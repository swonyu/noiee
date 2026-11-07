import Foundation
import Darwin
import CryptoKit

// Only HandoffProcess's released mutation dispatch reaches this single-file operation.
enum GuestDiskDisposal {
#if FAILED_DISK_TEST
    static var testRoot: String?
    static var testCommand: ((String, [String]) throws -> (Int32, Data, Data))?
    static var testAbsentProcesses: (([[String: Any]], [String: Any]) throws -> Void)?
#endif
    // Failed provisioning has no retirement receipt. These fixed read-only
    // inspections grant only this exact unlink, never execution or guest reuse.
    private static func inspectionCommand(_ program: String, _ arguments: [String]) throws -> (Int32, Data, Data) {
        guard ["/usr/sbin/lsof", "/usr/bin/hdiutil"].contains(program) else { throw fail("Unsupported failed-disk inspection") }
#if FAILED_DISK_TEST
        guard let run = testCommand else { throw fail("Offline inspection runner was not supplied") }
        return try run(program, arguments)
#else
        try HandoffProcess.trustedExecutable(program)
        var output: [Int32] = [0, 0], errors: [Int32] = [0, 0]
        guard pipe(&output) == 0 else { throw fail("Cannot retain inspection output") }
        guard pipe(&errors) == 0 else { close(output[0]); close(output[1]); throw fail("Cannot retain inspection diagnostics") }
        var fds = [output[0], errors[0]], writeFDs = [output[1], errors[1]]
        defer { for fd in fds + writeFDs where fd >= 0 { close(fd) } }
        var actions: posix_spawn_file_actions_t? = nil, attributes: posix_spawnattr_t? = nil
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw fail("Cannot configure inspection descriptors") }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw fail("Cannot configure inspection child") }
        defer { posix_spawnattr_destroy(&attributes) }
        guard posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
              posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions, errors[1], STDERR_FILENO) == 0 else { throw fail("Cannot bind inspection descriptors") }
        // Stay in the original gated helper's group. The coordinator refuses
        // closure if any descendant survives the helper, including cancellation.
        guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0 else { throw fail("Cannot constrain inspection inheritance") }
        var argv = ([program] + arguments).map { strdup($0) } + [nil]
        let environmentStrings: [String] = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", "LC_ALL=C"]
        var environment = environmentStrings.map { strdup($0) } + [nil]
        defer { for p in argv { free(p) }; for p in environment { free(p) } }
        guard argv.dropLast().allSatisfy({ $0 != nil }), environment.dropLast().allSatisfy({ $0 != nil }) else { throw fail("Cannot allocate inspection arguments") }
        var pid: pid_t = 0
        let launched = argv.withUnsafeMutableBufferPointer { av in environment.withUnsafeMutableBufferPointer { ev in posix_spawn(&pid, program, &actions, &attributes, av.baseAddress!, ev.baseAddress!) } }
        for fd in writeFDs { close(fd) }; writeFDs = []
        guard launched == 0, pid > 1 else { throw fail("Failed-disk inspection could not start") }
        var status: Int32 = 0, exited = false, rejected = false, killed = false
        defer { if !exited { kill(pid, SIGKILL); while waitpid(pid, &status, 0) < 0 && errno == EINTR {} } }
        for fd in fds { let flags = fcntl(fd, F_GETFL); guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { throw fail("Inspection descriptor unavailable") } }
        var data = [Data(), Data()]
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        while !exited || fds.contains(where: { $0 >= 0 }) {
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= deadline || rejected { rejected = true; if !exited && !killed { kill(pid, SIGKILL); killed = true } }
            guard now < deadline + 2_000_000_000 else { throw fail("Failed-disk inspection did not drain") }
            var pollFDs = fds.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
            let ready = poll(&pollFDs, 2, 25)
            if ready < 0 && errno != EINTR { rejected = true }
            for i in 0..<2 where fds[i] >= 0 && pollFDs[i].revents != 0 {
                var bytes = [UInt8](repeating: 0, count: 16_384)
                let count = read(fds[i], &bytes, bytes.count)
                if count == 0 { close(fds[i]); fds[i] = -1 }
                else if count > 0 { if data[i].count + count <= 1_048_576 { data[i].append(contentsOf: bytes.prefix(count)) } else { rejected = true } }
                else if errno != EINTR && errno != EAGAIN { rejected = true; close(fds[i]); fds[i] = -1 }
            }
            if !exited { let result = waitpid(pid, &status, WNOHANG); if result == pid { exited = true } else if result < 0 && errno != EINTR { throw fail("Inspection child closure is unknown") } }
        }
        guard !rejected, !killed, status & 0x7f == 0 else { throw fail("Failed-disk inspection failed or timed out") }
        return ((status >> 8) & 0xff, data[0], data[1])
#endif
    }
    static func inspectFailed(_ data: Data, dispose: Bool = false) throws -> [String: Any] {
        guard data.count <= 131_072, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(input.keys) == ["request", "failed"],
              let request = input["request"] as? [String: Any], let failed = input["failed"] as? [String: Any],
              Set(failed.keys) == ["parent", "processes", "files", "auxiliary", "namespace"],
              let workers = failed["processes"] as? [[String: Any]], workers.count == 2, let parent = failed["parent"] as? [String: Any],
              let files = failed["files"] as? [String: [String: Any]], files.count <= 24, let namespace = failed["namespace"] as? [String],
              let auxiliary = failed["auxiliary"] as? [String: String], let disk = request["disk"] as? [String: String],
              let rootID = request["rootIdentity"] as? [String: Any] else { throw fail("Invalid failed provisioning disk proof") }
        let owner = try CodingTemporary.string(request, "ownerId", limit: 36), generation = try CodingTemporary.string(request, "generation", limit: 36)
        let root = try CodingTemporary.string(request, "root"), allocation = URL(fileURLWithPath: root).deletingLastPathComponent().path
#if FAILED_DISK_TEST
        guard let allowed = testRoot, root.hasPrefix(allowed + "/"), allowed.contains("/failed-start-disposal-20261015/checks/") else { throw fail("Offline fixture path is outside its retained root") }
#endif
        guard HandoffProcess.matches(owner, HandoffProcess.noncePattern), HandoffProcess.matches(generation, HandoffProcess.noncePattern), root.hasSuffix("/\(owner)-\(generation)/guest") else { throw fail("Failed disk owner path differs") }
        let required = Set(["allocation.json", "guest/fixture.json", "guest/installed.json", "guest/hardware-model.bin", "guest/machine-id.bin", "guest/install-claim.json", "guest/install-terminal.json", "guest/provision-claim.json", "guest/provision-terminal.json", "guest/provision-events.jsonl", "receipts/installation.json", "receipts/provisioning.json"])
        let phases = ["address-found", "callback-entered", "callback-settled", "ready-resolved", "scan-first-drained", "scan-first-result", "scan-ready-drained", "scan-ready-result"].map { "receipts/startup-phase-\($0).json" }
        guard required.isSubset(of: Set(files.keys)), Set(files.keys).isSubset(of: required.union(phases)), Set(namespace) == Set(files.keys).union(["guest", "receipts", "guest/auxiliary.bin"]), namespace.count == Set(namespace).count else { throw fail("Unexplained failed guest namespace") }
        func recheck() throws {
            try CodingTemporary.canonical(allocation); try CodingTemporary.canonical(root)
            var rootStat = stat(); guard lstat(root, &rootStat) == 0, String(rootStat.st_dev) == rootID["dev"] as? String, String(rootStat.st_ino) == rootID["ino"] as? String, rootStat.st_mode == S_IFDIR | 0o700, rootStat.st_uid == getuid() else { throw fail("Failed guest root changed") }
            var found = [String]()
            for name in try FileManager.default.contentsOfDirectory(atPath: allocation) {
                if name == "guest" || name == "receipts" {
                    var directory = stat(); guard lstat(allocation + "/" + name, &directory) == 0, directory.st_mode == S_IFDIR | 0o700, directory.st_uid == getuid() else { throw fail("Failed guest directory changed") }
                    found.append(name)
                    found += try FileManager.default.contentsOfDirectory(atPath: allocation + "/" + name).map { name + "/" + $0 }
                } else { found.append(name) }
            }
            let expected = Set(namespace).union(["guest/disk.img"] + (dispose ? ["receipts/disk-release-intent.json"] : []))
            guard Set(found) == expected, found.count == expected.count else { throw fail("Failed guest acquired unknown files or execution artifacts") }
            for (name, expected) in files {
                guard Set(expected.keys) == ["sha256", "stamp"], let wanted = expected["stamp"] as? [String: String], let hash = expected["sha256"] as? String, HandoffProcess.matches(hash, "^[a-f0-9]{64}$") else { throw fail("Invalid failed guest record") }
                let path = allocation + "/" + name, fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw fail("Failed guest record unavailable") }
                defer { close(fd) }
                let before = try CodingTemporary.info(fd)
                guard before.st_mode == S_IFREG | 0o600, before.st_uid == getuid(), before.st_nlink == 1, before.st_size > 0, before.st_size <= 1_048_576 else { throw fail("Unsafe failed guest record") }
                var observed = try stamp(before); observed.removeValue(forKey: "blocks")
                if wanted["volumeUUID"] != nil { observed.removeValue(forKey: "dev"); observed["volumeUUID"] = try HandoffProcess.filesystemIdentity(fd)["volumeUUID"] }
                guard observed == wanted else { throw fail("Failed guest record identity changed") }
                let bytes = try HandoffProcess.read(fd, limit: Int(before.st_size), label: "Failed guest record")
                var named = stat(); guard bytes.count == Int(before.st_size), SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == hash, try stamp(CodingTemporary.info(fd)) == stamp(before), lstat(path, &named) == 0, try stamp(named) == stamp(before) else { throw fail("Failed guest record changed while reading") }
            }
            for (name, expected) in [("disk.img", disk), ("auxiliary.bin", auxiliary)] {
                let path = root + "/" + name, fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw fail("Failed guest storage unavailable") }; defer { close(fd) }
                let before = try CodingTemporary.info(fd); var value = try stamp(before)
                if expected["volumeUUID"] != nil { value.removeValue(forKey: "dev"); value["volumeUUID"] = try HandoffProcess.filesystemIdentity(fd)["volumeUUID"] }
                var named = stat(); guard value == expected, lstat(path, &named) == 0, try stamp(named) == stamp(before), try stamp(CodingTemporary.info(fd)) == stamp(before) else { throw fail("Failed guest storage identity changed") }
            }
        }
        func absentProcesses() throws {
#if FAILED_DISK_TEST
            guard let inspect = testAbsentProcesses else { throw fail("Offline process inspection was not supplied") }
            try inspect(workers, parent)
#else
            let ownerReceipt = try HandoffProcess.receipt(JSONSerialization.data(withJSONObject: parent), owner: true), observed = try HandoffProcess.inspectOwner(ownerReceipt)
            guard observed["owner"] is NSNull else { throw fail("Original failed provisioning parent is still present") }
            for worker in workers {
                let receipt = try HandoffProcess.receipt(JSONSerialization.data(withJSONObject: worker)), state = try HandoffProcess.inspect(receipt)
                guard receipt["nonce"] as? String == generation, state["leader"] is NSNull, let group = state["group"] as? [Any], group.isEmpty else { throw fail("Original failed provisioning worker or group is still present") }
            }
#endif
        }
        try recheck(); try absentProcesses()
        // No guest descriptors remain open in this helper during lsof. Unknown
        // diagnostics/refusals never become proof that the allocation is unused.
        let descriptors = try inspectionCommand("/usr/sbin/lsof", ["-nP", "-Fpcfn", "+D", allocation])
        guard descriptors.0 == 1, descriptors.1.isEmpty, descriptors.2.isEmpty else { throw fail("Failed guest still has open or unverified file users") }
        let mounted = try inspectionCommand("/usr/bin/hdiutil", ["info", "-plist"])
        guard mounted.0 == 0, mounted.2.isEmpty, let plist = (try? PropertyListSerialization.propertyList(from: mounted.1, format: nil)) as? [String: Any], let images = plist["images"] as? [[String: Any]] else { throw fail("Failed guest disk image inventory unavailable") }
        for image in images {
            guard let path = image["image-path"] as? String, path.hasPrefix("/"), !path.hasPrefix(allocation + "/") else { throw fail("Failed guest disk image is attached or unknown") }
            // Attachment inventory paths may themselves be aliases. Follow only
            // for this read-only comparison; unlink still uses its exact nofollow FD.
            var info = stat(); guard stat(path, &info) == 0 else { throw fail("Attached image identity is unavailable") }
            if String(info.st_dev) == disk["dev"] && String(info.st_ino) == disk["ino"] { throw fail("Failed guest disk image is attached through an alias") }
        }
        try absentProcesses(); try recheck()
        if dispose { return try run(JSONSerialization.data(withJSONObject: request, options: .sortedKeys)) }
        return ["version": 1, "ownerId": owner, "generation": generation, "guestId": request["guestId"] ?? NSNull(), "physicalClosed": true]
    }
    // This separate operation never unlinks storage. The coordinator's closed
    // owner record supplies historical closure; these checks establish current
    // emptiness while excluding a paused installer holding the inherited FD.
    static func inspectEmpty(_ data: Data, releasing: Bool = false) throws -> [String: Any] {
        guard data.count <= 131_072, let text = String(data: data, encoding: .utf8),
              let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(input.keys) == ["version", "ownerId", "generation", "allocation", "allocationIdentity", "rootIdentity", "receiptsIdentity", "allocationFile"],
              let file = input["allocationFile"] as? [String: Any], Set(file.keys) == ["sha256", "stamp"],
              let wanted = file["stamp"] as? [String: String], let hash = file["sha256"] as? String,
              HandoffProcess.matches(hash, "^[a-f0-9]{64}$"),
              Set(wanted.keys) == Set([wanted["volumeUUID"] == nil ? "dev" : "volumeUUID", "ino", "size", "mode", "uid", "nlink", "mtime", "ctime"]) else { throw fail("Invalid empty allocation proof") }
        let identities = try ["allocationIdentity", "rootIdentity", "receiptsIdentity"].map { key -> [String: Any] in
            guard let value = input[key] as? [String: Any], Set(value.keys) == ["dev", "ino", "mode", "uid"],
                  try HandoffProcess.integer(value["mode"], 0, Int(UInt16.max)) == Int(S_IFDIR | 0o700),
                  try HandoffProcess.integer(value["uid"], 0, Int(UInt32.max)) == Int(getuid()) else { throw fail("Invalid empty allocation directory proof") }
            for key in ["dev", "ino"] {
                guard let number = value[key] as? String, let integer = UInt64(number), integer > 0, String(integer) == number else { throw fail("Noncanonical empty allocation identity") }
            }
            return value
        }
        let keys = try NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"\s*:"#).numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
        guard keys == input.count + 12 + file.count + wanted.count, try HandoffProcess.integer(input["version"], 1, 1) == 1 else { throw fail("Duplicate or invalid empty allocation fields") }
        for (key, value) in wanted {
            if key == "volumeUUID" {
                guard HandoffProcess.matches(value, HandoffProcess.bootPattern), value != "00000000-0000-0000-0000-000000000000" else { throw fail("Invalid allocation filesystem identity") }
            } else { guard let number = UInt64(value), String(number) == value else { throw fail("Noncanonical allocation file stamp") } }
        }
        let owner = try CodingTemporary.string(input, "ownerId", limit: 36), generation = try CodingTemporary.string(input, "generation", limit: 36)
        let allocation = try CodingTemporary.string(input, "allocation")
        guard HandoffProcess.matches(owner, HandoffProcess.noncePattern), HandoffProcess.matches(generation, HandoffProcess.noncePattern),
              allocation.hasPrefix("/"), allocation.hasSuffix("/\(owner)-\(generation)"),
              !allocation.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw fail("Empty allocation owner path differs") }
#if FAILED_DISK_TEST
        guard let allowed = testRoot, allocation.hasPrefix(allowed + "/"),
              allowed.hasPrefix("/private/tmp/saleh-empty-allocation-") || allowed.contains("/empty-allocation-release-20261015/checks/native-fixture-") else { throw fail("Offline empty allocation is outside its fixture root") }
#endif
        try CodingTemporary.canonical(allocation)
        var fds: [Int32] = [-1, -1, -1]
        defer { for fd in fds where fd >= 0 { close(fd) } }
        fds[0] = try CodingTemporary.checked(open(allocation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "Open empty allocation")
        fds[1] = try CodingTemporary.directory(fds[0], "guest")
        fds[2] = try CodingTemporary.directory(fds[0], "receipts")
        // Never use an inherited/duplicated installer open-file-description:
        // flock aliases can share ownership instead of excluding that installer.
        _ = try CodingTemporary.checked(flock(fds[1], LOCK_EX | LOCK_NB), "Lock empty guest independently")
        let paths = [allocation, allocation + "/guest", allocation + "/receipts"]
        func directoryNames(_ fd: Int32) throws -> Set<String> {
            let copy = try CodingTemporary.checked(dup(fd), "Read empty allocation namespace")
            guard let directory = fdopendir(copy) else { close(copy); throw fail("Empty allocation namespace unavailable") }
            var closed = false
            defer { if !closed { closedir(directory) } }
            rewinddir(directory)
            var names = Set<String>()
            while true {
                errno = 0
                guard let entry = readdir(directory) else { guard errno == 0 else { throw fail("Empty allocation namespace incomplete") }; break }
                let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(validatingUTF8: $0) } }
                guard let name else { throw fail("Unknown empty allocation filename") }
                if name != "." && name != ".." { guard names.insert(name).inserted else { throw fail("Repeated empty allocation entry") } }
            }
            let result = closedir(directory); closed = true
            _ = try CodingTemporary.checked(result, "Close empty allocation namespace")
            return names
        }
        func record(_ parent: Int32, _ name: String) throws -> (String, [String: String], [String: String]) {
            var fd = try CodingTemporary.checked(openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC), "Open empty allocation record")
            defer { if fd >= 0 { close(fd) } }
            let before = try CodingTemporary.info(fd), raw = try stamp(before)
            guard before.st_mode == S_IFREG | 0o600, before.st_uid == getuid(), before.st_nlink == 1,
                  before.st_size > 0, before.st_size <= 1_048_576 else { throw fail("Unsafe empty allocation record") }
            let bytes = try HandoffProcess.read(fd, limit: Int(before.st_size), label: "Empty allocation record")
            guard bytes.count == Int(before.st_size), try stamp(CodingTemporary.info(fd)) == raw,
                  try stamp(CodingTemporary.namedInfo(parent, name)) == raw else { throw fail("Empty allocation record changed") }
            var stable = raw; stable.removeValue(forKey: "blocks")
            if wanted["volumeUUID"] != nil { stable.removeValue(forKey: "dev"); stable["volumeUUID"] = try HandoffProcess.filesystemIdentity(fd)["volumeUUID"] }
            let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let result = close(fd); fd = -1
            _ = try CodingTemporary.checked(result, "Close empty allocation record")
            return (hash, stable, raw)
        }
        var intent: (String, [String: String], [String: String])?
        func recheck() throws {
            for i in 0..<3 {
                try CodingTemporary.canonical(paths[i])
                var named = stat(); _ = try CodingTemporary.checked(lstat(paths[i], &named), "Inspect empty allocation directory")
                for info in [try CodingTemporary.info(fds[i]), named] {
                    guard String(info.st_dev) == identities[i]["dev"] as? String, String(info.st_ino) == identities[i]["ino"] as? String,
                          info.st_mode == S_IFDIR | 0o700, info.st_uid == getuid() else { throw fail("Empty allocation directory changed") }
                }
            }
            guard try directoryNames(fds[0]) == ["allocation.json", "guest", "receipts"],
                  try directoryNames(fds[1]).isEmpty,
                  try directoryNames(fds[2]) == (releasing ? ["disk-release-intent.json"] : []) else { throw fail("Empty allocation acquired unknown files") }
            let observed = try record(fds[0], "allocation.json")
            guard observed.0 == hash, observed.1 == wanted else { throw fail("Empty allocation metadata changed") }
            if releasing {
                let observed = try record(fds[2], "disk-release-intent.json")
                if let intent { guard observed == intent else { throw fail("Empty allocation intent changed") } } else { intent = observed }
            }
        }
        try recheck()
        let descriptors = try inspectionCommand("/usr/sbin/lsof", ["-nP", "-Fpcfn", "+D", allocation])
        guard [0, 1].contains(descriptors.0), descriptors.2.isEmpty, descriptors.1.count <= 1_048_576,
              let listing = String(data: descriptors.1, encoding: .utf8), listing.hasSuffix("\n"),
              !listing.contains("\r"), !listing.contains("\0") else { throw fail("Empty allocation file users are unverified") }
        let lines = listing.dropLast().components(separatedBy: "\n")
        let expected = Dictionary(uniqueKeysWithValues: zip(fds.map(String.init), paths))
        guard lines.count == 2 + 2 * expected.count, lines[0] == "p\(getpid())", lines[1].hasPrefix("c"), lines[1].count > 1,
              !lines[1].unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw fail("Empty allocation has foreign or incomplete file users") }
        var seen = Set<String>()
        for i in stride(from: 2, to: lines.count, by: 2) {
            let fd = String(lines[i].dropFirst())
            guard lines[i].hasPrefix("f"), let path = expected[fd], lines[i + 1] == "n" + path,
                  seen.insert(fd).inserted else { throw fail("Empty allocation file descriptor proof differs") }
        }
        guard seen == Set(expected.keys) else { throw fail("Empty allocation held descriptors are missing") }
        let mounted = try inspectionCommand("/usr/bin/hdiutil", ["info", "-plist"])
        guard mounted.0 == 0, mounted.2.isEmpty, mounted.1.count <= 1_048_576,
              let plist = (try? PropertyListSerialization.propertyList(from: mounted.1, format: nil)) as? [String: Any],
              let images = plist["images"] as? [[String: Any]] else { throw fail("Empty allocation image inventory unavailable") }
        for image in images {
            guard let path = image["image-path"] as? String, path.hasPrefix("/"), !path.contains("\0"),
                  let resolved = realpath(path, nil) else { throw fail("Empty allocation image identity unavailable") }
            defer { free(resolved) }
            let canonical = String(cString: resolved)
            guard path != allocation, !path.hasPrefix(allocation + "/"), canonical != allocation,
                  !canonical.hasPrefix(allocation + "/") else { throw fail("Empty allocation has an attached image") }
            guard let entities = image["system-entities"] as? [[String: Any]] else { throw fail("Empty allocation mount entities unavailable") }
            for entity in entities where entity["mount-point"] != nil {
                guard let point = entity["mount-point"] as? String, point.hasPrefix("/"),
                      !point.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                      let resolvedPoint = realpath(point, nil) else { throw fail("Empty allocation mount point unavailable") }
                defer { free(resolvedPoint) }
                let canonicalPoint = String(cString: resolvedPoint)
                guard point == canonicalPoint else { throw fail("Empty allocation mount point is not canonical") }
                guard point != allocation, !point.hasPrefix(allocation + "/"), canonicalPoint != allocation,
                      !canonicalPoint.hasPrefix(allocation + "/") else { throw fail("Empty allocation contains a mounted filesystem") }
            }
        }
        try recheck()
        for i in fds.indices.reversed() {
            let fd = fds[i]; fds[i] = -1
            _ = try CodingTemporary.checked(close(fd), "Close empty allocation descriptor")
        }
        return ["version": 1, "ownerId": owner, "generation": generation, "empty": true, "physicalClosed": true, "descriptorsClosed": true]
    }
    static func fail(_ text: String) -> Error { CodingTemporary.fail(text) }
    static func nanoseconds(_ value: timespec) throws -> String {
        let (seconds, overflow) = Int64(value.tv_sec).multipliedReportingOverflow(by: 1_000_000_000)
        let (total, sumOverflow) = seconds.addingReportingOverflow(Int64(value.tv_nsec))
        guard !overflow, !sumOverflow, total >= 0, value.tv_nsec >= 0, value.tv_nsec < 1_000_000_000 else { throw fail("Disk timestamp is outside its supported range") }
        return String(total)
    }
    static func stamp(_ value: stat) throws -> [String: String] {
        ["dev": String(value.st_dev), "ino": String(value.st_ino), "size": String(value.st_size),
         "mode": String(value.st_mode), "uid": String(value.st_uid), "nlink": String(value.st_nlink),
         "mtime": try nanoseconds(value.st_mtimespec), "ctime": try nanoseconds(value.st_ctimespec), "blocks": String(value.st_blocks)]
    }
    static func run(_ data: Data) throws -> [String: Any] {
        guard data.count <= 8192, let text = String(data: data, encoding: .utf8),
              let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(input.keys) == ["version", "ownerId", "generation", "guestId", "epoch", "root", "rootIdentity", "disk"],
              let root = input["rootIdentity"] as? [String: Any], Set(root.keys) == ["dev", "ino", "mode", "uid"],
              let disk = input["disk"] as? [String: String], Set(disk.keys) == ["dev", "ino", "size", "mode", "uid", "nlink", "mtime", "ctime", "blocks"] else { throw fail("Invalid disk disposal fields") }
        // All accepted values are scalars except these two fixed dictionaries.
        let keyCount = try NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"\s*:"#).numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
        guard keyCount == input.count + root.count + disk.count, try HandoffProcess.integer(input["version"], 1, 1) == 1 else { throw fail("Invalid or duplicate disk disposal fields") }
        let owner = try CodingTemporary.string(input, "ownerId", limit: 36), generation = try CodingTemporary.string(input, "generation", limit: 36)
        let guest = try CodingTemporary.string(input, "guestId", limit: 36), epoch = try CodingTemporary.string(input, "epoch", limit: 36)
        for value in [owner, generation] {
            guard value.utf8.count == 36, HandoffProcess.matches(value, "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$") else { throw fail("Invalid disposal owner or generation") }
        }
        for value in [guest, epoch] {
            guard value.utf8.count == 36, HandoffProcess.matches(value, HandoffProcess.bootPattern) else { throw fail("Invalid disposal guest or epoch") }
        }
        for value in Array(disk.values) + [root["dev"] as? String ?? "", root["ino"] as? String ?? ""] {
            guard let number = UInt64(value), String(number) == value else { throw fail("Noncanonical disk disposal identity") }
        }
        let rootMode = try HandoffProcess.integer(root["mode"], 0, Int(UInt16.max)), rootUID = try HandoffProcess.integer(root["uid"], 0, Int(UInt32.max))
        guard rootMode == Int(S_IFDIR | 0o700), rootUID == Int(getuid()),
              disk["mode"] == String(S_IFREG | 0o600), disk["uid"] == String(getuid()), disk["nlink"] == "1",
              let size = UInt64(disk["size"]!), size > 0, let blocks = UInt64(disk["blocks"]!) else { throw fail("Disk disposal requires a private regular file with one link") }
        let (allocated, overflow) = blocks.multipliedReportingOverflow(by: 512)
        guard !overflow else { throw fail("Disk allocation size overflow") }
        let path = try CodingTemporary.string(input, "root")
#if FAILED_DISK_TEST
        guard let allowed = testRoot, path.hasPrefix(allowed + "/"), allowed.contains("/failed-start-disposal-20261015/checks/") else { throw fail("Offline disposal path is outside its retained root") }
#endif
        guard path.hasSuffix("/\(owner)-\(generation)/guest") else { throw fail("Disk disposal root does not match its owner generation") }
        try CodingTemporary.canonical(path)
        var parent = try CodingTemporary.checked(open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "Open disposal parent")
        var file: Int32 = -1
        defer { if file >= 0 { close(file) }; if parent >= 0 { close(parent) } }
        func verifyParent() throws {
            try CodingTemporary.canonical(path)
            let held = try CodingTemporary.info(parent)
            var named = stat(); _ = try CodingTemporary.checked(lstat(path, &named), "Inspect disposal parent")
            for value in [held, named] {
                guard String(value.st_dev) == root["dev"] as? String, String(value.st_ino) == root["ino"] as? String,
                      Int(value.st_mode) == rootMode, Int(value.st_uid) == rootUID else { throw fail("Disk disposal parent identity or permissions changed") }
            }
        }
        func verifyDisk(_ value: stat) throws {
            guard try stamp(value) == disk else { throw fail("Reviewed disk identity or metadata changed") }
        }
        try verifyParent()
        try verifyDisk(CodingTemporary.namedInfo(parent, "disk.img"))
        file = try CodingTemporary.checked(openat(parent, "disk.img", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC), "Open reviewed disk")
        try verifyDisk(CodingTemporary.info(file))
        try verifyParent()
        try verifyDisk(CodingTemporary.info(file))
        try verifyDisk(CodingTemporary.namedInfo(parent, "disk.img"))
        // The coordinator owns the cooperating-writer lease; pathname checks are not a hostile-writer unlink CAS.
        _ = try CodingTemporary.checked(unlinkat(parent, "disk.img", 0), "Unlink reviewed disk")
        _ = try CodingTemporary.checked(fsync(parent), "Sync disposal parent")
        let unlinked = try CodingTemporary.info(file)
        guard String(unlinked.st_dev) == disk["dev"], String(unlinked.st_ino) == disk["ino"], unlinked.st_nlink == 0 else { throw fail("Disposed disk still has a link") }
        var named = stat(); errno = 0
        guard fstatat(parent, "disk.img", &named, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw fail("Disposed disk name is not absent") }
        try verifyParent()
        let diskClose = close(file); file = -1
        _ = try CodingTemporary.checked(diskClose, "Close disposed disk")
        let parentClose = close(parent); parent = -1
        _ = try CodingTemporary.checked(parentClose, "Close disposal parent")
        return ["version": 1, "ownerId": owner, "generation": generation, "guestId": guest, "epoch": epoch,
                "unlinked": true, "descriptorsClosed": true, "disk": disk, "rootIdentity": root,
                "logicalBytes": disk["size"]!, "allocatedBytes": String(allocated)]
    }
}
