import Foundation
import Security
import LocalAuthentication

enum GmailError:String,Error,LocalizedError {
    case configuration="Enter a registered Google Desktop OAuth client ID. Enable Gmail API and configure its restricted-scope consent first. No account was connected."
    case unavailable="Gmail is not connected. Use Noiee → Private Accounts → Gmail."
    case existing="A Gmail grant is already saved. Disconnect it locally before connecting another account or client."
    case denied="Google authorization was denied, revoked, or its identity/scope changed. Reconnect through native Gmail consent."
    case identity="Google account identity could not be verified. No account data was returned."
    case scope="Google did not grant exactly Gmail read-only and the requested OpenID/email identity scopes. No access was activated."
    case invalid="Google returned an invalid, incomplete or over-limit response. No credential details were returned."
    case callback="Google's single-use callback could not be verified. Start a new native connection."
    case listener="The local Google callback listener could not start or complete. No account was connected."
    case expired="Google authorization expired. Start a new native connection."
    case cancelled="Gmail work stopped. A Google authorization already accepted may remain. Local cancellation does not revoke it."
    case busy="Another Gmail operation is pending."
    case storage="Gmail credential storage could not be confirmed. Access is held. Retry local disconnect; do not assume removal succeeded."
    case refresh="Gmail refresh is pending or uncertain. Access is held; reconnect natively. The old refresh token will not be replayed."
    case transport="Google request failed. No provider error details or credentials were returned. No automatic retry was made."
    case revocation="Local Gmail reads are blocked, but remote Google revocation is unconfirmed. Retry Revoke or review your Google Account connections."
    var errorDescription:String? {rawValue}
}
enum GmailScopes {
    static let read="https://www.googleapis.com/auth/gmail.readonly"
    static let request="openid email "+read
    static let exact:Set<String>=["openid","email",read]
    static func validate(_ text:String)throws {
        guard text.utf8.count<=1024 else {throw GmailError.scope}
        let parts=text.split(separator:" ",omittingEmptySubsequences:false).map(String.init)
        let mapped=parts.map {$0=="https://www.googleapis.com/auth/userinfo.email" ? "email":$0}
        guard mapped.count==3,Set(mapped)==exact else {throw GmailError.scope}
    }
}
struct GmailIdentity:Codable,Equatable {
    let sub:String,email:String
    func validate()throws {
        guard !sub.isEmpty,sub.utf8.count<=255,sub.utf8.allSatisfy({$0>=33 && $0<=126}),email.utf8.count<=320,email.split(separator:"@").count==2,email.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw GmailError.identity}
    }
}
struct GmailTokens:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    let access:GmailSecret,refresh:GmailSecret,expires:Date,refreshExpires:Date?
    func validate()throws {
        _ = try GmailSecret(access.nativeValue());_ = try GmailSecret(refresh.nativeValue())
        guard expires.timeIntervalSince1970.isFinite,refreshExpires==nil || refreshExpires!.timeIntervalSince1970.isFinite else {throw GmailError.invalid}
    }
    var description:String {"[redacted Google token pair]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
}
struct GmailRecord:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    enum State:String,Codable {case active,refreshPending,revocationPending,disconnected}
    let destination:String
    let version:Int,id:UUID,state:State,registration:GmailRegistration,identity:GmailIdentity,tokens:GmailTokens?
    init(state:State,registration:GmailRegistration,identity:GmailIdentity,tokens:GmailTokens?=nil) {destination="local-agent-conversation-v1";version=1;id=UUID();self.state=state;self.registration=registration;self.identity=identity;self.tokens=tokens}
    func validate()throws {try registration.validate();try identity.validate();try tokens?.validate();guard version==1,destination=="local-agent-conversation-v1",([State.active,.revocationPending].contains(state))==(tokens != nil) else {throw GmailError.invalid}}
    var description:String {"GmailRecord(\(state.rawValue), credentials redacted)"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
}
@MainActor protocol GmailStore {
    func load()throws->GmailRecord?
    func isBlocked()throws->Bool
    func setBlocked(_ blocked:Bool)throws
    func save(_ record:GmailRecord,expected:UUID?)throws
}
@MainActor final class GmailKeychain:GmailStore {
    private let defaults:UserDefaults
    private let gate="privateGmailAccountBlockedV1"
    init(defaults:UserDefaults = .standard){self.defaults=defaults}
    func isBlocked()throws->Bool {
        guard let value=defaults.object(forKey:gate) else {return true}
        guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else {throw GmailError.storage};return n.boolValue
    }
    func setBlocked(_ blocked:Bool)throws {defaults.set(blocked,forKey:gate);guard defaults.synchronize(),try isBlocked()==blocked else {throw GmailError.storage}}
    private func query()->[String:Any] {
        let context=LAContext();context.interactionNotAllowed=true
        return [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.saleh.qwenlocal.chat.gmail-oauth.v1",kSecAttrAccount as String:"native-grant",kSecAttrSynchronizable as String:false,kSecUseAuthenticationContext as String:context]
    }
    func load()throws->GmailRecord? {
        var q=query();q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
        var value:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&value)
        if status==errSecItemNotFound {return nil}
        guard status==errSecSuccess,let bytes=value as? Data,bytes.count<=65536 else {throw GmailError.storage}
        do {let record=try JSONDecoder().decode(GmailRecord.self,from:bytes);try record.validate();return record} catch {throw GmailError.storage}
    }
    func save(_ record:GmailRecord,expected:UUID?)throws {
        do {
            try record.validate();let prior=try load();guard prior?.id==expected else {throw GmailError.storage}
            let bytes=try JSONEncoder().encode(record);guard bytes.count<=65536 else {throw GmailError.storage}
            let status:OSStatus
            if prior==nil {var q=query();q[kSecValueData as String]=bytes;q[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;status=SecItemAdd(q as CFDictionary,nil)}
            else {status=SecItemUpdate(query() as CFDictionary,[kSecValueData as String:bytes] as CFDictionary)}
            guard status==errSecSuccess,try load()?.id==record.id else {throw GmailError.storage}
        } catch {throw GmailError.storage}
    }
}
enum GmailJSON {
    static func containsCredential(_ value:Any,tokens:GmailTokens)->Bool {
        if let text=value as? String {return text.contains(tokens.access.nativeValue()) || text.contains(tokens.refresh.nativeValue())}
        if let array=value as? [Any] {return array.contains {containsCredential($0,tokens:tokens)}}
        if let object=value as? [String:Any] {return object.contains {containsCredential($0.key,tokens:tokens) || containsCredential($0.value,tokens:tokens)}}
        return false
    }
    static func object(_ data:Data,limit:Int=65536)throws->[String:Any] {guard data.count<=limit,let o=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {throw GmailError.invalid};return o}
    static func string(_ value:Any?,max:Int=8192)throws->String {guard let s=value as? String,!s.isEmpty,s.utf8.count<=max,!s.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) else {throw GmailError.invalid};return s}
    static func integer(_ value:Any?,max:Int=9007199254740991)throws->Int {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=1,n.doubleValue<=Double(max),n.doubleValue.rounded()==n.doubleValue else {throw GmailError.invalid};return n.intValue}
    static func identity(_ o:[String:Any])throws->GmailIdentity {
        guard let verified=o["email_verified"] as? NSNumber,CFGetTypeID(verified)==CFBooleanGetTypeID(),verified.boolValue else {throw GmailError.identity}
        let identity=try GmailIdentity(sub:string(o["sub"],max:255),email:string(o["email"],max:320));try identity.validate();return identity
    }
    static func tokens(_ data:Data,sent:Date,previous:GmailTokens?=nil)throws->(GmailTokens,GmailSecret?) {
        let o=try object(data,limit:32768)
        guard o["error"]==nil,(o["token_type"] as? String)?.lowercased()=="bearer" else {throw GmailError.denied}
        // RFC 6749: omitted refresh scope means the original authorized scope.
        if let scope=o["scope"] {try GmailScopes.validate(string(scope,max:1024))} else if previous==nil {throw GmailError.scope}
        let life=try integer(o["expires_in"],max:7200);guard life>60 else {throw GmailError.expired}
        let access=try GmailSecret(string(o["access_token"])),refresh:GmailSecret
        if let value=o["refresh_token"] {refresh=try .init(string(value))} else if let previous {refresh=previous.refresh} else {throw GmailError.invalid}
        let refreshExpiry:Date?
        if let lifetime=o["refresh_token_expires_in"] {refreshExpiry=sent.addingTimeInterval(Double(try integer(lifetime,max:315360000)))} else {refreshExpiry=previous?.refreshExpires}
        let tokens=GmailTokens(access:access,refresh:refresh,expires:sent.addingTimeInterval(Double(life)),refreshExpires:refreshExpiry);try tokens.validate()
        let identityToken=try o["id_token"].map {try GmailSecret(string($0,max:16384))}
        guard previous != nil || identityToken != nil else {throw GmailError.identity};return (tokens,identityToken)
    }
}
enum GmailRequest:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    case exchange(GmailAuthorization.Code),refresh(GmailRegistration,GmailSecret),revoke(GmailSecret),keys,userinfo(GmailSecret),profile(GmailSecret),read(PrivateAccountRead,PrivateAccountGrant)
    var description:String {"[redacted Google request]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    var isRevoke:Bool {if case .revoke=self {return true};return false}
    @MainActor func make()throws->URLRequest {
        let path:String;var form:[String:String]?,token:GmailSecret?
        switch self {
        case let .exchange(c):
            try c.registration.validate()
            guard c.redirect.scheme=="http",c.redirect.host=="127.0.0.1",c.redirect.path=="/oauth/callback",let p=c.redirect.port,p>=1024,p<=65535,c.redirect.query==nil,c.redirect.fragment==nil,c.redirect.user==nil,c.redirect.password==nil else {throw GmailError.callback}
            path="https://oauth2.googleapis.com/token";form=["client_id":c.registration.clientID,"code":c.code.nativeValue(),"code_verifier":c.verifier.nativeValue(),"redirect_uri":c.redirect.absoluteString,"grant_type":"authorization_code"]
        case let .refresh(reg,secret):try reg.validate();path="https://oauth2.googleapis.com/token";form=["client_id":reg.clientID,"refresh_token":secret.nativeValue(),"grant_type":"refresh_token"]
        case let .revoke(secret):path="https://oauth2.googleapis.com/revoke";form=["token":secret.nativeValue()]
        case .keys:path="https://www.googleapis.com/oauth2/v3/certs"
        case let .userinfo(access):path="https://openidconnect.googleapis.com/v1/userinfo";token=access
        case let .profile(access):path="https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress";token=access
        case let .read(operation,grant):guard operation.provider == .gmail,grant.provider == .gmail else {throw GmailError.invalid};let request=try operation.request(grant:grant);try PrivateAccountURLTransport.validate(request,maxBytes:262144);return request
        }
        var request=URLRequest(url:URL(string:path)!);request.httpMethod=form==nil ? "GET":"POST";request.timeoutInterval=30
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        if let token {request.setValue("Bearer "+token.nativeValue(),forHTTPHeaderField:"Authorization")}
        if let form {var c=URLComponents();c.queryItems=form.sorted(by:{$0.key<$1.key}).map {.init(name:$0.key,value:$0.value)};request.httpBody=Data(c.percentEncodedQuery!.replacingOccurrences(of:"+",with:"%2B").utf8);request.setValue("application/x-www-form-urlencoded",forHTTPHeaderField:"Content-Type")}
        return request
    }
}
struct GmailResponse {let status:Int,data:Data}
@MainActor protocol GmailHTTP {func send(_ operation:GmailRequest)async throws->GmailResponse}
private final class GmailRedirect:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void){completionHandler(nil)}
}
@MainActor final class GmailURLHTTP:GmailHTTP {
    private let session:URLSession
    init(){let c=URLSessionConfiguration.ephemeral;c.httpCookieStorage=nil;c.httpShouldSetCookies=false;c.urlCredentialStorage=nil;c.urlCache=nil;c.requestCachePolicy = .reloadIgnoringLocalCacheData;c.timeoutIntervalForResource=45;c.timeoutIntervalForRequest=30;session=URLSession(configuration:c,delegate:GmailRedirect(),delegateQueue:nil)}
    func send(_ operation:GmailRequest)async throws->GmailResponse {
        let request=try operation.make(),limit=request.httpMethod=="POST" ? 32768:262144
        do {
            let (stream,response)=try await session.bytes(for:request)
            guard let http=response as? HTTPURLResponse,http.url==request.url,http.expectedContentLength<=limit else {stream.task.cancel();throw GmailError.invalid}
            guard http.statusCode==200 else {stream.task.cancel();return .init(status:http.statusCode,data:Data())}
            if operation.isRevoke {stream.task.cancel();return .init(status:200,data:Data())}
            guard http.mimeType=="application/json" else {stream.task.cancel();throw GmailError.invalid}
            var data=Data();do {for try await byte in stream {try Task.checkCancellation();guard data.count<limit else {throw GmailError.invalid};data.append(byte)}} catch {stream.task.cancel();throw error}
            return .init(status:200,data:data)
        } catch let e as GmailError {throw e} catch {throw Task.isCancelled ? GmailError.cancelled:.transport}
    }
}
@MainActor final class GmailAccountSession {
    typealias VerifyID = (GmailSecret,Data,GmailSecret,GmailRegistration,String,Date,Date)throws->GmailIdentity
    private let http:any GmailHTTP,store:any GmailStore,now:()->Date,listener:@MainActor ()->any GmailLoopback,authorization:@MainActor ()->GmailAuthorization,verifyID:VerifyID
    private var generation=UUID(),busy=false,held=false,record:GmailRecord?,loopback:(any GmailLoopback)?,auth:GmailAuthorization?,worker:Task<[String:Any],Error>?
    init(http:any GmailHTTP,store:any GmailStore,now:@escaping()->Date=Date.init,listener:@escaping @MainActor ()->any GmailLoopback={GmailNativeLoopback()},authorization:@escaping @MainActor ()->GmailAuthorization={GmailAuthorization()},verifyID:@escaping VerifyID={try GmailIDToken.verify($0,jwks:$1,access:$2,registration:$3,nonce:$4,created:$5,now:$6)}) {self.http=http;self.store=store;self.now=now;self.listener=listener;self.authorization=authorization;self.verifyID=verifyID}
    func cancel(){generation=UUID();worker?.cancel();loopback?.cancel();auth?.cancel()}
    private func check(_ expected:UUID)throws {guard generation==expected,!Task.isCancelled else {throw GmailError.cancelled}}
    private func send(_ operation:GmailRequest,_ expected:UUID)async throws->Data {
        try check(expected);let response:GmailResponse
        do {response=try await http.send(operation)} catch let e as GmailError {throw e} catch {throw Task.isCancelled ? GmailError.cancelled:.transport}
        try check(expected)
        if response.status==401 {throw GmailError.denied}
        guard response.status==200,response.data.count<=262144 else {throw GmailError.transport};return response.data
    }
    private func save(_ next:GmailRecord,expected:UUID?)throws {do {try store.save(next,expected:expected);record=next} catch {held=true;record=nil;throw GmailError.storage}}
    private func invalidate(){held=true;do {try store.setBlocked(true)} catch {return};if let record {try? save(.init(state:.disconnected,registration:record.registration,identity:record.identity),expected:record.id)}}
    private func verify(_ tokens:GmailTokens,subject:String?,_ expected:UUID)async throws->GmailIdentity {
        try tokens.validate()
        let identity=try GmailJSON.identity(GmailJSON.object(await send(.userinfo(tokens.access),expected)))
        guard subject==nil || subject==identity.sub else {throw GmailError.identity}
        let profile=try GmailJSON.object(await send(.profile(tokens.access),expected)),email=try GmailJSON.string(profile["emailAddress"],max:320)
        guard email.lowercased()==identity.email.lowercased(),![identity.sub,identity.email].contains(where:{$0.contains(tokens.access.nativeValue()) || $0.contains(tokens.refresh.nativeValue())}) else {throw GmailError.identity}
        return identity
    }
    private func load()throws->GmailRecord {
        guard !held else {throw GmailError.denied}
        do {guard try !store.isBlocked(),let value=try store.load() else {throw GmailError.unavailable};try value.validate();guard value.state == .active else {throw value.state == .refreshPending ? GmailError.refresh:.unavailable};record=value;return value}
        catch let e as GmailError {throw e} catch {throw GmailError.storage}
    }
    private func usable(_ expected:UUID)async throws->GmailRecord {
        var saved=try load();guard let old=saved.tokens else {throw GmailError.unavailable}
        if old.expires<=now().addingTimeInterval(60) {
            guard old.refreshExpires==nil || old.refreshExpires!>now().addingTimeInterval(60) else {invalidate();throw GmailError.expired}
            let pending=GmailRecord(state:.refreshPending,registration:saved.registration,identity:saved.identity);try check(expected);try save(pending,expected:saved.id)
            let sent=now(),bytes=try await send(.refresh(saved.registration,old.refresh),expected),renewed=try GmailJSON.tokens(bytes,sent:sent,previous:old).0
            // A refresh ID token is not used as authentication. Fresh UserInfo and
            // Gmail profile verify the access token's same stable account instead.
            let identity=try await verify(renewed,subject:saved.identity.sub,expected)
            saved = .init(state:.active,registration:saved.registration,identity:identity,tokens:renewed);try check(expected);try save(saved,expected:pending.id)
        } else {
            let identity=try await verify(old,subject:saved.identity.sub,expected)
            if identity != saved.identity {let next=GmailRecord(state:.active,registration:saved.registration,identity:identity,tokens:old);try save(next,expected:saved.id);saved=next}
        }
        return saved
    }
    // Only native controls can invoke connect/disconnect/revoke. No bridge decoder.
    func connect(_ registration:GmailRegistration,consent:@escaping(GmailRegistration)async throws->Bool,openBrowser:@escaping(URL)throws->Bool)async throws->GmailIdentity {
        guard !busy else {throw GmailError.busy};busy=true;defer {busy=false;loopback?.cancel();auth?.cancel();loopback=nil;auth=nil};let expected=generation
        do {
            let original:GmailRecord?,blocked:Bool
            do {original=try store.load();blocked=try store.isBlocked()} catch {throw GmailError.storage}
            guard original==nil || original?.state != .active || blocked else {throw GmailError.existing}
            try registration.validate();guard try await consent(registration) else {throw GmailError.denied};try check(expected)
            do {try store.setBlocked(true)} catch {throw GmailError.storage}
            let loopback=listener(),auth=authorization();self.loopback=loopback;self.auth=auth
            let port=try await loopback.start();try check(expected)
            let request=try auth.begin(registration,port:port,now:now())
            guard try openBrowser(request.url) else {throw GmailError.listener};try check(expected)
            let callback=try await loopback.callback();try check(expected)
            let code=try auth.consume(callback,now:now()),sent=now(),bytes=try await send(.exchange(code),expected)
            let (tokens,idToken)=try GmailJSON.tokens(bytes,sent:sent);guard let idToken else {throw GmailError.identity}
            let keys=try await send(.keys,expected),identity=try verifyID(idToken,keys,tokens.access,registration,code.nonce,code.created,now())
            let verified=try await verify(tokens,subject:identity.sub,expected)
            guard verified.email.lowercased()==identity.email.lowercased() else {throw GmailError.identity}
            try check(expected)
            guard tokens.expires>now().addingTimeInterval(60) else {throw GmailError.expired}
            try save(.init(state:.active,registration:registration,identity:verified,tokens:tokens),expected:original?.id)
            do {try store.setBlocked(false)} catch {held=true;throw GmailError.storage};held=false;return verified
        } catch let e as GmailError {throw e} catch {throw Task.isCancelled ? GmailError.cancelled:.transport}
    }
    func disconnect()throws {
        cancel();held=true
        do {try store.setBlocked(true);guard let saved=try store.load() else {record=nil;return};try save(.init(state:.disconnected,registration:saved.registration,identity:saved.identity),expected:saved.id)} catch {held=true;record=nil;throw GmailError.storage}
    }
    func revoke(consent:@escaping(GmailIdentity,GmailRegistration)async throws->Bool)async throws {
        guard !busy else {throw GmailError.busy};busy=true;defer {busy=false};let expected=generation
        let saved:GmailRecord
        do {guard let value=try store.load(),[GmailRecord.State.active,.revocationPending].contains(value.state),value.tokens != nil else {throw GmailError.unavailable};try value.validate();saved=value} catch let e as GmailError {throw e} catch {throw GmailError.storage}
        guard try await consent(saved.identity,saved.registration) else {return};try check(expected)
        do {try store.setBlocked(true)} catch {throw GmailError.storage};held=true
        let pending=GmailRecord(state:.revocationPending,registration:saved.registration,identity:saved.identity,tokens:saved.tokens)
        try save(pending,expected:saved.id)
        do {_ = try await send(.revoke(saved.tokens!.refresh),expected);try check(expected)} catch {throw GmailError.revocation}
        try save(.init(state:.disconnected,registration:saved.registration,identity:saved.identity),expected:pending.id)
    }
    func perform(_ input:[String:Any])async throws->[String:Any] {
        guard let action=input["action"] as? String else {throw GmailError.invalid}
        let operation:PrivateAccountRead?
        switch action {
        case "status":guard Set(input.keys)==["action"] else {throw GmailError.invalid};operation=nil
        case "gmail_messages":
            guard Set(input.keys).isSubset(of:["action","query","pageToken"]),let query=input["query"] as? String,query.utf8.count<=1024,!query.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),input["pageToken"]==nil || input["pageToken"] is String else {throw GmailError.invalid};if let page=input["pageToken"] as? String {guard !page.isEmpty,page.utf8.count<=1024,page.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw GmailError.invalid}};operation = .gmailMessages(query:query,pageToken:input["pageToken"] as? String)
        case "gmail_message_metadata":guard Set(input.keys)==["action","id"],let id=input["id"] as? String,PrivateAccountRead.identifier(id) else {throw GmailError.invalid};operation = .gmailMessageMetadata(id:id)
        default:throw GmailError.invalid
        }
        guard !busy else {throw GmailError.busy};busy=true;defer {busy=false;worker=nil};let expected=generation
        let task=Task {()throws->[String:Any] in
            do {
                let saved=try await self.usable(expected),tokens=saved.tokens!
                if let operation {
                    let grant=try PrivateAccountGrant(provider:.gmail,token:tokens.access.nativeValue(),expiresAt:tokens.expires)
                    let result=try operation.parse(await self.send(.read(operation,grant),expected),grant:grant)
                    _ = try await self.verify(tokens,subject:saved.identity.sub,expected);try self.check(expected);guard tokens.expires>self.now() else {throw GmailError.expired}
                    guard !GmailJSON.containsCredential(result,tokens:tokens) else {throw GmailError.invalid};return result
                }
                return self.status(state:"connected",identity:saved.identity)
            } catch let e as GmailError {
                if [.identity,.denied,.scope,.expired].contains(e) {self.invalidate()}
                if operation==nil {return self.status(state:e == .unavailable ? "unconfigured":"held",message:e.localizedDescription)};throw e
            } catch let e as PrivateAccountFailure {throw e} catch {throw Task.isCancelled ? GmailError.cancelled:.transport}
        }
        worker=task;return try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
    }
    private func status(state:String,identity:GmailIdentity?=nil,message:String?=nil)->[String:Any] {
        var value:[String:Any]=["id":"gmail","state":state,"connected":state=="connected","readAvailable":state=="connected","grantAvailable":true,"requestedScope":GmailScopes.request,"message":message ?? "Verified Gmail grant. Search message IDs and read headers/snippets only. No body, attachments, sending or mutations. Native connection and revocation only."]
        if let identity {value["account"]=identity.email};return value
    }
}
