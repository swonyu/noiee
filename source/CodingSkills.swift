import Foundation
import CoreFoundation
import Darwin

// Read-only, selected-project inventory. This does not enable engine skills,
// execute dependencies, read referenced resources, or grant task access.
enum CodingSkills {
    static let maxEntries = 128, maxFile = 64 * 1024, maxBytes = 512 * 1024
    static let metadataSyntax = "UTF-8 SKILL.md with leading --- frontmatter; flat, unique keys; required name and description as nonempty single-line plain, single-quoted, or JSON-compatible double-quoted strings. No block scalars, nested values, YAML aliases/tags, or dependency interpretation."

    struct Failure: Error, CustomStringConvertible, LocalizedError {
        let code: String, description: String
        var errorDescription: String? { description }
    }
    private static func fail(_ code: String, _ message: String) -> Failure { Failure(code: code, description: message) }
    struct Issue {
        let path: String, code: String, message: String
        var json: [String: Any] { ["path": path, "code": code, "message": message] }
    }
    struct Skill {
        let id: String, name: String, description: String, path: String, bytes: Int, sha256: String
        var json: [String: Any] { ["id": id, "name": name, "description": description, "path": path, "bytes": bytes, "sha256": sha256] }
    }
    fileprivate struct Anchor: Equatable {
        let name: String, identity: [String]
    }
    fileprivate struct Proof {
        let skill: Skill, directory: String, anchors: [Anchor], fileVersion: [String]
    }
    struct Snapshot {
        let project: String, skills: [Skill], issues: [Issue], truncated: Bool
        fileprivate let proofs: [String: Proof]
        var json: [String: Any] {
            ["version": 1, "cwd": project, "skills": skills.map(\.json), "issues": issues.map(\.json),
             "truncated": truncated, "complete": !truncated && issues.isEmpty, "metadataSyntax": CodingSkills.metadataSyntax]
        }
        fileprivate init(project: String, skills: [Skill], issues: [Issue], truncated: Bool, proofs: [String: Proof]) {
            self.project = project; self.skills = skills; self.issues = issues; self.truncated = truncated; self.proofs = proofs
        }
    }
    struct Preview {
        let skill: Skill, text: String
        var json: [String: Any] { var result = skill.json; result["text"] = text; return result }
    }
    struct ProjectScope {
        let project: String
        fileprivate let anchors: [Anchor]
        let binding: String
    }

    static func projectScope(_ project: String) throws -> ProjectScope {
        let chain = try Chain(project:project)
        try ownedDirectory(chain.fd)
        return ProjectScope(project:project,anchors:chain.anchors,binding:HandoffFiles.hash(try HandoffFiles.json(chain.anchors.map { ["name":$0.name,"identity":$0.identity] })))
    }
    static func verifyProject(_ scope: ProjectScope) throws {
        let chain = try Chain(project:scope.project)
        try chain.verify(expected:scope.anchors);try ownedDirectory(chain.fd)
    }
    static func validateSkill(_ data: Data) throws -> (text:String,name:String,description:String) {
        guard data.count <= maxFile,let text=String(data:data,encoding:.utf8),!text.contains("\0") else {throw fail("invalid_text","Invalid bounded UTF-8 skill text")}
        let fields=try metadata(text)
        return (text,fields.0,fields.1)
    }
    private static func ownedDirectory(_ fd:Int32) throws {
        let value=try CodingTemporary.info(fd)
        guard value.st_mode & S_IFMT == S_IFDIR,value.st_uid == getuid(),value.st_mode & 0o022 == 0 else {throw fail("ownership","The selected project or skill directory is not owned and protected from other writers")}
    }
    private static func skillName(_ name:String) throws {
        guard name.range(of:"^[a-z0-9]+(?:-[a-z0-9]+)*$",options:.regularExpression) != nil,name.utf8.count <= 64 else {throw fail("catalog","Invalid fixed skill identity")}
    }
    private static func appendOwned(_ chain:Chain,_ name:String,create:Bool) throws {
        if create {
            var value=stat()
            if fstatat(chain.fd,name,&value,AT_SYMLINK_NOFOLLOW) != 0 {
                guard errno == ENOENT else {throw fail("unavailable","Skill ancestor could not be inspected")}
                _ = try CodingTemporary.checked(mkdirat(chain.fd,name,0o700),"Create skill ancestor")
                _ = try CodingTemporary.checked(fsync(chain.fd),"Sync skill ancestor")
            }
        }
        try chain.append(name);try ownedDirectory(chain.fd);try chain.verify()
    }
    private static func receiptData(_ parent:Int32) throws -> Data {
        let name=".saleh-install.json",before=try inspect(parent,name),version=HandoffFiles.version(before)
        guard before.st_mode & S_IFMT == S_IFREG,before.st_nlink == 1,before.st_uid == getuid(),before.st_mode & 0o777 == 0o600,before.st_size > 0,before.st_size <= 8192 else {throw fail("receipt","Skill installation receipt changed or is unsupported")}
        let fd=try HandoffFiles.opened(parent,name,before);defer{close(fd)}
        var data=Data(),buffer=[UInt8](repeating:0,count:4096)
        while data.count < before.st_size {
            let count=Darwin.read(fd,&buffer,min(buffer.count,Int(before.st_size)-data.count))
            if count < 0 && errno == EINTR {continue}
            guard count > 0 else {throw fail("receipt","Skill receipt could not be read completely")}
            data.append(contentsOf:buffer.prefix(count))
        }
        guard version == HandoffFiles.version(try CodingTemporary.info(fd)),version == HandoffFiles.version(try inspect(parent,name)) else {throw fail("changed","Skill receipt changed while reading")}
        return data
    }
    static func installedSkill(_ scope:ProjectScope,id:String,sha256:String,includeText:Bool=false) throws -> [String:Any] {
        try skillName(id)
        let chain=try Chain(project:scope.project);try chain.verify(expected:scope.anchors);try ownedDirectory(chain.fd)
        let path=scope.project+"/.agents/skills/"+id+"/SKILL.md"
        do {
            for name in [".agents","skills",id] {try appendOwned(chain,name,create:false)}
        } catch let error as Failure where error.code == "missing" {try chain.verify();return ["id":id,"state":"not_installed","installed":false]}
        var budget=0
        let content=try read(chain.fd,budget:&budget)
        let file=try inspect(chain.fd,"SKILL.md")
        guard file.st_uid == getuid(),file.st_mode & 0o777 == 0o600,HandoffFiles.hash(content.data) == sha256 else {return ["id":id,"state":"changed","installed":false,"path":path,"message":"Existing skill differs from the managed revision; it was retained."]}
        let raw:Data
        do {raw=try receiptData(chain.fd)}
        catch let error as Failure where error.code == "missing" {return ["id":id,"state":"unmanaged","installed":false,"path":path,"message":"Existing skill has no installation receipt; it was retained."]}
        guard let value=try JSONSerialization.jsonObject(with:raw) as? [String:Any],Set(value.keys)==["version","kind","operationId","project","projectBinding","id","sha256","bytes"],
              let version=value["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,
              value["kind"] as? String=="fixed-project-skill-install",value["project"] as? String==scope.project,value["projectBinding"] as? String==scope.binding,value["id"] as? String==id,value["sha256"] as? String==sha256,
              let bytes=value["bytes"] as? NSNumber,CFGetTypeID(bytes) != CFBooleanGetTypeID(),bytes.doubleValue==Double(content.data.count),
              let operation=value["operationId"] as? String,UUID(uuidString:operation)?.uuidString.lowercased()==operation else {throw fail("receipt","Skill receipt does not match the selected project and exact catalog revision")}
        _ = try validateSkill(content.data);try chain.verify()
        var result:[String:Any]=["id":id,"state":"installed","installed":true,"path":path,"sha256":sha256,"bytes":content.data.count,"operationId":operation,"receiptSHA256":HandoffFiles.hash(raw)]
        if includeText {result["text"]=content.text;result["contentRole"]="Task procedure text; it grants no permissions or additional authority."}
        return result
    }
    private static func writeSkillFile(_ parent:Int32,_ name:String,_ data:Data) throws {
        let fd=try CodingTemporary.checked(openat(parent,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600),"Create owned skill file");defer{close(fd)}
        var offset=0
        while offset < data.count {
            let count=data.withUnsafeBytes {Darwin.write(fd,$0.baseAddress!.advanced(by:offset),data.count-offset)}
            if count < 0 && errno == EINTR {continue}
            guard count > 0 else {throw fail("write","Skill file write was incomplete; owned stage retained")}
            offset+=count
        }
        _ = try CodingTemporary.checked(fsync(fd),"Sync skill file")
    }
    static func installSkill(_ scope:ProjectScope,id:String,data:Data,sha256:String,operationId:String,check:(String)throws->Void) throws -> [String:Any] {
        try skillName(id);_ = try validateSkill(data)
        guard HandoffFiles.hash(data)==sha256,UUID(uuidString:operationId)?.uuidString.lowercased()==operationId else {throw fail("catalog","Fixed skill bytes or operation identity changed")}
        let chain=try Chain(project:scope.project);try chain.verify(expected:scope.anchors);try ownedDirectory(chain.fd)
        try check("beforeCreate")
        try appendOwned(chain,".agents",create:true)
        let agents=chain.fd
        try check("beforeCreate");try appendOwned(chain,"skills",create:true)
        let skills=chain.fd
        var existing=stat()
        guard fstatat(skills,id,&existing,AT_SYMLINK_NOFOLLOW) != 0,errno == ENOENT else {throw fail("exists","This skill target already exists; no file was overwritten")}
        let stage=".saleh-skill-stage-"+operationId
        try check("beforeStage");_ = try CodingTemporary.checked(mkdirat(agents,stage,0o700),"Create private skill stage")
        let fd=try CodingTemporary.directory(agents,stage);defer{close(fd)}
        let created=try CodingTemporary.info(fd);try ownedDirectory(fd)
        do {
            let receipt:[String:Any]=["version":1,"kind":"fixed-project-skill-install","operationId":operationId,"project":scope.project,"projectBinding":scope.binding,"id":id,"sha256":sha256,"bytes":data.count]
            try writeSkillFile(fd,"SKILL.md",data);try check("afterContent")
            try writeSkillFile(fd,".saleh-install.json",HandoffFiles.json(receipt))
            try CodingTemporary.requireContents(fd,["SKILL.md",".saleh-install.json"])
            var budget=0
            guard try read(fd,budget:&budget).data == data,try receiptData(fd) == HandoffFiles.json(receipt) else {throw fail("changed","Prepared skill bytes changed")}
            _ = try CodingTemporary.checked(fsync(fd),"Sync prepared skill directory")
            try check("beforePublish");try chain.verify();try ownedDirectory(chain.fds[scope.anchors.count-1]);try ownedDirectory(agents);try ownedDirectory(skills)
            guard directoryIdentity(created)==directoryIdentity(try inspect(agents,stage)),directoryIdentity(created)==directoryIdentity(try CodingTemporary.info(fd)) else {throw fail("changed","Prepared skill directory changed; publication refused")}
            budget=0
            guard try read(fd,budget:&budget).data == data,try receiptData(fd) == HandoffFiles.json(receipt) else {throw fail("changed","Prepared skill bytes changed before publication")}
            try CodingTemporary.requireContents(fd,["SKILL.md",".saleh-install.json"])
            try check("publication");try chain.verify()
            _ = try CodingTemporary.checked(renameatx_np(agents,stage,skills,id,UInt32(RENAME_EXCL)),"Publish new skill without replacing files")
            try check("afterPublish")
            _ = try CodingTemporary.checked(fsync(skills),"Sync installed skill directory");_ = try CodingTemporary.checked(fsync(agents),"Sync retained stage parent")
            var result=try installedSkill(scope,id:id,sha256:sha256)
            guard result["installed"] as? Bool==true else {throw fail("changed","Published skill could not be verified; inspect the retained files")}
            result["durable"]=true;result["message"]="Installed one fixed project skill and verified its bytes and receipt. Use read to load its task procedure."
            return result
        } catch {throw fail("retained","Skill installation did not finish with confirmed publication. Inspect the selected project's skill and retained stage before retrying. Operation: "+operationId+". "+error.localizedDescription)}
    }

    // Pin each absolute ancestor as well as the selected project. Opening an
    // absolute path with O_NOFOLLOW alone would still follow ancestor symlinks.
    private final class Chain {
        let project: String
        var fds = [Int32](), anchors = [Anchor]()
        var fd: Int32 { fds.last! }
        init(project: String) throws {
            self.project = project
            guard !project.isEmpty, project.utf8.count <= 4096, !project.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), project.hasPrefix("/") else { throw fail("project", "Invalid selected project path") }
            try CodingTemporary.canonical(project)
            let parts = project.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            guard parts.count <= 128, parts.allSatisfy({ $0 != "." && $0 != ".." }) else { throw fail("project", "Selected project path exceeds the supported depth") }
            do {
                let root = try CodingTemporary.checked(open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "Open filesystem root")
                fds.append(root); anchors.append(Anchor(name: "/", identity: CodingSkills.directoryIdentity(try CodingTemporary.info(root))))
                for part in parts { try append(part) }
                try verify()
            } catch { for held in fds { close(held) }; fds.removeAll(); throw error }
        }
        deinit { for held in fds { close(held) } }
        func append(_ name: String) throws {
            let before = try inspect(fd, name)
            try requireDirectory(before)
            let child: Int32
            do { child = try CodingTemporary.directory(fd, name) }
            catch { throw fail("changed", "Skill directory changed or cannot be opened safely") }
            do {
                guard directoryIdentity(before) == directoryIdentity(try CodingTemporary.info(child)),
                      directoryIdentity(before) == directoryIdentity(try inspect(fd, name)) else { throw fail("changed", "Skill directory changed while opening") }
                fds.append(child); anchors.append(Anchor(name: name, identity: directoryIdentity(before)))
            } catch { close(child); throw error }
        }
        func removeLast() { close(fds.removeLast()); anchors.removeLast() }
        func verify(expected: [Anchor]? = nil) throws {
            try CodingTemporary.canonical(project)
            if let expected, expected != anchors { throw fail("changed", "Selected project or skill ancestor changed; refresh the inventory") }
            for index in fds.indices {
                guard directoryIdentity(try CodingTemporary.info(fds[index])) == anchors[index].identity else { throw fail("changed", "Held skill ancestor identity changed") }
                let named: stat
                if index == 0 {
                    var value = stat(); _ = try CodingTemporary.checked(lstat("/", &value), "Inspect filesystem root"); named = value
                } else { named = try inspect(fds[index - 1], anchors[index].name) }
                guard directoryIdentity(named) == anchors[index].identity else { throw fail("changed", "Selected project or skill ancestor changed; refresh the inventory") }
            }
        }
    }
    private static func directoryIdentity(_ value: stat) -> [String] {
        [String(value.st_dev), String(value.st_ino), String(value.st_mode & S_IFMT), HandoffFiles.time(value.st_birthtimespec)]
    }
    private static func inspect(_ fd: Int32, _ name: String) throws -> stat {
        var value = stat()
        guard fstatat(fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT { throw fail("missing", "Expected skill entry is missing") }
            throw fail("unavailable", "Cannot inspect skill entry safely")
        }
        return value
    }
    private static func requireDirectory(_ value: stat) throws {
        if value.st_mode & S_IFMT == S_IFLNK { throw fail("unsupported_link", "Symbolic links are unsupported and were not followed") }
        guard value.st_mode & S_IFMT == S_IFDIR else { throw fail("unsupported_type", "Expected a real skill directory") }
    }
    private static func issue(_ error: Error, path: String, missingRoot: Bool = false) -> Issue {
        let failure = error as? Failure
        let code = failure?.code == "missing" && missingRoot ? "missing_root" : failure?.code ?? "unavailable"
        return Issue(path: path, code: code, message: failure?.description ?? "Skill entry could not be verified safely")
    }

    // The entry bound includes unsupported entries, so a directory full of junk
    // cannot force an unbounded scan. At most one additional name detects overflow.
    private static func entries(_ fd: Int32) throws -> (names: [String], issues: [Issue], truncated: Bool) {
        let copy = try CodingTemporary.directory(fd, ".")
        guard let stream = fdopendir(copy) else { close(copy); throw fail("unavailable", "Cannot enumerate skill directories") }
        defer { closedir(stream) }
        var names = [String](), issues = [Issue](), count = 0, truncated = false
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw fail("unavailable", "Skill directory enumeration failed") }; break
            }
            let raw = withUnsafePointer(to: &entry.pointee.d_name) { Data(bytes: UnsafeRawPointer($0), count: Int(entry.pointee.d_namlen)) }
            if raw == Data(".".utf8) || raw == Data("..".utf8) { continue }
            if count == maxEntries { truncated = true; break }
            count += 1
            guard let name = String(data: raw, encoding: .utf8), !name.isEmpty, !name.contains("/"), !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                issues.append(Issue(path: "", code: "invalid_name", message: "A skill directory name has invalid UTF-8 or unsupported control characters")); continue
            }
            names.append(name)
        }
        return (names.sorted(), issues, truncated)
    }

    private struct ReadResult { let text: String, data: Data, version: [String] }
    private static func read(_ parent: Int32, budget: inout Int, expected: [String]? = nil) throws -> ReadResult {
        let before = try inspect(parent, "SKILL.md"), kind = before.st_mode & S_IFMT
        if kind == S_IFLNK { throw fail("unsupported_link", "Symbolic skill files are unsupported and were not followed") }
        guard kind == S_IFREG else { throw fail("unsupported_type", "SKILL.md must be a regular file") }
        guard before.st_nlink == 1 else { throw fail("hardlink", "Hardlink aliases are unsupported") }
        guard before.st_size >= 0, before.st_size <= maxFile else { throw fail("file_limit", "SKILL.md exceeds the 64 KiB file limit") }
        let size = Int(before.st_size), version = HandoffFiles.version(before)
        if let expected, expected != version { throw fail("changed", "Skill file changed; refresh the inventory") }
        guard budget <= maxBytes - size else { throw fail("aggregate_limit", "Skill content scan reached its 512 KiB limit; inventory is incomplete") }
        // Reserve even failed reads and malformed metadata against this scan.
        budget += size
        let file: Int32
        do { file = try HandoffFiles.opened(parent, "SKILL.md", before) }
        catch { throw fail("changed", "Skill file changed or cannot be opened safely") }
        defer { close(file) }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        bytes.reserveCapacity(size)
        while bytes.count < size {
            let amount = min(buffer.count, size - bytes.count)
            let count = Darwin.read(file, &buffer, amount)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw fail("changed", "Skill file changed or could not be read completely") }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        guard version == HandoffFiles.version(try CodingTemporary.info(file)),
              version == HandoffFiles.version(try inspect(parent, "SKILL.md")) else { throw fail("changed", "Skill file changed during reading; refresh the inventory") }
        guard let text = String(data: bytes, encoding: .utf8) else { throw fail("invalid_utf8", "SKILL.md is not valid UTF-8") }
        guard !text.contains("\0") else { throw fail("invalid_text", "SKILL.md contains unsupported NUL text") }
        return ReadResult(text: text, data: bytes, version: version)
    }

    private static func scalar(_ input: String) throws -> String {
        let value = input.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { throw fail("metadata", "Metadata values must be nonempty strings") }
        let decoded: String
        if value.hasPrefix("\"") {
            guard let data = value.data(using: .utf8), let string = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String else { throw fail("metadata", "Double-quoted metadata must use JSON-compatible string syntax") }
            decoded = string
        } else if value.hasPrefix("'") {
            guard value.count >= 2, value.hasSuffix("'") else { throw fail("metadata", "Unterminated quoted metadata") }
            let inside = String(value.dropFirst().dropLast())
            let unescaped = inside.replacingOccurrences(of: "''", with: "")
            guard !unescaped.contains("'") else { throw fail("metadata", "Single-quoted metadata must escape quotes by doubling them") }
            decoded = inside.replacingOccurrences(of: "''", with: "'")
        } else {
            guard !"[]{}&*!|>@`\"'%#,-?:".contains(value.first!), !value.contains(": "), !value.contains(" #") else { throw fail("metadata", "Unsupported YAML syntax; use a plain or quoted single-line string") }
            decoded = value
        }
        guard !decoded.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !decoded.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw fail("metadata", "Metadata must be nonempty single-line text") }
        return decoded
    }
    private static func metadata(_ text: String) throws -> (String, String) {
        // Bounded extraction avoids splitting an entire large body into lines.
        let bytes = Array(text.utf8.prefix(8193))
        var lines = [String](), start = 0, end: Int? = nil
        for index in bytes.indices where bytes[index] == 10 {
            var row = Array(bytes[start..<index]); if row.last == 13 { row.removeLast() }
            guard let line = String(bytes: row, encoding: .utf8) else { throw fail("metadata", "Invalid frontmatter text") }
            lines.append(line); start = index + 1
            if lines.count == 1 && line != "---" { throw fail("metadata", "SKILL.md requires leading --- frontmatter") }
            guard lines.count <= 64 else { throw fail("metadata", "Frontmatter exceeds 64 lines") }
            if lines.count > 1 && line == "---" { end = start; break }
        }
        guard let end, end <= 8192 else { throw fail("metadata", "Frontmatter must close within 8 KiB and end with a newline") }
        var values = [String: String]()
        for line in lines.dropFirst().dropLast() {
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard line.first != " ", line.first != "\t", let separator = line.firstIndex(of: ":") else { throw fail("metadata", "Only flat frontmatter keys and single-line string values are supported") }
            let key = String(line[..<separator])
            guard !key.isEmpty, key.utf8.count <= 64, key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }), values[key] == nil else { throw fail("metadata", "Frontmatter keys must be unique simple names") }
            values[key] = try scalar(String(line[line.index(after: separator)...]))
        }
        guard let name = values["name"], let description = values["description"], name.utf8.count <= 128, description.utf8.count <= 2000 else { throw fail("metadata", "Frontmatter requires name (up to 128 bytes) and description (up to 2000 bytes)") }
        return (name, description)
    }

    static func inventory(project: String) throws -> Snapshot {
        let chain = try Chain(project: project)
        var rows = [Skill](), proofs = [String: Proof](), issues = [Issue](), truncated = false, budget = 0
        func snapshot() -> Snapshot { Snapshot(project: project, skills: rows, issues: issues, truncated: truncated, proofs: proofs) }
        for component in [".agents", "skills"] {
            do { try chain.append(component) }
            catch { issues.append(issue(error, path: project + "/.agents/skills", missingRoot: true)); try chain.verify(); return snapshot() }
        }
        let directoryVersion = HandoffFiles.version(try CodingTemporary.info(chain.fd))
        let listed: (names: [String], issues: [Issue], truncated: Bool)
        do { listed = try entries(chain.fd) }
        catch { issues.append(issue(error, path: project + "/.agents/skills")); truncated = true; try chain.verify(); return snapshot() }
        issues += listed.issues.map { Issue(path: project + "/.agents/skills", code: $0.code, message: $0.message) }
        truncated = listed.truncated
        if truncated { issues.append(Issue(path: project + "/.agents/skills", code: "entry_limit", message: "Only the first 128 directory entries were inspected; inventory is incomplete")) }
        for name in listed.names {
            let path = project + "/.agents/skills/" + name + "/SKILL.md"
            do {
                try chain.append(name)
                defer { chain.removeLast() }
                let content = try read(chain.fd, budget: &budget), fields = try metadata(content.text)
                try chain.verify()
                let hash = HandoffFiles.hash(content.data)
                let identityData = try HandoffFiles.json(["path": path, "ancestors": chain.anchors.map { ["name": $0.name, "identity": $0.identity] }, "file": content.version, "sha256": hash])
                let row = Skill(id: HandoffFiles.hash(identityData), name: fields.0, description: fields.1, path: path, bytes: content.data.count, sha256: hash)
                rows.append(row); proofs[row.id] = Proof(skill: row, directory: name, anchors: chain.anchors, fileVersion: content.version)
            } catch {
                issues.append(issue(error, path: path))
                if (error as? Failure)?.code == "aggregate_limit" { truncated = true; break }
            }
        }
        try chain.verify()
        if directoryVersion != HandoffFiles.version(try CodingTemporary.info(chain.fd)) {
            issues.append(Issue(path: project + "/.agents/skills", code: "changed", message: "Skill directory entries changed during scanning; refresh the incomplete inventory")); truncated = true
        }
        return snapshot()
    }

    static func preview(_ snapshot: Snapshot, skillID: String) throws -> Preview {
        guard let proof = snapshot.proofs[skillID] else { throw fail("unknown_skill", "Unknown skill ID; refresh the inventory") }
        let chain = try Chain(project: snapshot.project)
        for component in [".agents", "skills", proof.directory] { try chain.append(component) }
        try chain.verify(expected: proof.anchors)
        var budget = 0
        let content = try read(chain.fd, budget: &budget, expected: proof.fileVersion)
        guard content.data.count == proof.skill.bytes, HandoffFiles.hash(content.data) == proof.skill.sha256 else { throw fail("changed", "Skill content changed; refresh the inventory") }
        try chain.verify(expected: proof.anchors)
        return Preview(skill: proof.skill, text: content.text)
    }
}
