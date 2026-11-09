import Foundation
import CryptoKit

@MainActor final class GmailFixtureStore:GmailStore {
    var record:GmailRecord?,blocked=true,loads=0,saves=0,failLoad=false,failSave=false,failBlock=false
    func isBlocked()throws->Bool {blocked}
    func setBlocked(_ value:Bool)throws {if failBlock {throw NSError(domain:"LEAK_SECRET",code:1)};blocked=value}
    func load()throws->GmailRecord? {loads+=1;if failLoad {throw NSError(domain:"LEAK_SECRET",code:1)};return record}
    func save(_ value:GmailRecord,expected:UUID?)throws {saves+=1;if failSave {throw NSError(domain:"LEAK_SECRET",code:1)};guard record?.id==expected else {throw GmailError.storage};try value.validate();record=value}
}
@MainActor final class GmailFixtureLoopback:GmailLoopback {
    var started=0,cancelled=0,url:URL?,denied=false,wrongState=false,duplicate=false,hold=false,continuation:CheckedContinuation<URL,Error>?
    func start()async throws->Int {started+=1;return 49152}
    func callback()async throws->URL {
        if hold {return try await withCheckedThrowingContinuation {continuation=$0}}
        return url!
    }
    func cancel(){cancelled+=1;continuation?.resume(throwing:GmailError.cancelled);continuation=nil}
    func open(_ url:URL)->Bool {
        let query=URLComponents(url:url,resolvingAgainstBaseURL:false)!.queryItems!,state=query.first {$0.name=="state"}!.value!
        var callback=URLComponents(string:"http://127.0.0.1:49152/oauth/callback")!
        callback.queryItems=[.init(name:"state",value:wrongState ? "wrong":state),.init(name:denied ? "error":"code",value:denied ? "access_denied":"fixture-authorization-code")]
        if duplicate {callback.queryItems!.append(.init(name:"state",value:state))}
        self.url=callback.url;return true
    }
}
@MainActor final class GmailFixtureHTTP:GmailHTTP {
    static let access="fixture-google-access-secret",refresh="fixture-google-refresh-secret"
    var requests:[URLRequest]=[],scope=GmailScopes.request,email="fixture@example.com",sub="stable-Sub123",profileEmail:String?,identitySub:String?,tokenType="Bearer",errorStatus:Int?,fail=false
    var refreshSecret=GmailFixtureHTTP.refresh,readEcho:String?
    var includeRefresh=true,includeScope=true,rotate=false,refreshLifetime:Int?,idToken=true,afterRead:(()->Void)?,holdPath:String?,continuation:CheckedContinuation<Void,Never>?,refreshes=0,revokes=0
    func send(_ operation:GmailRequest)async throws->GmailResponse {
        let r=try operation.make();requests.append(r)
        if r.url!.path==holdPath {await withCheckedContinuation {continuation=$0}}
        if fail {throw NSError(domain:"LEAK_SECRET",code:1,userInfo:[NSLocalizedDescriptionKey:Self.access])}
        if let errorStatus {return .init(status:errorStatus,data:Data(Self.refresh.utf8))}
        let value:Any
        switch operation {
        case .exchange:
            var row:[String:Any]=["access_token":Self.access,"token_type":tokenType,"expires_in":3600]
            if includeRefresh {row["refresh_token"]=refreshSecret};if includeScope {row["scope"]=scope};if idToken {row["id_token"]="fixture-identity-token"};if let refreshLifetime {row["refresh_token_expires_in"]=refreshLifetime};value=row
        case .refresh:
            refreshes+=1;var row:[String:Any]=["access_token":Self.access+"-renewed","token_type":tokenType,"expires_in":3600]
            if rotate {row["refresh_token"]=Self.refresh+"-rotated"};if includeScope {row["scope"]=scope};value=row
        case .keys:value=["keys":[]]
        case .userinfo:value=["sub":identitySub ?? sub,"email":email,"email_verified":true,"unknown":Self.refresh]
        case .profile:value=["emailAddress":profileEmail ?? email]
        case .revoke:revokes+=1;value=[:]
        case let .read(operation,_):
            if case .gmailMessages=operation {value=["messages":[["id":"abc123","threadId":"def456"]],"resultSizeEstimate":1]}
            else {value=["id":"abc123","threadId":"def456","snippet":readEcho ?? ("Snippet "+Self.access),"payload":["headers":[["name":"Subject","value":"Untrusted"],["name":"From","value":"fixture@example.com"]]]]}
            afterRead?()
        }
        return .init(status:200,data:try JSONSerialization.data(withJSONObject:value))
    }
    func release(){continuation?.resume();continuation=nil}
}
@MainActor final class GmailFixture {
    var now=Date(timeIntervalSince1970:1_800_000_000),counter:UInt8=0,nonce="",verificationFails=false,consents=0,opens=0
    let store=GmailFixtureStore(),http=GmailFixtureHTTP(),loopback=GmailFixtureLoopback()
    lazy var session=makeSession()
    func makeSession()->GmailAccountSession {
        GmailAccountSession(http:http,store:store,now:{self.now},listener:{self.loopback},authorization:{GmailAuthorization(random:{self.counter+=1;return Data(repeating:self.counter,count:32)})},verifyID:{_,_,_,_,nonce,_,_ in
            self.nonce=nonce;if self.verificationFails {throw GmailError.identity};return .init(sub:self.http.sub,email:self.http.email)
        })
    }
    func connect(consent:Bool=true,browser:Bool=true)async throws->GmailIdentity {
        try await session.connect(.init("fixture-client.apps.googleusercontent.com"),consent:{_ in self.consents+=1;return consent},openBrowser:{url in self.opens+=1;return browser && self.loopback.open(url)})
    }
}
@main struct GmailAccountsCheck {
    @MainActor static var count=0
    @MainActor static func expect(_ truth:Bool,_ title:String) {count+=1;guard truth else {fatalError("FAIL: "+title)}}
    @MainActor static func rejects(_ title:String,_ operation:()async throws->Void)async {
        do {try await operation();fatalError("FAIL: accepted "+title)} catch {expect(!error.localizedDescription.contains("LEAK_SECRET") && !error.localizedDescription.contains(GmailFixtureHTTP.access) && !error.localizedDescription.contains(GmailFixtureHTTP.refresh),"sanitized rejection "+title)}
    }
    @MainActor static func main()async throws {
        let registration=try GmailRegistration("fixture-client.apps.googleusercontent.com"),date=Date(timeIntervalSince1970:1_800_000_000)
        // Public RFC 7515 A.2 test vector: public key and signature only. No key generation.
        let key:[String:Any]=["kty":"RSA","alg":"RS256","use":"sig","n":"ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ","e":"AQAB"]
        let signing="eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ"
        let signature="cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw"
        try GmailIDToken.signature(signingInput:signing,signature:signature,key:key);expect(true,"RFC public RS256 vector verifies using Security")
        await rejects("tampered RSA message") {try GmailIDToken.signature(signingInput:signing+"x",signature:signature,key:key)}
        await rejects("tampered RSA signature") {try GmailIDToken.signature(signingInput:signing,signature:"A"+signature.dropFirst(),key:key)}
        var wrongKey=key;wrongKey["alg"]="HS256";await rejects("algorithm confusion") {try GmailIDToken.signature(signingInput:signing,signature:signature,key:wrongKey)}
        let access=try GmailSecret(GmailFixtureHTTP.access),nonce="fixture-nonce"
        let claims:[String:Any]=["iss":"https://accounts.google.com","aud":registration.clientID,"azp":registration.clientID,"sub":"stable-Sub123","email":"fixture@example.com","email_verified":true,"iat":1_800_000_000,"exp":1_800_003_600,"nonce":nonce,"at_hash":GmailAuthorization.base64(Data(SHA256.hash(data:Data(GmailFixtureHTTP.access.utf8))).prefix(16))]
        let identity=try GmailIDToken.claimsIdentity(claims,access:access,registration:registration,nonce:nonce,created:date,now:date)
        expect(identity.sub=="stable-Sub123","stable subject preserves case and nonnumeric ASCII")
        for (field,value) in [("iss","https://evil.example"),("aud","other-client"),("azp","other-client"),("nonce","wrong"),("sub",""),("email_verified",false),("exp",1_799_999_999),("iat",1_800_000_061),("at_hash","wrong")] as [(String,Any)] {
            var bad=claims;bad[field]=value
            await rejects("OIDC claim "+field) {_ = try GmailIDToken.claimsIdentity(bad,access:access,registration:registration,nonce:nonce,created:date,now:date)}
        }
        var missingNonce=claims;missingNonce.removeValue(forKey:"nonce");await rejects("missing nonce") {_ = try GmailIDToken.claimsIdentity(missingNonce,access:access,registration:registration,nonce:nonce,created:date,now:date)}
        let sample=try GmailSecret(signing+"."+signature)
        await rejects("RFC vector is not Google token") {_ = try GmailIDToken.verify(sample,jwks:JSONSerialization.data(withJSONObject:["keys":[key]]),access:access,registration:registration,nonce:nonce,created:date,now:date)}
        for alg in ["none","HS256","RS512"] {
            let head=GmailAuthorization.base64(try JSONSerialization.data(withJSONObject:["alg":alg,"kid":"fixture"]))
            let payload=GmailAuthorization.base64(try JSONSerialization.data(withJSONObject:claims)),token=try GmailSecret(head+"."+payload+".YWJjZA")
            await rejects("untrusted algorithm "+alg) {_ = try GmailIDToken.verify(token,jwks:JSONSerialization.data(withJSONObject:["keys":[key]]),access:access,registration:registration,nonce:nonce,created:date,now:date)}
        }
        try GmailScopes.validate("https://www.googleapis.com/auth/userinfo.email "+GmailScopes.read+" openid");expect(true,"documented email scope alias")
        for scope in ["openid email",GmailScopes.request+" https://www.googleapis.com/auth/drive.readonly",GmailScopes.request+" email","",GmailScopes.request.replacingOccurrences(of:"readonly",with:"modify")] {await rejects("partial/broad/duplicate scope") {try GmailScopes.validate(scope)}}
        // PKCE/state/nonce and callback parser, no listener/socket is constructed.
        func auth()->GmailAuthorization {var n:UInt8=0;return GmailAuthorization(random:{n+=1;return Data(repeating:n,count:32)})}
        let a=auth(),request=try a.begin(registration,port:49152,now:date),query=URLComponents(url:request.url,resolvingAgainstBaseURL:false)!.queryItems!
        func q(_ name:String)->String {query.first {$0.name==name}!.value!}
        expect(request.url.host=="accounts.google.com" && q("code_challenge_method")=="S256" && q("nonce") != q("state") && q("scope")==GmailScopes.request,"fixed authorization, PKCE and distinct nonce/state")
        let verifier=GmailAuthorization.base64(Data(repeating:2,count:32));expect(q("code_challenge")==GmailAuthorization.base64(Data(SHA256.hash(data:Data(verifier.utf8)))),"S256 computed verifier")
        let callback=URL(string:"http://127.0.0.1:49152/oauth/callback?state="+q("state")+"&code=fixture-code")!
        let code=try a.consume(callback,now:date);expect(code.verifier.nativeValue()==verifier && code.nonce==q("nonce"),"callback preserves verifier and nonce")
        await rejects("state replay") {_ = try a.consume(callback,now:date)}
        for change in ["host","port","path","fragment","duplicate","state","denied","expired","backward"] {
            let a=auth(),r=try a.begin(registration,port:49152,now:date),state=URLComponents(url:r.url,resolvingAgainstBaseURL:false)!.queryItems!.first {$0.name=="state"}!.value!
            var c=URLComponents(string:"http://127.0.0.1:49152/oauth/callback")!;c.queryItems=[.init(name:"state",value:state),.init(name:"code",value:"fixture-code")]
            switch change {case "host":c.host="localhost";case "port":c.port=49153;case "path":c.path="/other";case "fragment":c.fragment="x";case "duplicate":c.queryItems!.append(.init(name:"state",value:state));case "state":c.queryItems![0].value="wrong";case "denied":c.queryItems!.append(.init(name:"error",value:"access_denied"));default:break}
            await rejects("callback "+change) {_ = try a.consume(c.url!,now:change=="expired" ? date.addingTimeInterval(301):change=="backward" ? date.addingTimeInterval(-1):date)}
            await rejects("failed callback consumed once") {_ = try a.consume(c.url!,now:date)}
        }
        let cancelAuth=auth();_ = try cancelAuth.begin(registration,port:49152,now:date);cancelAuth.cancel();await rejects("cancelled callback") {_ = try cancelAuth.consume(callback,now:date)}
        let raw="GET /oauth/callback?state=one&code=fixture-code HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nConnection: close\r\n\r\n"
        expect(try GmailLoopbackParser.parse(Data(raw.utf8),port:49152).host=="127.0.0.1","strict loopback HTTP parser")
        for changed in [raw.replacingOccurrences(of:"GET ",with:"POST "),raw.replacingOccurrences(of:"127.0.0.1:49152",with:"evil.example"),raw.replacingOccurrences(of:"Connection: close",with:"Host: 127.0.0.1:49152"),raw.replacingOccurrences(of:"Connection: close",with:"Transfer-Encoding: chunked"),raw+"body",String(repeating:"x",count:8193)] {await rejects("host/method/smuggling/size") {_ = try GmailLoopbackParser.parse(Data(changed.utf8),port:49152)}}
        // Session tests inject transport/store/listener/signature identity result.
        let f=GmailFixture();let status=try await f.session.perform(["action":"status"]);expect(status["state"] as? String=="unconfigured" && f.http.requests.isEmpty,"unconfigured no network")
        await rejects("native consent denied") {_ = try await f.connect(consent:false)};expect(f.http.requests.isEmpty && f.loopback.started==0 && f.opens==0 && f.store.saves==0,"no account/browser/listener before consent")
        let connected=try await f.connect();expect(connected.email=="fixture@example.com" && f.store.record?.state == .active && !f.store.blocked,"verified account saved after one native approval")
        expect(f.store.record?.destination=="local-agent-conversation-v1" && f.nonce.count==43,"durable local destination and nonce verifier")
        expect(!String(describing:f.store.record!).contains(GmailFixtureHTTP.access) && !String(reflecting:f.store.record!).contains(GmailFixtureHTTP.refresh),"credential reflection redacted")
        for request in f.http.requests {expect(request.url!.scheme=="https" && request.url!.user==nil && !request.url!.absoluteString.contains(GmailFixtureHTTP.access) && !request.url!.absoluteString.contains(GmailFixtureHTTP.refresh),"fixed HTTPS never credentials in URL")}
        let exchange=f.http.requests.first {$0.url!.path=="/token"}!,body=String(data:exchange.httpBody!,encoding:.utf8)!
        expect(exchange.httpMethod=="POST" && body.contains("code_verifier=") && body.contains("redirect_uri=http") && !body.contains("client_secret"),"secretless public Desktop exchange")
        let list=try await f.session.perform(["action":"gmail_messages","query":"is:unread"]);expect((list["messages"] as? [[String:String]])?.first?["id"]=="abc123","bounded message search")
        let message=try await f.session.perform(["action":"gmail_message_metadata","id":"abc123"]);expect(message["bodyIncluded"] as? Bool==false && !(message["snippet"] as! String).contains(GmailFixtureHTTP.access),"metadata only and access redaction")
        expect(!f.http.requests.contains {$0.url!.path.contains("send") || $0.url!.path.contains("attachments")},"no Gmail write/body/attachment route")
        let restart=f.makeSession();_ = try await restart.perform(["action":"status"]);expect(f.consents==2 && f.opens==1,"automatic restore never native/browser approval again")
        f.http.email="renamed@example.com";_ = try await restart.perform(["action":"status"]);expect(f.store.record?.identity.email=="renamed@example.com","stable-sub email rename persists without new grant")
        f.now=f.now.addingTimeInterval(3600);f.http.includeScope=false
        _ = try await restart.perform(["action":"status"]);expect(f.http.refreshes==1 && f.store.record?.tokens?.refresh.nativeValue()==GmailFixtureHTTP.refresh,"refresh preserves omitted refresh token and scopes")
        f.now=f.now.addingTimeInterval(3600);f.http.rotate=true;_ = try await restart.perform(["action":"status"]);expect(f.store.record?.tokens?.refresh.nativeValue()==GmailFixtureHTTP.refresh+"-rotated","returned replacement refresh token persisted")
        for input:[String:Any] in [["action":"connect"],["action":"revoke"],["action":"gmail_messages","query":"q","token":"x"],["action":"gmail_messages","query":String(repeating:"x",count:1025)],["action":"gmail_message_metadata","id":"../profile"],["action":"status","scope":"full"],["action":"gmail_messages","query":"q","pageToken":false]] {
            let before=f.http.requests.count;await rejects("strict model schema") {_ = try await restart.perform(input)};expect(before==f.http.requests.count,"invalid input never dispatches")
        }
        for fault in ["callback","duplicate","browser","google-denial","signature","scope","partial","token","idtoken","identity","profile"] {
            let t=GmailFixture()
            switch fault {case "callback":t.loopback.wrongState=true;case "duplicate":t.loopback.duplicate=true;case "google-denial":t.loopback.denied=true;case "signature":t.verificationFails=true;case "scope":t.http.scope+=" other";case "partial":t.http.scope="openid email";case "token":t.http.includeRefresh=false;case "idtoken":t.http.idToken=false;case "identity":t.http.identitySub="different";case "profile":t.http.profileEmail="other@example.com";default:break}
            await rejects("failed connect "+fault) {_ = try await t.connect(browser:fault != "browser")};expect(t.store.record==nil && t.store.blocked,"failed setup never enables "+fault)
        }
        for httpStatus in [403,404,429,500,503] {
            let t=GmailFixture();_ = try await t.connect();let id=t.store.record!.id;t.http.errorStatus=httpStatus
            await rejects("transient HTTP") {_ = try await t.session.perform(["action":"gmail_messages","query":"q"])};expect(t.store.record?.id==id && !t.store.blocked,"transient read preserves grant")
            t.http.errorStatus=nil;_ = try await t.session.perform(["action":"gmail_messages","query":"q"])
        }
        for fault in ["401","sub","during"] {
            let t=GmailFixture();_ = try await t.connect()
            if fault=="401" {t.http.errorStatus=401};if fault=="sub" {t.http.identitySub="different"};if fault=="during" {t.http.afterRead={t.http.identitySub="different"}}
            await rejects("account invalidation "+fault) {_ = try await t.session.perform(["action":"gmail_messages","query":"q"])};expect(t.store.blocked && t.store.record?.tokens==nil,"changed identity never exposes result or survives restart")
        }
        let uncertain=GmailFixture();_ = try await uncertain.connect();uncertain.now=uncertain.now.addingTimeInterval(3600);uncertain.http.fail=true
        await rejects("uncertain refresh") {_ = try await uncertain.session.perform(["action":"gmail_messages","query":"q"])}
        expect(uncertain.store.record?.state == .refreshPending && uncertain.store.record?.tokens==nil,"durable refresh uncertainty tombstone")
        uncertain.http.fail=false;let before=uncertain.http.requests.count;_ = try await uncertain.makeSession().perform(["action":"status"]);expect(before==uncertain.http.requests.count,"restart never replays uncertain refresh")
        let broad=GmailFixture();_ = try await broad.connect();broad.now=broad.now.addingTimeInterval(3600);broad.http.scope+=" broad"
        await rejects("refresh scope expansion") {_ = try await broad.session.perform(["action":"gmail_messages","query":"q"])};expect(broad.store.blocked,"scope expansion held")
        let timed=GmailFixture();timed.http.refreshLifetime=604800;_ = try await timed.connect();timed.now=timed.now.addingTimeInterval(604800)
        await rejects("testing token expiry") {_ = try await timed.session.perform(["action":"gmail_messages","query":"q"])};expect(timed.http.refreshes==0 && timed.store.blocked,"expired refresh never attempted")
        let cancelled=GmailFixture();_ = try await cancelled.connect();cancelled.http.holdPath="/gmail/v1/users/me/messages"
        let task=Task {try await cancelled.session.perform(["action":"gmail_messages","query":"q"])}
        while cancelled.http.continuation==nil {await Task.yield()};cancelled.session.cancel();cancelled.http.release();await rejects("late read cancellation") {_ = try await task.value}
        let refreshCancel=GmailFixture();_ = try await refreshCancel.connect();refreshCancel.now=refreshCancel.now.addingTimeInterval(3600);refreshCancel.http.holdPath="/token"
        let rt=Task {try await refreshCancel.session.perform(["action":"gmail_messages","query":"q"])}
        while refreshCancel.http.continuation==nil {await Task.yield()};refreshCancel.session.cancel();refreshCancel.http.release();await rejects("refresh cancellation") {_ = try await rt.value};expect(refreshCancel.store.record?.state == .refreshPending,"cancelled refresh no replay")
        let browserCancel=GmailFixture();browserCancel.loopback.hold=true;let bt=Task {try await browserCancel.connect()}
        while browserCancel.loopback.continuation==nil {await Task.yield()};browserCancel.session.cancel();await rejects("browser callback cancellation") {_ = try await bt.value};expect(browserCancel.store.record==nil,"cancelled browser never stores grant")
        let local=GmailFixture();_ = try await local.connect();try local.session.disconnect();expect(local.store.blocked && local.store.record?.tokens==nil && local.http.revokes==0,"local disconnect is not remote revoke")
        let locked=GmailFixture();_ = try await locked.connect();locked.store.failLoad=true;await rejects("locked store disconnect") {try locked.session.disconnect()};expect(locked.store.blocked,"independent marker saved before locked Keychain")
        let loads=locked.store.loads;_ = try await locked.makeSession().perform(["action":"status"]);expect(locked.store.loads==loads,"blocked restore never opens Keychain")
        let revoke=GmailFixture();_ = try await revoke.connect();try await revoke.session.revoke(consent:{_,_ in false});expect(revoke.http.revokes==0 && !revoke.store.blocked,"remote revoke exact native approval")
        try await revoke.session.revoke(consent:{_,_ in true});expect(revoke.http.revokes==1 && revoke.store.record?.tokens==nil && revoke.store.blocked,"confirmed remote revoke removes local tokens")
        let revokeReq=revoke.http.requests.last!;expect(revokeReq.url!.absoluteString=="https://oauth2.googleapis.com/revoke" && String(data:revokeReq.httpBody!,encoding:.utf8)!.contains("token=") && revokeReq.value(forHTTPHeaderField:"Authorization")==nil,"revoke token in fixed form body only")
        let remoteUnknown=GmailFixture();_ = try await remoteUnknown.connect();remoteUnknown.http.fail=true
        await rejects("uncertain remote revoke") {try await remoteUnknown.session.revoke(consent:{_,_ in true})};expect(remoteUnknown.store.blocked && remoteUnknown.store.record?.state == .revocationPending,"uncertain revoke blocked with retry material")
        remoteUnknown.http.fail=false;let remoteCount=remoteUnknown.http.requests.count;_ = try await remoteUnknown.makeSession().perform(["action":"status"]);expect(remoteCount==remoteUnknown.http.requests.count,"no automatic revoke retry or access restoration")
        try await remoteUnknown.session.revoke(consent:{_,_ in true});expect(remoteUnknown.store.record?.state == .disconnected,"native retry can complete pending revocation")
        let publish=GmailFixture();publish.store.failSave=true;await rejects("credential publication failure") {_ = try await publish.connect()};expect(publish.store.blocked,"failed token publication cannot activate")
        let echo=GmailFixture();echo.http.email=GmailFixtureHTTP.refresh+"@example.com";await rejects("identity credential echo") {_ = try await echo.connect()};expect(echo.store.record==nil,"status cannot echo token")
        // Full JWT parser must reject unsupported headers, keys and signatures
        // before claims can become an identity. Positive RSA is tested above.
        let payload=GmailAuthorization.base64(try JSONSerialization.data(withJSONObject:claims))
        for mode in ["unknown-kid","duplicate-kid","jku","signature","missing-kid"] {
            var header:[String:Any]=["alg":"RS256","kid":"fixture"]
            var jwk=key;jwk["kid"]="fixture";var keys=[jwk]
            if mode=="unknown-kid" {header["kid"]="unknown"};if mode=="duplicate-kid" {keys.append(jwk)};if mode=="jku" {header["jku"]="https://evil.example/keys"};if mode=="missing-kid" {header.removeValue(forKey:"kid")}
            let jwt=try GmailSecret(GmailAuthorization.base64(JSONSerialization.data(withJSONObject:header))+"."+payload+"."+signature)
            await rejects("JWT key/header "+mode) {_ = try GmailIDToken.verify(jwt,jwks:JSONSerialization.data(withJSONObject:["keys":keys]),access:access,registration:registration,nonce:nonce,created:date,now:date)}
        }
        let defaultStore=GmailFixtureStore(),defaultHTTP=GmailFixtureHTTP(),defaultLoop=GmailFixtureLoopback()
        var deterministic:UInt8=0
        let defaultVerify=GmailAccountSession(http:defaultHTTP,store:defaultStore,now:{date},listener:{defaultLoop},authorization:{GmailAuthorization(random:{deterministic+=1;return Data(repeating:deterministic,count:32)})})
        await rejects("default session never trusts injected token claims") {_ = try await defaultVerify.connect(registration,consent:{_ in true},openBrowser:{defaultLoop.open($0)})}
        expect(defaultStore.record==nil,"production default invokes full JWT verification")
        let refreshSave=GmailFixture();_ = try await refreshSave.connect();refreshSave.now=refreshSave.now.addingTimeInterval(3600)
        refreshSave.http.afterRead=nil;refreshSave.http.holdPath="/token"
        let st=Task {try await refreshSave.session.perform(["action":"gmail_messages","query":"q"])}
        while refreshSave.http.continuation==nil {await Task.yield()};refreshSave.store.failSave=true;refreshSave.http.release()
        await rejects("rotated credential publication failure") {_ = try await st.value};expect(refreshSave.store.record?.state == .refreshPending,"publication failure cannot restore old refresh")
        refreshSave.store.failSave=false;let sc=refreshSave.http.requests.count;_ = try await refreshSave.makeSession().perform(["action":"status"]);expect(sc==refreshSave.http.requests.count,"publication failure no restart replay")
        let invalidGrant=GmailFixture();_ = try await invalidGrant.connect();invalidGrant.now=invalidGrant.now.addingTimeInterval(3600);invalidGrant.http.errorStatus=400
        await rejects("invalid-grant response") {_ = try await invalidGrant.session.perform(["action":"gmail_messages","query":"q"])};expect(invalidGrant.store.record?.state == .refreshPending,"400 refresh failure never enters refresh loop")
        let blockedRevoke=GmailFixture();_ = try await blockedRevoke.connect();blockedRevoke.store.failBlock=true;let br=blockedRevoke.http.requests.count
        await rejects("revoke deny marker failure") {try await blockedRevoke.session.revoke(consent:{_,_ in true})};expect(br==blockedRevoke.http.requests.count,"no revocation before durable local block")
        let disconnectFailure=GmailFixture();_ = try await disconnectFailure.connect();disconnectFailure.store.failSave=true
        await rejects("disconnect token erase failure") {try disconnectFailure.session.disconnect()};expect(disconnectFailure.store.blocked,"erase failure still blocks persisted grant")
        disconnectFailure.store.failSave=false;let dr=disconnectFailure.http.requests.count;_ = try await disconnectFailure.makeSession().perform(["action":"status"]);expect(dr==disconnectFailure.http.requests.count,"disconnect cannot restore after erase failure")
        let cancelledGrant=GmailFixture();cancelledGrant.http.holdPath="/token";let cg=Task {try await cancelledGrant.connect()}
        while cancelledGrant.http.continuation==nil {await Task.yield()};cancelledGrant.session.cancel();cancelledGrant.http.release();await rejects("late token exchange cancelled") {_ = try await cg.value};expect(cancelledGrant.store.record==nil && cancelledGrant.store.blocked,"late exchange never publishes credentials")
        let revokeCancel=GmailFixture();_ = try await revokeCancel.connect();revokeCancel.http.holdPath="/revoke";let rc=Task {try await revokeCancel.session.revoke(consent:{_,_ in true})}
        while revokeCancel.http.continuation==nil {await Task.yield()};revokeCancel.session.cancel();revokeCancel.http.release();await rejects("late revoke cancelled") {try await rc.value};expect(revokeCancel.store.blocked && revokeCancel.store.record?.state == .revocationPending,"cancelled revoke remains explicitly uncertain")
        let malformedRecord=GmailFixture();_ = try await malformedRecord.connect()
        var recordJSON=try JSONSerialization.jsonObject(with:JSONEncoder().encode(malformedRecord.store.record!)) as! [String:Any]
        recordJSON["destination"]="cloud-provider"
        let wrongDestination=try JSONDecoder().decode(GmailRecord.self,from:JSONSerialization.data(withJSONObject:recordJSON))
        await rejects("stored destination change") {try wrongDestination.validate()}
        let secretPlus=try GmailSecret("fixture+secret&value=?")
        let form=try GmailRequest.revoke(secretPlus).make(),formText=String(data:form.httpBody!,encoding:.utf8)!
        expect(formText.contains("%2B") && formText.contains("%26") && form.url!.query==nil,"OAuth form encodes plus and separators without URL leakage")
        for secret in ["1//synthetic-refresh-token","synthetic-\"quoted\"-token","synthetic-\\backslash-token"] {
            let escaping=GmailFixture();escaping.http.refreshSecret=secret;_ = try await escaping.connect();escaping.http.readEcho=secret
            await rejects("escaped refresh echo") {_ = try await escaping.session.perform(["action":"gmail_message_metadata","id":"abc123"])}
            let tokens=escaping.store.record!.tokens!
            expect(GmailJSON.containsCredential(["nested":[["header":secret]]],tokens:tokens),"recursive escaped secret detection")
            expect(GmailJSON.containsCredential([secret:"value"],tokens:tokens),"credential in object key refused")
            expect(GmailJSON.containsCredential(["nested":[GmailFixtureHTTP.access]],tokens:tokens),"recursive access secret detection")
        }
        print("PASS: \(count) offline Gmail OAuth/identity/consent/read/refresh/revoke assertions. Public RSA vector verified; all session transports, listener, stores and consent injected. No live provider, socket, browser, UI or Keychain.")
    }
}
