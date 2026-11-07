"""Compile only the actual native failed-startup method with fake dialogs and transports.
No AppKit, app launch, model, original store, filesystem copy or backend invocation.
All compiler outputs and generated files stay below this worktree's .artifacts.
"""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/"source/Tools.swift"
ART=ROOT/".artifacts/compaction/recovery-native"
ART.mkdir(parents=True,exist_ok=True)
text=SOURCE.read_text()
start=text.index("    private func failedStartupRecovery(")
end=text.index("    private func coding(",start)
method=text[start:end]
first=text.index('                    guard Set(body.keys)==["op","input"]',text.index('case "codingRecovery":'))
last=text.index('                case "codingStorage":',first)
bridge=text[first:last]
pre=r'''
import Foundation
import CoreFoundation
import CoreGraphics
enum ComputerError:Error {case message(String)}
enum CodingDiskReclamation {
 static func uuid(_ value:Any?) -> String? {guard let s=value as? String,s.range(of:"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$",options:.regularExpression) != nil else{return nil};return s}
 static func path(_ value:Any?) -> String? {guard let s=value as? String,s.hasPrefix("/"),!s.contains("\0"),!s.contains("/../") else{return nil};return s}
}
final class NSPopUpButton {
 var indexOfSelectedItem=0
 init(frame:NSRect){}
 func addItems(withTitles:[String]){}
}
@MainActor final class Harness {
 let token=UUID(),owner=UUID().uuidString.lowercased(),generation=UUID().uuidString.lowercased(),copyID=UUID().uuidString.lowercased()
 var actions:[String]=[],dialogs:[String]=[],checks=0,answers:[Bool]=[],state:String?=nil,empty=false,invalid=false,revoked=false,revokeAfterList=false,blockPrepare=false
 let source="/generated/failed-project"
 var target:String {FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Qwen Local/Recovered Projects").path+"/"+copyID+"/project"}
 func require(_ expected:UUID)throws {checks+=1;guard expected==token && !revoked else{throw ComputerError.message("Fixture authorization revoked")}}
 func signedRequest(_ operation:String,_ input:[String:Any],timeout:Double) async throws -> [String:Any] {
  guard operation=="codingRecovery",let action=input["action"] as? String else{throw ComputerError.message("Unexpected fixture transport")}
  actions.append(action)
  if action=="list" {
   if revokeAfterList{revoked=true}
   if invalid{return ["unverified":true]}
   let copies:[[String:Any]]=state.map{[["id":copyID,"target":target,"model":"fixture-model","state":$0,"threadId":$0=="opened" ? "saved_thread" as Any:NSNull()]]} ?? []
   return ["candidates":empty ? []:[["ownerId":owner,"generation":generation,"cwd":source,"continuations":copies]]]
  }
  if action=="prepare" {
   if blockPrepare{throw ComputerError.message("Fixture backend refused actual Coding profile")}
   return ["plan":["id":copyID,"operation":"failed-startup-copy","ownerId":owner,"generation":generation,"model":"fixture-model","source":source,"target":target,"head":NSNull(),"indexTree":String(repeating:"a",count:40),"files":3,"bytes":10,"omittedCount":0,"expiresAt":floor(Date().timeIntervalSince1970*1000)+60_000]]
  }
  if action=="cancel"{return ["cancelled":true]}
  throw ComputerError.message("Fixture forbids create/open or real work")
 }
 func approve(_ title:String,detail:String,button:String,expected:UUID,accessory:NSPopUpButton?=nil) async throws -> Bool {try require(expected);dialogs.append(title);return answers.isEmpty ? true:answers.removeFirst()}
 func run(_ model:String?=nil) async throws -> [String:Any] {try await failedStartupRecovery(model:model,expected:token)}
 func bridge(_ input:[String:Any]) async throws -> [String:Any] {
  let body:[String:Any]=["op":"codingRecovery","input":input],expected=token
  var result:[String:Any]=[:]
'''
post=r'''
  return result
 }
}
func expect(_ condition:Bool,_ message:String)throws {if !condition{throw ComputerError.message(message)}}
@main struct Main {
 @MainActor static func main() async throws {
  var passed:[String]=[]
  func record(_ name:String){passed.append(name);print("PASS "+name)}
  do {let f=Harness();f.empty=true;_ = try await f.bridge([:]);try expect(f.actions==["list"],"No-model empty listing must be read-only");record("absent model can list with existing signed authorization checks")}
  do {let f=Harness();let r=try await f.bridge([:]);try expect(f.actions==["list"] && f.dialogs==["Failed task startups"] && f.checks>=4,"No-model review must stop before prepare");try expect((r["message"] as? String)?.contains("choose a local model ready for Coding")==true,"Actionable model guidance");record("no-model selected startup is reviewable with explicit continuation prerequisites")}
  do {let f=Harness();f.state="opened";let r=try await f.bridge([:]);try expect(f.actions==["list"] && r["existingThreadId"] as? String=="saved_thread","Saved continuation should be history-capable");record("existing saved continuation can be shown without inference readiness")}
  for state in ["opening-unknown","copy-needs-inspection","copy-changed"] {
   let f=Harness();f.state=state;let r=try await f.bridge([:]);try expect(f.actions==["list"] && r["thread"]==nil && r["message"] is String,"Uncertain retained output must not restart");record(state+" remains inspectable without replay")
  }
  do {let f=Harness();f.invalid=true;var refused=false;do{_ = try await f.bridge([:])}catch{refused=true};try expect(refused && f.actions==["list"] && f.dialogs.isEmpty,"Unverified list response must refuse");record("malformed backend inventory is still refused before native review")}
  do {let f=Harness();f.revokeAfterList=true;var refused=false;do{_ = try await f.bridge([:])}catch{refused=true};try expect(refused && f.actions==["list"] && f.dialogs.isEmpty,"Revocation must stop review");record("native authorization revocation after list still fences all later steps")}
  do {let f=Harness();f.answers=[false];let r=try await f.bridge([:]);try expect(f.actions==["list"] && r["cancelled"] as? Bool==true,"Cancelled review must not prepare");record("cancelling review leaves all continuations untouched")}
  do {let f=Harness();f.answers=[true,false];_ = try await f.bridge(["model":"fixture-model"]);try expect(f.actions==["list","prepare","cancel"],"Ready model may prepare only after review; declined copy is cancelled");record("eligible continuation requires separate copy approval and preserves cancel")}
  do {let f=Harness();f.blockPrepare=true;var refused=false;do{_ = try await f.bridge(["model":"fixture-model"])}catch{refused=true};try expect(refused && f.actions==["list","prepare"],"Backend actual profile failure must not create");record("backend model/profile refusal cannot reach create or open")}
  do {let f=Harness();f.state="verified-copy";let r=try await f.bridge([:]);try expect(f.actions==["list"] && (r["message"] as? String)?.contains("Retained project copy:")==true,"No-model verified copy remains available");record("verified independent copy remains inspectable without model")}
  do {let f=Harness();f.state="verified-copy";f.answers=[true,false];_ = try await f.bridge(["model":"fixture-model"]);try expect(f.actions==["list"] && f.dialogs==["Failed task startups","Open a new native chat?"],"Opening requires its own user confirmation");record("ready model cannot open a verified copy without separate native approval")}
  for input:[String:Any] in [["model":NSNull()],["model":123],["model":""],["model":"bad\nmodel"],["unknown":true]] {
   let f=Harness();var refused=false;do{_ = try await f.bridge(input)}catch{refused=true};try expect(refused && f.actions.isEmpty,"Malformed input must fail before list")
  }
  record("only absent or valid model input passes the native bridge shape guard")
  print(String(data:try JSONSerialization.data(withJSONObject:["passed":passed.count,"failed":0,"tests":passed,"fakeTransportsOnly":true,"modelCalls":0,"nativeUI":0,"originalStore":0],options:[.sortedKeys]),encoding:.utf8)!)
 }
}
'''
swift=ART/"recovery-fixture.swift"
swift.write_text(pre+bridge+post.replace("  return result\n }\n}","  return result\n }\n"+method+"}",1))
binary=ART/"recovery-fixture"
command=["/usr/bin/xcrun","swiftc","-parse-as-library","-module-cache-path",str(ART/"module-cache"),str(swift),"-o",str(binary)]
built=subprocess.run(command,text=True,capture_output=True)
(ART/"compile.log").write_text(built.stdout+built.stderr)
if built.returncode:
 print(built.stdout+built.stderr)
 raise SystemExit(built.returncode)
result=subprocess.run([str(binary)],text=True,capture_output=True)
(ART/"run.log").write_text(result.stdout+result.stderr)
print(result.stdout+result.stderr)
print(json.dumps({"source":str(SOURCE),"sourceSHA256":hashlib.sha256(SOURCE.read_bytes()).hexdigest(),"fixtureSHA256":hashlib.sha256(swift.read_bytes()).hexdigest(),"compileExit":built.returncode,"runExit":result.returncode}))
raise SystemExit(result.returncode)
