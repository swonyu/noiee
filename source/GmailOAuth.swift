import Foundation
import CryptoKit
import Security
import Network

// Native-only authorization material. Never returned to WebKit, Agent or logs.
struct GmailSecret:Codable,CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
    fileprivate let value:String
    init(_ value:String)throws {guard value.utf8.count>=8,value.utf8.count<=16384,value.utf8.allSatisfy({$0>=33 && $0<=126}) else {throw GmailError.invalid};self.value=value}
    var description:String {"[redacted Google credential]"}
    var debugDescription:String {description}
    var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    // Fixed native request and verifier code only, never a model decoder.
    func nativeValue()->String {value}
}
struct GmailRegistration:Codable,Equatable {
    let clientID:String
    init(_ value:String)throws {
        guard value.hasSuffix(".apps.googleusercontent.com"),value.count>30,value.utf8.count<=256,value.utf8.allSatisfy({($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45||$0==46}) else {throw GmailError.configuration}
        clientID=value
    }
    func validate()throws {_ = try Self(clientID)}
}
@MainActor final class GmailAuthorization {
    struct Request:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
        let url:URL
        var description:String {"[redacted Google authorization request]"}
        var debugDescription:String {description}
        var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    }
    struct Code:CustomStringConvertible,CustomDebugStringConvertible,CustomReflectable {
        let code:GmailSecret,verifier:GmailSecret,nonce:String,redirect:URL,registration:GmailRegistration,created:Date
        var description:String {"[redacted Google authorization code]"}
        var debugDescription:String {description}
        var customMirror:Mirror {Mirror(self,children:["redacted":true])}
    }
    private struct Pending {let state:String,code:Code}
    private var pending:Pending?
    private let random:()->Data
    init(random:@escaping()->Data={var b=[UInt8](repeating:0,count:32);guard SecRandomCopyBytes(kSecRandomDefault,b.count,&b)==errSecSuccess else {return Data()};return Data(b)}) {self.random=random}
    func cancel(){pending=nil}
    nonisolated static func base64(_ d:Data)->String {d.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
    func begin(_ registration:GmailRegistration,port:Int,now:Date)throws->Request {
        guard pending==nil,port>=1024,port<=65535,now.timeIntervalSince1970.isFinite else {throw GmailError.callback};try registration.validate()
        let bytes=[random(),random(),random()];guard bytes.allSatisfy({$0.count==32}),Set(bytes).count==3 else {throw GmailError.invalid}
        let state=Self.base64(bytes[0]),verifier=Self.base64(bytes[1]),nonce=Self.base64(bytes[2])
        let redirect=URL(string:"http://127.0.0.1:\(port)/oauth/callback")!
        var c=URLComponents(string:"https://accounts.google.com/o/oauth2/v2/auth")!
        c.queryItems=[.init(name:"client_id",value:registration.clientID),.init(name:"redirect_uri",value:redirect.absoluteString),.init(name:"response_type",value:"code"),.init(name:"scope",value:GmailScopes.request),.init(name:"state",value:state),.init(name:"nonce",value:nonce),.init(name:"code_challenge",value:Self.base64(Data(SHA256.hash(data:Data(verifier.utf8))))),.init(name:"code_challenge_method",value:"S256"),.init(name:"access_type",value:"offline"),.init(name:"prompt",value:"consent select_account")]
        pending=try Pending(state:state,code:Code(code:.init("pending-code"),verifier:.init(verifier),nonce:nonce,redirect:redirect,registration:registration,created:now))
        return Request(url:c.url!)
    }
    func consume(_ callback:URL,now:Date)throws->Code {
        guard let p=pending else {throw GmailError.callback};pending=nil
        guard now>=p.code.created,now.timeIntervalSince(p.code.created)<=300,callback.absoluteString.utf8.count<=8192,
              let c=URLComponents(url:callback,resolvingAgainstBaseURL:false),c.scheme=="http",c.host=="127.0.0.1",c.port==p.code.redirect.port,c.percentEncodedPath=="/oauth/callback",c.user==nil,c.password==nil,c.fragment==nil else {throw GmailError.callback}
        var values:[String:String]=[:]
        for item in c.queryItems ?? [] {
            guard ["state","code","scope","authuser","prompt","error","error_description","error_uri"].contains(item.name),values[item.name]==nil,let value=item.value,value.utf8.count<=4096 else {throw GmailError.callback};values[item.name]=value
        }
        guard values["state"]==p.state else {throw GmailError.callback}
        if values["error"] != nil {throw GmailError.denied}
        guard values["error_description"]==nil,values["error_uri"]==nil,let code=values["code"] else {throw GmailError.callback}
        if let scope=values["scope"] {try GmailScopes.validate(scope)}
        return try Code(code:.init(code),verifier:p.code.verifier,nonce:p.code.nonce,redirect:p.code.redirect,registration:p.code.registration,created:p.code.created)
    }
}

// Pure bounded HTTP parser is tested without opening any socket. The listener
// accepts only a loopback Host and origin-form GET, never a proxy target/body.
enum GmailLoopbackParser {
    static func parse(_ data:Data,port:Int)throws->URL {
        guard data.count<=8192,let text=String(data:data,encoding:.utf8),text.hasSuffix("\r\n\r\n") else {throw GmailError.callback}
        let lines=text.components(separatedBy:"\r\n"),first=lines[0].split(separator:" ",omittingEmptySubsequences:false)
        guard lines.count<=66,first.count==3,first[0]=="GET",first[2]=="HTTP/1.1",first[1].hasPrefix("/oauth/callback?"),!first[1].contains("#") else {throw GmailError.callback}
        var headers:[String:String]=[:]
        for line in lines.dropFirst().dropLast(2) {
            guard let split=line.firstIndex(of:":"),!line.hasPrefix(" "),!line.hasPrefix("\t") else {throw GmailError.callback}
            let key=String(line[..<split]).lowercased(),value=String(line[line.index(after:split)...]).trimmingCharacters(in:.whitespaces)
            guard !key.isEmpty,headers[key]==nil,key.utf8.allSatisfy({($0>=97 && $0<=122)||$0==45}),!value.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) else {throw GmailError.callback};headers[key]=value
        }
        guard headers["host"]=="127.0.0.1:\(port)",headers["transfer-encoding"]==nil,headers["content-length"]==nil || headers["content-length"]=="0",let url=URL(string:"http://127.0.0.1:\(port)"+first[1]) else {throw GmailError.callback}
        return url
    }
}
@MainActor protocol GmailLoopback {
    func start()async throws->Int
    func callback()async throws->URL
    func cancel()
}
@MainActor final class GmailNativeLoopback:GmailLoopback {
    private var listener:NWListener?,connection:NWConnection?,port:Int?,buffer=Data(),result:Result<URL,Error>?
    private var starting:CheckedContinuation<Int,Error>?,waiting:CheckedContinuation<URL,Error>?,timeout:Task<Void,Never>?
    private let queue=DispatchQueue(label:"Noiee.GoogleLoopback")
    func start()async throws->Int {
        guard listener==nil,result==nil else {throw GmailError.busy}
        let parameters=NWParameters.tcp;parameters.requiredLocalEndpoint = .hostPort(host:"127.0.0.1",port:.any)
        parameters.allowLocalEndpointReuse=false
        do {listener=try NWListener(using:parameters)} catch {throw GmailError.listener}
        guard let listener else {throw GmailError.listener}
        listener.stateUpdateHandler={ [weak self] state in Task { @MainActor in
            guard let self else {return}
            if case .ready=state,let p=self.listener?.port?.rawValue,p>=1024 {self.port=Int(p);let c=self.starting;self.starting=nil;c?.resume(returning:Int(p))}
            if case .failed=state {self.finish(.failure(GmailError.listener))}
        }}
        listener.newConnectionHandler={ [weak self] connection in Task { @MainActor in self?.accept(connection) }}
        timeout=Task { [weak self] in do {try await Task.sleep(nanoseconds:300_000_000_000);self?.finish(.failure(GmailError.expired))} catch {}}
        return try await withTaskCancellationHandler(operation:{try await withCheckedThrowingContinuation {starting=$0;listener.start(queue:queue)}},onCancel:{Task { @MainActor in self.cancel() }})
    }
    func callback()async throws->URL {
        if let result {return try result.get()};guard port != nil,waiting==nil else {throw GmailError.listener}
        return try await withTaskCancellationHandler(operation:{try await withCheckedThrowingContinuation {waiting=$0}},onCancel:{Task { @MainActor in self.cancel() }})
    }
    private func accept(_ incoming:NWConnection) {
        guard result==nil,connection==nil,port != nil else {incoming.cancel();return}
        connection=incoming;incoming.start(queue:queue);receive(incoming)
    }
    private func receive(_ incoming:NWConnection) {
        incoming.receive(minimumIncompleteLength:1,maximumLength:8193) { [weak self] data,_,complete,error in Task { @MainActor in
            guard let self,self.result==nil,self.connection===incoming else {return}
            if let data {self.buffer.append(data)}
            guard error==nil,self.buffer.count<=8192 else {self.finish(.failure(GmailError.callback));return}
            if self.buffer.range(of:Data("\r\n\r\n".utf8)) != nil {
                let parsed=Result {try GmailLoopbackParser.parse(self.buffer,port:self.port!)}
                // Never echo callback/code/state or provider error content.
                let body="Return to Noiee to finish reviewing this connection."
                let reply="HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Security-Policy: default-src 'none'\r\n\r\n"+body
                incoming.send(content:Data(reply.utf8),completion:.contentProcessed { [weak self] _ in Task { @MainActor in self?.finish(parsed) }})
            } else if complete {self.finish(.failure(GmailError.callback))} else {self.receive(incoming)}
        }}
    }
    private func finish(_ value:Result<URL,Error>) {
        guard result==nil else {return};result=value;listener?.cancel();connection?.cancel();listener=nil;connection=nil;buffer=Data();timeout?.cancel();timeout=nil
        let begin=starting;starting=nil;begin?.resume(throwing:GmailError.listener)
        let callback=waiting;waiting=nil;callback?.resume(with:value)
    }
    func cancel(){finish(.failure(GmailError.cancelled))}
}

// Google's RS256 signature and OIDC claims are verified locally against only the
// fixed Google JWKS endpoint. No JWT-selected URL, key or algorithm is trusted.
enum GmailIDToken {
    static func decode(_ text:String,limit:Int)throws->Data {
        guard !text.isEmpty,text.utf8.count<=limit*2,text.utf8.allSatisfy({($0>=65 && $0<=90)||($0>=97 && $0<=122)||($0>=48 && $0<=57)||$0==45||$0==95}) else {throw GmailError.identity}
        var b=text.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/");b+=String(repeating:"=",count:(4-b.count%4)%4)
        guard let d=Data(base64Encoded:b),d.count<=limit,GmailAuthorization.base64(d)==text else {throw GmailError.identity};return d
    }
    private static func der(_ tag:UInt8,_ bytes:Data)->Data {
        var length=bytes.count,encoded=[UInt8]()
        repeat {encoded.insert(UInt8(length&255),at:0);length>>=8} while length>0
        return Data([tag])+(bytes.count<128 ? Data([UInt8(bytes.count)]):Data([0x80|UInt8(encoded.count)])+Data(encoded))+bytes
    }
    static func verify(_ token:GmailSecret,jwks:Data,access:GmailSecret,registration:GmailRegistration,nonce:String,created:Date,now:Date)throws->GmailIdentity {
        let parts=token.nativeValue().split(separator:".",omittingEmptySubsequences:false);guard parts.count==3 else {throw GmailError.identity}
        let header=try GmailJSON.object(decode(String(parts[0]),limit:2048)),claims=try GmailJSON.object(decode(String(parts[1]),limit:16384))
        guard header["alg"] as? String=="RS256",Set(header.keys).isSubset(of:["alg","kid","typ"]),header["typ"]==nil || header["typ"] as? String=="JWT" else {throw GmailError.identity}
        let kid=try GmailJSON.string(header["kid"],max:256),keys=try GmailJSON.object(jwks)
        guard let rows=keys["keys"] as? [[String:Any]],!rows.isEmpty,rows.count<=10 else {throw GmailError.identity}
        let matches=rows.filter {$0["kid"] as? String==kid};guard matches.count==1 else {throw GmailError.identity};let key=matches[0]
        try signature(signingInput:String(parts[0])+"."+String(parts[1]),signature:String(parts[2]),key:key)
        return try claimsIdentity(claims,access:access,registration:registration,nonce:nonce,created:created,now:now)
    }
    static func signature(signingInput:String,signature:String,key:[String:Any])throws {
        guard key["kty"] as? String=="RSA",key["alg"] as? String=="RS256",key["use"] as? String=="sig" else {throw GmailError.identity}
        let n=try decode(GmailJSON.string(key["n"],max:1024),limit:512),e=try decode(GmailJSON.string(key["e"],max:12),limit:8)
        guard n.count>=256,n.count<=512,n.first != 0,e==Data([1,0,1]) else {throw GmailError.identity}
        let modulus=der(2,(n.first!&0x80==0 ? Data():Data([0]))+n),exponent=der(2,e),publicData=der(0x30,modulus+exponent)
        let attrs:[CFString:Any]=[kSecAttrKeyType:kSecAttrKeyTypeRSA,kSecAttrKeyClass:kSecAttrKeyClassPublic,kSecAttrKeySizeInBits:n.count*8]
        guard let publicKey=SecKeyCreateWithData(publicData as CFData,attrs as CFDictionary,nil),SecKeyVerifySignature(publicKey,.rsaSignatureMessagePKCS1v15SHA256,Data(signingInput.utf8) as CFData,try decode(signature,limit:512) as CFData,nil) else {throw GmailError.identity}
    }
    static func claimsIdentity(_ claims:[String:Any],access:GmailSecret,registration:GmailRegistration,nonce:String,created:Date,now:Date)throws->GmailIdentity {
        guard ["https://accounts.google.com","accounts.google.com"].contains(claims["iss"] as? String ?? ""),claims["aud"] as? String==registration.clientID,claims["azp"]==nil || claims["azp"] as? String==registration.clientID,claims["nonce"] as? String==nonce else {throw GmailError.identity}
        let expiry=try GmailJSON.integer(claims["exp"]),issued=try GmailJSON.integer(claims["iat"])
        guard now.timeIntervalSince1970.isFinite,Double(expiry)>now.timeIntervalSince1970,Double(issued)<=now.timeIntervalSince1970+60,Double(issued)>=created.timeIntervalSince1970-60,expiry>issued,expiry-issued<=7200 else {throw GmailError.identity}
        if let hash=claims["at_hash"] {guard hash as? String==GmailAuthorization.base64(Data(SHA256.hash(data:Data(access.nativeValue().utf8))).prefix(16)) else {throw GmailError.identity}}
        return try GmailJSON.identity(claims)
    }
}
