import Foundation
import CryptoKit
import Darwin

// Startup receipts contain a fixed schema and allowlisted error categories.
// Provider output, environment values, source lines and arbitrary paths are never persisted.
struct NoieeRuntimeContract: Decodable, Sendable {
    struct Node: Decodable, Sendable {
        let version: String
        let executableSHA256: String
        let candidates: [String]
    }
    struct Backend: Decodable, Sendable { let host: String; let port: Int }
    let schemaVersion: Int
    let node: Node
    let backend: Backend

    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 16_384,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["schemaVersion", "node", "backend"],
              let node = value["node"] as? [String: Any],
              Set(node.keys) == ["version", "executableSHA256", "candidates"],
              let backend = value["backend"] as? [String: Any],
              Set(backend.keys) == ["host", "port"] else { throw NoieeStartupFailure(.invalidContract) }
        let contract = try JSONDecoder().decode(Self.self, from: data)
        guard contract.schemaVersion == 1,
              validVersion(contract.node.version),
              contract.node.executableSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              contract.node.candidates == ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
              contract.backend.host == "127.0.0.1", contract.backend.port == 8787 else {
            throw NoieeStartupFailure(.invalidContract)
        }
        return contract
    }

    static func validVersion(_ value: String) -> Bool {
        value.range(of: "^v[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil
    }
}

enum NoieeStartupCode: String, Codable, Sendable {
    case missingResources, missingContract, invalidContract, missingBackend
    case missingConfiguration, invalidConfiguration, missingRuntime, runtimeChanged
    case incompatibleRuntime, runtimeProbeFailed, runtimeProbeTimedOut
    case portOccupied, portCheckFailed, backendDependencyMissing, backendSyntaxError
    case backendExited, backendTimedOut, accessUnavailable, unexpectedBackendExit
}

struct NoieeStartupFailure: Error, LocalizedError, Sendable {
    let code: NoieeStartupCode
    let requiredVersion: String?
    let observedVersion: String?
    let exitStatus: Int32?
    let runtimeDiagnostics: NoieeStderrSummary?

    init(_ code: NoieeStartupCode, required: String? = nil, observed: String? = nil, exit: Int32? = nil, diagnostics: NoieeStderrSummary? = nil) {
        self.code = code
        self.requiredVersion = required.flatMap { NoieeRuntimeContract.validVersion($0) ? $0 : nil }
        self.observedVersion = observed.flatMap { NoieeRuntimeContract.validVersion($0) ? $0 : nil }
        self.exitStatus = exit
        self.runtimeDiagnostics = diagnostics
    }

    var errorDescription: String? {
        switch code {
        case .missingResources, .missingContract, .invalidContract, .missingBackend:
            return "Noiee's installed application resources are missing or invalid. Reinstall a verified Noiee build; changing model settings will not repair this."
        case .missingConfiguration, .invalidConfiguration:
            return "Noiee's bundled workspace configuration is missing or invalid. Reinstall the verified app while keeping its existing data. Your saved workspace was not opened by this startup check."
        case .missingRuntime:
            return "Noiee needs Node.js \(requiredVersion ?? "at its qualified version") at /opt/homebrew/bin/node or /usr/local/bin/node. Install the supported runtime, then reopen Noiee. Your saved data stays in place."
        case .incompatibleRuntime:
            return "This Noiee build supports Node.js \(requiredVersion ?? "at its qualified version"); it found \(observedVersion ?? "an unrecognized version"). Use the supported runtime or a Noiee update qualified for the new version."
        case .runtimeChanged:
            return "The installed Node.js executable has changed from the version qualified for this Noiee build. Use a verified supported runtime or update Noiee; no workspace was started."
        case .runtimeProbeTimedOut:
            return "Node.js did not complete its startup check. Repair the supported Node installation and reopen Noiee."
        case .runtimeProbeFailed:
            return "The Node.js runtime could not run its startup check. Its installation or required libraries may be incomplete. Repair the supported Node installation and reopen Noiee."
        case .portOccupied:
            return "Another process is already using Noiee's local port 8787. Quit the other Noiee window or the app using that port, then reopen Noiee. No process was stopped automatically."
        case .portCheckFailed:
            return "Noiee could not verify its local listening port. Open Startup Report in Diagnostics for the failure category, then reopen Noiee after resolving the local runtime problem."
        case .backendDependencyMissing:
            return "Noiee's local server reported a missing or unloadable dependency. Reinstall a verified Noiee build and its supported runtime; this is not a model-selection problem."
        case .backendSyntaxError:
            return "Noiee's local server could not load its bundled JavaScript. Reinstall a verified Noiee build and its supported runtime."
        case .backendExited:
            return "Noiee's local server exited before it became ready. Open Startup Report in Diagnostics for the failure category and exit status. Your saved workspace has not been replaced."
        case .backendTimedOut:
            return "Noiee's local server started but did not confirm readiness in time. Open Startup Report in Diagnostics. Quit normally before trying again; no duplicate server was started."
        case .accessUnavailable:
            return "Noiee could not verify its saved tool-access or recovery state. That state was preserved. Review the access error and recovery instructions before reopening."
        case .unexpectedBackendExit:
            return "Noiee's local server stopped after startup. Pending tool authority was revoked. Reopen Noiee normally and inspect any incomplete result before retrying work."
        }
    }
}

struct NoieeStderrSummary: Codable, Sendable, Equatable {
    let receivedBytes: Int
    let capturedBytes: Int
    let truncated: Bool
    let categories: [String]
    let redactedPreview: [String]

    static func redact(_ data: Data, received: Int, limit: Int) -> Self {
        let text = String(decoding: data, as: UTF8.self)
        let allowed = ["EADDRINUSE", "EACCES", "EPERM", "ENOENT", "ERR_MODULE_NOT_FOUND",
                       "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_UNKNOWN_BUILTIN_MODULE",
                       "ERR_REQUIRE_ESM", "SyntaxError", "Library not loaded", "dyld"]
        let found = allowed.filter { text.range(of: "(?<![A-Za-z0-9_])" + NSRegularExpression.escapedPattern(for: $0) + "(?![A-Za-z0-9_])", options: .regularExpression) != nil }
        return Self(receivedBytes: received, capturedBytes: data.count,
                    truncated: received > limit, categories: found,
                    redactedPreview: found.isEmpty ? (received == 0 ? [] : ["Unrecognized diagnostic text omitted."]) :
                        found.map { "Reported \($0); paths, source text and values omitted." })
    }
}

final class NoieeBoundedCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var received = 0
    private var active = true
    let limit: Int
    init(limit: Int = 8192) { self.limit = limit }
    func append(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard active else { return }
        received = min(Int.max - data.count, received) + data.count
        if bytes.count < limit { bytes.append(data.prefix(limit - bytes.count)) }
    }
    func snapshot() -> (Data, Int) {
        lock.lock(); defer { lock.unlock() }
        return (bytes, received)
    }
    func summary() -> NoieeStderrSummary {
        let (data, count) = snapshot()
        return .redact(data, received: count, limit: limit)
    }
    @discardableResult func finish() -> NoieeStderrSummary {
        lock.lock()
        let data = bytes, count = received
        bytes.removeAll(keepingCapacity: false); received = 0; active = false
        lock.unlock()
        return .redact(data, received: count, limit: limit)
    }
}

struct NoieeVerifiedRuntime: Sendable {
    let executable: URL
    let version: String
    let executableSHA256: String
    let contractSHA256: String
}

enum NoieeStartupPreflight {
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func regularData(_ url: URL, limit: Int) throws -> Data {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw NoieeStartupFailure(.invalidConfiguration) }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var before = stat(), after = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_nlink == 1, before.st_size >= 0, before.st_size <= limit else {
            throw NoieeStartupFailure(.invalidConfiguration)
        }
        let data = try file.read(upToCount: limit + 1) ?? Data()
        guard fstat(fd, &after) == 0, data.count == before.st_size,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw NoieeStartupFailure(.invalidConfiguration) }
        return data
    }

    static func checkPort(_ port: Int) throws {
        guard (0...65535).contains(port) else { throw NoieeStartupFailure(.portCheckFailed) }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NoieeStartupFailure(.portCheckFailed) }
        defer { close(fd) }
        // Match Node's listener policy: TIME_WAIT is reusable, a live listener is not.
        var reuse: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw NoieeStartupFailure(.portCheckFailed)
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(port).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else { throw NoieeStartupFailure(errno == EADDRINUSE ? .portOccupied : .portCheckFailed) }
    }

    // Runs only --version, with bounded readers and a deadline. It never starts the app backend.
    static func probeVersion(_ executable: URL, expected: String, timeout: TimeInterval = 3) throws -> String {
        let process = Process(), output = Pipe(), errors = Pipe()
        let stdout = NoieeBoundedCapture(limit: 256), stderr = NoieeBoundedCapture()
        process.executableURL = executable; process.arguments = ["--version"]
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output; process.standardError = errors
        let outputEnded = DispatchSemaphore(value: 0), errorEnded = DispatchSemaphore(value: 0)
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; outputEnded.signal() } else { stdout.append(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; errorEnded.signal() } else { stderr.append(data) }
        }
        defer {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            try? output.fileHandleForReading.close(); try? errors.fileHandleForReading.close()
            stdout.finish(); stderr.finish()
        }
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        do {
            try process.run()
            try? output.fileHandleForWriting.close(); try? errors.fileHandleForWriting.close()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            throw NoieeStartupFailure(.runtimeProbeFailed, required: expected)
        }
        if ended.wait(timeout: .now() + timeout) == .timedOut {
            if process.isRunning { process.terminate() }
            if ended.wait(timeout: .now() + 0.5) == .timedOut, process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                _ = ended.wait(timeout: .now() + 0.5)
            }
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            throw NoieeStartupFailure(.runtimeProbeTimedOut, required: expected, diagnostics: stderr.summary())
        }
        // A retained pipe never creates an unbounded synchronous read.
        guard outputEnded.wait(timeout: .now() + 0.5) == .success,
              errorEnded.wait(timeout: .now() + 0.5) == .success else {
            throw NoieeStartupFailure(.runtimeProbeFailed, required: expected)
        }
        let (data, count) = stdout.snapshot()
        let version = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationReason == .exit, process.terminationStatus == 0,
              stderr.snapshot().1 == 0, count <= 256, NoieeRuntimeContract.validVersion(version) else {
            throw NoieeStartupFailure(.runtimeProbeFailed, required: expected, exit: process.terminationStatus, diagnostics: stderr.summary())
        }
        guard version == expected else { throw NoieeStartupFailure(.incompatibleRuntime, required: expected, observed: version) }
        return version
    }

    static func verifyRuntime(_ contract: NoieeRuntimeContract) throws -> NoieeVerifiedRuntime {
        let manager = FileManager.default
        guard let candidate = contract.node.candidates.first(where: { manager.isExecutableFile(atPath: $0) }) else {
            throw NoieeStartupFailure(.missingRuntime, required: contract.node.version)
        }
        let executable = URL(fileURLWithPath: candidate).resolvingSymlinksInPath()
        let before: String
        do { before = digest(try regularData(executable, limit: 256 * 1024 * 1024)) }
        catch { throw NoieeStartupFailure(.runtimeChanged, required: contract.node.version) }
        guard before == contract.node.executableSHA256 else {
            throw NoieeStartupFailure(.runtimeChanged, required: contract.node.version)
        }
        let version = try probeVersion(executable, expected: contract.node.version)
        guard digest(try regularData(executable, limit: 256 * 1024 * 1024)) == before else {
            throw NoieeStartupFailure(.runtimeChanged, required: contract.node.version, observed: version)
        }
        return NoieeVerifiedRuntime(executable: executable, version: version,
                                    executableSHA256: before, contractSHA256: "")
    }

    static func prepare(resources: URL) throws -> NoieeVerifiedRuntime {
        let manager = FileManager.default, contractURL = resources.appendingPathComponent("runtime-contract.json")
        guard manager.fileExists(atPath: contractURL.path) else { throw NoieeStartupFailure(.missingContract) }
        let bytes: Data, contract: NoieeRuntimeContract
        do { bytes = try regularData(contractURL, limit: 16_384); contract = try .decode(bytes) }
        catch { throw NoieeStartupFailure(.invalidContract) }
        let config = resources.appendingPathComponent("owned-runtime.json")
        guard manager.fileExists(atPath: config.path) else { throw NoieeStartupFailure(.missingConfiguration) }
        do { _ = try regularData(config, limit: 262_144); _ = try OwnedRuntimePaths(resources: resources) }
        catch { throw NoieeStartupFailure(.invalidConfiguration) }
        do { _ = try regularData(resources.appendingPathComponent("server.mjs"), limit: 1024 * 1024) }
        catch { throw NoieeStartupFailure(.missingBackend) }
        let runtime = try verifyRuntime(contract)
        try checkPort(contract.backend.port)
        return NoieeVerifiedRuntime(executable: runtime.executable, version: runtime.version,
                                    executableSHA256: runtime.executableSHA256, contractSHA256: digest(bytes))
    }

    static func backendFailure(exited: Bool, status: Int32?, stderr: NoieeStderrSummary) -> NoieeStartupFailure {
        let codes = Set(stderr.categories)
        if codes.contains("EADDRINUSE") { return NoieeStartupFailure(.portOccupied, exit: status) }
        if !codes.isDisjoint(with: ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_UNKNOWN_BUILTIN_MODULE"]) {
            return NoieeStartupFailure(.backendDependencyMissing, exit: status)
        }
        if codes.contains("SyntaxError") { return NoieeStartupFailure(.backendSyntaxError, exit: status) }
        return NoieeStartupFailure(exited ? .backendExited : .backendTimedOut, exit: status)
    }
}

struct NoieeStartupReceipt: Encodable, Sendable {
    let schemaVersion = 1
    let recordedAt: String
    let build: String
    let outcome: String
    let phase: String
    let failureCode: NoieeStartupCode?
    let exitStatus: Int32?
    let requiredNodeVersion: String?
    let observedNodeVersion: String?
    let nodeExecutableSHA256: String?
    let runtimeContractSHA256: String?
    let stderr: NoieeStderrSummary
    let rawDiagnosticTextPersisted = false
    let originalStoresOpenedByDiagnostics = false
}

enum NoieeStartupReports {
    static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Noiee/Startup", isDirectory: true)
    }
    static func write(_ receipt: NoieeStartupReceipt, root: URL = defaultRoot) throws -> URL {
        let manager = FileManager.default
        // Foundation home URLs can lose their directory hint when resolving a
        // missing path. Canonical filesystem paths must match; URL hints need not.
        guard root.isFileURL, root.standardizedFileURL.path == root.path,
              root.resolvingSymlinksInPath().path == root.path else {
            throw NoieeStartupFailure(.invalidConfiguration)
        }
        // Only the new diagnostics directories are created; no app store or history is read.
        for directory in [root.deletingLastPathComponent(), root] {
            if !manager.fileExists(atPath: directory.path) {
                try manager.createDirectory(at: directory, withIntermediateDirectories: false,
                                            attributes: [.posixPermissions: 0o700])
            }
            var info = stat()
            guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
                  info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
                throw NoieeStartupFailure(.invalidConfiguration)
            }
        }
        let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw NoieeStartupFailure(.invalidConfiguration) }
        defer { close(fd) }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(receipt)
        guard data.count <= 16_384 else { throw NoieeStartupFailure(.invalidConfiguration) }
        let name = "startup-" + UUID().uuidString.lowercased() + ".json"
        let output = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard output >= 0 else { throw NoieeStartupFailure(.invalidConfiguration) }
        let file = FileHandle(fileDescriptor: output, closeOnDealloc: true)
        defer { try? file.close() }
        try file.write(contentsOf: data); try file.synchronize()
        return root.appendingPathComponent(name)
    }
}


// Main-actor caller owns this value. No process, UI, timer, or original store
// operation is performed here; tokens reject stale asynchronous completions.
struct NoieeStartupLifecycle {
    enum Phase: Equatable { case idle, preflight, paused, backend, ready, failed, closed }
    enum ResumeAction: Equatable { case restart, present, none }
    struct NavigationPermit: Equatable {
        let attempt: UUID
        let generation: Int
        fileprivate let identity = UUID()
    }
    private(set) var phase: Phase = .idle
    private(set) var attempt: UUID?
    private(set) var presented = false
    private var departure: UUID?
    private var navigation: NavigationPermit?
    var quitting: Bool { departure != nil }

    func owns(_ ticket: UUID) -> Bool { attempt == ticket && phase != .closed }
    mutating func beginStartup() -> UUID? {
        guard !quitting, phase == .idle || phase == .paused else { return nil }
        let ticket = UUID()
        attempt = ticket; phase = .preflight; presented = false; navigation = nil
        return ticket
    }
    mutating func continuePreflight(_ ticket: UUID) -> Bool {
        guard owns(ticket), phase == .preflight else { return false }
        if quitting { phase = .paused; return false }
        return true
    }
    mutating func authorizeBackendLaunch(_ ticket: UUID) -> Bool {
        guard continuePreflight(ticket) else { return false }
        phase = .backend
        return true
    }
    mutating func markReady(_ ticket: UUID) -> Bool {
        guard owns(ticket), phase == .backend else { return false }
        phase = .ready
        return true
    }
    mutating func markFailed(_ ticket: UUID) -> Bool {
        guard owns(ticket), [.preflight, .backend, .ready].contains(phase) else { return false }
        phase = .failed; navigation = nil
        return true
    }
    mutating func beginQuit() -> UUID? {
        guard !quitting, phase != .closed else { return nil }
        let ticket = UUID()
        departure = ticket; navigation = nil
        return ticket
    }
    mutating func cancelQuit(_ ticket: UUID) -> ResumeAction? {
        guard departure == ticket, phase != .closed else { return nil }
        departure = nil
        switch phase {
        case .idle, .paused: return .restart
        case .ready, .failed: return .present
        default: return ResumeAction.none
        }
    }
    mutating func completeQuit(_ ticket: UUID) -> Bool {
        guard departure == ticket, phase != .closed else { return false }
        phase = .closed; navigation = nil
        return true
    }
    mutating func invalidateNavigation() { navigation = nil }
    mutating func beginNavigation(generation: Int) -> NavigationPermit? {
        guard phase == .ready, !quitting, !presented, navigation == nil,
              let attempt else { return nil }
        let permit = NavigationPermit(attempt: attempt, generation: generation)
        navigation = permit
        return permit
    }
    mutating func finishNavigation(_ permit: NavigationPermit, generation: Int,
                                   startupDocument: Bool, blocked: Bool) -> Bool {
        guard navigation == permit else { return false }
        navigation = nil
        guard owns(permit.attempt), phase == .ready, !quitting, !presented,
              !blocked, permit.generation == generation, startupDocument else { return false }
        presented = true
        return true
    }
}
