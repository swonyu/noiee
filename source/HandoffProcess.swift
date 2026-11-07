import Foundation
import Darwin
import Darwin.crt_externs
import CoreFoundation

// A pre-effect release gate and read-only incarnation inspection, not a subprocess supervisor.
enum HandoffProcess {
    static let git = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"
    static let sandbox = "/usr/bin/sandbox-exec"
    static let noncePattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    static let bootPattern = "^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$"
    static func fail(_ message: String) -> Error { CodingTemporary.fail(message) }
    static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
    static func boot() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 128), count = 128
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &count, nil, 0) == 0,
              count > 1, count <= bytes.count, bytes[count - 1] == 0,
              let value = String(bytes: bytes.prefix(count - 1), encoding: .utf8), value.utf8.count == 36, matches(value, bootPattern) else { throw fail("Boot-session identity is unavailable") }
        return value
    }
    static func identity(_ pid: Int32, _ bootSession: String) -> (row: [String: Any]?, error: Int32) {
        var value = proc_bsdinfo(); errno = 0
        let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)), error = errno
        guard count == MemoryLayout<proc_bsdinfo>.size, error == 0, value.pbi_pid == UInt32(pid), value.pbi_pgid > 0,
              value.pbi_start_tvsec > 0, value.pbi_start_tvusec < 1_000_000 else { return (nil, error) }
        return (["version": 1, "pid": Int(value.pbi_pid), "pgid": Int(value.pbi_pgid), "uid": Int(value.pbi_uid),
                 "startSec": String(value.pbi_start_tvsec), "startUsec": Int(value.pbi_start_tvusec), "bootSession": bootSession], 0)
    }
    static func selfReceipt(_ nonce: String) throws -> [String: Any] {
        guard nonce.utf8.count == 36, matches(nonce, noncePattern), getpid() > 1, getpgrp() == getpid(), geteuid() == getuid() else { throw fail("Invalid release nonce or detached process ownership") }
        let current = identity(getpid(), try boot())
        guard var row = current.row, row["pgid"] as? Int == Int(getpid()), row["uid"] as? Int == Int(getuid()) else { throw fail("Native process identity is unavailable (errno \(current.error))") }
        row["nonce"] = nonce; return row
    }
    static func owner() throws -> [String: Any] {
        let parent = getppid(), session = try boot()
        guard parent > 1, geteuid() == getuid() else { throw fail("Direct process owner is unavailable") }
        let current = identity(parent, session)
        guard getppid() == parent, let row = current.row, row["uid"] as? Int == Int(getuid()) else { throw fail("Direct process owner identity is unavailable (errno \(current.error))") }
        return ["version": 1, "bootSession": session, "owner": row]
    }
    static func filesystemIdentity(_ fd: Int32) throws -> [String: String] {
        let before = try CodingTemporary.info(fd), flags = fcntl(fd, F_GETFL)
        guard flags >= 0, flags & O_ACCMODE == O_RDONLY,
              [mode_t(S_IFDIR), mode_t(S_IFREG)].contains(before.st_mode & S_IFMT) else { throw fail("Filesystem identity requires a read-only regular file or directory descriptor") }
        var attributes = attrlist(); attributes.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
        attributes.volattr = attrgroup_t(ATTR_VOL_INFO) | attrgroup_t(ATTR_VOL_UUID)
        var bytes = [UInt8](repeating: 0, count: 20)
        let result = bytes.withUnsafeMutableBytes { fgetattrlist(fd, &attributes, $0.baseAddress!, $0.count, 0) }
        guard result == 0, bytes.withUnsafeBytes({ $0.loadUnaligned(as: UInt32.self) }) == 20,
              bytes.dropFirst(4).contains(where: { $0 != 0 }) else { throw fail("Persistent volume UUID is unavailable") }
        let hex = bytes.dropFirst(4).map { String(format: "%02X", $0) }.joined()
        let offsets = [0, 8, 12, 16, 20, 32], chars = Array(hex)
        let volume = (0..<5).map { String(chars[offsets[$0]..<offsets[$0 + 1]]) }.joined(separator: "-")
        let after = try CodingTemporary.info(fd)
        // APFS directory link counts change with child entries; file link counts stay exact.
        guard CodingTemporary.same(before, after), before.st_mode == after.st_mode, before.st_uid == after.st_uid,
              before.st_nlink > 0, after.st_nlink > 0,
              (before.st_mode & S_IFMT == S_IFDIR || before.st_nlink == after.st_nlink), before.st_ino > 0 else { throw fail("Filesystem identity changed during inspection") }
        return ["volumeUUID": volume, "ino": String(before.st_ino)]
    }
    static func integer(_ value: Any?, _ low: Int, _ high: Int) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue >= Double(low), number.doubleValue <= Double(high), number.doubleValue.rounded(.towardZero) == number.doubleValue else { throw fail("Invalid process receipt number") }
        return number.intValue
    }
    static func receipt(_ data: Data, owner: Bool = false) throws -> [String: Any] {
        var fields: Set<String> = ["version", "pid", "pgid", "uid", "startSec", "startUsec", "bootSession"]
        if !owner { fields.insert("nonce") }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == fields,
              let text = String(data: data, encoding: .utf8) else { throw fail("Invalid process receipt fields") }
        // JSONSerialization otherwise silently accepts duplicate keys. All accepted values are scalars.
        let keys = try NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"\s*:"#).matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard keys.count == object.count else { throw fail("Duplicate process receipt keys") }
        guard try integer(object["version"], 1, 1) == 1,
              try integer(object["uid"], 0, Int(UInt32.max)) == Int(getuid()),
              let session = object["bootSession"] as? String, session.utf8.count == 36, matches(session, bootPattern),
              let start = object["startSec"] as? String, start.utf8.count <= 20, let seconds = UInt64(start), seconds > 0, String(seconds) == start else { throw fail("Invalid process receipt identity") }
        let pid = try integer(object["pid"], 2, Int(Int32.max)), pgid = try integer(object["pgid"], 1, Int(Int32.max))
        if !owner {
            guard pid == pgid, let nonce = object["nonce"] as? String, nonce.utf8.count == 36, matches(nonce, noncePattern) else { throw fail("Invalid process receipt identity") }
        }
        _ = try integer(object["startUsec"], 0, 999_999)
        return object
    }
    static func inspectOwner(_ saved: [String: Any]) throws -> [String: Any] {
        let session = try boot(), prior = session != saved["bootSession"] as? String
        var result: [String: Any] = ["version": 1, "bootSession": session, "priorBoot": prior, "owner": NSNull()]
        if prior { return result }
        let current = identity(Int32(try integer(saved["pid"], 2, Int(Int32.max))), session)
        if let row = current.row { result["owner"] = row }
        else if current.error != ESRCH { throw fail("Owner process inspection failed (errno \(current.error))") }
        return result
    }
    static func inspect(_ receipt: [String: Any]) throws -> [String: Any] {
        let session = try boot(), prior = session != receipt["bootSession"] as? String
        var result: [String: Any] = ["version": 1, "bootSession": session, "priorBoot": prior, "leader": NSNull(),
                                    "group": [], "groupQuery": ["bytes": 0, "errno": 0, "positivePids": 0]]
        // Never inspect a historical numeric PID/group from another boot.
        if prior { return result }
        let pid = Int32(try integer(receipt["pid"], 2, Int(Int32.max)))
        let leader = identity(pid, session)
        if let row = leader.row { result["leader"] = row }
        else if leader.error != ESRCH { throw fail("Leader process inspection failed (errno \(leader.error))") }
        // ponytail: one bounded kernel group snapshot; saturation refuses rather than guessing completeness.
        var ids = [pid_t](repeating: 0, count: 4096)
        let capacity = ids.count * MemoryLayout<pid_t>.size
        errno = 0
        let count = proc_listpids(UInt32(PROC_PGRP_ONLY), UInt32(pid), &ids, Int32(capacity)), error = errno
        guard count >= 0, error == 0, count < capacity, Int(count) % MemoryLayout<pid_t>.size == 0 else { throw fail("Process group inspection failed or exceeded its bound (\(count)/\(error))") }
        let positive = ids.prefix(Int(count) / MemoryLayout<pid_t>.size).filter { $0 > 0 }
        guard Set(positive).count == positive.count else { throw fail("Process group inspection repeated an identity") }
        result["group"] = positive.map { member -> [String: Any] in
            let current = identity(member, session)
            return current.row ?? ["pid": Int(member), "unavailable": true, "errno": Int(current.error)]
        }
        result["groupQuery"] = ["bytes": Int(count), "errno": Int(error), "positivePids": positive.count]
        return result
    }
    static func nonblocking(_ fd: Int32) throws {
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { throw fail("Process gate descriptor is unavailable") }
    }
    static func wait(_ fd: Int32, _ events: Int16, _ deadline: UInt64, _ label: String) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw fail("\(label) timed out") }
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let milliseconds = Int32(min((deadline - now + 999_999) / 1_000_000, 10_000))
            let count = poll(&descriptor, 1, milliseconds)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0, descriptor.revents & Int16(POLLNVAL) == 0 else { throw fail("\(label) descriptor failed") }
            if count > 0 { return }
        }
    }
    static func read(_ fd: Int32, limit: Int, label: String) throws -> Data {
        try nonblocking(fd)
        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        var data = Data(), bytes = [UInt8](repeating: 0, count: min(limit + 1, 4096))
        while true {
            try wait(fd, Int16(POLLIN), deadline, label)
            let count = Darwin.read(fd, &bytes, min(bytes.count, limit + 1 - data.count))
            if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            guard count >= 0 else { throw fail("\(label) read failed") }
            if count == 0 { return data }
            guard data.count <= limit - count else { throw fail("\(label) exceeds its byte limit") }
            data.append(contentsOf: bytes.prefix(count))
        }
    }
    static func write(_ fd: Int32, _ value: [String: Any], limit: Int) throws {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); data.append(10)
        guard data.count <= limit else { throw fail("Process identity output exceeds its bound") }
        try nonblocking(fd)
        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                try wait(fd, Int16(POLLOUT), deadline, "Process identity write")
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
                guard count > 0 else { throw fail("Process identity write failed") }
                offset += count
            }
        }
    }
    static func trustedExecutable(_ path: String) throws {
        try CodingTemporary.canonical(path)
        let fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw fail("Trusted executable is unavailable") }
        defer { close(fd) }
        var named = stat(); let value = try CodingTemporary.info(fd)
        guard lstat(path, &named) == 0, CodingTemporary.same(value, named), value.st_mode & S_IFMT == S_IFREG,
              value.st_uid == 0, value.st_mode & 0o022 == 0, value.st_mode & 0o111 != 0 else { throw fail("Trusted executable ownership changed") }
    }
    static func release(_ nonce: String) throws {
        for fd: Int32 in [3, 4] {
            var value = stat()
            guard fstat(fd, &value) == 0, [mode_t(S_IFIFO), mode_t(S_IFSOCK)].contains(value.st_mode & S_IFMT) else { throw fail("Process gate requires dedicated release pipes") }
        }
        let identity = try selfReceipt(nonce)
        try write(3, identity, limit: 2048); close(3)
        defer { close(4) }
        guard try read(4, limit: 37, label: "Process release") == Data((nonce + "\n").utf8) else { throw fail("Process release refused: exact nonce and EOF required") }
    }
    static func command(_ arguments: [String]) -> Int32 {
        signal(SIGPIPE, SIG_IGN)
        do {
            guard arguments.count >= 3, arguments[1] == "--handoff-process" else { throw fail("Invalid handoff-process command") }
            let mode = arguments[2]
            if mode == "boot" { guard arguments.count == 3 else { throw fail("Invalid boot command") }; try write(1, ["version": 1, "bootSession": try boot()], limit: 256); return 0 }
            if mode == "owner" { guard arguments.count == 3 else { throw fail("Invalid owner command") }; try write(1, owner(), limit: 2048); return 0 }
            if mode == "filesystem-identity" { guard arguments.count == 3 else { throw fail("Invalid filesystem identity command") }; try write(1, filesystemIdentity(3), limit: 256); return 0 }
            if mode == "filesystem-identities" {
                guard arguments.count == 4, let count = Int(arguments[3]), (1...32).contains(count), String(count) == arguments[3] else { throw fail("Invalid filesystem identity batch command") }
                let identities = try (0..<count).map { try filesystemIdentity(Int32(3 + $0)) }
                try write(1, ["identities": identities], limit: 4096); return 0
            }
            if mode == "inspect-owner" {
                guard arguments.count == 3 else { throw fail("Invalid owner inspection command") }
                try write(1, inspectOwner(receipt(read(0, limit: 8192, label: "Owner receipt"), owner: true)), limit: 2048); return 0
            }
            if mode == "inspect" {
                guard arguments.count == 3 else { throw fail("Invalid inspection command") }
                try write(1, inspect(receipt(read(0, limit: 8192, label: "Process receipt"))), limit: 2 * 1024 * 1024); return 0
            }
            if mode == "inspect-empty-allocation" {
                guard arguments.count == 3 else { throw fail("Invalid empty allocation inspection") }
                try write(1, GuestDiskDisposal.inspectEmpty(read(0, limit: 131_072, label: "Empty allocation proof")), limit: 8192); return 0
            }
            if mode == "inspect-failed-disk" {
                guard arguments.count == 3 else { throw fail("Invalid failed disk inspection command") }
                try write(1, GuestDiskDisposal.inspectFailed(read(0, limit: 131072, label: "Failed disk inspection request")), limit: 8192); return 0
            }
            guard arguments.count <= 517, arguments.count >= 5, arguments.reduce(0, { $0 + $1.utf8.count }) <= 256 * 1024,
                  arguments.allSatisfy({ !$0.contains("\0") }), arguments[3].utf8.count == 36, matches(arguments[3], noncePattern) else { throw fail("Invalid process gate arguments") }
            if mode == "files" {
                guard arguments.count == 5, ["snapshot", "copy", "materialize", "publish", "recoverySnapshot", "recoverPublish", "disposeGuestDisk", "disposeFailedGuestDisk", "releaseEmptyAllocation"].contains(arguments[4]) else { throw fail("Invalid gated file action") }
                try release(arguments[3])
                if arguments[4] == "releaseEmptyAllocation" {
                    try write(1, GuestDiskDisposal.inspectEmpty(read(0, limit: 131_072, label: "Empty allocation proof"), releasing: true), limit: 8192); return 0
                }
                if arguments[4] == "disposeGuestDisk" {
                    try write(1, GuestDiskDisposal.run(read(0, limit: 8192, label: "Disk disposal request")), limit: 8192); return 0
                }
                if arguments[4] == "disposeFailedGuestDisk" {
                    try write(1, GuestDiskDisposal.inspectFailed(read(0, limit: 131072, label: "Failed disk disposal request"), dispose: true), limit: 8192); return 0
                }
                return HandoffFiles.command([arguments[0], "--handoff-files", arguments[4]])
            }
            guard mode == "git", arguments.count >= 6, !arguments[4].isEmpty, arguments[4].utf8.count <= 128 * 1024,
                  arguments.dropFirst(5).allSatisfy({ $0.utf8.count <= 32 * 1024 }) else { throw fail("Invalid gated Git command or policy") }
            try trustedExecutable(sandbox); try trustedExecutable(git)
            try release(arguments[3])
            try trustedExecutable(sandbox); try trustedExecutable(git)
            var argv = ([sandbox, "-p", arguments[4], git] + arguments.dropFirst(5)).map { strdup($0) }
            guard argv.allSatisfy({ $0 != nil }) else { throw fail("Git argument allocation failed") }
            defer { for value in argv { free(value) } }
            argv.append(nil)
            argv.withUnsafeMutableBufferPointer { buffer in _ = execve(sandbox, buffer.baseAddress!, _NSGetEnviron().pointee) }
            throw fail("Trusted Git execution failed (errno \(errno))")
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8)); return 1
        }
    }
}
