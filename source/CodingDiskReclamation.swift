import Foundation
import CoreFoundation

// Native-only review. The page selects a chat or exact failed owner/generation,
// never a disk path, a physical-closure claim, or a supplied proof.
@MainActor enum CodingDiskReclamation {
    struct Failure: LocalizedError { var errorDescription: String? { "Storage review changed, expired or is unavailable. No automatic retry was made; inspect retained storage." } }
    struct UnconfirmedRelease: LocalizedError {
        let diagnostic:String
        var errorDescription:String? { "The reservation release outcome is unconfirmed; the reservation may already be released. Inspect the exact durable evidence before any further action. Do not retry this release. Diagnostic: \(diagnostic)" }
    }
    struct Confirmation { let title:String; let detail:String; let button:String }
    static func keys(_ value: [String:Any], _ names: [String]) -> Bool { Set(value.keys) == Set(names) }
    static func uuid(_ value: Any?, upper: Bool = false) -> String? {
        guard let s=value as? String, let id=UUID(uuidString:s), s == (upper ? id.uuidString : id.uuidString.lowercased()) else{return nil};return s
    }
    static func path(_ value:Any?) -> String? {
        guard let s=value as? String,s.hasPrefix("/"),s != "/",s.utf8.count<=4096,!s.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}),URL(fileURLWithPath:s).standardizedFileURL.path==s else{return nil};return s
    }
    static func decimal(_ value:Any?) -> String? {
        guard let s=value as? String,let n=UInt64(s),String(n)==s else{return nil};return s
    }
    static func filesystem(_ value:[String:Any]) -> Bool {
        keys(value,["volumeUUID","ino"]) && uuid(value["volumeUUID"],upper:true) != nil && value["volumeUUID"] as? String != "00000000-0000-0000-0000-000000000000" && decimal(value["ino"]) != nil && value["ino"] as? String != "0"
    }
    static func same(_ a:[String:Any],_ b:[String:Any]) throws -> Bool {
        try JSONSerialization.data(withJSONObject:a,options:.sortedKeys)==JSONSerialization.data(withJSONObject:b,options:.sortedKeys)
    }
    static func emptyReview(_ value:[String:Any]) throws -> String {
        guard keys(value,["id","kind","ownerId","generation","cwd","logicalBytes","expiresAt","snapshot"]),value["kind"] as? String=="empty-allocation",
              let id=uuid(value["id"]),let owner=uuid(value["ownerId"]),let generation=uuid(value["generation"]),let cwd=path(value["cwd"]),let logical=decimal(value["logicalBytes"]),logical != "0",
              let expires=value["expiresAt"] as? NSNumber,CFGetTypeID(expires) != CFBooleanGetTypeID(),expires.doubleValue.isFinite,expires.doubleValue.rounded()==expires.doubleValue,expires.doubleValue>Date().timeIntervalSince1970*1000,
              let snapshot=value["snapshot"] as? [String:Any],keys(snapshot,["basis","request"]),let basis=snapshot["basis"] as? [String:Any],
              keys(basis,["kind","catalog","runtime","allocationIdentity","rootIdentity","receiptsIdentity","ownerId","generation","proofs"]),basis["kind"] as? String=="empty-allocation",basis["ownerId"] as? String==owner,basis["generation"] as? String==generation,
              let request=snapshot["request"] as? [String:Any],keys(request,["version","ownerId","generation","allocation","allocationIdentity","rootIdentity","receiptsIdentity","allocationFile"]),
              let version=request["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,request["ownerId"] as? String==owner,request["generation"] as? String==generation,
              let allocation=path(request["allocation"]),let runtime=basis["runtime"] as? [String:Any],let runtimePath=path(runtime["path"]),allocation==runtimePath+"/\(owner)-\(generation)",
              let basisRoot=basis["rootIdentity"] as? [String:Any] else{throw Failure()}
        let stable=basisRoot["volumeUUID"] != nil
        for key in ["catalog","runtime"] {
            guard let v=basis[key] as? [String:Any],keys(v,["path","identity"]),path(v["path"]) != nil,let identity=v["identity"] as? [String:Any],(stable ? filesystem(identity) : keys(identity,["dev","ino"]) && identity.values.allSatisfy({decimal($0) != nil})) else{throw Failure()}
        }
        for key in ["allocationIdentity","rootIdentity","receiptsIdentity"] {
            guard let durable=basis[key] as? [String:Any],keys(durable,stable ? ["volumeUUID","ino","mode","uid"] : ["dev","ino","mode","uid"]),
                  (stable ? filesystem(durable.filter{$0.key=="volumeUUID" || $0.key=="ino"}) : decimal(durable["dev"]) != nil && decimal(durable["ino"]) != nil),
                  let mode=durable["mode"] as? NSNumber,CFGetTypeID(mode) != CFBooleanGetTypeID(),mode.doubleValue==16832,let uid=durable["uid"] as? NSNumber,CFGetTypeID(uid) != CFBooleanGetTypeID(),uid.doubleValue==Double(getuid()),
                  let raw=request[key] as? [String:Any],keys(raw,["dev","ino","mode","uid"]),decimal(raw["dev"]) != nil,decimal(raw["ino"]) != nil,
                  try same(raw.filter{stable ? $0.key != "dev" : true},durable.filter{stable ? $0.key != "volumeUUID" : true}) else{throw Failure()}
        }
        guard let proofs=basis["proofs"] as? [String:Any],keys(proofs,["allocation"]),let proof=proofs["allocation"] as? [String:Any],keys(proof,["sha256","identity"]),
              let hash=proof["sha256"] as? String,hash.utf8.count==64,hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,
              let identity=proof["identity"] as? [String:Any],(stable ? filesystem(identity) : keys(identity,["dev","ino"]) && identity.values.allSatisfy({decimal($0) != nil})),
              let file=request["allocationFile"] as? [String:Any],keys(file,["sha256","stamp"]),file["sha256"] as? String==hash,let stamp=file["stamp"] as? [String:Any],
              keys(stamp,[stable ? "volumeUUID":"dev","ino","size","mode","uid","nlink","mtime","ctime"]),stamp.filter({$0.key != "volumeUUID"}).values.allSatisfy({decimal($0) != nil}),
              try same(identity,stamp.filter{[stable ? "volumeUUID":"dev","ino"].contains($0.key)}),
              let size=UInt64(stamp["size"] as? String ?? ""),size>0,size<=1048576,stamp["mode"] as? String=="33152",stamp["uid"] as? String==String(getuid()),stamp["nlink"] as? String=="1" else{throw Failure()}
        return "Project: \(cwd)\nOwner: \(owner)\nGeneration: \(generation)\nUnused reservation: \(logical) bytes\nReview: \(id)\n\nNo files are deleted. The failed workspace remains unavailable for running tasks. Saved chats, original records and host project files are retained.\n\nThis releases only the unused reservation after another inspection confirms the allocation is empty and closed. It does not free a guest disk or enable reuse of this failed workspace. Stop cannot undo a committed release. After release is sent, Stop or a lost reply can leave its outcome unconfirmed; inspect storage before any further action."
    }
    static func confirmation(_ value:[String:Any]) throws -> Confirmation {
        let detail=try review(value)
        return value["kind"] as? String=="empty-allocation" ? Confirmation(title:"Release unused reservation?",detail:detail,button:"Release unused reservation") : Confirmation(title:"Discard this exact guest disk?",detail:detail,button:"Discard guest disk")
    }
    static func review(_ value:[String:Any]) throws -> String {
        if value["kind"] as? String=="empty-allocation" || ((value["snapshot"] as? [String:Any])?["basis"] as? [String:Any])?["kind"] as? String=="empty-allocation" {return try emptyReview(value)}
        let failed = ((value["snapshot"] as? [String:Any])?["basis"] as? [String:Any])?["kind"] as? String == "failed-provisioning"
        guard keys(value,["id","ownerId","generation","guestId","cwd","logicalBytes","allocatedBytes","expiresAt","snapshot"]),
              let id=uuid(value["id"]),let owner=uuid(value["ownerId"]),let generation=uuid(value["generation"]),let guest=uuid(value["guestId"],upper:true),
              let cwd=path(value["cwd"]),let logical=decimal(value["logicalBytes"]),logical != "0",let allocated=decimal(value["allocatedBytes"]),
              let expires=value["expiresAt"] as? NSNumber,CFGetTypeID(expires) != CFBooleanGetTypeID(),expires.doubleValue.rounded()==expires.doubleValue,expires.doubleValue>Date().timeIntervalSince1970*1000,
              let snapshot=value["snapshot"] as? [String:Any],keys(snapshot,["basis","request"]),let basis=snapshot["basis"] as? [String:Any],
              keys(basis,["catalog","runtime","allocationIdentity","rootIdentity","receiptsIdentity","ownerId","generation","guestId","epoch","proofs"] + (failed ? ["kind","failed"] : [])),
              basis["ownerId"] as? String==owner,basis["generation"] as? String==generation,basis["guestId"] as? String==guest,let epoch=uuid(basis["epoch"],upper:true),
              let request=snapshot["request"] as? [String:Any],keys(request,["version","ownerId","generation","guestId","epoch","root","rootIdentity","disk"]),
              let version=request["version"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,request["ownerId"] as? String==owner,request["generation"] as? String==generation,request["guestId"] as? String==guest,request["epoch"] as? String==epoch,
              let root=path(request["root"]),root.hasSuffix("/\(owner)-\(generation)/guest"),
              let disk=request["disk"] as? [String:Any],keys(disk,["dev","ino","size","mode","uid","nlink","mtime","ctime","blocks"]),disk.values.allSatisfy({decimal($0) != nil}),
              disk["size"] as? String==logical,disk["mode"] as? String=="33152",disk["nlink"] as? String=="1",disk["uid"] as? String==String(getuid()),let blocks=UInt64(disk["blocks"] as? String ?? ""),blocks<=UInt64.max/512,String(blocks*512)==allocated,
              let rootID=request["rootIdentity"] as? [String:Any],let basisRoot=basis["rootIdentity"] as? [String:Any],keys(rootID,["dev","ino","mode","uid"]),decimal(rootID["dev"]) != nil,decimal(rootID["ino"]) != nil else{throw Failure()}
        let stable=basisRoot["volumeUUID"] != nil
        if stable {
            for key in ["ino","mode","uid"] {guard let a=rootID[key],let b=basisRoot[key],try same([key:a],[key:b]) else{throw Failure()}}
        } else if try !same(rootID,basisRoot) {throw Failure()}
        for key in ["catalog","runtime"] {
            guard let v=basis[key] as? [String:Any],keys(v,["path","identity"]),path(v["path"]) != nil,let identity=v["identity"] as? [String:Any],(stable ? filesystem(identity) : keys(identity,["dev","ino"]) && identity.values.allSatisfy({decimal($0) != nil})) else{throw Failure()}
        }
        for key in ["allocationIdentity","rootIdentity","receiptsIdentity"] {
            guard let v=basis[key] as? [String:Any],keys(v,stable ? ["volumeUUID","ino","mode","uid"] : ["dev","ino","mode","uid"]),
                  (stable ? filesystem(v.filter{$0.key=="volumeUUID" || $0.key=="ino"}) : decimal(v["dev"]) != nil && decimal(v["ino"]) != nil),
                  let mode=v["mode"] as? NSNumber,CFGetTypeID(mode) != CFBooleanGetTypeID(),mode.doubleValue==16832,let uid=v["uid"] as? NSNumber,CFGetTypeID(uid) != CFBooleanGetTypeID(),uid.doubleValue==Double(getuid()) else{throw Failure()}
        }
        guard let proofs=basis["proofs"] as? [String:Any],keys(proofs,failed ? ["allocation","installation","installationClaim","installationTerminal","provisioning","claim","terminal"] : ["allocation","retirement","claim","terminal"]) else{throw Failure()}
        for v in proofs.values {
            guard let p=v as? [String:Any],keys(p,["sha256","identity"]),let hash=p["sha256"] as? String,hash.utf8.count==64,hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,
                  let identity=p["identity"] as? [String:Any],(stable ? filesystem(identity) : keys(identity,["dev","ino"]) && identity.values.allSatisfy({decimal($0) != nil})) else{throw Failure()}
        }
        if failed {
            guard let proof=basis["failed"] as? [String:Any],keys(proof,["parent","processes","files","auxiliary","namespace"]),let processes=proof["processes"] as? [[String:Any]],processes.count==2,let parent=proof["parent"] as? [String:Any],let files=proof["files"] as? [String:Any],files.count<=24,let namespace=proof["namespace"] as? [String],namespace.count<=28,proof["auxiliary"] is [String:String] else{throw Failure()}
            _ = try HandoffProcess.receipt(JSONSerialization.data(withJSONObject:parent),owner:true)
            for process in processes {let checked=try HandoffProcess.receipt(JSONSerialization.data(withJSONObject:process));guard checked["nonce"] as? String==generation else{throw Failure()}}
        }
        let outcome = failed ? "This startup failed during guest provisioning and never acquired a chat root. Its original failure records remain, execution stays unrevoked, and this owner/project remains fenced. This is not successful retirement or permission to reuse the guest." : "This guest completed successful execution retirement and remains spent; it will never be reused."
        return "Project: \(cwd)\nOwner: \(owner)\nGeneration: \(generation)\nGuest: \(guest)\nDisk: \(root)/disk.img\nDisk identity: \(disk["dev"]!):\(disk["ino"]!)\nLogical reservation: \(logical) bytes\nAllocated file blocks: \(allocated) bytes\nReview: \(id)\n\n\(outcome)\n\nPermanently discards this exact guest disk, including ANY guest-only or unpublished files. These contents cannot be recovered by this app after deletion. Saved chats, original records and host project files are retained. Physical free space may differ from the reservation released.\n\nContinue only if you no longer need anything remaining inside this exact guest. Stop cannot undo deletion already sent."
    }
    static func perform(_ input:[String:Any],check:() throws -> Void,request:([String:Any]) async throws -> [String:Any],ask:(Confirmation) async throws -> Bool) async throws -> [String:Any] {
        let preparation:[String:Any]
        if keys(input,["ownerId","generation"]),let owner=uuid(input["ownerId"]),let generation=uuid(input["generation"]) {preparation=["action":"prepareFailed","ownerId":owner,"generation":generation]}
        else {guard keys(input,["threadId"]),let thread=input["threadId"] as? String,thread.utf8.count<=160,!thread.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}),thread.range(of:"^[\\w.-]{1,160}$",options:.regularExpression) != nil else{throw Failure()};preparation=["action":"prepare","threadId":thread]}
        try check();let reviewed=try await request(preparation);try check()
        let empty=reviewed["kind"] as? String=="empty-allocation"
        if preparation["action"] as? String == "prepareFailed" {guard ["ownerId","generation"].allSatisfy({reviewed[$0] as? String==input[$0] as? String}),let kind=((reviewed["snapshot"] as? [String:Any])?["basis"] as? [String:Any])?["kind"] as? String,["failed-provisioning","empty-allocation"].contains(kind) else{throw Failure()}}
        else if empty {throw Failure()}
        let dialog=try confirmation(reviewed),id=reviewed["id"] as! String
        var sent=false
        do {
            guard try await ask(dialog) else{_ = try await request(["action":"cancel","id":id]);return ["cancelled":true,"message":empty ? "Reservation retained.":"Guest disk retained."]}
            try check();let current=try await request(["action":"inspect","id":id]);try check();_ = try review(current)
            guard try same(current,reviewed) else{throw Failure()}
            sent=true;let result=try await request(["action":"execute","id":id,"reviewed":reviewed]);try check()
            guard keys(result,["released","ownerId","generation",empty ? "kind":"guestId","releasedBytes","message"]),let released=result["released"] as? NSNumber,CFGetTypeID(released)==CFBooleanGetTypeID(),released.boolValue,
                  ["ownerId","generation",empty ? "kind":"guestId"].allSatisfy({result[$0] as? String==reviewed[$0] as? String}),result["releasedBytes"] as? String==reviewed["logicalBytes"] as? String,result["message"] is String else{throw Failure()}
            return result
        } catch {
            // Cancelling an unconsumed review has no physical effect. A sent
            // execution is never retried or rewritten as confirmed closure.
            if !sent {_ = try? await request(["action":"cancel","id":id])}
            else if empty {throw UnconfirmedRelease(diagnostic:error.localizedDescription)}
            throw error
        }
    }
}
