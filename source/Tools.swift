import AppKit
import WebKit
import Contacts
import CryptoKit
import Darwin
import Security

@MainActor
enum CodingProviderSettings {
    // Publish a pointer only after its unique credential exists. Previous keys
    // remain available to the saved chats that reference them.
    static func save(directory:URL,endpoint:String,model:String,key:String,check:() throws->Void,addCredential:(String,Data)throws->Void) throws -> Bool {
        guard let parsed=URLComponents(string:endpoint),parsed.scheme=="https",let host=parsed.host,!host.isEmpty,host.utf16.count<=120,
              endpoint.utf16.count<=2048,!endpoint.contains("\0"),parsed.user==nil,parsed.password==nil,parsed.query==nil,parsed.fragment==nil,
              !model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,model.utf16.count<=200,!model.contains("\0"),
              !key.isEmpty,key.utf8.count<=8192,!key.contains("\0"),!key.contains("\n"),!key.contains("\r") else {
            throw ComputerError.message("Enter an HTTPS base URL, exact model and API key. Nothing was saved.")
        }
        let credential=UUID().uuidString.lowercased()
        let bytes=try JSONSerialization.data(withJSONObject:["version":2,"profile":["name":host,"baseURL":endpoint,"model":model,"credentialId":credential]],options:[.sortedKeys])
        try check()
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try CodingTemporary.canonical(directory.path)
        let folder=try CodingTemporary.checked(open(directory.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),"Open provider directory")
        defer {close(folder)}
        let parent=try CodingTemporary.info(folder);try CodingTemporary.privateDirectory(parent)
        func snapshot() throws -> Data? {
            let fd=openat(folder,"providers.json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
            if fd<0 && errno==ENOENT{return nil}
            _ = try CodingTemporary.checked(fd,"Read provider configuration")
            let file=FileHandle(fileDescriptor:fd,closeOnDealloc:true)
            let info=try CodingTemporary.info(fd)
            guard info.st_mode & S_IFMT == S_IFREG,info.st_uid==getuid(),info.st_mode & 0o077 == 0,info.st_nlink==1,info.st_size<=16384 else{throw ComputerError.message("Provider configuration is not a private regular file.")}
            let data=try file.read(upToCount:16385) ?? Data()
            guard data.count<=16384,CodingTemporary.same(info,try CodingTemporary.namedInfo(folder,"providers.json")) else{throw ComputerError.message("Provider configuration changed while reading.")}
            return data
        }
        let original=try snapshot(),name=".provider-"+credential+".tmp"
        let fd=try CodingTemporary.checked(openat(folder,name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600),"Stage provider configuration")
        let file=FileHandle(fileDescriptor:fd,closeOnDealloc:true),identity=try CodingTemporary.info(fd)
        var committed=false
        defer {
            if !committed,let current=try? CodingTemporary.namedInfo(folder,name),CodingTemporary.same(identity,current){_ = unlinkat(folder,name,0)}
        }
        _ = try CodingTemporary.checked(fchmod(fd,0o600),"Protect provider configuration")
        try file.write(contentsOf:bytes);try file.synchronize();try check()
        try addCredential("cloud-"+credential,Data(key.utf8))
        try check();try CodingTemporary.canonical(directory.path)
        let named=try CodingTemporary.checked(open(directory.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),"Verify provider directory")
        defer {close(named)}
        let heldDirectory=try CodingTemporary.info(folder),namedDirectory=try CodingTemporary.info(named)
        try CodingTemporary.privateDirectory(heldDirectory);try CodingTemporary.privateDirectory(namedDirectory)
        let staged=try CodingTemporary.info(fd)
        guard CodingTemporary.same(parent,namedDirectory),CodingTemporary.same(identity,staged),CodingTemporary.same(staged,try CodingTemporary.namedInfo(folder,name)),
              staged.st_mode & S_IFMT == S_IFREG,staged.st_uid==getuid(),staged.st_mode & 0o777 == 0o600,staged.st_nlink==1,staged.st_size==bytes.count,
              try snapshot()==original else{throw ComputerError.message("Provider configuration changed while saving. The previous selection was not replaced.")}
        try file.seek(toOffset:0)
        guard try file.read(upToCount:bytes.count+1)==bytes else{throw ComputerError.message("Staged provider configuration changed. The previous selection was not replaced.")}
        try check()
        // ponytail: one native settings writer; the snapshot check is not CAS
        // against arbitrary external writers. Every published key pair is immutable.
        _ = try CodingTemporary.checked(renameat(folder,name,folder,"providers.json"),"Publish provider configuration")
        committed=true
        return fsync(folder)==0
    }
}

// Confirmation policy inspired by OpenHands AlwaysConfirm/NeverConfirm; see THIRD-PARTY-NOTICES.txt.
enum ToolAccessMode: String {
    case reviewed, full
    static let preferenceKey = "toolAccessMode"
    static let recoveryKey = "recoveryStartupArmedBoot"
    static func saved(_ defaults: UserDefaults = .standard) -> Self {
        Self(rawValue: defaults.string(forKey: preferenceKey) ?? "reviewed") ?? .reviewed
    }
    var label: String { self == .full ? "Full Access" : "Ask Before Tools" }
    func skipsConfirmation(operational: Bool) -> Bool { self == .full && operational }
    private static func validBoot(_ value:String)->Bool {value.utf8.count==36 && HandoffProcess.matches(value,HandoffProcess.bootPattern)}
    static func recoveryRequest(_ defaults:UserDefaults = .standard) throws -> String? {
        guard let raw=defaults.object(forKey:recoveryKey) else {return nil}
        guard let boot=raw as? String,validBoot(boot) else {throw ComputerError.message("Recovery startup request is invalid. No tools were started.")}
        return boot
    }
    static func armRecovery(_ defaults:UserDefaults = .standard,boot:String) throws {
        guard saved(defaults) == .full,validBoot(boot) else {throw ComputerError.message("Select Full Access for the next launch before preparing recovery startup.")}
        defaults.set(boot,forKey:recoveryKey)
        guard try recoveryRequest(defaults)==boot else {throw ComputerError.message("Recovery startup request could not be saved.")}
    }
    func startup(_ directory:URL,boot:String,request:String?) throws -> (unconfinedBoot:Bool,recoveryStartup:Bool) {
        guard Self.validBoot(boot),request==nil || Self.validBoot(request!) else {throw ComputerError.message("Invalid recovery startup boot identity.")}
        // A request can only withhold execution. It never erases or overrides an
        // existing Full Access marker, including one made by another app launch.
        if self == .full,let request,try !Self.reviewed.recordBoot(directory,boot:boot) {
            guard request != boot else {throw ComputerError.message("Restart the Mac before recovery startup. The request belongs to this same boot; no tools were started.")}
            return (false,true)
        }
        return (try recordBoot(directory,boot:boot),false)
    }
    // An immutable per-boot marker survives clean quit and mode changes. Stop
    // cannot prove that unrestricted detached programs have exited.
    func recordBoot(_ directory:URL, boot:String) throws -> Bool {
        guard Self.validBoot(boot) else {throw ComputerError.message("Invalid access boot identity.")}
        let manager=FileManager.default
        if self == .full {try manager.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}
        let folder=open(directory.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
        if folder<0 && errno==ENOENT && self != .full {return false}
        guard folder>=0 else {throw ComputerError.message("Access marker directory is unavailable.")}
        defer {close(folder)}
        var info=stat()
        guard fstat(folder,&info)==0,info.st_uid==getuid(),info.st_mode & 0o077 == 0 else {throw ComputerError.message("Access marker directory is not private.")}
        if self == .full {
        let fd=openat(folder,"full-access-"+boot,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
        if fd>=0 {
            let file=FileHandle(fileDescriptor:fd,closeOnDealloc:true)
            try file.write(contentsOf:Data((boot+"\n").utf8));try file.synchronize()
            guard fsync(folder)==0 else {throw ComputerError.message("Access marker could not be saved.")}
        } else if errno != EEXIST {throw ComputerError.message("Access marker could not be created.")}
        let parent=open(directory.deletingLastPathComponent().path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
        guard parent>=0 else {throw ComputerError.message("Access marker parent is unavailable.")}
        defer {close(parent)}
        guard fsync(parent)==0 else {throw ComputerError.message("Access marker directory could not be saved.")}
        }
        let read=openat(folder,"full-access-"+boot,O_RDONLY|O_NOFOLLOW|O_NONBLOCK)
        if read<0 && errno==ENOENT && self != .full {return false}
        guard read>=0 else {throw ComputerError.message("Access marker could not be verified.")}
        let file=FileHandle(fileDescriptor:read,closeOnDealloc:true)
        guard fstat(read,&info)==0,info.st_mode & S_IFMT == S_IFREG,info.st_uid==getuid(),info.st_nlink==1,info.st_size==37,
              try file.read(upToCount:38)==Data((boot+"\n").utf8) else {throw ComputerError.message("Access marker differs; full access was not started.")}
        return true
    }
    static func check() {
        precondition(Self.full.skipsConfirmation(operational:true))
        precondition(!Self.full.skipsConfirmation(operational:false))
        precondition(!Self.reviewed.skipsConfirmation(operational:true))
        let domain="saleh-access-check-"+UUID().uuidString, defaults=UserDefaults(suiteName:domain)!
        defer { defaults.removePersistentDomain(forName:domain) }
        precondition(Self.saved(defaults) == .reviewed)
        defaults.set("invalid",forKey:preferenceKey);precondition(Self.saved(defaults) == .reviewed)
        defaults.set("full",forKey:preferenceKey);precondition(Self.saved(defaults) == .full)
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(domain,isDirectory:true)
        defer {try? FileManager.default.removeItem(at:directory)}
        let boot="AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", next="BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"
        do {
            let before=try Self.reviewed.recordBoot(directory,boot:boot);precondition(!before)
            do {_ = try Self.full.startup(directory,boot:boot,request:boot);preconditionFailure("Same-boot recovery startup accepted")} catch {}
            let notAdmitted=try Self.reviewed.recordBoot(directory,boot:boot);precondition(!notAdmitted)
            let full=try Self.full.recordBoot(directory,boot:boot);precondition(full)
            let same=try Self.reviewed.recordBoot(directory,boot:boot);precondition(same)
            let different=try Self.reviewed.recordBoot(directory,boot:next);precondition(!different)
            let current=try Self.full.startup(directory,boot:boot,request:boot);precondition(current.unconfinedBoot && !current.recoveryStartup)
            let held=try Self.full.startup(directory,boot:next,request:boot);precondition(!held.unconfinedBoot && held.recoveryStartup)
            let reopen=try Self.full.startup(directory,boot:next,request:boot);precondition(!reopen.unconfinedBoot && reopen.recoveryStartup)
            let untouched=try Self.reviewed.recordBoot(directory,boot:next);precondition(!untouched)
            let released=try Self.full.startup(directory,boot:next,request:nil);precondition(released.unconfinedBoot && !released.recoveryStartup)
            let contaminated=try Self.full.startup(directory,boot:next,request:boot);precondition(contaminated.unconfinedBoot && !contaminated.recoveryStartup)
            try Self.armRecovery(defaults,boot:boot);let armed=try Self.recoveryRequest(defaults);precondition(armed==boot)
            precondition(Self.saved(defaults) == .full)
            defaults.set(true,forKey:recoveryKey)
            do {_ = try Self.recoveryRequest(defaults);preconditionFailure("Invalid recovery request accepted")} catch {}
            defaults.set(boot+"\n",forKey:recoveryKey)
            do {_ = try Self.recoveryRequest(defaults);preconditionFailure("Trailing-newline recovery request accepted")} catch {}
            do {_ = try Self.full.startup(directory,boot:next,request:"invalid");preconditionFailure("Invalid recovery boot accepted")} catch {}
            defaults.removeObject(forKey:recoveryKey)
            let cleared=try Self.recoveryRequest(defaults);precondition(cleared==nil && Self.saved(defaults) == .full)
            try Data("changed".utf8).write(to:directory.appendingPathComponent("full-access-"+next))
            do {_ = try Self.full.startup(directory,boot:next,request:boot);preconditionFailure("Changed boot marker accepted")} catch {}
        } catch {preconditionFailure(error.localizedDescription)}
        RecoveryStartupPolicy.check()
        print("PASS: native access mode persistence, invalid-value refusal and input-selection separation")
    }
}

struct PhoneTarget {
    static func url(_ number: String) throws -> URL {
        var cleaned = ""
        for c in number {
            if let digit = c.wholeNumberValue, digit < 10 { cleaned += String(digit) }
            else if c == "+" && cleaned.isEmpty { cleaned += "+" }
            else if " ()-.".contains(c) { continue }
            else { throw ComputerError.message("This number contains an extension or dial code. Dial it yourself in Phone.") }
        }
        let count = cleaned.filter(\.isNumber).count
        guard (7...15).contains(count), let url = URL(string:"tel:" + cleaned) else { throw ComputerError.message("The contact has no supported phone number.") }
        return url
    }
    static func check() {
        precondition(try! url("+966 50 123 4567").absoluteString == "tel:+966501234567")
        for number in ["*123#", "123", "5551234567;123", "5551234567x2", "5551234567\n"] { do { _ = try url(number); preconditionFailure("Unsafe number") } catch {} }
        print("PASS: phone URL normalization, dial-code and extension rejection")
    }
}
private final class ToolsNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

// Only the two bundled presets qualify. Server names and advertised annotations are not authority.
enum RoutineReadPolicy {
    static func kind(_ entry:[String:Any], resources:String, runtime:String) -> String? {
        guard entry["transport"] as? String == "stdio", let command=entry["command"] as? String,
              ["/opt/homebrew/bin/node","/usr/local/bin/node"].contains(command),
              entry["envKeys"] as? [String] == [], entry["cwd"] as? String == runtime,
              let args=entry["args"] as? [String] else { return nil }
        if args.count==2, args[0]==resources+"/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", args[1].hasPrefix("/") { return "files" }
        if args==[resources+"/node_modules/@playwright/mcp/cli.js","--isolated","--browser","chrome"] { return "browser" }
        return nil
    }
    static func allows(_ kind:String, name:String, arguments:[String:Any]) -> Bool {
        if kind=="browser" {
            return (name=="browser_snapshot" && arguments.isEmpty) || (name=="browser_tabs" && Set(arguments.keys)==["action"] && arguments["action"] as? String=="list")
        }
        guard kind=="files" else { return false }
        if name=="list_allowed_directories" { return arguments.isEmpty }
        guard ["read_text_file","list_directory","get_file_info"].contains(name), let path=arguments["path"] as? String, path.hasPrefix("/") else { return false }
        let parts=URL(fileURLWithPath:path).standardized.pathComponents.map{$0.lowercased()}
        guard !parts.contains(where:{ $0.hasPrefix(".env") || [".ssh",".aws",".gnupg","keychains","credentials","secrets","cookies","login data"].contains($0) || [".pem",".key",".p12",".pfx"].contains(where:$0.hasSuffix) }) else { return false }
        return Set(arguments.keys).isSubset(of:name=="read_text_file" ? ["path","head","tail"] : ["path"])
    }
    static func automaticArguments(_ kind:String,name:String,arguments:[String:Any]) -> [String:Any]? {
        guard allows(kind,name:name,arguments:arguments) else { return nil }
        guard kind=="files", let path=arguments["path"] as? String else { return arguments }
        guard let resolved=realpath(path,nil) else { return nil }
        defer { free(resolved) }
        var canonical=arguments; canonical["path"]=String(cString:resolved)
        return allows(kind,name:name,arguments:canonical) ? canonical : nil
    }
    static func check() {
        let base="/app/resources", runtime="/app/data", file:[String:Any]=["transport":"stdio","command":"/opt/homebrew/bin/node","envKeys":[String](),"cwd":runtime,"args":[base+"/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js","/tmp/work"]]
        precondition(kind(file,resources:base,runtime:runtime)=="files")
        var fake=file;fake["args"]=["/tmp/fake-server","/tmp/work"];precondition(kind(fake,resources:base,runtime:runtime)==nil)
        fake=file;fake["envKeys"]=["NODE_OPTIONS"];precondition(kind(fake,resources:base,runtime:runtime)==nil)
        fake=file;fake["cwd"]=base;precondition(kind(fake,resources:base,runtime:runtime)==nil)
        precondition(allows("files",name:"read_text_file",arguments:["path":"/tmp/work/note.txt"]))
        for path in ["/tmp/work/.env","/tmp/work/key.pem","/tmp/work/../.ssh/id_rsa"] { precondition(!allows("files",name:"read_text_file",arguments:["path":path])) }
        precondition(!allows("files",name:"write_file",arguments:["path":"/tmp/work/note.txt","content":"x"]))
        precondition(allows("browser",name:"browser_snapshot",arguments:[:]))
        precondition(!allows("browser",name:"browser_snapshot",arguments:["filename":"/tmp/x"]))
        precondition(allows("browser",name:"browser_tabs",arguments:["action":"list"]))
        precondition(!allows("browser",name:"browser_tabs",arguments:["action":"close"]))
        let fixture=FileManager.default.temporaryDirectory.appendingPathComponent("qwen-read-policy-"+UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at:fixture,withIntermediateDirectories:true)
            defer { try? FileManager.default.removeItem(at:fixture) }
            try Data("synthetic only".utf8).write(to:fixture.appendingPathComponent(".env"))
            try FileManager.default.createSymbolicLink(at:fixture.appendingPathComponent("note.txt"),withDestinationURL:fixture.appendingPathComponent(".env"))
            precondition(automaticArguments("files",name:"read_text_file",arguments:["path":fixture.appendingPathComponent("note.txt").path])==nil)
            let ordinary=fixture.appendingPathComponent("ordinary.txt")
            try Data("test".utf8).write(to:ordinary)
            let actual=realpath(ordinary.path,nil)!; defer { free(actual) }
            precondition(automaticArguments("files",name:"read_text_file",arguments:["path":ordinary.path])?["path"] as? String == String(cString:actual))
        } catch { preconditionFailure("Could not run disposable routine-read fixture: \(error)") }
        print("PASS: bundled routine-read provenance, secret-path exclusions and browser mutation rejection")
    }
}

// These operations cannot grant access or start work; they remain available during a review.
enum CodingControlPolicy {
    static func allows(_ body:[String:Any]) -> Bool {
        guard Set(body.keys)==["op","input"], let op=body["op"] as? String,
              let input=body["input"] as? [String:Any], let action=input["action"] as? String else { return false }
        if op=="codingMCP" { return ["setupStatus","cancelSetup"].contains(action) && CodingMCPSetupPolicy.action(input)==action }
        if op=="codingWorktrees" { return Set(input.keys)==["action"] && action=="stop" }
        if op=="codingSchedules" { return ["pause","stop"].contains(action) && CodingSchedulePolicy.action(input) != nil }
        if op=="codingGit" { return action=="stop" && CodingGitPolicy.action(input) != nil }
        if op=="codingQueue" { return CodingQueuePolicy.control(input) }
        guard op=="coding" else { return false }
        func id(_ key:String) -> Bool {
            guard let value=input[key] as? String else { return false }
            return !value.isEmpty && value.utf8.count<=200 && !value.contains("\0")
        }
        switch action {
        case "status": return Set(input.keys)==["action"]
        case "mcpOutcomes":
            guard Set(input.keys)==["action","threadId"], let value=input["threadId"] as? String,
                  !value.isEmpty, value.utf8.count<=160 else { return false }
            let allowed=CharacterSet(charactersIn:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")
            return value.unicodeScalars.allSatisfy { allowed.contains($0) }
        case "terminalResults":
            guard Set(input.keys)==["action","threadId"] || Set(input.keys)==["action","threadId","recordId"],
                  let thread=input["threadId"] as? String, !thread.isEmpty, thread.utf8.count<=160 else { return false }
            let allowed=CharacterSet(charactersIn:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")
            guard thread.unicodeScalars.allSatisfy({allowed.contains($0)}) else { return false }
            if let value=input["recordId"] {
                guard let record=value as? String, record.utf8.count==36, record==record.lowercased(), UUID(uuidString:record) != nil else { return false }
            }
            return true
        case "events":
            guard Set(input.keys).isSubset(of:["action","after"]) else { return false }
            guard let after=input["after"] else { return true }
            guard let number=after as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let value=number.doubleValue
            return value>=0 && value<=9_007_199_254_740_991 && value.rounded(.towardZero)==value
        case "interrupt": return Set(input.keys)==["action","threadId","turnId"] && id("threadId") && id("turnId")
        case "interruptFamily": return Set(input.keys)==["action","threadId"] && id("threadId")
        case "terminalStop": return Set(input.keys)==["action","processId"] && id("processId")
        case "terminalSnapshot": return CodingTerminalPolicy.action(input)==action
        default: return false
        }
    }
}

enum RecoveryStartupPolicy {
    static let message="Recovery startup holds unrestricted tools. Full Access remains selected. Finish recovery, or cancel recovery startup in the app menu for the next launch."
    static func allows(_ body:[String:Any]) -> Bool {
        guard let op=body["op"] as? String else {return false}
        if ["departPage","cancel","cancelTools","disconnect"].contains(op) {return true}
        guard let input=body["input"] as? [String:Any],let action=input["action"] as? String else {return false}
        if op=="codingWorktrees" {return ["list","stop","reconnect","recoverHandoff","recoverCopy","archive","restore"].contains(action)}
        if op=="coding" {return ["status","events","list","read","historyPage","readImage","family","mcpOutcomes","terminalResults","providerBindingInfo","approvalInfo","terminalSnapshot","interrupt","interruptFamily","terminalStop"].contains(action) || action=="approval" && input["decision"] as? String=="decline"}
        if ["codingGit","codingSchedules"].contains(op) {return action=="stop"}
        if op=="codingQueue" {return ["pause","cancel"].contains(action)}
        if op=="codingMCP" {return action=="cancelSetup"}
        return false
    }
    static func check() {
        for action in ["list","stop","reconnect","recoverHandoff","recoverCopy","archive","restore"] {precondition(allows(["op":"codingWorktrees","input":["action":action]]))}
        for action in ["create","handoff","open","unknown"] {precondition(!allows(["op":"codingWorktrees","input":["action":action]]))}
        for action in ["status","read","historyPage","interrupt","terminalStop"] {precondition(allows(["op":"coding","input":["action":action]]))}
        for action in ["send","steer","start","fork","terminalInput","terminalResize","approval"] {precondition(!allows(["op":"coding","input":["action":action]]))}
        precondition(allows(["op":"coding","input":["action":"approval","decision":"decline"]]))
        for op in ["execute","connect","catalog","agentStep","addFilesystem","addBrowser","codingStorage","codingConfigureProvider","unknown"] {precondition(!allows(["op":op,"input":["action":"start"]]))}
        precondition(allows(["op":"cancel"]) && !allows([:]))
        print("PASS: native recovery startup permits retained reads, reviewed archive/restore, explicit recovery and Stop while execution stays held")
    }
}

enum CodingTerminalPolicy {
    static func action(_ input:[String:Any]) -> String? {
        guard let action=input["action"] as? String else { return nil }
        func id(_ key:String) -> Bool {
            guard let value=input[key] as? String else { return false }
            return !value.isEmpty && value.utf8.count<=200 && !value.contains("\0")
        }
        func integer(_ value:Any?,_ low:Double,_ high:Double) -> Bool {
            guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let n=number.doubleValue;return n.isFinite && n>=low && n<=high && n.rounded(.towardZero)==n
        }
        switch action {
        case "terminalStart":
            guard Set(input.keys)==["action","threadId","command","mode","cols","rows"],id("threadId"),input["command"] as? String=="",input["mode"] as? String=="pty",integer(input["cols"],20,240),integer(input["rows"],5,100) else { return nil }
        case "terminalAttach": guard Set(input.keys)==["action","processId"],id("processId") else { return nil }
        case "terminalSnapshot":
            guard Set(input.keys).isSubset(of:["action","processId","after"]),id("processId"),input["after"]==nil || integer(input["after"],0,9_007_199_254_740_991) else { return nil }
        case "terminalInput":
            guard Set(input.keys)==["action","processId","dataBase64"],id("processId"),let text=input["dataBase64"] as? String,text.utf8.count<=21336,let data=Data(base64Encoded:text),!data.isEmpty,data.count<=16000,data.base64EncodedString()==text else { return nil }
        case "terminalResize":
            guard Set(input.keys)==["action","processId","cols","rows"],id("processId"),integer(input["cols"],20,240),integer(input["rows"],5,100) else { return nil }
        default: return nil
        }
        return action
    }
}

struct CodingTerminalGrants {
    struct Entry {let token:UUID;var folder:String?;var threadId:String?}
    private(set) var entries:[String:Entry]=[:]
    private(set) var startEpoch=UUID()
    mutating func begin(_ id:String) -> UUID {
        // ponytail: 32 native grants; stale views renew if a long session reaches this cache ceiling.
        if entries.count>=32 { revoke() }
        let token=UUID();entries[id]=Entry(token:token);return token
    }
    mutating func allow(_ id:String,token:UUID,folder:String,threadId:String) -> Bool {
        guard entries[id]?.token==token else { return false }
        entries[id]=Entry(token:token,folder:folder,threadId:threadId);return true
    }
    func allows(_ id:String,token:UUID?) -> Bool {
        guard let token,let entry=entries[id] else { return false }
        return entry.token==token && entry.folder != nil && entry.threadId != nil
    }
    mutating func revoke(_ id:String?=nil) {
        startEpoch=UUID()
        if let id { entries[id]=nil } else { entries=[:] }
    }
}

enum CodingSchedulePolicy {
    private static func modelID(_ value:Any?) -> String? {
        guard let model=value as? String,!model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,model.utf16.count<=200,
              model.range(of:"[\\x00-\\x1f\\x7f]",options:.regularExpression)==nil else {return nil}
        return model
    }
    static func action(_ input:[String:Any]) -> String? {
        guard let action=input["action"] as? String else { return nil }
        func text(_ key:String,_ limit:Int) -> String? {
            guard let value=input[key] as? String,!value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,value.utf8.count<=limit,!value.contains("\0") else { return nil };return value
        }
        func integer(_ value:Any?,_ low:Double,_ high:Double) -> Bool {
            guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let n=number.doubleValue;return n.isFinite && n>=low && n<=high && n.rounded(.towardZero)==n
        }
        switch action {
        case "list","stop","recover": return Set(input.keys)==["action"] ? action:nil
        case "pause","resume","run","delete":
            guard Set(input.keys)==["action","id"],let id=text("id",100),UUID(uuidString:id) != nil else { return nil }
        case "save":
            guard Set(input.keys).subtracting(["executionMode"])==["action","id","name","cwd","prompt","effort","model","cadence"],modelID(input["model"]) != nil,
                  input["executionMode"]==nil || ["native","vm"].contains(input["executionMode"] as? String ?? ""),
                  input["id"] is NSNull || (input["id"] as? String).flatMap(UUID.init(uuidString:)) != nil,
                  text("name",120) != nil,let cwd=text("cwd",4096),cwd.hasPrefix("/"),text("prompt",20000) != nil,
                  let effort=input["effort"] as? String,["none","high"].contains(effort),let cadence=input["cadence"] as? [String:Any],let type=cadence["type"] as? String else { return nil }
            switch type {
            case "once": guard Set(cadence.keys)==["type","at"],integer(cadence["at"],0,8_640_000_000_000_000) else { return nil }
            case "interval": guard Set(cadence.keys)==["type","minutes"],integer(cadence["minutes"],1,10080) else { return nil }
            case "calendar":
                guard Set(cadence.keys)==["type","days","time","timeZone"],let days=cadence["days"] as? [Any],!days.isEmpty,days.count<=7,days.allSatisfy({integer($0,0,6)}),Set(days.compactMap{($0 as? NSNumber)?.intValue}).count==days.count,
                      let time=cadence["time"] as? String,time.range(of:"^([01][0-9]|2[0-3]):[0-5][0-9]$",options:.regularExpression) != nil,
                      let zone=cadence["timeZone"] as? String,zone.utf8.count<=100,TimeZone(identifier:zone) != nil else { return nil }
            default: return nil
            }
        default: return nil
        }
        return action
    }
    static func prepared(_ response:[String:Any],input:[String:Any]) -> (id:String,executionMode:String,detail:String)? {
        guard let requested=action(input),["save","resume","run"].contains(requested),Set(response.keys)==["plan"],let plan=response["plan"] as? [String:Any],
              Set(plan.keys)==Set(["id","request","project","model","nextRunAt","expiresAt"]+(requested=="save" ? []:["definition"])),
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,let request=plan["request"] as? [String:Any],action(request)==requested,
              let project=plan["project"] as? [String:Any],Set(project.keys)==["cwd","identity"],let cwd=project["cwd"] as? String,
              cwd.hasPrefix("/"),cwd.utf8.count<=4096,!cwd.contains("\0"),
              let identity=project["identity"] as? [String:String],Set(identity.keys)==["volumeUUID","ino"],
              let volume=identity["volumeUUID"],let uuid=UUID(uuidString:volume),uuid.uuidString==volume,volume != "00000000-0000-0000-0000-000000000000",
              let inode=identity["ino"],let number=UInt64(inode),number>0,String(number)==inode,
              let selectedModel=modelID(plan["model"]),
              let expires=plan["expiresAt"] as? NSNumber,CFGetTypeID(expires) != CFBooleanGetTypeID() else {return nil}
        guard let canonical=realpath(cwd,nil) else {return nil};defer{free(canonical)}
        guard String(cString:canonical)==cwd else {return nil}
        let now=Date().timeIntervalSince1970*1000,deadline=expires.doubleValue
        guard deadline.isFinite,deadline.rounded(.towardZero)==deadline,deadline>now,deadline<=now+120_000 else {return nil}
        if let at=plan["nextRunAt"] as? NSNumber {
            let value=at.doubleValue;guard CFGetTypeID(at) != CFBooleanGetTypeID(),value.isFinite,value.rounded(.towardZero)==value,value>=0,value<=253_402_300_799_999 else {return nil}
        } else if !(plan["nextRunAt"] is NSNull) {return nil}
        let mode:String
        if requested=="save" {
            guard let path=input["cwd"] as? String,let resolved=realpath(path,nil) else {return nil};defer{free(resolved)}
            var expected=input;expected["cwd"]=String(cString:resolved);expected["executionMode"]=input["executionMode"] ?? "vm"
            guard request["cwd"] as? String==cwd,NSDictionary(dictionary:request).isEqual(to:expected),let value=request["executionMode"] as? String else {return nil};mode=value
        } else {
            guard NSDictionary(dictionary:request).isEqual(to:input),let definition=plan["definition"] as? [String:Any],
                  Set(definition.keys)==["name","cwd","prompt","effort","model","cadence","active","executionMode"],definition["cwd"] as? String==cwd,
                  let active=definition["active"] as? NSNumber,CFGetTypeID(active)==CFBooleanGetTypeID(),let value=definition["executionMode"] as? String else {return nil}
            var fields=definition;fields.removeValue(forKey:"active");fields["action"]="save";fields["id"]=NSNull()
            guard action(fields)=="save" else {return nil};mode=value
        }
        guard ["native","vm"].contains(mode),let data=try? JSONSerialization.data(withJSONObject:plan,options:[.prettyPrinted,.sortedKeys,.withoutEscapingSlashes]),data.count<=200_000 else {return nil}
        let fields=requested=="save" ? request:plan["definition"] as! [String:Any]
        guard fields["model"] as? String==selectedModel else {return nil}
        let cadence=fields["cadence"] as! [String:Any],formatter=DateFormatter()
        formatter.dateStyle = .medium;formatter.timeStyle = .short
        formatter.timeZone=(cadence["timeZone"] as? String).flatMap(TimeZone.init(identifier:)) ?? .current
        func date(_ value:Any?) -> String {
            guard let at=value as? NSNumber else {return "No future run"}
            return formatter.string(from:Date(timeIntervalSince1970:at.doubleValue/1000))+" ("+formatter.timeZone.identifier+")"
        }
        let timing:String
        switch cadence["type"] as! String {
        case "interval":timing="Every \((cadence["minutes"] as! NSNumber).intValue) minutes"
        case "once":timing="Once · "+date(cadence["at"])
        default:
            let days=(cadence["days"] as! [NSNumber]).map{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][$0.intValue]}.joined(separator:", ")
            timing="Weekly · "+days+" · "+(cadence["time"] as! String)+" · "+formatter.timeZone.identifier
        }
        let detail="Project: "+cwd+"\nName: "+(fields["name"] as! String)+"\nModel: "+selectedModel+"\n\nInstructions:\n"+(fields["prompt"] as! String)+"\n\nReasoning: "+(fields["effort"] as? String=="high" ? "Deep":"Standard")+"\nTiming: "+timing+"\nNext run: "+date(plan["nextRunAt"])
        return (id,mode,detail)
    }
    static func recoveryPlan(_ response:[String:Any]) -> (id:String,detail:String)? {
        guard Set(response.keys)==["plan"],let plan=response["plan"] as? [String:Any],
              Set(plan.keys)==["id","kind","expiresAt","ledgerSHA256","directory","projects","scheduleCount"],
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,plan["kind"] as? String=="recover-paused",
              let expires=plan["expiresAt"] as? NSNumber,CFGetTypeID(expires) != CFBooleanGetTypeID(),
              let count=plan["scheduleCount"] as? NSNumber,CFGetTypeID(count) != CFBooleanGetTypeID(),
              let hash=plan["ledgerSHA256"] as? String,hash.utf8.count==64,hash.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}),
              let directory=plan["directory"] as? [String:Any],let projects=plan["projects"] as? [[String:Any]],projects.count<=32 else {return nil}
        let now=Date().timeIntervalSince1970*1000,deadline=expires.doubleValue,n=count.doubleValue
        guard deadline.isFinite,deadline.rounded(.towardZero)==deadline,deadline>now,deadline<=now+120_000,
              n.isFinite,n.rounded(.towardZero)==n,n>=0,n<=32 else {return nil}
        func binding(_ value:[String:Any],project:Bool) -> String? {
            guard Set(value.keys)==(project ? ["path","before","after","scheduleIds"]:["path","before","after"]),
                  let path=value["path"] as? String,path.hasPrefix("/"),path.utf8.count<=4096,!path.contains("\0"),(path as NSString).standardizingPath==path,
                  let before=value["before"] as? [String:String],Set(before.keys)==["dev","ino"],before.values.allSatisfy({!$0.isEmpty && $0.utf8.count<=30 && $0.utf8.allSatisfy({(48...57).contains($0)})}),
                  let after=value["after"] as? [String:String],Set(after.keys)==["volumeUUID","ino"],
                  let volume=after["volumeUUID"],let uuid=UUID(uuidString:volume),uuid.uuidString==volume,volume != "00000000-0000-0000-0000-000000000000",
                  let inode=after["ino"],let number=UInt64(inode),number>0,String(number)==inode,before["ino"]==inode else {return nil}
            return path
        }
        guard binding(directory,project:false) != nil else {return nil}
        var paths=Set<String>(),ids=Set<String>()
        for project in projects {
            guard let path=binding(project,project:true),paths.insert(path).inserted,
                  let scheduleIds=project["scheduleIds"] as? [String],!scheduleIds.isEmpty,scheduleIds.count<=32 else {return nil}
            for id in scheduleIds {guard UUID(uuidString:id) != nil,ids.insert(id).inserted else {return nil}}
        }
        guard ids.count==Int(n),let data=try? JSONSerialization.data(withJSONObject:plan,options:[.prettyPrinted,.sortedKeys,.withoutEscapingSlashes]),data.count<=200_000 else {return nil}
        return (id,String(decoding:data,as:UTF8.self))
    }
}

enum CodingWorktreePolicy {
    static func action(_ input:[String:Any]) -> String? {
        guard let action=input["action"] as? String else { return nil }
        func text(_ key:String,_ limit:Int) -> String? {
            guard let value=input[key] as? String, !value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
                  value.utf8.count<=limit, !value.contains("\0") else { return nil }
            return value
        }
        switch action {
        case "list","stop","reconnect": return Set(input.keys)==["action"] ? action:nil
        case "create":
            guard Set(input.keys)==Set(["action","cwd","ref"]).union(input["copyChanges"] == nil ? []:["copyChanges"]),let cwd=text("cwd",4096),cwd.hasPrefix("/"),text("ref",512) != nil else { return nil }
            if let value=input["copyChanges"] {guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil}}
        case "archive","restore","recoverCopy":
            guard Set(input.keys)==["action","id"],let id=text("id",100),UUID(uuidString:id) != nil else { return nil }
        case "recoverHandoff":
            guard Set(input.keys)==["action","id","mode"],let id=text("id",100),UUID(uuidString:id) != nil,let mode=input["mode"] as? String,["restore","finish"].contains(mode) else { return nil }
        case "handoff":
            guard Set(input.keys)==["action","id","threadId"],let id=text("id",100),UUID(uuidString:id) != nil,
                  let thread=text("threadId",160),thread.range(of:"^[A-Za-z0-9_.-]{1,160}$",options:.regularExpression) != nil else { return nil }
        case "open":
            guard Set(input.keys).isSubset(of:["action","id","provider","model","executionMode"]),let id=text("id",100),UUID(uuidString:id) != nil,
                  let provider=input["provider"] as? String,["local","cloud"].contains(provider) else { return nil }
            if let mode=input["executionMode"] { guard let mode=mode as? String,["native","vm"].contains(mode) else { return nil } }
            if input["model"] != nil {
                guard provider=="local",let model=text("model",800),model.count<=200,
                      model.range(of:"[\\x00-\\x1f\\x7f]",options:.regularExpression)==nil else { return nil }
            }
        default: return nil
        }
        return action
    }
    private static func text(_ value:Any?,_ limit:Int) -> String? {
        guard let value=value as? String,!value.isEmpty,value.utf8.count<=limit,!value.contains("\0") else {return nil};return value
    }
    private static func integer(_ value:Any?,_ limit:Int) -> Bool {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID() else {return false};let v=n.doubleValue
        return v.isFinite && v>=0 && v<=Double(limit) && v.rounded(.towardZero)==v
    }
    private static func flag(_ value:Any?) -> Bool? {
        guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else {return nil};return n.boolValue
    }
    private static func threadID(_ value:Any?) -> String? {
        guard let value=text(value,160),value.range(of:"^[A-Za-z0-9_.-]{1,160}$",options:.regularExpression) != nil else {return nil};return value
    }
    private static func path(_ value:Any?) -> String? {
        // NSString standardization rewrites canonical /private/tmp paths on macOS.
        // The manager binds filesystem identity; this boundary validates exact syntax.
        guard let value=text(value,4096),value.hasPrefix("/"),!value.contains("\n"),!value.contains("\r"),
              value.dropFirst().split(separator:"/",omittingEmptySubsequences:false).allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".."}) else {return nil};return value
    }
    static func creationPlan(_ plan:[String:Any],input:[String:Any]) -> Bool {
        func relative(_ value:String) -> Bool {value.utf8.count<=4096 && !value.isEmpty && !value.contains("\0") && value.split(separator:"/",omittingEmptySubsequences:false).allSatisfy{!$0.isEmpty && $0 != "." && $0 != ".." && $0.decomposedStringWithCanonicalMapping.uppercased().lowercased() != ".git"}}
        func summary(_ value:Any?) -> [String:Any]? {guard let v=value as? [String:Any],integer(v["files"],20000),integer(v["bytes"],134217728) else{return nil};return v}
        guard Set(plan.keys)==["id","source","commonDir","commit","cwd","dirty","expiresAt","copyChanges","localChanges","localSetup"],
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,let source=path(plan["source"]),let target=path(plan["cwd"]),path(plan["commonDir"]) != nil,
              source != target,!source.hasPrefix(target+"/"),!target.hasPrefix(source+"/"),flag(plan["dirty"]) != nil,
              let copy=flag(plan["copyChanges"]),copy==(flag(input["copyChanges"] ?? false) ?? false),
              let commit=plan["commit"] as? String,commit.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil,
              integer(plan["expiresAt"],9_007_199_254_740_991),let expiry=plan["expiresAt"] as? NSNumber,expiry.doubleValue>Date().timeIntervalSince1970*1000,expiry.doubleValue<=Date().timeIntervalSince1970*1000+120001,
              let setup=summary(plan["localSetup"]),Set(setup.keys)==["files","bytes","paths"],let paths=setup["paths"] as? [String],paths.count==(setup["files"] as? NSNumber)?.intValue,paths.allSatisfy(relative) else{return false}
        if !copy {return plan["localChanges"] is NSNull}
        guard let changes=summary(plan["localChanges"]),Set(changes.keys)==["files","bytes","changes","excludedScratch","ignoredRemainders"],let entries=changes["changes"] as? [[String:Any]],entries.count<=2000,
              let excluded=changes["excludedScratch"] as? [String],excluded.count<=2,excluded.allSatisfy({relative($0) && !$0.contains("/") && $0.decomposedStringWithCanonicalMapping.uppercased().lowercased().hasPrefix(".saleh-coding-tmp-")}) else{return false}
        guard let remainders=changes["ignoredRemainders"] as? [String],remainders.count<=2000,remainders.allSatisfy({name in relative(name) && entries.contains{($0["path"] as? String)==name && ($0["index"] as? String)=="D"}}) else{return false}
        return entries.allSatisfy{row in guard Set(row.keys)==["path","index","worktree"],let name=row["path"] as? String,relative(name),let index=row["index"] as? String,let working=row["worktree"] as? String else{return false};return index.count==1 && working.count==1 && index.allSatisfy{" MAD?!".contains($0)} && working.allSatisfy{" MAD?!".contains($0)}}
    }
    static func copyPlan(_ plan:[String:Any],input:[String:Any]) -> Bool {
        guard Set(plan.keys)==["id","operation","handoffId","rootThreadId","source","target","head","indexTree","files","bytes","omittedCount","expiresAt"],
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,plan["operation"] as? String=="handoff-original-copy",plan["handoffId"] as? String==input["id"] as? String,
              threadID(plan["rootThreadId"]) != nil,let source=path(plan["source"]),let target=path(plan["target"]),
              target.hasSuffix("/"+id+"/project"),source != target,!source.hasPrefix(target+"/"),!target.hasPrefix(source+"/"),
              integer(plan["files"],20000),integer(plan["bytes"],134217728),integer(plan["omittedCount"],20000),
              integer(plan["expiresAt"],9_007_199_254_740_991),let expiry=plan["expiresAt"] as? NSNumber,
              expiry.doubleValue>Date().timeIntervalSince1970*1000,expiry.doubleValue<=Date().timeIntervalSince1970*1000+120001 else{return false}
        return ["head","indexTree"].allSatisfy{key in guard let value=plan[key] as? String else{return false};return value.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil}
    }
    static func copyResult(_ result:[String:Any],plan:[String:Any]) -> Bool {
        guard Set(result.keys)==["copy"],let copy=result["copy"] as? [String:Any],
              Set(copy.keys)==Set(plan.keys).subtracting(["expiresAt"]).union(["receiptPath","independent","originalRecoveryComplete"]),
              flag(copy["independent"])==true,flag(copy["originalRecoveryComplete"])==false,
              let target=plan["target"] as? String,copy["receiptPath"] as? String==String(target.dropLast("project".count))+"receipt.json" else{return false}
        for (key,value) in plan where key != "expiresAt" {guard let actual=copy[key],NSDictionary(dictionary:[key:actual]).isEqual(to:[key:value]) else{return false}}
        return true
    }
    static func reconnectPlan(_ plan:[String:Any]) -> Bool {
        func hash(_ value:Any?,_ count:Int) -> Bool {guard let value=value as? String else{return false};return value.range(of:"^[a-f0-9]{\(count)}$",options:.regularExpression) != nil}
        func digits(_ value:String?) -> Bool {guard let value else{return false};return value.range(of:"^[0-9]{1,20}$",options:.regularExpression) != nil}
        guard Set(plan.keys)==Set(["id","operation","root","expiresAt","ledgerSHA256","historicalContinuity","records","bindings","content"]).union(plan["handoffs"] == nil ? []:["handoffs"]),
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,plan["operation"] as? String=="reconnect",let root=path(plan["root"]),root.hasSuffix("/Worktrees"),
              flag(plan["historicalContinuity"])==false,hash(plan["ledgerSHA256"],64),integer(plan["expiresAt"],9_007_199_254_740_991),
              let expiry=plan["expiresAt"] as? NSNumber,expiry.doubleValue>Date().timeIntervalSince1970*1000,expiry.doubleValue<=Date().timeIntervalSince1970*1000+120001,
              let records=plan["records"] as? [[String:Any]],!records.isEmpty,records.count<=128,
              let bindings=plan["bindings"] as? [[String:Any]],!bindings.isEmpty,bindings.count<=1025,
              let content=plan["content"] as? [[String:Any]],!content.isEmpty,content.count<=256 else{return false}
        var projects=Set<String>(),ids=Set<String>(),bound=Set<String>(),device:String?,volume:String?
        for row in records {
            let fields:Set<String>=["id","source","commit","cwd","createdAt","state","message","head","dirty","archivedAt"]
            guard Set(row.keys).isSubset(of:fields),let id=row["id"] as? String,UUID(uuidString:id) != nil,ids.insert(id).inserted,
                  let source=path(row["source"]),let cwd=path(row["cwd"]),cwd==root+"/"+id,source != cwd,
                  hash(row["commit"],40),hash(row["head"],40),row["state"] as? String=="ready",text(row["message"],2000) != nil,flag(row["dirty"]) != nil,integer(row["createdAt"],9_007_199_254_740_991),
                  row["archivedAt"]==nil || integer(row["archivedAt"],9_007_199_254_740_991) else{return false}
            projects.insert(source);projects.insert(cwd)
        }
        for row in bindings {
            guard Set(row.keys)==["path","before","after"],let name=path(row["path"]),bound.insert(name).inserted,
                  let before=row["before"] as? [String:String],Set(before.keys)==["dev","ino"],digits(before["dev"]),digits(before["ino"]),
                  let after=row["after"] as? [String:String],Set(after.keys)==["dev","ino","volumeUUID"],digits(after["dev"]),digits(after["ino"]),before["dev"] != after["dev"],before["ino"]==after["ino"],
                  let uuid=after["volumeUUID"],UUID(uuidString:uuid) != nil,uuid==uuid.uppercased(),uuid != "00000000-0000-0000-0000-000000000000",
                  device==nil || device==after["dev"],volume==nil || volume==uuid else{return false}
            device=after["dev"];volume=uuid
        }
        var captured=Set<String>(),files=0,bytes=0
        for row in content {
            guard Set(row.keys)==["path","hash","files","bytes"],let name=path(row["path"]),captured.insert(name).inserted,hash(row["hash"],64),integer(row["files"],20000),integer(row["bytes"],134217728) else{return false}
            files+=(row["files"] as! NSNumber).intValue;bytes+=(row["bytes"] as! NSNumber).intValue
        }
        if let value=plan["handoffs"] {
            guard let handoffs=value as? [[String:Any]],handoffs.count==1,let h=handoffs.first,
                  Set(h.keys)==["id","worktreeId","rootThreadId","source","destination","ownerId","manifestSHA256","receipts","committedSequence"],
                  let id=h["id"] as? String,UUID(uuidString:id) != nil,let owner=h["ownerId"] as? String,UUID(uuidString:owner) != nil,
                  let worktree=h["worktreeId"] as? String,ids.contains(worktree),threadID(h["rootThreadId"]) != nil,
                  let source=path(h["source"]),let destination=path(h["destination"]),source != destination,
                  records.contains(where:{$0["id"] as? String==worktree && Set([$0["source"] as? String ?? "",$0["cwd"] as? String ?? ""])==Set([source,destination])}),hash(h["manifestSHA256"],64),integer(h["receipts"],8192),integer(h["committedSequence"],8192),
                  (h["committedSequence"] as! NSNumber).intValue <= (h["receipts"] as! NSNumber).intValue else{return false}
        }
        return bound.contains(root) && projects.isSubset(of:bound) && projects==captured && files<=20000 && bytes<=134217728
    }
    static func reconnectResult(_ result:[String:Any],plan:[String:Any]) -> Bool {
        guard Set(result.keys)==["reconnected","backupPath","receiptPath","worktrees","message"],flag(result["reconnected"])==true,
              let root=plan["root"] as? String,let id=plan["id"] as? String,text(result["message"],1600) != nil,
              let worktrees=result["worktrees"] as? [[String:Any]],let records=plan["records"] as? [[String:Any]],
              NSArray(array:worktrees).isEqual(to:records) else{return false}
        let base=String(root.dropLast("Worktrees".count))+"managed-worktrees.json."+id
        return result["backupPath"] as? String==base+(plan["handoffs"] == nil ? ".v1.backup":".v2.backup") && result["receiptPath"] as? String==base+".reconnect.receipt.json"
    }
    static func handoffPlan(_ plan:[String:Any],input:[String:Any]) -> Bool {
        guard Set(plan.keys)==["id","operation","worktreeId","rootThreadId","source","destination","branch","family","files","bytes","nativePolicy","synthesized","recoveryDirectory","expiresAt"],
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,plan["operation"] as? String=="handoff",
              plan["worktreeId"] as? String==input["id"] as? String,let root=threadID(plan["rootThreadId"]),root==input["threadId"] as? String,
              let source=path(plan["source"]),let destination=path(plan["destination"]),source != destination,!source.hasPrefix(destination+"/"),!destination.hasPrefix(source+"/"),path(plan["recoveryDirectory"]) != nil,
              integer(plan["files"],40000),integer(plan["bytes"],268435456),text(plan["nativePolicy"],4096) != nil,
              integer(plan["expiresAt"],9_007_199_254_740_991),(plan["expiresAt"] as! NSNumber).doubleValue>Date().timeIntervalSince1970*1000,
              handoffFamily(plan["family"],root:root) else {return false}
        guard let synthesized=plan["synthesized"] as? [String:Any],Set(synthesized.keys)==["source","destination"] else {return false}
        for label in ["source","destination"] {
            guard let rows=synthesized[label] as? [[String:Any]],rows.count<=20000 else {return false};var paths=Set<String>()
            for row in rows {
                guard Set(row.keys)==["path","metadataFrom","mode"],let name=text(row["path"],4096),!name.hasPrefix("/"),name.split(separator:"/",omittingEmptySubsequences:false).allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".." && $0.lowercased() != ".git"}),paths.insert(name).inserted,
                      row["metadataFrom"] is NSNull || ["source","destination"].contains(row["metadataFrom"] as? String ?? ""),integer(row["mode"],0o7777) else {return false}
            }
        }
        return handoffBranch(plan["branch"])
    }
    private static func handoffFamily(_ value:Any?,root:String) -> Bool {
        guard let family=value as? [[String:Any]],!family.isEmpty,family.count<=2001 else {return false};var members=Set<String>()
        for row in family {
            guard Set(row.keys)==["id","archived"],let id=threadID(row["id"]),let archived=flag(row["archived"]),members.insert(id).inserted,id != root || !archived else {return false}
        }
        return members.contains(root)
    }
    private static func handoffBranch(_ value:Any?) -> Bool {
        guard let branch=value as? [String:Any],Set(branch.keys)==["sourceBefore","destinationBefore","sourceAfter","destinationAfter","retainedDestinationBranch","retention","branchRefsUnchanged"],flag(branch["branchRefsUnchanged"])==true,
              let retention=branch["retention"] as? [String:String],Set(retention.keys)==["source","destination"],retention.values.allSatisfy({$0.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil}),
              let sourceBefore=text(branch["sourceBefore"],1024),let destinationBefore=text(branch["destinationBefore"],1024),
              branch["sourceAfter"] as? String==retention["source"]!+"\n",branch["destinationAfter"] as? String==sourceBefore else {return false}
        for (head,oid) in [(sourceBefore,retention["source"]!),(destinationBefore,retention["destination"]!)] {
            guard head==oid+"\n" || head.range(of:"\\Aref: refs/heads/[^\\r\\n]{1,512}\\n\\z",options:.regularExpression) != nil else {return false}
        }
        if branch["retainedDestinationBranch"] is NSNull {return destinationBefore==retention["destination"]!+"\n"}
        guard let retained=text(branch["retainedDestinationBranch"],512) else {return false}
        return destinationBefore=="ref: refs/heads/"+retained+"\n"
    }
    static func recoveryPlan(_ plan:[String:Any],input:[String:Any]) -> Bool {
        guard Set(plan.keys)==["id","operation","handoffId","worktreeId","rootThreadId","mode","source","destination","target","phase","family","branch","files","bytes","retainedFiles","nativePolicy","recoveryDirectory","expiresAt"],
              let id=plan["id"] as? String,UUID(uuidString:id) != nil,plan["operation"] as? String=="handoff-recovery",
              let handoff=plan["handoffId"] as? String,UUID(uuidString:handoff) != nil,handoff==input["id"] as? String,
              let worktree=plan["worktreeId"] as? String,UUID(uuidString:worktree) != nil,let root=threadID(plan["rootThreadId"]),
              let mode=plan["mode"] as? String,["restore","finish"].contains(mode),mode==input["mode"] as? String,
              let source=path(plan["source"]),let destination=path(plan["destination"]),let recovery=path(plan["recoveryDirectory"]),
              plan["target"] as? String==(mode=="restore" ? source:destination),
              let phase=text(plan["phase"],80),phase.range(of:"^[a-z][a-z0-9-]{0,79}$",options:.regularExpression) != nil,
              integer(plan["files"],40000),integer(plan["bytes"],268435456),integer(plan["retainedFiles"],40000),text(plan["nativePolicy"],4096) != nil,
              integer(plan["expiresAt"],9_007_199_254_740_991),(plan["expiresAt"] as! NSNumber).doubleValue>Date().timeIntervalSince1970*1000,
              handoffFamily(plan["family"],root:root),handoffBranch(plan["branch"]) else {return false}
        return [(source,destination),(source,recovery),(destination,recovery)].allSatisfy{$0 != $1 && !$0.hasPrefix($1+"/") && !$1.hasPrefix($0+"/")}
    }
    static func recoveryResult(_ result:[String:Any],plan:[String:Any]) -> Bool {
        guard Set(result.keys)==["handoff","family"],let handoff=result["handoff"] as? [String:Any],Set(handoff.keys)==["id","rootThreadId","source","destination","mode","target","state","recoveryDirectory"],handoff["state"] as? String=="complete",
              handoff["id"] as? String==plan["handoffId"] as? String,
              ["rootThreadId","source","destination","mode","target","recoveryDirectory"].allSatisfy({handoff[$0] as? String==plan[$0] as? String}) else {return false}
        return handoffFamilyResult(result["family"],plan:plan,target:plan["target"] as? String)
    }
    static func handoffResult(_ result:[String:Any],plan:[String:Any]) -> Bool {
        guard Set(result.keys)==["handoff","family"],let handoff=result["handoff"] as? [String:Any],Set(handoff.keys)==["id","rootThreadId","source","destination","state","recoveryDirectory"],handoff["state"] as? String=="complete",
              ["id","rootThreadId","source","destination","recoveryDirectory"].allSatisfy({handoff[$0] as? String==plan[$0] as? String}) else {return false}
        return handoffFamilyResult(result["family"],plan:plan,target:plan["destination"] as? String)
    }
    private static func handoffFamilyResult(_ value:Any?,plan:[String:Any],target:String?) -> Bool {
        guard let target,let family=value as? [String:Any],Set(family.keys)==["rootThreadId","cwd","model","modelProvider","fingerprint","members"],let root=threadID(family["rootThreadId"]),root==plan["rootThreadId"] as? String,family["cwd"] as? String==target,
              let model=text(family["model"],512),let provider=text(family["modelProvider"],512),let fingerprint=family["fingerprint"] as? String,fingerprint.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,
              let reviewed=plan["family"] as? [[String:Any]],let members=family["members"] as? [[String:Any]],members.count==reviewed.count else {return false}
        let expected=Dictionary(uniqueKeysWithValues:reviewed.map{($0["id"] as! String,$0["archived"] as! Bool)});var parents=[String:String](),seen=Set<String>()
        for row in members {
            guard Set(row.keys)==["id","parentThreadId","archived","cwd","model","modelProvider","lastTurnId","compatibility"],let id=threadID(row["id"]),seen.insert(id).inserted,let archived=flag(row["archived"]),expected[id]==archived,
                  row["cwd"] as? String==family["cwd"] as? String,row["model"] as? String==model,row["modelProvider"] as? String==provider,row["lastTurnId"] is NSNull || threadID(row["lastTurnId"]) != nil,
                  let compatibility=row["compatibility"] as? [String:Any],Set(compatibility.keys)==["version","headerHash","identity"],integer(compatibility["version"],1),(compatibility["version"] as? NSNumber)?.intValue==1,
                  let hash=compatibility["headerHash"] as? String,hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,
                  let identity=compatibility["identity"] as? [String:String],Set(identity.keys)==["dev","ino"],identity.values.allSatisfy({$0.range(of:"^[0-9]{1,20}$",options:.regularExpression) != nil}) else {return false}
            if id==root {guard row["parentThreadId"] is NSNull else {return false}}
            else {guard let parent=threadID(row["parentThreadId"]),expected[parent] != nil else {return false};parents[id]=parent}
        }
        for id in parents.keys {var current=id,visited=Set<String>();while current != root {guard visited.count<32,visited.insert(current).inserted,let parent=parents[current] else {return false};current=parent}}
        return seen==Set(expected.keys)
    }
}

enum CodingGitPolicy {
    static func action(_ input:[String:Any]) -> String? {
        guard let action=input["action"] as? String else { return nil }
        func text(_ key:String,_ limit:Int) -> String? {
            guard let value=input[key] as? String,!value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,value.utf8.count<=limit,!value.contains("\0") else { return nil };return value
        }
        func uuid(_ key:String) -> Bool { text(key,36).flatMap(UUID.init(uuidString:)) != nil }
        func line(_ key:String,_ limit:Int) -> String? {
            guard let value=text(key,limit),!value.contains("\r"),!value.contains("\n") else { return nil };return value
        }
        func branch(_ key:String) -> Bool {
            guard let value=line(key,200),value != "HEAD",!value.hasPrefix("-"),!value.hasPrefix("refs/"),!value.hasSuffix("."),!value.contains(".."),!value.contains("@{"),value.range(of:"[\\x00-\\x20\\x7f~^:?*\\[\\\\]",options:.regularExpression)==nil else{return false}
            return value.split(separator:"/",omittingEmptySubsequences:false).allSatisfy{!$0.isEmpty && !$0.hasPrefix(".") && !$0.hasSuffix(".lock")}
        }
        if action=="stop" { return Set(input.keys)==["action","requestId"] && uuid("requestId") ? action:nil }
        guard let thread=text("threadId",160),thread.range(of:"^[A-Za-z0-9_.-]+$",options:.regularExpression) != nil else { return nil }
        if action=="inspect" { return Set(input.keys)==["action","threadId"] ? action:nil }
        if action=="inspectRemoteOutcome" {return Set(input.keys)==["action","threadId","requestId"] && uuid("requestId") ? action:nil}
        if action=="acknowledgeRemoteOutcome" {return Set(input.keys)==["action","threadId","requestId","observationId"] && uuid("requestId") && uuid("observationId") ? action:nil}
        guard uuid("snapshotId"),uuid("requestId") else { return nil }
        let base:Set<String>=["action","threadId","snapshotId","requestId"]
        switch action {
        case "stage","unstage":
            guard Set(input.keys)==base.union(["entryIds"]),let ids=input["entryIds"] as? [String],!ids.isEmpty,ids.count<=128,Set(ids).count==ids.count,ids.allSatisfy({!$0.isEmpty && $0.utf8.count<=160 && !$0.contains("\0")}) else { return nil }
        case "commit":
            guard Set(input.keys)==base.union(["message","authorName","authorEmail"]),text("message",8192) != nil,
                  let name=line("authorName",120),!name.contains("<"),!name.contains(">"),let email=line("authorEmail",254),email.contains("@"),email.rangeOfCharacter(from:.whitespacesAndNewlines)==nil,!email.contains("<"),!email.contains(">") else { return nil }
        case "createBranch","switchBranch": guard Set(input.keys)==base.union(["name"]),line("name",200) != nil else { return nil }
        case "remoteInspect": guard Set(input.keys)==base.union(["remote","branch","base"]),let remote=line("remote",100),remote.rangeOfCharacter(from:.whitespacesAndNewlines)==nil,branch("branch"),branch("base") else{return nil}
        case "publishBranch": guard Set(input.keys)==base.union(["remoteSnapshotId"]),uuid("remoteSnapshotId") else{return nil}
        case "createPR": guard Set(input.keys)==base.union(["remoteSnapshotId","title","body"]),uuid("remoteSnapshotId"),line("title",256) != nil,let body=input["body"] as? String,body.utf8.count<=65536,!body.contains("\0") else{return nil}
        default: return nil
        }
        return action
    }
}

// Read-only diagnostics; process IDs and historical snapshots are never recovery authority.
enum ShutdownInspection {
    enum Failure: Error { case malformed, unsafe, changed }
    static let names = ["command","inference","tools","worktrees","git","schedules","coding"]
    static func integer(_ value: Any?, max: Double = 253402300799999) throws -> Int64 {
        guard let n=value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= max, n.doubleValue.rounded() == n.doubleValue else { throw Failure.malformed }
        return n.int64Value
    }
    static func render(_ value: [String:Any], filename: String? = nil) throws -> String {
        guard Set(value.keys) == ["version","id","pid","startedAt","requestedAt","updatedAt","revision","trigger","state","executionRevoked","subsystems"],
              try integer(value["version"]) == 1, let id=value["id"] as? String, UUID(uuidString:id)?.uuidString.lowercased() == id,
              filename == nil || filename == id+".json", try integer(value["pid"],max:2147483647) > 0,
              try integer(value["revision"],max:9007199254740991) > 0,
              let trigger=value["trigger"] as? String, ["native-request","parent-eof","sigterm","sigint"].contains(trigger),
              let state=value["state"] as? String, ["pending","closed","unconfirmed"].contains(state),
              let subsystems=value["subsystems"] as? [String:String], Set(subsystems.keys) == Set(names),
              subsystems.values.allSatisfy({["pending","closed","unconfirmed","failed"].contains($0)}),
              state != "closed" || subsystems.values.allSatisfy({$0 == "closed"}),
              state == "pending" || !subsystems.values.contains("pending") else { throw Failure.malformed }
        for key in ["startedAt","requestedAt","updatedAt"] { _ = try integer(value[key]) }
        let revoked: String
        if value["executionRevoked"] is NSNull { revoked="unreported" }
        else if let flag=value["executionRevoked"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() { revoked=flag.boolValue ? "confirmed":"not confirmed" }
        else { throw Failure.malformed }
        let date=Date(timeIntervalSince1970:Double(try integer(value["updatedAt"]))/1000)
        return "Run \(id) • \(ISO8601DateFormatter().string(from:date))\nTrigger: \(trigger) • Outcome: \(state) • Revision: \(try integer(value["revision"]))\nExecution revocation: \(revoked)\n" + names.map{"\($0): \(subsystems[$0]!)"}.joined(separator:" · ") + (state == "pending" ? "\nThis shutdown has no recorded terminal outcome.":"")
    }
    static func live(_ value: [String:Any]) throws -> String {
        guard Set(value.keys) == ["record","persistence","savedRevision"], let persistence=value["persistence"] as? String,
              ["idle","pending","saved","failed","unavailable"].contains(persistence) else { throw Failure.malformed }
        let saved=try integer(value["savedRevision"],max:9007199254740991)
        let text: String
        if let record=value["record"] as? [String:Any] {
            let revision=try integer(record["revision"],max:9007199254740991)
            guard persistence != "idle", saved <= revision, persistence != "saved" || saved == revision else { throw Failure.malformed }
            text=try render(record)
        } else {
            guard value["record"] is NSNull, saved == 0, ["idle","unavailable"].contains(persistence) else { throw Failure.malformed }
            text="No shutdown requested in this server run."
        }
        return "Live signed status\nDurability: \(persistence) • Saved revision: \(saved)\n\n" + text
    }
    static func read(_ directory: Int32, _ name: String) throws -> [String:Any] {
        let before=try CodingTemporary.namedInfo(directory,name)
        guard before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(), before.st_mode & 0o077 == 0,
              before.st_nlink == 1, before.st_size >= 0, before.st_size <= 16384 else { throw Failure.unsafe }
        let fd=try HandoffFiles.opened(directory,name,before); defer { close(fd) }
        var bytes=[UInt8](repeating:0,count:16385),count=0
        while count < bytes.count {
            let n=bytes.withUnsafeMutableBytes{Darwin.read(fd,$0.baseAddress!.advanced(by:count),$0.count-count)}
            if n < 0 && errno == EINTR { continue }
            guard n >= 0 else { throw Failure.unsafe }; if n == 0 { break }; count += n
        }
        guard HandoffFiles.version(before) == HandoffFiles.version(try CodingTemporary.info(fd)),
              HandoffFiles.version(before) == HandoffFiles.version(try CodingTemporary.namedInfo(directory,name)) else { throw Failure.changed }
        guard count <= 16384, count == before.st_size else { throw Failure.unsafe }
        let data=Data(bytes.prefix(count))
        guard String(data:data,encoding:.utf8) != nil, let record=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { throw Failure.malformed }
        _ = try render(record,filename:name); return record
    }
    static func saved(_ path: String) -> String {
        let heading="Previous-run snapshots — historical observations, not proof that a process is alive or that recovery is safe."
        var named=stat()
        if lstat(path,&named) != 0 { return heading + (errno == ENOENT ? "\nNo saved shutdown records found.":"\nShutdown records are unreadable.") }
        do {
            try CodingTemporary.canonical(path); try CodingTemporary.privateDirectory(named)
            let fd=try CodingTemporary.directory(AT_FDCWD,path); defer { close(fd) }
            guard CodingTemporary.same(named,try CodingTemporary.info(fd)) else { throw Failure.changed }
            let copy=try CodingTemporary.directory(fd,".")
            guard let stream=fdopendir(copy) else { close(copy); throw Failure.unsafe }; defer { closedir(stream) }
            var records=[(Int64,String)](),malformed=0,unsafe=0,changed=0,ignored=0,entries=0,limited=false,pending=0
            // ponytail: bound inspection to 256 entries and 20 displayed records; add paging when retained history exceeds this view.
            while true {
                errno=0
                guard let entry=readdir(stream) else { if errno != 0 { throw Failure.unsafe }; break }
                let name=withUnsafePointer(to:&entry.pointee.d_name){p in p.withMemoryRebound(to:CChar.self,capacity:Int(entry.pointee.d_namlen)+1){String(cString:$0)}}
                if name == "." || name == ".." { continue }
                entries += 1; if entries > 256 { limited=true; break }
                guard name.hasSuffix(".json"), let uuid=UUID(uuidString:String(name.dropLast(5))), uuid.uuidString.lowercased()+".json" == name else { ignored += 1; continue }
                do {
                    let record=try read(fd,name); if record["state"] as? String == "pending" { pending += 1 }
                    records.append((try integer(record["updatedAt"]),try render(record)))
                } catch Failure.malformed { malformed += 1 } catch Failure.changed { changed += 1 } catch { unsafe += 1 }
            }
            try CodingTemporary.canonical(path); try CodingTemporary.privateDirectory(try CodingTemporary.info(fd))
            var after=stat(); guard lstat(path,&after) == 0, HandoffFiles.version(named) == HandoffFiles.version(after) else { throw Failure.changed }
            var text=heading+"\nValid: \(records.count) • Pending: \(pending) • Malformed or unsupported: \(malformed) • Unsafe or unreadable: \(unsafe) • Changed: \(changed) • Other entries: \(ignored)"
            if limited { text += "\nInspection limited to 256 entries; additional records may exist. This is not a complete history." }
            if entries == 0 { text += "\nNo completed record files in this directory." }
            if records.count > 20 { text += "\nShowing 20 of \(records.count) valid snapshots read; other records are retained." }
            return text + "\n\n" + records.sorted{$0.0 > $1.0}.prefix(20).map{$0.1}.joined(separator:"\n\n")
        } catch Failure.changed { return heading+"\nSnapshot changed during inspection; this view is incomplete. Refresh to inspect again." }
        catch { return heading+"\nShutdown records could not be safely inspected. Files are preserved." }
    }
}


// This bridge accepts selectors from the page; only signed backend inspection
// supplies a tool and its arguments. A durable native claim precedes dispatch.
private enum NativeAgentStep {
    static func uuid(_ value:Any?) -> String? { guard let value=value as? String,let id=UUID(uuidString:value),id.uuidString.lowercased()==value else{return nil};return value }
    static func integer(_ value:Any?) -> Int? { guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=1,n.doubleValue<=9_007_199_254_740_991,n.doubleValue.rounded()==n.doubleValue else{return nil};return n.intValue }
    static func inspect(_ value:[String:Any],run:String,step:String) throws {
        guard Set(value.keys)==["version","runId","stepId","stepDigest","generation","name","arguments","state"],integer(value["version"])==1,
              value["runId"] as? String==run,value["stepId"] as? String==step,uuid(value["generation"]) != nil,
              let digest=value["stepDigest"] as? String,digest.count==64,digest.allSatisfy({"0123456789abcdef".contains($0)}),
              let name=value["name"] as? String,!name.isEmpty,name.utf8.count<=200,
              let args=value["arguments"] as? [String:Any],JSONSerialization.isValidJSONObject(args),try JSONSerialization.data(withJSONObject:args).count<=64000,
              value["state"] as? String=="pending" else{throw ComputerError.message("Invalid pending Agent step. Nothing was dispatched.")}
    }
    static func claim(_ value:[String:Any],inspection:[String:Any],id:String) throws {
        var expected=inspection;expected["state"]="claimed";expected["claimId"]=id
        guard Set(value.keys)==Set(expected.keys),JSONSerialization.isValidJSONObject(value),try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:expected,options:[.sortedKeys]) else{throw ComputerError.message("Agent claim acknowledgement differed. Nothing was dispatched.")}
    }
    static func receipt(_ value:[String:Any],run:String,step:String,status:String,revision:Int) throws {
        guard value["persistence"] as? String=="saved",value["saveError"] is NSNull,
              let durable=integer(value["durableRevision"]),durable>=revision,
              let row=value["run"] as? [String:Any],integer(row["version"])==2,row["kind"] as? String=="agent",row["runId"] as? String==run,
              let rowRevision=integer(row["revision"]),rowRevision>=revision,durable>=rowRevision,
              let receipts=row["receipts"] as? [[String:Any]],receipts.filter({$0["id"] as? String==step}).count==1,
              receipts.first(where:{$0["id"] as? String==step})?["status"] as? String==status else{throw ComputerError.message("Agent result persistence is unconfirmed. Inspect the retained step before retrying.")}
    }
    static func completion(_ value:[String:Any],run:String,step:String,claim:String,kind:String,status:String) throws {
        guard let done=value["completion"] as? [String:Any],Set(done.keys)==["runId","stepId","claimId","outcomeKind","revision"],
              done["runId"] as? String==run,done["stepId"] as? String==step,done["claimId"] as? String==claim,done["outcomeKind"] as? String==kind,
              let revision=integer(done["revision"]) else{throw ComputerError.message("Agent completion acknowledgement is unconfirmed.")}
        try receipt(value,run:run,step:step,status:status,revision:revision)
    }
    static func decline(_ value:[String:Any],run:String,step:String) throws {
        guard let row=value["run"] as? [String:Any],let revision=integer(row["revision"]) else{throw ComputerError.message("Agent cancellation persistence is unconfirmed.")}
        try receipt(value,run:run,step:step,status:"cancelled",revision:revision)
    }
    static func message(_ error:Error) -> String {
        var data=Data(error.localizedDescription.utf8.prefix(2000))
        while String(data:data,encoding:.utf8)==nil && !data.isEmpty {data.removeLast()}
        return String(data:data,encoding:.utf8).flatMap{$0.isEmpty ? nil:$0} ?? "Native action outcome is unconfirmed."
    }
}

@MainActor
final class NativeToolsController: NSObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    var authenticate: (() async -> Bool)?
    private let computer: ComputerController, token: String
    private let accessMode: ToolAccessMode
    private(set) var recoveryStartup=false
    func holdForRecoveryStartup(){recoveryStartup=true}
    private let session = URLSession(configuration:.ephemeral,delegate:ToolsNoRedirect(),delegateQueue:nil)
    private var epoch = UUID(), busy = false, alert: NSAlert?
    private var codingAnswer: Task<[String:Any],Error>?
    private var agentStepTask: Task<[String:Any],Error>?
    private var agentStepTaskID: UUID?
    private var agentStepSettlementError: String?
    private var worktreeEpoch = UUID(), worktreeBusy = false
    private var scheduleEpoch = UUID(), scheduleBusy = false
    private var gitEpoch = UUID(), gitBusy = false, gitRequest: String?
    // SCOPED STOP ADMISSION BEGIN
    private struct ScopedStop { let id:UUID, scope:String; let admittedUncertainty:UUID? }
    private var scopedStops:[UUID:String]=[:], uncertainScopedStops:[String:UUID]=[:]
    private func beginScopedStop(_ body:[String:Any]) -> ScopedStop? {
        guard CodingControlPolicy.allows(body),let op=body["op"] as? String,let input=body["input"] as? [String:Any],
              let scope=["codingWorktrees":"worktrees","codingSchedules":"schedules","codingGit":"git"][op] else {return nil}
        if scope=="git",input["requestId"] as? String != gitRequest {return nil}
        // Concurrent controls join this generation; Pause(A) must not discard Pause(B).
        if !scopedStops.values.contains(scope) {
            switch scope {case "worktrees":worktreeEpoch=UUID();case "schedules":scheduleEpoch=UUID();default:gitEpoch=UUID()}
        }
        let reviewing=scope=="worktrees" ? worktreeBusy:scope=="schedules" ? scheduleBusy:gitBusy
        if reviewing,let alert,let parent=alert.window.sheetParent {parent.endSheet(alert.window,returnCode:.abort)}
        let ticket=ScopedStop(id:UUID(),scope:scope,admittedUncertainty:uncertainScopedStops[scope]);scopedStops[ticket.id]=scope;return ticket
    }
    private func requestScopedStop(_ operation:String,_ input:[String:Any],ticket:ScopedStop?) async throws -> [String:Any] {
        guard let ticket,ticket.scope==operation,scopedStops[ticket.id]==operation else {throw ComputerError.message("Cancellation is no longer active.")}
        do {
            let result=try await request(operation,input)
            if uncertainScopedStops[operation]==ticket.admittedUncertainty {uncertainScopedStops[operation]=nil};return result
        } catch {
            // A lost POST reply can leave cancellation in flight. A fresh acknowledged
            // Stop can clear this fence; changing a native generation cannot.
            uncertainScopedStops[operation]=UUID();throw error
        }
    }
    // SCOPED STOP ADMISSION END
    private var routineReads: [String:(kind:String,hash:String)] = [:]
    private var codingGrants = Set<String>()
    private let codingQueue = CodingQueueSession()
    private var queueAlertRoot: String?
    private let codingSkills = CodingSkillsSession()
    private let projectSkills = ProjectSkillsSession()
    private let fetchPlugin = FetchPluginSession()
    private let codingFilePreview = CodingFilePreviewSession()
    private let codingSetup = CodingMCPSetupSession()
    private let provisioning = CodingProvisioning()
    private var provisioningAlertID: String?
    private var setupAlertID: String?
    private var providerBinding: (threadId:String,token:UUID)?
    private var providerBindingAlert: UUID?
    private var codingTerminals: [String:String] = [:]
    private var codingInteractive = CodingTerminalGrants()
    private let contacts = CNContactStore()
    private let runtimePaths:Result<OwnedRuntimePaths,Error> = Result {try OwnedRuntimePaths(resources:Bundle.main.resourceURL)}
    init(computer: ComputerController, token: String, accessMode: ToolAccessMode = .reviewed) { self.computer=computer; self.token=token; self.accessMode=accessMode }
    func shutdownStatus() async -> String {
        let current: String
        do { current=try ShutdownInspection.live(await request("shutdownStatus",[:])) }
        catch { current="Live shutdown status is unavailable. Saved snapshots below cannot establish the current server's state." }
        do {
            let path=try runtimePaths.get().shutdown.path
            let saved=await Task.detached { ShutdownInspection.saved(path) }.value
            return current+"\n\n"+saved
        } catch {return current+"\n\n"+error.localizedDescription}
    }
    func stop() { stopTools(includeCoding:true) }
    func shutdown() async throws {
        let pending=agentStepTask
        revokeTools(includeCoding:true)
        if let pending {
            let stopping=Task {try await self.request("stop",["reason":"shutdown-drain"])}
            _ = await pending.result
            _ = try await stopping.value
        }
        await projectSkills.drain()
        await fetchPlugin.drain()
        if let failure=agentStepSettlementError {throw ComputerError.message("Agent completion persistence is unconfirmed. "+failure)}
        let result = try await request("shutdown",[:])
        guard let stopped = result["stopped"] as? NSNumber,
              CFGetTypeID(stopped) == CFBooleanGetTypeID(), stopped.boolValue else {
            throw ComputerError.message("Shutdown is unconfirmed. Cleanup ownership is retained; inspect pending work before quitting.")
        }
    }
    func departPage() { stopTools(departure:true) }
    func stopTools(includeCoding:Bool=false,departure:Bool=false) {
        let pending=agentStepTask
        let admittedUncertainty=uncertainScopedStops
        revokeTools(includeCoding:includeCoding,departure:departure)
        let stoppedEpoch=epoch
        Task {
            let detail:[String:Any]
            do {
                // Start cancellation before draining the native task: backend Stop
                // may itself be waiting for that task's durable completion.
                let stopping=Task {try await self.request(departure ? "depart":"stop",departure || includeCoding ? [:]:["coding":false])}
                if let pending {_ = await pending.result}
                await self.projectSkills.drain()
                await self.fetchPlugin.drain()
                let result=try await stopping.value
                if let failure=agentStepSettlementError {throw ComputerError.message("Agent completion persistence is unconfirmed. "+failure)}
                let flag=result["stopped"] as? NSNumber,valid=flag.map{CFGetTypeID($0)==CFBooleanGetTypeID()}==true
                if valid && flag!.boolValue {
                    for scope in includeCoding ? ["worktrees","git","schedules"]:["worktrees","git"] where uncertainScopedStops[scope]==admittedUncertainty[scope] {uncertainScopedStops[scope]=nil}
                }
                detail=["stopped":valid && flag!.boolValue,"message":valid ? String((result["message"] as? String ?? "Stop outcome unavailable. Inspect retained work before retrying.").prefix(1600)):"Stop outcome is unconfirmed. Inspect retained work before retrying."]
            } catch {detail=["stopped":false,"message":String(("Stop outcome is unconfirmed. "+error.localizedDescription).prefix(1600))]}
            guard epoch==stoppedEpoch,let data=try? JSONSerialization.data(withJSONObject:detail,options:[.sortedKeys]) else {return}
            webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('tools-stop-result',{detail:"+String(decoding:data,as:UTF8.self)+"}))",completionHandler:nil)
        }
    }
    private func revokeTools(includeCoding:Bool,departure:Bool=false) {
        codingAnswer?.cancel()
        provisioning.invalidate()
        codingSkills.invalidate(); projectSkills.invalidate(); fetchPlugin.invalidate(); codingFilePreview.invalidate(); codingSetup.invalidate(); codingQueue.invalidate(); queueAlertRoot=nil; setupAlertID=nil;providerBinding=nil;providerBindingAlert=nil
        epoch=UUID(); worktreeEpoch=UUID(); scheduleEpoch=UUID(); gitEpoch=UUID(); gitRequest=nil; routineReads=[:]; codingGrants=[]; codingInteractive.revoke(); computer.stop()
        if includeCoding { codingTerminals=[:] }
        let event=includeCoding ? "agent-stopped":"tools-stopped"
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)',{detail:{departure:\(departure ? "true":"false")}}))",completionHandler:nil)
        if let alert, let parent=alert.window.sheetParent { parent.endSheet(alert.window,returnCode:.abort) }; alert=nil
    }
    private func require(_ expected: UUID) throws { guard expected==epoch, !Task.isCancelled else { throw ComputerError.message("Stopped. Any action already sent may still have happened; no retry was made.") } }
    private func request(_ operation: String, _ input: [String:Any]) async throws -> [String:Any] {
        let expected=epoch,action=input["action"] as? String ?? ""
        if CodingProvisioning.canStartGuest(operation:operation,action:action) {
            let nonce=UUID().uuidString.lowercased()
            // Bind display identity before original dispatch. Later updates can
            // never attach to a new page request after this one settles.
            if let script=startupProgressScript(nonce,action:action,revision:0,state:"begin",stage:nil){_ = try? await webView?.evaluateJavaScript(script)}
            return try await provisioning.execute(requestId:nonce,check:{try self.require(expected)},
                original:{try await self.signedRequest(operation,input,nonce:nonce,timeout:CodingProvisioning.startupTimeout)},
                exchange:{try await self.provisioningExchange($0,expected:expected)},
                ask:{try await self.provisioningReview($0,pending:$1,expected:expected)},dismiss:{self.dismissProvisioning($0)},observe:{update in
                    if let script=self.startupProgressScript(nonce,action:action,revision:update.revision,state:update.state,stage:update.stage,fraction:update.fraction){self.webView?.evaluateJavaScript(script,completionHandler:nil)}
                })
        }
        if operation=="codingMCP",let setupId=input["setupId"] as? String {
            if action=="commitStart" {
                let nonce=UUID().uuidString.lowercased()
                let value=try await provisioning.execute(requestId:nonce,setupId:setupId,check:{try self.require(expected)},
                    original:{let result=try await self.signedRequest(operation,input,nonce:nonce);_ = try CodingMCPSetupPolicy.project(result,setupId:setupId);return result},
                    exchange:{try await self.provisioningExchange($0,expected:expected)},
                    ask:{try await self.provisioningReview($0,pending:$1,expected:expected)},dismiss:{self.dismissProvisioning($0)},cancelSetup:{
                        let cancelled=try await self.signedRequest("codingMCP",["action":"cancelSetup","setupId":setupId],timeout:CodingProvisioning.inspectionTimeout)
                        _ = try CodingMCPSetupPolicy.project(cancelled,setupId:setupId)
                        guard ["cancelled","failed"].contains(cancelled["phase"] as? String ?? ""),cancelled["cleanup"] as? String=="closed" else{throw CodingProvisioning.Failure()}
                    })
                if value["phase"] as? String != "committing" {provisioning.finishSetup(setupId)}
                return value
            }
            if action=="cancelSetup" {provisioning.finishSetup(setupId)}
            if action=="setupStatus" {
                do {
                    let value=try await signedRequest(operation,input);try require(expected)
                    _ = try CodingMCPSetupPolicy.project(value,setupId:setupId)
                    if value["phase"] as? String=="committing" {
                        try await provisioning.inspectSetup(setupId,check:{try self.require(expected)},
                            exchange:{try await self.provisioningExchange($0,expected:expected)},
                            ask:{try await self.provisioningReview($0,pending:$1,expected:expected)})
                    } else if ["created","cancelled","failed"].contains(value["phase"] as? String ?? "") {provisioning.finishSetup(setupId)}
                    return value
                } catch {await provisioning.failSetup(setupId);throw CodingProvisioning.Failure()}
            }
        }
        if operation=="coding",action=="answer" {
            let task=Task { try require(expected); return try await signedRequest(operation,input) }
            codingAnswer=task
            defer { codingAnswer=nil }
            let result=try await task.value
            try require(expected);return result
        }
        // Approved Git execution includes guarded host/guest synchronization.
        return try await signedRequest(operation,input,timeout:operation == "shutdownStatus" ? 2:operation == "git" && action == "execute" ? 600:75)
    }
    private func provisioningExchange(_ input:[String:Any],expected:UUID) async throws -> [String:Any] {
        try require(expected);let result=try await signedRequest("codingProvisioning",input,timeout:CodingProvisioning.inspectionTimeout);try require(expected);return result
    }
    private func startupProgressScript(_ requestId:String,action:String,revision:Int,state:String,stage:String?,fraction:Double?=nil) -> String? {
        var value:[String:Any] = ["requestId":requestId,"action":action,"revision":revision,"state":state,"stage":stage as Any? ?? NSNull()]
        if let fraction{guard state=="observed",stage=="installing",fraction.isFinite,(0...1).contains(fraction) else{return nil};value["fraction"]=fraction}
        guard let data=try? JSONSerialization.data(withJSONObject:value) else{return nil}
        return "window.dispatchEvent(new CustomEvent('coding-startup-progress',{detail:"+String(decoding:data,as:UTF8.self)+"}))"
    }
    private func provisioningReview(_ requestId:String,pending:CodingProvisioning.Pending,expected:UUID) async throws -> Bool {
        let value=pending.object
        let detail="1. In the guest window matching the owner, generation and guest below, finish any visible first-run screens.\n\n2. Select Request guest shutdown here, then confirm Shut Down inside that exact guest window if prompted. The guest must finish shutting down within 60 seconds of your request. Execution waits for verified clean shutdown and key extraction.\n\nProject: \(value["cwd"]!)\nOwner: \(value["ownerId"]!)\nGeneration: \(value["generation"]!)\nGuest: \(value["guestId"]!)\n\nCancel requests cancellation of this startup. Physical cleanup is confirmed separately; it does not undo actions already sent."
        return try await approve("Inspect this provisioning guest",detail:detail,button:"Request guest shutdown",expected:expected,provisioningId:requestId)
    }
    private func dismissProvisioning(_ requestId:String) {
        guard provisioningAlertID==requestId else{return}
        if let alert,let parent=alert.window.sheetParent {parent.endSheet(alert.window,returnCode:.abort)}
        alert=nil;setupAlertID=nil;provisioningAlertID=nil
    }
    func computerProposal(_ input:[String:Any]) async throws -> [String:Any] {
        let expected=epoch;try require(expected)
        let result=try await signedRequest("computerProposal",input,timeout:300);try require(expected);return result
    }
    private func signedRequest(_ operation:String,_ input:[String:Any],nonce:String=UUID().uuidString.lowercased(),timeout:TimeInterval=75) async throws -> [String:Any] {
        let route="/api/tools/"+operation, time=String(Int64(Date().timeIntervalSince1970*1000))
        let data=try JSONSerialization.data(withJSONObject:input,options:["coding","codingQueue","computerProposal"].contains(operation) ? [.sortedKeys,.withoutEscapingSlashes]:[.sortedKeys])
        let digest=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()
        let payload="QwenLocal:tools:v1\nPOST\n\(route)\n\(nonce)\n\(time)\n\(digest)"
        let signature=HMAC<SHA256>.authenticationCode(for:Data(payload.utf8),using:SymmetricKey(data:Data(token.utf8))).map{String(format:"%02x",$0)}.joined()
        var req=URLRequest(url:URL(string:"http://127.0.0.1:8787"+route)!); req.httpMethod="POST"; req.httpBody=data; req.timeoutInterval=timeout
        req.setValue("application/json",forHTTPHeaderField:"Content-Type"); req.setValue(nonce,forHTTPHeaderField:"X-Qwen-Nonce"); req.setValue(time,forHTTPHeaderField:"X-Qwen-Time"); req.setValue(signature,forHTTPHeaderField:"X-Qwen-Permit")
        let (body,response)=try await session.data(for:req)
        guard body.count <= (operation=="agentStep" ? 16*1024*1024:4_000_000), let value=try JSONSerialization.jsonObject(with:body) as? [String:Any] else { throw ComputerError.message("Invalid local tool response. Completion is unconfirmed; no retry was made.") }
        guard (response as? HTTPURLResponse)?.statusCode==200 else { throw ComputerError.message(value["error"] as? String ?? "Local tool request failed.") }
        return value
    }
    private func approve(_ title: String, detail: String, button: String, expected: UUID, accessory: NSView? = nil, operational: Bool = false, setupId: String? = nil, provisioningId:String?=nil) async throws -> Bool {
        try require(expected)
        if accessory == nil && accessMode.skipsConfirmation(operational:operational) { return true }
        guard alert==nil else {throw ComputerError.message("Another native review is still pending. No approval was sent.")}
        guard let owner=webView?.window else { throw ComputerError.message("The app window is unavailable.") }
        let dialog=NSAlert(); dialog.messageText=title; dialog.addButton(withTitle:"Cancel"); dialog.addButton(withTitle:button)
        if let accessory { dialog.informativeText=detail; dialog.accessoryView=accessory }
        else {
            let scroll=NSScrollView(frame:NSRect(x:0,y:0,width:540,height:250)); scroll.hasVerticalScroller=true; scroll.borderType = .bezelBorder
            let text=NSTextView(frame:scroll.bounds); text.isEditable=false; text.isSelectable=true; text.font = .monospacedSystemFont(ofSize:12,weight:.regular); text.string=detail; text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView=true; scroll.documentView=text; dialog.accessoryView=scroll
            dialog.informativeText="Review the exact operation below. Approval applies once. Stop cannot undo an operation already sent."
        }
        alert=dialog; setupAlertID=setupId; provisioningAlertID=provisioningId
        owner.makeKeyAndOrderFront(nil); NSApp.activate()
        let result=await withCheckedContinuation { continuation in dialog.beginSheetModal(for:owner){continuation.resume(returning:$0)};if provisioningId != nil{NSLog("Saleh provisioning phase: ask-presented")} }
        if alert===dialog { alert=nil; setupAlertID=nil; provisioningAlertID=nil }; try require(expected); return result == .alertSecondButtonReturn
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin=message.frameInfo.securityOrigin
        guard message.webView===webView, message.frameInfo.isMainFrame, origin.protocol=="http", origin.host=="127.0.0.1", origin.port==8787,
              let body=message.body as? [String:Any], let op=body["op"] as? String else { replyHandler(nil,"Untrusted caller.");return }
        if op=="departPage", Set(body.keys)==["op"] {
            departPage(); replyHandler(["departed":true,"message":"Page action grants revoked; accepted text generation stays with the backend."],nil);return
        }
        if op=="cancel" || op=="cancelTools" {
            if op=="cancel" { stop() } else { stopTools() }
            replyHandler(["cancelled":true,"message":"Stop requested. Inspect any operation already sent before retrying."],nil);return
        }
        if op=="codingSkills", Set(body.keys)==["op","input"], let input=body["input"] as? [String:Any], Set(input.keys)==["action"], input["action"] as? String=="clear" {
            codingSkills.invalidate(); replyHandler(["cleared":true],nil); return
        }
        if op=="codingFilePreview", Set(body.keys)==["op","input"], let input=body["input"] as? [String:Any], Set(input.keys)==["action"], input["action"] as? String=="clear" {
            codingFilePreview.invalidate(); replyHandler(["cleared":true],nil); return
        }
        guard !recoveryStartup || RecoveryStartupPolicy.allows(body) else {replyHandler(nil,RecoveryStartupPolicy.message);return}
        let terminalInput=op=="coding" ? body["input"] as? [String:Any]:nil
        let terminalAction=terminalInput.flatMap(CodingTerminalPolicy.action)
        let processId=terminalInput?["processId"] as? String
        let interactiveControl=["terminalInput","terminalResize"].contains(terminalAction ?? "") && processId.map{codingInteractive.allows($0,token:codingInteractive.entries[$0]?.token)}==true
        let control=CodingControlPolicy.allows(body) || interactiveControl
        guard control || !busy && scopedStops.isEmpty && uncertainScopedStops.isEmpty else { replyHandler(nil,scopedStops.isEmpty && uncertainScopedStops.isEmpty ? "Another native tool is still pending.":"Cancellation is pending or unconfirmed. Retry Stop and inspect its result before starting new work.");return }
        let scopedStop=beginScopedStop(body)
        let queueOperation: CodingQueueSession.Operation?
        if op=="codingQueue" {
            guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any] else{replyHandler(nil,CodingQueuePolicy.Failure().localizedDescription);return}
            do{queueOperation=try codingQueue.begin(input)}catch{replyHandler(nil,error.localizedDescription);return}
            if input["action"] as? String=="pause",queueAlertRoot==input["threadId"] as? String,let alert,let parent=alert.window.sheetParent {parent.endSheet(alert.window,returnCode:.abort)}
        }else{queueOperation=nil}
        if op=="codingGit",control,let input=body["input"] as? [String:Any],input["action"] as? String=="stop",scopedStop==nil {replyHandler(["cancelled":true,"message":"The earlier Git request is no longer active."],nil);return}
        let setupOperation: CodingMCPSetupSession.Operation?
        if op=="codingMCP" {
            guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any] else {replyHandler(nil,CodingMCPSetupPolicy.Failure().localizedDescription);return}
            do { setupOperation=try codingSetup.begin(input) }
            catch {replyHandler(nil,CodingMCPSetupPolicy.Failure().localizedDescription);return}
            // begin() revoked this setup synchronously, before authentication or
            // cancellation transport can wait. Only its own sheet is dismissed.
            if setupOperation?.action=="cancelSetup",let id=setupOperation?.setupId,setupAlertID==id {
                if let alert,let parent=alert.window.sheetParent {parent.endSheet(alert.window,returnCode:.abort)}
                alert=nil;setupAlertID=nil
            }
            if setupOperation?.action=="cancelSetup",let id=setupOperation?.setupId {provisioning.finishSetup(id)}
        } else {setupOperation=nil}
        if !control { busy=true }; let expected=epoch, skillGeneration=codingSkills.token
        let previewGeneration=op=="codingFilePreview" ? codingFilePreview.begin():codingFilePreview.token
        let providerBindingToken:UUID?
        if op=="codingBindProvider",Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],Set(input.keys)==["threadId"],let id=try? CodingMCPSetupPolicy.identifier(input["threadId"],limit:160) {
            let token=UUID();providerBinding=(id,token);providerBindingToken=token
        }else{providerBindingToken=nil}
        if op=="coding",let input=terminalInput,CodingControlPolicy.allows(body) {
            if input["action"] as? String=="terminalStop",let processId { codingInteractive.revoke(processId) }
            if ["interrupt","interruptFamily"].contains(input["action"] as? String ?? "") {
                codingInteractive.revoke(); codingSkills.invalidate(); codingFilePreview.invalidate()
                // Child Stop can name a member rather than its owner root. Revoke
                // native preparations before awaiting that backend lookup.
                codingQueue.invalidate()
                if queueAlertRoot != nil,let alert,let parent=alert.window.sheetParent {parent.endSheet(alert.window,returnCode:.abort)}
            }
            if input["action"] as? String=="interruptFamily",let pending=providerBinding,pending.threadId==input["threadId"] as? String {
                providerBinding=nil
                if providerBindingAlert==pending.token {if let alert,let parent=alert.window.sheetParent{parent.endSheet(alert.window,returnCode:.abort)};alert=nil;providerBindingAlert=nil}
            }
        }
        let terminalToken:UUID?
        if terminalAction=="terminalAttach",let processId { terminalToken=codingInteractive.begin(processId) }
        else { terminalToken=processId.flatMap{codingInteractive.entries[$0]?.token} }
        let terminalStartEpoch=codingInteractive.startEpoch
        if op=="codingWorktrees",Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],let action=CodingWorktreePolicy.action(input),["reconnect","create","archive","restore","handoff","recoverHandoff","recoverCopy"].contains(action) { worktreeEpoch=UUID() }
        let worktreeGeneration=worktreeEpoch
        if op=="codingSchedules",Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],let action=CodingSchedulePolicy.action(input),["save","resume","run","delete","recover"].contains(action) { scheduleEpoch=UUID() }
        let scheduleGeneration=scheduleEpoch
        if op=="codingGit",Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],let action=CodingGitPolicy.action(input),!["inspect","stop"].contains(action) { gitEpoch=UUID();gitRequest=input["requestId"] as? String }
        let gitGeneration=gitEpoch
        Task {
            defer { if let scopedStop {scopedStops[scopedStop.id]=nil}; if let queueOperation{codingQueue.finish(queueOperation)}; if let setupOperation {codingSetup.abandon(setupOperation)};if let token=providerBindingToken,providerBinding?.token==token{providerBinding=nil;providerBindingAlert=nil}; if !control { busy=false } }
            do {
                guard await authenticate?() == true else { throw ComputerError.message("The app-owned server is unavailable.") }; try require(expected)
                let result: [String:Any]
                switch op {
                case "codingQueue":
                    guard let queueOperation else{throw CodingQueuePolicy.Failure()}
                    result=try await codingQueue.perform(queueOperation,check:{try self.require(expected)},
                        request:{try await self.request("codingQueue",$0)},
                        grant:{scope,model in
                            self.queueAlertRoot=queueOperation.threadId
                            defer{self.queueAlertRoot=nil}
                            let accepted=try await self.reviewCodingProject(scope,expected:expected,model:model)
                            try self.codingQueue.check(queueOperation);try self.require(expected)
                            if accepted{self.codingGrants.insert(scope.key)}
                            return accepted
                        })
                case "codingFilePreview":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any] else {throw ComputerError.message("Invalid file preview request.")}
                    let snapshot=try await codingFilePreview.inspect(input,expected:previewGeneration) { id in
                        try self.require(expected)
                        let value=try await self.request("coding",["action":"read","threadId":id])
                        try self.require(expected);return value
                    }
                    try require(expected)
                    guard let owner=webView?.window else {throw ComputerError.message("The task window is unavailable.")}
                    try codingFilePreview.present(snapshot,expected:previewGeneration,owner:owner)
                    result=snapshot.metadata
                case "codingSkills":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any] else { throw ComputerError.message("Invalid task skill request.") }
                    result=try await codingSkills.perform(input,expected:skillGeneration) { id in
                        try self.require(expected)
                        let value=try await self.request("coding",["action":"read","threadId":id])
                        try self.require(expected); return value
                    }
                case "projectSkills":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any] else {throw ComputerError.message("Invalid project skill request.")}
                    result=try await performProjectSkills(input,expected:expected)
                case "fetchPlugin":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any] else {throw ComputerError.message("Invalid fixed Fetch request.")}
                    result=try await performFetchPlugin(input,expected:expected)
                case "projectSkillsChoose":
                    guard Set(body.keys)==["op"] else {throw ComputerError.message("Invalid project choice.")}
                    let admitted=try await request("projectSkills",["action":"catalog"]);try require(expected)
                    guard admitted["admitted"] as? Bool==true else {throw ComputerError.message(admitted["message"] as? String ?? "Project skill access is held.")}
                    let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false
                    panel.message="Choose the project where these three fixed skills may be installed. Existing skill files are retained."
                    guard panel.runModal() == .OK,let folder=panel.url else {result=["cancelled":true,"message":"Project choice cancelled."];break}
                    try require(expected);result=try await projectSkills.choose(folder.path);try require(expected)
                case "codingMCP":
                    guard let setupOperation else {throw CodingMCPSetupPolicy.Failure()}
                    result=try await codingSetup.perform(setupOperation,
                        check:{try self.require(expected)},
                        request:{input in try await self.request("codingMCP",input)},
                        ask:{id,detail in try await self.approve("Create Coding task with MCP?",detail:detail,button:"Create once",expected:expected,operational:true,setupId:id)},
                        grantProject:{scope in try self.require(expected);self.codingGrants.insert(scope.key)})
                case "codingChooseFolder": result=try chooseCodingFolder(expected:expected)
                case "codingConfigureProvider": result=try await configureCodingProvider(expected:expected)
                case "codingBindProvider":
                    guard let token=providerBindingToken,let input=body["input"] as? [String:Any] else{throw ComputerError.message("Invalid cloud connection request.")}
                    result=try await bindCodingProvider(input,expected:expected,token:token)
                case "codingRecovery":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],Set(input.keys)==["model"],let model=input["model"] as? String,!model.isEmpty,model.utf8.count<=200,!model.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}) else {throw ComputerError.message("Choose a valid local model for the new chat.")}
                    result=try await failedStartupRecovery(model:model,expected:expected)
                case "codingStorage":
                    guard Set(body.keys)==["op","input"],var input=body["input"] as? [String:Any] else{throw CodingDiskReclamation.Failure()}
                    if Set(input.keys)==["failed"],let flag=input["failed"] as? NSNumber,CFGetTypeID(flag)==CFBooleanGetTypeID(),flag.boolValue {
                        try require(expected);let listed=try await signedRequest("codingStorage",["action":"listFailed"],timeout:30);try require(expected)
                        guard Set(listed.keys)==["candidates"],let candidates=listed["candidates"] as? [[String:Any]],candidates.count<=128,candidates.allSatisfy({Set($0.keys)==["ownerId","generation","cwd"] && CodingDiskReclamation.uuid($0["ownerId"]) != nil && CodingDiskReclamation.uuid($0["generation"]) != nil && CodingDiskReclamation.path($0["cwd"]) != nil}) else{throw CodingDiskReclamation.Failure()}
                        guard !candidates.isEmpty else{replyHandler(["message":"No closed failed-startup storage is available for review."],nil);return}
                        let picker=NSPopUpButton(frame:NSRect(x:0,y:0,width:620,height:30));picker.addItems(withTitles:candidates.map{"\($0["cwd"]!) · \($0["ownerId"]!) · \($0["generation"]!)"})
                        guard try await approve("Review failed-startup storage?",detail:"Choose one exact failed startup. This only opens a fresh inspection. A separate confirmation describes whether an empty reservation can be released or a guest disk can be discarded. Other retained workspaces are not selected.",button:"Inspect selected startup",expected:expected,accessory:picker) else{replyHandler(["cancelled":true,"message":"Storage retained."],nil);return}
                        try require(expected);guard candidates.indices.contains(picker.indexOfSelectedItem) else{throw CodingDiskReclamation.Failure()};let selected=candidates[picker.indexOfSelectedItem];input=["ownerId":selected["ownerId"]!,"generation":selected["generation"]!]
                    }
                    let failedReview=input["ownerId"] != nil
                    result=try await CodingDiskReclamation.perform(input,check:{try self.require(expected)},
                        request:{try await self.signedRequest("codingStorage",$0,timeout:failedReview || $0["action"] as? String == "execute" ? 30:5)},
                        ask:{try await self.approve($0.title,detail:$0.detail,button:$0.button,expected:expected)})
                case "codingGit":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],CodingGitPolicy.action(input) != nil else { throw ComputerError.message("Invalid Git request.") }
                    result=try await gitWorkflow(input,expected:expected,generation:gitGeneration,stopTicket:scopedStop)
                case "codingSchedules":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],CodingSchedulePolicy.action(input) != nil else { throw ComputerError.message("Invalid scheduled-work request.") }
                    result=try await schedules(input,expected:expected,generation:scheduleGeneration,stopTicket:scopedStop)
                case "codingWorktrees":
                    guard Set(body.keys)==["op","input"],let input=body["input"] as? [String:Any],CodingWorktreePolicy.action(input) != nil else { throw ComputerError.message("Invalid worktree request.") }
                    result=try await worktrees(input,expected:expected,generation:worktreeGeneration,stopTicket:scopedStop)
                case "coding":
                    guard Set(body.keys)==["op","input"], let input=body["input"] as? [String:Any], try JSONSerialization.data(withJSONObject:input,options:[.withoutEscapingSlashes]).count<=(["send","steer"].contains(input["action"] as? String ?? "") ? 4*1024*1024:80000) else { throw ComputerError.message("Invalid coding request.") }
                    result=try await coding(input,expected:expected,terminalToken:terminalToken,terminalStartEpoch:terminalStartEpoch)
                case "describe": result=try await request("describe",[:])
                case "catalog":
                    guard Set(body.keys).isSubset(of:["op","query","offset"]) else { throw ComputerError.message("Invalid catalog request.") }
                    var input=body; input.removeValue(forKey:"op"); result=try await request("catalog",input)
                case "connect":
                    guard let id=body["id"] as? String else { throw ComputerError.message("Missing server.") }; result=try await connect(id,expected:expected)
                case "disconnect": guard let id=body["id"] as? String else { throw ComputerError.message("Missing server.") }; routineReads[id]=nil; result=try await request("disconnect",["id":id])
                case "addFilesystem", "addBrowser", "editConfig": result=try await configure(op,expected:expected)
                case "agentStep":
                    guard Set(body.keys)==["op","runId","stepId"],let run=NativeAgentStep.uuid(body["runId"]),let step=NativeAgentStep.uuid(body["stepId"]),agentStepTask==nil,agentStepSettlementError==nil else{throw ComputerError.message("Invalid or unsettled native Agent step.")}
                    let id=UUID(),task=Task {try await self.performAgentStep(run:run,step:step,expected:expected)}
                    agentStepTaskID=id;agentStepTask=task
                    defer {if agentStepTaskID==id {agentStepTask=nil;agentStepTaskID=nil}}
                    result=try await task.value
                case "execute":
                    guard Set(body.keys)==["op","name","arguments"],let name=body["name"] as? String,let arguments=body["arguments"] as? [String:Any],JSONSerialization.isValidJSONObject(arguments),try JSONSerialization.data(withJSONObject:arguments).count<=64000 else{throw ComputerError.message("Invalid tool request.")}
                    result=try await execute(name,arguments:arguments,expected:expected)
                default: throw ComputerError.message("Unknown native operation.")
                }
                try require(expected); replyHandler(result,nil)
            } catch { replyHandler(nil,op=="codingMCP" ? CodingMCPSetupPolicy.Failure().localizedDescription:error.localizedDescription) }
        }
    }
    private func execute(_ name:String,arguments:[String:Any],expected:UUID,beforeEffect:(() async throws -> Void)?=nil,agentClaim:(() -> [String:Any]?)?=nil) async throws -> [String:Any] {
        try require(expected)
        func dispatch(_ operation:String,_ input:[String:Any]) async throws -> [String:Any] {
            var value=input;if let claim=agentClaim?() {value["agentClaim"]=claim}
            return try await self.request(operation,value)
        }
        if name.hasPrefix("computer_") {return try await computer.agentTool(name,arguments:arguments,beforeEffect:beforeEffect)}
        if name=="project_skills" {return try await performProjectSkills(arguments,expected:expected,beforeEffect:beforeEffect,agentClaim:agentClaim)}
        if name=="fetch_plugin" {return try await performFetchPlugin(arguments,expected:expected,beforeEffect:beforeEffect,agentClaim:agentClaim)}
        if name=="call_contact" {guard Set(arguments.keys)==["name"],let contact=arguments["name"] as? String else{throw ComputerError.message("A contact name is required.")};return try await call(contact,expected:expected,beforeEffect:beforeEffect)}
        if name=="connect_tool_server" {guard Set(arguments.keys)==["server"],let id=arguments["server"] as? String else{throw ComputerError.message("Invalid server request.")};return try await connect(id,expected:expected,beforeEffect:beforeEffect,agentClaim:agentClaim)}
        if name=="list_tools" {guard arguments.isEmpty else{throw ComputerError.message("Invalid catalog request.")};try await beforeEffect?();try require(expected);return try await dispatch("catalog",[:])}
        if name=="search_tools" {guard Set(arguments.keys).isSubset(of:["query","offset"]),arguments["query"] is String else{throw ComputerError.message("Invalid search.")};try await beforeEffect?();try require(expected);return try await dispatch("search",arguments)}
        if name=="run_command" {
            guard Set(arguments.keys)==["command","cwd"],let command=arguments["command"] as? String,let cwd=arguments["cwd"] as? String,command.count<=16000 else{throw ComputerError.message("Invalid command.")}
            guard try await approve("Run this command?",detail:"Working directory: \(cwd)\n\n\(command)\n\nRuns as your Mac user. The working directory is NOT a security sandbox; the command can access other files and the network. Maximum runtime: 60 seconds. Review all operations, including redirections and scripts.",button:"Run once",expected:expected,operational:true) else{return ["cancelled":true,"message":"Command cancelled. Nothing was started."]}
            try await beforeEffect?();try require(expected);return try await dispatch("command",arguments)
        }
        if name=="execute_tool" {
            guard Set(arguments.keys)==["server","name","arguments"],let server=arguments["server"] as? String,let tool=arguments["name"] as? String,let input=arguments["arguments"] as? [String:Any] else{throw ComputerError.message("Invalid MCP tool call.")}
            if beforeEffect==nil,let grant=routineReads[server],let admitted=RoutineReadPolicy.automaticArguments(grant.kind,name:tool,arguments:input) {
                try await beforeEffect?();try require(expected)
                guard let current=routineReads[server],current.kind==grant.kind,current.hash==grant.hash,
                      let checked=RoutineReadPolicy.automaticArguments(current.kind,name:tool,arguments:input),NSDictionary(dictionary:checked).isEqual(to:admitted) else{throw ComputerError.message("Routine read permission changed before dispatch.")}
                var read=arguments;read["arguments"]=admitted;read["readOnlyConfigHash"]=grant.hash
                return try await dispatch("call",read)
            }
            let data=try JSONSerialization.data(withJSONObject:arguments,options:[.prettyPrinted,.sortedKeys])
            guard try await approve("Run this tool once?",detail:String(decoding:data,as:UTF8.self),button:"Run once",expected:expected,operational:true) else{return ["cancelled":true,"message":"Tool cancelled. Nothing was sent."]}
            try await beforeEffect?();try require(expected);return try await dispatch("call",arguments)
        }
        throw ComputerError.message("Unknown tool.")
    }
    private func performFetchPlugin(_ input:[String:Any],expected:UUID,beforeEffect:(() async throws -> Void)?=nil,agentClaim:(() -> [String:Any]?)?=nil) async throws -> [String:Any] {
        let request=try FetchPluginRequest.parse(input);try require(expected)
        if request.action != "catalog" {
            let detail=request.action=="install" ? "Install the fixed free Fetch 2026.10.24 runtime for Agent tools. It requires the existing qualified Python 3.14.8. Existing MCP configuration is retained. Connect explicitly after enabling.":request.enabled==true ? "Enable the installed fixed Fetch entry for Agent tools. This does not connect it.":"Disable Fetch for Agent tools and close only its owned connection. Other tool connections are retained."
            guard try await approve("\(request.action=="install" ? "Install Fetch":request.enabled==true ? "Enable Fetch":"Disable Fetch")?",detail:detail,button:"Continue once",expected:expected,operational:true) else {return ["cancelled":true,"message":"Fetch operation cancelled. Inspect its catalog before another task."]}
        }
        try await beforeEffect?();try require(expected)
        var body=input;if let claim=agentClaim?(){body["agentClaim"]=claim}
        let admitted=try await self.request("fetchPlugin",body);try require(expected)
        if admitted["isError"] as? Bool==true {return admitted}
        guard Set(admitted.keys)==["admitted","connectionHeld"],let flag=admitted["admitted"] as? NSNumber,CFGetTypeID(flag)==CFBooleanGetTypeID(),flag.boolValue,
              let held=admitted["connectionHeld"] as? NSNumber,CFGetTypeID(held)==CFBooleanGetTypeID() else {throw ComputerError.message("Fetch admission was not confirmed. Inspect its state before retrying.")}
        let parent=try runtimePaths.get().dataDir.deletingLastPathComponent()
        var result=try await fetchPlugin.perform(input,parent:parent,resources:Bundle.main.resourceURL);try require(expected)
        // The installer cannot observe the MCP hub's live connection state.
        result.removeValue(forKey:"connected");result.removeValue(forKey:"needsConnect")
        result["connectionHeld"]=held.boolValue;result["toolMode"]="Agent tools";return result
    }
    private func performProjectSkills(_ input:[String:Any],expected:UUID,beforeEffect:(() async throws -> Void)?=nil,agentClaim:(() -> [String:Any]?)?=nil) async throws -> [String:Any] {
        let request=try ProjectSkillRequest.parse(input);try require(expected)
        if request.action=="install" {
            guard let scope=projectSkills.scopeView,scope["scopeId"] as? String==request.scopeId,
                  let entry=try ProjectSkillCatalog.entries().first(where:{$0.id==request.id}) else {throw ComputerError.message("Select this project's current skill scope in Tools first.")}
            let detail="Project: \(scope["project"]!)\nSkill: \(entry.id)\nSHA256: \(entry.sha256)\n\nCreates one new .agents/skills/\(entry.id) directory with its text and receipt. Existing targets are retained. No executable, dependency or MCP configuration is installed."
            guard try await approve("Install this project skill?",detail:detail,button:"Install once",expected:expected,operational:true) else {return ["cancelled":true,"message":"Skill installation cancelled. No files were written."]}
        }
        try await beforeEffect?();try require(expected)
        var body=input;if let claim=agentClaim?(){body["agentClaim"]=claim}
        let admitted=try await self.request("projectSkills",body);try require(expected)
        if admitted["isError"] as? Bool==true {return admitted}
        guard Set(admitted.keys)==["admitted"],let flag=admitted["admitted"] as? NSNumber,CFGetTypeID(flag)==CFBooleanGetTypeID(),flag.boolValue else {throw ComputerError.message("Project skill admission was not confirmed. Nothing was installed.")}
        let result=try await projectSkills.perform(input);try require(expected);return result
    }
    private func performAgentStep(run:String,step:String,expected:UUID) async throws -> [String:Any] {
        try require(expected)
        let inspection=try await signedRequest("agentStep",["action":"inspect","runId":run,"stepId":step]);try require(expected)
        try NativeAgentStep.inspect(inspection,run:run,step:step)
        let digest=inspection["stepDigest"] as! String,generation=inspection["generation"] as! String
        let selectors:[String:Any]=["runId":run,"stepId":step,"stepDigest":digest,"generation":generation]
        var claimID:String?,dispatchAdmitted=false
        func decline() async throws -> [String:Any] {
            var input=selectors;input["action"]="decline"
            let value=try await self.signedRequest("agentStep",input);try NativeAgentStep.decline(value,run:run,step:step);return value
        }
        func complete(_ outcome:[String:Any],status:String) async throws -> [String:Any] {
            guard let claimID else{throw ComputerError.message("Agent claim identity is unavailable.")}
            let input:[String:Any]=["action":"complete","runId":run,"stepId":step,"claimId":claimID,"outcome":outcome]
            guard try JSONSerialization.data(withJSONObject:input,options:[.sortedKeys]).count<=4_000_000 else{throw ComputerError.message("Native result exceeds the durable completion transport limit.")}
            let value=try await self.signedRequest("agentStep",input)
            try NativeAgentStep.completion(value,run:run,step:step,claim:claimID,kind:outcome["kind"] as! String,status:status);return value
        }
        let result:[String:Any]
        do {
            result=try await execute(inspection["name"] as! String,arguments:inspection["arguments"] as! [String:Any],expected:expected,beforeEffect:{
                try self.require(expected)
                guard claimID==nil else{throw ComputerError.message("Agent step dispatch was already claimed; no retry was made.")}
                let id=UUID().uuidString.lowercased();claimID=id
                var input=selectors;input["action"]="claim";input["claimId"]=id
                let claimed=try await self.signedRequest("agentStep",input)
                try NativeAgentStep.claim(claimed,inspection:inspection,id:id)
                try self.require(expected);dispatchAdmitted=true
            },agentClaim:{claimID.map{["runId":run,"stepId":step,"claimId":$0]}})
        } catch {
            guard claimID != nil else{throw error} // Departure before claim leaves the review pending.
            let kind=dispatchAdmitted ? "unconfirmed":"not-started"
            do {_ = try await complete(["kind":kind,"message":NativeAgentStep.message(error)],status:dispatchAdmitted ? "unconfirmed":"cancelled")}
            catch let completionError {
                if !dispatchAdmitted {
                    var declined=false
                    do {_ = try await decline();declined=true} catch {}
                    if declined {throw error}
                }
                agentStepSettlementError=NativeAgentStep.message(completionError)
                throw ComputerError.message("Agent result is unconfirmed and retained. "+agentStepSettlementError!)
            }
            throw error
        }
        if claimID==nil {
            try require(expected)
            guard result["cancelled"] as? Bool==true else{throw ComputerError.message("Native Agent tool returned without a dispatch claim.")}
            _ = try await decline();return result
        }
        let fits=JSONSerialization.isValidJSONObject(result) && ((try? JSONSerialization.data(withJSONObject:result).count) ?? Int.max)<=3_900_000
        let status=fits ? (result["cancelled"] as? Bool==true ? "cancelled":result["isError"] as? Bool==true ? "error":"returned") : "unconfirmed"
        let outcome:[String:Any]=fits ? ["kind":"returned","result":result] : ["kind":"unconfirmed","message":"Native result exceeded the durable receipt limit. The action was not retried."]
        do {_ = try await complete(outcome,status:status)}
        catch {
            agentStepSettlementError=NativeAgentStep.message(error)
            throw ComputerError.message("Agent result is unconfirmed and retained. "+agentStepSettlementError!)
        }
        if !fits {throw ComputerError.message("Native result exceeded the durable receipt limit; inspect the retained action.")}
        return result
    }
    private func chooseCodingFolder(expected:UUID) throws -> [String:Any] {
        let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false
        panel.message="Choose a project for coding. You will review access before the first task."
        guard panel.runModal() == .OK, let url=panel.url else { return ["cancelled":true] }
        try require(expected);return ["cwd":url.resolvingSymlinksInPath().standardizedFileURL.path]
    }
    private func reviewCodingProject(_ scope:CodingProjectGrant.Scope,expected:UUID,model:String?=nil) async throws -> Bool {
        try require(expected)
        if codingGrants.contains(scope.key){return true}
        let cloud=scope.provider=="cloud" ? "\nThis chat uses your configured cloud provider. Its conversation, project context and tool outputs are sent to that provider and may incur charges." : "\nInference uses this chat's selected local model."
        let execution=scope.executionMode=="native" ? "Native macOS: works directly without a guest disk; file and network access follow the selected tool access mode." : "Virtual machine: uses a separate guest system and reserved storage."
        let selected=model.map{"\nModel: "+$0} ?? ""
        return try await approve("Work in this coding project?",detail:"Project: \(scope.folder)\nExecution: \(execution)"+selected+"\n\nThe agent can read local files and run commands in the coding sandbox. File writes are limited to this project; requests for additional write or network access appear separately. Shell temporary files use a private .saleh-coding-tmp-* folder here, shared by this project's tasks. It may appear in Git. The app preserves this folder after engine exit because detached programs may still use it. Tasks can delegate to child agents using the same model and project access. Accepted tasks and queued follow-ups can continue when you leave this page. Stop chat pauses pending follow-ups and interrupts that chat, its child agents and tracked command sessions. Detached programs may continue. Stop does not undo edits. Review changes before using them."+cloud,button:"Use project",expected:expected,operational:true)
    }
    private func failedStartupRecovery(model:String,expected:UUID) async throws -> [String:Any] {
        func fail() -> ComputerError {ComputerError.message("The failed startup recovery response could not be verified. Retain output for inspection; no retry was made.")}
        func exchange(_ input:[String:Any]) async throws -> [String:Any] {try require(expected);let value=try await signedRequest("codingRecovery",input,timeout:120);try require(expected);return value}
        func threadID(_ value:Any?) -> String? {guard let value=value as? String,!value.isEmpty,value.utf8.count<=160,value.range(of:"^[A-Za-z0-9_.-]+$",options:.regularExpression) != nil else{return nil};return value}
        let parent=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Qwen Local/Recovered Projects").path
        func target(_ value:Any?,_ id:String) -> String? {guard let path=CodingDiskReclamation.path(value),path==parent+"/"+id+"/project" else{return nil};return path}
        let listed=try await exchange(["action":"list"])
        guard Set(listed.keys)==["candidates"],let candidates=listed["candidates"] as? [[String:Any]],candidates.count<=256 else{throw fail()}
        for candidate in candidates {
            guard Set(candidate.keys)==["ownerId","generation","cwd","continuations"],CodingDiskReclamation.uuid(candidate["ownerId"]) != nil,CodingDiskReclamation.uuid(candidate["generation"]) != nil,CodingDiskReclamation.path(candidate["cwd"]) != nil,let copies=candidate["continuations"] as? [[String:Any]],copies.count<=256 else{throw fail()}
            for copy in copies {
                guard Set(copy.keys)==["id","target","model","state","threadId"],let id=CodingDiskReclamation.uuid(copy["id"]),target(copy["target"],id) != nil,let savedModel=copy["model"] as? String,!savedModel.isEmpty,savedModel.utf8.count<=200,let state=copy["state"] as? String,["incomplete","verified-copy","copy-needs-inspection","copy-changed","opening-unknown","opened"].contains(state),state=="opened" ? threadID(copy["threadId"]) != nil:copy["threadId"] is NSNull else{throw fail()}
            }
        }
        guard !candidates.isEmpty else{return ["message":"No verified closed failed startups are available for continuation."]}
        let picker=NSPopUpButton(frame:NSRect(x:0,y:0,width:620,height:30))
        picker.addItems(withTitles:candidates.map{value in let copies=value["continuations"] as! [[String:Any]],state=copies.first(where:{["opened","opening-unknown","verified-copy","copy-needs-inspection","copy-changed"].contains($0["state"] as? String ?? "")})?["state"] as? String ?? (copies.isEmpty ? "failed original":"prepared output retained");return "\(value["cwd"]!) · \(state) · \(value["ownerId"]!)"})
        guard try await approve("Failed task startups",detail:"Choose the exact failed startup to inspect. Its owner, original project and stored history remain protected. A continuation uses an independent project copy and a fresh native chat; it does not restart the failed VM.",button:"Review selected startup",expected:expected,accessory:picker) else{return ["cancelled":true,"message":"Existing chats, drafts and projects are kept."]}
        try require(expected);guard candidates.indices.contains(picker.indexOfSelectedItem) else{throw fail()}
        let selected=candidates[picker.indexOfSelectedItem],owner=selected["ownerId"] as! String,generation=selected["generation"] as! String,source=selected["cwd"] as! String,copies=selected["continuations"] as! [[String:Any]]
        let completed=copies.filter{["opened","opening-unknown","verified-copy","copy-needs-inspection","copy-changed"].contains($0["state"] as? String ?? "")}
        guard completed.count<=1 else{throw fail()}
        if let copy=completed.first,copy["state"] as? String=="opened" {
            guard let id=threadID(copy["threadId"]),try await approve("Open existing continuation?",detail:"Original failed project: \(source)\n\nIndependent project: \(copy["target"]!)\n\nThe saved native chat is already openable. No additional chat or prompt will be created.",button:"Show saved chat",expected:expected) else{return ["cancelled":true]}
            try require(expected);return ["existingThreadId":id,"message":"Showing the saved native continuation; the original startup remains failed."]
        }
        if completed.first?["state"] as? String=="opening-unknown" {return ["message":"Opening the previous continuation is unconfirmed. Inspect saved Tasks history before another action. No duplicate chat was created. Project copy: \(completed.first!["target"]!)"]}
        if completed.first?["state"] as? String=="copy-needs-inspection" {return ["message":"Copy completion was recorded, but verification required to open a continuation did not finish. Inspect the retained project: \(completed.first!["target"]!)"]}
        if completed.first?["state"] as? String=="copy-changed" {return ["message":"The retained project copy changed since verification. No new chat was opened or copy replaced. Inspect this project: \(completed.first!["target"]!)"]}
        var copyID:String,newTarget:String
        if let copy=completed.first {
            guard copy["model"] as? String==model,let id=CodingDiskReclamation.uuid(copy["id"]),let path=target(copy["target"],id) else{throw fail()};copyID=id;newTarget=path
        } else {
            let prepared=try await exchange(["action":"prepare","ownerId":owner,"generation":generation,"model":model])
            guard Set(prepared.keys)==["plan"],let plan=prepared["plan"] as? [String:Any],Set(plan.keys)==["id","operation","ownerId","generation","model","source","target","head","indexTree","files","bytes","omittedCount","expiresAt"],let id=CodingDiskReclamation.uuid(plan["id"]),let path=target(plan["target"],id),plan["operation"] as? String=="failed-startup-copy",plan["ownerId"] as? String==owner,plan["generation"] as? String==generation,plan["source"] as? String==source,plan["model"] as? String==model else{throw fail()}
            func integer(_ value:Any?,_ maximum:Double) -> Double? {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID() else{return nil};let d=n.doubleValue;return d.isFinite && d>=0 && d<=maximum && d.rounded(.towardZero)==d ? d:nil}
            guard integer(plan["files"],20000) != nil,integer(plan["bytes"],134217728) != nil,integer(plan["omittedCount"],0)==0,let expiry=integer(plan["expiresAt"],9_007_199_254_740_991),expiry>Date().timeIntervalSince1970*1000,expiry<=Date().timeIntervalSince1970*1000+120001,plan["head"] is NSNull || (plan["head"] as? String)?.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil,(plan["indexTree"] as? String)?.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil else{throw fail()}
            guard try await approve("Continue in a new project copy?",detail:"Original project: \(source)\nOwner: \(owner)\nGeneration: \(generation)\n\nNew project: \(path)\n\(plan["files"]!) entries · \(plan["bytes"]!) bytes · no omitted files\n\nPreserves HEAD, staging contents, working, ignored and untracked files plus supported native metadata. Original files, owners and VM receipts stay unchanged. Stop retains partial output for inspection. No model prompt is sent.",button:"Create verified copy",expected:expected) else{_ = try await exchange(["action":"cancel","id":id]);return ["cancelled":true,"message":"Copy review cancelled. Originals and any prepared output are retained."]}
            let result=try await exchange(["action":"create","id":id])
            guard Set(result.keys)==["copy"],let copy=result["copy"] as? [String:Any],Set(copy.keys)==Set(plan.keys).subtracting(["expiresAt"]).union(["receiptPath","independent","originalStartupRecovered"]),(copy["independent"] as? NSNumber).map({CFGetTypeID($0)==CFBooleanGetTypeID() && $0.boolValue})==true,(copy["originalStartupRecovered"] as? NSNumber).map({CFGetTypeID($0)==CFBooleanGetTypeID() && !$0.boolValue})==true,copy["receiptPath"] as? String==parent+"/"+id+"/receipt.json" else{throw fail()}
            for (key,value) in plan where key != "expiresAt" {guard let actual=copy[key],NSDictionary(dictionary:[key:actual]).isEqual(to:[key:value]) else{throw fail()}}
            copyID=id;newTarget=path
        }
        guard try await approve("Open a new native chat?",detail:"Verified independent project: \(newTarget)\n\nLocal model: \(model)\n\nOpens one fresh native chat using the current access setting. Your existing chats and unsent drafts stay saved. The failed VM and original project remain retained. No prompt is sent. An uncertain result will not be retried automatically.",button:"Open new native chat",expected:expected) else{return ["cancelled":true,"message":"Verified project copy kept. Open it from Failed task startups when ready."]}
        let result=try await exchange(["action":"open","ownerId":owner,"generation":generation,"model":model,"id":copyID])
        guard result["copyId"] as? String==copyID,let thread=result["thread"] as? [String:Any],threadID(thread["id"]) != nil,thread["cwd"] as? String==newTarget,thread["model"] as? String==model,thread["modelProvider"] as? String=="saleh_local",result["executionMode"] as? String=="native" else{throw fail()}
        return result
    }
    private func coding(_ input:[String:Any], expected:UUID, terminalToken:UUID?=nil, terminalStartEpoch:UUID?=nil) async throws -> [String:Any] {
        guard let action=input["action"] as? String else { throw ComputerError.message("Missing coding operation.") }
        // Setup is exclusively native; a webpage cannot submit credentials or alter provider config.
        guard !["reloadProviders","configureProvider","providerBindingInfo","bindProvider"].contains(action) else { throw ComputerError.message("Use native provider setup.") }
        if ["terminalAttach","terminalSnapshot","terminalInput","terminalResize"].contains(action) {
            guard CodingTerminalPolicy.action(input)==action,let id=input["processId"] as? String else { throw ComputerError.message("Invalid interactive terminal request.") }
            if action=="terminalSnapshot" {
                var result=try await request("coding",input);try require(expected)
                if result["state"] as? String != "running",codingInteractive.entries[id] != nil { codingInteractive.revoke(id) }
                result["inputGranted"]=codingInteractive.allows(id,token:codingInteractive.entries[id]?.token);return result
            }
            if action=="terminalAttach" {
                guard let terminalToken,codingInteractive.entries[id]?.token==terminalToken else { throw ComputerError.message("Terminal access was revoked. Review the session again.") }
                let before=try await request("coding",["action":"terminalSnapshot","processId":id]);try require(expected)
                guard before["processId"] as? String==id,before["mode"] as? String=="pty",before["state"] as? String=="running",let folder=before["cwd"] as? String,folder.hasPrefix("/"),let thread=before["threadId"] as? String,codingInteractive.entries[id]?.token==terminalToken else { throw ComputerError.message("This terminal is no longer available for interaction.") }
                guard try await approve("Interact with this terminal?",detail:"Project: \(folder)\nSession: \(id)\n\nKeyboard input and paste can execute commands in this existing session. Local files can be read; writes are limited to this project. Network access is blocked. This grant lasts until Stop or page navigation. The process continues until Stop, exit or app quit. Reload preserves the screen and process but requires review again before typing. Stop cannot undo file changes.",button:"Allow this session",expected:expected,operational:true) else { codingInteractive.revoke(id);return ["cancelled":true] }
                var after=try await request("coding",["action":"terminalSnapshot","processId":id]);try require(expected)
                guard after["processId"] as? String==id,after["mode"] as? String=="pty",after["state"] as? String=="running",after["cwd"] as? String==folder,after["threadId"] as? String==thread,codingInteractive.allow(id,token:terminalToken,folder:folder,threadId:thread) else { throw ComputerError.message("The terminal changed or was stopped during review. No input was sent.") }
                after["inputGranted"]=true;return after
            }
            guard codingInteractive.allows(id,token:terminalToken) else { throw ComputerError.message("Review this terminal session before typing or resizing.") }
            try require(expected);return try await request("coding",input)
        }
        if action=="approval", input["decision"] as? String=="accept" {
            guard let id=input["id"] else { throw ComputerError.message("Missing approval.") }
            let pending=try await request("coding",["action":"approvalInfo","id":id]);try require(expected)
            if pending["method"] as? String=="item/tool/call" {
                guard let publicID=id as? String else { throw ComputerError.message("Invalid Coding MCP approval.") }
                let decision=try await CodingMCPReview.reviewDecision(pending,requestedID:publicID,
                    check:{ try self.require(expected) },
                    ask:{ detail in try await self.approve("Run this Coding MCP tool once?",detail:detail,button:"Run once",expected:expected,operational:true) },
                    readFresh:{ currentID in try await self.request("coding",["action":"approvalInfo","id":currentID]) })
                try require(expected)
                return try await request("coding",["action":"approval","id":publicID,"decision":decision.rawValue])
            }
            let detail=String(decoding:try JSONSerialization.data(withJSONObject:pending,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self)
            let accepted=try await approve("Approve this coding action once?",detail:detail,button:"Approve once",expected:expected,operational:true)
            return try await request("coding",["action":"approval","id":id,"decision":accepted ? "accept":"decline"])
        }
        if ["start","send","review","terminalStart","fork"].contains(action) {
            var cwd=input["cwd"] as? String, provider=input["provider"] as? String ?? "local"
            var executionMode=input["executionMode"] as? String ?? "vm"
            if action=="start", input["executionMode"] != nil, !(input["executionMode"] is String) { throw ComputerError.message("Invalid Coding execution mode.") }
            if action != "start" {
                guard let id=input["threadId"] as? String else { throw ComputerError.message("Choose a coding chat.") }
                let data=try await request("coding",["action":"read","threadId":id]);try require(expected)
                guard let thread=data["thread"] as? [String:Any] else { throw ComputerError.message("The coding chat is unavailable.") }
                cwd=thread["cwd"] as? String;provider=thread["modelProvider"] as? String == "saleh_cloud" ? "cloud":"local"
                executionMode=thread["executionMode"] as? String ?? "vm"
            }
            guard let cwd,cwd.hasPrefix("/") else { throw ComputerError.message("Choose a project folder.") }
            guard ["native","vm"].contains(executionMode) else { throw ComputerError.message("Invalid Coding execution mode.") }
            let scope=try CodingProjectGrant.scope(provider:provider,cwd:cwd,executionMode:executionMode)
            let folder=scope.folder,grant=scope.key
            guard try await reviewCodingProject(scope,expected:expected) else{return ["cancelled":true,"message":"Project access cancelled. No task started."]}
            codingGrants.insert(grant)
            if action=="terminalStart" {
                if input["mode"] != nil {
                    guard CodingTerminalPolicy.action(input)==action else { throw ComputerError.message("Invalid interactive terminal start.") }
                    guard try await approve("Open an interactive terminal?",detail:"Project: \(folder)\n\nStarts /bin/zsh -f -i without your shell startup files or history. Keyboard input and paste can execute commands in this one session. Local files can be read; writes are limited to this project. Network access is blocked. Temporary files use the project's private .saleh-coding-tmp-* folder. The shell runs until Stop, exit or app quit, including while this panel is hidden. Reload preserves its screen and process but requires review before typing again. Up to 500 scrollback lines are retained. Stop ends the tracked session; detached programs may continue. It does not undo changes.",button:"Open and allow typing",expected:expected,operational:true) else { return ["cancelled":true] }
                    guard terminalStartEpoch==codingInteractive.startEpoch else { throw ComputerError.message("Terminal start was revoked by Stop. Nothing was started.") }
                    var result=try await request("coding",input);try require(expected)
                    if let id=result["processId"] as? String {
                        codingTerminals[id]=folder
                        let snapshot=try await request("coding",["action":"terminalSnapshot","processId":id]);try require(expected)
                        if terminalStartEpoch==codingInteractive.startEpoch {
                            let live=snapshot["processId"] as? String==id && snapshot["mode"] as? String=="pty" && snapshot["state"] as? String=="running" && snapshot["cwd"] as? String==folder && snapshot["threadId"] as? String==input["threadId"] as? String
                            if live { let token=codingInteractive.begin(id);result["inputGranted"]=codingInteractive.allow(id,token:token,folder:folder,threadId:input["threadId"] as! String) }
                            else { result["inputGranted"]=false }
                        } else { result["inputGranted"]=false }
                    }
                    return result
                }
                guard let command=input["command"] as? String,command.count<=16000 else { throw ComputerError.message("Invalid terminal command.") }
                guard try await approve("Run this terminal command?",detail:"Project: \(folder)\n\n\(command)\n\nRuns for up to 10 minutes. Local files can be read; writes are limited to this project. Network access is blocked. Temporary files use this project's private .saleh-coding-tmp-* folder, which is preserved after engine exit. Stop command ends the tracked session; detached programs may continue. It does not undo file changes.",button:"Run once",expected:expected,operational:true) else { return ["cancelled":true] }
                let result=try await request("coding",input)
                if let process=result["processId"] as? String { codingTerminals[process]=folder }
                return result
            }
        }
        if action=="terminalWrite" {
            guard let id=input["processId"] as? String,let folder=codingTerminals[id],let text=input["text"] as? String,text.utf8.count<=16000 else { throw ComputerError.message("The terminal session is unavailable.") }
            guard try await approve("Send input to this terminal?",detail:"Project: \(folder)\n\n\(text)",button:"Send once",expected:expected,operational:true) else { return ["cancelled":true] }
        }
        try require(expected);return try await request("coding",input)
    }
    private func worktrees(_ input:[String:Any],expected:UUID,generation:UUID,stopTicket:ScopedStop?) async throws -> [String:Any] {
        guard let action=CodingWorktreePolicy.action(input) else { throw ComputerError.message("Invalid worktree request.") }
        if action=="stop" {
            guard generation==worktreeEpoch else { return ["cancelled":true,"message":"The earlier worktree request is no longer active."] }
            return try await requestScopedStop("worktrees",["action":"stop"],ticket:stopTicket)
        }
        if action=="list" { return try await request("worktrees",input) }
        if action=="open" {
            let resolved=try await request("worktrees",["action":"resolve","id":input["id"]!]);try require(expected)
            guard let worktree=resolved["worktree"] as? [String:Any],let cwd=worktree["cwd"] as? String else { throw ComputerError.message("The managed checkout could not be verified.") }
            var start:[String:Any]=["action":"start","cwd":cwd,"provider":input["provider"]!,"executionMode":input["executionMode"] as? String ?? "vm"]
            if let model=input["model"] { start["model"]=model }
            return try await coding(start,expected:expected)
        }
        guard generation==worktreeEpoch else { throw ComputerError.message("Worktree operation stopped. No retry was made.") }
        worktreeBusy=true;defer { worktreeBusy=false }
        if action=="recoverHandoff" {
            guard try await approve("Inspect this retained handoff?",detail:"Inspection opens retained Coding history and may permanently upgrade Coding storage, making it incompatible with Build80 and earlier. Cancel in the later review or Stop does not undo that format change; reopening Coding requires this version or a compatible newer version. Restoring or finishing the handoff requires a separate review of the exact prepared plan. No prompt is sent.",button:"Inspect recovery",expected:expected) else { return ["cancelled":true,"message":"Recovery inspection cancelled."] }
            try require(expected)
            guard generation==worktreeEpoch else { throw ComputerError.message("Worktree operation stopped. No retry was made.") }
        }
        do {
            var requestInput:[String:Any]=action=="reconnect" ? ["action":"prepareReconnect"] : action=="recoverCopy" ? ["action":"prepareRecoveryCopy","id":input["id"]!] : action=="recoverHandoff" ? ["action":"prepareHandoffRecovery","id":input["id"]!,"mode":input["mode"]!] : action=="handoff" ? ["action":"prepareHandoff","id":input["id"]!,"threadId":input["threadId"]!] : action=="create" ? ["action":"prepare","cwd":input["cwd"]!,"ref":input["ref"]!] : ["action":action=="archive" ? "prepareArchive":"prepareRestore","id":input["id"]!]
            if action=="create",let copy=input["copyChanges"] {requestInput["copyChanges"]=copy}
            let prepared=try await request("worktrees",requestInput);try require(expected)
            guard generation==worktreeEpoch else { throw ComputerError.message("Worktree operation stopped. No retry was made.") }
            guard let plan=prepared["plan"] as? [String:Any],let id=plan["id"] as? String,UUID(uuidString:id) != nil else { throw ComputerError.message("The worktree plan could not be verified.") }
            if action=="create",!CodingWorktreePolicy.creationPlan(plan,input:input) {throw ComputerError.message("The fresh checkout plan does not match the selected copy option or has invalid content.")}
            var title="Create this isolated checkout?",button="Create worktree"
            var effect="Creates a detached Git worktree from this exact local commit. Staged, unstaged and untracked source changes stay in the original checkout. Ignored regular files selected by .worktreeinclude, plus an ignored AGENTS.override.md, are copied as local setup when listed in this plan. Source symlinks and occupied targets are skipped; existing target files are never overwritten. Git may write the new checkout and its private registration in the shared Git directory. Network access and external executable hooks/filters are blocked. No prompt is sent. Stop may leave a partial checkout for inspection; it is not removed or retried automatically."
            if action=="create",input["copyChanges"] as? Bool==true {effect="Creates a new detached checkout from source HEAD and copies the reviewed staged and unstaged edits, deletions, untracked files, literal symlinks, executable modes, internal hardlinks and empty directories. Staged edits stay staged; working edits stay unstaged. Ignored working remainders of staged deletions are copied only when listed in ignoredRemainders. Source files, index and branches are kept. Reserved app scratch listed in excludedScratch stays only in source; this exclusion grants no cleanup or writer authority. The listed ignored local setup files are copied afterward without replacing occupied leaves. Only the new checkout, its index and its private Git registration are written. Network access and external hooks/filters are blocked. No prompt is sent. Stop or failure retains partial output for inspection without removing or retrying it."}
            if action=="reconnect" {
                guard Set(prepared.keys)==["plan"],CodingWorktreePolicy.reconnectPlan(plan) else {throw ComputerError.message("The retained worktree reconnect plan could not be verified.")}
                let paths=(plan["content"] as! [[String:Any]]).map{($0["path"] as! String).decomposedStringWithCanonicalMapping.uppercased().lowercased()}
                func affected(_ folder:String) -> Bool {let value=folder.decomposedStringWithCanonicalMapping.uppercased().lowercased();return value=="/" || paths.contains{$0==value || value.hasPrefix($0+"/") || $0.hasPrefix(value+"/")}}
                codingGrants=codingGrants.filter{grant in guard let colon=grant.firstIndex(of:":") else{return false};return !affected(String(grant[grant.index(after:colon)...]))}
                codingTerminals=codingTerminals.filter{!affected($0.value)}
                for (id,entry) in codingInteractive.entries where entry.folder.map(affected)==true {codingInteractive.revoke(id)}
                title="Reconnect these retained worktrees?";button="Reconnect worktrees"
                effect="The saved device number changed. This review adopts the exact currently inspected folders, Git registrations and recovery artifacts; it does not establish historical volume identity. It saves the original ledger and transaction evidence, then updates only recorded device numbers. Checkout files, staging, Git history, chats, drafts and recovery files are preserved. Existing project access is revoked; opening a chat requires its own review. No prompt is sent. A future restart of macOS may require another reconnect review. Stop cancels pending work; if publication already began, inspect the saved outcome before retrying."
                if plan["handoffs"] != nil {effect="The saved device number changed. This reconnect verifies the original closed chat owner and prior-boot writers, then adopts the currently inspected filesystem and Git identities. It preserves the original ledger, handoff manifest and complete progress journal in hashed evidence, and publishes explicitly derived current-device recovery metadata. The same owner, family, model and provider are retained. Checkout files, Git staging/history, chats and drafts stay in place. The interrupted handoff remains fenced; Restore or Finish requires a separate review. Full Access stays selected and recovery startup continues holding unrestricted tools. Stop or a failure retains the transaction fence and evidence for inspection; no automatic rollback or retry occurs."}
            } else if action=="recoverCopy" {
                guard Set(prepared.keys)==["plan"],CodingWorktreePolicy.copyPlan(plan,input:input) else{throw ComputerError.message("The original project copy plan could not be verified.")}
                title="Create a recovered project copy?";button="Create project copy"
                effect="Creates an independent project in the new folder shown above, using the recorded original source files, committed HEAD and staging. Working edits, untracked files and native file metadata are preserved. Ignored files and app scratch are omitted and remain in the original folders. The original checkouts, retained handoff, chat family, history and drafts stay in place. This does not finish the original handoff or reconnect it for execution. No prompt is sent. The new folder opens in Finder after verification. Stop or failure keeps partial output for inspection; it never overwrites an existing project or retries automatically."
            } else if action=="handoff" || action=="recoverHandoff" {
                guard Set(prepared.keys)==["plan"],action=="handoff" ? CodingWorktreePolicy.handoffPlan(plan,input:input):CodingWorktreePolicy.recoveryPlan(plan,input:input) else {throw ComputerError.message("The reviewed handoff does not match the selected operation, chat and checkout pair.")}
                let paths=[plan["source"] as! String,plan["destination"] as! String].map{$0.decomposedStringWithCanonicalMapping.uppercased().lowercased()}
                func affected(_ folder:String) -> Bool {let value=folder.decomposedStringWithCanonicalMapping.uppercased().lowercased();return value=="/" || paths.contains{$0==value || value.hasPrefix($0+"/") || $0.hasPrefix(value+"/")}}
                codingGrants=codingGrants.filter {grant in guard let colon=grant.firstIndex(of:":") else {return false};return !affected(String(grant[grant.index(after:colon)...]))}
                codingTerminals=codingTerminals.filter{!affected($0.value)}
                for (id,entry) in codingInteractive.entries where entry.folder.map(affected)==true {codingInteractive.revoke(id)}
                if action=="recoverHandoff" {
                    let restoring=plan["mode"] as? String=="restore"
                    title=restoring ? "Restore this interrupted handoff?":"Finish this interrupted handoff?";button=restoring ? "Restore handoff":"Finish handoff"
                    effect=restoring ? "Restores the original recorded state and returns this same chat and its agent family to source. Selects the branch Before columns and original staged and working edits.":"Finishes the recorded candidate result and moves this same chat and its agent family to destination. Selects the branch After columns and candidate staged and working edits."
                    effect += " Both checkouts change to the selected recorded state; staged changes remain separate from working edits and branch refs remain unchanged. Reviewed displaced content is preserved in the recovery storage shown above. Recorded ignored paths and currently verified app scratch stay in place. Unverified scratch is reviewed as ordinary content. The nativePolicy describes native metadata. The same chat, family, history, model and provider are retained. Existing project and terminal access to both paths is revoked; execution requires a new review. No prompt is sent. Stop may retain another partial recovery attempt for inspection; it does not automatically roll back, retry or clear the fence."
                } else {
                    title="Move this chat and its local changes?";button="Move chat"
                    effect="Moves this same chat and its agent family to the reviewed destination, retaining their history, model and provider. Both checkouts change: staging remains separate from working edits, compatible destination changes are preserved, and the source is restored to its reviewed HEAD. Branch effects and native metadata rules are shown above. Ignored files and app scratch stay in place. Existing project and terminal access is revoked. No prompt is sent. Recovery copies stay on disk. Stop can leave a partial handoff requiring inspection; it does not roll back or retry the transfer automatically. Starting this move upgrades Coding storage and makes it incompatible with Build80 and earlier; reopening Coding requires this or a compatible newer version."
                }
            } else if action != "create" {
                guard plan["operation"] as? String==action,plan["worktreeId"] as? String==input["id"] as? String,
                      let cwd=plan["cwd"] as? String,cwd.hasPrefix("/"),cwd.utf8.count<=4096,!cwd.contains("\0"),
                      let commit=plan["commit"] as? String,commit.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil,
                      let files=plan["files"] as? NSNumber,CFGetTypeID(files) != CFBooleanGetTypeID(),files.doubleValue>=0,files.doubleValue<=20000,files.doubleValue.rounded(.towardZero)==files.doubleValue,
                      let bytes=plan["bytes"] as? NSNumber,CFGetTypeID(bytes) != CFBooleanGetTypeID(),bytes.doubleValue>=0,bytes.doubleValue<=134217728,bytes.doubleValue.rounded(.towardZero)==bytes.doubleValue else { throw ComputerError.message("The reviewed worktree operation does not match the selected checkout.") }
                // Revoke path grants before review/dispatch; restoring never silently grants execution.
                codingGrants=codingGrants.filter { grant in
                    guard let colon=grant.firstIndex(of:":") else { return false }
                    let folder=String(grant[grant.index(after:colon)...]);return folder != cwd && !folder.hasPrefix(cwd+"/")
                }
                if action=="archive" {
                    title="Archive this checkout?";button="Archive checkout"
                    effect="Moves this checkout into private local recovery storage and removes its active Git registration. Committed history, staging, working edits, ignored files and native file metadata are retained. This keeps recovery files on disk; it does not promise reclaimed space. Chats and drafts stay available, but this checkout cannot run tasks until restored. Close other editors or commands using it before continuing."
                } else {
                    title="Restore this checkout?";button="Restore checkout"
                    effect="Returns the saved files to their original path and restores the exact committed HEAD and staging. The checkout is detached; existing branches stay unchanged. The original path must be absent. Existing chats remain available and project access is reviewed again before execution. The recovery bundle is retained."
                }
                effect += " No prompt is sent. Stop cannot undo an operation already sent; an interrupted result is retained for inspection and is never retried automatically."
            }
            var detail:String
            if action=="reconnect" {
                let records=plan["records"] as! [[String:Any]]
                detail="Managed folder: \(plan["root"] as! String)\n\n"+records.enumerated().map{index,row in
                    "Worktree \(index+1)\nSource: \(row["source"] as! String)\nCheckout: \(row["cwd"] as! String)\nCurrent commit: \(row["head"] as! String)\nLocal changes: \((row["dirty"] as! Bool) ? "present — kept":"none")"
                }.joined(separator:"\n\n")
                if let handoffs=plan["handoffs"] as? [[String:Any]],let h=handoffs.first {detail += "\n\nRetained handoff: \(h["id"] as! String)\nOriginal chat: \(h["rootThreadId"] as! String)\nOwner: \(h["ownerId"] as! String)\nSource: \(h["source"] as! String)\nDestination: \(h["destination"] as! String)\nOriginal manifest SHA256: \(h["manifestSHA256"] as! String)\nRetained receipts: \(h["receipts"] as! NSNumber)\nCommitted receipt: \(h["committedSequence"] as! NSNumber)"}
            } else {detail=String(decoding:try JSONSerialization.data(withJSONObject:plan,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self)}
            guard try await approve(title,detail:detail+"\n\n"+effect,button:button,expected:expected) else {
                if generation==worktreeEpoch { _ = try? await request("worktrees",["action":"stop"]) }
                return ["cancelled":true,"message":"Worktree operation cancelled."]
            }
            try require(expected)
            guard generation==worktreeEpoch else { throw ComputerError.message("Worktree operation stopped. No retry was made.") }
            let result=try await request("worktrees",["action":action=="reconnect" ? "commitReconnect":action=="recoverCopy" ? "createRecoveryCopy":action,"planId":id]);try require(expected)
            guard generation==worktreeEpoch else {throw ComputerError.message("Worktree operation stopped. Completion is unconfirmed; inspect retained work before retrying.")}
            if action=="handoff",!CodingWorktreePolicy.handoffResult(result,plan:plan) {throw ComputerError.message("The handoff outcome could not be verified. Inspect retained work before retrying.")}
            if action=="recoverHandoff",!CodingWorktreePolicy.recoveryResult(result,plan:plan) {throw ComputerError.message("The recovery outcome could not be verified. Inspect retained work before retrying.")}
            if action=="reconnect",!CodingWorktreePolicy.reconnectResult(result,plan:plan) {throw ComputerError.message("The reconnect outcome could not be verified. Inspect the ledger and saved transaction evidence before retrying.")}
            if action=="recoverCopy" {
                guard CodingWorktreePolicy.copyResult(result,plan:plan) else{throw ComputerError.message("The recovered project copy could not be verified. Inspect retained output before retrying.")}
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath:plan["target"] as! String,isDirectory:true)])
            }
            return result
        } catch {
            if generation==worktreeEpoch { _ = try? await request("worktrees",["action":"stop"]) }
            throw error
        }
    }
    private func gitWorkflow(_ input:[String:Any],expected:UUID,generation:UUID,stopTicket:ScopedStop?) async throws -> [String:Any] {
        guard let action=CodingGitPolicy.action(input) else { throw ComputerError.message("Invalid Git request.") }
        let requestId=input["requestId"] as? String
        if action=="stop" {
            guard generation==gitEpoch,requestId==gitRequest else { return ["cancelled":true,"message":"The earlier Git request is no longer active."] }
            return try await requestScopedStop("git",input,ticket:stopTicket)
        }
        if action != "inspect" {
            guard generation==gitEpoch,requestId==gitRequest else { throw ComputerError.message("Git review stopped. No retry was made.") }
            gitBusy=true
        }
        defer { if action != "inspect" { gitBusy=false;if generation==gitEpoch { gitRequest=nil } } }
        do {
            let data=try await request("coding",["action":"read","threadId":input["threadId"]!]);try require(expected)
            guard let thread=data["thread"] as? [String:Any],let cwd=thread["cwd"] as? String,cwd.hasPrefix("/") else { throw ComputerError.message("The coding project is unavailable.") }
            if action=="inspect" { return try await request("git",["action":"inspect","cwd":cwd]) }
            guard thread["parentThreadId"] == nil || thread["parentThreadId"] is NSNull,
                  (thread["source"] as? [String:Any])?["subAgent"] == nil,thread["canAcceptDirectInput"] as? Bool != false else { throw ComputerError.message("Change Git state through the parent chat.") }
            guard generation==gitEpoch,requestId==gitRequest else { throw ComputerError.message("Git review stopped. No retry was made.") }
            if ["remoteInspect","inspectRemoteOutcome","acknowledgeRemoteOutcome"].contains(action) {
                var requestInput=input;requestInput.removeValue(forKey:"threadId");requestInput["cwd"]=cwd
                let answer=try await request("git",requestInput);try require(expected)
                guard generation==gitEpoch,requestId==gitRequest else{throw ComputerError.message("Git inspection stopped. No retry was made.")}
                return answer
            }
            var effect=input;for key in ["action","threadId","snapshotId","requestId"] { effect.removeValue(forKey:key) };effect["kind"]=action
            let prepared=try await request("git",["action":"prepare","cwd":cwd,"snapshotId":input["snapshotId"]!,"requestId":requestId!,"request":effect]);try require(expected)
            guard generation==gitEpoch,requestId==gitRequest else { throw ComputerError.message("Git review stopped. No retry was made.") }
            if let state=prepared["state"] as? String {
                guard Set(prepared.keys)==["state","requestId","message"],["stale","busy","cancelled","failed"].contains(state),prepared["requestId"] as? String==requestId,
                      let message=prepared["message"] as? String,!message.isEmpty,message.utf8.count<=6400 else { throw ComputerError.message("The Git preparation outcome could not be verified.") }
                return prepared
            }
            guard let plan=prepared["plan"] as? [String:Any],let planId=plan["id"] as? String,UUID(uuidString:planId) != nil,plan["requestId"] as? String==requestId else { throw ComputerError.message("The Git plan could not be verified.") }
            let detail=String(decoding:try JSONSerialization.data(withJSONObject:plan,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self)
            let label=["stage":"Stage selected changes","unstage":"Unstage selected changes","commit":"Commit staged changes","createBranch":"Create branch","switchBranch":"Switch branch","publishBranch":"Publish branch","createPR":"Create draft pull request"][action]!
            let remote=["publishBranch","createPR"].contains(action)
            let effectDescription=remote ? (action=="publishBranch" ? "Publishes the reviewed commit to the displayed GitHub account, repository and branch. Only a new branch or verified fast-forward is supported. Local working files, index and configuration stay unchanged." : "Creates a draft pull request from the already published head to the displayed base. Does not push, fork or edit an existing pull request. Named refs can move during creation; uncertain outcomes retain the URL for inspection.") : action=="switchBranch" ? "Working files will change to the reviewed local branch. Compatible local edits are carried over; conflicting changes and untracked or ignored collisions are rejected. An interrupted switch may leave partial changes and requires inspection." : "Existing working files stay unchanged. Branch creation does not switch the checkout."
            guard try await approve(label+"?",detail:detail+"\n\nApplies this exact "+(remote ? "GitHub":"local Git")+" operation once. "+effectDescription+(remote ? "":" No push or pull request is sent.")+" Hooks, signing and external filters are not executed. Stop cannot undo an operation already sent; inspect its result before retrying.",button:label,expected:expected,operational:true) else {
                _ = try? await request("git",["action":"stop","requestId":requestId!])
                return ["state":"cancelled","requestId":requestId!,"message":"Git review cancelled. No operation was submitted."]
            }
            guard generation==gitEpoch,requestId==gitRequest else { throw ComputerError.message("Git review stopped. No retry was made.") }
            return try await request("git",["action":"execute","planId":planId,"requestId":requestId!])
        } catch {
            if let requestId { _ = try? await request("git",["action":"stop","requestId":requestId]) }
            throw error
        }
    }
    private func bindCodingProvider(_ input:[String:Any],expected:UUID,token:UUID) async throws -> [String:Any] {
        try CodingMCPSetupPolicy.exact(input,["threadId"])
        let id=try CodingMCPSetupPolicy.identifier(input["threadId"],limit:160)
        func check() throws {try require(expected);guard providerBinding?.threadId==id,providerBinding?.token==token else{throw ComputerError.message("Cloud connection review was stopped. No retry was made.")}}
        func validate(_ value:[String:Any]) throws -> [String:Any] {
            try CodingMCPSetupPolicy.exact(value,["ownerId","threadId","model","state","profile","fingerprint"])
            _ = try CodingMCPSetupPolicy.uuid(value["ownerId"])
            let model=try CodingMCPSetupPolicy.text(value["model"],limit:200)
            guard value["threadId"] as? String==id,["bound","unbound"].contains(value["state"] as? String ?? ""),let profile=value["profile"] as? [String:Any] else{throw CodingMCPSetupPolicy.Failure()}
            _ = try CodingMCPSetupPolicy.cloudProvider(profile,model:model)
            let fingerprint=try CodingMCPSetupPolicy.text(value["fingerprint"],limit:64)
            guard fingerprint.utf8.count==64,fingerprint.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) else{throw CodingMCPSetupPolicy.Failure()}
            return profile
        }
        try check();let before=try await request("coding",["action":"providerBindingInfo","threadId":id]);try check()
        let profile=try validate(before),bound=before["state"] as? String=="bound"
        let detail="Provider: \(profile["name"]!)\nEndpoint: \(profile["baseURL"]!)\nModel: \(profile["model"]!)\n\n"+(bound ? "This chat keeps this saved connection even when the default provider changes.":"Bind this saved chat to the displayed cloud provider. Future continuation will send its conversation, project context and tool outputs there using the saved API key. Provider charges may apply. Binding does not send a message or start work.")
        providerBindingAlert=token
        let accepted=try await approve(bound ? "This chat's cloud connection":"Choose this chat's cloud connection",detail:detail,button:bound ? "Done":"Bind this chat",expected:expected)
        try check();providerBindingAlert=nil
        if bound{return ["state":"bound","message":"This chat keeps its saved cloud connection."]}
        if !accepted{return ["cancelled":true,"message":"Cloud connection unchanged."]}
        try check();let after=try await request("coding",["action":"bindProvider","threadId":id,"fingerprint":before["fingerprint"]!]);try check()
        let selected=try validate(after)
        guard after["state"] as? String=="bound",after["ownerId"] as? String==before["ownerId"] as? String,after["fingerprint"] as? String==before["fingerprint"] as? String,try CodingMCPSetupPolicy.bytes(selected)==CodingMCPSetupPolicy.bytes(profile) else{throw ComputerError.message("Cloud binding could not be confirmed. Inspect this chat's connection before continuing.")}
        return ["state":"bound","message":"Cloud connection saved for this chat. No message was sent."]
    }
    private func configureCodingProvider(expected:UUID) async throws -> [String:Any] {
        let paths=try runtimePaths.get()
        try require(expected)
        guard let owner=webView?.window else { throw ComputerError.message("The app window is unavailable.") }
        let panel=NSAlert();panel.messageText="Add an optional cloud model"
        panel.informativeText="Local Qwen stays the default. Select Cloud explicitly for a new coding chat to send its conversation, project context and tool outputs to your provider. Provider charges may apply. Use an HTTPS endpoint supporting the Responses API."
        panel.addButton(withTitle:"Cancel");panel.addButton(withTitle:"Save provider")
        let stack=NSStackView();stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=7
        let url=NSTextField(string:"");url.placeholderString="https://api.openai.com/v1"
        let model=NSTextField(string:"");model.placeholderString="Exact model identifier"
        let key=NSSecureTextField(string:"");key.placeholderString="API key (saved in macOS Keychain)"
        for (label,field) in [("Responses API base URL",url),("Model",model),("API key",key as NSTextField)] {
            stack.addArrangedSubview(NSTextField(labelWithString:label));field.translatesAutoresizingMaskIntoConstraints=false;field.widthAnchor.constraint(equalToConstant:500).isActive=true;stack.addArrangedSubview(field)
        }
        panel.accessoryView=stack;alert=panel;owner.makeKeyAndOrderFront(nil);NSApp.activate()
        let choice=await withCheckedContinuation { continuation in panel.beginSheetModal(for:owner){continuation.resume(returning:$0)} };alert=nil;try require(expected)
        guard choice == .alertSecondButtonReturn else { return ["cancelled":true] }
        let endpoint=url.stringValue.trimmingCharacters(in:.whitespacesAndNewlines),modelName=model.stringValue.trimmingCharacters(in:.whitespacesAndNewlines),secret=key.stringValue
        let durable=try CodingProviderSettings.save(directory:paths.dataDir,endpoint:endpoint,model:modelName,key:secret,check:{try self.require(expected)},addCredential:{account,data in
            let item:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.saleh.qwenlocal.coding",kSecAttrAccount as String:account,kSecValueData as String:data]
            let status=SecItemAdd(item as CFDictionary,nil)
            guard status==errSecSuccess else { throw ComputerError.message("Keychain could not save the provider key (\(status)).") }
        })
        return ["durable":durable,"message":"Cloud provider saved for new coding chats. Existing chats keep their provider; local Qwen remains the default."+(durable ? "":" The change is visible, but disk synchronization could not be confirmed. Inspect provider settings before closing the app.")]
    }
    private func schedules(_ input:[String:Any],expected:UUID,generation:UUID,stopTicket:ScopedStop?) async throws -> [String:Any] {
        guard let action=CodingSchedulePolicy.action(input) else { throw ComputerError.message("Invalid scheduled-work request.") }
        if action=="list" { return try await request("schedules",input) }
        guard generation==scheduleEpoch else { throw ComputerError.message("Scheduled-work request stopped. No retry was made.") }
        if action=="pause" || action=="stop" {
            return try await requestScopedStop("schedules",input,ticket:stopTicket)
        }
        scheduleBusy=true;defer { scheduleBusy=false }
        if action=="delete" {
            let listing=try await request("schedules",["action":"list"]);try require(expected)
            guard generation==scheduleEpoch else { throw ComputerError.message("Scheduled-work request stopped.") }
            guard let records=listing["schedules"] as? [[String:Any]],let record=records.first(where:{$0["id"] as? String==input["id"] as? String}),record["active"] as? Bool==false else { throw ComputerError.message("Pause this schedule before deleting it.") }
            let detail=String(decoding:try JSONSerialization.data(withJSONObject:record,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self)
            guard try await approve("Delete this paused schedule?",detail:detail+"\n\nRemoves this schedule and its run index. Saved chats and project files remain available.",button:"Delete schedule",expected:expected) else { return ["cancelled":true] }
            guard generation==scheduleEpoch else { throw ComputerError.message("Scheduled-work request stopped.") }
            return try await request("schedules",input)
        }
        if action=="recover" {
            let prepared=try await request("schedules",["action":"prepareRecovery"]);try require(expected)
            guard generation==scheduleEpoch else {throw ComputerError.message("Schedule recovery review stopped. No retry was made.")}
            guard let plan=CodingSchedulePolicy.recoveryPlan(prepared) else {throw ComputerError.message("The paused schedule recovery plan could not be verified.")}
            let scope="Restore these saved schedule records with the exact current folder identities below. All schedules remain paused; definitions and run history are preserved. This adopts current identities and does not establish historical identity proof. No task starts. Existing workspace execution restrictions remain; Resume or Run needs its own review and workspace checks."
            guard try await approve("Recover paused schedules",detail:scope+"\n\n"+plan.detail,button:"Recover paused schedules",expected:expected) else {return ["cancelled":true,"message":"Schedule recovery cancelled. No recovery was committed."]}
            try require(expected)
            guard generation==scheduleEpoch else {throw ComputerError.message("Schedule recovery review stopped. No retry was made.")}
            let result=try await request("schedules",["action":"commitRecovery","planId":plan.id]);try require(expected)
            guard generation==scheduleEpoch else {throw ComputerError.message("Recovery result arrived after Stop. Inspect schedules; recovery may already have completed. No retry was made.")}
            return result
        }
        let prepared=try await request("schedules",["action":"prepare","request":input]);try require(expected)
        guard generation==scheduleEpoch else { throw ComputerError.message("Scheduled-work review stopped. No retry was made.") }
        guard let plan=CodingSchedulePolicy.prepared(prepared,input:input) else { throw ComputerError.message("The scheduled-work plan could not be verified.") }
        let execution=plan.executionMode=="native" ? "Native macOS. Each run works directly in the approved project without a guest disk. Stop cancels tracked work; detached host programs may continue." : "Virtual machine. Each run uses a separate guest system and the approved project workspace. Guest setup and storage are required."
        let recurring=action != "run"
        let scope=recurring ? "Saves scheduled project access for this exact schedule until paused or deleted. Each due occurrence starts a new local Qwen chat without asking for project access again." : "Starts one additional local Qwen chat now using this saved schedule. Its saved timing is unchanged."
        guard try await approve(recurring ? "Enable this scheduled work?":"Run this scheduled task now?",detail:execution+"\n\n"+scope+"\n\n"+plan.detail+"\n\nThe agent can read local files and write inside this project. Existing project changes remain and may be modified. Network and additional write access are not granted; actions requiring escalation stop the run for review. Runs require this app and an awake Mac. Missed active occurrences are combined into one run; paused time is skipped. Pause cancels this schedule and future runs. Stop All pauses every schedule. Quitting cancels current work but preserves enabled future schedules. Stop cannot undo edits already made.",button:recurring ? "Enable schedule":"Run once",expected:expected,operational:true) else { return ["cancelled":true,"message":"Schedule review cancelled. No configuration was changed or run requested."] }
        guard generation==scheduleEpoch else { throw ComputerError.message("Scheduled-work review stopped. No retry was made.") }
        return try await request("schedules",["action":"commit","planId":plan.id])
    }
    private func connect(_ id:String, expected:UUID,beforeEffect:(() async throws -> Void)?=nil,agentClaim:(() -> [String:Any]?)?=nil) async throws -> [String:Any] {
        let configURL=try runtimePaths.get().mcpConfig
        guard let servers=try await request("describe",[:])["servers"] as? [[String:Any]], let entry=servers.first(where:{$0["id"] as? String==id}), let hash=entry["configHash"] as? String else { throw ComputerError.message("Unknown configured server.") }
        let data=try JSONSerialization.data(withJSONObject:entry,options:[.prettyPrinted,.sortedKeys])
        let kind=Bundle.main.resourcePath.flatMap{RoutineReadPolicy.kind(entry,resources:$0,runtime:configURL.deletingLastPathComponent().path)}
        let reads=kind == nil ? "" : "\n\nWhile connected, routine reads in this preset's scope run without another prompt. File writes, known secret paths, browser actions and custom tools still require review. Stop/disconnect revokes this permission."
        guard try await approve("Connect \(id)?",detail:String(decoding:data,as:UTF8.self)+"\n\nConnecting a local server starts its executable. Only connect servers you trust. Environment/header values stay private."+reads,button:"Connect once",expected:expected,operational:true) else { return ["cancelled":true,"message":"Connection cancelled."] }
        try await beforeEffect?();try require(expected)
        var input:[String:Any]=["id":id,"configHash":hash];if let claim=agentClaim?(){input["agentClaim"]=claim}
        let result=try await request("connect",input)
        if beforeEffect==nil {try require(expected)}
        if expected==epoch,let kind {routineReads[id]=(kind,hash)}
        return result
    }
    private func call(_ name: String, expected: UUID,beforeEffect:(() async throws -> Void)?=nil) async throws -> [String:Any] {
        let name=name.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !name.isEmpty,name.count<=80,!name.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}) else { throw ComputerError.message("Provide the contact's name.") }
        guard try await contacts.requestAccess(for:.contacts) else { throw ComputerError.message("Contacts permission was not granted. Choose the person directly in Phone.") };try require(expected)
        let keys:[CNKeyDescriptor]=[CNContactFormatter.descriptorForRequiredKeys(for:.fullName),CNContactPhoneNumbersKey as CNKeyDescriptor,CNContactIdentifierKey as CNKeyDescriptor]
        let found=try contacts.unifiedContacts(matching:CNContact.predicateForContacts(matchingName:name),keysToFetch:keys)
        var choices:[(id:String,number:String,label:String)]=[]
        for contact in found.prefix(20) {
            for phone in contact.phoneNumbers.prefix(10) {
                guard (try? PhoneTarget.url(phone.value.stringValue)) != nil else { continue }
                let full=CNContactFormatter.string(from:contact,style:.fullName) ?? name
                let label=phone.label.map{CNLabeledValue<NSString>.localizedString(forLabel:$0)} ?? "Phone"
                choices.append((contact.identifier,phone.value.stringValue,"\(full) · \(label) · \(phone.value.stringValue)"))
            }
        }
        guard !choices.isEmpty else { try await beforeEffect?();try require(expected);return ["message":"No matching contact with a supported telephone number. No call was placed.","isError":true] }
        let picker=NSPopUpButton(frame:NSRect(x:0,y:0,width:520,height:30));picker.addItems(withTitles:choices.map(\.label))
        guard try await approve("Call a contact matching “\(name)” ?",detail:"Choose the intended person and number. This sends one telephone call request to macOS Phone or FaceTime. A connected iPhone/calling setup may be required.",button:"Call selected number",expected:expected,accessory:picker) else { return ["cancelled":true,"message":"Call cancelled. No call request was sent."] }
        let chosen=choices[picker.indexOfSelectedItem]
        try await beforeEffect?();try require(expected)
        let current=try contacts.unifiedContact(withIdentifier:chosen.id,keysToFetch:keys)
        guard current.phoneNumbers.contains(where:{$0.value.stringValue==chosen.number}) else { throw ComputerError.message("The contact changed. No call request was sent.") }
        let url=try PhoneTarget.url(chosen.number);try require(expected)
        guard NSWorkspace.shared.open(url) else { throw ComputerError.message("macOS did not accept the call request. No retry was made.") }
        return ["message":"macOS accepted one telephone call request for the contact you selected. Check Phone/FaceTime for any final prompt or calling error. Ringing, connection and answer are unverified.","callRequested":true]
    }
    private func configure(_ operation:String, expected:UUID) async throws -> [String:Any] {
        let configURL=try runtimePaths.get().mcpConfig
        if operation=="editConfig" {
            if !FileManager.default.fileExists(atPath:configURL.path) { try writeConfig(["mcpServers":[:]],replacing:nil) }
            NSWorkspace.shared.open(configURL);return ["message":"Opened the MCP configuration. Changes need a new Connect approval. Never put secrets in command-line arguments."]
        }
        guard let resources=Bundle.main.resourceURL, let node=["/opt/homebrew/bin/node","/usr/local/bin/node"].first(where:{FileManager.default.isExecutableFile(atPath:$0)}) else { throw ComputerError.message("Node runtime is unavailable.") }
        var root:[String:Any]=["mcpServers":[:]]
        let original = FileManager.default.fileExists(atPath:configURL.path) ? try Data(contentsOf:configURL) : nil
        if let data=original { guard data.count<=262144, let saved=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw ComputerError.message("MCP configuration is unreadable.") };root=saved }
        guard var servers=root["mcpServers"] as? [String:Any] else { throw ComputerError.message("MCP configuration needs mcpServers.") }
        let id=operation=="addFilesystem" ? "files" : "browser"
        guard servers[id]==nil else { return ["message":"\(id) is already configured. Use its Connect button."] }
        var args:[String]
        if operation=="addFilesystem" {
            let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false;panel.message="Choose Qwen's working folder. After Connect, routine reads are automatic; writes and known secret paths require review."
            guard panel.runModal() == .OK, let folder=panel.url else { return ["cancelled":true,"message":"Folder selection cancelled."] };try require(expected)
            args=[resources.appendingPathComponent("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js").path,folder.path]
        } else { args=[resources.appendingPathComponent("node_modules/@playwright/mcp/cli.js").path,"--isolated","--browser","chrome"] }
        servers[id]=["command":node,"args":args,"cwd":configURL.deletingLastPathComponent().path];root["mcpServers"]=servers;try writeConfig(root,replacing:original)
        return ["message":"\(id) configured. Review and Connect to activate it."]
    }
    private func writeConfig(_ root:[String:Any], replacing original:Data?) throws {
        let configURL=try runtimePaths.get().mcpConfig
        let parent=configURL.deletingLastPathComponent();try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let data=try JSONSerialization.data(withJSONObject:root,options:[.prettyPrinted,.sortedKeys])
        // ponytail: exact bytes guard the chooser interval; uncoordinated writers can still race the final check/replace.
        let current = FileManager.default.fileExists(atPath:configURL.path) ? try Data(contentsOf:configURL) : nil
        guard current == original else { throw ComputerError.message("MCP configuration changed while this preset was being added. No changes were saved. Review the current file and add the preset again.") }
        try data.write(to:configURL,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:configURL.path)
    }
}
