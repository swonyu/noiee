import Foundation
import CoreFoundation
import CryptoKit
import Darwin

enum FetchPluginRequest {
    struct Value {let action:String,enabled:Bool?}
    static func parse(_ input:[String:Any]) throws -> Value {
        guard let action=input["action"] as? String,["catalog","install","set_enabled"].contains(action),
              Set(input.keys)==(action=="set_enabled" ? ["action","enabled"]:["action"]) else {throw FetchPluginSession.failure("Invalid fixed Fetch request.")}
        if action=="set_enabled" {
            guard let value=input["enabled"] as? NSNumber,CFGetTypeID(value)==CFBooleanGetTypeID() else {throw FetchPluginSession.failure("Fetch enabled must be a Boolean.")}
            return Value(action:action,enabled:value.boolValue)
        }
        return Value(action:action,enabled:nil)
    }
}

// One fixed bundled payload. No package, command, path or environment comes
// from a tool argument. The app parent is derived by the native caller.
@MainActor final class FetchPluginSession {
    static let revision="f14622be6addadd62adade8fe848ad68bc8c8db8a62f74ef29ca74948036ea8f"
    private static let python="/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/bin/python3.14"
    private static let framework="/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/Python"
    private static let helperSHA="c873c82529acb67bf51d9aa2c38e4b88443df38f2711df4c6fa95d29bbb52970"
    private var generation=UUID(),worker:Task<[String:Any],Error>?,process:Process?
    var active:Bool {worker != nil}
    nonisolated static func failure(_ text:String) -> Error {NSError(domain:"FixedFetchPlugin",code:1,userInfo:[NSLocalizedDescriptionKey:text])}
    func invalidate() {
        generation=UUID();worker?.cancel()
        // Keep ownership until termination and pipe EOF. The fixed helper
        // handles SIGTERM and checks it before each publication boundary.
        if let process,process.isRunning {process.terminate()}
    }
    func drain() async {if let worker {_ = await worker.result}}
    private static func fileVersion(_ value:stat) -> [String] {
        [String(value.st_dev),String(value.st_ino),String(value.st_mode),String(value.st_uid),String(value.st_gid),String(value.st_nlink),String(value.st_size),String(value.st_mtimespec.tv_sec),String(value.st_mtimespec.tv_nsec),String(value.st_ctimespec.tv_sec),String(value.st_ctimespec.tv_nsec)]
    }
    private static func verifyFile(_ path:String,sha:String,bytes:Int) throws {
        guard URL(fileURLWithPath:path).resolvingSymlinksInPath().path==path else {throw failure("Qualified Fetch dependency has a changed canonical path.")}
        var before=stat();guard lstat(path,&before)==0,before.st_mode&S_IFMT==S_IFREG,before.st_uid==getuid(),before.st_nlink==1,before.st_mode&0o022==0,before.st_size==bytes else {throw failure("Qualified Fetch dependency is unavailable or its metadata changed.")}
        let fd=open(path,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);guard fd>=0 else {throw failure("Qualified Fetch dependency could not be opened.")};defer{close(fd)}
        var opened=stat();guard fstat(fd,&opened)==0,fileVersion(opened)==fileVersion(before) else {throw failure("Qualified Fetch dependency changed before inspection.")}
        var digest=SHA256(),buffer=[UInt8](repeating:0,count:65536),total=0
        while true {
            let count=Darwin.read(fd,&buffer,buffer.count)
            if count<0 && errno==EINTR {continue}
            guard count>=0 else {throw failure("Qualified Fetch dependency could not be read.")}
            if count==0 {break};total+=count;guard total<=bytes else {throw failure("Qualified Fetch dependency exceeds its bound.")};digest.update(data:Data(buffer.prefix(count)))
        }
        var after=stat(),current=stat()
        guard total==bytes,digest.finalize().map({String(format:"%02x",$0)}).joined()==sha,fstat(fd,&after)==0,lstat(path,&current)==0,fileVersion(before)==fileVersion(after),fileVersion(before)==fileVersion(current) else {throw failure("Qualified Fetch dependency bytes or identity changed.")}
    }
    private static func verifyDependencies(_ resources:URL) throws -> URL {
        try verifyFile(python,sha:"1b5cb11d163e5ba34e2a05fc533c0ed89574d4425f9749a9d89405f651980e0d",bytes:34640)
        try verifyFile(framework,sha:"ea96cfe3ee0190f17c4f907a321f8aadbca35eee47285e329ad243347be6a8b9",bytes:5467456)
        let helper=resources.appendingPathComponent("fetch-plugin-runtime.py")
        try verifyFile(helper.path,sha:helperSHA,bytes:16116)
        return helper
    }
    func perform(_ input:[String:Any],parent:URL,resources:URL?) async throws -> [String:Any] {
        let request=try FetchPluginRequest.parse(input),expected=generation
        guard !active,!Task.isCancelled else {throw Self.failure("Fetch work is pending or stopped. Inspect its catalog before retrying.")}
        guard let resources else {throw Self.failure("The fixed Fetch resources are unavailable.")}
        let helper:URL
        do {helper=try Self.verifyDependencies(resources)}
        catch {
            if request.action=="catalog" {return ["id":"managed-fetch","version":"2026.10.24","license":"MIT","revision":Self.revision,"available":false,"installed":NSNull(),"enabled":NSNull(),"needsConnect":true,"connected":false,"message":error.localizedDescription+" Fetch requires the qualified existing Homebrew Python 3.14.8; no interpreter is installed automatically."]}
            throw error
        }
        guard expected==generation,!Task.isCancelled else {throw Self.failure("Fetch work was stopped before launch.")}
        let task=Task {() throws -> [String:Any] in
            guard expected==self.generation,!Task.isCancelled else {throw Self.failure("Fetch work was stopped before launch.")}
            let child=Process(),output=Pipe()
            child.executableURL=URL(fileURLWithPath:Self.python)
            child.arguments=["-I","-B",helper.path,"--parent",parent.path,"--resources",resources.path,"--action",request.action]+(request.enabled.map{["--enabled",$0 ? "true":"false"]} ?? [])
            child.currentDirectoryURL=resources
            let base=parent.appendingPathComponent("extensions/fetch",isDirectory:true)
            child.environment=["HOME":base.appendingPathComponent("home").path,"TMPDIR":base.appendingPathComponent("tmp").path,"PATH":"/usr/bin:/bin","LANG":"en_US.UTF-8","LC_ALL":"en_US.UTF-8"]
            child.standardInput=FileHandle.nullDevice;child.standardOutput=output;child.standardError=FileHandle.nullDevice
            self.process=child
            let status:(Int32,Process.TerminationReason)=try await withCheckedThrowingContinuation {continuation in
                child.terminationHandler={process in continuation.resume(returning:(process.terminationStatus,process.terminationReason))}
                do {try child.run()}
                catch {child.terminationHandler=nil;continuation.resume(throwing:error)}
            }
            let data=output.fileHandleForReading.readDataToEndOfFile()
            guard data.count<=8192,let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw Self.failure("Fetch helper output is unavailable. Publication may be uncertain; inspect the catalog/state before retrying.")}
            guard status.0==0,status.1 == .exit,value["isError"] as? Bool != true else {throw Self.failure((value["message"] as? String ?? "Fetch helper did not exit normally.")+" Inspect retained state before retrying.")}
            _ = try Self.verifyDependencies(resources)
            guard expected==self.generation,!Task.isCancelled else {throw Self.failure("Fetch work was stopped. Publication may have completed; inspect its catalog/state before retrying.")}
            guard value["id"] as? String=="managed-fetch",value["revision"] as? String==Self.revision,value["version"] as? String=="2026.10.24" else {throw Self.failure("Fetch helper identity changed.")}
            return value
        }
        worker=task
        defer {worker=nil;process=nil}
        return try await task.value
    }
}
