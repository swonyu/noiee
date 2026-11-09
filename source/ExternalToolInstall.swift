import Foundation
import CoreFoundation
import CryptoKit
import Darwin

// Internet bytes remain inert data here. This module has no Process, import,
// executable probe, package manager, model-controlled path or environment.
enum ExternalToolInstall {
    static let limit = 1024 * 1024, rootName = "external-tools-v1", maximumEntries = 64
    static func fail(_ message: String) -> Error { NSError(domain:"ExternalToolInstall",code:1,userInfo:[NSLocalizedDescriptionKey:message]) }
    static func hash(_ data: Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]) }
    static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of:pattern,options:.regularExpression) != nil }
    static func sha(_ value: Any?) throws -> String {
        guard let value=value as? String,matches(value,"^[a-f0-9]{64}$") else {throw fail("An exact lowercase SHA-256 is required.")};return value
    }
    static func uuid(_ value: String) -> Bool { UUID(uuidString:value)?.uuidString.lowercased() == value }
    struct Proposal {
        let url: String, sha256: String, purpose: String
        var input: [String:Any] { ["action":"install","url":url,"sha256":sha256,"purpose":purpose] }
    }
    static func proposal(_ value: [String:Any]) throws -> Proposal {
        guard Set(value.keys)==["action","url","sha256","purpose"],value["action"] as? String=="install",
              let url=value["url"] as? String,url.utf8.count<=2048,
              matches(url,"^https://raw\\.githubusercontent\\.com/[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_.-]{1,100}/[a-f0-9]{40}/[A-Za-z0-9_./-]+\\.mjs$"),
              !url.split(separator:"/").contains(where:{$0=="." || $0==".."}),
              let purpose=value["purpose"] as? String,!purpose.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,purpose.utf8.count<=500,purpose.unicodeScalars.allSatisfy({$0.value>=32 && $0.value<=126}),
              !purpose.unicodeScalars.contains(where:{[.control,.format,.surrogate,.lineSeparator,.paragraphSeparator].contains($0.properties.generalCategory)}) else {throw fail("Only one public immutable raw.githubusercontent.com .mjs URL, SHA-256 and short purpose are supported. No credentials, queries, packages or install commands.")}
        return Proposal(url:url,sha256:try sha(value["sha256"]),purpose:purpose)
    }
    static func downloaded(_ value: [String:Any], for request: Proposal) throws -> Data {
        guard Set(value.keys)==["version","url","sha256","bytes","base64","sourceTrust"],
              let version=value["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,
              value["url"] as? String==request.url,value["sha256"] as? String==request.sha256,value["sourceTrust"] as? String=="unreviewed-external",
              let count=value["bytes"] as? NSNumber,CFGetTypeID(count) != CFBooleanGetTypeID(),count.doubleValue>=1,count.doubleValue<=Double(limit),
              let encoded=value["base64"] as? String,encoded.utf8.count<=(limit+2)/3*4,
              let data=Data(base64Encoded:encoded),data.base64EncodedString()==encoded,count.doubleValue==Double(data.count),hash(data)==request.sha256,
              let text=String(data:data,encoding:.utf8),!text.contains("\0") else {throw fail("Downloaded artifact identity, size or encoding differs from the exact proposal. Nothing was installed.")}
        return data
    }
    static func directoryIdentity(_ value: stat) -> [String] {
        [String(value.st_dev),String(value.st_ino),String(value.st_mode),String(value.st_uid),String(value.st_gid),String(value.st_birthtimespec.tv_sec),String(value.st_birthtimespec.tv_nsec)]
    }
    static func version(_ value: stat) -> [String] { directoryIdentity(value)+[String(value.st_nlink),String(value.st_size),String(value.st_mtimespec.tv_sec),String(value.st_mtimespec.tv_nsec),String(value.st_ctimespec.tv_sec),String(value.st_ctimespec.tv_nsec)] }
    static func owned(_ fd: Int32) throws {
        let value=try CodingTemporary.info(fd)
        guard value.st_mode&S_IFMT==S_IFDIR,value.st_uid==getuid(),value.st_mode&0o077==0 else {throw fail("External tool storage must be a private owned directory.")}
    }
    // Each ancestor is opened relative to its held predecessor. Verification
    // binds path identity and permissions; no symlink ancestor is followed.
    final class Chain {
        let parent: String
        var fds=[Int32](),names=[String](),identities=[[String]]()
        var fd: Int32 {fds.last!}
        init(_ parent: String) throws {
            self.parent=parent
            guard parent.hasPrefix("/"),parent.utf8.count<=4096,parent.split(separator:"/").count<=128 else {throw fail("Invalid app-owned parent.")}
            try CodingTemporary.canonical(parent)
            do {
                let root=try CodingTemporary.checked(open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),"Open root")
                fds.append(root);names.append("/");identities.append(directoryIdentity(try CodingTemporary.info(root)))
                for name in parent.split(separator:"/") {try append(String(name))}
                let value=try CodingTemporary.info(fd)
                guard value.st_uid==getuid(),value.st_mode&0o022==0 else {throw fail("App-owned parent is not protected from other writers.")}
                try verify()
            } catch {for fd in fds {close(fd)};fds=[];throw error}
        }
        deinit {for fd in fds {close(fd)}}
        func append(_ name: String, create: Bool=false) throws {
            guard !name.isEmpty,!name.contains("/"),name != ".",name != ".." else {throw fail("Invalid owned storage component.")}
            var before=stat()
            if fstatat(fd,name,&before,AT_SYMLINK_NOFOLLOW) != 0 {
                guard errno==ENOENT,create else {throw fail("Owned storage entry is missing or inaccessible.")}
                _ = try CodingTemporary.checked(mkdirat(fd,name,0o700),"Create owned storage directory")
                _ = try CodingTemporary.checked(fsync(fd),"Sync owned storage parent")
                before=try CodingTemporary.namedInfo(fd,name)
            }
            guard before.st_mode&S_IFMT==S_IFDIR else {throw fail("Owned storage contains a symlink or unsupported entry.")}
            let child=try CodingTemporary.directory(fd,name)
            do {
                guard directoryIdentity(before)==directoryIdentity(try CodingTemporary.info(child)),directoryIdentity(before)==directoryIdentity(try CodingTemporary.namedInfo(fd,name)) else {throw fail("Owned storage changed while opening.")}
                if create {try owned(child)}
                fds.append(child);names.append(name);identities.append(directoryIdentity(before))
            } catch {close(child);throw error}
        }
        func verify() throws {
            try CodingTemporary.canonical(parent)
            for index in fds.indices {
                let named:stat
                if index==0 {var value=stat();_ = try CodingTemporary.checked(lstat("/",&value),"Check root");named=value}
                else {named=try CodingTemporary.namedInfo(fds[index-1],names[index])}
                guard directoryIdentity(named)==identities[index],directoryIdentity(try CodingTemporary.info(fds[index]))==identities[index] else {throw fail("Owned storage ancestor or permissions changed.")}
            }
        }
    }
    static func read(_ parent: Int32, _ name: String, limit: Int) throws -> Data {
        let before=try CodingTemporary.namedInfo(parent,name)
        guard before.st_mode&S_IFMT==S_IFREG,before.st_uid==getuid(),before.st_nlink==1,before.st_mode&0o777==0o400,before.st_size>0,before.st_size<=limit else {throw fail("Artifact or receipt must be a bounded, single-link, read-only owned file.")}
        let fd=try CodingTemporary.checked(openat(parent,name,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC),"Read owned artifact");defer{close(fd)}
        guard version(before)==version(try CodingTemporary.info(fd)) else {throw fail("Artifact identity changed before reading.")}
        var data=Data(),buffer=[UInt8](repeating:0,count:65536)
        while true {
            let count=Darwin.read(fd,&buffer,min(buffer.count,limit+1-data.count))
            if count<0 && errno==EINTR {continue};guard count>=0 else {throw fail("Artifact read failed.")}
            if count==0 {break};data.append(contentsOf:buffer.prefix(count));guard data.count<=limit else {throw fail("Artifact grew beyond its bound.")}
        }
        guard data.count==before.st_size,version(before)==version(try CodingTemporary.info(fd)),version(before)==version(try CodingTemporary.namedInfo(parent,name)) else {throw fail("Artifact changed while reading.")}
        return data
    }
    static func write(_ parent: Int32, _ name: String, _ data: Data) throws {
        let fd=try CodingTemporary.checked(openat(parent,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600),"Create new artifact file");defer{close(fd)}
        var offset=0
        while offset<data.count {
            let count=data.withUnsafeBytes{Darwin.write(fd,$0.baseAddress!.advanced(by:offset),data.count-offset)}
            if count<0 && errno==EINTR {continue};guard count>0 else {throw fail("Artifact write is incomplete; stage retained.")};offset+=count
        }
        _ = try CodingTemporary.checked(fchmod(fd,0o400),"Protect artifact")
        _ = try CodingTemporary.checked(fsync(fd),"Sync artifact")
        guard try read(parent,name,limit:max(limit,16384))==data else {throw fail("New artifact bytes changed.")}
    }
    static func names(_ fd: Int32) throws -> [String] {
        let copy=try CodingTemporary.directory(fd,".")
        guard let stream=fdopendir(copy) else {close(copy);throw fail("Storage inventory unavailable.")};defer{closedir(stream)}
        var names=[String]()
        while true {
            errno=0
            guard let entry=readdir(stream) else {guard errno==0 else {throw fail("Storage inventory failed.")};break}
            let name=withUnsafePointer(to:&entry.pointee.d_name){$0.withMemoryRebound(to:CChar.self,capacity:Int(entry.pointee.d_namlen)+1){String(cString:$0)}}
            if name=="." || name==".." {continue};names.append(name)
            guard names.count<=maximumEntries else {throw fail("Retained external-tool storage reached its entry bound. Nothing was removed.")}
        }
        return names.sorted()
    }
    static func destination(_ parent: String, _ sha256: String) -> String { parent+"/"+rootName+"/revisions/"+sha256 }
    struct Scope {let parent:String,binding:[[String]]}
    static func scope(_ parent: String) throws -> Scope {let chain=try Chain(parent);return Scope(parent:parent,binding:chain.identities)}
    static func verify(_ scope: Scope) throws -> Chain {
        let chain=try Chain(scope.parent);guard chain.identities==scope.binding else {throw fail("App-owned parent changed since review.")};return chain
    }
    static func install(_ scope: Scope, proposal: Proposal, data: Data, operation: String, generation: String, check:(String)throws->Void) throws -> [String:Any] {
        guard uuid(operation),uuid(generation),hash(data)==proposal.sha256,data.count<=limit else {throw fail("Invalid exact artifact installation.")}
        let chain=try verify(scope);try check("beforeCreate")
        try chain.append(rootName,create:true);try chain.append("revisions",create:true);try chain.verify();try owned(chain.fd)
        let existing=try names(chain.fd)
        guard existing.count<maximumEntries,!existing.contains(proposal.sha256) else {throw fail("This immutable revision already exists or storage is full. Inspect it; nothing was overwritten.")}
        let stage=".stage-"+operation
        try check("beforeStage");try chain.verify()
        _ = try CodingTemporary.checked(mkdirat(chain.fd,stage,0o700),"Create exclusive artifact stage")
        let fd=try CodingTemporary.directory(chain.fd,stage);defer{close(fd)}
        let created=directoryIdentity(try CodingTemporary.info(fd));try owned(fd)
        let receipt:[String:Any]=["version":1,"kind":"inert-external-js-install","operationId":operation,"generation":generation,"url":proposal.url,"sha256":proposal.sha256,"bytes":data.count,"purpose":proposal.purpose,"sourceTrust":"unreviewed-external","launch":"never-started"]
        let raw=try json(receipt)
        do {
            try write(fd,"artifact.mjs",data);try check("afterContent");try write(fd,"receipt.json",raw)
            try CodingTemporary.requireContents(fd,["artifact.mjs","receipt.json"])
            _ = try CodingTemporary.checked(fsync(fd),"Sync staged revision")
            try check("beforePublish");try chain.verify();try owned(chain.fd);try owned(fd)
            guard created==directoryIdentity(try CodingTemporary.namedInfo(chain.fd,stage)),created==directoryIdentity(try CodingTemporary.info(fd)),try read(fd,"artifact.mjs",limit:limit)==data,try read(fd,"receipt.json",limit:16384)==raw else {throw fail("Staged artifact or receipt changed.")}
            try check("publication");try chain.verify()
            guard created==directoryIdentity(try CodingTemporary.namedInfo(chain.fd,stage)),created==directoryIdentity(try CodingTemporary.info(fd)),try read(fd,"artifact.mjs",limit:limit)==data,try read(fd,"receipt.json",limit:16384)==raw else {throw fail("Staged bytes changed at publication.")}
            try CodingTemporary.requireContents(fd,["artifact.mjs","receipt.json"])
            _ = try CodingTemporary.checked(renameatx_np(chain.fd,stage,chain.fd,proposal.sha256,UInt32(RENAME_EXCL)),"Publish immutable external artifact")
            try check("afterPublish")
            _ = try CodingTemporary.checked(fsync(chain.fd),"Sync published artifact")
            try chain.verify()
            guard created==directoryIdentity(try CodingTemporary.namedInfo(chain.fd,proposal.sha256)),try read(fd,"artifact.mjs",limit:limit)==data,try read(fd,"receipt.json",limit:16384)==raw else {throw fail("Published artifact changed.")}
            return ["state":"installed-inert","operationId":operation,"revision":proposal.sha256,"path":destination(scope.parent,proposal.sha256),"receiptSHA256":hash(raw),"installed":true,"connected":false,"executable":false,"message":"Exact artifact stored inertly. No external code ran. Use connect with this exact revision for a separate mandatory launch review. No MCP configuration or provider was changed."]
        } catch {throw fail("Installation publication is unconfirmed. Inspect revision "+proposal.sha256+" and retained operation "+operation+" before retrying. No external code ran. "+error.localizedDescription)}
    }
    static func inspect(_ parent: String) throws -> [String:Any] {
        let chain=try Chain(parent)
        var metadata=stat()
        if fstatat(chain.fd,rootName,&metadata,AT_SYMLINK_NOFOLLOW) != 0,errno==ENOENT {return ["entries":[],"message":"No external artifacts installed. No external code ran."]}
        try chain.append(rootName);try owned(chain.fd);try chain.append("revisions");try owned(chain.fd)
        var entries=[[String:Any]]()
        for name in try names(chain.fd) {
            if name.hasPrefix(".stage-"),uuid(String(name.dropFirst(7))) {entries.append(["operationId":String(name.dropFirst(7)),"state":"retained-stage","installed":false]);continue}
            guard (try? sha(name)) != nil else {throw fail("Unexpected storage entry retained for inspection.")}
            let fd=try CodingTemporary.directory(chain.fd,name);defer{close(fd)};try owned(fd)
            let before=directoryIdentity(try CodingTemporary.info(fd)),data=try read(fd,"artifact.mjs",limit:limit),raw=try read(fd,"receipt.json",limit:16384)
            guard hash(data)==name,let receipt=try JSONSerialization.jsonObject(with:raw) as? [String:Any],Set(receipt.keys)==["version","kind","operationId","generation","url","sha256","bytes","purpose","sourceTrust","launch"],receipt["sha256"] as? String==name,receipt["launch"] as? String=="never-started",receipt["kind"] as? String=="inert-external-js-install",receipt["sourceTrust"] as? String=="unreviewed-external",
                  let operation=receipt["operationId"] as? String,uuid(operation),let generation=receipt["generation"] as? String,uuid(generation),let count=receipt["bytes"] as? NSNumber,CFGetTypeID(count) != CFBooleanGetTypeID(),count.doubleValue==Double(data.count),let version=receipt["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1 else {throw fail("Installed artifact receipt no longer matches its revision.")}
            _ = try proposal(["action":"install","url":receipt["url"] as Any,"sha256":name,"purpose":receipt["purpose"] as Any])
            try CodingTemporary.requireContents(fd,["artifact.mjs","receipt.json"]);try chain.verify()
            guard before==directoryIdentity(try CodingTemporary.namedInfo(chain.fd,name)) else {throw fail("Installed revision changed during inspection.")}
            entries.append(["revision":name,"operationId":operation,"state":"installed","installed":true,"connectionState":"inspect-runtime-status","path":destination(parent,name),"receiptSHA256":hash(raw)])
        }
        try chain.verify();return ["entries":entries,"message":"External artifacts inspected without execution. Retained stages are not installed tools."]
    }
}

@MainActor final class ExternalToolInstallSession {
    private var generation=UUID(),worker:Task<[String:Any],Error>?
    private var busy=false
    private var finished:[CheckedContinuation<Void,Never>]=[]
    func invalidate() {generation=UUID();worker?.cancel()}
    func drain() async {if busy {await withCheckedContinuation {finished.append($0)}}}
    func perform(_ input:[String:Any],parent:String,check:()throws->Void,download:([String:Any])async throws->[String:Any],ask:(String)async throws->Bool) async throws -> [String:Any] {
        guard !busy,worker==nil,!Task.isCancelled else {throw ExternalToolInstall.fail("External artifact work is pending or stopped.")}
        busy=true;defer{busy=false;let waiting=finished;finished=[];for continuation in waiting {continuation.resume()}}
        let expected=generation
        func requireCurrent() throws {try check();guard expected==generation,!Task.isCancelled else {throw ExternalToolInstall.fail("External artifact operation stopped. Inspect retained state before retrying.")}}
        try requireCurrent()
        if Set(input.keys)==["action"],input["action"] as? String=="inspect" {let value=try await Task.detached {try ExternalToolInstall.inspect(parent)}.value;try requireCurrent();return value}
        let proposal=try ExternalToolInstall.proposal(input),operation=UUID().uuidString.lowercased()
        let scope=try ExternalToolInstall.scope(parent)
        let response=try await download(proposal.input);try requireCurrent()
        let data=try ExternalToolInstall.downloaded(response,for:proposal)
        let detail="Install inert external JavaScript artifact?\n\nSource trust: unknown, unreviewed external code. A hash proves identity, not trust.\nURL: \(proposal.url)\nSHA-256: \(proposal.sha256)\nBytes: \(data.count)\nPurpose supplied by the model (untrusted): \(proposal.purpose)\nDestination: \(ExternalToolInstall.destination(parent,proposal.sha256))\nOperation: \(operation)\n\nOnly this exact file and an immutable receipt will be installed. No code, imports, help/version probes, dependencies or package scripts run. A separate Connect once review is required before running this artifact as a tool. Launch requires an already unconfined non-recovery backend boot. Existing MCP and provider configuration stays unchanged. A later launch would run as your Mac user, not in an OS sandbox; a private HOME or working directory would only separate storage. Source content and tool descriptions cannot authorize execution."
        guard try await ask(detail) else {return ["cancelled":true,"installed":false,"connected":false,"message":"Installation cancelled. Downloaded bytes were not published or executed."]}
        try requireCurrent();_ = try ExternalToolInstall.verify(scope)
        let task=Task.detached(priority:.userInitiated) {try ExternalToolInstall.install(scope,proposal:proposal,data:data,operation:operation,generation:expected.uuidString.lowercased(),check:{_ in try Task.checkCancellation()})}
        worker=task;defer{worker=nil}
        let result=try await task.value;try requireCurrent();return result
    }
}
