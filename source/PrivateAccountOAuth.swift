import Foundation
import CryptoKit
import Security

// Google authorization preparation/validation only. No listener, browser opener,
// token exchange or persistence is exposed until production registration exists.
// Never put the authorize URL, callback, code or verifier into tool results.
@MainActor final class PrivateAccountGoogleAuthorization {
    struct Registration {
        let clientID:String,provider:PrivateAccountProvider,redirect:URL
        init(clientID:String,provider:PrivateAccountProvider,loopbackPort:Int) throws {
            guard provider != .github,loopbackPort>=1024,loopbackPort<=65535,
                  clientID.hasSuffix(".apps.googleusercontent.com"),clientID.utf8.count<=256,
                  clientID.utf8.allSatisfy({($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45||$0==46}) else {throw PrivateAccountFailure.invalid}
            self.clientID=clientID;self.provider=provider
            self.redirect=URL(string:"http://127.0.0.1:\(loopbackPort)/oauth/callback")!
        }
    }
    struct Prepared:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
        let browserURL:URL
        var description:String {"Google authorization request [redacted]"}
        var debugDescription:String {description}
        var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    }
    struct Code:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
        // Native coordinator may consume this for a fixed token endpoint later.
        let value:String,verifier:String,redirect:URL,clientID:String,provider:PrivateAccountProvider
        var description:String {"Google authorization code [redacted]"}
        var debugDescription:String {description}
        var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    }
    private struct Pending {let registration:Registration,state:String,verifier:String,created:Date}
    private var pending:Pending?,generation=UUID(),starting=false
    private let random:()->Data
    init(random:@escaping()->Data = {
        var bytes=[UInt8](repeating:0,count:32)
        guard SecRandomCopyBytes(kSecRandomDefault,bytes.count,&bytes)==errSecSuccess else {return Data()}
        return Data(bytes)
    }) {self.random=random}
    private func base64(_ bytes:Data)->String {bytes.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
    func cancel() {generation=UUID();pending=nil}
    func begin(_ registration:Registration?,now:Date=Date(),approveNative:@escaping(PrivateAccountProvider,String) async throws -> Bool) async throws -> Prepared {
        guard let registration else {throw PrivateAccountFailure.unconfigured}
        guard !starting,pending==nil else {throw PrivateAccountFailure.busy}
        starting=true;defer {starting=false};let expected=generation
        // There is deliberately no operational/Full Access bypass parameter.
        let approved:Bool
        do {approved=try await approveNative(registration.provider,registration.provider.scope)} catch {throw PrivateAccountFailure.denied}
        guard expected==generation,!Task.isCancelled else {throw PrivateAccountFailure.cancelled}
        guard approved else {throw PrivateAccountFailure.denied}
        let stateBytes=random(),verifierBytes=random()
        guard stateBytes.count==32,verifierBytes.count==32,stateBytes != verifierBytes,now.timeIntervalSince1970.isFinite else {throw PrivateAccountFailure.invalid}
        let state=base64(stateBytes),verifier=base64(verifierBytes),challenge=base64(Data(SHA256.hash(data:Data(verifier.utf8))))
        var url=URLComponents(string:"https://accounts.google.com/o/oauth2/v2/auth")!
        url.queryItems=[.init(name:"client_id",value:registration.clientID),.init(name:"redirect_uri",value:registration.redirect.absoluteString),
                       .init(name:"response_type",value:"code"),.init(name:"scope",value:registration.provider.scope),
                       .init(name:"state",value:state),.init(name:"code_challenge",value:challenge),.init(name:"code_challenge_method",value:"S256"),
                       .init(name:"access_type",value:"offline"),.init(name:"prompt",value:"consent")]
        pending=Pending(registration:registration,state:state,verifier:verifier,created:now)
        return Prepared(browserURL:url.url!)
    }
    func consume(_ callback:URL,now:Date=Date()) throws -> Code {
        guard let pending else {throw PrivateAccountFailure.callback}
        self.pending=nil // Every callback attempt consumes state, including errors.
        guard now>=pending.created,now.timeIntervalSince(pending.created)<=300,callback.absoluteString.utf8.count<=8192,
              let received=URLComponents(url:callback,resolvingAgainstBaseURL:false),
              received.scheme=="http",received.host=="127.0.0.1",received.port==pending.registration.redirect.port,
              received.percentEncodedPath=="/oauth/callback",received.user==nil,received.password==nil,received.fragment==nil else {throw PrivateAccountFailure.callback}
        var items:[String:String]=[:]
        for item in received.queryItems ?? [] {
            guard ["state","code","scope","authuser","prompt","error","error_description","error_uri"].contains(item.name),items[item.name]==nil,
                  let value=item.value,value.utf8.count<=4096 else {throw PrivateAccountFailure.callback}
            items[item.name]=value
        }
        guard items["state"]==pending.state else {throw PrivateAccountFailure.callback}
        if items["error"] != nil {throw PrivateAccountFailure.denied}
        guard let code=items["code"],!code.isEmpty,code.utf8.allSatisfy({$0>=33 && $0<=126}),
              items["scope"]==nil || items["scope"]==pending.registration.provider.scope else {throw PrivateAccountFailure.callback}
        return Code(value:code,verifier:pending.verifier,redirect:pending.registration.redirect,clientID:pending.registration.clientID,provider:pending.registration.provider)
    }
}
