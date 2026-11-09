import Foundation
import Security
import CryptoKit
import LocalAuthentication

// Native-only foundation. No production grant loader, callback listener or Picker
// exists yet. The app exposes status only, never these credential-bearing APIs.
enum PrivateAccountProvider: String, CaseIterable, Codable {
    case gmail, drive, github
    var scope: String {
        switch self {
        case .gmail: return "https://www.googleapis.com/auth/gmail.readonly"
        case .drive: return "https://www.googleapis.com/auth/drive.file"
        case .github: return "github-app-selected-repositories-read"
        }
    }
    var prerequisite: String {
        switch self {
        case .gmail: return "Register a Google Desktop OAuth client, enable Gmail API, configure consent for restricted gmail.readonly, and complete the native browser callback integration."
        case .drive: return "Register a Google Desktop OAuth client, enable Drive API and complete native consent plus a verified Google Picker selection. drive.file permits writes at the provider; this connector permits only reads of selected file metadata."
        case .github: return "Register a GitHub App with selected repositories and read-only metadata/issues permissions; complete installation, user consent and secure token delivery. No gh credentials or embedded app secret/private key are used."
        }
    }
}

enum PrivateAccountFailure: String, Error, LocalizedError {
    case invalid = "Private account request is invalid or outside its fixed read-only limits."
    case unconfigured = "Private account registration and native user authorization are not configured. No account was connected."
    case denied = "Private account access was denied. A fresh native user authorization is required."
    case cancelled = "Private account work was cancelled. No late result was accepted."
    case expired = "Private account authorization expired. Reconnect through native user consent."
    case callback = "OAuth callback could not be verified. Start a new native authorization."
    case busy = "Another private account operation is pending."
    case storage = "Private account credential storage is unavailable. No secret details were returned."
    case transport = "Private account request failed. No provider error body or credential was returned."
    case response = "Private account response is invalid, redirected or exceeds its bounded limit."
    var errorDescription: String? {rawValue}
}

struct PrivateAccountSecret: Codable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    fileprivate let value: String
    init(_ value: String) throws {
        guard value.utf8.count >= 8, value.utf8.count <= 8192,
              value.utf8.allSatisfy({$0 >= 33 && $0 <= 126}) else {throw PrivateAccountFailure.invalid}
        self.value=value
    }
    var description: String {"[redacted private account credential]"}
    var debugDescription: String {description}
    var customMirror: Mirror {Mirror(self, children: ["redacted":true])}
}

// Only the future native consent/selection coordinator may publish a grant.
// This is NOT proof of provider permissions and has no bridge/model decoder.
struct PrivateAccountGrant: Codable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let id: UUID, provider: PrivateAccountProvider, scope: String, expiresAt: Date
    let selectedResources: Set<String>
    fileprivate let secret: PrivateAccountSecret
    init(id: UUID = UUID(), provider: PrivateAccountProvider, token: String, expiresAt: Date,
         selectedResources: Set<String> = []) throws {
        self.id=id;self.provider=provider;self.scope=provider.scope;self.expiresAt=expiresAt
        self.selectedResources=provider == .github ? Set(selectedResources.map {$0.lowercased()}):selectedResources;self.secret=try PrivateAccountSecret(token)
        try validate()
    }
    func validate() throws {
        guard scope==provider.scope, expiresAt.timeIntervalSince1970.isFinite, selectedResources.count<=100,
              provider != .gmail || selectedResources.isEmpty,
              provider == .gmail || !selectedResources.isEmpty,
              selectedResources.allSatisfy({provider == .github ? PrivateAccountRead.repository($0) && $0==$0.lowercased():PrivateAccountRead.identifier($0)}) else {throw PrivateAccountFailure.invalid}
        _ = try PrivateAccountSecret(secret.value)
    }
    var description: String {"PrivateAccountGrant(provider: \(provider.rawValue), credentials: redacted)"}
    var debugDescription: String {description}
    var customMirror: Mirror {Mirror(self, children: ["redacted":true])}
}

@MainActor protocol PrivateAccountCredentialStore {
    func read(_ provider: PrivateAccountProvider) throws -> PrivateAccountGrant?
    func insert(_ grant: PrivateAccountGrant) throws
    func remove(_ provider: PrivateAccountProvider) throws
}

@MainActor final class PrivateAccountKeychain: PrivateAccountCredentialStore {
    private let service="com.saleh.qwenlocal.chat.private-accounts.v1"
    private func query(_ provider: PrivateAccountProvider) -> [String:Any] {
        let context=LAContext();context.interactionNotAllowed=true
        return [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,
         kSecAttrAccount as String:provider.rawValue,kSecAttrSynchronizable as String:false,
         kSecUseAuthenticationContext as String:context]
    }
    func read(_ provider: PrivateAccountProvider) throws -> PrivateAccountGrant? {
        var query=query(provider);query[kSecReturnData as String]=true;query[kSecMatchLimit as String]=kSecMatchLimitOne
        var item:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&item)
        if status==errSecItemNotFound {return nil}
        guard status==errSecSuccess, let bytes=item as? Data, bytes.count<=32768 else {throw PrivateAccountFailure.storage}
        do {let grant=try JSONDecoder().decode(PrivateAccountGrant.self,from:bytes);try grant.validate();guard grant.provider==provider else {throw PrivateAccountFailure.storage};return grant}
        catch {throw PrivateAccountFailure.storage}
    }
    func insert(_ grant: PrivateAccountGrant) throws {
        do {
            try grant.validate();let bytes=try JSONEncoder().encode(grant)
            guard bytes.count<=32768 else {throw PrivateAccountFailure.storage}
            var query=query(grant.provider);query[kSecValueData as String]=bytes
            query[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            // Never replace an existing account implicitly. Explicit local revoke first.
            guard SecItemAdd(query as CFDictionary,nil)==errSecSuccess else {throw PrivateAccountFailure.storage}
        } catch {throw PrivateAccountFailure.storage}
    }
    func remove(_ provider: PrivateAccountProvider) throws {
        let status=SecItemDelete(query(provider) as CFDictionary)
        guard status==errSecSuccess || status==errSecItemNotFound else {throw PrivateAccountFailure.storage}
    }
}

enum PrivateAccountRead {
    case gmailMessages(query: String, pageToken: String?)
    case gmailMessageMetadata(id: String)
    case driveFileMetadata(id: String)
    case githubRepository(name: String)
    case githubIssues(name: String, page: Int)
    var provider: PrivateAccountProvider {
        switch self {case .gmailMessages,.gmailMessageMetadata:return .gmail;case .driveFileMetadata:return .drive;default:return .github}
    }
    static func identifier(_ value:String)->Bool {
        !value.isEmpty && value.utf8.count<=256 && value.utf8.allSatisfy {($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45||$0==95}
    }
    static func repository(_ value:String)->Bool {
        let parts=value.split(separator:"/",omittingEmptySubsequences:false)
        return parts.count==2 && parts[0].count<=39 && parts[1].count<=100 && parts.allSatisfy {part in
            !part.isEmpty && part != "." && part != ".." && part.utf8.allSatisfy {($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45||$0==95||$0==46}
        }
    }
    func request(grant:PrivateAccountGrant) throws -> URLRequest {
        try grant.validate();guard provider==grant.provider else {throw PrivateAccountFailure.denied}
        var base:String,query:[URLQueryItem]=[]
        switch self {
        case let .gmailMessages(text,page):
            guard text.utf8.count<=1024,!text.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),
                  page == nil || page!.utf8.count<=1024 && !page!.isEmpty && page!.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw PrivateAccountFailure.invalid}
            base="https://gmail.googleapis.com/gmail/v1/users/me/messages"
            query=[.init(name:"maxResults",value:"50"),.init(name:"q",value:text),.init(name:"fields",value:"messages(id,threadId),nextPageToken,resultSizeEstimate")]
            if let page {query.append(.init(name:"pageToken",value:page))}
        case let .gmailMessageMetadata(id):
            guard Self.identifier(id) else {throw PrivateAccountFailure.invalid}
            base="https://gmail.googleapis.com/gmail/v1/users/me/messages/"+id
            query=[.init(name:"format",value:"metadata"),.init(name:"fields",value:"id,threadId,snippet,payload/headers")]
            for name in ["From","To","Subject","Date"] {query.append(.init(name:"metadataHeaders",value:name))}
        case let .driveFileMetadata(id):
            guard Self.identifier(id),grant.selectedResources.contains(id) else {throw PrivateAccountFailure.denied}
            base="https://www.googleapis.com/drive/v3/files/"+id
            query=[.init(name:"fields",value:"id,name,mimeType,size,modifiedTime,trashed"),.init(name:"supportsAllDrives",value:"true")]
        case let .githubRepository(name),let .githubIssues(name,_):
            guard Self.repository(name),grant.selectedResources.contains(name.lowercased()) else {throw PrivateAccountFailure.denied}
            base="https://api.github.com/repos/"+name
            if case let .githubIssues(_,page)=self {
                guard page>=1,page<=1000 else {throw PrivateAccountFailure.invalid}
                base+="/issues";query=[.init(name:"state",value:"all"),.init(name:"per_page",value:"50"),.init(name:"page",value:String(page))]
            }
        }
        var components=URLComponents(string:base)!;if !query.isEmpty {components.queryItems=query}
        guard let url=components.url else {throw PrivateAccountFailure.invalid}
        var request=URLRequest(url:url);request.httpMethod="GET";request.timeoutInterval=30
        request.setValue("Bearer "+grant.secret.value,forHTTPHeaderField:"Authorization")
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        if provider == .github {request.setValue("2022-11-28",forHTTPHeaderField:"X-GitHub-Api-Version");request.setValue("application/vnd.github+json",forHTTPHeaderField:"Accept")}
        return request
    }
    func parse(_ data:Data,grant:PrivateAccountGrant) throws -> [String:Any] {
        guard data.count<=262144,let value=try? JSONSerialization.jsonObject(with:data,options:[.fragmentsAllowed]) else {throw PrivateAccountFailure.response}
        func string(_ value:Any?,max:Int=4096) throws -> String {
            guard let s=value as? String,s.utf8.count<=max,!s.contains("\0") else {throw PrivateAccountFailure.response}
            // Provider-controlled bodies and error objects never pass through wholesale.
            return s.replacingOccurrences(of:grant.secret.value,with:"[redacted]")
        }
        func identifier(_ value:Any?) throws -> String {let id=try string(value,max:256);guard Self.identifier(id) else {throw PrivateAccountFailure.response};return id}
        func integer(_ value:Any?) throws -> Int {
            guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=9007199254740991,n.doubleValue.rounded()==n.doubleValue else {throw PrivateAccountFailure.response};return n.intValue
        }
        func optionalString(_ value:Any?,max:Int=4096) throws -> String {
            if value == nil || value is NSNull {return ""}
            return try string(value,max:max)
        }
        var result:[String:Any]=["provider":provider.rawValue,"readOnly":true]
        switch self {
        case .gmailMessages:
            guard let object=value as? [String:Any],Set(object.keys).isSubset(of:["messages","nextPageToken","resultSizeEstimate"]),
                  object["messages"] != nil || object["resultSizeEstimate"] != nil,
                  let rows=(object["messages"] ?? []) as? [[String:Any]],rows.count<=50 else {throw PrivateAccountFailure.response}
            if let estimate=object["resultSizeEstimate"] {result["resultSizeEstimate"]=try integer(estimate)}
            result["messages"]=try rows.map {try ["id":identifier($0["id"]),"threadId":identifier($0["threadId"])]}
            if let token=object["nextPageToken"] {let page=try string(token,max:1024);guard !page.isEmpty else {throw PrivateAccountFailure.response};result["nextPageToken"]=page}
            result["complete"]=object["nextPageToken"]==nil
        case let .gmailMessageMetadata(expected):
            guard let object=value as? [String:Any],try identifier(object["id"])==expected,
                  let payload=object["payload"] as? [String:Any],let headers=(payload["headers"] ?? []) as? [[String:Any]],headers.count<=32 else {throw PrivateAccountFailure.response}
            result["id"]=expected;result["threadId"]=try identifier(object["threadId"]);result["snippet"]=try string(object["snippet"] ?? "")
            result["headers"]=try headers.compactMap {row -> [String:String]? in
                let name=try string(row["name"],max:64);guard ["from","to","subject","date"].contains(name.lowercased()) else {return nil}
                return ["name":name,"value":try string(row["value"],max:8192)]
            }
            result["bodyIncluded"]=false
        case let .driveFileMetadata(expected):
            guard let object=value as? [String:Any],try identifier(object["id"])==expected else {throw PrivateAccountFailure.response}
            result["id"]=expected;result["name"]=try string(object["name"]);result["mimeType"]=try string(object["mimeType"],max:256)
            for key in ["size","modifiedTime"] {if let v=object[key] {result[key]=try string(v,max:128)}}
            if let flag=object["trashed"] {guard let n=flag as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else {throw PrivateAccountFailure.response};result["trashed"]=n.boolValue}
            result["contentIncluded"]=false
        case let .githubRepository(expected):
            guard let object=value as? [String:Any],try string(object["full_name"],max:140).lowercased()==expected.lowercased() else {throw PrivateAccountFailure.response}
            result["id"]=try integer(object["id"]);result["fullName"]=expected;result["description"]=try optionalString(object["description"])
            result["url"]="https://github.com/"+expected
        case let .githubIssues(name,page):
            guard let rows=value as? [[String:Any]],rows.count<=50 else {throw PrivateAccountFailure.response}
            result["issues"]=try rows.map {row -> [String:Any] in
                let number=try integer(row["number"]),state=try string(row["state"],max:20)
                guard number>0,["open","closed"].contains(state) else {throw PrivateAccountFailure.response}
                let pull=row["pull_request"] != nil
                return ["number":number,"title":try string(row["title"]),"body":try optionalString(row["body"],max:16384),"state":state,"isPullRequest":pull,"url":"https://github.com/"+name+(pull ? "/pull/":"/issues/")+String(number)]
            }
            // A full page does not establish a next page, and is never auto-fetched.
            result["mayHaveMore"]=rows.count==50;result["page"]=page
        }
        guard JSONSerialization.isValidJSONObject(result),try JSONSerialization.data(withJSONObject:result).count<=262144 else {throw PrivateAccountFailure.response}
        func redact(_ value:Any)->Any {
            if let text=value as? String {return text.replacingOccurrences(of:grant.secret.value,with:"[redacted]")}
            if let array=value as? [Any] {return array.map(redact)}
            if let object=value as? [String:Any] {return object.mapValues(redact)}
            return value
        }
        return redact(result) as! [String:Any]
    }
}

struct PrivateAccountHTTPResponse {let url:URL,status:Int,data:Data}
@MainActor protocol PrivateAccountTransport {
    func send(_ request:URLRequest,maxBytes:Int) async throws -> PrivateAccountHTTPResponse
}
private final class PrivateAccountNoRedirect:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) {completionHandler(nil)}
}
@MainActor final class PrivateAccountURLTransport:PrivateAccountTransport {
    private let session:URLSession
    init() {
        let config=URLSessionConfiguration.ephemeral;config.httpCookieStorage=nil;config.httpShouldSetCookies=false
        config.urlCredentialStorage=nil;config.urlCache=nil;config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest=30;config.timeoutIntervalForResource=45
        session=URLSession(configuration:config,delegate:PrivateAccountNoRedirect(),delegateQueue:nil)
    }
    static func validate(_ request:URLRequest,maxBytes:Int) throws {
        guard request.httpMethod=="GET",request.httpBody==nil,request.httpBodyStream==nil,let url=request.url,
              let components=URLComponents(url:url,resolvingAgainstBaseURL:false),url.scheme=="https",url.port==nil,
              url.user==nil,url.password==nil,url.fragment==nil,maxBytes>0,maxBytes<=262144,
              components.percentEncodedPath==url.path else {throw PrivateAccountFailure.invalid}
        let parts=url.path.split(separator:"/",omittingEmptySubsequences:true).map {String($0)}
        guard url.path=="/"+parts.joined(separator:"/") else {throw PrivateAccountFailure.invalid}
        let items=components.queryItems ?? []
        var values:[String:[String]]=[:]
        for item in items {guard let value=item.value else {throw PrivateAccountFailure.invalid};values[item.name,default:[]].append(value)}
        let keys=Set(values.keys)
        func one(_ key:String,_ expected:String)->Bool {values[key]==[expected]}
        var allowed=false
        if url.host=="gmail.googleapis.com",parts==["gmail","v1","users","me","messages"] {
            allowed=keys==["maxResults","q","fields"] || keys==["maxResults","q","fields","pageToken"]
            allowed=allowed && one("maxResults","50") && one("fields","messages(id,threadId),nextPageToken,resultSizeEstimate") && values["q"]?.count==1 && (values["q"]?.first?.utf8.count ?? 2048)<=1024
            if let page=values["pageToken"] {allowed=allowed && page.count==1 && !page[0].isEmpty && page[0].utf8.count<=1024}
        } else if url.host=="gmail.googleapis.com",parts.count==6,Array(parts.prefix(5))==["gmail","v1","users","me","messages"],PrivateAccountRead.identifier(parts[5]) {
            allowed=keys==["format","fields","metadataHeaders"] && one("format","metadata") && one("fields","id,threadId,snippet,payload/headers") && values["metadataHeaders"]==["From","To","Subject","Date"]
        } else if url.host=="www.googleapis.com",parts.count==4,Array(parts.prefix(3))==["drive","v3","files"],PrivateAccountRead.identifier(parts[3]) {
            allowed=keys==["fields","supportsAllDrives"] && one("fields","id,name,mimeType,size,modifiedTime,trashed") && one("supportsAllDrives","true")
        } else if url.host=="api.github.com",parts.count>=3,parts[0]=="repos",PrivateAccountRead.repository(parts[1]+"/"+parts[2]) {
            allowed=parts.count==3 && keys.isEmpty
            if parts.count==4,parts[3]=="issues",let page=values["page"],page.count==1,let n=Int(page[0]),n>=1,n<=1000,String(n)==page[0] {
                allowed=keys==["state","per_page","page"] && one("state","all") && one("per_page","50")
            }
        }
        guard allowed else {throw PrivateAccountFailure.invalid}
    }
    func send(_ request:URLRequest,maxBytes:Int) async throws -> PrivateAccountHTTPResponse {
        try Self.validate(request,maxBytes:maxBytes)
        let url=request.url!
        do {
            let (stream,response)=try await session.bytes(for:request)
            guard let http=response as? HTTPURLResponse,http.url==url,http.expectedContentLength<=maxBytes else {stream.task.cancel();throw PrivateAccountFailure.response}
            // Never collect provider error bodies, which can include request details.
            if http.statusCode != 200 {stream.task.cancel();return .init(url:url,status:http.statusCode,data:Data())}
            guard http.mimeType=="application/json" else {stream.task.cancel();throw PrivateAccountFailure.response}
            var data=Data();do {for try await byte in stream {try Task.checkCancellation();guard data.count<maxBytes else {throw PrivateAccountFailure.response};data.append(byte)}}
            catch {stream.task.cancel();throw error}
            return .init(url:url,status:200,data:data)
        } catch let error as PrivateAccountFailure {throw error}
        catch {throw Task.isCancelled ? PrivateAccountFailure.cancelled:PrivateAccountFailure.transport}
    }
}

@MainActor final class PrivateAccountReader {
    private let credentials:any PrivateAccountCredentialStore,transport:any PrivateAccountTransport
    private var generation=UUID(),blocked=Set<PrivateAccountProvider>(),pending:Task<[String:Any],Error>?
    init(credentials:any PrivateAccountCredentialStore,transport:any PrivateAccountTransport) {self.credentials=credentials;self.transport=transport}
    func cancel() {generation=UUID();pending?.cancel()}
    // Local credential removal is not a claim of remote OAuth revocation.
    func disconnectLocally(_ provider:PrivateAccountProvider) throws {
        cancel();blocked.insert(provider)
        do {try credentials.remove(provider)} catch {throw PrivateAccountFailure.storage}
    }
    func read(_ operation:PrivateAccountRead,now:Date=Date()) async throws -> [String:Any] {
        guard pending==nil else {throw PrivateAccountFailure.busy}
        guard !blocked.contains(operation.provider) else {throw PrivateAccountFailure.denied}
        let grant:PrivateAccountGrant
        do {guard let saved=try credentials.read(operation.provider) else {throw PrivateAccountFailure.unconfigured};grant=saved}
        catch let e as PrivateAccountFailure {throw e} catch {throw PrivateAccountFailure.storage}
        guard grant.expiresAt>now.addingTimeInterval(30) else {throw PrivateAccountFailure.expired}
        let request=try operation.request(grant:grant),expected=generation
        let task=Task {() throws -> [String:Any] in
            do {
                try Task.checkCancellation()
                let response=try await self.transport.send(request,maxBytes:262144)
                guard expected==self.generation,!Task.isCancelled else {throw PrivateAccountFailure.cancelled}
                guard response.url==request.url,response.data.count<=262144 else {throw PrivateAccountFailure.response}
                if response.status==401 || response.status==403 {self.blocked.insert(operation.provider);throw PrivateAccountFailure.denied}
                guard response.status==200 else {throw PrivateAccountFailure.transport}
                return try operation.parse(response.data,grant:grant)
            } catch let e as PrivateAccountFailure {throw e}
            catch {throw Task.isCancelled ? PrivateAccountFailure.cancelled:PrivateAccountFailure.transport}
        }
        pending=task;defer {pending=nil}
        return try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
    }
}

// Only status is reachable from Agent/Tools in this release. In particular no
// connect, token import, URL, scope, repository selection or revoke API is exposed.
enum PrivateAccountsAvailability {
    static func status(_ input:[String:Any]) throws -> [String:Any] {
        guard Set(input.keys)==["action"],input["action"] as? String=="status" else {throw PrivateAccountFailure.invalid}
        return ["providers":PrivateAccountProvider.allCases.map {provider -> [String:Any] in
            ["id":provider.rawValue,"state":"unconfigured","connected":false,"readAvailable":false,"grantAvailable":false,
             "requestedScope":provider.scope,"message":provider.prerequisite]
        },"message":"Read-only connector foundation only. No private account is connected. Native consent, provider registration and selected-resource setup are not yet available. Full Access does not grant account access."]
    }
}
