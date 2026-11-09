import Foundation
import CryptoKit
import Security

// Desktop Picker uses drive.file alone. It cannot request OpenID/email scopes.
// State + PKCE bind the OAuth session. Picked IDs are not claimed to be signed;
// the coordinator verifies account, exact scope and each selected resource.
@MainActor final class DriveAuthorization {
    struct Request:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
        let url:URL
        var description:String {"[redacted Drive Picker request]"}
        var debugDescription:String {description}
        var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    }
    struct Code:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
        let code:GmailSecret,verifier:GmailSecret,redirect:URL,registration:GmailRegistration,selectedIDs:[String]
        var description:String {"[redacted Drive authorization code]"}
        var debugDescription:String {description}
        var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    }
    private struct Pending {let registration:GmailRegistration,state:String,verifier:GmailSecret,redirect:URL,created:Date}
    private var pending:Pending?
    private let random:()->Data
    init(random:@escaping()->Data={var bytes=[UInt8](repeating:0,count:32);guard SecRandomCopyBytes(kSecRandomDefault,bytes.count,&bytes)==errSecSuccess else {return Data()};return Data(bytes)}) {self.random=random}
    func cancel(){pending=nil}
    func begin(_ registration:GmailRegistration,port:Int,now:Date)throws->Request {
        guard pending==nil,port>=1024,port<=65535,now.timeIntervalSince1970.isFinite else {throw DriveError.callback};try registration.validate()
        let stateBytes=random(),verifierBytes=random();guard stateBytes.count==32,verifierBytes.count==32,stateBytes != verifierBytes else {throw DriveError.invalid}
        let state=GmailAuthorization.base64(stateBytes),verifier=GmailAuthorization.base64(verifierBytes),redirect=URL(string:"http://127.0.0.1:\(port)/oauth/callback")!
        var url=URLComponents(string:"https://accounts.google.com/o/oauth2/v2/auth")!
        url.queryItems=[.init(name:"client_id",value:registration.clientID),.init(name:"redirect_uri",value:redirect.absoluteString),.init(name:"response_type",value:"code"),.init(name:"scope",value:DrivePolicy.scope),.init(name:"state",value:state),.init(name:"code_challenge",value:GmailAuthorization.base64(Data(SHA256.hash(data:Data(verifier.utf8))))),.init(name:"code_challenge_method",value:"S256"),.init(name:"access_type",value:"offline"),.init(name:"prompt",value:"consent"),.init(name:"trigger_onepick",value:"true"),.init(name:"allow_multiple",value:"true")]
        pending=try Pending(registration:registration,state:state,verifier:.init(verifier),redirect:redirect,created:now)
        return Request(url:url.url!)
    }
    func consume(_ callback:URL,now:Date)throws->Code {
        guard let p=pending else {throw DriveError.callback};pending=nil
        guard now>=p.created,now.timeIntervalSince(p.created)<=300,callback.absoluteString.utf8.count<=8192,
              let url=URLComponents(url:callback,resolvingAgainstBaseURL:false),url.scheme=="http",url.host=="127.0.0.1",url.port==p.redirect.port,url.percentEncodedPath=="/oauth/callback",url.user==nil,url.password==nil,url.fragment==nil else {throw DriveError.callback}
        var values:[String:String]=[:]
        for item in url.queryItems ?? [] {
            guard ["state","code","scope","picked_file_ids","authuser","prompt","error","error_description","error_uri"].contains(item.name),values[item.name]==nil,let value=item.value,value.utf8.count<=4096 else {throw DriveError.callback};values[item.name]=value
        }
        guard values["state"]==p.state else {throw DriveError.callback}
        if values["error"] != nil {throw DriveError.denied}
        guard values["error_description"]==nil,values["error_uri"]==nil,values["scope"]==DrivePolicy.scope,let code=values["code"] else {throw DriveError.callback}
        guard let raw=values["picked_file_ids"],!raw.isEmpty else {throw DriveError.selection}
        let ids=raw.split(separator:",",omittingEmptySubsequences:false).map(String.init)
        guard ids.count<=DrivePolicy.maxFiles,Set(ids).count==ids.count,ids.allSatisfy(PrivateAccountRead.identifier) else {throw DriveError.selection}
        return try Code(code:.init(code),verifier:p.verifier,redirect:p.redirect,registration:p.registration,selectedIDs:ids.sorted())
    }
}
