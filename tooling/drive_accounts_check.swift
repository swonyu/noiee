import Foundation
import CryptoKit
@MainActor final class DriveFixtureStore:DriveStore {
    var record:DriveRecord?,blocked=true,loads=0,saves=0,failLoad=false,failSave=false,failBlock=false
    func isBlocked()throws->Bool {blocked}
    func setBlocked(_ value:Bool)throws {if failBlock {throw NSError(domain:"LEAK_SECRET",code:1)};blocked=value}
    func load()throws->DriveRecord? {loads+=1;if failLoad {throw NSError(domain:"LEAK_SECRET",code:1)};return record}
    func save(_ value:DriveRecord,expected:UUID?)throws {saves+=1;if failSave {throw NSError(domain:"LEAK_SECRET",code:1)};guard record?.id==expected else {throw DriveError.storage};try value.validate();record=value}
}
@MainActor final class DriveFixtureLoopback:GmailLoopback {
    var starts=0,cancels=0,url:URL?,ids="file1",scope=DrivePolicy.scope,denied=false,wrongState=false,duplicate=false,hold=false
    var continuation:CheckedContinuation<URL,Error>?,lastAuthorization:URL?
    func start()async throws->Int {starts+=1;return 49153}
    func callback()async throws->URL {if hold {return try await withCheckedThrowingContinuation {continuation=$0}};return url!}
    func cancel(){cancels+=1;continuation?.resume(throwing:DriveError.cancelled);continuation=nil}
    func open(_ authorization:URL)->Bool {
        lastAuthorization=authorization
        let state=URLComponents(url:authorization,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="state"}!.value!
        var c=URLComponents(string:"http://127.0.0.1:49153/oauth/callback")!
        c.queryItems=[.init(name:"state",value:wrongState ? "wrong":state),.init(name:"scope",value:scope),.init(name:"picked_file_ids",value:ids),.init(name:denied ? "error":"code",value:denied ? "access_denied":"fixture-drive-code")]
        if duplicate {c.queryItems!.append(.init(name:"state",value:state))};url=c.url;return true
    }
}
@MainActor final class DriveFixtureHTTP:DriveHTTP {
    static let access="fixture-drive-access-secret",refresh="1//fixture-drive-refresh-secret",key="fixture-resource-key"
    var requests:[URLRequest]=[],scope=DrivePolicy.scope,includeScope=true,includeRefresh=true,rotate=false,refreshSecret=DriveFixtureHTTP.refresh
    var permissionID="stable-drive-ID",email="drive@example.com",me=true,authorized=true,canDownload=true,trashed=false,mime="text/plain",version="1",size="13",resourceKey:String?=DriveFixtureHTTP.key,encryption:String?,unknownEncryption=false
    var name="Selected text",content=Data("Selected text".utf8),contentMime="text/plain",contentStatus=200,metadataStatus:Int?,errorStatus:Int?,fail=false,refreshes=0,contents=0,revokes=0
    var afterContent:(()->Void)?,holdPath:String?,continuation:CheckedContinuation<Void,Never>?,refreshLifetime:Int?
    func send(_ operation:DriveRequest)async throws->DriveResponse {
        let request=try operation.make();requests.append(request)
        if request.url!.path==holdPath {await withCheckedContinuation {continuation=$0}}
        if fail {throw NSError(domain:"LEAK_SECRET",code:1,userInfo:[NSLocalizedDescriptionKey:Self.access])}
        if let errorStatus {return .init(status:errorStatus,data:Data(Self.refresh.utf8),mime:"application/json")}
        let object:Any
        switch operation {
        case .exchange:
            var value:[String:Any]=["access_token":Self.access,"token_type":"Bearer","expires_in":3600]
            if includeScope {value["scope"]=scope};if includeRefresh {value["refresh_token"]=refreshSecret};if let refreshLifetime {value["refresh_token_expires_in"]=refreshLifetime};object=value
        case .refresh:
            refreshes+=1;var value:[String:Any]=["access_token":Self.access+"-renewed","token_type":"Bearer","expires_in":3600]
            if includeScope {value["scope"]=scope};if rotate {value["refresh_token"]=refreshSecret+"-rotated"};object=value
        case .about:object=["user":["permissionId":permissionID,"emailAddress":email,"me":me]]
        case let .metadata(_,id,_):
            if let metadataStatus {return .init(status:metadataStatus,data:Data(),mime:nil)}
            var value:[String:Any]=["id":id,"name":name+" "+id,"mimeType":mime,"version":version,"modifiedTime":"2026-11-09T10:00:00.000Z","size":size,"trashed":trashed,"isAppAuthorized":authorized,"capabilities":["canDownload":canDownload]]
            if let resourceKey {value["resourceKey"]=resourceKey};if let encryption {value["clientEncryptionDetails"]=["encryptionState":encryption]};if unknownEncryption {value["clientEncryptionDetails"]=[: ]};object=value
        case .content:contents+=1;afterContent?();return .init(status:contentStatus,data:content,mime:contentMime)
        case .revoke:revokes+=1;return .init(status:200,data:Data(),mime:nil)
        }
        return .init(status:200,data:try JSONSerialization.data(withJSONObject:object),mime:"application/json")
    }
    func release(){continuation?.resume();continuation=nil}
}
@MainActor final class DriveFixture {
    var now=Date(timeIntervalSince1970:1_800_000_000),random:UInt8=0,consents=0,opens=0
    let store=DriveFixtureStore(),http=DriveFixtureHTTP(),loopback=DriveFixtureLoopback()
    lazy var session=makeSession()
    func makeSession()->DriveAccountSession {DriveAccountSession(http:http,store:store,now:{self.now},listener:{self.loopback},authorization:{DriveAuthorization(random:{self.random+=1;return Data(repeating:self.random,count:32)})})}
    func connect(consent:Bool=true,browser:Bool=true,client:String="drive-fixture.apps.googleusercontent.com")async throws->DriveIdentity {try await session.connect(.init(client),consent:{_,_ in self.consents+=1;return consent},openBrowser:{url in self.opens+=1;return browser && self.loopback.open(url)})}
}
@main struct DriveAccountsCheck {
    @MainActor static var count=0
    @MainActor static func expect(_ value:Bool,_ title:String){count+=1;guard value else {fatalError("FAIL: "+title)}}
    @MainActor static func rejects(_ title:String,_ operation:()async throws->Void)async {
        do {try await operation();fatalError("FAIL: accepted "+title)} catch {expect(!error.localizedDescription.contains("LEAK_SECRET") && !error.localizedDescription.contains(DriveFixtureHTTP.access) && !error.localizedDescription.contains(DriveFixtureHTTP.refresh) && !error.localizedDescription.contains(DriveFixtureHTTP.key),"sanitized rejection "+title)}
    }
    @MainActor static func main()async throws {
        let registration=try GmailRegistration("drive-fixture.apps.googleusercontent.com"),date=Date(timeIntervalSince1970:1_800_000_000)
        func auth()->DriveAuthorization {var n:UInt8=0;return DriveAuthorization(random:{n+=1;return Data(repeating:n,count:32)})}
        let a=auth(),request=try a.begin(registration,port:49153,now:date),items=URLComponents(url:request.url,resolvingAgainstBaseURL:false)!.queryItems!
        func q(_ name:String)->String? {items.first {$0.name==name}?.value}
        expect(request.url.host=="accounts.google.com" && q("scope")==DrivePolicy.scope && q("trigger_onepick")=="true" && q("prompt")=="consent","documented desktop Picker request")
        expect(q("nonce")==nil && !(q("scope")!.contains("openid")) && q("allow_folder_selection")==nil && q("allow_multiple")=="true","Drive-only scope no fabricated OpenID or folder selection")
        let verifier=GmailAuthorization.base64(Data(repeating:2,count:32));expect(q("code_challenge")==GmailAuthorization.base64(Data(SHA256.hash(data:Data(verifier.utf8)))) && q("code_challenge_method")=="S256","Drive PKCE S256")
        func callback(_ state:String,ids:String="file2,file1",scope:String=DrivePolicy.scope)->URL {var c=URLComponents(string:"http://127.0.0.1:49153/oauth/callback")!;c.queryItems=[.init(name:"state",value:state),.init(name:"code",value:"fixture-drive-code"),.init(name:"scope",value:scope),.init(name:"picked_file_ids",value:ids)];return c.url!}
        let code=try a.consume(callback(q("state")!),now:date);expect(code.selectedIDs==["file1","file2"] && code.verifier.nativeValue()==verifier,"callback carries bounded sorted selected IDs with PKCE verifier")
        await rejects("callback replay") {_ = try a.consume(callback(q("state")!),now:date)}
        for ids in ["","file1,file1","file1,","../file",(0...20).map {"file\($0)"}.joined(separator:","),String(repeating:"x",count:257)] {
            let a=auth(),r=try a.begin(registration,port:49153,now:date),state=URLComponents(url:r.url,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="state"}!.value!
            await rejects("invalid Picker IDs") {_ = try a.consume(callback(state,ids:ids),now:date)};await rejects("failed selection consumes callback") {_ = try a.consume(callback(state),now:date)}
        }
        for failure in ["scope","state","port","host","path","fragment","duplicate","expiry","backward","error"] {
            let a=auth(),r=try a.begin(registration,port:49153,now:date),state=URLComponents(url:r.url,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="state"}!.value!
            var c=URLComponents(url:callback(state),resolvingAgainstBaseURL:false)!
            switch failure {case "scope":c.queryItems![2].value=DrivePolicy.scope+" openid";case "state":c.queryItems![0].value="wrong";case "port":c.port=49154;case "host":c.host="localhost";case "path":c.path="/else";case "fragment":c.fragment="x";case "duplicate":c.queryItems!.append(.init(name:"picked_file_ids",value:"other"));case "error":c.queryItems!.append(.init(name:"error",value:"access_denied"));default:break}
            await rejects("Picker callback "+failure) {_ = try a.consume(c.url!,now:failure=="expiry" ? date.addingTimeInterval(301):failure=="backward" ? date.addingTimeInterval(-1):date)}
        }
        let cancelledAuth=auth();_ = try cancelledAuth.begin(registration,port:49153,now:date);cancelledAuth.cancel();await rejects("cancelled Picker state") {_ = try cancelledAuth.consume(callback(q("state")!),now:date)}
        let f=DriveFixture();let initial=try await f.session.perform(["action":"status"]);expect(initial["state"] as? String=="unconfigured" && f.http.requests.isEmpty,"unconfigured Drive no provider access")
        await rejects("native consent denied") {_ = try await f.connect(consent:false)};expect(f.loopback.starts==0 && f.opens==0 && f.http.requests.isEmpty && f.store.saves==0,"no Picker/token request before native consent")
        let identity=try await f.connect();expect(identity.permissionID=="stable-drive-ID" && f.store.record?.files.map(\.id)==["file1"] && !f.store.blocked,"verified self and Picker selection persisted")
        expect(f.store.record?.destination==DrivePolicy.destination && f.store.record?.tokens != nil,"exact local destination and durable refresh grant")
        expect(f.session.registrationHint()==registration.clientID,"public native registration hint only")
        for r in f.http.requests {expect(r.url!.scheme=="https" && !r.url!.absoluteString.contains(DriveFixtureHTTP.access) && !r.url!.absoluteString.contains(DriveFixtureHTTP.refresh) && !r.url!.absoluteString.contains(DriveFixtureHTTP.key),"fixed HTTPS without access material in URLs")}
        let exchange=f.http.requests.first {$0.url!.path=="/token"}!,form=String(data:exchange.httpBody!,encoding:.utf8)!
        expect(exchange.httpMethod=="POST" && form.contains("code_verifier=") && !form.contains("client_secret") && !form.contains("picked_file_ids"),"public Desktop exchange, selected IDs never become token parameters")
        let metadata=try await f.session.perform(["action":"drive_file_metadata","id":"file1"]);expect(metadata["id"] as? String=="file1" && metadata["contentIncluded"] as? Bool==false && metadata["resourceKey"]==nil,"metadata projection excludes resource key")
        let text=try await f.session.perform(["action":"drive_file_text","id":"file1"]);expect(text["text"] as? String=="Selected text" && text["complete"] as? Bool==true,"complete UTF-8 selected-file text")
        let media=f.http.requests.first {URLComponents(url:$0.url!,resolvingAgainstBaseURL:false)!.queryItems?.contains(where:{$0.name=="alt" && $0.value=="media"})==true}!
        expect(media.httpMethod=="GET" && media.value(forHTTPHeaderField:"X-Goog-Drive-Resource-Keys")=="file1/"+DriveFixtureHTTP.key && media.httpBody==nil,"GET media uses only verified resource-key header")
        await rejects("arbitrary provider-accessible ID") {_ = try await f.session.perform(["action":"drive_file_text","id":"unselected"])}
        expect(!f.http.requests.contains {$0.url!.path.contains("unselected")} && f.store.record?.files.map(\.id)==["file1"],"model ID never dispatched or added")
        let restart=f.makeSession();_ = try await restart.perform(["action":"status"]);expect(f.opens==1 && f.consents==2,"restore requires no browser or consent")
        f.http.email="renamed@example.com";f.http.name="Renamed";_ = try await restart.perform(["action":"drive_file_metadata","id":"file1"])
        expect(f.store.record?.identity.email=="renamed@example.com" && f.store.record?.files.first?.name=="Renamed file1","stable account/file IDs permit display rename")
        f.http.mime="application/vnd.google-apps.document";f.http.size="999999999";let exported=try await restart.perform(["action":"drive_file_text","id":"file1"])
        expect((exported["representation"] as? String)?.contains("plain-text export")==true,"Docs export is text rendition, not full document fidelity")
        let export=f.http.requests.last {$0.url!.path.hasSuffix("/export")}!,exportQuery=URLComponents(url:export.url!,resolvingAgainstBaseURL:false)!.queryItems!
        expect(exportQuery==[URLQueryItem(name:"mimeType",value:"text/plain")] && export.httpMethod=="GET","fixed Docs export parameters without blob-only options")
        f.now=f.now.addingTimeInterval(3600);f.http.includeScope=false;_ = try await restart.perform(["action":"status"])
        expect(f.http.refreshes==1 && f.store.record?.tokens?.refresh.nativeValue()==DriveFixtureHTTP.refresh,"refresh retains omitted refresh token/scope")
        f.now=f.now.addingTimeInterval(3600);f.http.rotate=true;_ = try await restart.perform(["action":"status"])
        expect(f.store.record?.tokens?.refresh.nativeValue()==DriveFixtureHTTP.refresh+"-rotated","refresh replacement stored")
        // Changing the local selection requires a fresh actual Picker callback.
        let selection=DriveFixture();selection.loopback.ids="file1,file2";_ = try await selection.connect();let oldRecord=selection.store.record!.id
        selection.loopback.ids="";await rejects("empty replacement selection") {_ = try await selection.connect()};expect(selection.store.record?.id==oldRecord && !selection.store.blocked,"empty Picker preserves existing grant")
        selection.loopback.ids="file2";_ = try await selection.connect();expect(selection.store.record?.files.map(\.id)==["file2"],"native reselect replaces rather than silently unions IDs")
        await rejects("old removed selection") {_ = try await selection.session.perform(["action":"drive_file_metadata","id":"file1"])}
        _ = try await selection.makeSession().perform(["action":"status"]);expect(selection.store.record?.files.map(\.id)==["file2"],"restart never re-adds previous provider-authorized ID")
        let oldIdentity=selection.store.record!.id;selection.http.permissionID="other-account"
        await rejects("reselect changed account") {_ = try await selection.connect()};expect(selection.store.record?.id==oldIdentity && !selection.store.blocked,"failed account switch preserves prior selection")
        selection.http.permissionID="stable-drive-ID";let noClientRequest=selection.http.requests.count
        await rejects("new Desktop client without disconnect") {_ = try await selection.connect(client:"other-client.apps.googleusercontent.com")};expect(noClientRequest==selection.http.requests.count,"client binding cannot silently change")
        for fault in ["scope","partial","me","permission","metadata","browser","callback","duplicate","denied","token"] {
            let t=DriveFixture()
            switch fault {case "scope":t.http.scope+=" openid";case "partial":t.http.includeScope=false;case "me":t.http.me=false;case "permission":t.http.authorized=false;case "metadata":t.http.metadataStatus=404;case "callback":t.loopback.wrongState=true;case "duplicate":t.loopback.duplicate=true;case "denied":t.loopback.denied=true;case "token":t.http.includeRefresh=false;default:break}
            await rejects("failed native selection "+fault) {_ = try await t.connect(browser:fault != "browser")};expect(t.store.record==nil && t.store.blocked,"invalid Picker grant never activates")
        }
        for kind in ["application/pdf","image/png","application/vnd.google-apps.shortcut","application/vnd.google-apps.spreadsheet"] {
            let t=DriveFixture();t.http.mime=kind;_ = try await t.connect();_ = try await t.session.perform(["action":"drive_file_metadata","id":"file1"])
            await rejects("unsupported text MIME") {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])};expect(t.http.contents==0,"no conversion or shortcut following")
        }
        for fault in ["trashed","download","encrypted","unknown-encryption","size"] {
            let t=DriveFixture();_ = try await t.connect()
            switch fault {case "trashed":t.http.trashed=true;case "download":t.http.canDownload=false;case "encrypted":t.http.encryption="encrypted";case "unknown-encryption":t.http.unknownEncryption=true;case "size":t.http.size="262145";default:break}
            await rejects("content prerequisite "+fault) {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])};expect(t.http.contents==0,"content request forbidden before validation")
        }
        for fault in ["oversize","invalid-utf8","binary-control","wrong-content-type","version","identity"] {
            let t=DriveFixture();_ = try await t.connect()
            switch fault {case "oversize":t.http.content=Data(repeating:65,count:DrivePolicy.maxText+1);case "invalid-utf8":t.http.content=Data([0xff,0xfe]);case "binary-control":t.http.content=Data([0,1,2]);case "wrong-content-type":t.http.contentMime="application/octet-stream";case "version":t.http.afterContent={t.http.version="2"};case "identity":t.http.afterContent={t.http.permissionID="changed"};default:break}
            await rejects("late content validation "+fault) {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])};expect(t.http.contents==1,"bounded read rejected without publishing partial content")
        }
        for key in ["bad/key","bad,key","bad\r\nheader",""] {let t=DriveFixture();t.http.resourceKey=key;await rejects("ambiguous resource key") {_ = try await t.connect()};expect(t.store.record==nil,"invalid header material never saved")}
        for secret in [DriveFixtureHTTP.refresh,"1//quoted-\"refresh\"","drive-\\backslash-refresh"] {
            let t=DriveFixture();t.http.refreshSecret=secret;_ = try await t.connect();t.http.content=Data(secret.utf8);t.http.size=String(t.http.content.count)
            await rejects("escaped refresh token in text") {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])}
            t.http.content=Data(DriveFixtureHTTP.access.utf8);t.http.size=String(t.http.content.count);await rejects("access token in text") {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])}
            t.http.content=Data(DriveFixtureHTTP.key.utf8);t.http.size=String(t.http.content.count);await rejects("resource key in text") {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])}
        }
        let echo=DriveFixture();echo.http.name=DriveFixtureHTTP.refresh;await rejects("metadata secret echo") {_ = try await echo.connect()};expect(echo.store.record==nil,"metadata secret never reaches saved/native selection")
        for status in [403,404,429,500,503] {
            let t=DriveFixture();_ = try await t.connect();let id=t.store.record!.id;t.http.errorStatus=status
            await rejects("transient provider failure") {_ = try await t.session.perform(["action":"drive_file_metadata","id":"file1"])};expect(t.store.record?.id==id && !t.store.blocked,"transient errors do not change approved IDs")
            t.http.errorStatus=nil;_ = try await t.session.perform(["action":"drive_file_metadata","id":"file1"])
        }
        let identityChange=DriveFixture();_ = try await identityChange.connect();identityChange.http.permissionID="new"
        await rejects("restored account mismatch") {_ = try await identityChange.session.perform(["action":"drive_file_metadata","id":"file1"])};expect(identityChange.store.blocked && identityChange.store.record?.tokens==nil && identityChange.store.record?.files.first?.resourceKey==nil,"wrong account invalidates all access material")
        for failure in ["network","scope","cancel","save"] {
            let t=DriveFixture();_ = try await t.connect();t.now=t.now.addingTimeInterval(3600)
            if failure=="network" {t.http.fail=true};if failure=="scope" {t.http.scope="https://www.googleapis.com/auth/drive.readonly"}
            if ["cancel","save"].contains(failure) {
                t.http.holdPath="/token";let task=Task {try await t.session.perform(["action":"drive_file_metadata","id":"file1"])}
                while t.http.continuation==nil {await Task.yield()};if failure=="cancel" {t.session.cancel()} else {t.store.failSave=true};t.http.release();await rejects("refresh failure "+failure) {_ = try await task.value}
            } else {await rejects("refresh failure "+failure) {_ = try await t.session.perform(["action":"drive_file_metadata","id":"file1"])}}
            expect(t.store.record?.tokens==nil && t.store.record?.files.first?.resourceKey==nil,"uncertain refresh removes tokens and resource keys from durable record")
            t.http.fail=false;t.store.failSave=false;let calls=t.http.requests.count;_ = try await t.makeSession().perform(["action":"status"]);expect(calls==t.http.requests.count,"no automatic replay after uncertain refresh")
        }
        let expired=DriveFixture();expired.http.refreshLifetime=604800;_ = try await expired.connect();expired.now=expired.now.addingTimeInterval(604800)
        await rejects("refresh expiry") {_ = try await expired.session.perform(["action":"drive_file_metadata","id":"file1"])};expect(expired.http.refreshes==0 && expired.store.blocked,"expired grant not refreshed")
        let late=DriveFixture();_ = try await late.connect();late.http.holdPath="/drive/v3/files/file1"
        let lateTask=Task {try await late.session.perform(["action":"drive_file_text","id":"file1"])}
        while late.http.continuation==nil {await Task.yield()};late.session.cancel();late.http.release();await rejects("late read after Stop") {_ = try await lateTask.value};expect(late.http.contents==0,"Stop before metadata completion prevents content request")
        let pickerCancel=DriveFixture();pickerCancel.loopback.hold=true;let pc=Task {try await pickerCancel.connect()}
        while pickerCancel.loopback.continuation==nil {await Task.yield()};pickerCancel.session.cancel();await rejects("cancelled browser Picker") {_ = try await pc.value};expect(pickerCancel.store.record==nil,"no late Picker grant publication")
        let exchangeCancel=DriveFixture();exchangeCancel.http.holdPath="/token";let ec=Task {try await exchangeCancel.connect()}
        while exchangeCancel.http.continuation==nil {await Task.yield()};exchangeCancel.session.cancel();exchangeCancel.http.release();await rejects("cancelled exchange") {_ = try await ec.value};expect(exchangeCancel.store.record==nil,"late exchange cannot activate selected files")
        let local=DriveFixture();_ = try await local.connect();try local.session.disconnect();expect(local.store.blocked && local.store.record?.tokens==nil && local.store.record?.files.first?.resourceKey==nil && local.http.revokes==0,"local disconnect removes access material without remote revoke")
        let locked=DriveFixture();_ = try await locked.connect();locked.store.failLoad=true;await rejects("locked store disconnect") {try locked.session.disconnect()};let loads=locked.store.loads;_ = try await locked.makeSession().perform(["action":"status"]);expect(locked.store.blocked && loads==locked.store.loads,"deny marker prevents locked Keychain restore")
        let revoke=DriveFixture();_ = try await revoke.connect();try await revoke.session.revoke(consent:{_,_ in false});expect(revoke.http.revokes==0 && !revoke.store.blocked,"no remote revoke without exact native approval")
        try await revoke.session.revoke(consent:{_,_ in true});expect(revoke.http.revokes==1 && revoke.store.record?.tokens==nil && revoke.store.record?.files.first?.resourceKey==nil,"project revoke clears tokens and resource keys")
        let remote=DriveFixture();_ = try await remote.connect();remote.http.fail=true;await rejects("uncertain revoke") {try await remote.session.revoke(consent:{_,_ in true})};expect(remote.store.blocked && remote.store.record?.state == .revocationPending,"unconfirmed revoke remains blocked")
        remote.http.fail=false;let rc=remote.http.requests.count;_ = try await remote.makeSession().perform(["action":"status"]);expect(rc==remote.http.requests.count,"no automatic revoke or access restore")
        try await remote.session.revoke(consent:{_,_ in true});expect(remote.store.record?.state == .disconnected,"explicit native retry completes revoke")
        for input:[String:Any] in [["action":"connect"],["action":"drive_file_text","id":"../else"],["action":"drive_file_metadata","id":"file1","token":"x"],["action":"drive_file_text","id":"file1","scope":"drive"],["action":"status","id":"file1"]] {let before=f.http.requests.count;await rejects("strict Drive model schema") {_ = try await f.session.perform(input)};expect(before==f.http.requests.count,"invalid model input never dispatches")}
        let reflected=DriveFixture();_ = try await reflected.connect();expect(!String(reflecting:reflected.store.record!).contains(DriveFixtureHTTP.refresh) && !String(describing:reflected.store.record!.files[0]).contains(DriveFixtureHTTP.key),"tokens/resource keys not reflected")
        for change in ["download","trash","encryption","resource-key","name"] {
            let t=DriveFixture();_ = try await t.connect();t.http.afterContent={
                switch change {case "download":t.http.canDownload=false;case "trash":t.http.trashed=true;case "encryption":t.http.encryption="encrypted";case "resource-key":t.http.resourceKey="replacement-resource-key";default:t.http.name="changed name"}
            }
            await rejects("post-read permission/metadata change "+change) {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])}
        }
        for size in ["12","14"] {
            let t=DriveFixture();_ = try await t.connect();t.http.size=size
            await rejects("plain-text byte count differs from metadata") {_ = try await t.session.perform(["action":"drive_file_text","id":"file1"])}
            expect(t.http.contents==1,"shorter or longer 200 body is not published as complete")
        }
        let empty=DriveFixture();empty.http.content=Data();empty.http.size="0";_ = try await empty.connect()
        let emptyText=try await empty.session.perform(["action":"drive_file_text","id":"file1"])
        expect(emptyText["text"] as? String=="" && emptyText["complete"] as? Bool==true,"verified empty text is complete")
        let partial=DriveFixture();_ = try await partial.connect();partial.http.contentStatus=206
        await rejects("partial HTTP text is not complete") {_ = try await partial.session.perform(["action":"drive_file_text","id":"file1"])}
        let publication=DriveFixture();publication.store.failSave=true;await rejects("failed initial publication") {_ = try await publication.connect()};expect(publication.store.blocked && publication.store.record==nil,"failed token publication remains blocked")
        let replacement=DriveFixture();_ = try await replacement.connect();replacement.loopback.ids="file2";replacement.store.failSave=true
        await rejects("failed replacement publication") {_ = try await replacement.connect()};expect(replacement.store.blocked && replacement.store.record?.files.map(\.id)==["file1"],"failed selection write never activates new or old scope")
        replacement.store.failSave=false;let calls=replacement.http.requests.count;_ = try await replacement.makeSession().perform(["action":"status"]);expect(calls==replacement.http.requests.count,"failed replacement cannot restore stale selection")
        let revokeFence=DriveFixture();_ = try await revokeFence.connect();revokeFence.store.failBlock=true;let requests=revokeFence.http.requests.count
        await rejects("remote revoke fence failure") {try await revokeFence.session.revoke(consent:{_,_ in true})};expect(requests==revokeFence.http.requests.count,"no remote revoke before durable block")
        let revokeCancel=DriveFixture();_ = try await revokeCancel.connect();revokeCancel.http.holdPath="/revoke"
        let revokeTask=Task {try await revokeCancel.session.revoke(consent:{_,_ in true})}
        while revokeCancel.http.continuation==nil {await Task.yield()};revokeCancel.session.cancel();revokeCancel.http.release();await rejects("late remote revoke") {try await revokeTask.value};expect(revokeCancel.store.blocked && revokeCancel.store.record?.state == .revocationPending,"cancelled revoke remains explicitly uncertain")
        let erase=DriveFixture();_ = try await erase.connect();erase.store.failSave=true;await rejects("local erase failure") {try erase.session.disconnect()};expect(erase.store.blocked,"independent marker survives token/key erase failure")
        erase.store.failSave=false;let erasedCalls=erase.http.requests.count;_ = try await erase.makeSession().perform(["action":"status"]);expect(erasedCalls==erase.http.requests.count,"failed erase does not restore access")
        let malformed=DriveFixture();_ = try await malformed.connect()
        var raw=try JSONSerialization.jsonObject(with:JSONEncoder().encode(malformed.store.record!)) as! [String:Any];raw["destination"]="cloud"
        let wrongDestination=try JSONDecoder().decode(DriveRecord.self,from:JSONSerialization.data(withJSONObject:raw));await rejects("saved cloud destination") {try wrongDestination.validate()}
        // The API may omit encryption information; this app permits strict UTF-8
        // text then, but never claims Google guaranteed unencrypted metadata.
        let unencrypted=DriveFixture();unencrypted.http.encryption="unencrypted";_ = try await unencrypted.connect();_ = try await unencrypted.session.perform(["action":"drive_file_text","id":"file1"]);expect(unencrypted.http.contents==1,"explicit unencrypted supported text")
        let identityEcho=DriveFixture();identityEcho.http.permissionID=DriveFixtureHTTP.refresh;await rejects("Drive identity token echo") {_ = try await identityEcho.connect()};expect(identityEcho.store.record==nil,"Drive identity does not disclose secrets")
        let missingKey=DriveFixture();missingKey.http.resourceKey=nil;_ = try await missingKey.connect();_ = try await missingKey.session.perform(["action":"drive_file_text","id":"file1"]);expect(!missingKey.http.requests.contains {$0.value(forHTTPHeaderField:"X-Goog-Drive-Resource-Keys") != nil},"missing resource key is never fabricated")
        print("PASS: \(count) offline Drive Picker/identity/selected-ID/metadata/text/refresh/revoke assertions. HTTP, stores, listener and consent injected; no network, browser, UI, actual Picker, Keychain or downloads.")
    }
}
