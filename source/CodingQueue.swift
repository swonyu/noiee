import Foundation

// The page supplies intent. Only this native prepare/review/commit path can
// transfer a follow-up to the backend; backend tokens are never page inputs.
enum CodingQueuePolicy {
 struct Failure:LocalizedError {var errorDescription:String?{"Follow-up preparation changed or was stopped. Your draft is kept; inspect the saved queue before trying again."}}
 static func input(_ value:[String:Any]) throws -> [String:Any] {
  do {
   guard let action=value["action"] as? String else{throw Failure()}
   let fields:[String:Set<String>]=["inspect":["threadId"],"read":["threadId","id"],"enqueue":["threadId","id","text","attachments","effort"],"resume":["threadId","revision"],"verify":["threadId","id","revision"],"pause":["threadId"],"edit":["threadId","id","revision","text","effort"],"remove":["threadId","id","revision"],"reorder":["threadId","revision","ids"]]
   guard let keys=fields[action] else{throw Failure()}
   let modeKeys:Set<String>=["enqueue","edit"].contains(action) && value["mode"] != nil ? ["mode"]:[]
   try CodingMCPSetupPolicy.exact(value,keys.union(["action"]).union(modeKeys))
   _ = try CodingMCPSetupPolicy.identifier(value["threadId"],limit:160)
   if let id=value["id"] {let text=try CodingMCPSetupPolicy.uuid(id);guard text==text.lowercased() else{throw Failure()}}
   if let revision=value["revision"] {guard try CodingMCPSetupPolicy.integer(revision)>0 else{throw Failure()}}
   if ["enqueue","edit"].contains(action) {
    if value["mode"] != nil {guard ["build","plan"].contains(value["mode"] as? String ?? "") else{throw Failure()}}
    guard let text=value["text"] as? String,text.utf16.count<=20000,!text.contains("\0"),["none","high"].contains(value["effort"] as? String ?? "") else{throw Failure()}
    if action=="enqueue" {guard let files=value["attachments"] as? [[String:Any]],files.count<=4,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !files.isEmpty else{throw Failure()}}
   }
   if action=="reorder" {guard let ids=value["ids"] as? [String],ids.count<=128,Set(ids).count==ids.count else{throw Failure()};for id in ids{guard try CodingMCPSetupPolicy.uuid(id)==id.lowercased() else{throw Failure()}}}
   let bytes=try JSONSerialization.data(withJSONObject:value,options:[.withoutEscapingSlashes])
   guard bytes.count<=(action=="enqueue" ? 4*1024*1024:80000) else{throw Failure()}
   return try JSONSerialization.jsonObject(with:bytes) as! [String:Any]
  }catch{throw Failure()}
 }
 static func control(_ input:[String:Any]) -> Bool {guard ["inspect","read","pause"].contains(input["action"] as? String ?? "") else{return false};return (try? self.input(input)) != nil}
 static func project(_ prepared:[String:Any],root:String) throws -> (String,CodingProjectGrant.Scope,String) {
  do {
   try CodingMCPSetupPolicy.exact(prepared,["token","binding"]);let token=try CodingMCPSetupPolicy.uuid(prepared["token"])
   guard token==token.lowercased(),let binding=prepared["binding"] as? [String:Any] else{throw Failure()}
   try CodingMCPSetupPolicy.exact(binding,["version","ownerId","home","rootThreadId","cwd","projectIdentity","provider","model","executionMode"])
   guard try CodingMCPSetupPolicy.integer(binding["version"])==1,binding["rootThreadId"] as? String==root else{throw Failure()}
   let owner=try CodingMCPSetupPolicy.uuid(binding["ownerId"]);guard owner==owner.lowercased() else{throw Failure()}
   for key in ["home","projectIdentity"] {
    guard let identity=binding[key] as? [String:String],Set(identity.keys)==["volumeUUID","ino"],let volume=identity["volumeUUID"],UUID(uuidString:volume) != nil,volume==volume.uppercased(),volume != "00000000-0000-0000-0000-000000000000",let ino=identity["ino"],ino.range(of:"^[1-9][0-9]{0,19}$",options:.regularExpression) != nil else{throw Failure()}
   }
   let cwd=try CodingMCPSetupPolicy.path(binding["cwd"]),model=try CodingMCPSetupPolicy.text(binding["model"],limit:200)
   guard let provider=binding["provider"] as? String,let mode=binding["executionMode"] as? String else{throw Failure()}
   let scope=try CodingProjectGrant.scope(provider:provider,cwd:cwd,executionMode:mode);guard scope.folder==cwd else{throw Failure()}
   return (token,scope,model)
  }catch{throw Failure()}
 }
}

@MainActor final class CodingQueueSession {
 struct Operation {let input:[String:Any],action:String,threadId:String,epoch:UUID,token:UUID?}
 private var epoch=UUID(),pending=[String:UUID]()
 func invalidate(_ root:String?=nil) {if let root{pending[root]=nil}else{epoch=UUID();pending=[:]}}
 func begin(_ value:[String:Any]) throws -> Operation {
  let input=try CodingQueuePolicy.input(value),action=input["action"] as! String,root=input["threadId"] as! String
  if action=="pause" {invalidate(root)}
  let id:UUID? = ["enqueue","resume","verify"].contains(action) ? UUID():nil
  if let id {guard pending[root]==nil else{throw CodingQueuePolicy.Failure()};pending[root]=id}
  return Operation(input:input,action:action,threadId:root,epoch:epoch,token:id)
 }
 func check(_ op:Operation) throws {guard op.epoch==epoch,!Task.isCancelled,op.token==nil || pending[op.threadId]==op.token else{throw CodingQueuePolicy.Failure()}}
 func finish(_ op:Operation) {if let token=op.token,pending[op.threadId]==token{pending[op.threadId]=nil}}
 func perform(_ op:Operation,check outer:() throws -> Void,request:([String:Any]) async throws -> [String:Any],grant:(CodingProjectGrant.Scope,String) async throws -> Bool) async throws -> [String:Any] {
  func current() throws {try check(op);try outer()};defer{finish(op)}
  try current();guard ["enqueue","resume","verify"].contains(op.action) else{return try await request(op.input)}
  var token:String?
  do {
   var input=op.input;input["action"]=["enqueue":"prepare","resume":"prepareResume","verify":"prepareVerify"][op.action]!
   let prepared=try await request(input)
   // Retain the returned token even when Stop arrived during preparation, so
   // cancellation can close exactly that unaccepted backend preparation.
   token=try? CodingMCPSetupPolicy.uuid(prepared["token"]);try current()
   let (id,scope,model)=try CodingQueuePolicy.project(prepared,root:op.threadId);token=id
   let accepted=try await grant(scope,model);try current()
   guard accepted else{_ = try await request(["action":"cancel","token":id]);return ["cancelled":true]}
   let result=try await request(["action":"commit","token":id]);token=nil
   guard result["accepted"] as? Bool==true,op.action=="resume" || (result["item"] as? [String:Any])?["id"] as? String==op.input["id"] as? String else{throw CodingQueuePolicy.Failure()}
   return result
  }catch{if let token{_ = try? await request(["action":"cancel","token":token])};throw error}
 }
}
