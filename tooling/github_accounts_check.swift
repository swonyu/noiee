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
    var initialRefresh=GitHubFixtureHTTP.refresh,readEcho:String?
    var requests:[URLRequest]=[],polls=0,refreshes=0,userID=10,repoID=21,repoName="owner/one",appID=7,selection="selected",scope="",tokenType="bearer",suspended=false
    var userLogin="fixtureuser",ownerLogin="owner",ownerID=12,installationID=11,appSlug="fixture-app"
    var repositoryRows:[GitHubAccountRepository]?,partialRepositories=false,repoFailurePage:Int?,afterRead:(()->Void)?
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
        case let path where path=="/apps/"+appSlug:object=["id":appID,"slug":appSlug,"client_id":"Iv1.fixtureclient","permissions":permissions]
        case "/login/device/code":object=["device_code":String(repeating:"a",count:40),"user_code":"AB12-EF34","verification_uri":invalidVerification ? "https://evil.example/":"https://github.com/login/device","expires_in":900,"interval":5]
        case "/login/oauth/access_token":
            let body=String(data:request.httpBody!,encoding:.utf8)!
            if body.contains("grant_type=refresh_token") {refreshes+=1;object=pair(newSecret,newRefresh)}
            else {polls+=1;if !pollErrors.isEmpty {object=["error":pollErrors.removeFirst(),"error_description":Self.access]} else {object=pair(Self.access,initialRefresh)}}
        case "/user":object=["id":userID,"login":userLogin,"secret":Self.access]
        case "/user/installations":object=["total_count":partial ? 2:1,"installations":[["id":installationID,"app_id":appID,"app_slug":appSlug,"repository_selection":selection,"permissions":permissions,"suspended_at":suspended ? "2026":NSNull(),"account":["id":ownerID,"login":ownerLogin]]]]
        case let path where path=="/user/installations/\(installationID)/repositories":
            let page=Int(URLComponents(url:request.url!,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="page"}!.value!)!
            if repoFailurePage==page {throw GitHubAccountError.transport}
            let all=repositoryRows ?? [.init(id:repoID,name:repoName)]
            let rows=Array(all.dropFirst((page-1)*20).prefix(20))
            object=["total_count":all.count+(partialRepositories ? 1:0),"repositories":rows.map {["id":$0.id,"full_name":$0.name] as [String:Any]}]
        case let path where path.hasPrefix("/repos/"):
            let issues=path.hasSuffix("/issues"),name=String(path.dropFirst(7).dropLast(path.hasSuffix("/issues") ? 7:0))
            guard let repository=(repositoryRows ?? [.init(id:repoID,name:repoName)]).first(where:{$0.name==name}) else {return .init(status:404,data:Data())}
            if issues {object=[["number":1,"state":"open","title":"Issue","body":readEcho ?? ("Untrusted text "+Self.access)]]}
            else {object=["id":repository.id,"full_name":repository.name,"description":readEcho ?? ("Repository "+Self.access)]}
            afterRead?()
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
        let (renamed,renameStore,renameHTTP,renameClock)=fixture();try await connect(renamed)
        renameHTTP.userLogin="renameduser";renameHTTP.ownerLogin="renamedowner";renameHTTP.appSlug="renamed-app";renameHTTP.repoName="renamedowner/project"
        let renamedStatus=try await renamed.perform(["action":"status"])
        let renamedProvider=(renamedStatus["providers"] as! [[String:Any]])[2]
        expect(renamedProvider["account"] as? String=="renameduser" && renamedProvider["repositories"] as? [String]==["renamedowner/project"],"names reconcile from stable IDs without a grant")
        expect(renameStore.record?.selection.appID==7 && renameStore.record?.selection.registration.slug=="renamed-app" && renameStore.record?.selection.user.id==10 && renameStore.record?.selection.installation.id==11 && renameStore.record?.selection.installation.owner.id==12,"all authority IDs remain stable through rename")
        _ = try await renamed.perform(["action":"github_repository","repository":"renamedowner/project"])
        await rejects("old renamed path no longer routes") {_ = try await renamed.perform(["action":"github_repository","repository":"owner/one"])}
        expect(!renameHTTP.requests.contains {$0.url!.path=="/repos/owner/one"},"old repository path never dispatched after rename")
        renameClock.value=renameClock.value.addingTimeInterval(28800);renameHTTP.repoName="renamedowner/again"
        _ = try await renamed.perform(["action":"status"])
        expect(renameStore.record?.selection.repositories.first?.name=="renamedowner/again" && renameHTTP.refreshes==1,"refresh also reconciles same-ID names")

        let (reduced,reducedStore,reducedHTTP,reducedClock)=fixture()
        let one=GitHubAccountRepository(id:21,name:"owner/one"),two=GitHubAccountRepository(id:22,name:"owner/two"),new=GitHubAccountRepository(id:23,name:"owner/new")
        reducedHTTP.repositoryRows=[one,two];try await connect(reduced)
        reducedHTTP.repositoryRows=[two,new]
        let reducedStatus=try await reduced.perform(["action":"status"])
        expect((reducedStatus["providers"] as! [[String:Any]])[2]["repositories"] as? [String]==["owner/two"],"confirmed reduction persists and added ID is ignored")
        expect(reducedStore.record?.selection.repositories==[two] && !reducedStore.blocked,"remaining approved IDs stay active without new consent")
        _ = try await reduced.perform(["action":"github_repository","repository":"owner/two"])
        reducedHTTP.repositoryRows=[one,two,new]
        let reducedRestart=GitHubAccountSession(http:reducedHTTP,store:reducedStore,now:{reducedClock.value},sleep:{try await reducedClock.sleep($0)})
        _ = try await reducedRestart.perform(["action":"status"])
        expect(reducedStore.record?.selection.repositories==[two],"removed ID cannot be restored after restart or provider reappearance")
        await rejects("removed ID remains excluded") {_ = try await reducedRestart.perform(["action":"github_repository","repository":"owner/one"])}
        await rejects("new ID never silently admitted") {_ = try await reducedRestart.perform(["action":"github_repository","repository":"owner/new"])}

        for status in [403,404,429,500,503] {
            let (transient,tStore,tHTTP,_)=fixture();try await connect(transient)
            let original=tStore.record!.id;tHTTP.deniedStatus=status
            await rejects("transient HTTP \(status)",.transport) {_ = try await transient.perform(["action":"github_repository","repository":"owner/one"])}
            expect(tStore.record?.id==original && !tStore.blocked && tStore.record?.tokens != nil,"transient status never prunes or revokes")
            tHTTP.deniedStatus=nil
            _ = try await transient.perform(["action":"github_repository","repository":"owner/one"])
            expect(tStore.record?.id==original,"transient recovery needs no new grant")
        }
        let (incomplete,iStore,iHTTP,_)=fixture();iHTTP.repositoryRows=[one,two];try await connect(incomplete)
        let prior=iStore.record!.id;iHTTP.repositoryRows=[two];iHTTP.partialRepositories=true
        await rejects("partial inventory is not removal",.invalid) {_ = try await incomplete.perform(["action":"github_repository","repository":"owner/two"])}
        expect(iStore.record?.id==prior && iStore.record?.selection.repositories==[one,two] && !iStore.blocked,"incomplete inventory preserves prior authority but returns no data")
        iHTTP.partialRepositories=false
        _ = try await incomplete.perform(["action":"status"])
        expect(iStore.record?.selection.repositories==[two],"only complete inventory confirms removal")

        let (pages,pStore,pHTTP,_)=fixture()
        let many=(21...41).map {GitHubAccountRepository(id:$0,name:"owner/r\($0)")}
        pHTTP.repositoryRows=many;try await connect(pages)
        let beforePages=pStore.record!.id;pHTTP.repositoryRows=Array(many.dropFirst())+[.init(id:99,name:"owner/replacement")];pHTTP.repoFailurePage=2
        await rejects("second-page failure",.transport) {_ = try await pages.perform(["action":"github_repository","repository":"owner/r22"])}
        expect(pStore.record?.id==beforePages && pStore.record?.selection.repositories==many,"earlier pages cannot establish deletion")
        pHTTP.repoFailurePage=nil;_ = try await pages.perform(["action":"status"])
        expect(pStore.record?.selection.repositories==Array(many.dropFirst()),"complete pagination intersects only approved IDs")

        let (during,dStore,dHTTP,_)=fixture();dHTTP.repositoryRows=[one,two];try await connect(during)
        dHTTP.afterRead={dHTTP.repositoryRows=[two];dHTTP.afterRead=nil}
        await rejects("requested ID removed during read") {_ = try await during.perform(["action":"github_issues","repository":"owner/one","page":1])}
        expect(dStore.record?.selection.repositories==[two] && !dStore.blocked,"post-read removal discards result but preserves other approved repositories")
        _ = try await during.perform(["action":"github_repository","repository":"owner/two"])

        let (empty,eStore,eHTTP,eClock)=fixture();try await connect(empty);eHTTP.repositoryRows=[]
        await rejects("all repositories confirmed removed",.denied) {_ = try await empty.perform(["action":"github_repository","repository":"owner/one"])}
        expect(eStore.blocked && eStore.record?.tokens==nil,"complete loss of authority durably disconnects")
        eHTTP.repositoryRows=[one]
        let emptyRestart=GitHubAccountSession(http:eHTTP,store:eStore,now:{eClock.value},sleep:{try await eClock.sleep($0)})
        let noRevival=eHTTP.requests.count;_ = try await emptyRestart.perform(["action":"status"])
        expect(eHTTP.requests.count==noRevival,"fully removed grant cannot revive automatically")
        for identity in ["app","installation","owner"] {
            let (changed,cStore,cHTTP,_)=fixture();try await connect(changed)
            if identity=="app" {cHTTP.appID=99};if identity=="installation" {cHTTP.installationID=99};if identity=="owner" {cHTTP.ownerID=99}
            await rejects("changed authority ID "+identity) {_ = try await changed.perform(["action":"github_repository","repository":"owner/one"])}
            expect(cStore.blocked && cStore.record?.tokens==nil,"name reconciliation never changes authority ID")
        }
        let (writeScope,wStore,wHTTP,_)=fixture();try await connect(writeScope);wHTTP.permissions["issues"]="write"
        await rejects("scope expansion after grant",.permissions) {_ = try await writeScope.perform(["action":"github_repository","repository":"owner/one"])}
        expect(wStore.blocked && wStore.record?.tokens==nil,"read permissions never silently expand")
        let (prune,pruneStore,pruneHTTP,pruneClock)=fixture();pruneHTTP.repositoryRows=[one,two];try await connect(prune)
        pruneHTTP.repositoryRows=[two];pruneStore.failSave=true
        await rejects("failed reduction publication",.storage) {_ = try await prune.perform(["action":"github_repository","repository":"owner/two"])}
        expect(pruneStore.blocked,"confirmed removal has independent durable deny fence before Keychain update")
        pruneStore.failSave=false;pruneHTTP.repositoryRows=[one,two]
        let pruneRestart=GitHubAccountSession(http:pruneHTTP,store:pruneStore,now:{pruneClock.value},sleep:{try await pruneClock.sleep($0)})
        let pruneRequests=pruneHTTP.requests.count
        await rejects("failed removal cannot revive prior scope",.unavailable) {_ = try await pruneRestart.perform(["action":"github_repository","repository":"owner/one"])}
        expect(pruneHTTP.requests.count==pruneRequests,"failed removal never restores revoked ID on restart")
        for secret in ["ghr_fixture/slash/refresh","ghr_fixture_\"quoted\"_refresh","ghr_fixture_\\backslash_refresh"] {
            let (escaped,escapedStore,escapedHTTP,_)=fixture();escapedHTTP.initialRefresh=secret;try await connect(escaped);escapedHTTP.readEcho=secret
            await rejects("escaped refresh in repository",.invalid) {_ = try await escaped.perform(["action":"github_repository","repository":"owner/one"])}
            await rejects("escaped refresh in issue",.invalid) {_ = try await escaped.perform(["action":"github_issues","repository":"owner/one","page":1])}
            let tokens=escapedStore.record!.tokens!
            expect(GitHubAccountJSON.containsCredential(["nested":[["body":secret]]],tokens:tokens),"recursive refresh string detection")
            expect(GitHubAccountJSON.containsCredential([secret:"value"],tokens:tokens),"recursive secret-key detection")
            expect(GitHubAccountJSON.containsCredential(["nested":[GitHubFixtureHTTP.access]],tokens:tokens),"recursive access detection")
        }
        print("PASS: \(count) offline GitHub device/identity/consent/refresh/read/disconnect assertions. No browser, network, Keychain, app UI or real account used.")
    }
}
