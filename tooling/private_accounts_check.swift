import Foundation

// Compile only connector sources and this entry point. Never constructs or calls
// PrivateAccountKeychain/PrivateAccountURLTransport; all stores/network are fake.
@MainActor final class FixtureCredentials:PrivateAccountCredentialStore {
    var grants:[PrivateAccountProvider:PrivateAccountGrant]=[:],reads=0,writes=0,removes=0,fail=false
    func read(_ provider:PrivateAccountProvider)throws->PrivateAccountGrant? {reads+=1;if fail {throw NSError(domain:"SYNTHETIC_SECRET",code:1)};return grants[provider]}
    func insert(_ grant:PrivateAccountGrant)throws {writes+=1;if fail || grants[grant.provider] != nil {throw PrivateAccountFailure.storage};grants[grant.provider]=grant}
    func remove(_ provider:PrivateAccountProvider)throws {removes+=1;if fail {throw NSError(domain:"SYNTHETIC_SECRET",code:1)};grants[provider]=nil}
}
@MainActor final class FixtureHTTP:PrivateAccountTransport {
    var requests:[URLRequest]=[],body:Data=Data("{}".utf8),status=200,url:URL?,fail=false,hold=false
    var continuation:CheckedContinuation<Void,Never>?
    func send(_ request:URLRequest,maxBytes:Int)async throws->PrivateAccountHTTPResponse {
        requests.append(request)
        if hold {await withCheckedContinuation {continuation=$0}}
        if fail {throw NSError(domain:"SYNTHETIC_SECRET",code:1,userInfo:[NSLocalizedDescriptionKey:"SYNTHETIC_SECRET"])}
        return .init(url:url ?? request.url!,status:status,data:body)
    }
    func release(){continuation?.resume();continuation=nil}
}
@main struct PrivateAccountsCheck {
    @MainActor static var assertions=0
    @MainActor static func expect(_ condition:Bool,_ name:String) {assertions+=1;guard condition else {fatalError("FAIL: "+name)}}
    @MainActor static func rejects(_ name:String,_ expected:PrivateAccountFailure?=nil,_ block:()throws->Void) {
        do {try block();fatalError("FAIL: accepted "+name)} catch {
            expect(expected==nil || error as? PrivateAccountFailure==expected,"failure classification "+name)
            expect(!error.localizedDescription.contains("SYNTHETIC_SECRET"),"sanitized failure "+name)
        }
    }
    @MainActor static func rejectsAsync(_ name:String,_ expected:PrivateAccountFailure?=nil,_ block:()async throws->Void)async {
        do {try await block();fatalError("FAIL: accepted "+name)} catch {
            expect(expected==nil || error as? PrivateAccountFailure==expected,"failure classification "+name)
            expect(!error.localizedDescription.contains("SYNTHETIC_SECRET"),"sanitized failure "+name)
        }
    }
    static func bytes(_ object:Any)throws->Data {try JSONSerialization.data(withJSONObject:object)}
    @MainActor static func main()async throws {
        let now=Date(timeIntervalSince1970:1_800_000_000),secret="SYNTHETIC_SECRET"
        func grant(_ provider:PrivateAccountProvider,resources:Set<String>=[])throws->PrivateAccountGrant {
            try .init(provider:provider,token:secret,expiresAt:now.addingTimeInterval(3600),selectedResources:resources)
        }
        let gmail=try grant(.gmail),drive=try grant(.drive,resources:["picked_1"]),github=try grant(.github,resources:["OWNER/Repo"])
        let status=try PrivateAccountsAvailability.status(["action":"status"])
        let providers=status["providers"] as! [[String:Any]]
        expect(providers.count==3 && providers.allSatisfy {$0["state"] as? String=="unconfigured" && $0["connected"] as? Bool==false && $0["readAvailable"] as? Bool==false && $0["grantAvailable"] as? Bool==false},"all production accounts fail closed")
        for action in ["connect","token","read","revoke","disconnect"] {rejects("bridge "+action,.invalid) {_ = try PrivateAccountsAvailability.status(["action":action])}}
        rejects("bridge token payload",.invalid) {_ = try PrivateAccountsAvailability.status(["action":"status","token":secret])}
        rejects("invalid secret CRLF",.invalid) {_ = try PrivateAccountSecret("Bearer bad\r\n")}
        rejects("unselected drive grant",.invalid) {_ = try grant(.drive)}
        rejects("GitHub traversal grant",.invalid) {_ = try grant(.github,resources:["owner/.."])}
        var dumped="";dump(gmail,to:&dumped);dump(try PrivateAccountSecret(secret),to:&dumped)
        expect(!dumped.contains(secret) && !String(reflecting:gmail).contains(secret),"credential debug and reflection redaction")
        expect(github.selectedResources==["owner/repo"],"canonical selected repositories")
        let operations:[(PrivateAccountRead,PrivateAccountGrant)]=[
            (.gmailMessages(query:"from:a@example.com &alt=media",pageToken:"page+next/="),gmail),(.gmailMessageMetadata(id:"abc123"),gmail),
            (.driveFileMetadata(id:"picked_1"),drive),(.githubRepository(name:"owner/repo"),github),(.githubIssues(name:"owner/repo",page:1),github)]
        for (operation,g) in operations {
            let request=try operation.request(grant:g);try PrivateAccountURLTransport.validate(request,maxBytes:262144)
            expect(request.httpMethod=="GET" && request.httpBody==nil && !request.url!.absoluteString.contains(secret),"fixed GET headers only")
            expect(request.value(forHTTPHeaderField:"Authorization")=="Bearer "+secret,"native bearer injection")
            var mutation=request;mutation.httpMethod="POST";rejects("write transport",.invalid) {try PrivateAccountURLTransport.validate(mutation,maxBytes:262144)}
            mutation=request;mutation.url=URL(string:"https://evil.example/path")!;rejects("host transport",.invalid) {try PrivateAccountURLTransport.validate(mutation,maxBytes:262144)}
            mutation=request;mutation.url=URL(string:request.url!.absoluteString+"&access_token=bad")!;rejects("extra query transport",.invalid) {try PrivateAccountURLTransport.validate(mutation,maxBytes:262144)}
        }
        let request=try operations[0].0.request(grant:gmail)
        let params=URLComponents(url:request.url!,resolvingAgainstBaseURL:false)!.queryItems!
        expect(params.first {$0.name=="q"}!.value=="from:a@example.com &alt=media" && params.filter {$0.name=="alt"}.isEmpty,"query injection encoded")
        for invalid in ["../other","a/b","a%2Fb","a?key=1",""] {rejects("unsafe Gmail ID",.invalid) {_ = try PrivateAccountRead.gmailMessageMetadata(id:invalid).request(grant:gmail)}}
        rejects("unselected Drive file",.denied) {_ = try PrivateAccountRead.driveFileMetadata(id:"not_picked").request(grant:drive)}
        rejects("unselected repository",.denied) {_ = try PrivateAccountRead.githubRepository(name:"owner/other").request(grant:github)}
        rejects("cross-provider credential",.denied) {_ = try PrivateAccountRead.gmailMessageMetadata(id:"abc").request(grant:drive)}
        rejects("excessive paging",.invalid) {_ = try PrivateAccountRead.githubIssues(name:"owner/repo",page:1001).request(grant:github)}
        for path in ["https://api.github.com/user","https://www.googleapis.com/drive/v3/files","https://api.github.com/repos/owner/repo/contents/secrets","https://gmail.googleapis.com/gmail/v1/users/me/profile"] {
            rejects("unsupported endpoint",.invalid) {try PrivateAccountURLTransport.validate(URLRequest(url:URL(string:path)!),maxBytes:262144)}
        }
        let parsed=try PrivateAccountRead.gmailMessageMetadata(id:"abc").parse(bytes(["id":"abc","threadId":"thread1","snippet":secret,"payload":["headers":[["name":"Subject","value":"Topic "+secret],["name":"Authorization","value":secret]]],"access_token":secret]),grant:gmail)
        expect(!(String(data:try bytes(parsed),encoding:.utf8)!).contains(secret),"secrets and unknown fields filtered from provider output")
        expect((parsed["headers"] as! [[String:String]]).count==1 && parsed["bodyIncluded"] as? Bool==false,"metadata only explicit")
        rejects("wrong resource response",.response) {_ = try PrivateAccountRead.driveFileMetadata(id:"picked_1").parse(bytes(["id":"another","name":"n","mimeType":"text/plain"]),grant:drive)}
        rejects("oversized body",.response) {_ = try operations[0].0.parse(Data(repeating:32,count:262145),grant:gmail)}
        rejects("malformed JSON",.response) {_ = try operations[0].0.parse(Data([255,0,10]),grant:gmail)}
        rejects("error object is not empty mailbox",.response) {_ = try operations[0].0.parse(bytes(["error":"provider failed"]),grant:gmail)}
        let empty=try operations[0].0.parse(bytes(["resultSizeEstimate":0]),grant:gmail)
        expect(empty["complete"] as? Bool==true && (empty["messages"] as? [[String:String]])?.isEmpty==true,"verified empty mailbox result")
        rejects("too many rows",.response) {_ = try operations[0].0.parse(bytes(["messages":Array(repeating:["id":"a","threadId":"t"],count:51)]),grant:gmail)}
        rejects("boolean ID",.response) {_ = try PrivateAccountRead.githubRepository(name:"owner/repo").parse(bytes(["id":true,"full_name":"owner/repo"]),grant:github)}
        rejects("wrong repository response",.response) {_ = try PrivateAccountRead.githubRepository(name:"owner/repo").parse(bytes(["id":1,"full_name":"other/repo"]),grant:github)}
        let paged=try operations[0].0.parse(bytes(["messages":[],"nextPageToken":"next"]),grant:gmail)
        expect(paged["complete"] as? Bool==false && paged["nextPageToken"] as? String=="next","bounded explicit Gmail continuation")
        let driveResult=try PrivateAccountRead.driveFileMetadata(id:"picked_1").parse(bytes(["id":"picked_1","name":"n","mimeType":"text/plain","size":"123","trashed":false]),grant:drive)
        expect(driveResult["contentIncluded"] as? Bool==false,"Drive metadata capability limit")
        let issue=["number":7,"state":"open","title":"Title","body":"Text"] as [String:Any]
        let issues=try PrivateAccountRead.githubIssues(name:"owner/repo",page:2).parse(bytes(Array(repeating:issue,count:50)),grant:github)
        expect(issues["mayHaveMore"] as? Bool==true && issues["page"] as? Int==2,"GitHub bounded page not complete claim")

        let store=FixtureCredentials(),http=FixtureHTTP(),reader=PrivateAccountReader(credentials:store,transport:http)
        await rejectsAsync("unconfigured read",.unconfigured) {_ = try await reader.read(operations[0].0,now:now)}
        expect(http.requests.isEmpty,"no request before credentials")
        try store.insert(gmail);http.body=try bytes(["messages":[["id":"a","threadId":"b"]]])
        let result=try await reader.read(operations[0].0,now:now)
        expect((result["messages"] as? [[String:String]])?.count==1 && http.requests.count==1,"mock read reaches fixed service")
        http.fail=true;await rejectsAsync("transport details",.transport) {_ = try await reader.read(operations[0].0,now:now)};http.fail=false
        http.url=URL(string:"https://evil.example/")!;await rejectsAsync("redirected response",.response) {_ = try await reader.read(operations[0].0,now:now)};http.url=nil
        http.body=Data(repeating:32,count:262145);await rejectsAsync("mock oversized",.response) {_ = try await reader.read(operations[0].0,now:now)}
        http.body=try bytes(["messages":[]]);http.status=401
        await rejectsAsync("provider revocation",.denied) {_ = try await reader.read(operations[0].0,now:now)}
        let count=http.requests.count;http.status=200
        await rejectsAsync("no automatic retry after revocation",.denied) {_ = try await reader.read(operations[0].0,now:now)}
        expect(http.requests.count==count,"revoked grant fenced")
        let expired=FixtureCredentials();try expired.insert(.init(provider:.gmail,token:secret,expiresAt:now))
        await rejectsAsync("expired credential",.expired) {_ = try await PrivateAccountReader(credentials:expired,transport:http).read(operations[0].0,now:now)}
        let badStore=FixtureCredentials();badStore.fail=true
        await rejectsAsync("store errors",.storage) {_ = try await PrivateAccountReader(credentials:badStore,transport:http).read(operations[0].0,now:now)}
        let heldHTTP=FixtureHTTP();heldHTTP.hold=true;heldHTTP.body=try bytes(["messages":[]])
        let heldReader=PrivateAccountReader(credentials:store,transport:heldHTTP)
        let first=Task {try await heldReader.read(operations[0].0,now:now)}
        while heldHTTP.continuation==nil {await Task.yield()}
        await rejectsAsync("concurrent read",.busy) {_ = try await heldReader.read(operations[0].0,now:now)}
        heldReader.cancel();heldHTTP.release()
        await rejectsAsync("late cancelled response",.cancelled) {_ = try await first.value}
        expect(heldHTTP.requests.count==1,"no cancellation replay")
        heldHTTP.hold=false
        let afterStop=try await heldReader.read(operations[0].0,now:now)
        expect(afterStop["complete"] as? Bool==true,"new explicit read after cancellation")
        try heldReader.disconnectLocally(.gmail)
        expect(store.grants[.gmail]==nil && store.removes==1,"local credential removal")
        await rejectsAsync("local disconnection",.denied) {_ = try await heldReader.read(operations[0].0,now:now)}
        let revStore=FixtureCredentials();try revStore.insert(gmail)
        let revHTTP=FixtureHTTP();revHTTP.hold=true;revHTTP.body=try bytes(["messages":[]])
        let revReader=PrivateAccountReader(credentials:revStore,transport:revHTTP)
        let inFlight=Task {try await revReader.read(operations[0].0,now:now)}
        while revHTTP.continuation==nil {await Task.yield()}
        revStore.fail=true;rejects("failed local removal",.storage) {try revReader.disconnectLocally(.gmail)}
        revHTTP.release();await rejectsAsync("revoke discards late read",.cancelled) {_ = try await inFlight.value}
        revStore.fail=false;await rejectsAsync("failed deletion remains blocked",.denied) {_ = try await revReader.read(operations[0].0,now:now)}
        expect(revHTTP.requests.count==1,"failed revoke never permits another read")

        let registration=try PrivateAccountGoogleAuthorization.Registration(clientID:"offline-fixture.apps.googleusercontent.com",provider:.gmail,loopbackPort:49152)
        rejects("GitHub cannot reuse Google auth",.invalid) {_ = try PrivateAccountGoogleAuthorization.Registration(clientID:registration.clientID,provider:.github,loopbackPort:49152)}
        var entropy:UInt8=1,asks=0
        let auth=PrivateAccountGoogleAuthorization(random:{defer {entropy+=1};return Data(repeating:entropy,count:32)})
        await rejectsAsync("missing registration",.unconfigured) {_ = try await auth.begin(nil,now:now) {_,_ in asks+=1;return true}}
        expect(asks==0,"unconfigured never asks or creates state")
        await rejectsAsync("native denial",.denied) {_ = try await auth.begin(registration,now:now) {_,_ in asks+=1;return false}}
        expect(entropy==1,"denied native consent never creates state")
        let prepared=try await auth.begin(registration,now:now) {provider,scope in asks+=1;expect(provider == .gmail && scope==provider.scope,"exact native consent scope");return true}
        let query=Dictionary(uniqueKeysWithValues:URLComponents(url:prepared.browserURL,resolvingAgainstBaseURL:false)!.queryItems!.map {($0.name,$0.value!)})
        expect(query["code_challenge_method"]=="S256" && query["state"]?.count==43 && query["code_challenge"]?.count==43,"PKCE entropy and S256")
        expect(query["include_granted_scopes"]==nil && query["scope"]==PrivateAccountProvider.gmail.scope,"no unsupported desktop incremental authorization")
        var output="";dump(prepared,to:&output);expect(!output.contains(query["state"]!),"authorization URL debug redaction")
        func callback(_ state:String,extra:String="",port:Int=49152)->URL {URL(string:"http://127.0.0.1:\(port)/oauth/callback?state="+state+"&code=offline-code"+extra)!}
        let code=try auth.consume(callback(query["state"]!),now:now.addingTimeInterval(1))
        expect(code.value=="offline-code" && code.verifier.count==43,"verified one-use code handoff")
        output="";dump(code,to:&output);expect(!output.contains(code.value) && !output.contains(code.verifier),"code and verifier debug redaction")
        rejects("callback replay",.callback) {_ = try auth.consume(callback(query["state"]!),now:now)}
        for variant in ["state","port","duplicate","path","fragment","expired","scope","deny"] {
            let p=try await auth.begin(registration,now:now) {_,_ in true}
            let state=URLComponents(url:p.browserURL,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="state"}!.value!
            var url=callback(state),time=now
            switch variant {
            case "state":url=callback("wrong")
            case "port":url=callback(state,port:49153)
            case "duplicate":url=callback(state,extra:"&state="+state)
            case "path":url=URL(string:url.absoluteString.replacingOccurrences(of:"/oauth/callback",with:"/oauth/%63allback"))!
            case "fragment":url=URL(string:url.absoluteString+"#fragment")!
            case "expired":time=now.addingTimeInterval(301)
            case "scope":url=callback(state,extra:"&scope=broader")
            default:url=callback(state,extra:"&error=access_denied&error_description=SYNTHETIC_SECRET")
            }
            rejects("callback "+variant,variant=="deny" ? .denied:.callback) {_ = try auth.consume(url,now:time)}
            rejects("failed callback consumed state",.callback) {_ = try auth.consume(callback(state),now:now)}
        }
        let pending=try await auth.begin(registration,now:now) {_,_ in true}
        let state=URLComponents(url:pending.browserURL,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="state"}!.value!
        auth.cancel();rejects("cancel invalidates callback",.callback) {_ = try auth.consume(callback(state),now:now)}
        var approval:CheckedContinuation<Bool,Never>?
        let start=Task {try await auth.begin(registration,now:now) {_,_ in await withCheckedContinuation {approval=$0}}}
        while approval==nil {await Task.yield()}
        await rejectsAsync("overlapping native approval",.busy) {_ = try await auth.begin(registration,now:now) {_,_ in true}}
        auth.cancel();approval!.resume(returning:true)
        await rejectsAsync("cancelled native approval",.cancelled) {_ = try await start.value}
        print("PASS: \(assertions) offline connector assertions. No Keychain access, browser, accounts, network, app UI or model used.")
    }
}
