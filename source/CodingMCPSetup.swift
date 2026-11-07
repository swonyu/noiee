import Foundation
import CoreFoundation
import Darwin

// Shared with the existing ordinary Coding project review. This display/key
// normalization is not a substitute for the owner's POSIX canonical-path check.
enum CodingProjectGrant {
    struct Scope {let provider:String,folder:String,executionMode:String;var key:String {(executionMode=="native" ? "native|":"")+provider+":"+folder}}
    static func scope(provider:String,cwd:String,executionMode:String="vm") throws -> Scope {
        guard ["native","vm"].contains(executionMode),["local","cloud"].contains(provider),cwd.hasPrefix("/"),!cwd.contains("\0") else{throw CodingMCPSetupPolicy.Failure()}
        return Scope(provider:provider,folder:URL(fileURLWithPath:cwd).resolvingSymlinksInPath().standardizedFileURL.path,executionMode:executionMode)
    }
}

// The page chooses a bounded selection. Only native review creates the trusted
// commit proof. Neither validation nor connection review grants tool-call access.
enum CodingMCPSetupPolicy {
    struct Failure: LocalizedError { var errorDescription: String? { "Coding MCP setup is unavailable or changed. Inspect the original setup before trying again; no automatic retry was made." } }
    static let errorMessages = [
        "expired":"Coding MCP setup expired; prepare and review again.",
        "cancelled":"Coding MCP setup was cancelled.",
        "setup-failed":"Coding MCP setup failed; retained status and evidence were preserved.",
        "creation-unconfirmed":"Chat creation is unconfirmed. Inspect this setup; do not create or send again automatically.",
        "closure-unconfirmed":"Owned connection or execution closure is unconfirmed; resources remain retained."]
    static func exact(_ value:[String:Any],_ keys:Set<String>) throws { guard Set(value.keys)==keys else {throw Failure()} }
    static func text(_ value:Any?,limit:Int,empty:Bool=false) throws -> String {
        guard let s=value as? String,(empty || !s.isEmpty),s.utf16.count<=limit,
              !s.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}) else {throw Failure()};return s
    }
    static func integer(_ value:Any?) throws -> Int64 {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=9_007_199_254_740_991,n.doubleValue.rounded(.towardZero)==n.doubleValue else {throw Failure()};return n.int64Value
    }
    static func uuid(_ value:Any?) throws -> String {
        let s=try text(value,limit:36);guard s.utf8.count==36,UUID(uuidString:s) != nil else {throw Failure()};return s
    }
    static func path(_ value:Any?) throws -> String {let s=try text(value,limit:4096);guard s.hasPrefix("/") else {throw Failure()};return s}
    static func identifier(_ value:Any?,limit:Int=100) throws -> String {
        let s=try text(value,limit:limit);guard s.utf8.allSatisfy({(48...57).contains($0)||(65...90).contains($0)||(97...122).contains($0)||[45,46,95].contains($0)}) else{throw Failure()};return s
    }
    static func executionMode(_ value:[String:Any]) throws -> String {
        guard let supplied=value["executionMode"] else{return "vm"}
        guard let mode=supplied as? String,["native","vm"].contains(mode) else{throw Failure()};return mode
    }
    static func selection(_ value:[String:Any]) throws {
        try exact(value,value["executionMode"] == nil ? ["cwd","provider","model","serverIds"]:["cwd","provider","model","serverIds","executionMode"]);_ = try executionMode(value);_ = try path(value["cwd"]);_ = try text(value["model"],limit:200)
        guard ["local","cloud"].contains(value["provider"] as? String ?? ""),let ids=value["serverIds"] as? [String],(1...64).contains(ids.count),Set(ids).count==ids.count else{throw Failure()}
        for id in ids {_ = try identifier(id)}
    }
    static func input(_ value:[String:Any]) throws -> [String:Any] {
        guard let action=value["action"] as? String else{throw Failure()}
        switch action {
        case "prepareStart":
            try exact(value,value["executionMode"] == nil ? ["action","cwd","provider","model","serverIds"]:["action","cwd","provider","model","serverIds","executionMode"]);var s=value;s.removeValue(forKey:"action");try selection(s)
        case "setupStatus","cancelSetup":try exact(value,["action","setupId"]);_ = try uuid(value["setupId"])
        case "reviewStart":try exact(value,["action","setupId","revision"]);_ = try uuid(value["setupId"]);_ = try integer(value["revision"])
        default:throw Failure()
        }
        // Copy primitive fields/arrays now, before authentication or any await.
        return try JSONSerialization.jsonObject(with:JSONSerialization.data(withJSONObject:value)) as! [String:Any]
    }
    static func action(_ value:[String:Any]) -> String? {(try? input(value))?["action"] as? String}
    static func bytes(_ value:Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else{throw Failure()}
        let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]);guard data.count<=131072 else{throw Failure()};return data
    }
    static func endpoint(_ value:Any?,redactedQuery:Bool) throws {
        let s=try text(value,limit:8192);guard let u=URLComponents(string:s),let host=u.host,!host.isEmpty,u.user==nil,u.password==nil,u.fragment==nil,u.scheme=="https" || (u.scheme=="http" && ["localhost","127.0.0.1"].contains(host)) else{throw Failure()}
        if redactedQuery,let query=u.queryItems {guard query.allSatisfy({$0.value=="[redacted]"}) else{throw Failure()}}
    }
    static func cloudProvider(_ value:Any?,model:String) throws -> [String:Any] {
        guard let provider=value as? [String:Any] else{throw Failure()};try exact(provider,["name","model","baseURL","modelProvider","credentialId"])
        let credential=try uuid(provider["credentialId"]);guard credential==credential.lowercased() else{throw Failure()}
        _ = try text(provider["name"],limit:120);guard provider["model"] as? String==model,provider["modelProvider"] as? String=="saleh_cloud" else{throw Failure()};try endpoint(provider["baseURL"],redactedQuery:false);guard let base=provider["baseURL"] as? String,base.utf16.count<=2048,let url=URLComponents(string:base),url.scheme=="https",url.query==nil else{throw Failure()}
        return provider
    }
    static func review(_ value:Any?,request:[String:Any]) throws -> [[String:Any]] {
        guard let review=value as? [String:Any] else{throw Failure()};try exact(review,["provider","servers"])
        if request["provider"] as? String=="local" {guard review["provider"] is NSNull else{throw Failure()}}
        else {
            _ = try cloudProvider(review["provider"],model:text(request["model"],limit:200))
        }
        guard let servers=review["servers"] as? [[String:Any]],let ids=request["serverIds"] as? [String],servers.count==ids.count,servers.map({$0["id"] as? String}).compactMap({$0}).sorted()==ids.sorted() else{throw Failure()}
        for server in servers {
            _ = try identifier(server["id"]);let hash=try text(server["configHash"],limit:64)
            guard hash.utf8.count==64,hash.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) else{throw Failure()}
            let keys:[String]
            if server["transport"] as? String=="stdio" {
                try exact(server,["id","configHash","transport","command","args","cwd","envKeys"]);_ = try text(server["command"],limit:4096);_ = try path(server["cwd"])
                guard let args=server["args"] as? [String],args.count<=1024,let env=server["envKeys"] as? [String] else{throw Failure()};for arg in args {guard arg.utf16.count<=16384,!arg.contains("\0") else{throw Failure()}};keys=env
            } else if server["transport"] as? String=="http" {
                try exact(server,["id","configHash","transport","url","headerKeys"]);try endpoint(server["url"],redactedQuery:true);guard let headers=server["headerKeys"] as? [String] else{throw Failure()};keys=headers
            } else {throw Failure()}
            guard keys.count<=1024,Set(keys).count==keys.count else{throw Failure()};for key in keys {_ = try text(key,limit:256)}
        }
        return servers
    }
    static func project(_ value:[String:Any],setupId:String?=nil) throws -> [String:Any] {
        try exact(value,["setupId","revision","expiresAt","phase","request","creation","root","cleanup","error","review"])
        _ = try bytes(value);let id=try uuid(value["setupId"]);if let setupId,setupId != id{throw Failure()};_ = try integer(value["revision"])
        guard let phase=value["phase"] as? String,["preparing","prepared","committing","created","cancelled","failed"].contains(phase),let request=value["request"] as? [String:Any] else{throw Failure()};try selection(request)
        if !(value["expiresAt"] is NSNull) {_ = try integer(value["expiresAt"])}
        if ["preparing","prepared"].contains(phase),value["expiresAt"] is NSNull {throw Failure()}
        if ["committing","created"].contains(phase),!(value["expiresAt"] is NSNull) {throw Failure()}
        guard let creation=value["creation"] as? String,["not-started","unknown","confirmed"].contains(creation),["not-requested","pending","closed","unconfirmed"].contains(value["cleanup"] as? String ?? "") else{throw Failure()}
        if let root=value["root"] as? [String:Any] {
            guard creation=="confirmed" else{throw Failure()};try exact(root,["ownerId","generation","thread"]);_ = try uuid(root["ownerId"]);_ = try uuid(root["generation"])
            guard let thread=root["thread"] as? [String:Any] else{throw Failure()};try exact(thread,thread["executionMode"] == nil ? ["id","cwd","model","modelProvider","createdAt","updatedAt","name","historyMode"]:["id","cwd","model","modelProvider","createdAt","updatedAt","name","historyMode","executionMode"])
            _ = try identifier(thread["id"],limit:160)
            guard try executionMode(thread)==executionMode(request),thread["cwd"] as? String==request["cwd"] as? String,thread["model"] as? String==request["model"] as? String,thread["modelProvider"] as? String==(request["provider"] as? String=="cloud" ? "saleh_cloud":"saleh_local") else{throw Failure()}
            for key in ["createdAt","updatedAt"] {if !(thread[key] is NSNull) {_ = try integer(thread[key])}}
            if !(thread["name"] is NSNull) {guard let name=thread["name"] as? String,name.utf16.count<=2000,!name.contains("\0") else{throw Failure()}}
            guard thread["historyMode"] is NSNull || ["legacy","paginated"].contains(thread["historyMode"] as? String ?? "") else{throw Failure()}
        } else {guard value["root"] is NSNull,creation != "confirmed" else{throw Failure()}}
        if phase=="created",creation != "confirmed" {throw Failure()}
        if ["preparing","prepared"].contains(phase),creation != "not-started" {throw Failure()}
        if let error=value["error"] as? [String:Any] {try exact(error,["code","message"]);guard let code=error["code"] as? String,let known=errorMessages[code],error["message"] as? String==known else{throw Failure()}}
        else {guard value["error"] is NSNull else{throw Failure()}}
        if !(value["review"] is NSNull) {_ = try review(value["review"],request:request)}
        else if ["prepared","committing","created"].contains(phase) {throw Failure()}
        var result=value;result.removeValue(forKey:"review");return result
    }
    struct Review {
        let setupId:String,revision:Int64,fingerprint:Data,display:String,configs:[[String:String]],project:CodingProjectGrant.Scope
    }
    static func prepared(_ value:[String:Any],setupId:String,revision:Int64,nowMS:Double=Date().timeIntervalSince1970*1000) throws -> Review {
        _ = try project(value,setupId:setupId)
        guard value["phase"] as? String=="prepared",value["cleanup"] as? String=="not-requested",value["error"] is NSNull,try integer(value["revision"])==revision,
              let request=value["request"] as? [String:Any],try Double(integer(value["expiresAt"]))>nowMS,
              try Double(integer(value["expiresAt"]))-nowMS<=300000 else{throw Failure()}
        let cwd=try path(request["cwd"])
        guard let resolved=realpath(cwd,nil) else{throw Failure()};defer{free(resolved)}
        var directory:ObjCBool=false
        guard String(cString:resolved)==cwd,FileManager.default.fileExists(atPath:cwd,isDirectory:&directory),directory.boolValue else{throw Failure()}
        let servers=try review(value["review"],request:request),fingerprint=try bytes(value)
        let mode=try executionMode(request)
        let execution=mode=="native" ? "Native macOS: works directly in this project without a guest disk.":"Virtual machine: uses a separate guest system and reserved storage."
        let details=try bytes(["project":cwd,"provider":request["provider"]!,"model":request["model"]!,"executionMode":mode,"connections":value["review"]!])
        let display="Create this Coding task with MCP connections?\n\n"+String(decoding:details,as:UTF8.self)+"\n\nExecution: \(execution)\n\nProject access: the task can read local files and run commands in its coding sandbox. File writes are limited to the project; additional write or network access requires separate review. Stop interrupts tracked work; detached programs may continue. It does not undo edits or actions already sent. Project permission is remembered for this execution mode, provider and project during the current app session. Stop, page navigation, provider changes or affected checkout changes can require project review again.\n\nEach MCP connection runs through the host app, outside the coding project's sandbox and any project VM. A local executable runs as your Mac user; a remote server receives requests over the network. Provider permissions determine access to other files and services. Environment and header values remain private.\n\nCloud tasks send conversation, project context and tool outputs to the displayed provider and may incur charges. Local tasks use the selected local model. Connection review applies once to these exact configurations; every MCP tool call still requires separate review. This does not grant automatic MCP tool-call permission."
        return Review(setupId:setupId,revision:revision,fingerprint:fingerprint,display:display,configs:servers.map{["id":$0["id"] as! String,"configHash":$0["configHash"] as! String]},project:try CodingProjectGrant.scope(provider:request["provider"] as! String,cwd:cwd,executionMode:mode))
    }
}

// Native handles are ephemeral. Status may inspect a retained setup after a lost
// reply, but cannot restore review authority from browser storage or a restart.
@MainActor final class CodingMCPSetupSession {
    struct Operation {let input:[String:Any],action:String,epoch:UUID,token:UUID,setupId:String?}
    private var epoch=UUID(),pending=Set<UUID>(),entries=[String:UUID](),consumed=Set<String>()
    func invalidate(_ id:String?=nil) {if let id {entries[id]=nil} else {epoch=UUID();pending=[];entries=[:];consumed=[]}}
    func begin(_ supplied:[String:Any]) throws -> Operation {
        let input=try CodingMCPSetupPolicy.input(supplied),action=input["action"] as! String,id=input["setupId"] as? String
        let token:UUID
        if action=="prepareStart" {guard entries.count+pending.count<256 else{throw CodingMCPSetupPolicy.Failure()};token=UUID();pending.insert(token)}
        else if action=="reviewStart" {guard let id,!consumed.contains(id),let current=entries[id] else{throw CodingMCPSetupPolicy.Failure()};token=current}
        else {token=UUID();if action=="cancelSetup",let id{invalidate(id)}}
        return Operation(input:input,action:action,epoch:epoch,token:token,setupId:id)
    }
    func abandon(_ op:Operation) {if op.action=="prepareStart"{pending.remove(op.token)}}
    private func current(_ op:Operation) throws {
        guard epoch==op.epoch,!Task.isCancelled else{throw CodingMCPSetupPolicy.Failure()}
        if op.action=="prepareStart" {guard pending.contains(op.token) else{throw CodingMCPSetupPolicy.Failure()}}
        if op.action=="reviewStart" {guard let id=op.setupId,entries[id]==op.token else{throw CodingMCPSetupPolicy.Failure()}}
    }
    func perform(_ op:Operation,check:() throws -> Void,
                 request:([String:Any]) async throws -> [String:Any],
                 ask:(String,String) async throws -> Bool,
                 grantProject:(CodingProjectGrant.Scope) throws -> Void = {_ in}) async throws -> [String:Any] {
        func requireCurrent() throws {try current(op);try check()}
        defer {if op.action=="prepareStart"{pending.remove(op.token)}}
        try requireCurrent()
        if op.action != "reviewStart" {
            let value=try await request(op.input);try requireCurrent()
            let projected=try CodingMCPSetupPolicy.project(value,setupId:op.setupId)
            if op.action=="prepareStart" {
                guard let id=projected["setupId"] as? String,entries[id]==nil,let selection=projected["request"] as? [String:Any],selection["cwd"] as? String==op.input["cwd"] as? String,selection["provider"] as? String==op.input["provider"] as? String,selection["model"] as? String==op.input["model"] as? String,try CodingMCPSetupPolicy.executionMode(selection)==CodingMCPSetupPolicy.executionMode(op.input),(selection["serverIds"] as? [String])?.sorted()==(op.input["serverIds"] as? [String])?.sorted() else{throw CodingMCPSetupPolicy.Failure()}
                entries[id]=op.token
            }
            return projected
        }
        let id=op.setupId!,revision=try CodingMCPSetupPolicy.integer(op.input["revision"])
        let before=try await request(["action":"setupStatus","setupId":id]);try requireCurrent()
        let review=try CodingMCPSetupPolicy.prepared(before,setupId:id,revision:revision)
        let accepted=try await ask(id,review.display);try requireCurrent()
        guard accepted else {
            invalidate(id)
            let value=try await request(["action":"cancelSetup","setupId":id]);try check();guard epoch==op.epoch,!Task.isCancelled else{throw CodingMCPSetupPolicy.Failure()}
            return try CodingMCPSetupPolicy.project(value,setupId:id)
        }
        let fresh=try await request(["action":"setupStatus","setupId":id]);try requireCurrent()
        let rechecked=try CodingMCPSetupPolicy.prepared(fresh,setupId:id,revision:revision)
        guard rechecked.fingerprint==review.fingerprint else{throw CodingMCPSetupPolicy.Failure()}
        // Consume local authority before transport, preserving inspect-only status
        // if the commit response is lost. Never retry this creation automatically.
        try requireCurrent()
        consumed.insert(id)
        // Match ordinary Coding: remember exactly the accepted project scope
        // before sending work. A lost commit reply changes no creation receipt.
        // Status never invokes this callback or restores a cleared grant.
        try grantProject(review.project)
        let committed=try await request(["action":"commitStart","setupId":id,"revision":revision,"reviewedConfigs":review.configs])
        try requireCurrent()
        return try CodingMCPSetupPolicy.project(committed,setupId:id)
    }
}
