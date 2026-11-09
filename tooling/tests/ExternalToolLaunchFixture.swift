import Foundation
import Darwin

@main struct ExternalToolLaunchFixture {
    static var checks=0
    static func expect(_ value:@autoclosure()throws->Bool,_ label:String)throws{checks+=1;guard try value() else{throw ExternalToolInstall.fail("FAIL: "+label)}}
    static func reject(_ label:String,_ work:()throws->Void)throws{var rejected=false;do{try work()}catch{rejected=true};try expect(rejected,label)}
    @MainActor static func main() async throws {
        if CommandLine.arguments.count==6,CommandLine.arguments[1]=="--validate-review" {
            let data=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2])),contract=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))
            let review=try JSONSerialization.jsonObject(with:data) as! [String:Any]
            _ = try ExternalToolLaunch.validate(review,revision:CommandLine.arguments[5],parent:CommandLine.arguments[4],contract:contract)
            print("PASS: production Node review canonical digest/config/runtime accepted by native validator without launch")
            return
        }
        let manager=FileManager.default,base=manager.urls(for:.cachesDirectory,in:.userDomainMask)[0].appendingPathComponent("noiee-launch-test-"+UUID().uuidString)
        try manager.createDirectory(at:base,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]);defer{try? manager.removeItem(at:base)}
        let parent=base.resolvingSymlinksInPath().path,artifact=Data("throw Error('never execute native fixture');".utf8),revision=ExternalToolInstall.hash(artifact)
        let proposal=try ExternalToolInstall.proposal(["action":"install","url":"https://raw.githubusercontent.com/fixture/repo/"+String(repeating:"a",count:40)+"/server.mjs","sha256":revision,"purpose":"Fixture only"])
        let scope=try ExternalToolInstall.scope(parent)
        _ = try ExternalToolInstall.install(scope,proposal:proposal,data:artifact,operation:UUID().uuidString.lowercased(),generation:UUID().uuidString.lowercased(),check:{_ in})
        let contract=try ExternalToolInstall.json(["schemaVersion":1,"node":["version":"v26.13.0","executableSHA256":String(repeating:"a",count:64)]])
        func prepared() throws -> [String:Any] {
            let launch=UUID().uuidString.lowercased(),run=parent+"/external-tools-v1/runs/"+launch
            let config:[String:Any]=["command":"/qualified/fixture/node","args":["--input-type=module","--eval",ExternalToolLaunch.loader,"--",revision],"env":["HOME":run+"/home","TMPDIR":run+"/tmp","PATH":"/usr/bin:/bin","LANG":"C","LC_ALL":"C"],"cwd":run+"/work"]
            let created=Int64(Date().timeIntervalSince1970*1000)
            var value:[String:Any]=["version":1,"createdAt":created,"expiresAt":created+300000,"prepareId":UUID().uuidString.lowercased(),"nonce":String(repeating:"b",count:64),"operationId":UUID().uuidString.lowercased(),"generation":UUID().uuidString.lowercased(),"epoch":0,"launchID":launch,"id":"external-js-"+revision,"parent":parent,"root":parent+"/external-tools-v1","revision":revision,"receiptSHA256":String(repeating:"c",count:64),"artifactIdentity":String(repeating:"d",count:64),"runtime":["executable":"/qualified/fixture/node","sha256":String(repeating:"a",count:64),"version":"v26.13.0","identity":String(repeating:"e",count:64),"contractSHA256":ExternalToolInstall.hash(contract)],"config":config,"configHash":String(repeating:"f",count:64),"configFingerprint":ExternalToolInstall.hash(try ExternalToolInstall.json(config)),"unconfinedBoot":true,"recoveryStartup":false,"source":["url":proposal.url,"purpose":proposal.purpose,"trust":"unreviewed-external"]]
            value["fingerprint"]=ExternalToolInstall.hash(try ExternalToolInstall.json(value));return value
        }
        let value=try prepared(),review=try ExternalToolLaunch.validate(value,revision:revision,parent:parent,contract:contract)
        try expect(review.detail.contains("NOT an OS sandbox"),"host scope disclosed")
        try expect(review.detail.contains(proposal.url),"source URL disclosed")
        for key in ["version","createdAt","expiresAt","prepareId","nonce","operationId","generation","epoch","launchID","id","parent","root","revision","receiptSHA256","artifactIdentity","runtime","config","configHash","configFingerprint","fingerprint","unconfinedBoot","recoveryStartup","source"] {
            var mutated=value;mutated[key]="changed";try reject("mutated "+key){_ = try ExternalToolLaunch.validate(mutated,revision:revision,parent:parent,contract:contract)}
        }
        for field in ["grant","approved","prepareId","nonce","fingerprint","command","env"] {try reject("model-forged "+field){_ = try ExternalToolLaunch.request(["action":"connect","revision":revision,field:true])}}
        var altered=value;var config=value["config"] as! [String:Any];config["args"]=["/bin/sh","-c","bad"];altered["config"]=config
        try reject("unexpected launch arguments"){_ = try ExternalToolLaunch.validate(altered,revision:revision,parent:parent,contract:contract)}
        try ExternalToolLaunch.pending(review,scope:scope,check:{_ in})
        try expect(manager.fileExists(atPath:review.run+"/pending.json"),"pending durable before commit")
        try reject("replayed native pending"){try ExternalToolLaunch.pending(review,scope:scope,check:{_ in})}
        let histories=try ExternalToolLaunch.inspect(parent);try expect(histories.count==1 && histories[0]["state"] as? String=="launch-uncertain","crash retained uncertain")
        let response:[String:Any]=["connected":true,"revision":revision,"launchID":review.launchID,"fingerprint":review.fingerprint,"launchState":"connected"]
        let result=try ExternalToolLaunch.outcome(response,review:review,scope:scope);try expect(result["connected"] as? Bool==true,"exact outcome")
        try expect((ExternalToolLaunch.inspect(parent).first?["state"] as? String)=="recorded-connected","history not live-state proof")
        try reject("outcome no overwrite"){_ = try ExternalToolLaunch.outcome(response,review:review,scope:scope)}
        let closed:[String:Any]=["version":1,"kind":"external-js-owned-closure","launchID":review.launchID,"revision":revision,"fingerprint":review.fingerprint,"ownedExitConfirmed":true,"descendants":"not-proven-terminated"]
        var forged=closed;forged["fingerprint"]=String(repeating:"f",count:64)
        try reject("forged owned closure"){try ExternalToolLaunch.closure(forged,parent:parent)}
        try ExternalToolLaunch.closure(closed,parent:parent);try ExternalToolLaunch.closure(closed,parent:parent)
        try expect((ExternalToolLaunch.inspect(parent).first?["state"] as? String)=="owned-closed-descendants-unproven","owned closure distinguishes detached uncertainty")
        for phase in ["beforeRunParent","beforeRun","beforeRunDirectory","beforePending","afterPending"] {
            let review=try ExternalToolLaunch.validate(prepared(),revision:revision,parent:parent,contract:contract)
            try reject("Stop "+phase){try ExternalToolLaunch.pending(review,scope:scope,check:{if $0==phase{throw CancellationError()}})}
            try expect(manager.fileExists(atPath:review.run+"/pending.json")==((phase=="afterPending")),"Stop durable point "+phase)
        }
        let race=try ExternalToolLaunch.validate(prepared(),revision:revision,parent:parent,contract:contract)
        try reject("exclusive run race"){try ExternalToolLaunch.pending(race,scope:scope,check:{if $0=="beforeRun" {try manager.createDirectory(atPath:race.run,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}})}
        try expect(try manager.contentsOfDirectory(atPath:race.run).isEmpty,"race destination retained unchanged")
        let session=ExternalToolLaunchSession();var requests=0,asks=0
        let rejected=try await session.perform(["action":"connect","revision":revision],parent:parent,contract:contract,check:{},request:{body in requests+=1;try expect(body["action"] as? String=="prepare","declined review never commits");return try prepared()},ask:{_ in asks+=1;return false})
        try expect(requests==1 && asks==1 && rejected["cancelled"] as? Bool==true,"mandatory review decline")
        var stale=false
        do {_ = try await session.perform(["action":"connect","revision":revision],parent:parent,contract:contract,check:{},request:{_ in try prepared()},ask:{_ in session.invalidate();return true})}catch{stale=true}
        try expect(stale,"stale review rejected")
        var commitCount=0
        let connected=try await session.perform(["action":"connect","revision":revision],parent:parent,contract:contract,check:{},request:{body in
            if body["action"] as? String=="prepare" {return try prepared()}
            commitCount+=1;try expect(Set(body.keys)==["action","prepareId","nonce","fingerprint"],"native-only exact commit")
            // Resolve only synthetic pending receipts in our disposable root.
            let runs=try manager.contentsOfDirectory(atPath:parent+"/external-tools-v1/runs")
            for name in runs {
                let url=URL(fileURLWithPath:parent+"/external-tools-v1/runs/"+name+"/pending.json")
                guard let raw=try? Data(contentsOf:url),let pending=try JSONSerialization.jsonObject(with:raw) as? [String:Any],let bound=pending["review"] as? [String:Any],bound["fingerprint"] as? String==body["fingerprint"] as? String else {continue}
                return ["connected":true,"revision":revision,"launchID":name,"fingerprint":body["fingerprint"]!,"launchState":"connected"]
            }
            throw ExternalToolInstall.fail("Missing synthetic pending receipt")
        },ask:{_ in true})
        try expect(commitCount==1 && connected["connected"] as? Bool==true,"one native-approved commit")
        func rearmValue() throws -> [String:Any] {
            let created=Int64(Date().timeIntervalSince1970*1000)
            let history:[[String:Any]]=[["launchID":review.launchID,"fingerprint":review.fingerprint,"pendingSHA256":String(repeating:"a",count:64),"outcomeSHA256":NSNull(),"closureSHA256":NSNull(),"classification":"unresolved"]]
            var value:[String:Any]=["version":1,"kind":"external-js-rearm-review","revision":revision,"rearmID":UUID().uuidString.lowercased(),"generation":UUID().uuidString.lowercased(),"epoch":0,"createdAt":created,"expiresAt":created+300000,"history":history]
            value["fingerprint"]=ExternalToolInstall.hash(try ExternalToolInstall.json(value));return value
        }
        let rearmObject=try rearmValue(),rearm=try ExternalToolLaunch.rearmReview(rearmObject,revision:revision)
        try expect(rearm.detail.contains("detached processes may still run") && rearm.detail.contains("NEW separately reviewed launch"),"rearm does not claim cleanup or execution authority")
        for key in ["version","kind","revision","rearmID","generation","epoch","createdAt","expiresAt","history","fingerprint"] {var bad=rearmObject;bad[key]="forged";try reject("forged rearm "+key){_ = try ExternalToolLaunch.rearmReview(bad,revision:revision)}}
        try ExternalToolLaunch.acknowledge(rearm,scope:scope,check:{})
        try expect(manager.fileExists(atPath:parent+"/external-tools-v1/rearms/"+rearm.id+".json"),"acknowledgment immutable publication")
        try reject("ack replay no overwrite"){try ExternalToolLaunch.acknowledge(rearm,scope:scope,check:{})}
        var step=0,launchAsks=0,rearmAsks=0
        let next=try prepared(),nextReview=try ExternalToolLaunch.validate(next,revision:revision,parent:parent,contract:contract),ack=try rearmValue()
        let rearmed=try await session.perform(["action":"connect","revision":revision],parent:parent,contract:contract,check:{},request:{body in
            step+=1
            switch step {
            case 1:try expect(body["action"] as? String=="prepare","first retained inspection");return ["needsRearm":true,"review":ack]
            case 2:try expect(body["action"] as? String=="rearm" && body["rearmID"] as? String==ack["rearmID"] as? String,"native acknowledgment dispatch");return ["rearmed":true,"revision":revision,"rearmID":ack["rearmID"]!,"fingerprint":ack["fingerprint"]!]
            case 3:try expect(body["action"] as? String=="prepare","new launch prepared only after acknowledgment");return next
            case 4:try expect(body["action"] as? String=="commit","new launch separately committed");return ["connected":true,"revision":revision,"launchID":nextReview.launchID,"fingerprint":nextReview.fingerprint,"launchState":"connected"]
            default:throw ExternalToolInstall.fail("Unexpected rearm request")
            }
        },ask:{_ in launchAsks+=1;return true},rearmAsk:{_ in rearmAsks+=1;return true})
        try expect(step==4 && launchAsks==1 && rearmAsks==1 && rearmed["connected"] as? Bool==true,"uncertainty and new launch require distinct native approvals")
        print("PASS: \(checks) external launch native fixture assertions. No provider or external code executed.")
    }
}
