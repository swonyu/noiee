import Foundation
import Darwin

@main
struct StartupFixture {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).resolvingSymlinksInPath()
        var checks = 0
        func check(_ condition: Bool, _ label: String) {
            guard condition else { print("FAIL: " + label); exit(1) }
            checks += 1
        }
        func refuses(_ code: NoieeStartupCode, _ body: () throws -> Void) {
            do { try body(); print("FAIL: expected " + code.rawValue); exit(1) }
            catch let error as NoieeStartupFailure { check(error.code == code, "exact refusal " + code.rawValue) }
            catch { print("FAIL: unclassified refusal"); exit(1) }
        }
        func script(_ name: String, _ body: String) throws -> URL {
            let path = root.appendingPathComponent(name)
            try Data(("#!/bin/sh\n" + body + "\n").utf8).write(to: path, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
            return path
        }
        let version = "v26.13.0"
        let valid = #"{"schemaVersion":1,"node":{"version":"v26.13.0","executableSHA256":"7296c3dda88793e08d1089d839a782178c4bba6bb22f5c40ab2a75263fb071bd","candidates":["/opt/homebrew/bin/node","/usr/local/bin/node"]},"backend":{"host":"127.0.0.1","port":8787}}"#
        let decoded = try NoieeRuntimeContract.decode(Data(valid.utf8))
        check(decoded.node.version == version, "exact production contract")
        refuses(.invalidContract) { _ = try NoieeRuntimeContract.decode(Data(valid.replacingOccurrences(of: "v26.13.0", with: ">=v26").utf8)) }
        refuses(.invalidContract) { _ = try NoieeRuntimeContract.decode(Data(valid.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2").utf8)) }
        refuses(.invalidContract) { _ = try NoieeRuntimeContract.decode(Data(valid.replacingOccurrences(of: "\"127.0.0.1\"", with: "\"example.com\"").utf8)) }
        refuses(.invalidContract) { _ = try NoieeRuntimeContract.decode(Data(valid.replacingOccurrences(of: "8787", with: "9999").utf8)) }
        refuses(.invalidContract) { _ = try NoieeRuntimeContract.decode(Data(valid.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"extra\":true,\"schemaVersion\":1").utf8)) }

        let capture = NoieeBoundedCapture(limit: 128)
        capture.append(Data(("ERR_MODULE_NOT_FOUND /Users/private/secret\nBearer sk-SHOULD-NOT-APPEAR\n" + String(repeating: "private", count: 1000)).utf8))
        let summary = capture.finish()
        check(summary.capturedBytes == 128 && summary.truncated, "bounded capture")
        check(summary.categories == ["ERR_MODULE_NOT_FOUND"], "allowlisted code")
        let redacted = String(decoding: try JSONEncoder().encode(summary), as: UTF8.self)
        check(!redacted.contains("SHOULD-NOT-APPEAR") && !redacted.contains("/Users/private") && !redacted.contains("Bearer"), "secrets and paths omitted")
        capture.append(Data("EADDRINUSE".utf8))
        check(capture.snapshot().0.isEmpty, "ready/finished capture ignores later output")
        check(NoieeStartupPreflight.backendFailure(exited: true, status: 1, stderr: summary).code == .backendDependencyMissing, "dependency failure is not port error")
        let portError = NoieeStderrSummary.redact(Data("Error: EADDRINUSE secret=abc".utf8), received: 32, limit: 8192)
        check(NoieeStartupPreflight.backendFailure(exited: true, status: 1, stderr: portError).code == .portOccupied, "reported port conflict")
        let unknown = NoieeStderrSummary.redact(Data("private unknown problem".utf8), received: 23, limit: 8192)
        check(NoieeStartupPreflight.backendFailure(exited: true, status: 9, stderr: unknown).code == .backendExited, "unknown exit stays unknown")
        check(NoieeStartupPreflight.backendFailure(exited: false, status: nil, stderr: unknown).code == .backendTimedOut, "readiness timeout distinct")
        let syntax = NoieeStderrSummary.redact(Data("SyntaxError: secret text".utf8), received: 24, limit: 8192)
        check(NoieeStartupPreflight.backendFailure(exited: true, status: 1, stderr: syntax).code == .backendSyntaxError, "syntax failure distinct")

        let good = try script("good-node", "printf 'v26.13.0\\n'")
        check(try NoieeStartupPreflight.probeVersion(good, expected: version) == version, "generated version process")
        let old = try script("old-node", "printf 'v1.0.0\\n'")
        refuses(.incompatibleRuntime) { _ = try NoieeStartupPreflight.probeVersion(old, expected: version) }
        let noisy = try script("noisy-node", "printf 'v26.13.0\\n'; printf 'ERR_DLOPEN_FAILED sk-NO-LOG\\n' >&2; exit 1")
        refuses(.runtimeProbeFailed) { _ = try NoieeStartupPreflight.probeVersion(noisy, expected: version) }
        let hung = try script("hung-node", "while :; do :; done")
        let start = Date()
        refuses(.runtimeProbeTimedOut) { _ = try NoieeStartupPreflight.probeVersion(hung, expected: version, timeout: 0.1) }
        check(Date().timeIntervalSince(start) < 2, "probe deadline remains bounded")
        let tooMuch = try script("large-node", "i=0; while [ \"$i\" -lt 2048 ]; do printf x; i=$((i+1)); done")
        refuses(.runtimeProbeFailed) { _ = try NoieeStartupPreflight.probeVersion(tooMuch, expected: version) }
        let hash = NoieeStartupPreflight.digest(try Data(contentsOf: good))
        let generatedContract = NoieeRuntimeContract(schemaVersion: 1,
            node: .init(version: version, executableSHA256: hash, candidates: [good.path]),
            backend: .init(host: "127.0.0.1", port: 8787))
        check(try NoieeStartupPreflight.verifyRuntime(generatedContract).executableSHA256 == hash, "generated runtime identity")
        let mismatch = NoieeRuntimeContract(schemaVersion: 1,
            node: .init(version: version, executableSHA256: String(repeating: "0", count: 64), candidates: [good.path]),
            backend: .init(host: "127.0.0.1", port: 8787))
        refuses(.runtimeChanged) { _ = try NoieeStartupPreflight.verifyRuntime(mismatch) }
        let missing = NoieeRuntimeContract(schemaVersion: 1,
            node: .init(version: version, executableSHA256: hash, candidates: [root.appendingPathComponent("absent").path]),
            backend: .init(host: "127.0.0.1", port: 8787))
        refuses(.missingRuntime) { _ = try NoieeStartupPreflight.verifyRuntime(missing) }

        // Only ephemeral fixture ports are used; the installed app's port is never probed.
        try NoieeStartupPreflight.checkPort(0); check(true, "available ephemeral port")
        var listener = socket(AF_INET, SOCK_STREAM, 0); check(listener >= 0, "fixture socket")
        defer { if listener >= 0 { close(listener) } }
        var reuse: Int32 = 1
        check(setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0, "fixture Node-style reuse policy")
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0; address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        } }
        check(bound == 0, "fixture bind")
        check(listen(listener, 1) == 0, "fixture live listener")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let found = withUnsafeMutablePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(listener, $0, &length)
        } }
        check(found == 0, "fixture port")
        let port = Int(UInt16(bigEndian: address.sin_port))
        refuses(.portOccupied) { try NoieeStartupPreflight.checkPort(port) }
        let client = socket(AF_INET, SOCK_STREAM, 0)
        check(client >= 0, "fixture client")
        let connected = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(client, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        } }
        check(connected == 0, "fixture loopback connection")
        let accepted = accept(listener, nil, nil)
        check(accepted >= 0, "fixture accepted connection")
        var deadline = timeval(tv_sec: 1, tv_usec: 0)
        check(setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size)) == 0, "fixture client deadline")
        check(setsockopt(accepted, SOL_SOCKET, SO_RCVTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size)) == 0, "fixture server deadline")
        check(shutdown(accepted, SHUT_WR) == 0, "server initiates connection close")
        var byte: UInt8 = 0
        check(recv(client, &byte, 1, 0) == 0, "client observes server EOF")
        check(shutdown(client, SHUT_WR) == 0, "client completes close")
        check(recv(accepted, &byte, 1, 0) == 0, "server observes peer EOF")
        close(accepted); close(client); close(listener); listener = -1
        try NoieeStartupPreflight.checkPort(port)
        check(true, "immediate relaunch accepts recently closed loopback connection")

        let resources = root.appendingPathComponent("resources", isDirectory: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        refuses(.missingContract) { _ = try NoieeStartupPreflight.prepare(resources: resources) }
        try Data(valid.utf8).write(to: resources.appendingPathComponent("runtime-contract.json"), options: .withoutOverwriting)
        refuses(.missingConfiguration) { _ = try NoieeStartupPreflight.prepare(resources: resources) }
        try Data("invalid".utf8).write(to: resources.appendingPathComponent("owned-runtime.json"), options: .withoutOverwriting)
        refuses(.invalidConfiguration) { _ = try NoieeStartupPreflight.prepare(resources: resources) }
        try Data(#"{"dataDir":"/fixture/Coding","executor":{},"limits":{}}"#.utf8).write(to: resources.appendingPathComponent("owned-runtime.json"))
        refuses(.missingBackend) { _ = try NoieeStartupPreflight.prepare(resources: resources) }

        let report = NoieeStartupReceipt(recordedAt: "fixture", build: "172", outcome: "failed", phase: "fixture",
            failureCode: .backendDependencyMissing, exitStatus: 1, requiredNodeVersion: version,
            observedNodeVersion: version, nodeExecutableSHA256: hash, runtimeContractSHA256: hash, stderr: summary)
        let reportRoot = root.appendingPathComponent("reports/Startup", isDirectory: true)
        let first = try NoieeStartupReports.write(report, root: reportRoot)
        let second = try NoieeStartupReports.write(report, root: reportRoot)
        check(first != second, "exclusive support receipts")
        let reportData = try Data(contentsOf: first)
        check(reportData.count <= 16_384 && !String(decoding: reportData, as: UTF8.self).contains("SHOULD-NOT-APPEAR"), "bounded redacted disk receipt")
        let attributes = try FileManager.default.attributesOfItem(atPath: first.path)
        check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "private support receipt")
        let linked = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: root.appendingPathComponent("reports"))
        refuses(.invalidConfiguration) { _ = try NoieeStartupReports.write(report, root: linked.appendingPathComponent("Startup")) }

        // Deterministic event orderings for the same lifecycle value used by App.
        // These fixtures create no AppKit object, actual app, model, or data store.
        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            check(state.beginStartup() == nil, "startup task cannot be duplicated")
            let quit = state.beginQuit()!
            check(!state.continuePreflight(start) && state.phase == .paused, "Quit before preflight pauses all launch work")
            check(!state.authorizeBackendLaunch(start), "paused startup cannot create an access marker or child")
            check(state.completeQuit(quit) && state.phase == .closed, "closed no-server decision remains terminal")
            check(!state.markReady(start) && !state.markFailed(start) && state.beginStartup() == nil, "late startup completions cannot reopen a closed app")
        }
        do {
            var state = NoieeStartupLifecycle()
            let old = state.beginStartup()!
            check(state.continuePreflight(old), "active preflight may observe runtime")
            let quit = state.beginQuit()!
            check(!state.authorizeBackendLaunch(old) && state.phase == .paused, "Quit during preflight revokes backend launch")
            check(!state.markFailed(old), "paused preflight error cannot replace cancellation state")
            check(state.cancelQuit(quit) == .restart, "cancelled early Quit requests a fresh startup")
            let current = state.beginStartup()!
            check(current != old && !state.authorizeBackendLaunch(old), "retry gets new authority and rejects old completion")
            check(!state.markReady(current), "preflight alone cannot report a ready backend")
            check(state.authorizeBackendLaunch(current) && state.markReady(current), "fresh retry can launch and become ready")
        }
        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            check(state.authorizeBackendLaunch(start), "backend launch is admitted before shutdown")
            let quit = state.beginQuit()!
            check(state.markReady(start) && state.quitting, "already launched backend finishes readiness under Quit ownership")
            check(state.beginNavigation(generation: 1) == nil, "ready backend cannot navigate during departure")
            check(state.cancelQuit(quit) == .present, "cancelled warm Quit resumes presentation without another process")
            let permit = state.beginNavigation(generation: 1)!
            check(state.finishNavigation(permit, generation: 1, startupDocument: true, blocked: false), "ready startup can present after cancelled Quit")
            check(state.beginStartup() == nil && state.beginNavigation(generation: 1) == nil, "warm cancellation neither duplicates backend nor page")
        }
        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            _ = state.authorizeBackendLaunch(start); _ = state.markReady(start)
            let stale = state.beginNavigation(generation: 3)!
            let quit = state.beginQuit()!
            check(!state.finishNavigation(stale, generation: 3, startupDocument: true, blocked: false), "Quit invalidates in-flight ready document evaluation")
            check(state.cancelQuit(quit) == .present, "pending presentation survives a cancelled Quit")
            let fresh = state.beginNavigation(generation: 3)!
            check(!state.finishNavigation(stale, generation: 3, startupDocument: true, blocked: false), "stale callback cannot consume a newer navigation permit")
            check(state.finishNavigation(fresh, generation: 3, startupDocument: true, blocked: false), "fresh ready evaluation commits once")
            check(!state.finishNavigation(fresh, generation: 3, startupDocument: true, blocked: false), "duplicate ready callback is ignored")
        }
        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            _ = state.authorizeBackendLaunch(start); _ = state.markReady(start)
            let oldPage = state.beginNavigation(generation: 8)!
            check(!state.finishNavigation(oldPage, generation: 9, startupDocument: true, blocked: false), "page generation change rejects old ready navigation")
            let beforeBody = state.beginNavigation(generation: 9)!
            state.invalidateNavigation() // didFinish supplies a new document observation.
            let afterBody = state.beginNavigation(generation: 9)!
            check(!state.finishNavigation(beforeBody, generation: 9, startupDocument: false, blocked: false), "early body reply cannot clear the completed-document permit")
            check(!state.finishNavigation(afterBody, generation: 9, startupDocument: false, blocked: false), "non-startup document is never replaced")
            let held = state.beginNavigation(generation: 9)!
            check(!state.finishNavigation(held, generation: 9, startupDocument: true, blocked: true), "reload or newly closed backend blocks navigation")
            let restored = state.beginNavigation(generation: 9)!
            check(state.finishNavigation(restored, generation: 9, startupDocument: true, blocked: false), "released reload can finish pending startup presentation")
        }
        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            _ = state.authorizeBackendLaunch(start); _ = state.markReady(start)
            let permit = state.beginNavigation(generation: 2)!
            check(state.markFailed(start), "backend exit removes ready authority")
            check(!state.finishNavigation(permit, generation: 2, startupDocument: true, blocked: false), "dead backend cannot load its cached ready page")
            let quit = state.beginQuit()!
            check(state.cancelQuit(quit) == .present && state.beginStartup() == nil, "failed backend is reported without an unsafe automatic restart")
            check(!state.markReady(start), "late readiness cannot resurrect a failed process")
        }
        do {
            var state = NoieeStartupLifecycle()
            let first = state.beginStartup()!
            let oldQuit = state.beginQuit()!
            _ = state.continuePreflight(first)
            _ = state.cancelQuit(oldQuit)
            let retry = state.beginStartup()!
            let currentQuit = state.beginQuit()!
            check(state.beginQuit() == nil, "duplicate Quit cannot replace departure ownership")
            check(!state.completeQuit(oldQuit) && state.quitting, "old successful Quit cannot close a newer departure")
            check(state.cancelQuit(oldQuit) == nil && state.quitting, "old cancellation cannot unfreeze a newer departure")
            check(!state.authorizeBackendLaunch(retry), "second Quit still prevents the retry from launching")
            check(state.cancelQuit(currentQuit) == .restart, "current cancelled Quit can retry exactly its paused startup")
            let final = state.beginStartup()!
            check(final != retry && !state.markReady(retry), "repeated cancellation rejects every prior startup generation")
        }
        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            _ = state.authorizeBackendLaunch(start)
            let quit = state.beginQuit()!
            check(state.markFailed(start) && state.quitting, "startup failure during Quit stays owned by departure")
            check(state.cancelQuit(quit) == .present, "cancelled Quit exposes its deferred startup failure")
            let again = state.beginQuit()!
            check(state.completeQuit(again), "a later confirmed Quit closes the failed startup")
            check(state.cancelQuit(again) == nil && state.beginNavigation(generation: 0) == nil, "successful closure rejects cancellation and presentation")
        }

        do {
            var state = NoieeStartupLifecycle()
            let start = state.beginStartup()!
            let earlyQuit = state.beginQuit()!
            let preflightResume = state.cancelQuit(earlyQuit)
            check(preflightResume == .some(NoieeStartupLifecycle.ResumeAction.none) &&
                  !state.quitting && state.phase == .preflight,
                  "cancelling an active preflight returns a non-nil no-restart response")
            check(state.continuePreflight(start) && state.authorizeBackendLaunch(start) &&
                  state.beginStartup() == nil,
                  "preflight cancellation retains the same launch authority without duplication")
            let warmQuit = state.beginQuit()!
            let backendResume = state.cancelQuit(warmQuit)
            check(backendResume == .some(NoieeStartupLifecycle.ResumeAction.none) &&
                  !state.quitting && state.phase == .backend && state.beginStartup() == nil,
                  "cancelling backend readiness returns a non-nil no-restart response")
            check(state.markReady(start),
                  "backend cancellation preserves the existing process readiness generation")
        }

        print("{\"passed\":\(checks),\"failed\":0,\"appLaunches\":0,\"modelRequests\":0,\"originalStoreActions\":0,\"scope\":\"generated process, socket, config, lifecycle-race and support-report fixtures\"}")
    }
}
