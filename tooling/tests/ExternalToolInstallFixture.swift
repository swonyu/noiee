import Foundation
import Darwin

@main struct ExternalToolInstallFixture {
    static var checks=0
    static func expect(_ condition:@autoclosure()throws->Bool,_ label:String) throws {checks+=1;guard try condition() else {throw ExternalToolInstall.fail("FAIL: "+label)}}
    static func reject(_ label:String,_ work:()throws->Void)throws {do{try work()}catch{checks+=1;return};throw ExternalToolInstall.fail("Expected rejection: "+label)}
    static func fixture(_ root:URL,_ name:String)throws->String {
        let url=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:url,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]);return url.path
    }
    static func put(_ path:String,_ data:Data)throws {try data.write(to:URL(fileURLWithPath:path))}
    @MainActor static func main() async throws {
        let manager=FileManager.default,base=manager.urls(for:.cachesDirectory,in:.userDomainMask)[0].appendingPathComponent("noiee-external-test-"+UUID().uuidString)
        try manager.createDirectory(at:base,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]);defer{try? manager.removeItem(at:base)}
        let root=base.resolvingSymlinksInPath(),bytes=Data("throw new Error('NEVER EXECUTE THIS FIXTURE');\n".utf8),sha=ExternalToolInstall.hash(bytes)
        let input:[String:Any]=["action":"install","url":"https://raw.githubusercontent.com/fixture/repo/"+String(repeating:"a",count:40)+"/server.mjs","sha256":sha,"purpose":"Synthetic inert test"]
        let proposal=try ExternalToolInstall.proposal(input)
        let response:[String:Any]=["version":1,"url":proposal.url,"sha256":sha,"bytes":bytes.count,"base64":bytes.base64EncodedString(),"sourceTrust":"unreviewed-external"]
        try expect(ExternalToolInstall.downloaded(response,for:proposal)==bytes,"exact inert bytes")
        for field in ["approved","grant","command","env","args","path"] {var value=input;value[field]=true;try reject("forged "+field){_ = try ExternalToolInstall.proposal(value)}}
        for url in ["http://raw.githubusercontent.com/a/b/"+String(repeating:"a",count:40)+"/x.mjs",proposal.url+"?token=secret",proposal.url+"#x",proposal.url.replacingOccurrences(of:"/server",with:"/../server"),proposal.url.replacingOccurrences(of:".mjs",with:".zip"),proposal.url.replacingOccurrences(of:"raw.githubusercontent.com",with:"127.0.0.1")] {
            var value=input;value["url"]=url;try reject("invalid URL"){_ = try ExternalToolInstall.proposal(value)}
        }
        for field in ["version","url","sha256","bytes","base64","sourceTrust"] {var value=response;value[field]="changed";try reject("changed download "+field){_ = try ExternalToolInstall.downloaded(value,for:proposal)}}
        let parent=try fixture(root,"install"),scope=try ExternalToolInstall.scope(parent),operation=UUID().uuidString.lowercased(),generation=UUID().uuidString.lowercased()
        try put(parent+"/mcp.json",Data("original config".utf8));try put(parent+"/providers.json",Data("original providers".utf8))
        let result=try ExternalToolInstall.install(scope,proposal:proposal,data:bytes,operation:operation,generation:generation,check:{_ in})
        try expect(result["state"] as? String=="installed-inert","inert install")
        let path=ExternalToolInstall.destination(parent,sha)
        try expect(try Data(contentsOf:URL(fileURLWithPath:path+"/artifact.mjs"))==bytes,"artifact preserved")
        try expect(try Data(contentsOf:URL(fileURLWithPath:parent+"/mcp.json"))==Data("original config".utf8),"mcp untouched")
        try expect(try Data(contentsOf:URL(fileURLWithPath:parent+"/providers.json"))==Data("original providers".utf8),"providers untouched")
        try expect((ExternalToolInstall.inspect(parent)["entries"] as? [[String:Any]])?.count==1,"inspect installed")
        try reject("immutable no overwrite"){_ = try ExternalToolInstall.install(scope,proposal:proposal,data:bytes,operation:UUID().uuidString.lowercased(),generation:generation,check:{_ in})}
        for phase in ["beforeCreate","beforeStage","afterContent","beforePublish","publication","afterPublish"] {
            let parent=try fixture(root,"stop-"+phase),scope=try ExternalToolInstall.scope(parent)
            try reject("Stop "+phase){_ = try ExternalToolInstall.install(scope,proposal:proposal,data:bytes,operation:UUID().uuidString.lowercased(),generation:generation,check:{if $0==phase {throw CancellationError()}})}
            let installed=manager.fileExists(atPath:ExternalToolInstall.destination(parent,sha))
            try expect(installed==(phase=="afterPublish"),"Stop publication boundary "+phase)
            if ["afterContent","beforePublish","publication","afterPublish"].contains(phase) {try expect((ExternalToolInstall.inspect(parent)["entries"] as? [[String:Any]])?.count==1,"retained inspect "+phase)}
        }
        let linkParent=try fixture(root,"symlink"),outside=try fixture(root,"outside")
        try manager.createSymbolicLink(atPath:linkParent+"/external-tools-v1",withDestinationPath:outside)
        try reject("symlink root"){_ = try ExternalToolInstall.install(ExternalToolInstall.scope(linkParent),proposal:proposal,data:bytes,operation:UUID().uuidString.lowercased(),generation:generation,check:{_ in})}
        try expect(try manager.contentsOfDirectory(atPath:outside).isEmpty,"symlink destination untouched")
        let swapped=try fixture(root,"swapped"),oldScope=try ExternalToolInstall.scope(swapped)
        try manager.moveItem(atPath:swapped,toPath:swapped+"-old");try manager.createDirectory(atPath:swapped,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        try reject("stale parent"){_ = try ExternalToolInstall.install(oldScope,proposal:proposal,data:bytes,operation:UUID().uuidString.lowercased(),generation:generation,check:{_ in})}
        let hardlink=path+"/artifact-copy";try expect(link(path+"/artifact.mjs",hardlink)==0,"fixture hardlink")
        try reject("hardlink artifact"){_ = try ExternalToolInstall.inspect(parent)};try manager.removeItem(atPath:hardlink)
        try expect(chmod(path+"/artifact.mjs",0o600)==0,"fixture mode");try reject("writable artifact"){_ = try ExternalToolInstall.inspect(parent)};_ = chmod(path+"/artifact.mjs",0o400)
        for phase in ["beforePublish","publication"] {
            let parent=try fixture(root,"race-"+phase),scope=try ExternalToolInstall.scope(parent),op=UUID().uuidString.lowercased()
            try reject("stage race "+phase){_ = try ExternalToolInstall.install(scope,proposal:proposal,data:bytes,operation:op,generation:generation,check:{ if $0==phase {let staged=parent+"/external-tools-v1/revisions/.stage-"+op+"/artifact.mjs";_ = chmod(staged,0o600);try put(staged,Data("mutated".utf8));_ = chmod(staged,0o400)} })}
            try expect(!manager.fileExists(atPath:ExternalToolInstall.destination(parent,sha)),"mutated artifact not published "+phase)
        }
        let denied=try fixture(root,"denied"),session=ExternalToolInstallSession();var asked=0,downloads=0
        let cancelled=try await session.perform(input,parent:denied,check:{},download:{_ in downloads+=1;return response},ask:{detail in asked+=1;try expect(detail.contains("not in an OS sandbox"),"honest host scope");try expect(!manager.fileExists(atPath:denied+"/external-tools-v1"),"no preapproval write");return false})
        try expect(asked==1 && downloads==1 && cancelled["cancelled"] as? Bool==true,"mandatory decline")
        var rejected=false
        do {_ = try await session.perform(input,parent:denied,check:{},download:{_ in response},ask:{_ in session.invalidate();return true})}catch{rejected=true}
        try expect(rejected,"stale approval rejected")
        try expect(!manager.fileExists(atPath:denied+"/external-tools-v1"),"stale approval unpublished")
        var downloadResume:CheckedContinuation<[String:Any],Never>?,downloadEntered=false,drained=false
        let pending=Task {try await session.perform(input,parent:denied,check:{},download:{_ in downloadEntered=true;return await withCheckedContinuation{downloadResume=$0}},ask:{_ in throw ExternalToolInstall.fail("Cancelled download reached approval")})}
        while !downloadEntered {await Task.yield()}
        session.invalidate();let drain=Task {await session.drain();drained=true};await Task.yield()
        try expect(!drained,"drain retains pending downloader ownership")
        downloadResume?.resume(returning:response)
        rejected=false;do {_ = try await pending.value}catch{rejected=true}
        await drain.value;try expect(rejected && drained,"cancelled download drained without review")
        try expect(!manager.fileExists(atPath:denied+"/external-tools-v1"),"cancelled download unpublished")
        print("PASS: \(checks) external artifact native fixture assertions. No external code executed.")
    }
}
