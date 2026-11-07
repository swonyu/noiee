import Foundation

// Read-only snapshots belong to one existing task and one short-lived UI session.
// This does not grant execution, alter engine skills, or retain SKILL.md text.
@MainActor final class CodingSkillsSession {
    private struct Context: Equatable {
        let threadId: String, cwd: String, provider: String
    }
    private struct Entry {
        let context: Context, snapshot: CodingSkills.Snapshot, created: TimeInterval
    }
    private let now: () -> TimeInterval
    private var generation = UUID(), entries: [String:Entry] = [:], order: [String] = []
    var token: UUID { generation }
    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) { self.now = now }
    func invalidate() { generation = UUID(); entries.removeAll(); order.removeAll() }
    private func require(_ expected: UUID) throws {
        guard expected == generation, !Task.isCancelled else { throw CodingTemporary.fail("Skill view changed or was stopped. Refresh the selected task's skills.") }
    }
    private func string(_ value: Any?, limit: Int = 200) throws -> String {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= limit,
              !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw CodingTemporary.fail("Invalid task skill request.") }
        return text
    }
    private func context(_ id: String, read: (String) async throws -> [String:Any], expected: UUID) async throws -> Context {
        let result = try await read(id); try require(expected)
        guard let thread = result["thread"] as? [String:Any], thread["id"] as? String == id else { throw CodingTemporary.fail("The selected task could not be verified.") }
        let cwd = try string(thread["cwd"], limit:4096)
        try await Task.detached(priority: .userInitiated) { try CodingTemporary.canonical(cwd) }.value
        try require(expected)
        return Context(threadId:id,cwd:cwd,provider:thread["modelProvider"] as? String ?? "")
    }
    private func prune() {
        let time = now()
        order = order.filter { key in
            guard let value = entries[key], time >= value.created, time - value.created <= 300 else { entries[key] = nil; return false }
            return true
        }
    }
    func perform(_ input: [String:Any], expected requestGeneration: UUID? = nil, read: (String) async throws -> [String:Any]) async throws -> [String:Any] {
        guard let action = input["action"] as? String, ["list","preview"].contains(action),
              Set(input.keys) == (action == "list" ? Set(["action","threadId"]) : Set(["action","threadId","inventoryId","skillId"])) else { throw CodingTemporary.fail("Invalid task skill request.") }
        let id = try string(input["threadId"]), expected = requestGeneration ?? generation
        try require(expected)
        prune()
        let before = try await context(id,read:read,expected:expected)
        let snapshot: CodingSkills.Snapshot, inventoryId: String
        var result: [String:Any]
        // Count/byte limits do not bound filesystem latency. Await each retained
        // worker so Clear/Stop can run on MainActor; reject its late result after
        // invalidation without claiming the underlying syscall was cancelled.
        if action == "list" {
            let cwd = before.cwd
            snapshot = try await Task.detached(priority: .userInitiated) { try CodingSkills.inventory(project:cwd) }.value
            try require(expected)
            result = snapshot.json; inventoryId = UUID().uuidString.lowercased()
        } else {
            inventoryId = try string(input["inventoryId"])
            guard let entry = entries[inventoryId], entry.context == before, now() - entry.created <= 300 else { throw CodingTemporary.fail("Skill inventory expired or belongs to another task. Refresh it before previewing.") }
            snapshot = entry.snapshot
            let skillID = try string(input["skillId"])
            let preview = try await Task.detached(priority: .userInitiated) { try CodingSkills.preview(snapshot,skillID:skillID) }.value
            try require(expected)
            result = preview.json
        }
        try require(expected)
        let after = try await context(id,read:read,expected:expected)
        guard before == after else { throw CodingTemporary.fail("The task project changed during skill inspection. No preview was accepted.") }
        if action == "list" {
            for key in order where entries[key]?.context.threadId == id { entries[key] = nil }
            order.removeAll { entries[$0] == nil }
            while order.count >= 8 { entries[order.removeFirst()] = nil }
            entries[inventoryId] = Entry(context:before,snapshot:snapshot,created:now()); order.append(inventoryId)
        } else {
            guard let entry = entries[inventoryId], entry.context == before,
                  now() >= entry.created, now() - entry.created <= 300 else { throw CodingTemporary.fail("Skill inventory expired or was replaced. Refresh it before previewing.") }
        }
        result["threadId"] = id; result["cwd"] = before.cwd; result["inventoryId"] = inventoryId
        return result
    }
}
