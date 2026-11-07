import Foundation
import CoreFoundation

// Native review authority belongs to the original signed request nonce, including
// MCP commits whose immediate reply precedes completion of guest startup.
@MainActor final class CodingProvisioning {
    static let startupTimeout:TimeInterval=1530 // Must exceed the trusted guest startup bound (1500 seconds).
    static let inspectionTimeout:TimeInterval=3
    static func canStartGuest(operation:String,action:String)->Bool {
        // Keep aligned with CodingOwners.handle cold execution admission.
        operation=="coding" && ["start","send","goalContinue","steer","review","fork","rename","archive","unarchive","terminalStart","git"].contains(action)
    }
    struct Failure:LocalizedError {
        var cause:Error?=nil
        var errorDescription:String? {"Guest provisioning review stopped, changed or lost its transport. Startup completion and physical cleanup are unconfirmed; inspect the original task before retrying. No automatic retry was made."}
    }
    struct Pending:Equatable {let object:[String:String]}
    struct Progress:Equatable {let revision:Int,stage:String,fraction:Double?}
    struct Update {let revision:Int,state:String,stage:String?,fraction:Double?}
    typealias Observe=(Update)->Void
    typealias Exchange=([String:Any]) async throws -> [String:Any]
    typealias Ask=(String,Pending) async throws -> Bool
    @MainActor private final class Origin {
        let id:String,dismiss:(String)->Void,cancelSetup:(() async throws -> Void)?
        var live=true,consumed=Set<String>(),result:Result<[String:Any],Error>?,failure:Error?
        var original:Task<Void,Never>?,poll:Task<Void,Never>?,deadline:Task<Void,Never>?,cleanup:Task<Void,Never>?
        var cleanupError:Error?
        var pollObserved=false,nullObserved=false
        let observe:Observe?
        var progressRevision=0,displayRevision=0,displayState="",displayStage:String?,displayFraction:Double?
        init(_ id:String,dismiss:@escaping(String)->Void,cancelSetup:(() async throws -> Void)?,observe:Observe?){self.id=id;self.dismiss=dismiss;self.cancelSetup=cancelSetup;self.observe=observe}
        func display(_ state:String,_ stage:String?=nil,_ fraction:Double?=nil){
            guard state != displayState || stage != displayStage || fraction != displayFraction else{return}
            displayState=state;displayStage=stage;displayFraction=fraction;displayRevision+=1;observe?(Update(revision:displayRevision,state:state,stage:stage,fraction:fraction))
        }
    }
    private var origins=[String:Origin](),setups=[String:String](),reviewing:Origin?
    private let timeout:TimeInterval
    init(timeout:TimeInterval=CodingProvisioning.startupTimeout){self.timeout=timeout}
    private static func uuid(_ value:Any?,upper:Bool=false) throws -> String {
        guard let s=value as? String,let parsed=UUID(uuidString:s),s==(upper ? parsed.uuidString:parsed.uuidString.lowercased()),
              s.utf8.count==36,s[s.index(s.startIndex,offsetBy:14)]=="4",["8","9","a","b"].contains(String(s[s.index(s.startIndex,offsetBy:19)]).lowercased()) else{throw Failure()};return s
    }
    static func pending(_ response:[String:Any],requestId:String) throws -> Pending? {
        guard Set(response.keys)==["requestId","pending"] || Set(response.keys)==["requestId","pending","progress"] else{throw Failure()}
        guard try uuid(response["requestId"])==requestId else{throw Failure()}
        if response["pending"] is NSNull{return nil}
        guard let value=response["pending"] as? [String:String],Set(value.keys)==["id","ownerId","generation","guestId","cwd"] else{throw Failure()}
        for key in ["id","ownerId","generation"]{_ = try uuid(value[key])};_ = try uuid(value["guestId"],upper:true)
        guard let cwd=value["cwd"],cwd.hasPrefix("/"),cwd != "/",cwd.utf8.count<=4096,
              !cwd.unicodeScalars.contains(where:{[.control,.format,.surrogate,.lineSeparator,.paragraphSeparator].contains($0.properties.generalCategory)}),
              URL(fileURLWithPath:cwd).standardizedFileURL.path==cwd,URL(fileURLWithPath:cwd).resolvingSymlinksInPath().path==cwd else{throw Failure()}
        var directory:ObjCBool=false;guard FileManager.default.fileExists(atPath:cwd,isDirectory:&directory),directory.boolValue else{throw Failure()}
        return Pending(object:value)
    }
    static func progress(_ value:Any?) -> Progress? {
        guard let value=value as? [String:Any],Set(value.keys)==["revision","stage"] || Set(value.keys)==["revision","stage","fraction"],let number=value["revision"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue>=1,number.doubleValue<=9_007_199_254_740_991,
              number.doubleValue==Double(number.intValue),let stage=value["stage"] as? String,
              ["allocating","installing","booting","waiting-connection","waiting-review","finishing-setup","preparing-project"].contains(stage) else{return nil}
        var fraction:Double?
        if let raw=value["fraction"] {
            guard stage=="installing",let number=raw as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.isFinite,(0...1).contains(number.doubleValue) else{return nil}
            fraction=number.doubleValue
        }
        return Progress(revision:number.intValue,stage:stage,fraction:fraction)
    }
    private func current(_ origin:Origin,_ check:() throws -> Void) throws {
        guard !Task.isCancelled,origin.live,origins[origin.id]===origin else{throw Failure()};try check()
    }
    private func cancel(_ origin:Origin,remote:Bool=true){
        if origin.live{origin.display("interrupted")}
        origin.failure=origin.failure ?? Failure();origin.live=false;origin.original?.cancel();origin.poll?.cancel();origin.deadline?.cancel();origin.dismiss(origin.id)
        if remote,let stop=origin.cancelSetup,origin.cleanup==nil {
            origin.cleanup=Task{@MainActor in do{try await stop()}catch{origin.cleanupError=error}}
        }
    }
    func invalidate(){for origin in origins.values{cancel(origin)};origins=[:];setups=[:]}
    func finishSetup(_ setupId:String){if let id=setups.removeValue(forKey:setupId),let origin=origins.removeValue(forKey:id){cancel(origin,remote:false)}}
    func failSetup(_ setupId:String) async {
        if let id=setups[setupId],let origin=origins[id]{cancel(origin);await origin.cleanup?.value}
    }
    private func review(_ origin:Origin,check:() throws -> Void,exchange:Exchange,ask:Ask) async throws {
        try current(origin,check);guard reviewing==nil else{return}
        if !origin.pollObserved{origin.pollObserved=true;NSLog("Saleh provisioning phase: poll-entered")}
        let response=try await exchange(["action":"status","requestId":origin.id]);try current(origin,check)
        let pending=try Self.pending(response,requestId:origin.id)
        // Display parsing is independent of the exact review capability. Missing
        // or malformed telemetry never becomes a review/Stop failure.
        if let progress=Self.progress(response["progress"]){
            if progress.revision>origin.progressRevision{origin.progressRevision=progress.revision;origin.display("observed",progress.stage,progress.fraction)}
        }else{origin.display("unavailable")}
        guard let pending else{
            if !origin.nullObserved{origin.nullObserved=true;NSLog("Saleh provisioning phase: first-null")};return
        }
        guard !origin.consumed.contains(pending.object["id"]!) else{throw Failure()}
        guard reviewing==nil else{return};reviewing=origin
        NSLog("Saleh provisioning phase: matched-pending")
        defer{if reviewing===origin{reviewing=nil};origin.dismiss(origin.id)}
        let accepted=try await ask(origin.id,pending);try current(origin,check)
        let fresh=try await exchange(["action":"status","requestId":origin.id]);try current(origin,check)
        guard try Self.pending(fresh,requestId:origin.id)==pending else{throw Failure()}
        let decision=accepted ? "continue":"cancel",id=pending.object["id"]!
        origin.consumed.insert(id) // Never resend a decision after a lost reply.
        let result=try await exchange(["action":"decide","requestId":origin.id,"pending":pending.object,"decision":decision]);try current(origin,check)
        guard Set(result.keys)==["requestId","id","decision","accepted"],result["requestId"] as? String==origin.id,result["id"] as? String==id,result["decision"] as? String==decision,
              let flag=result["accepted"] as? NSNumber,CFGetTypeID(flag)==CFBooleanGetTypeID(),flag.boolValue else{throw Failure()}
    }
    func inspectSetup(_ setupId:String,check:() throws -> Void,exchange:Exchange,ask:Ask) async throws {
        guard let id=setups[setupId],let origin=origins[id] else{return} // Inspection cannot restore native authority.
        do{try await review(origin,check:check,exchange:exchange,ask:ask)}
        catch{NSLog("Saleh provisioning phase: poll-failed");cancel(origin);await origin.cleanup?.value;throw Failure(cause:origin.cleanupError ?? error)}
    }
    func execute(requestId:String,setupId:String?=nil,check:@escaping() throws -> Void,
                 original:@escaping() async throws -> [String:Any],exchange:@escaping Exchange,
                 ask:@escaping Ask,dismiss:@escaping(String)->Void,observe:Observe?=nil,cancelSetup:(() async throws -> Void)?=nil) async throws -> [String:Any] {
        _ = try Self.uuid(requestId);try check();guard !Task.isCancelled,origins[requestId]==nil,origins.count<256 else{throw Failure()}
        if let setupId{_ = try Self.uuid(setupId);guard setups[setupId]==nil else{throw Failure()}}
        let origin=Origin(requestId,dismiss:dismiss,cancelSetup:cancelSetup,observe:observe);origins[requestId]=origin;if let setupId{setups[setupId]=requestId}
        origin.deadline=Task{@MainActor in
            do{try await Task.sleep(nanoseconds:UInt64(timeout*1_000_000_000));NSLog("Saleh provisioning phase: deadline-expired");origin.failure=Failure();cancel(origin)}catch is CancellationError{}catch{origin.failure=error;cancel(origin)}
        }
        let operation=Task{@MainActor in
            do{origin.result = .success(try await original())}catch{NSLog("Saleh provisioning phase: request-failed");origin.result = .failure(error)}
            if setupId==nil || {if case .failure=origin.result{return true};return false}(){
                origin.live=false;origin.poll?.cancel();origin.deadline?.cancel();origin.dismiss(origin.id)
            }
        };origin.original=operation
        if setupId==nil {
            origin.poll=Task{@MainActor in
                do{while origin.live{try await review(origin,check:check,exchange:exchange,ask:ask);try await Task.sleep(nanoseconds:500_000_000)}}
                catch{if origin.live{NSLog("Saleh provisioning phase: poll-failed");origin.failure=Failure();cancel(origin)}}
            }
        }
        await withTaskCancellationHandler(operation:{await operation.value;await origin.poll?.value},onCancel:{Task{@MainActor in self.cancel(origin)}})
        origin.original=nil;origin.poll=nil
        if setupId==nil{origins[requestId]=nil}
        do{
            if let failure=origin.failure{throw failure};if Task.isCancelled{throw Failure()};try check()
            guard let result=origin.result else{throw Failure()};return try result.get()
        }catch{
            cancel(origin);await origin.cleanup?.value
            if setupId != nil{throw Failure(cause:origin.cleanupError ?? error)};throw error
        }
    }
}
