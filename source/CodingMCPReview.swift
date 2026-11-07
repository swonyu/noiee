import Foundation

// Validation/display only. This creates no grant and cannot verify live process
// ownership itself. The caller must retain its native epoch, re-fetch the same
// public approval after review, call requireSame, and let the backend consume it.
enum CodingMCPReview {
    static let descriptorLimit = 65_536, displayLimit = 81_920
    private static let safeInteger = 9_007_199_254_740_991.0
    struct Failure: Error, LocalizedError, CustomStringConvertible {
        let description: String
        var errorDescription: String? { description }
    }
    enum RPCID: Equatable {
        case string(String), integer(Int64)
    }
    enum Decision: String { case accept, decline }
    struct Review {
        let publicID: String, key: String, generation: String
        let threadID: String, turnID: String, callID: String, rpcID: RPCID
        let descriptorID: String, server: String, tool: String
        let expiresAt: Double, context: String, display: String
        // Exact canonical bytes, not a lossy/short hash. Keep private to native
        // review flow; this fingerprint is not an execution capability.
        let fingerprint: Data
        func requireSame(_ fresh: [String:Any], requestedID: String, nowMS: Double = Date().timeIntervalSince1970 * 1000) throws {
            let other = try CodingMCPReview.validate(fresh, requestedID: requestedID, nowMS: nowMS)
            guard other.publicID == publicID, other.fingerprint == fingerprint else {
                throw CodingMCPReview.fail("The pending MCP call changed during review. No approval was sent; inspect a fresh request.")
            }
        }
    }
    private static func fail(_ message: String = "Invalid or over-limit Coding MCP review. No approval was sent.") -> Failure { Failure(description: message) }
    // This flow returns a decision only. The caller must check its epoch again
    // before dispatch; the backend must finally revalidate/consume the original
    // process-owned capability. Awaited sheet/read work is never treated as
    // cancelled merely because native ownership changed during that await.
    @MainActor static func reviewDecision(
        _ pending: [String:Any], requestedID: String,
        nowMS: () -> Double = { Date().timeIntervalSince1970 * 1000 },
        check: () throws -> Void,
        ask: (String) async throws -> Bool,
        readFresh: (String) async throws -> [String:Any]
    ) async throws -> Decision {
        let review = try validate(pending, requestedID: requestedID, nowMS: nowMS())
        func requireCurrent() throws { try Task.checkCancellation(); try check() }
        try requireCurrent()
        let accepted = try await ask(review.display)
        try requireCurrent()
        guard accepted else { return .decline }
        let fresh = try await readFresh(review.publicID)
        try requireCurrent()
        try review.requireSame(fresh, requestedID: review.publicID, nowMS: nowMS())
        return .accept
    }
    private static func exact(_ value: [String:Any], _ keys: Set<String>) throws {
        guard Set(value.keys) == keys else { throw fail() }
    }
    private static func object(_ value: Any?) throws -> [String:Any] {
        guard let result = value as? [String:Any] else { throw fail() }; return result
    }
    private static func identifier(_ value: Any?, max: Int) throws -> String {
        guard let result = value as? String, !result.isEmpty, result.utf16.count <= max,
              !result.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw fail() }
        return result
    }
    private static func integer(_ value: Any?) throws -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw fail() }
        let result = number.doubleValue
        guard result.isFinite, abs(result) <= safeInteger, result.rounded(.towardZero) == result else { throw fail() }
        return result
    }
    private static func canonical(_ value: Any, depthLimit: Int, nodeLimit: Int, byteLimit: Int) throws -> Data {
        var nodes = 0, contentBytes = 0
        func text(_ string: String) throws {
            let count = string.utf8.count
            guard count <= byteLimit - contentBytes else { throw fail() }; contentBytes += count
        }
        func visit(_ value: Any, _ depth: Int) throws {
            nodes += 1
            guard nodes <= nodeLimit, depth <= depthLimit else { throw fail() }
            if value is NSNull { return }
            if let value = value as? String { try text(value); return }
            if let value = value as? NSNumber { guard value.doubleValue.isFinite else { throw fail() }; return }
            if let value = value as? [String:Any] {
                for (key, child) in value { try text(key); try visit(child, depth + 1) }; return
            }
            if let value = value as? [Any] { for child in value { try visit(child, depth + 1) }; return }
            throw fail()
        }
        try visit(value, 0)
        let data: Data
        do { data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]) }
        catch { throw fail() }
        guard data.count <= byteLimit else { throw fail() }
        return data
    }
    static func validate(_ pending: [String:Any], requestedID: String, nowMS: Double = Date().timeIntervalSince1970 * 1000) throws -> Review {
        try exact(pending, ["id", "method", "params", "item"])
        let publicID = try identifier(pending["id"], max: 200)
        guard publicID == (try identifier(requestedID, max: 200)), pending["method"] as? String == "item/tool/call",
              pending["item"] is NSNull, nowMS.isFinite, nowMS >= 0, nowMS <= safeInteger else { throw fail() }
        let params = try object(pending["params"])
        try exact(params, ["key", "generation", "threadId", "turnId", "callId", "rpcId", "descriptor", "expiresAt"])
        let key = try identifier(params["key"], max: 36)
        guard key.utf16.count == 36, UUID(uuidString: key) != nil else { throw fail() }
        let generation = try identifier(params["generation"], max: 160)
        let threadID = try identifier(params["threadId"], max: 160)
        let turnID = try identifier(params["turnId"], max: 160)
        let callID = try identifier(params["callId"], max: 160)
        let rpcID: RPCID
        if let value = params["rpcId"] as? String { rpcID = .string(try identifier(value, max: 160)) }
        else { rpcID = .integer(Int64(try integer(params["rpcId"]))) }
        let expiresAt = try integer(params["expiresAt"])
        guard expiresAt > nowMS, expiresAt - nowMS <= 300_000 else {
            throw fail("The Coding MCP review is expired or has an invalid lifetime. No approval was sent.")
        }
        let descriptor = try object(params["descriptor"])
        try exact(descriptor, ["id", "server", "name", "arguments"])
        let descriptorID = try identifier(descriptor["id"], max: 48)
        guard descriptorID.utf8.count == 48, descriptorID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw fail() }
        let server = try identifier(descriptor["server"], max: 100)
        guard server.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,95].contains($0) }) else { throw fail() }
        let tool = try identifier(descriptor["name"], max: 256)
        _ = try object(descriptor["arguments"])
        // Match the coordinator's prepared-descriptor limits. The full envelope
        // adds two container levels and a bounded set of identity fields.
        _ = try canonical(descriptor, depthLimit: 32, nodeLimit: 8192, byteLimit: descriptorLimit)
        let fingerprint = try canonical(pending, depthLimit: 34, nodeLimit: 8224, byteLimit: displayLimit)
        let context = "Task: \(threadID)\nTurn: \(turnID)\nCall: \(callID)\nProcess generation: \(generation)\nMCP provider: \(server)\nTool: \(tool)"
        let display = context + "\n\nThis call goes to an MCP provider connected by the host app. It may act outside this coding project's sandbox, including outside a project VM. Provider permissions determine its access to other files and network services. Approval applies once to this exact call. Stop cannot undo an action already sent.\n\nExact pending call and arguments (JSON):\n" + String(decoding: fingerprint, as: UTF8.self)
        guard display.utf8.count <= displayLimit else { throw fail("The exact MCP review exceeds the display limit. Nothing was truncated and no approval was sent.") }
        return Review(publicID: publicID, key: key, generation: generation, threadID: threadID, turnID: turnID, callID: callID, rpcID: rpcID,
                      descriptorID: descriptorID, server: server, tool: tool, expiresAt: expiresAt, context: context, display: display, fingerprint: fingerprint)
    }
}
