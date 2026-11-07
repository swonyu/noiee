import Foundation
import Darwin

// Descriptor-relative operations keep project symlinks out of temporary-file ownership.
enum CodingTemporary {
    struct Failure: Error, CustomStringConvertible, LocalizedError { let description: String; var errorDescription: String? { description } }
    static func fail(_ message: String) -> Failure { Failure(description: message) }
    static func checked(_ result: Int32, _ operation: String) throws -> Int32 {
        guard result >= 0 else { throw fail("\(operation): \(String(cString: strerror(errno)))") }
        return result
    }
    static func info(_ fd: Int32) throws -> stat {
        var value = stat(); _ = try checked(fstat(fd, &value), "Inspect directory"); return value
    }
    static func namedInfo(_ fd: Int32, _ name: String) throws -> stat {
        var value = stat(); _ = try checked(fstatat(fd, name, &value, AT_SYMLINK_NOFOLLOW), "Inspect entry"); return value
    }
    static func same(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }
    static func directory(_ fd: Int32, _ name: String) throws -> Int32 {
        try checked(openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "Open directory")
    }
    static func string(_ input: [String: Any], _ key: String, limit: Int = 4096) throws -> String {
        guard let value = input[key] as? String, !value.isEmpty, value.utf8.count <= limit, !value.contains("\0") else { throw fail("Invalid \(key)") }
        return value
    }
    static func canonical(_ path: String) throws {
        guard path.hasPrefix("/"), let resolved = realpath(path, nil) else { throw fail("Project directory is unavailable") }
        defer { free(resolved) }
        guard String(cString: resolved) == path else { throw fail("Project directory is no longer canonical") }
    }
    static func entry(_ cwd: String, _ path: String, _ nonce: String, _ project: stat, _ dir: stat) -> [String: Any] {
        ["cwd": cwd, "path": path, "nonce": nonce, "projectDev": String(project.st_dev), "projectIno": String(project.st_ino), "dev": String(dir.st_dev), "ino": String(dir.st_ino)]
    }
    static func matches(_ value: stat, _ input: [String: Any], prefix: String) -> Bool {
        String(value.st_dev) == input[prefix.isEmpty ? "dev" : "projectDev"] as? String && String(value.st_ino) == input[prefix.isEmpty ? "ino" : "projectIno"] as? String
    }
    static func privateDirectory(_ value: stat) throws {
        guard value.st_mode & S_IFMT == S_IFDIR, value.st_uid == getuid(), value.st_mode & 0o077 == 0 else { throw fail("Temporary directory identity or private permissions changed") }
    }
    static func marker(_ fd: Int32, nonce: String) throws {
        let file = try checked(openat(fd, ".saleh-owner", O_RDONLY | O_NOFOLLOW | O_CLOEXEC), "Open ownership marker")
        defer { close(file) }
        let meta = try info(file)
        guard meta.st_mode & S_IFMT == S_IFREG, meta.st_size == nonce.utf8.count else { throw fail("Temporary ownership marker changed") }
        var bytes = [UInt8](repeating: 0, count: nonce.utf8.count + 1)
        let count = bytes.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
        guard count == nonce.utf8.count, Data(bytes.prefix(count)) == Data(nonce.utf8) else { throw fail("Temporary ownership marker changed") }
    }
    static func requireContents(_ fd: Int32, _ allowed: Set<String>) throws {
        let copy = try directory(fd, ".")
        guard let stream = fdopendir(copy) else { close(copy); throw fail("Inspect temporary contents failed") }
        defer { closedir(stream) }
        var found = Set<String>()
        while true {
            errno = 0
            guard let record = readdir(stream) else { if errno != 0 { throw fail("Inspect temporary contents failed") }; break }
            let name = withUnsafePointer(to: &record.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(record.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard allowed.contains(name) else { throw fail("Temporary directory contains pre-existing or concurrent data; preserved") }
            found.insert(name)
        }
        guard found == allowed else { throw fail("Temporary directory contents changed; preserved") }
    }
    // Never follows a child symlink; every descent is opened relative to its held parent.
    static func empty(_ fd: Int32, depth: Int = 0) throws {
        guard depth < 128 else { throw fail("Temporary cleanup depth limit reached; remaining files preserved") }
        let copy = try checked(dup(fd), "Duplicate directory")
        guard let stream = fdopendir(copy) else { close(copy); throw fail("Read temporary directory failed") }
        defer { closedir(stream) }
        while true {
            errno = 0
            guard let record = readdir(stream) else { if errno != 0 { throw fail("Read temporary entries failed") }; break }
            let name = withUnsafePointer(to: &record.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(record.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            let before = try namedInfo(fd, name)
            if before.st_mode & S_IFMT == S_IFDIR {
                let child = try directory(fd, name)
                do {
                    guard same(before, try info(child)) else { throw fail("Temporary child was replaced; preserved") }
                    try empty(child, depth: depth + 1)
                    guard same(before, try namedInfo(fd, name)) else { throw fail("Temporary child was replaced; preserved") }
                    _ = try checked(unlinkat(fd, name, AT_REMOVEDIR), "Remove temporary directory")
                    close(child)
                } catch { close(child); throw error }
            } else {
                _ = try checked(unlinkat(fd, name, 0), "Remove temporary file")
            }
        }
    }
    static func run(_ action: String, _ input: [String: Any]) throws -> [String: Any] {
        let keys: Set<String> = action == "create" ? ["cwd", "nonce"] : ["cwd", "path", "nonce", "projectDev", "projectIno", "dev", "ino"]
        guard ["create", "verify", "remove"].contains(action), Set(input.keys) == keys else { throw fail("Invalid temporary operation") }
        let cwd = try string(input, "cwd"), nonce = try string(input, "nonce", limit: 100)
        guard UUID(uuidString: nonce) != nil else { throw fail("Invalid ownership nonce") }
        try canonical(cwd)
        let project = try checked(open(cwd, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "Open project")
        defer { close(project) }
        let projectInfo = try info(project)
        try canonical(cwd)
        var path: String, name: String, fd: Int32
        if action == "create" {
            name = ".saleh-coding-tmp-" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            path = (cwd as NSString).appendingPathComponent(name)
            _ = try checked(mkdirat(project, name, 0o700), "Create temporary directory")
            fd = try directory(project, name)
            defer { close(fd) }
            let created = try info(fd); try privateDirectory(created)
            // Establish ownership only on an empty held directory, never existing data.
            try requireContents(fd, [])
            let file = try checked(openat(fd, ".saleh-owner", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600), "Create ownership marker")
            let bytes = Array(nonce.utf8)
            let count = bytes.withUnsafeBytes { Darwin.write(file, $0.baseAddress, $0.count) }
            close(file)
            guard count == bytes.count else { throw fail("Write ownership marker failed; directory preserved") }
            guard same(created, try namedInfo(project, name)) else { throw fail("Temporary directory was replaced; preserved") }
            try marker(fd, nonce: nonce)
            try requireContents(fd, [".saleh-owner"])
            return entry(cwd, path, nonce, projectInfo, created)
        }
        path = try string(input, "path"); name = (path as NSString).lastPathComponent
        guard (path as NSString).deletingLastPathComponent == cwd, name.range(of: "^\\.saleh-coding-tmp-[A-Za-z0-9_-]+$", options: .regularExpression) != nil, matches(projectInfo, input, prefix: "project") else { throw fail("Temporary project ownership changed") }
        fd = try directory(project, name)
        defer { close(fd) }
        let current = try info(fd); try privateDirectory(current)
        guard matches(current, input, prefix: ""), same(current, try namedInfo(project, name)) else { throw fail("Temporary directory identity changed") }
        try marker(fd, nonce: nonce)
        if action == "verify" { return ["verified": true] }
        try empty(fd)
        guard same(current, try namedInfo(project, name)) else { throw fail("Temporary directory was replaced; preserved") }
        _ = try checked(unlinkat(project, name, AT_REMOVEDIR), "Remove owned temporary directory")
        return ["removed": true]
    }
    static func command(_ arguments: [String]) -> Int32 {
        do {
            guard arguments.count == 4, arguments[3].utf8.count <= 16384,
                  let data = arguments[3].data(using: .utf8), let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("Invalid temporary operation input") }
            let output = try run(arguments[2], input)
            let encoded = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
            FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data([10])); return 0
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8)); return 1
        }
    }
}
