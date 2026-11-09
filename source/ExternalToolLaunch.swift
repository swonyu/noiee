import Foundation
import Darwin

import CoreFoundation

// The only wire commit is constructed here after mandatory native consent. A
// model-supplied approval flag, config, path, nonce or grant is never accepted.
enum ExternalToolLaunch {
    static let loader="import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';const expected=process.argv[1];if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('Invalid reviewed revision');let size=0;const chunks=[];for await(const chunk of createReadStream(null,{fd:3,autoClose:true,highWaterMark:65536})){size+=chunk.length;if(size>1048576)throw Error('External source exceeds bound');chunks.push(chunk);}const source=Buffer.concat(chunks);if(!size||createHash('sha256').update(source).digest('hex')!==expected)throw Error('External source digest mismatch');await import('data:text/javascript;base64,'+source.toString('base64'));"
    struct Review {
        let object:[String:Any],revision:String,launchID:String,fingerprint:String,parent:String,receiptSHA256:String
        let snapshot:Data
        var commit:[String:Any] { ["action":"commit","prepareId":object["prepareId"]!,"nonce":object["nonce"]!,"fingerprint":fingerprint] }
        var run:String {parent+"/"+ExternalToolInstall.rootName+"/runs/"+launchID}
        var detail:String {
            "Connect this unknown-source external tool once?\n\nSource trust: unreviewed external code. SHA-256 identifies bytes, not trust.\n\nRuns as your Mac user with host filesystem and network access. It is NOT an OS sandbox. Private HOME, temporary and working directories only separate storage; the program may access other files, accounts and services available to your Mac user. No saved app credential or ambient environment is passed.\n\nApproval applies once to the exact artifact, runtime, arguments, environment, paths and configuration below. Tool descriptions and schemas remain untrusted. Stop disconnects the owned provider but cannot undo code effects or prove detached descendants exited. There is no automatic reconnection or recovery.\n\nExact launch review:\n"+String(decoding:snapshot,as:UTF8.self)
        }
    }
    static func request(_ input:[String:Any]) throws -> (String,String?) {
        guard let action=input["action"] as? String,["connect","disconnect","status"].contains(action),Set(input.keys)==(action=="status" ? ["action"]:["action","revision"]) else {throw ExternalToolInstall.fail("Unsupported external tool action. Model arguments cannot contain a launch grant or configuration.")}
        return (action,action=="status" ? nil:try ExternalToolInstall.sha(input["revision"]))
    }
    static func validate(_ value:[String:Any],revision:String,parent:String,contract:Data) throws -> Review {
        let keys:Set<String>=["version","createdAt","expiresAt","prepareId","nonce","operationId","generation","epoch","launchID","id","parent","root","revision","receiptSHA256","artifactIdentity","runtime","config","configHash","configFingerprint","fingerprint","unconfinedBoot","recoveryStartup","source"]
        guard Set(value.keys)==keys,let version=value["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,
              let epoch=value["epoch"] as? NSNumber,CFGetTypeID(epoch) != CFBooleanGetTypeID(),epoch.doubleValue>=0,epoch.doubleValue<=Double(Int32.max),epoch.doubleValue.rounded()==epoch.doubleValue,
              let unconfined=value["unconfinedBoot"] as? NSNumber,CFGetTypeID(unconfined)==CFBooleanGetTypeID(),unconfined.boolValue,
              let recovery=value["recoveryStartup"] as? NSNumber,CFGetTypeID(recovery)==CFBooleanGetTypeID(),!recovery.boolValue,
              value["revision"] as? String==revision,value["parent"] as? String==parent,value["root"] as? String==parent+"/"+ExternalToolInstall.rootName,value["id"] as? String=="external-js-"+revision else {throw ExternalToolInstall.fail("Launch review is invalid or this backend boot is not eligible. Use the existing access-mode/restart workflow; no setting was changed.")}
        let now=Date().timeIntervalSince1970*1000
        guard let created=value["createdAt"] as? NSNumber,CFGetTypeID(created) != CFBooleanGetTypeID(),let expiry=value["expiresAt"] as? NSNumber,CFGetTypeID(expiry) != CFBooleanGetTypeID(),created.doubleValue.rounded()==created.doubleValue,expiry.doubleValue.rounded()==expiry.doubleValue,created.doubleValue<=now,expiry.doubleValue>now,expiry.doubleValue-created.doubleValue==300000 else {throw ExternalToolInstall.fail("External launch review expired or has an invalid lifetime.")}
        for key in ["prepareId","operationId","generation","launchID"] {guard let id=value[key] as? String,ExternalToolInstall.uuid(id) else {throw ExternalToolInstall.fail("Invalid launch operation identity.")}}
        for key in ["nonce","receiptSHA256","artifactIdentity","configHash","configFingerprint","fingerprint"] {_ = try ExternalToolInstall.sha(value[key])}
        guard let source=value["source"] as? [String:Any],Set(source.keys)==["url","purpose","trust"],source["trust"] as? String=="unreviewed-external" else {throw ExternalToolInstall.fail("External source provenance is missing.")}
        _ = try ExternalToolInstall.proposal(["action":"install","url":source["url"] as Any,"purpose":source["purpose"] as Any,"sha256":revision])
        let launchID=value["launchID"] as! String,run=parent+"/"+ExternalToolInstall.rootName+"/runs/"+launchID
        guard let runtime=value["runtime"] as? [String:Any],Set(runtime.keys)==["executable","sha256","version","identity","contractSHA256"],
              let executable=runtime["executable"] as? String,executable.hasPrefix("/"),executable.utf8.count<=4096,!executable.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}),
              URL(fileURLWithPath:executable).standardizedFileURL.path==executable,
              let manifest=try JSONSerialization.jsonObject(with:contract) as? [String:Any],manifest["schemaVersion"] as? Int==1,
              let node=manifest["node"] as? [String:Any],runtime["sha256"] as? String==node["executableSHA256"] as? String,runtime["version"] as? String==node["version"] as? String,
              runtime["contractSHA256"] as? String==ExternalToolInstall.hash(contract) else {throw ExternalToolInstall.fail("External launch runtime differs from the app's qualified Node contract.")}
        for key in ["sha256","identity","contractSHA256"] {_ = try ExternalToolInstall.sha(runtime[key])}
        let expected:[String:Any]=["command":executable,"args":["--input-type=module","--eval",loader,"--",revision],"env":["HOME":run+"/home","TMPDIR":run+"/tmp","PATH":"/usr/bin:/bin","LANG":"C","LC_ALL":"C"],"cwd":run+"/work"]
        guard let config=value["config"] as? [String:Any],NSDictionary(dictionary:config).isEqual(to:expected) else {throw ExternalToolInstall.fail("Launch config contains unexpected arguments, credentials, environment or paths.")}
        guard value["configFingerprint"] as? String==ExternalToolInstall.hash(try ExternalToolInstall.json(expected)) else {throw ExternalToolInstall.fail("Reviewed config fingerprint is invalid.")}
        var bound=value;bound.removeValue(forKey:"fingerprint")
        guard value["fingerprint"] as? String==ExternalToolInstall.hash(try ExternalToolInstall.json(bound)) else {throw ExternalToolInstall.fail("Launch review fingerprint does not bind its exact displayed content.")}
        let snapshot=try ExternalToolInstall.json(value)
        guard snapshot.count<=32768 else {throw ExternalToolInstall.fail("Exact launch review exceeds display limits; nothing was truncated or approved.")}
        return Review(object:value,revision:revision,launchID:launchID,fingerprint:value["fingerprint"] as! String,parent:parent,receiptSHA256:value["receiptSHA256"] as! String,snapshot:snapshot)
    }
    static func pending(_ review:Review,scope:ExternalToolInstall.Scope,check:(String)throws->Void) throws {
        let chain=try ExternalToolInstall.verify(scope)
        try chain.append(ExternalToolInstall.rootName);try ExternalToolInstall.owned(chain.fd)
        try check("beforeRunParent");try chain.append("runs",create:true)
        guard try ExternalToolInstall.names(chain.fd).count<ExternalToolInstall.maximumEntries else {throw ExternalToolInstall.fail("External launch history is full; nothing was deleted.")}
        var info=stat()
        guard fstatat(chain.fd,review.launchID,&info,AT_SYMLINK_NOFOLLOW) != 0,errno==ENOENT else {throw ExternalToolInstall.fail("Launch destination already exists. Inspect the original operation; no overwrite or retry.")}
        let runs=chain.fd,stage=".stage-"+review.launchID
        try check("beforeRun");try chain.verify();_ = try CodingTemporary.checked(mkdirat(runs,stage,0o700),"Create exclusive launch stage")
        let run=try CodingTemporary.directory(runs,stage);defer{close(run)};try ExternalToolInstall.owned(run)
        let identity=ExternalToolInstall.directoryIdentity(try CodingTemporary.info(run))
        for name in ["home","tmp","work"] {
            try check("beforeRunDirectory");_ = try CodingTemporary.checked(mkdirat(run,name,0o700),"Create private external launch directory")
            let child=try CodingTemporary.directory(run,name);try ExternalToolInstall.owned(child);close(child)
        }
        try check("beforePending");try chain.verify()
        let raw=try ExternalToolInstall.json(["version":1,"kind":"external-js-launch-pending","review":review.object])
        try ExternalToolInstall.write(run,"pending.json",raw)
        try CodingTemporary.requireContents(run,["home","tmp","work","pending.json"])
        _ = try CodingTemporary.checked(fsync(run),"Sync pending external launch")
        try check("beforeRunPublish");try chain.verify()
        guard identity==ExternalToolInstall.directoryIdentity(try CodingTemporary.namedInfo(runs,stage)),identity==ExternalToolInstall.directoryIdentity(try CodingTemporary.info(run)),try ExternalToolInstall.read(run,"pending.json",limit:65536)==raw else {throw ExternalToolInstall.fail("Pending launch receipt changed; nothing was launched.")}
        try CodingTemporary.requireContents(run,["home","tmp","work","pending.json"])
        _ = try CodingTemporary.checked(renameatx_np(runs,stage,runs,review.launchID,UInt32(RENAME_EXCL)),"Publish exact pending launch without overwrite")
        _ = try CodingTemporary.checked(fsync(runs),"Sync external launch parent")
        try check("afterPending");try chain.verify()
        guard identity==ExternalToolInstall.directoryIdentity(try CodingTemporary.namedInfo(runs,review.launchID)),try ExternalToolInstall.read(run,"pending.json",limit:65536)==raw else {throw ExternalToolInstall.fail("Published launch receipt changed; nothing was launched.")}
    }
    static func inspect(_ parent:String) throws -> [[String:Any]] {
        let chain=try ExternalToolInstall.Chain(parent)
        var metadata=stat()
        if fstatat(chain.fd,ExternalToolInstall.rootName,&metadata,AT_SYMLINK_NOFOLLOW) != 0,errno==ENOENT {return []}
        try chain.append(ExternalToolInstall.rootName);try ExternalToolInstall.owned(chain.fd)
        if fstatat(chain.fd,"runs",&metadata,AT_SYMLINK_NOFOLLOW) != 0,errno==ENOENT {return []}
        try chain.append("runs");try ExternalToolInstall.owned(chain.fd)
        var results=[[String:Any]]()
        for name in try ExternalToolInstall.names(chain.fd) {
            if name.hasPrefix(".stage-"),ExternalToolInstall.uuid(String(name.dropFirst(7))) {results.append(["launchID":String(name.dropFirst(7)),"state":"staged-not-started","currentConnection":"not-started"]);continue}
            guard ExternalToolInstall.uuid(name) else {throw ExternalToolInstall.fail("Unknown external launch storage retained for inspection.")}
            let fd=try CodingTemporary.directory(chain.fd,name);defer{close(fd)};try ExternalToolInstall.owned(fd)
            var state="incomplete-before-launch",revision:String?
            if fstatat(fd,"pending.json",&metadata,AT_SYMLINK_NOFOLLOW)==0 {
                let raw=try ExternalToolInstall.read(fd,"pending.json",limit:65536)
                guard let pending=try JSONSerialization.jsonObject(with:raw) as? [String:Any],Set(pending.keys)==["version","kind","review"],pending["version"] as? Int==1,pending["kind"] as? String=="external-js-launch-pending",let review=pending["review"] as? [String:Any],review["launchID"] as? String==name,let hash=try? ExternalToolInstall.sha(review["revision"]) else {throw ExternalToolInstall.fail("External launch pending evidence is invalid.")}
                revision=hash;state="launch-uncertain"
                if fstatat(fd,"outcome.json",&metadata,AT_SYMLINK_NOFOLLOW)==0 {
                    let data=try ExternalToolInstall.read(fd,"outcome.json",limit:16384)
                    guard let outcome=try JSONSerialization.jsonObject(with:data) as? [String:Any],Set(outcome.keys)==["version","kind","launchID","fingerprint","state"],outcome["version"] as? Int==1,outcome["kind"] as? String=="external-js-launch-outcome",outcome["launchID"] as? String==name,outcome["fingerprint"] as? String==review["fingerprint"] as? String,let recorded=outcome["state"] as? String,["connected","not-started","launch-uncertain"].contains(recorded) else {throw ExternalToolInstall.fail("External launch outcome is invalid.")}
                    state="recorded-"+recorded
                } else if errno != ENOENT {throw ExternalToolInstall.fail("External launch outcome is unreadable.")}
            } else if errno != ENOENT {throw ExternalToolInstall.fail("External launch pending evidence is unreadable.")}
            if fstatat(fd,"closure.json",&metadata,AT_SYMLINK_NOFOLLOW)==0 {
                let data=try ExternalToolInstall.read(fd,"closure.json",limit:16384)
                guard let closed=try JSONSerialization.jsonObject(with:data) as? [String:Any],closed["kind"] as? String=="external-js-owned-closure",closed["launchID"] as? String==name,closed["revision"] as? String==revision,closed["ownedExitConfirmed"] as? Bool==true,closed["descendants"] as? String=="not-proven-terminated" else {throw ExternalToolInstall.fail("Retained owned closure evidence is invalid.")}
                state="owned-closed-descendants-unproven"
            } else if errno != ENOENT {throw ExternalToolInstall.fail("Owned closure evidence is unreadable.")}
            results.append(["launchID":name,"revision":revision as Any? ?? NSNull(),"state":state,"currentConnection":"not-established-by-receipt","restartRequiresInspection":true])
        }
        try chain.verify();return results
    }
    struct Rearm {
        let object:[String:Any],revision:String,id:String,fingerprint:String
        let snapshot:Data
        var detail:String {"Review prior uncertain external execution?\n\nThe exact prior attempts below have no verified owned shutdown or proven pre-spawn refusal. Code may already have changed files or accounts, and detached processes may still run. Inspect those effects before continuing. Acknowledgment does not mark prior work successful, stop descendants, undo effects or erase receipts. It only permits preparing a NEW separately reviewed launch; that launch can repeat effects. No code runs from this acknowledgment.\n\nPrior evidence (hashes identify retained bytes, not trust):\n"+String(decoding:snapshot,as:UTF8.self)}
    }
    static func rearmReview(_ value:[String:Any],revision:String) throws -> Rearm {
        guard Set(value.keys)==["version","kind","revision","rearmID","generation","epoch","createdAt","expiresAt","history","fingerprint"],value["kind"] as? String=="external-js-rearm-review",value["revision"] as? String==revision,
              let version=value["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.intValue==1,
              let id=value["rearmID"] as? String,ExternalToolInstall.uuid(id),let generation=value["generation"] as? String,ExternalToolInstall.uuid(generation),
              let epoch=value["epoch"] as? NSNumber,CFGetTypeID(epoch) != CFBooleanGetTypeID(),epoch.doubleValue>=0,epoch.doubleValue<=Double(Int32.max),epoch.doubleValue.rounded()==epoch.doubleValue,
              let created=value["createdAt"] as? NSNumber,CFGetTypeID(created) != CFBooleanGetTypeID(),let expiry=value["expiresAt"] as? NSNumber,CFGetTypeID(expiry) != CFBooleanGetTypeID(),created.doubleValue.rounded()==created.doubleValue,expiry.doubleValue.rounded()==expiry.doubleValue,created.doubleValue<=Date().timeIntervalSince1970*1000,expiry.doubleValue>Date().timeIntervalSince1970*1000,expiry.doubleValue-created.doubleValue==300000,
              let history=value["history"] as? [[String:Any]],!history.isEmpty,history.count<=64 else {throw ExternalToolInstall.fail("Prior-execution acknowledgment is missing, stale or invalid.")}
        var names=[String]()
        for row in history {
            guard Set(row.keys)==["launchID","fingerprint","pendingSHA256","outcomeSHA256","closureSHA256","classification"],let name=row["launchID"] as? String,ExternalToolInstall.uuid(name),let state=row["classification"] as? String,["not-started","owned-closed","unresolved"].contains(state) else {throw ExternalToolInstall.fail("Invalid prior external launch evidence.")}
            names.append(name);for key in ["fingerprint","pendingSHA256"] {_ = try ExternalToolInstall.sha(row[key])}
            for key in ["outcomeSHA256","closureSHA256"] {if !(row[key] is NSNull) {_ = try ExternalToolInstall.sha(row[key])}}
        }
        guard names==names.sorted(),Set(names).count==names.count,history.contains(where:{$0["classification"] as? String=="unresolved"}) else {throw ExternalToolInstall.fail("Re-arm must identify the exact unresolved prior attempts.")}
        let fingerprint=try ExternalToolInstall.sha(value["fingerprint"]);var bound=value;bound.removeValue(forKey:"fingerprint")
        guard fingerprint==ExternalToolInstall.hash(try ExternalToolInstall.json(bound)) else {throw ExternalToolInstall.fail("Prior execution review fingerprint changed.")}
        let snapshot=try ExternalToolInstall.json(value);guard snapshot.count<=65536 else {throw ExternalToolInstall.fail("Prior execution review is over limit; no truncated approval.")}
        return Rearm(object:value,revision:revision,id:id,fingerprint:fingerprint,snapshot:snapshot)
    }
    static func acknowledge(_ rearm:Rearm,scope:ExternalToolInstall.Scope,check:()throws->Void) throws {
        let chain=try ExternalToolInstall.verify(scope);try chain.append(ExternalToolInstall.rootName);try ExternalToolInstall.owned(chain.fd)
        try check();try chain.append("rearms",create:true)
        guard try ExternalToolInstall.names(chain.fd).count<64 else {throw ExternalToolInstall.fail("Prior-execution acknowledgment storage is full. Nothing was deleted.")}
        let raw=try ExternalToolInstall.json(["version":1,"kind":"external-js-rearm-acknowledgment","review":rearm.object,"decision":"acknowledge-uncertain-prior-effects"]),stage=".stage-"+rearm.id
        try check();try chain.verify();try ExternalToolInstall.write(chain.fd,stage,raw)
        try check();try chain.verify()
        guard try ExternalToolInstall.read(chain.fd,stage,limit:65536)==raw else {throw ExternalToolInstall.fail("Prior-execution acknowledgment changed.")}
        _ = try CodingTemporary.checked(renameatx_np(chain.fd,stage,chain.fd,rearm.id+".json",UInt32(RENAME_EXCL)),"Publish one exact prior-execution acknowledgment")
        _ = try CodingTemporary.checked(fsync(chain.fd),"Sync prior-execution acknowledgment");try chain.verify()
    }
    static func closure(_ value:[String:Any],parent:String) throws {
        guard Set(value.keys)==["version","kind","launchID","revision","fingerprint","ownedExitConfirmed","descendants"],let version=value["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,value["kind"] as? String=="external-js-owned-closure",let id=value["launchID"] as? String,ExternalToolInstall.uuid(id),let exited=value["ownedExitConfirmed"] as? NSNumber,CFGetTypeID(exited)==CFBooleanGetTypeID(),exited.boolValue,value["descendants"] as? String=="not-proven-terminated" else {throw ExternalToolInstall.fail("Owned external process closure is unconfirmed.")}
        let revision=try ExternalToolInstall.sha(value["revision"]),fingerprint=try ExternalToolInstall.sha(value["fingerprint"])
        let chain=try ExternalToolInstall.Chain(parent)
        for name in [ExternalToolInstall.rootName,"runs",id] {try chain.append(name);try ExternalToolInstall.owned(chain.fd)}
        let pending=try ExternalToolInstall.read(chain.fd,"pending.json",limit:65536)
        guard let object=try JSONSerialization.jsonObject(with:pending) as? [String:Any],object["kind"] as? String=="external-js-launch-pending",let review=object["review"] as? [String:Any],review["launchID"] as? String==id,review["revision"] as? String==revision,review["fingerprint"] as? String==fingerprint else {throw ExternalToolInstall.fail("Owned closure differs from the retained pending launch.")}
        let raw=try ExternalToolInstall.json(value);var metadata=stat()
        if fstatat(chain.fd,"closure.json",&metadata,AT_SYMLINK_NOFOLLOW)==0 {
            guard try ExternalToolInstall.read(chain.fd,"closure.json",limit:16384)==raw else {throw ExternalToolInstall.fail("Existing owned closure evidence differs and was retained.")}
        } else {
            guard errno==ENOENT else {throw ExternalToolInstall.fail("Owned closure evidence is inaccessible.")}
            try ExternalToolInstall.write(chain.fd,"closure.json",raw)
        }
        _ = try CodingTemporary.checked(fsync(chain.fd),"Sync owned external closure");try chain.verify()
    }
    static func closures(_ values:[[String:Any]],parent:String) throws {
        guard values.count<=64 else {throw ExternalToolInstall.fail("Owned external closure result exceeds its bound.")}
        for value in values {try closure(value,parent:parent)}
    }
    static func outcome(_ result:[String:Any],review:Review,scope:ExternalToolInstall.Scope) throws -> [String:Any] {
        guard result["revision"] as? String==review.revision,result["launchID"] as? String==review.launchID,result["fingerprint"] as? String==review.fingerprint,
              let state=result["launchState"] as? String,["connected","not-started","launch-uncertain"].contains(state),
              let connected=result["connected"] as? NSNumber,CFGetTypeID(connected)==CFBooleanGetTypeID(),connected.boolValue==(state=="connected") else {throw ExternalToolInstall.fail("External launch response is unconfirmed. The pending receipt is retained; inspect before retrying.")}
        let chain=try ExternalToolInstall.verify(scope)
        for name in [ExternalToolInstall.rootName,"runs",review.launchID] {try chain.append(name);try ExternalToolInstall.owned(chain.fd)}
        let pending=try ExternalToolInstall.read(chain.fd,"pending.json",limit:65536),expected=try ExternalToolInstall.json(["version":1,"kind":"external-js-launch-pending","review":review.object])
        guard pending==expected else {throw ExternalToolInstall.fail("Pending launch evidence changed. Outcome remains unconfirmed.")}
        let receipt:[String:Any]=["version":1,"kind":"external-js-launch-outcome","launchID":review.launchID,"fingerprint":review.fingerprint,"state":state]
        try ExternalToolInstall.write(chain.fd,"outcome.json",ExternalToolInstall.json(receipt))
        _ = try CodingTemporary.checked(fsync(chain.fd),"Sync external launch outcome");try chain.verify()
        var output=result;output.removeValue(forKey:"fingerprint")
        if state != "connected" {output["isError"]=true}
        output["message"]=state=="connected" ? "External tool connected after exact native review. Discover its untrusted catalog before calling. Runs as your Mac user, not an OS sandbox. No automatic reconnection.":state=="not-started" ? "External launch was refused before spawn. Installed artifact retained; inspect before another review.":"External code may have run. Completion is uncertain; inspect effects before any further attempt. No automatic retry."
        return output
    }
}

@MainActor final class ExternalToolLaunchSession {
    private var generation=UUID(),worker:Task<Void,Error>?,busy=false,finished=[CheckedContinuation<Void,Never>]()
    func invalidate() {generation=UUID();worker?.cancel()}
    func drain() async {if busy {await withCheckedContinuation{finished.append($0)}}}
    func perform(_ input:[String:Any],parent:String,contract:Data,check:()throws->Void,request:([String:Any])async throws->[String:Any],ask:(String)async throws->Bool,rearmAsk:(String)async throws->Bool={_ in false}) async throws -> [String:Any] {
        let (action,revision)=try ExternalToolLaunch.request(input)
        guard !busy,!Task.isCancelled else {throw ExternalToolInstall.fail("External launch review is already pending.")}
        busy=true;defer{busy=false;let waiting=finished;finished=[];for continuation in waiting {continuation.resume()}}
        let expected=generation
        func current() throws {try check();guard expected==generation,!Task.isCancelled else {throw ExternalToolInstall.fail("External launch was stopped. Inspect pending evidence before retrying.")}}
        try current()
        if action != "connect" {
            let value=try await request(input)
            if action=="disconnect",let closed=value["closure"] as? [String:Any] {try await Task.detached{try ExternalToolLaunch.closure(closed,parent:parent)}.value}
            try current();return value
        }
        let scope=try ExternalToolInstall.scope(parent)
        var prepared=try await request(["action":"prepare","revision":revision!]);try current()
        if Set(prepared.keys)==["needsRearm","review"],prepared["needsRearm"] as? Bool==true,let object=prepared["review"] as? [String:Any] {
            let rearm=try ExternalToolLaunch.rearmReview(object,revision:revision!)
            guard try await rearmAsk(rearm.detail) else {return ["cancelled":true,"connected":false,"message":"Prior uncertainty retained. No acknowledgment or new launch occurred."]}
            try current();_ = try ExternalToolLaunch.rearmReview(object,revision:revision!)
            let task=Task.detached(priority:.userInitiated){try ExternalToolLaunch.acknowledge(rearm,scope:scope,check:{try Task.checkCancellation()})};worker=task
            do {try await task.value;worker=nil;try current()}catch{worker=nil;throw error}
            let accepted=try await request(["action":"rearm","rearmID":rearm.id,"fingerprint":rearm.fingerprint]);try current()
            guard Set(accepted.keys)==["rearmed","revision","rearmID","fingerprint"],accepted["rearmed"] as? Bool==true,accepted["revision"] as? String==rearm.revision,accepted["rearmID"] as? String==rearm.id,accepted["fingerprint"] as? String==rearm.fingerprint else {throw ExternalToolInstall.fail("Prior execution acknowledgment was not confirmed; no launch occurred.")}
            prepared=try await request(["action":"prepare","revision":revision!]);try current()
        }
        let review=try ExternalToolLaunch.validate(prepared,revision:revision!,parent:parent,contract:contract)
        guard try await ask(review.detail) else {return ["cancelled":true,"connected":false,"message":"External launch declined. No run directory was created and no code executed."]}
        try current()
        _ = try ExternalToolLaunch.validate(prepared,revision:revision!,parent:parent,contract:contract)
        let task=Task.detached(priority:.userInitiated){try ExternalToolLaunch.pending(review,scope:scope,check:{_ in try Task.checkCancellation()})}
        worker=task
        do {try await task.value;worker=nil;try current()}
        catch {worker=nil;throw error}
        // Receipt precedes transport admission. A crash or lost response leaves
        // this exact attempt uncertain and the backend refuses automatic retry.
        let response=try await request(review.commit)
        // Record returned evidence even if Stop changed the UI generation while
        // the signed request was in flight. Never manufacture a success on Stop.
        let result=try await Task.detached {try ExternalToolLaunch.outcome(response,review:review,scope:scope)}.value
        try current();return result
    }
}
