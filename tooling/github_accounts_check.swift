import Foundation

@MainActor final class GitHubFixtureClock {
    var value=Date(timeIntervalSince1970:1_800_000_000),waits:[Double]=[]
    func sleep(_ seconds:TimeInterval)async throws {try Task.checkCancellation();waits.append(seconds);value=value.addingTimeInterval(seconds)}
}
@MainActor final class GitHubFixtureStore:GitHubAccountStore {
    var record:GitHubAccountRecord?,saves=0,loads=0,failSave=false,failLoad=false,blocked=true
    func isBlocked()throws->Bool {blocked}
    func setBlocked(_ value:Bool)throws {blocked=value}
    func load()throws->GitHubAccountRecord? {loads+=1;if failLoad {throw NSError(domain:"LEAK_SECRET",code:1)};return record}
    func save(_ value:GitHubAccountRecord,expected:UUID?)throws {
        saves+=1;if failSave {throw NSError(domain:"LEAK_SECRET",code:1)}
        guard record?.id==expected else {throw GitHubAccountError.storage};try value.validate();record=value
    }
}
@MainActor final class GitHubFixtureHTTP:GitHubAccountHTTP {
    var requests:[URLRequest]=[],polls=0,refreshes=0,userID=10,repoID=21,repoName="owner/one",appID=7,selection="selected",scope="",tokenType="bearer",suspended=false
    var permissions:[String:String]=["metadata":"read","issues":"read"],pollErrors:[String]=[],deniedStatus:Int?,fail=false,invalidVerification=false,partial=false
    var holdPath:String?,continuation:CheckedContinuation<Void,Never>?,newSecret="ghu_fixture_new_access",newRefresh="ghr_fixture_new_refresh"
    static let access="ghu_fixture_old_access",refresh="ghr_fixture_old_refresh"
    func data(_ object:Any)throws->Data {try JSONSerialization.data(withJSONObject:object)}
    func pair(_ access:String,_ refresh:String)->[String:Any] {["access_token":access,"refresh_token":refresh,"token_type":tokenType,"scope":scope,"expires_in":28800,"refresh_token_expires_in":15897600]}
    func send(_ operation:GitHubAccountRequest)async throws->GitHubAccountResponse {
        let request=try operation.make();requests.append(request)
        if request.url!.path==holdPath {await withCheckedContinuation {continuation=$0}}
        if fail {throw NSError(domain:"LEAK_SECRET",code:1,userInfo:[NSLocalizedDescriptionKey:Self.access])}
        if let deniedStatus {return .init(status:deniedStatus,data:try data(["error":Self.access]))}
        let object:Any
        switch request.url!.path {
        case "/apps/fixture-app":object=["id":appID,"slug":"fixture-app","client_id":"Iv1.fixtureclient","permissions":permissions]
        case "/login/device/code":object=["device_code":String(repeating:"a",count:40),"user_code":"AB12-EF34","verification_uri":invalidVerification ? "https://evil.example/":"https://github.com/login/device","expires_in":900,"interval":5]
        case "/login/oauth/access_token":
            let body=String(data:request.httpBody!,encoding:.utf8)!
            if body.contains("grant_type=refresh_token") {refreshes+=1;object=pair(newSecret,newRefresh)}
            else {polls+=1;if !pollErrors.isEmpty {object=["error":pollErrors.removeFirst(),"error_description":Self.access]} else {object=pair(Self.access,Self.refresh)}}
        case "/user":object=["id":userID,"login":"fixtureuser","secret":Self.access]
        case "/user/installations":object=["total_count":partial ? 2:1,"installations":[["id":11,"app_id":appID,"app_slug":"fixture-app","repository_selection":selection,"permissions":permissions,"suspended_at":suspended ? "2026":NSNull(),"account":["id":12,"login":"owner"]]]]
        case "/user/installations/11/repositories":object=["total_count":1,"repositories":[["id":repoID,"full_name":repoName]]]
        case "/repos/owner/one":object=["id":repoID,"full_name":"owner/one","description":"Repository "+Self.access]
        case "/repos/owner/one/issues":object=[["number":1,"state":"open","title":"Issue","body":"Untrusted text "+Self.access]]
        default:throw GitHubAccountError.invalid
        }
        return .init(status:200,data:try data(object))
    }
    func release(){continuation?.resume();continuation=nil}
}
@main struct GitHubAccountsCheck {
    @MainActor static var count=0
    @MainActor static func expect(_ truth:Bool,_ name:String) {count+=1;guard truth else {fatalError("FAIL: "+name)}}
    @MainActor static func rejects(_ name:String,_ expectedError:GitHubAccountError?=nil,_ operation:()async throws->Void)async {
        do {try await operation();fatalError("FAIL: accepted "+name)} catch {
            expect(expectedError==nil || error as? GitHubAccountError==expectedError,"expected error "+name)
            expect(!error.localizedDescription.contains("LEAK_SECRET") && !error.localizedDescription.contains(GitHubFixtureHTTP.access),"sanitized error "+name)
        }
    }
    @MainActor static func main()async throws {
        let registration=try GitHubAccountRegistration(slug:"fixture-app",clientID:"Iv1.fixtureclient")
        func fixture()->(GitHubAccountSession,GitHubFixtureStore,GitHubFixtureHTTP,GitHubFixtureClock) {
            let store=GitHubFixtureStore(),http=GitHubFixtureHTTP(),clock=GitHubFixtureClock()
            return (.init(http:http,store:store,now:{clock.value},sleep:{try await clock.sleep($0)}),store,http,clock)
        }
        func connect(_ s:GitHubAccountSession,consent:Bool=true,approval:Bool=true)async throws {
            try await s.connect(registration,consent:{_ in consent},displayCode:{code,_ in expect(code=="AB12-EF34","native device code")},choose:{$0.first?.id},approve:{selection in expect(selection.user.id==10 && selection.repositories.first?.id==21,"verified native selection");return approval})
        }
        let (session,store,http,clock)=fixture()
        let unavailable=try await session.perform(["action":"status"])
        expect((unavailable["providers"] as! [[String:Any]])[2]["connected"] as? Bool==false && http.requests.isEmpty,"unconfigured status no network")
        await rejects("native consent denied",.denied) {try await connect(session,consent:false)}
        expect(http.requests.count==1 && http.polls==0 && store.saves==0,"only public app fetched before consent")
        http.pollErrors=["authorization_pending","slow_down","authorization_pending"]
        try await connect(session)
        expect(clock.waits==[5,5,10,10],"pending and slow_down polling intervals")
        expect(store.record?.state == .active && store.record?.tokens != nil && store.saves==1,"only approved verified grant persisted")
        for request in http.requests {
            expect(!request.url!.absoluteString.contains(GitHubFixtureHTTP.access),"no credential URL")
            if request.httpMethod=="POST" {let body=String(data:request.httpBody!,encoding:.utf8)!;expect(!body.contains("client_secret") && !body.contains("scope=repo"),"no secret or broad scope request")}
        }
        let issues=try await session.perform(["action":"github_issues","repository":"owner/one","page":1])
        expect((issues["issues"] as? [[String:Any]])?.count==1,"approved automatic issue read")
        let rendered=String(data:try JSONSerialization.data(withJSONObject:issues),encoding:.utf8)!
        expect(!rendered.contains(GitHubFixtureHTTP.access) && !rendered.contains(GitHubFixtureHTTP.refresh),"read credentials redacted")
        await rejects("extra action fields") {_ = try await session.perform(["action":"status","token":"LEAK_SECRET"])}
        await rejects("write operation") {_ = try await session.perform(["action":"connect"])}
        await rejects("unselected repository") {_ = try await session.perform(["action":"github_repository","repository":"owner/other"])}
        let resumed=GitHubAccountSession(http:http,store:store,now:{clock.value},sleep:{try await clock.sleep($0)})
        let status=try await resumed.perform(["action":"status"])
        expect((status["providers"] as! [[String:Any]])[2]["connected"] as? Bool==true,"durable grant restores without new consent")
        clock.value=clock.value.addingTimeInterval(28800)
        _ = try await resumed.perform(["action":"github_repository","repository":"owner/one"])
        expect(http.refreshes==1 && store.saves==3 && store.record?.state == .active,"refresh marks pending then saves rotated pair")
        var dumpText="";dump(store.record!,to:&dumpText);dump(GitHubAccountRequest.refresh(registration.clientID,store.record!.tokens!.refresh),to:&dumpText)
        expect(!dumpText.contains(http.newSecret) && !dumpText.contains(http.newRefresh),"refresh/record reflection redacted")
        try resumed.disconnect()
        expect(store.record?.state == .disconnected && store.record?.tokens==nil,"durable disconnect tombstone removes both tokens")
        let afterRestart=GitHubAccountSession(http:http,store:store,now:{clock.value},sleep:{try await clock.sleep($0)})
        let before=http.requests.count
        _ = try await afterRestart.perform(["action":"status"])
        expect(http.requests.count==before,"disconnect blocks auto restore after restart")

        for kind in ["wide","write","partial","suspended","wrong_verification","scope","token_type"] {
            let (s,st,h,_)=fixture()
            if kind=="wide" {h.selection="all"};if kind=="write" {h.permissions["issues"]="write"}
            if kind=="partial" {h.partial=true};if kind=="suspended" {h.suspended=true}
            if kind=="wrong_verification" {h.invalidVerification=true};if kind=="scope" {h.scope="repo"};if kind=="token_type" {h.tokenType="basic"}
            await rejects(kind) {try await connect(s)}
            expect(st.saves==0,"no persisted partial or broader grant "+kind)
        }
        let (declined,declinedStore,_,_)=fixture()
        await rejects("native final selection declined",.cancelled) {try await connect(declined,approval:false)}
        expect(declinedStore.saves==0,"final denial never saves")
        let (changed,changedStore,changedHTTP,_)=fixture();try await connect(changed)
        changedHTTP.userID=99
        await rejects("account switch",.denied) {_ = try await changed.perform(["action":"github_repository","repository":"owner/one"])}
        expect(changedStore.record?.state == .disconnected && changedStore.record?.tokens==nil,"account switch durably invalidates")
        let (changedRepo,repoStore,repoHTTP,_)=fixture();try await connect(changedRepo);repoHTTP.repoID=99
        await rejects("repository replacement",.denied) {_ = try await changedRepo.perform(["action":"github_repository","repository":"owner/one"])}
        expect(repoStore.record?.tokens==nil,"stable repository ID enforced")
        let (revoked,revokedStore,revokedHTTP,_)=fixture();try await connect(revoked);revokedHTTP.deniedStatus=401
        await rejects("provider revocation",.denied) {_ = try await revoked.perform(["action":"github_repository","repository":"owner/one"])}
        expect(revokedStore.record?.tokens==nil,"provider revocation durable")
        let (failed,failedStore,failedHTTP,failedClock)=fixture();try await connect(failed)
        failedClock.value=failedClock.value.addingTimeInterval(28800);failedHTTP.holdPath="/login/oauth/access_token"
        let refresh=Task {try await failed.perform(["action":"github_repository","repository":"owner/one"])}
        while failedHTTP.continuation==nil {await Task.yield()}
        expect(failedStore.record?.state == .refreshPending && failedStore.record?.tokens==nil,"rotation fence precedes token request")
        failed.cancel();failedHTTP.release()
        await rejects("cancelled refresh",.cancelled) {_ = try await refresh.value}
        failedHTTP.holdPath=nil
        let retry=GitHubAccountSession(http:failedHTTP,store:failedStore,now:{failedClock.value},sleep:{try await failedClock.sleep($0)})
        let requests=failedHTTP.requests.count
        await rejects("refresh replay after restart",.refresh) {_ = try await retry.perform(["action":"github_repository","repository":"owner/one"])}
        expect(failedHTTP.requests.count==requests,"no uncertain refresh replay")
        let (held,heldStore,heldHTTP,_)=fixture();heldHTTP.holdPath="/login/oauth/access_token"
        let connecting=Task {try await connect(held)}
        while heldHTTP.continuation==nil {await Task.yield()}
        held.cancel();heldHTTP.release()
        await rejects("late connection callback",.cancelled) {_ = try await connecting.value}
        expect(heldStore.saves==0,"cancelled grant never persisted")
        let (saving,savingStore,_,_)=fixture();savingStore.failSave=true
        await rejects("failed publication",.storage) {try await connect(saving)}
        let (failing,failingStore,_,_)=fixture();try await connect(failing);failingStore.failSave=true
        await rejects("disconnect storage failure",.storage) {try failing.disconnect()}
        await rejects("disconnect failure remains held",.denied) {_ = try await failing.perform(["action":"github_repository","repository":"owner/one"])}
        let failedRestart=GitHubAccountSession(http:GitHubFixtureHTTP(),store:failingStore)
        let deniedRestore=try await failedRestart.perform(["action":"status"])
        expect((deniedRestore["providers"] as! [[String:Any]])[2]["connected"] as? Bool==false && failingStore.blocked,"failed Keychain removal cannot restore after restart")
        let (late,lateStore,lateHTTP,_)=fixture()
        await rejects("changed account during native review",.denied) {
            try await late.connect(registration,consent:{_ in true},displayCode:{_,_ in},choose:{$0.first?.id},approve:{_ in lateHTTP.userID=99;return true})
        }
        expect(lateStore.saves==0,"account changed during review never published")
        let (rotation,rotationStore,rotationHTTP,rotationClock)=fixture();try await connect(rotation)
        rotationClock.value=rotationClock.value.addingTimeInterval(28800);rotationHTTP.userID=99
        await rejects("changed account after refresh",.denied) {_ = try await rotation.perform(["action":"github_repository","repository":"owner/one"])}
        expect(rotationStore.record?.tokens==nil && rotationStore.blocked,"mismatched refreshed identity stays disabled")
        let (net,netStore,netHTTP,_)=fixture();netHTTP.fail=true
        await rejects("network exception secret",.transport) {try await connect(net)}
        expect(netStore.saves==0,"network errors never publish")
        let (reading,readingStore,readingHTTP,_)=fixture();try await connect(reading)
        readingHTTP.holdPath="/repos/owner/one/issues"
        let readTask=Task {try await reading.perform(["action":"github_issues","repository":"owner/one","page":1])}
        while readingHTTP.continuation==nil {await Task.yield()}
        try reading.disconnect();readingHTTP.release()
        await rejects("disconnect during read",.cancelled) {_ = try await readTask.value}
        expect(readingStore.record?.tokens==nil && readingStore.blocked,"late private read cannot survive local disconnect")
        for secret in [GitHubFixtureHTTP.access,GitHubFixtureHTTP.refresh] {
            let (echo,echoStore,echoHTTP,_)=fixture();echoHTTP.repoName="owner/"+secret
            var approvals=0
            await rejects("provider credential echo",.invalid) {
                try await echo.connect(registration,consent:{_ in true},displayCode:{_,_ in},choose:{$0.first?.id},approve:{_ in approvals+=1;return true})
            }
            expect(approvals==0 && echoStore.saves==0,"neither access nor refresh secret reaches selection UI/store")
        }
        print("PASS: \(count) offline GitHub device/identity/consent/refresh/read/disconnect assertions. No browser, network, Keychain, app UI or real account used.")
    }
}
