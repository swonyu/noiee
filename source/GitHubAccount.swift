import Foundation
import Security
import LocalAuthentication

// Registered GitHub App device flow. These types have no WebKit/model decoder.
// Only native UI can invoke connect. Tokens never leave this native subsystem.
enum GitHubAccountError:String,Error,LocalizedError {
    case configuration="Enter the registered GitHub App slug and client ID in Private Accounts. No secret or private key is needed."
    case permissions="The GitHub App or installation is not limited to selected repositories with Metadata and Issues read-only permissions. No access was activated."
    case denied="GitHub authorization was denied, revoked, suspended or changed. Reconnect through Private Accounts."
    case invalid="GitHub returned an invalid, incomplete or over-limit response. No account access was activated."
    case cancelled="Private-account work stopped. Any GitHub authorization already granted may remain; revoke it in GitHub Settings → Applications → Authorized GitHub Apps if unwanted."
    case busy="Another private-account operation is pending."
    case existing="A GitHub account grant is already saved. Disconnect locally before connecting a different account or app."
    case unavailable="GitHub is not connected. Use Noiee → Private Accounts."
    case transport="GitHub request failed. Credentials and provider error details were not returned. No automatic retry was made."
    case storage="Credential storage could not be confirmed. Access is held. Retry local disconnect in Private Accounts; do not assume removal succeeded."
    case refresh="Token refresh is pending or unconfirmed. Access is held; reconnect through native authorization. The old refresh token will not be replayed."
    case expired="GitHub authorization expired. Reconnect through Private Accounts."
    var errorDescription:String? {rawValue}
}

struct GitHubAccountSecret:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    fileprivate let value:String
    init(_ value:String,prefix:String) throws {
        guard value.hasPrefix(prefix),value.utf8.count>=12,value.utf8.count<=8192,value.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw GitHubAccountError.invalid}
        self.value=value
    }
    var description:String {"[redacted GitHub credential]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
}
struct GitHubAccountRegistration:Codable,Equatable {
    let slug:String,clientID:String
    init(slug:String,clientID:String)throws {
        guard !slug.isEmpty,slug.utf8.count<=100,slug.utf8.allSatisfy({($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45}),
              clientID.utf8.count>=8,clientID.utf8.count<=100,clientID.utf8.allSatisfy({($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==46||$0==95}) else {throw GitHubAccountError.configuration}
        self.slug=slug;self.clientID=clientID
    }
    func validate()throws {_ = try Self(slug:slug,clientID:clientID)}
}
struct GitHubAccountApp:Equatable {let id:Int,registration:GitHubAccountRegistration}
struct GitHubAccountUser:Codable,Equatable {let id:Int,login:String}
struct GitHubAccountInstallation:Codable,Equatable {let id:Int,owner:GitHubAccountUser}
struct GitHubAccountRepository:Codable,Equatable {let id:Int,name:String}
struct GitHubAccountSelection:Codable,Equatable {
    let registration:GitHubAccountRegistration,appID:Int,user:GitHubAccountUser,installation:GitHubAccountInstallation,repositories:[GitHubAccountRepository]
    func validate()throws {
        try registration.validate()
        guard appID>0,user.id>0,installation.id>0,installation.owner.id>0,
              GitHubAccountJSON.login(user.login),GitHubAccountJSON.login(installation.owner.login),
              !repositories.isEmpty,repositories.count<=100,Set(repositories.map(\.id)).count==repositories.count,Set(repositories.map(\.name)).count==repositories.count,
              repositories.allSatisfy({$0.id>0 && PrivateAccountRead.repository($0.name) && $0.name==$0.name.lowercased()}) else {throw GitHubAccountError.invalid}
    }
}
struct GitHubAccountTokens:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    let access:GitHubAccountSecret,refresh:GitHubAccountSecret,expires:Date,refreshExpires:Date
    var description:String {"[redacted GitHub token pair]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    func validate()throws {
        _ = try GitHubAccountSecret(access.value,prefix:"ghu_");_ = try GitHubAccountSecret(refresh.value,prefix:"ghr_")
        guard expires.timeIntervalSince1970.isFinite,refreshExpires.timeIntervalSince1970.isFinite,refreshExpires>expires else {throw GitHubAccountError.invalid}
    }
}
struct GitHubAccountRecord:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    enum State:String,Codable {case active,refreshPending,disconnected}
    let version:Int,id:UUID,state:State,selection:GitHubAccountSelection,tokens:GitHubAccountTokens?
    init(state:State,selection:GitHubAccountSelection,tokens:GitHubAccountTokens?=nil) {version=1;id=UUID();self.state=state;self.selection=selection;self.tokens=tokens}
    func validate()throws {try selection.validate();try tokens?.validate();guard version==1,(state == .active)==(tokens != nil) else {throw GitHubAccountError.invalid}}
    var description:String {"GitHubAccountRecord(\(state.rawValue), credentials redacted)"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
}

@MainActor protocol GitHubAccountStore {
    func load()throws->GitHubAccountRecord?
    func isBlocked()throws->Bool
    func setBlocked(_ blocked:Bool)throws
    // Native single writer, exact expected record prevents an app-level stale save.
    func save(_ value:GitHubAccountRecord,expected:UUID?)throws
}
@MainActor final class GitHubAccountKeychain:GitHubAccountStore {
    // Independent non-secret deny marker can persist even while Keychain is locked.
    // Missing/invalid state never activates a stored credential. This is app state,
    // not a security boundary against arbitrary same-user native code.
    private let defaults:UserDefaults
    private let gateKey="privateGitHubAccountBlockedV1"
    init(defaults:UserDefaults = .standard) {self.defaults=defaults}
    func isBlocked()throws->Bool {
        guard let object=defaults.object(forKey:gateKey) else {return true}
        guard let n=object as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else {throw GitHubAccountError.storage}
        return n.boolValue
    }
    func setBlocked(_ blocked:Bool)throws {
        defaults.set(blocked,forKey:gateKey)
        guard defaults.synchronize(),try isBlocked()==blocked else {throw GitHubAccountError.storage}
    }
    private func query()->[String:Any] {
        let context=LAContext();context.interactionNotAllowed=true
        return [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.saleh.qwenlocal.chat.github-device.v1",
                kSecAttrAccount as String:"native-grant",kSecAttrSynchronizable as String:false,kSecUseAuthenticationContext as String:context]
    }
    func load()throws->GitHubAccountRecord? {
        var q=query();q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status==errSecItemNotFound {return nil}
        guard status==errSecSuccess,let data=result as? Data,data.count<=65536 else {throw GitHubAccountError.storage}
        do {let value=try JSONDecoder().decode(GitHubAccountRecord.self,from:data);try value.validate();return value} catch {throw GitHubAccountError.storage}
    }
    func save(_ value:GitHubAccountRecord,expected:UUID?)throws {
        do {
            try value.validate();let previous=try load();guard previous?.id==expected else {throw GitHubAccountError.storage}
            let bytes=try JSONEncoder().encode(value);guard bytes.count<=65536 else {throw GitHubAccountError.storage}
            let status:OSStatus
            if previous==nil {var q=query();q[kSecValueData as String]=bytes;q[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;status=SecItemAdd(q as CFDictionary,nil)}
            else {status=SecItemUpdate(query() as CFDictionary,[kSecValueData as String:bytes] as CFDictionary)}
            guard status==errSecSuccess,try load()?.id==value.id else {throw GitHubAccountError.storage}
        } catch {throw GitHubAccountError.storage}
    }
}

enum GitHubAccountJSON {
    static func login(_ s:String)->Bool {!s.isEmpty && s.utf8.count<=39 && s.utf8.allSatisfy {($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45}}
    static func object(_ bytes:Data,limit:Int=262144)throws->[String:Any] {
        guard bytes.count<=limit,let value=try? JSONSerialization.jsonObject(with:bytes),let object=value as? [String:Any] else {throw GitHubAccountError.invalid};return object
    }
    static func string(_ value:Any?,max:Int=256)throws->String {guard let s=value as? String,!s.isEmpty,s.utf8.count<=max,!s.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) else {throw GitHubAccountError.invalid};return s}
    static func integer(_ value:Any?,max:Int=9007199254740991,zero:Bool=false)throws->Int {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=Double(zero ? 0:1),n.doubleValue<=Double(max) else {throw GitHubAccountError.invalid};return n.intValue
    }
    static func permissions(_ value:Any?)throws {
        guard let p=value as? [String:String],p==["metadata":"read","issues":"read"] else {throw GitHubAccountError.permissions}
    }
    static func user(_ value:[String:Any])throws->GitHubAccountUser {
        let name=try string(value["login"],max:39);guard login(name) else {throw GitHubAccountError.invalid};return .init(id:try integer(value["id"]),login:name)
    }
    static func tokens(_ data:Data,sent:Date)throws->GitHubAccountTokens {
        let value=try object(data,limit:16384)
        guard value["error"]==nil,value["token_type"] as? String=="bearer",value["scope"] as? String=="" else {throw GitHubAccountError.denied}
        let lifetime=try integer(value["expires_in"],max:28800),refreshLife=try integer(value["refresh_token_expires_in"],max:15897600)
        guard lifetime>60,refreshLife>lifetime else {throw GitHubAccountError.invalid}
        return try .init(access:.init(string(value["access_token"],max:8192),prefix:"ghu_"),refresh:.init(string(value["refresh_token"],max:8192),prefix:"ghr_"),expires:sent.addingTimeInterval(Double(lifetime)),refreshExpires:sent.addingTimeInterval(Double(refreshLife)))
    }
}

// URLs/bodies can only be built from this typed fixed-endpoint inventory.
enum GitHubAccountRequest:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    case app(String),device(String),poll(String,GitHubAccountSecret),refresh(String,GitHubAccountSecret)
    case user(GitHubAccountSecret),installations(GitHubAccountSecret,Int),repositories(GitHubAccountSecret,Int,Int)
    case read(PrivateAccountRead,PrivateAccountGrant)
    var description:String {"GitHub request [redacted]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    @MainActor func make()throws->URLRequest {
        var path:String,token:GitHubAccountSecret?,form:[String:String]?,query:[URLQueryItem]=[]
        switch self {
        case let .app(slug): _ = try GitHubAccountRegistration(slug:slug,clientID:"validation");path="https://api.github.com/apps/"+slug
        case let .device(client):path="https://github.com/login/device/code";form=["client_id":client,"scope":"offline_access"]
        case let .poll(client,code):path="https://github.com/login/oauth/access_token";form=["client_id":client,"device_code":code.value,"grant_type":"urn:ietf:params:oauth:grant-type:device_code"]
        case let .refresh(client,refresh):path="https://github.com/login/oauth/access_token";form=["client_id":client,"refresh_token":refresh.value,"grant_type":"refresh_token"]
        case let .user(access):path="https://api.github.com/user";token=access
        case let .installations(access,page):guard page>=1,page<=5 else {throw GitHubAccountError.invalid};path="https://api.github.com/user/installations";token=access;query=[.init(name:"per_page",value:"20"),.init(name:"page",value:String(page))]
        case let .repositories(access,id,page):guard id>0,page>=1,page<=5 else {throw GitHubAccountError.invalid};path="https://api.github.com/user/installations/\(id)/repositories";token=access;query=[.init(name:"per_page",value:"20"),.init(name:"page",value:String(page))]
        case let .read(operation,grant):guard operation.provider == .github,grant.provider == .github else {throw GitHubAccountError.invalid};let request=try operation.request(grant:grant);try PrivateAccountURLTransport.validate(request,maxBytes:262144);return request
        }
        var url=URLComponents(string:path)!;if !query.isEmpty {url.queryItems=query}
        var request=URLRequest(url:url.url!);request.httpMethod=form==nil ? "GET":"POST";request.timeoutInterval=30
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        request.setValue("2026-03-10",forHTTPHeaderField:"X-GitHub-Api-Version")
        if let token {request.setValue("Bearer "+token.value,forHTTPHeaderField:"Authorization")}
        if let form {
            guard let client=form["client_id"],(try? GitHubAccountRegistration(slug:"validation",clientID:client)) != nil else {throw GitHubAccountError.configuration}
            var encoded=URLComponents();encoded.queryItems=form.sorted(by:{$0.key<$1.key}).map {URLQueryItem(name:$0.key,value:$0.value)}
            request.httpBody=Data(encoded.percentEncodedQuery!.replacingOccurrences(of:"+",with:"%2B").utf8)
            request.setValue("application/x-www-form-urlencoded",forHTTPHeaderField:"Content-Type")
        }
        return request
    }
}
struct GitHubAccountResponse {let status:Int,data:Data}
@MainActor protocol GitHubAccountHTTP {func send(_ request:GitHubAccountRequest)async throws->GitHubAccountResponse}
private final class GitHubAccountRedirect:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) {completionHandler(nil)}
}
@MainActor final class GitHubAccountURLHTTP:GitHubAccountHTTP {
    private let session:URLSession
    init() {
        let c=URLSessionConfiguration.ephemeral;c.httpCookieStorage=nil;c.httpShouldSetCookies=false;c.urlCredentialStorage=nil;c.urlCache=nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData;c.timeoutIntervalForResource=45;c.timeoutIntervalForRequest=30
        session=URLSession(configuration:c,delegate:GitHubAccountRedirect(),delegateQueue:nil)
    }
    func send(_ operation:GitHubAccountRequest)async throws->GitHubAccountResponse {
        let request=try operation.make(),limit=request.httpMethod=="POST" ? 16384:262144
        do {
            let (stream,response)=try await session.bytes(for:request)
            guard let http=response as? HTTPURLResponse,http.url==request.url,http.expectedContentLength<=limit else {stream.task.cancel();throw GitHubAccountError.invalid}
            guard http.statusCode==200 else {stream.task.cancel();return .init(status:http.statusCode,data:Data())}
            guard http.mimeType=="application/json" else {stream.task.cancel();throw GitHubAccountError.invalid}
            var bytes=Data()
            do {for try await byte in stream {try Task.checkCancellation();guard bytes.count<limit else {throw GitHubAccountError.invalid};bytes.append(byte)}} catch {stream.task.cancel();throw error}
            return .init(status:200,data:bytes)
        } catch let e as GitHubAccountError {throw e} catch {throw Task.isCancelled ? GitHubAccountError.cancelled:.transport}
    }
}

@MainActor final class GitHubAccountSession {
    private let http:any GitHubAccountHTTP,store:any GitHubAccountStore,now:()->Date,sleep:(TimeInterval)async throws->Void
    private var generation=UUID(),busy=false,held=false,record:GitHubAccountRecord?
    private var worker:Task<[String:Any],Error>?
    init(http:any GitHubAccountHTTP,store:any GitHubAccountStore,now:@escaping()->Date=Date.init,sleep:@escaping(TimeInterval)async throws->Void={try await Task.sleep(nanoseconds:UInt64($0*1_000_000_000))}) {self.http=http;self.store=store;self.now=now;self.sleep=sleep}
    func cancel() {generation=UUID();worker?.cancel()}
    private func check(_ expected:UUID)throws {guard expected==generation,!Task.isCancelled else {throw GitHubAccountError.cancelled}}
    private func send(_ request:GitHubAccountRequest,_ expected:UUID)async throws->Data {
        try check(expected)
        let response:GitHubAccountResponse
        do {response=try await http.send(request)} catch let e as GitHubAccountError {throw e} catch {throw Task.isCancelled ? GitHubAccountError.cancelled:.transport}
        try check(expected)
        if [401,403,404].contains(response.status) {throw GitHubAccountError.denied}
        guard response.status==200,response.data.count<=262144 else {throw GitHubAccountError.transport}
        return response.data
    }
    private func app(_ registration:GitHubAccountRegistration,_ expected:UUID)async throws->GitHubAccountApp {
        try registration.validate()
        let object=try GitHubAccountJSON.object(await send(.app(registration.slug),expected))
        guard object["slug"] as? String==registration.slug,object["client_id"] as? String==registration.clientID else {throw GitHubAccountError.configuration}
        try GitHubAccountJSON.permissions(object["permissions"])
        return .init(id:try GitHubAccountJSON.integer(object["id"]),registration:registration)
    }
    private func installations(_ token:GitHubAccountSecret,app:GitHubAccountApp,_ expected:UUID)async throws->[GitHubAccountInstallation] {
        var rows:[GitHubAccountInstallation]=[],total:Int?
        for page in 1...5 {
            let result=try GitHubAccountJSON.object(await send(.installations(token,page),expected))
            let count=try GitHubAccountJSON.integer(result["total_count"],max:100,zero:true)
            guard let entries=result["installations"] as? [[String:Any]],entries.count<=20,total==nil || total==count else {throw GitHubAccountError.invalid};total=count
            for value in entries {
                guard try GitHubAccountJSON.integer(value["app_id"])==app.id,value["app_slug"] as? String==app.registration.slug,
                      value["repository_selection"] as? String=="selected",value["suspended_at"] is NSNull,
                      let owner=value["account"] as? [String:Any] else {throw GitHubAccountError.permissions}
                try GitHubAccountJSON.permissions(value["permissions"])
                rows.append(try .init(id:GitHubAccountJSON.integer(value["id"]),owner:GitHubAccountJSON.user(owner)))
            }
            guard rows.count<=count,Set(rows.map(\.id)).count==rows.count else {throw GitHubAccountError.invalid}
            if rows.count==count {guard !rows.isEmpty else {throw GitHubAccountError.denied};return rows}
            guard entries.count==20 else {throw GitHubAccountError.invalid}
        }
        throw GitHubAccountError.invalid
    }
    private func repositories(_ token:GitHubAccountSecret,installation:Int,_ expected:UUID)async throws->[GitHubAccountRepository] {
        var rows:[GitHubAccountRepository]=[],total:Int?
        for page in 1...5 {
            let result=try GitHubAccountJSON.object(await send(.repositories(token,installation,page),expected))
            let count=try GitHubAccountJSON.integer(result["total_count"],max:100,zero:true)
            guard let entries=result["repositories"] as? [[String:Any]],entries.count<=20,total==nil || total==count else {throw GitHubAccountError.invalid};total=count
            for value in entries {
                let name=try GitHubAccountJSON.string(value["full_name"],max:140).lowercased()
                guard PrivateAccountRead.repository(name) else {throw GitHubAccountError.invalid}
                rows.append(try .init(id:GitHubAccountJSON.integer(value["id"]),name:name))
            }
            guard rows.count<=count,Set(rows.map(\.id)).count==rows.count,Set(rows.map(\.name)).count==rows.count else {throw GitHubAccountError.invalid}
            if rows.count==count {guard !rows.isEmpty else {throw GitHubAccountError.denied};return rows.sorted {$0.id<$1.id}}
            guard entries.count==20 else {throw GitHubAccountError.invalid}
        }
        throw GitHubAccountError.invalid
    }
    private func rejectCredentialEcho(_ selection:GitHubAccountSelection,tokens:GitHubAccountTokens)throws {
        let fields=[selection.registration.slug,selection.registration.clientID,selection.user.login,selection.installation.owner.login]+selection.repositories.map(\.name)
        guard fields.allSatisfy({!$0.contains(tokens.access.value) && !$0.contains(tokens.refresh.value)}) else {throw GitHubAccountError.invalid}
    }
    private func verify(_ selection:GitHubAccountSelection,tokens:GitHubAccountTokens,_ expected:UUID)async throws {
        try selection.validate();try tokens.validate();try rejectCredentialEcho(selection,tokens:tokens)
        let app=try await app(selection.registration,expected)
        guard app.id==selection.appID else {throw GitHubAccountError.denied}
        let user=try GitHubAccountJSON.user(GitHubAccountJSON.object(await send(.user(tokens.access),expected)))
        guard user==selection.user else {throw GitHubAccountError.denied}
        let installations=try await installations(tokens.access,app:app,expected)
        guard installations.contains(selection.installation) else {throw GitHubAccountError.denied}
        guard try await repositories(tokens.access,installation:selection.installation.id,expected)==selection.repositories else {throw GitHubAccountError.denied}
    }
    private func save(_ next:GitHubAccountRecord,expected:UUID?)throws {
        do {try store.save(next,expected:expected);record=next} catch {held=true;record=nil;throw GitHubAccountError.storage}
    }
    private func invalidateSaved() {
        held=true
        do {try store.setBlocked(true)} catch {return}
        guard let saved=record else {return}
        do {try save(.init(state:.disconnected,selection:saved.selection),expected:saved.id)} catch {record=nil}
    }
    private func load()throws->GitHubAccountRecord {
        guard !held else {throw GitHubAccountError.denied}
        do {
            guard try !store.isBlocked(),let saved=try store.load() else {throw GitHubAccountError.unavailable};try saved.validate()
            guard saved.state == .active else {throw saved.state == .refreshPending ? GitHubAccountError.refresh:.unavailable}
            record=saved;return saved
        } catch let e as GitHubAccountError {throw e} catch {held=true;throw GitHubAccountError.storage}
    }
    private func usable(_ expected:UUID)async throws->GitHubAccountRecord {
        var saved=try load();guard let old=saved.tokens else {throw GitHubAccountError.unavailable}
        if old.expires<=now().addingTimeInterval(60) {
            guard old.refreshExpires>now().addingTimeInterval(60) else {invalidateSaved();throw GitHubAccountError.expired}
            let tombstone=GitHubAccountRecord(state:.refreshPending,selection:saved.selection)
            try check(expected);try save(tombstone,expected:saved.id)
            let sent=now(),data=try await send(.refresh(saved.selection.registration.clientID,old.refresh),expected)
            let renewed=try GitHubAccountJSON.tokens(data,sent:sent)
            guard renewed.access.value != old.access.value,renewed.refresh.value != old.refresh.value else {throw GitHubAccountError.invalid}
            try await verify(saved.selection,tokens:renewed,expected);try check(expected)
            saved = .init(state:.active,selection:saved.selection,tokens:renewed);try save(saved,expected:tombstone.id)
        } else {try await verify(saved.selection,tokens:old,expected)}
        try check(expected);return saved
    }
    // Native UI calls only. Approval is independent of all operational tool modes.
    func connect(_ registration:GitHubAccountRegistration,
                 consent:@escaping(GitHubAccountApp)async throws->Bool,
                 displayCode:@escaping(String,Date)->Void,
                 choose:@escaping([GitHubAccountInstallation])async throws->Int?,
                 approve:@escaping(GitHubAccountSelection)async throws->Bool)async throws {
        guard !busy else {throw GitHubAccountError.busy};busy=true;defer {busy=false};let expected=generation
        do {
            let original:GitHubAccountRecord?
            do {original=try store.load()} catch {throw GitHubAccountError.storage}
            let blocked:Bool
            do {blocked=try store.isBlocked()} catch {throw GitHubAccountError.storage}
            guard original==nil || original?.state != .active || blocked else {throw GitHubAccountError.existing}
            do {try store.setBlocked(true)} catch {throw GitHubAccountError.storage}
            let app=try await app(registration,expected)
            guard try await consent(app) else {throw GitHubAccountError.denied};try check(expected)
            let sent=now(),device=try GitHubAccountJSON.object(await send(.device(registration.clientID),expected),limit:16384)
            let deviceCode=try GitHubAccountSecret(GitHubAccountJSON.string(device["device_code"],max:128),prefix:"")
            let code=try GitHubAccountJSON.string(device["user_code"],max:9)
            guard deviceCode.value.count==40,deviceCode.value.utf8.allSatisfy({($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)}),
                  code.count==9,code[code.index(code.startIndex,offsetBy:4)]=="-",code.enumerated().allSatisfy({$0.offset==4 ? $0.element=="-":$0.element.isASCII && (($0.element>="A" && $0.element<="Z") || ($0.element>="0" && $0.element<="9"))}),
                  device["verification_uri"] as? String=="https://github.com/login/device" else {throw GitHubAccountError.invalid}
            let expires=sent.addingTimeInterval(Double(try GitHubAccountJSON.integer(device["expires_in"],max:900)))
            var interval=Double(try GitHubAccountJSON.integer(device["interval"],max:60)),tokens:GitHubAccountTokens?
            displayCode(code,expires)
            var polls=0
            while now()<expires {
                polls+=1;guard polls<=180,now()>=sent else {throw GitHubAccountError.expired}
                try await sleep(interval);try check(expected);guard now()<expires else {throw GitHubAccountError.expired}
                let sent=now(),data=try await send(.poll(registration.clientID,deviceCode),expected)
                guard now()<expires else {throw GitHubAccountError.expired}
                let value=try GitHubAccountJSON.object(data,limit:16384)
                if let error=value["error"] as? String {
                    guard value["access_token"]==nil else {throw GitHubAccountError.invalid}
                    if error=="authorization_pending" {continue}
                    if error=="slow_down" {interval+=5;guard interval<=60 else {throw GitHubAccountError.invalid};continue}
                    throw ["expired_token","token_expired"].contains(error) ? GitHubAccountError.expired:.denied
                }
                tokens=try GitHubAccountJSON.tokens(data,sent:sent);break
            }
            guard let tokens else {throw GitHubAccountError.expired}
            let user=try GitHubAccountJSON.user(GitHubAccountJSON.object(await send(.user(tokens.access),expected)))
            let installations=try await installations(tokens.access,app:app,expected)
            guard let id=try await choose(installations),let installation=installations.first(where:{$0.id==id}) else {throw GitHubAccountError.cancelled};try check(expected)
            let repos=try await repositories(tokens.access,installation:id,expected)
            let selection=GitHubAccountSelection(registration:registration,appID:app.id,user:user,installation:installation,repositories:repos)
            try rejectCredentialEcho(selection,tokens:tokens)
            guard try await approve(selection) else {throw GitHubAccountError.cancelled};try check(expected)
            // Recheck provider identity/permissions/resources after the native review.
            try await verify(selection,tokens:tokens,expected);try check(expected)
            try save(.init(state:.active,selection:selection,tokens:tokens),expected:original?.id)
            do {try store.setBlocked(false)} catch {held=true;throw GitHubAccountError.storage};held=false
        } catch let e as GitHubAccountError {throw e} catch {throw Task.isCancelled ? GitHubAccountError.cancelled:.transport}
    }
    func disconnect()throws {
        cancel();held=true
        do {
            try store.setBlocked(true)
            guard let saved=try store.load() else {record=nil;return}
            // Overwrite tokens with a durable non-secret tombstone. No remote revoke claim.
            try save(.init(state:.disconnected,selection:saved.selection),expected:saved.id)
        } catch {held=true;record=nil;throw GitHubAccountError.storage}
    }
    func perform(_ input:[String:Any])async throws->[String:Any] {
        guard let action=input["action"] as? String else {throw PrivateAccountFailure.invalid}
        let operation:PrivateAccountRead?
        if action=="status" {guard Set(input.keys)==["action"] else {throw PrivateAccountFailure.invalid};operation=nil}
        else {
            guard ["github_repository","github_issues"].contains(action),let repository=input["repository"] as? String,PrivateAccountRead.repository(repository) else {throw PrivateAccountFailure.invalid}
            if action=="github_repository" {guard Set(input.keys)==["action","repository"] else {throw PrivateAccountFailure.invalid};operation = .githubRepository(name:repository.lowercased())}
            else {guard Set(input.keys)==["action","repository","page"],let page=input["page"] as? NSNumber,CFGetTypeID(page) != CFBooleanGetTypeID(),page.doubleValue.rounded()==page.doubleValue,page.intValue>=1,page.intValue<=1000 else {throw PrivateAccountFailure.invalid};operation = .githubIssues(name:repository.lowercased(),page:page.intValue)}
        }
        guard !busy else {throw GitHubAccountError.busy};busy=true;defer {busy=false;worker=nil};let expected=generation
        let task=Task {()throws->[String:Any] in
            do {
                let saved=try await self.usable(expected),tokens=saved.tokens!,selection=saved.selection
                if let operation {
                    let name:String;switch operation {case let .githubRepository(n),let .githubIssues(n,_):name=n;default:throw PrivateAccountFailure.invalid}
                    guard let repository=selection.repositories.first(where:{$0.name==name}) else {throw PrivateAccountFailure.denied}
                    let grant=try PrivateAccountGrant(provider:.github,token:tokens.access.value,expiresAt:tokens.expires,selectedResources:Set(selection.repositories.map(\.name)))
                    let data=try await self.send(.read(operation,grant),expected)
                    let result=try operation.parse(data,grant:grant)
                    if case .githubRepository=operation {guard result["id"] as? Int==repository.id else {throw GitHubAccountError.denied}}
                    // Reject late results if provider/account/resource identity changed mid-read.
                    try await self.verify(selection,tokens:tokens,expected);try self.check(expected)
                    let text=String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!
                    guard !text.contains(tokens.refresh.value) else {throw GitHubAccountError.invalid}
                    return result
                }
                return self.status(state:"connected",selection:selection)
            } catch let e as GitHubAccountError {
                if [.denied,.permissions,.expired].contains(e) {self.invalidateSaved()}
                if operation==nil {return self.status(state:e == .unavailable ? "unconfigured":"held",message:e.localizedDescription)}
                throw e
            } catch let e as PrivateAccountFailure {throw e}
            catch {throw Task.isCancelled ? GitHubAccountError.cancelled:.transport}
        }
        worker=task
        return try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
    }
    private func status(state:String,selection:GitHubAccountSelection?=nil,message:String?=nil)->[String:Any] {
        var result=try! PrivateAccountsAvailability.status(["action":"status"])
        var providers=result["providers"] as! [[String:Any]]
        var github:[String:Any]=["id":"github","state":state,"connected":state=="connected","readAvailable":state=="connected","grantAvailable":true,
                               "message":message ?? "GitHub App access is verified. Only selected repository metadata and issue summaries are readable. Account setup is native-only."]
        if let selection {github["account"]=selection.user.login;github["repositories"]=selection.repositories.map(\.name)}
        providers[2]=github;result["providers"]=providers
        result["message"]="GitHub uses a native user-authorized GitHub App. Gmail and Drive remain unavailable. Full Access never grants account access."
        return result
    }
}
