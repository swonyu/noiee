import Foundation
import Security
import LocalAuthentication

enum DriveError:String,Error,LocalizedError {
    case configuration="Use a registered Google Desktop client with Drive API and Google Picker API enabled. No account was connected."
    case existing="Disconnect locally before switching the Desktop client or Drive account."
    case unavailable="Drive is not connected. Use Noiee → Private Accounts → Drive."
    case denied="Drive authorization was denied or changed. No new file access was activated."
    case account="The verified Drive account changed. Disconnect locally before choosing a different account."
    case identity="The authenticated Drive account could not be verified. No file data was returned."
    case scope="Google did not grant exactly drive.file. Broader or combined scopes are not accepted."
    case selection="No valid files were selected. Choose between 1 and 20 distinct files in Google's Picker. The previous selection was preserved."
    case selected="That file is not in this app's approved selection. Choose it through the native Google Picker first."
    case invalid="Drive returned an invalid, incomplete or over-limit response. No credential details were returned."
    case callback="Drive's single-use Picker callback could not be verified. Start a new native selection."
    case cancelled="Drive work stopped. Google permissions already granted may remain; local cancellation does not revoke them."
    case expired="Drive authorization expired. Reconnect through native consent."
    case busy="Another Drive operation is pending."
    case storage="Drive credential storage could not be confirmed. Access is held. Retry local disconnect; do not assume removal succeeded."
    case refresh="Drive refresh is pending or uncertain. Reconnect natively; the old refresh token is not replayed."
    case transport="Drive request failed. No provider error details or credentials were returned. No automatic retry was made."
    case revoke="Local Drive reads are blocked, but remote project revocation is unconfirmed. Retry natively or review Google Account connections."
    case unsupported="Text reads support only unencrypted plain-text files and Google Docs. Shortcuts, folders, binaries and other formats are not followed or converted. Select the actual supported file."
    case download="Drive does not currently permit this content read, or the file is trashed. No download restriction was bypassed."
    case oversized="The file text exceeds Noiee's 256 KiB limit. No partial content was returned."
    case changed="The file changed during its read. No content was returned; retry for a fresh version."
    var errorDescription:String? {rawValue}
}
enum DrivePolicy {
    static let scope="https://www.googleapis.com/auth/drive.file",maxFiles=20,maxText=262144
    static let destination="local-agent-conversation-v1"
}
struct DriveIdentity:Codable,Equatable {
    let permissionID:String,email:String?
    func validate()throws {guard !permissionID.isEmpty,permissionID.utf8.count<=256,permissionID.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw DriveError.identity};if let email {guard email.utf8.count<=320,email.split(separator:"@").count==2,email.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw DriveError.identity}}}
}
struct DriveFile:Codable,Equatable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    let id:String,name:String,mime:String,version:String,modified:String,size:String?,trashed:Bool,canDownload:Bool,resourceKey:String?,encryption:String?
    func validate()throws {
        guard PrivateAccountRead.identifier(id),!name.isEmpty,name.utf8.count<=1024,!name.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),!mime.isEmpty,mime.utf8.count<=256,!mime.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),let v=Int64(version),v>0,version.utf8.allSatisfy({$0>=48 && $0<=57}),!modified.isEmpty,modified.utf8.count<=128 else {throw DriveError.invalid}
        if let size {guard let bytes=Int64(size),bytes>=0,size.utf8.allSatisfy({$0>=48 && $0<=57}) else {throw DriveError.invalid}}
        if let key=resourceKey {guard !key.isEmpty,key.utf8.count<=1024,key.utf8.allSatisfy({$0>=32 && $0<=126 && $0 != 44 && $0 != 47}) else {throw DriveError.invalid}}
        if let encryption {guard ["encrypted","unencrypted"].contains(encryption) else {throw DriveError.invalid}}
    }
    var description:String {"[Drive file metadata; access material redacted]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    func contentAllowed()throws {
        guard ["text/plain","application/vnd.google-apps.document"].contains(mime),encryption==nil || encryption=="unencrypted" else {throw DriveError.unsupported}
        guard !trashed,canDownload else {throw DriveError.download}
        if mime=="text/plain",let size,Int64(size)!>DrivePolicy.maxText {throw DriveError.oversized}
    }
    func withoutResourceKey()->DriveFile {DriveFile(id:id,name:name,mime:mime,version:version,modified:modified,size:size,trashed:trashed,canDownload:canDownload,resourceKey:nil,encryption:encryption)}
    func output()->[String:Any] {
        var result:[String:Any]=["provider":"drive","readOnly":true,"id":id,"name":name,"mimeType":mime,"version":version,"modifiedTime":modified,"trashed":trashed,"canReadText":(try? contentAllowed()) != nil,"contentIncluded":false]
        if let size {result["size"]=size};return result
    }
}
struct DriveRecord:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    enum State:String,Codable {case active,refreshPending,revocationPending,disconnected}
    let version:Int,id:UUID,destination:String,state:State,registration:GmailRegistration,identity:DriveIdentity,files:[DriveFile],tokens:GmailTokens?
    init(state:State,registration:GmailRegistration,identity:DriveIdentity,files:[DriveFile],tokens:GmailTokens?=nil) {version=1;id=UUID();destination=DrivePolicy.destination;self.state=state;self.registration=registration;self.identity=identity;self.files=[State.disconnected,.refreshPending].contains(state) ? files.map {$0.withoutResourceKey()}:files;self.tokens=tokens}
    func validate()throws {try registration.validate();try identity.validate();try tokens?.validate();try files.forEach {try $0.validate()};guard version==1,destination==DrivePolicy.destination,!files.isEmpty,files.count<=DrivePolicy.maxFiles,Set(files.map(\.id)).count==files.count,([State.active,.revocationPending].contains(state))==(tokens != nil) else {throw DriveError.invalid}}
    var description:String {"DriveRecord(\(state.rawValue), access material redacted)"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
}
@MainActor protocol DriveStore {
    func load()throws->DriveRecord?
    func isBlocked()throws->Bool
    func setBlocked(_ blocked:Bool)throws
    func save(_ record:DriveRecord,expected:UUID?)throws
}
@MainActor final class DriveKeychain:DriveStore {
    private let defaults:UserDefaults
    private let gate="privateDriveAccountBlockedV1"
    init(defaults:UserDefaults = .standard){self.defaults=defaults}
    func isBlocked()throws->Bool {guard let value=defaults.object(forKey:gate) else {return true};guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else {throw DriveError.storage};return n.boolValue}
    func setBlocked(_ value:Bool)throws {defaults.set(value,forKey:gate);guard defaults.synchronize(),try isBlocked()==value else {throw DriveError.storage}}
    private func query()->[String:Any] {let context=LAContext();context.interactionNotAllowed=true;return [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.saleh.qwenlocal.chat.drive-picker.v1",kSecAttrAccount as String:"native-grant",kSecAttrSynchronizable as String:false,kSecUseAuthenticationContext as String:context]}
    func load()throws->DriveRecord? {
        var q=query();q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
        var value:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&value)
        if status==errSecItemNotFound {return nil};guard status==errSecSuccess,let bytes=value as? Data,bytes.count<=65536 else {throw DriveError.storage}
        do {let value=try JSONDecoder().decode(DriveRecord.self,from:bytes);try value.validate();return value} catch {throw DriveError.storage}
    }
    func save(_ value:DriveRecord,expected:UUID?)throws {
        do {try value.validate();let previous=try load();guard previous?.id==expected else {throw DriveError.storage};let bytes=try JSONEncoder().encode(value);guard bytes.count<=65536 else {throw DriveError.storage}
            let status:OSStatus
            if previous==nil {var q=query();q[kSecValueData as String]=bytes;q[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;status=SecItemAdd(q as CFDictionary,nil)} else {status=SecItemUpdate(query() as CFDictionary,[kSecValueData as String:bytes] as CFDictionary)}
            guard status==errSecSuccess,try load()?.id==value.id else {throw DriveError.storage}
        } catch {throw DriveError.storage}
    }
}
enum DriveJSON {
    static func object(_ bytes:Data)throws->[String:Any] {guard bytes.count<=65536,let value=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] else {throw DriveError.invalid};return value}
    static func string(_ value:Any?,max:Int=8192)throws->String {guard let s=value as? String,!s.isEmpty,s.utf8.count<=max,!s.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) else {throw DriveError.invalid};return s}
    static func bool(_ value:Any?)throws->Bool {guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else {throw DriveError.invalid};return n.boolValue}
    static func identity(_ bytes:Data)throws->DriveIdentity {
        guard let user=try object(bytes)["user"] as? [String:Any],try bool(user["me"]) else {throw DriveError.identity}
        let value=try DriveIdentity(permissionID:string(user["permissionId"],max:256),email:user["emailAddress"].map {try string($0,max:320)});try value.validate();return value
    }
    static func file(_ bytes:Data,expected:String)throws->DriveFile {
        let value=try object(bytes);guard value["id"] as? String==expected,try bool(value["isAppAuthorized"]) else {throw DriveError.selected}
        let encryption:String?
        if let object=value["clientEncryptionDetails"] {guard let fields=object as? [String:Any] else {throw DriveError.invalid};encryption=try string(fields["encryptionState"],max:32)} else {encryption=nil}
        let capabilities=value["capabilities"] as? [String:Any]
        let file=try DriveFile(id:expected,name:string(value["name"],max:1024),mime:string(value["mimeType"],max:256),version:string(value["version"],max:20),modified:string(value["modifiedTime"],max:128),size:value["size"].map {try string($0,max:20)},trashed:bool(value["trashed"]),canDownload:capabilities?["canDownload"].map {try bool($0)} ?? false,resourceKey:value["resourceKey"].map {try string($0,max:1024)},encryption:encryption)
        try file.validate();guard file.mime != "application/vnd.google-apps.folder" else {throw DriveError.unsupported};return file
    }
    static func tokens(_ data:Data,sent:Date,previous:GmailTokens?=nil)throws->GmailTokens {
        let value=try object(data);guard value["error"]==nil,(value["token_type"] as? String)?.lowercased()=="bearer" else {throw DriveError.denied}
        if let scope=value["scope"] {guard scope as? String==DrivePolicy.scope else {throw DriveError.scope}} else if previous==nil {throw DriveError.scope}
        let lifetime=try GmailJSON.integer(value["expires_in"],max:7200);guard lifetime>60 else {throw DriveError.expired}
        let access=try GmailSecret(string(value["access_token"])),refresh:GmailSecret
        if let token=value["refresh_token"] {refresh=try .init(string(token))} else if let previous {refresh=previous.refresh} else {throw DriveError.invalid}
        let refreshExpires:Date?
        if let expires=value["refresh_token_expires_in"] {refreshExpires=sent.addingTimeInterval(Double(try GmailJSON.integer(expires,max:315360000)))} else {refreshExpires=previous?.refreshExpires}
        let result=GmailTokens(access:access,refresh:refresh,expires:sent.addingTimeInterval(Double(lifetime)),refreshExpires:refreshExpires);try result.validate();return result
    }
    static func containsAccess(_ value:Any,tokens:GmailTokens,files:[DriveFile])->Bool {
        if GmailJSON.containsCredential(value,tokens:tokens) {return true}
        if let text=value as? String {return files.compactMap(\.resourceKey).contains {text.contains($0)}}
        if let array=value as? [Any] {return array.contains {containsAccess($0,tokens:tokens,files:files)}}
        if let object=value as? [String:Any] {return object.contains {containsAccess($0.key,tokens:tokens,files:files) || containsAccess($0.value,tokens:tokens,files:files)}}
        return false
    }
}
enum DriveRequest:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    case exchange(DriveAuthorization.Code),refresh(GmailRegistration,GmailSecret),revoke(GmailSecret),about(GmailSecret),metadata(GmailSecret,String,String?),content(GmailSecret,DriveFile)
    var description:String {"[redacted Drive request]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    var isRevoke:Bool {if case .revoke=self {return true};return false}
    var isContent:Bool {if case .content=self {return true};return false}
    func make()throws->URLRequest {
        let path:String;var form:[String:String]?,query:[URLQueryItem]=[],token:GmailSecret?,resource:String?
        switch self {
        case let .exchange(code):
            try code.registration.validate();guard code.redirect.scheme=="http",code.redirect.host=="127.0.0.1",code.redirect.path=="/oauth/callback",let port=code.redirect.port,port>=1024,port<=65535,code.redirect.query==nil,code.redirect.fragment==nil,code.redirect.user==nil,code.redirect.password==nil else {throw DriveError.callback}
            path="https://oauth2.googleapis.com/token";form=["client_id":code.registration.clientID,"code":code.code.nativeValue(),"code_verifier":code.verifier.nativeValue(),"redirect_uri":code.redirect.absoluteString,"grant_type":"authorization_code"]
        case let .refresh(registration,refresh):try registration.validate();path="https://oauth2.googleapis.com/token";form=["client_id":registration.clientID,"refresh_token":refresh.nativeValue(),"grant_type":"refresh_token"]
        case let .revoke(refresh):path="https://oauth2.googleapis.com/revoke";form=["token":refresh.nativeValue()]
        case let .about(access):path="https://www.googleapis.com/drive/v3/about";token=access;query=[.init(name:"fields",value:"user(permissionId,emailAddress,me)")]
        case let .metadata(access,id,key):
            guard PrivateAccountRead.identifier(id) else {throw DriveError.invalid};path="https://www.googleapis.com/drive/v3/files/"+id;token=access
            query=[.init(name:"fields",value:"id,name,mimeType,size,modifiedTime,version,trashed,isAppAuthorized,capabilities(canDownload),resourceKey,clientEncryptionDetails(encryptionState)"),.init(name:"supportsAllDrives",value:"true")]
            if let key {resource=try Self.resourceHeader(id,key)}
        case let .content(access,file):
            try file.validate();try file.contentAllowed();token=access
            if file.mime=="text/plain" {path="https://www.googleapis.com/drive/v3/files/"+file.id;query=[.init(name:"alt",value:"media"),.init(name:"supportsAllDrives",value:"true")]}
            else {path="https://www.googleapis.com/drive/v3/files/"+file.id+"/export";query=[.init(name:"mimeType",value:"text/plain")]}
            if let key=file.resourceKey {resource=try Self.resourceHeader(file.id,key)}
        }
        var url=URLComponents(string:path)!;if !query.isEmpty {url.queryItems=query}
        var request=URLRequest(url:url.url!);request.httpMethod=form==nil ? "GET":"POST";request.timeoutInterval=30;request.setValue(isContent ? "text/plain":"application/json",forHTTPHeaderField:"Accept")
        if let token {request.setValue("Bearer "+token.nativeValue(),forHTTPHeaderField:"Authorization")};if let resource {request.setValue(resource,forHTTPHeaderField:"X-Goog-Drive-Resource-Keys")}
        if let form {var c=URLComponents();c.queryItems=form.sorted(by:{$0.key<$1.key}).map {.init(name:$0.key,value:$0.value)};request.httpBody=Data(c.percentEncodedQuery!.replacingOccurrences(of:"+",with:"%2B").utf8);request.setValue("application/x-www-form-urlencoded",forHTTPHeaderField:"Content-Type")}
        return request
    }
    private static func resourceHeader(_ id:String,_ key:String)throws->String {
        guard PrivateAccountRead.identifier(id),!key.isEmpty,key.utf8.count<=1024,key.utf8.allSatisfy({$0>=32 && $0<=126 && $0 != 44 && $0 != 47}) else {throw DriveError.invalid};return id+"/"+key
    }
}
struct DriveResponse {let status:Int,data:Data,mime:String?}
@MainActor protocol DriveHTTP {func send(_ operation:DriveRequest)async throws->DriveResponse}
private final class DriveRedirect:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void){completionHandler(nil)}
}
@MainActor final class DriveURLHTTP:DriveHTTP {
    private let session:URLSession
    init(){let c=URLSessionConfiguration.ephemeral;c.httpCookieStorage=nil;c.httpShouldSetCookies=false;c.urlCredentialStorage=nil;c.urlCache=nil;c.requestCachePolicy = .reloadIgnoringLocalCacheData;c.timeoutIntervalForResource=45;c.timeoutIntervalForRequest=30;session=URLSession(configuration:c,delegate:DriveRedirect(),delegateQueue:nil)}
    func send(_ operation:DriveRequest)async throws->DriveResponse {
        let request=try operation.make(),limit=operation.isContent ? DrivePolicy.maxText:65536
        do {
            let (stream,response)=try await session.bytes(for:request)
            guard let http=response as? HTTPURLResponse,http.url==request.url,http.expectedContentLength<=limit else {stream.task.cancel();throw operation.isContent ? DriveError.oversized:.invalid}
            guard http.statusCode==200 else {stream.task.cancel();return .init(status:http.statusCode,data:Data(),mime:nil)}
            if operation.isRevoke {stream.task.cancel();return .init(status:200,data:Data(),mime:nil)}
            guard http.mimeType?.lowercased()==(operation.isContent ? "text/plain":"application/json") else {stream.task.cancel();throw DriveError.invalid}
            if operation.isContent,let charset=http.textEncodingName {guard ["utf-8","utf8","us-ascii"].contains(charset.lowercased()) else {stream.task.cancel();throw DriveError.unsupported}}
            var bytes=Data();do {for try await byte in stream {try Task.checkCancellation();guard bytes.count<limit else {throw operation.isContent ? DriveError.oversized:.invalid};bytes.append(byte)}} catch {stream.task.cancel();throw error}
            return .init(status:200,data:bytes,mime:http.mimeType?.lowercased())
        } catch let e as DriveError {throw e} catch {throw Task.isCancelled ? DriveError.cancelled:.transport}
    }
}

@MainActor final class DriveAccountSession {
    private let http:any DriveHTTP,store:any DriveStore,now:()->Date,listener:@MainActor ()->any GmailLoopback,authorization:@MainActor ()->DriveAuthorization
    private var generation=UUID(),busy=false,held=false,record:DriveRecord?,loopback:(any GmailLoopback)?,auth:DriveAuthorization?,worker:Task<[String:Any],Error>?
    init(http:any DriveHTTP,store:any DriveStore,now:@escaping()->Date=Date.init,listener:@escaping @MainActor ()->any GmailLoopback={GmailNativeLoopback()},authorization:@escaping @MainActor ()->DriveAuthorization={DriveAuthorization()}) {self.http=http;self.store=store;self.now=now;self.listener=listener;self.authorization=authorization}
    func registrationHint()->String? {(try? store.load())?.registration.clientID}
    var selectedCount:Int {record?.files.count ?? 0}
    func cancel(){generation=UUID();worker?.cancel();loopback?.cancel();auth?.cancel()}
    private func check(_ expected:UUID)throws {guard generation==expected,!Task.isCancelled else {throw DriveError.cancelled}}
    private func send(_ operation:DriveRequest,_ expected:UUID)async throws->Data {
        try check(expected);let response:DriveResponse
        do {response=try await http.send(operation)} catch let e as DriveError {throw e} catch {throw Task.isCancelled ? DriveError.cancelled:.transport}
        try check(expected);if response.status==401 {throw DriveError.denied}
        guard response.status==200 else {throw DriveError.transport}
        if operation.isRevoke {return Data()}
        guard response.data.count<=(operation.isContent ? DrivePolicy.maxText:65536) else {throw operation.isContent ? DriveError.oversized:.invalid}
        guard response.mime==(operation.isContent ? "text/plain":"application/json") else {throw DriveError.invalid}
        return response.data
    }
    private func save(_ next:DriveRecord,expected:UUID?)throws {do {try store.save(next,expected:expected);record=next} catch {held=true;record=nil;throw DriveError.storage}}
    private func invalidate(){held=true;do {try store.setBlocked(true)} catch {return};if let record {try? save(.init(state:.disconnected,registration:record.registration,identity:record.identity,files:record.files),expected:record.id)}}
    private func verify(_ tokens:GmailTokens,subject:String?,files:[DriveFile],_ expected:UUID)async throws->DriveIdentity {
        try tokens.validate();let identity=try DriveJSON.identity(await send(.about(tokens.access),expected))
        guard subject==nil || subject==identity.permissionID,!DriveJSON.containsAccess([identity.permissionID,identity.email ?? ""],tokens:tokens,files:files) else {throw DriveError.identity}
        return identity
    }
    private func metadata(_ tokens:GmailTokens,id:String,key:String?,_ expected:UUID)async throws->DriveFile {
        let file=try DriveJSON.file(await send(.metadata(tokens.access,id,key),expected),expected:id)
        guard !DriveJSON.containsAccess(file.output(),tokens:tokens,files:[file]) else {throw DriveError.invalid};return file
    }
    private func load()throws->DriveRecord {
        guard !held else {throw DriveError.denied}
        do {guard try !store.isBlocked(),let value=try store.load() else {throw DriveError.unavailable};try value.validate();guard value.state == .active else {throw value.state == .refreshPending ? DriveError.refresh:.unavailable};record=value;return value}
        catch let e as DriveError {throw e} catch {throw DriveError.storage}
    }
    private func usable(_ expected:UUID)async throws->DriveRecord {
        var saved=try load();guard let old=saved.tokens else {throw DriveError.unavailable}
        if old.expires<=now().addingTimeInterval(60) {
            guard old.refreshExpires==nil || old.refreshExpires!>now().addingTimeInterval(60) else {invalidate();throw DriveError.expired}
            let pending=DriveRecord(state:.refreshPending,registration:saved.registration,identity:saved.identity,files:saved.files);try check(expected);try save(pending,expected:saved.id)
            let sent=now(),bytes=try await send(.refresh(saved.registration,old.refresh),expected),renewed=try DriveJSON.tokens(bytes,sent:sent,previous:old)
            let identity=try await verify(renewed,subject:saved.identity.permissionID,files:saved.files,expected)
            saved = .init(state:.active,registration:saved.registration,identity:identity,files:saved.files,tokens:renewed);try check(expected);try save(saved,expected:pending.id)
        } else {
            let identity=try await verify(old,subject:saved.identity.permissionID,files:saved.files,expected)
            if identity != saved.identity {let next=DriveRecord(state:.active,registration:saved.registration,identity:identity,files:saved.files,tokens:old);try save(next,expected:saved.id);saved=next}
        }
        return saved
    }
    // Native Connect/Change selection only. Empty/cancelled selection preserves
    // the existing local grant. A new successful Picker choice replaces its IDs;
    // no model request or provider inventory can add an ID.
    func connect(_ registration:GmailRegistration,consent:@escaping(GmailRegistration,DriveIdentity?)async throws->Bool,openBrowser:@escaping(URL)throws->Bool)async throws->DriveIdentity {
        guard !busy else {throw DriveError.busy};busy=true;defer {busy=false;loopback?.cancel();auth?.cancel();loopback=nil;auth=nil};let expected=generation
        do {
            let original:DriveRecord?,blocked:Bool
            do {original=try store.load();blocked=try store.isBlocked();try original?.validate()} catch {throw DriveError.storage}
            let continuing = !blocked && original != nil && original!.state != .disconnected
            if continuing,original!.registration != registration {throw DriveError.existing}
            try registration.validate();guard try await consent(registration,continuing ? original?.identity:nil) else {throw DriveError.denied};try check(expected)
            let loopback=listener(),auth=authorization();self.loopback=loopback;self.auth=auth
            let port=try await loopback.start();try check(expected)
            let request=try auth.begin(registration,port:port,now:now());guard try openBrowser(request.url) else {throw DriveError.callback};try check(expected)
            let callback=try await loopback.callback();try check(expected);let code=try auth.consume(callback,now:now()),sent=now()
            let tokens=try DriveJSON.tokens(await send(.exchange(code),expected),sent:sent)
            let identity=try await verify(tokens,subject:nil,files:[],expected)
            if continuing,identity.permissionID != original!.identity.permissionID {throw DriveError.account}
            var files:[DriveFile]=[]
            for id in code.selectedIDs {let file=try await metadata(tokens,id:id,key:nil,expected);guard !file.trashed else {throw DriveError.download};files.append(file)}
            let confirmed=try await verify(tokens,subject:identity.permissionID,files:files,expected)
            guard !DriveJSON.containsAccess(files.map {$0.output()},tokens:tokens,files:files),tokens.expires>now().addingTimeInterval(60) else {throw DriveError.invalid};try check(expected)
            // Publishing a replacement is fenced before touching its old record.
            do {try store.setBlocked(true)} catch {held=true;throw DriveError.storage}
            try save(.init(state:.active,registration:registration,identity:confirmed,files:files,tokens:tokens),expected:original?.id)
            do {try store.setBlocked(false)} catch {held=true;throw DriveError.storage};held=false;return confirmed
        } catch let e as DriveError {throw e} catch {throw Task.isCancelled || expected != generation ? DriveError.cancelled:.transport}
    }
    func disconnect()throws {
        cancel();held=true
        do {try store.setBlocked(true);guard let saved=try store.load() else {record=nil;return};try save(.init(state:.disconnected,registration:saved.registration,identity:saved.identity,files:saved.files),expected:saved.id)} catch {held=true;record=nil;throw DriveError.storage}
    }
    func revoke(consent:@escaping(DriveIdentity,GmailRegistration)async throws->Bool)async throws {
        guard !busy else {throw DriveError.busy};busy=true;defer {busy=false};let expected=generation
        let saved:DriveRecord
        do {guard let value=try store.load(),[DriveRecord.State.active,.revocationPending].contains(value.state),value.tokens != nil else {throw DriveError.unavailable};try value.validate();saved=value} catch let e as DriveError {throw e} catch {throw DriveError.storage}
        guard try await consent(saved.identity,saved.registration) else {return};try check(expected)
        do {try store.setBlocked(true)} catch {throw DriveError.storage};held=true
        let pending=DriveRecord(state:.revocationPending,registration:saved.registration,identity:saved.identity,files:saved.files,tokens:saved.tokens);try save(pending,expected:saved.id)
        do {_ = try await send(.revoke(saved.tokens!.refresh),expected);try check(expected)} catch {throw DriveError.revoke}
        try save(.init(state:.disconnected,registration:saved.registration,identity:saved.identity,files:saved.files),expected:pending.id)
    }
    func perform(_ input:[String:Any])async throws->[String:Any] {
        guard let action=input["action"] as? String else {throw DriveError.invalid}
        let id:String?
        if action=="status" {guard Set(input.keys)==["action"] else {throw DriveError.invalid};id=nil}
        else {guard ["drive_file_metadata","drive_file_text"].contains(action),Set(input.keys)==["action","id"],let value=input["id"] as? String,PrivateAccountRead.identifier(value) else {throw DriveError.invalid};id=value}
        guard !busy else {throw DriveError.busy};busy=true;defer {busy=false;worker=nil};let expected=generation
        let task=Task {()throws->[String:Any] in
            do {
                let saved=try await self.usable(expected),tokens=saved.tokens!
                guard let id else {guard !DriveJSON.containsAccess(saved.files.map {$0.output()},tokens:tokens,files:saved.files) else {throw DriveError.invalid};return self.status(state:"connected",saved:saved)}
                guard let selected=saved.files.first(where:{$0.id==id}) else {throw DriveError.selected}
                let before=try await self.metadata(tokens,id:id,key:selected.resourceKey,expected)
                var result=before.output()
                if action=="drive_file_text" {
                    try before.contentAllowed();let bytes=try await self.send(.content(tokens.access,before),expected)
                    guard let text=String(data:bytes,encoding:.utf8),!text.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0) && ![9,10,13].contains($0.value)}) else {throw DriveError.unsupported}
                    if before.mime=="text/plain",let size=before.size {guard Int64(size)==Int64(bytes.count) else {throw DriveError.changed}}
                    let after=try await self.metadata(tokens,id:id,key:before.resourceKey,expected);try after.contentAllowed()
                    guard after==before else {throw DriveError.changed}
                    result["text"]=text;result["contentIncluded"]=true;result["complete"]=true
                    result["representation"]=before.mime=="text/plain" ? "UTF-8 plain text":"Google Docs plain-text export; formatting, images, comments and full tab fidelity are not preserved"
                }
                let identity=try await self.verify(tokens,subject:saved.identity.permissionID,files:saved.files+[before],expected);try self.check(expected)
                guard tokens.expires>self.now(),!DriveJSON.containsAccess(result,tokens:tokens,files:saved.files+[before]) else {throw DriveError.invalid}
                guard try JSONSerialization.data(withJSONObject:result).count<=DrivePolicy.maxText else {throw DriveError.oversized}
                // Same approved IDs only; refresh displayed metadata, never discover
                // or follow shortcut targets or add provider-accessible files.
                if selected != before || identity != saved.identity {
                    let files=saved.files.map {$0.id==id ? before:$0}
                    guard Set(files.map(\.id))==Set(saved.files.map(\.id)) else {throw DriveError.selected}
                    try self.save(.init(state:.active,registration:saved.registration,identity:identity,files:files,tokens:tokens),expected:saved.id)
                }
                return result
            } catch let e as DriveError {
                if [.identity,.denied,.scope,.expired].contains(e) {self.invalidate()}
                if id==nil {return self.status(state:e == .unavailable ? "unconfigured":"held",message:e.localizedDescription)};throw e
            } catch {throw Task.isCancelled ? DriveError.cancelled:.invalid}
        }
        worker=task;return try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
    }
    private func status(state:String,saved:DriveRecord?=nil,message:String?=nil)->[String:Any] {
        var value:[String:Any]=["id":"drive","state":state,"connected":state=="connected","readAvailable":state=="connected","grantAvailable":true,"requestedScope":DrivePolicy.scope,"message":message ?? "Native Google Picker selection. Only approved IDs can be read. Names below are last-verified metadata; each file's current access is checked when read. Google's drive.file grant includes write capability and prior app-authorized files; Noiee exposes GET-only reads of its exact selected IDs."]
        if let saved {value["account"]=saved.identity.email ?? "Drive account "+saved.identity.permissionID;value["files"]=saved.files.map {["id":$0.id,"name":$0.name,"mimeType":$0.mime]}}
        return value
    }
}
