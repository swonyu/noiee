#!/usr/bin/env python3
"""Synthetic native boundary checks; never launches the app or reads user config.

Compiles the actual preparation method with stand-ins for platform responses, and
the actual config/bridge/policy methods with disposable paths and inert boundaries.
Permission and network calls in the full config target trap if unexpectedly reached.
This is not a live AX or ScreenCaptureKit acceptance check.
"""
import pathlib
import base64
import json
import subprocess
import sys
import tempfile

arguments = [value for value in sys.argv[1:] if value not in ["--worktrees-only", "--lifecycle-only", "--quit-only", "--agent-step-only", "--errors-only"]]
evidence_path = None
if "--handoff-evidence" in arguments:
    position = arguments.index("--handoff-evidence")
    evidence_path = pathlib.Path(arguments[position + 1]).resolve()
    del arguments[position:position + 2]
source = pathlib.Path(arguments[0]).resolve() if arguments else pathlib.Path(__file__).resolve().parent

def scoped_stop_source(native_tools):
    begin, end = "// SCOPED STOP ADMISSION BEGIN", "// SCOPED STOP ADMISSION END"
    if begin not in native_tools and end not in native_tools:
        return ""
    assert native_tools.count(begin) == native_tools.count(end) == 1, "Scoped Stop extraction markers changed"
    return native_tools[native_tools.index(begin) + len(begin):native_tools.index(end)].replace("private ", "")


# Worktree/lifecycle fixtures exercise their real bridge and revocation methods,
# not skills inventory. Keep the session generation contract; unexpected reads
# must fail rather than touching a project or silently returning invented data.
skills_stub = r'''
// Unrelated queue traffic is forbidden in these bounded worktree fixtures.
enum CodingQueuePolicy {struct Failure:LocalizedError {var errorDescription:String?{"Unexpected queue traffic"}};static func control(_ input:[String:Any])->Bool{preconditionFailure("Unexpected queue traffic")}}
@MainActor final class CodingQueueSession {struct Operation{};func begin(_ input:[String:Any])throws->Operation{preconditionFailure("Unexpected queue traffic")};func finish(_ op:Operation){preconditionFailure("Unexpected queue traffic")};func invalidate(){}}
@MainActor final class CodingSkillsSession {
 var token=UUID(),invalidations=0
 func invalidate(){token=UUID();invalidations+=1}
 func perform(_ input:[String:Any],expected:UUID,read:(String) async throws -> [String:Any]) async throws -> [String:Any] {
  preconditionFailure("Unrelated skill inventory must not run in this fixture")
 }
}
@MainActor final class CodingFilePreviewSession {
 var token=UUID()
 func invalidate(){token=UUID()}
 func begin()->UUID {invalidate();return token}
}
'''

lifecycle_fixture = r'''
import AppKit
// POLICIES
// SKILLS_STUB
@MainActor final class FixtureComputer { var stops=0; func stop(){stops+=1} }
@MainActor final class FixtureRevocation { func invalidate() {} }
@MainActor final class FixtureWeb { var stopped=false;var toolsStopped=false;var scripts=[String]();func evaluateJavaScript(_ script:String,completionHandler:Any?){scripts.append(script);stopped = stopped || script.contains("agent-stopped");toolsStopped = toolsStopped || script.contains("tools-stopped")} }
@MainActor final class FixtureParent { var ended=false;func endSheet(_ window:FixtureWindow,returnCode:NSApplication.ModalResponse){ended=true} }
@MainActor final class FixtureWindow { let sheetParent:FixtureParent?=FixtureParent() }
@MainActor final class FixtureAlert { let window=FixtureWindow() }
enum ComputerError: Error { case message(String) }
@MainActor final class FixtureTools {
 var recoveryStartup=false,worktreeBusy=false,scheduleBusy=false,gitBusy=false
 // SCOPED_STOP
 let computer:FixtureComputer;var epoch=UUID();var worktreeEpoch=UUID();var scheduleEpoch=UUID();var gitEpoch=UUID();var gitRequest:String?;var routineReads=["fixture":true];var codingGrants:Set<String>=["fixture"];var codingTerminals=["fixture":"/tmp"];var webView:FixtureWeb?=FixtureWeb();var alert:FixtureAlert?=FixtureAlert()
 let codingQueue=CodingQueueSession();var queueAlertRoot:String?
 var codingInteractive=CodingTerminalGrants()
 let codingSkills=CodingSkillsSession()
 let codingFilePreview=CodingFilePreviewSession()
 var codingAnswer:Task<Void,Never>?
 var agentStepTask:Task<[String:Any],Error>?,agentStepSettlementError:String?
 let provisioning=FixtureRevocation()
 let codingSetup=CodingMCPSetupSession();var providerBinding:(threadId:String,token:UUID)?;var providerBindingAlert:UUID?;var setupAlertID:String?
 init(_ computer:FixtureComputer){self.computer=computer}
 var response:[String:Any]=["stopped":true,"message":"Selected work stopped."]
 var failRequest=false,holdRequest=false;var pending:CheckedContinuation<Void,Never>?
 var operations=[String](),requests=[[String:Any]]();func request(_ op:String,_ input:[String:Any]) async throws -> [String:Any] { operations.append(op);requests.append(input);if holdRequest{await withCheckedContinuation{pending=$0}};if failRequest{throw ComputerError.message("Injected request failure")};return response }
 // STOP_METHODS
}
final class FixtureProcess { var terminationHandler:((Int)->Void)? }
@MainActor final class FixtureOwner {
 let computer=FixtureComputer();lazy var tools=FixtureTools(computer)
 func terminate(){let process=FixtureProcess();
 // TERMINATION_HANDLER
 process.terminationHandler?(0)
 }
}
@main struct Check {
 @MainActor static func armSetup(_ tools:FixtureTools) async -> (String,[CodingMCPSetupSession.Operation]) {
  let input:[String:Any]=["action":"prepareStart","cwd":"/fixture","provider":"local","model":"fixture","serverIds":["fixture"],"executionMode":"native"]
  let id=UUID().uuidString.lowercased(),prepare=try! tools.codingSetup.begin(input)
  var selection=input;selection.removeValue(forKey:"action")
  let status:[String:Any]=["setupId":id,"revision":0,"expiresAt":Date().timeIntervalSince1970.rounded(.down)*1000+60000,"phase":"preparing","request":selection,"creation":"not-started","root":NSNull(),"cleanup":"not-requested","error":NSNull(),"review":NSNull()]
  _ = try! await tools.codingSetup.perform(prepare,check:{},request:{_ in status},ask:{_,_ in preconditionFailure("Lifecycle fixture must not request setup approval")})
  let review=try! tools.codingSetup.begin(["action":"reviewStart","setupId":id,"revision":0])
  let pending=try! tools.codingSetup.begin(input)
  tools.setupAlertID=id
  return (id,[pending,review])
 }
 @MainActor static func expectSetupRevoked(_ tools:FixtureTools,_ armed:(String,[CodingMCPSetupSession.Operation]),_ label:String) async -> [String] {
  var failures=[String](),requests=0,reviews=0
  if tools.setupAlertID != nil {failures.append("\(label) retained setup approval identity")}
  do{_ = try tools.codingSetup.begin(["action":"reviewStart","setupId":armed.0,"revision":0]);failures.append("\(label) retained registered setup authority")}catch{}
  for operation in armed.1 {
   do{
    _ = try await tools.codingSetup.perform(operation,check:{},request:{_ in requests+=1;throw ComputerError.message("Unexpected setup request")},ask:{_,_ in reviews+=1;return true})
    failures.append("\(label) accepted a revoked setup operation")
   }catch{}
  }
  if requests != 0 || reviews != 0 {failures.append("\(label) dispatched setup work after revocation")}
  return failures
 }
  @MainActor static func setupModeChecks() async -> [String] {
   var failures=[String]()
   let folder=URL(fileURLWithPath:CommandLine.arguments[1]).deletingLastPathComponent().appendingPathComponent("mcp-setup-project",isDirectory:true)
   do {try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:false)} catch {return ["Cannot create disposable MCP project"]}
   guard let resolved=realpath(folder.path,nil) else{return ["Cannot canonicalize disposable MCP project"]}
   let cwd=String(cString:resolved);free(resolved)
   let grantFolder=URL(fileURLWithPath:cwd).resolvingSymlinksInPath().standardizedFileURL.path
   for requested:String? in [nil,"vm","native"] {
    let mode=requested ?? "vm",id=UUID().uuidString.lowercased(),session=CodingMCPSetupSession()
    var input:[String:Any]=["action":"prepareStart","cwd":cwd,"provider":"local","model":"fixture","serverIds":["fixture"]]
    if let requested {input["executionMode"]=requested}
    var selection=input;selection.removeValue(forKey:"action")
    let review:[String:Any]=["provider":NSNull(),"servers":[["id":"fixture","configHash":String(repeating:"a",count:64),"transport":"http","url":"http://127.0.0.1:1/mcp","headerKeys":[]]]]
    let prepared:[String:Any]=["setupId":id,"revision":1,"expiresAt":floor(Date().timeIntervalSince1970*1000)+60000,"phase":"prepared","request":selection,"creation":"not-started","root":NSNull(),"cleanup":"not-requested","error":NSNull(),"review":review]
    var thread:[String:Any]=["id":"fixture-root","cwd":cwd,"model":"fixture","modelProvider":"saleh_local","createdAt":10,"updatedAt":11,"name":NSNull(),"historyMode":"legacy"]
    if let requested {thread["executionMode"]=requested}
    var created=prepared;created["revision"]=2;created["expiresAt"]=NSNull();created["phase"]="created";created["creation"]="confirmed";created["root"]=["ownerId":UUID().uuidString.lowercased(),"generation":UUID().uuidString.lowercased(),"thread":thread]
    var commits=0,grants=[String](),asks=0,stage="prepare registration"
    do {
     let op=try session.begin(input)
     _ = try await session.perform(op,check:{},request:{_ in prepared},ask:{_,_ in preconditionFailure("Prepare must not grant project access")})
     stage="prepared review admission"
     let approved=try session.begin(["action":"reviewStart","setupId":id,"revision":1])
     _ = try await session.perform(approved,check:{},request:{ command in
      if command["action"] as? String=="commitStart" {stage="created-root projection";commits+=1;try CodingMCPSetupPolicy.exact(command,["action","setupId","revision","reviewedConfigs"]);return created}
      return prepared
     },ask:{_,display in stage="fresh review admission";asks+=1;if !display.contains(mode=="native" ? "Native macOS":"Virtual machine"){failures.append("MCP review omitted execution mode")};return true},grantProject:{grants.append($0.key)})
     let expected=(mode=="native" ? "native|":"")+"local:"+grantFolder
     if commits != 1 || asks != 1 || grants != [expected] {failures.append("MCP \(mode) review did not grant its exact project mode")}
     do {_ = try session.begin(["action":"reviewStart","setupId":id,"revision":1]);failures.append("Consumed MCP review was reusable")}catch{}
     var wrong=created,root=wrong["root"] as! [String:Any],changedThread=thread;changedThread["executionMode"]=mode=="native" ? "vm":"native";root["thread"]=changedThread;wrong["root"]=root
     do {_ = try CodingMCPSetupPolicy.project(wrong);failures.append("MCP root mode mismatch accepted")}catch{}
     if mode=="native" {changedThread.removeValue(forKey:"executionMode");root["thread"]=changedThread;wrong["root"]=root;do {_ = try CodingMCPSetupPolicy.project(wrong);failures.append("Native root with missing mode accepted")}catch{}}
     stage="changed-mode control registration"
     let altered=CodingMCPSetupSession(),start=try altered.begin(input)
     _ = try await altered.perform(start,check:{},request:{_ in prepared},ask:{_,_ in false})
     let handle=try altered.begin(["action":"reviewStart","setupId":id,"revision":1]);var reads=0
     do {_ = try await altered.perform(handle,check:{},request:{_ in reads+=1;if reads==1{return prepared};var changed=prepared,request=selection;request["executionMode"]=mode=="native" ? "vm":"native";changed["request"]=request;return changed},ask:{_,_ in true},grantProject:{_ in failures.append("Changed MCP mode granted project access")});failures.append("Changed MCP mode passed fresh review fingerprint")}catch{}
     if reads != 2 {failures.append("Changed MCP mode dispatched a commit")}
     stage="substituted-response control registration"
     let substituted=CodingMCPSetupSession(),first=try substituted.begin(input)
     var changed=prepared,request=selection;request["executionMode"]=mode=="native" ? "vm":"native";changed["request"]=request
     do {_ = try await substituted.perform(first,check:{},request:{_ in changed},ask:{_,_ in false});failures.append("Prepare response substituted execution mode")}catch{}
    } catch {failures.append("Valid MCP \(mode) setup failed at \(stage): \(error.localizedDescription)")}
   }
   for invalid:Any in [NSNull(),false,"","other",1] {
    do {_ = try CodingMCPSetupPolicy.input(["action":"prepareStart","cwd":cwd,"provider":"local","model":"fixture","serverIds":["fixture"],"executionMode":invalid]);failures.append("Invalid MCP mode was accepted")}catch{}
   }
   return failures
  }
 @MainActor static func main() async {
 let owner=FixtureOwner(), epoch=owner.tools.epoch, parent=owner.tools.alert!.window.sheetParent!
 let serverSetup=await armSetup(owner.tools)
 owner.terminate();for _ in 0..<20{await Task.yield()}
 var failures=await setupModeChecks()
 failures += await expectSetupRevoked(owner.tools,serverSetup,"Server exit")
 do{try owner.tools.require(epoch);failures.append("Server exit retained a pending tool epoch")}catch{}
 if !owner.tools.routineReads.isEmpty || !owner.tools.codingGrants.isEmpty || !owner.tools.codingTerminals.isEmpty{failures.append("Server exit retained routine or coding grants")}
 if owner.tools.alert != nil || !parent.ended{failures.append("Server exit retained pending approval")}
 if owner.computer.stops != 1 || owner.tools.webView?.stopped != true{failures.append("Server exit did not cancel both controllers")}
 if owner.tools.codingSkills.invalidations != 1{failures.append("Server exit retained the skill session")}
 let navigation=FixtureOwner(), oldEpoch=navigation.tools.epoch
 let navigationSetup=await armSetup(navigation.tools)
 navigation.tools.departPage();for _ in 0..<20{await Task.yield()}
 failures += await expectSetupRevoked(navigation.tools,navigationSetup,"Navigation")
 do{try navigation.tools.require(oldEpoch);failures.append("Navigation retained pending tool epoch")}catch{}
 if navigation.tools.webView?.toolsStopped != true || navigation.tools.webView?.stopped == true { failures.append("Navigation claimed coding interruption") }
 if navigation.tools.operations.last != "depart" || navigation.tools.requests.last?.isEmpty != true { failures.append("Navigation must request the dedicated departure route") }
 if navigation.tools.webView?.scripts.contains(where:{$0.contains("departure:true")}) != true { failures.append("Navigation did not distinguish departure from explicit Stop") }
 if !navigation.tools.routineReads.isEmpty || !navigation.tools.codingGrants.isEmpty || navigation.tools.codingTerminals.isEmpty { failures.append("Navigation did not clear grants while retaining terminal ownership") }
 if navigation.tools.alert != nil || navigation.computer.stops != 1 { failures.append("Navigation retained approval or computer scope") }
 if navigation.tools.codingSkills.invalidations != 1{failures.append("Navigation retained the skill session")}
 if navigation.tools.webView?.scripts.contains(where:{$0.contains("tools-stop-result") && $0.contains("\"stopped\":true")}) != true { failures.append("Confirmed Stop result was not forwarded") }
 let stopped=FixtureOwner(),stopSetup=await armSetup(stopped.tools)
 stopped.tools.stop();for _ in 0..<20{await Task.yield()}
 failures += await expectSetupRevoked(stopped.tools,stopSetup,"Explicit Stop")
 if !stopped.tools.codingTerminals.isEmpty || stopped.tools.webView?.stopped != true || stopped.tools.requests.last?.isEmpty != true || stopped.tools.operations.last != "stop" {failures.append("Explicit Stop did not include coding ownership")}
 if stopped.tools.webView?.scripts.contains(where:{$0.contains("departure:false")}) != true { failures.append("Explicit Stop was mislabeled as departure") }
 let uncertain=FixtureOwner();uncertain.tools.response=["stopped":false,"message":"Process exit is unconfirmed."];uncertain.tools.stopTools();for _ in 0..<20{await Task.yield()}
 if uncertain.tools.webView?.scripts.contains(where:{$0.contains("tools-stop-result") && $0.contains("\"stopped\":false") && $0.contains("unconfirmed")}) != true { failures.append("Unconfirmed Stop result was not forwarded honestly") }
 let invalid=FixtureOwner();invalid.tools.response=["stopped":1,"message":"Unsafe success"];invalid.tools.stopTools();for _ in 0..<20{await Task.yield()}
 if invalid.tools.webView?.scripts.contains(where:{$0.contains("tools-stop-result") && $0.contains("\"stopped\":false")}) != true { failures.append("Nonboolean Stop result was treated as confirmed") }
 for response:[String:Any] in [["stopped":false],["stopped":1],[:]] {
  let owner=FixtureOwner();owner.tools.response=response
  do{try await owner.tools.shutdown();failures.append("Quit accepted an unconfirmed shutdown")}catch{}
 }
 let failed=FixtureOwner();failed.tools.failRequest=true
 do{try await failed.tools.shutdown();failures.append("Quit suppressed a request failure")}catch{}
 let held=FixtureOwner();held.tools.holdRequest=true;var returned=false
 let shutting=Task{try await held.tools.shutdown();returned=true}
 for _ in 0..<20{await Task.yield()};if returned||held.tools.pending==nil{failures.append("Quit did not retain pending request")}
 held.tools.pending?.resume();do{try await shutting.value}catch{failures.append("Confirmed shutdown failed")}
 if !returned{failures.append("Confirmed shutdown did not return")}
 for f in failures{print("FAIL: \(f)")};if !failures.isEmpty{exit(1)}
 print("PASS: MCP native/VM review, project grant and receipt mode binding; server exit and explicit Stop stop all work; navigation preserves coding work; all three revoke pending and registered MCP setup authority before dispatch")
 }
}
'''

quit_fixture = r'''
import Foundation
enum ComputerError: LocalizedError { case message(String);var errorDescription:String? {if case .message(let value)=self{return value};return nil} }
@MainActor final class NSApplication {
 enum TerminateReply { case terminateNow,terminateLater,terminateCancel }
 var replies=[Bool]()
 func reply(toApplicationShouldTerminate value:Bool){replies.append(value)}
}
@MainActor let NSApp=NSApplication()
@MainActor final class QuitTools {
 var requests=0,stops=0,fail=false;var pending:CheckedContinuation<Void,Never>?
 func stop(){stops+=1}
 func shutdown() async throws {requests+=1;await withCheckedContinuation{pending=$0};if fail{throw ComputerError.message("Injected shutdown failure")}}
}
@MainActor final class QuitWeb {
 enum ContentWorld {case page}
 var calls=0,saves=0,restores=0,holdSaves=false
 var pending:CheckedContinuation<Any?,Error>?
 func callAsyncJavaScript(_ script:String,arguments:[String:Any],in frame:Any?,contentWorld:ContentWorld) async throws -> Any? {
  saves+=1;if script.contains("const finishing = true;"){calls+=1}
  if holdSaves {return try await withCheckedThrowingContinuation{pending=$0}}
  return true
 }
 func resolve(_ value:Bool){let current=pending;pending=nil;current?.resume(returning:value)}
 func reject(){let current=pending;pending=nil;current?.resume(throwing:ComputerError.message("Injected draft save failure"))}
 func evaluateJavaScript(_ script:String) async throws -> Any? {
  if script.contains("salehSaveBeforeLeave") {saves+=1;if script.contains("const finishing = true;"){calls+=1};return true}
  if script.contains("delete window.__salehDraftDeparture"){restores+=1}
  return nil
 }
}
@MainActor final class QuitWindow {var raised=0;func makeKeyAndOrderFront(_ sender:Any?){raised+=1}}
final class QuitProcess: @unchecked Sendable {
 enum Reason {case exit,uncaughtSignal}
 let gate=DispatchSemaphore(value:0),entered=DispatchSemaphore(value:0)
 var isRunning=true,terminationStatus:Int32=0,terminationReason=Reason.exit
 func waitUntilExit(){entered.signal();gate.wait()}
 func release(_ status:Int32=0){terminationStatus=status;isRunning=false;gate.signal()}
}
@MainActor final class QuitOwner {
 var server:QuitProcess?=QuitProcess(),terminationPending=false,reloadPending=false,departureGeneration=0
 let startupPageID="fixture-startup"
 let serverInput=Pipe(),tools=QuitTools(),webView=QuitWeb()
 var window:QuitWindow?=QuitWindow(),errors=[String](),inspection=false,inspectionShows=0
 func showShutdownInspection(){inspection=true;inspectionShows+=1}
 func dismissShutdownInspection(){inspection=false}
 func showError(_ error:String){errors.append(error)}
 // QUIT_METHODS
}
@main struct Check {
 @MainActor static func until(_ condition:()->Bool) async {
  for _ in 0..<2000{if condition(){return};try? await Task.sleep(for:.milliseconds(1))}
  preconditionFailure("Quit fixture did not reach checkpoint")
 }
 @MainActor static func main() async throws {
  for stage in [1,2] {for outcome in ["success","false","reject","generation"] {
   NSApp.replies=[];let owner=QuitOwner(),process=owner.server!;owner.webView.holdSaves=true
   _=owner.applicationShouldTerminate(NSApp)
   await until{owner.webView.pending != nil || owner.tools.pending != nil || !NSApp.replies.isEmpty}
   precondition(owner.webView.pending != nil && owner.tools.requests==0 && NSApp.replies.isEmpty,"Quit must await the first durable save before shutdown")
   if stage==2 {
    owner.webView.resolve(true);await until{owner.tools.pending != nil};owner.tools.pending?.resume()
    await until{owner.webView.pending != nil || !NSApp.replies.isEmpty}
    precondition(owner.webView.pending != nil && NSApp.replies.isEmpty,"Quit must await the final durable save before closing server stdin")
   }
   precondition(process.entered.wait(timeout:.now()) == .timedOut,"Pending saves must not wait for or admit server exit")
   try owner.serverInput.fileHandleForWriting.write(contentsOf:Data())
   if outcome=="generation" {owner.departureGeneration+=1}
   if outcome=="reject" {owner.webView.reject()} else {owner.webView.resolve(outcome != "false")}
   if outcome != "success" {
    await until{!NSApp.replies.isEmpty}
    precondition(NSApp.replies==[false] && !owner.terminationPending && owner.webView.restores==1 && owner.errors.count==1,"Failed or stale save must restore the editor and cancel Quit")
    precondition(owner.tools.requests==(stage==1 ? 0:1) && owner.webView.saves==stage)
    try owner.serverInput.fileHandleForWriting.write(contentsOf:Data())
   } else {
    if stage==1 {
     await until{owner.tools.pending != nil};owner.tools.pending?.resume()
     await until{owner.webView.pending != nil};owner.webView.resolve(true)
    }
    await until{process.entered.wait(timeout:.now()) == .success}
    precondition(NSApp.replies.isEmpty && owner.webView.saves==2,"Both resolved flushes still require confirmed server exit")
    process.release();await until{!NSApp.replies.isEmpty};precondition(NSApp.replies==[true])
   }
  }}
  for fail in [false,true] {
   NSApp.replies=[];let owner=QuitOwner(),process=owner.server!;owner.tools.fail=fail
   precondition(owner.applicationShouldTerminate(NSApp) == .terminateLater)
   precondition(owner.applicationShouldTerminate(NSApp) == .terminateLater)
   await until{owner.tools.pending != nil}
   precondition(owner.tools.requests==1 && NSApp.replies.isEmpty && owner.webView.calls==0)
   precondition(owner.webView.saves==1,"Quit must save before requesting shutdown")
   precondition(owner.inspection && owner.inspectionShows==1,"Pending Quit must expose inspection before waiting")
   try owner.serverInput.fileHandleForWriting.write(contentsOf:Data())
   owner.tools.pending?.resume()
   if fail {
    await until{!NSApp.replies.isEmpty}
    precondition(NSApp.replies==[false] && owner.errors==["Injected shutdown failure"] && owner.window?.raised==1)
    precondition(!owner.terminationPending && owner.webView.calls==0 && !owner.inspection)
    precondition(owner.webView.restores==1,"Failed cleanup restores the prior editor state")
    try owner.serverInput.fileHandleForWriting.write(contentsOf:Data())
   } else {
    await until{process.entered.wait(timeout:.now()) == .success}
    precondition(NSApp.replies.isEmpty && owner.webView.calls==1)
    precondition(owner.webView.saves==2,"Quit must re-save before pagehide and server exit")
    do{try owner.serverInput.fileHandleForWriting.write(contentsOf:Data([1]));preconditionFailure("Parent stdin stayed open")}catch{}
    process.release();await until{!NSApp.replies.isEmpty}
    precondition(NSApp.replies==[true] && owner.errors.isEmpty && !owner.inspection)
   }
  }
  NSApp.replies=[];let failed=QuitOwner(),process=failed.server!
  _=failed.applicationShouldTerminate(NSApp);await until{failed.tools.pending != nil};failed.tools.pending?.resume()
  await until{process.entered.wait(timeout:.now()) == .success};process.release(1)
  await until{!NSApp.replies.isEmpty};precondition(NSApp.replies==[false] && failed.errors.count==1)
  NSApp.replies=[];let absent=QuitOwner();absent.server=nil
  precondition(absent.applicationShouldTerminate(NSApp) == .terminateLater)
  await until{!NSApp.replies.isEmpty}
  precondition(NSApp.replies==[true] && absent.tools.stops==1 && absent.webView.saves==2 && absent.webView.calls==1)
  print("PASS: actual native Quit awaits both held saves, rejects failed/stale saves, coalesces requests, retains failed cleanup, waits for server exit and rejects nonzero exit; synthetic platform responses")
 }
}
'''

def quit_source(app):
    helper_start = app.index("    private func departureScript(")
    helper_end = app.index("    @objc private func reload()", helper_start)
    quit_start = app.index("    func applicationShouldTerminate(_ sender:")
    quit_end = app.index("    // DRAFT DEPARTURE END", quit_start)
    return quit_fixture.replace(" // QUIT_METHODS", app[helper_start:helper_end] + app[quit_start:quit_end])


agent_step_fixture = r'''
import Foundation
import CoreFoundation
enum ComputerError: LocalizedError {case message(String);var errorDescription:String? {if case .message(let s)=self{return s};return nil}}
// POLICIES
// AGENT_POLICY
// SKILLS_STUB
final class WKUserContentController {}
struct FixtureOrigin {let `protocol`="http",host="127.0.0.1",port=8787}
struct FixtureFrame {let securityOrigin=FixtureOrigin(),isMainFrame=true}
struct WKScriptMessage {let webView:WKWebView?;let body:Any;let frameInfo=FixtureFrame()}
@MainActor final class WKWebView {var scripts=[String]();func evaluateJavaScript(_ script:String,completionHandler:Any?){scripts.append(script)}}
enum FixtureResponse {case abort}
@MainActor final class FixtureParent {func endSheet(_ window:FixtureWindow,returnCode:FixtureResponse){}}
@MainActor final class FixtureWindow {let sheetParent:FixtureParent?=FixtureParent()}
@MainActor final class FixtureAlert {let window=FixtureWindow()}
@MainActor final class FixtureProvisioning {func invalidate(){};func finishSetup(_ id:String){preconditionFailure("Unexpected setup operation")}}
@MainActor final class Gate {var entered=false;var continuation:CheckedContinuation<Void,Never>?;func wait()async{entered=true;await withCheckedContinuation{continuation=$0}};func release(){let saved=continuation;continuation=nil;saved?.resume()}}
@MainActor final class FixtureComputer {var stops=0;func stop(){stops+=1};func agentTool(_ name:String,arguments:[String:Any],beforeEffect:(()async throws->Void)?=nil)async throws->[String:Any]{preconditionFailure("No computer permissions or effects in this fixture")}}
enum RoutineReadPolicy {static func automaticArguments(_ kind:String,name:String,arguments:[String:Any])->[String:Any]?{arguments}}
@MainActor final class Reply {var called=false,value:[String:Any]?,error:String?}
@MainActor final class Fixture {
 var webView:WKWebView?=WKWebView(),epoch=UUID(),busy=false,alert:FixtureAlert?,authenticate:(()async->Bool)?={true}
 var worktreeEpoch=UUID(),scheduleEpoch=UUID(),gitEpoch=UUID(),gitRequest:String?
 var recoveryStartup=false,worktreeBusy=false,scheduleBusy=false,gitBusy=false
 // SCOPED_STOP
 var codingAnswer:Task<[String:Any],Error>?,agentStepTask:Task<[String:Any],Error>?,agentStepTaskID:UUID?,agentStepSettlementError:String?
 let codingSkills=CodingSkillsSession(),codingFilePreview=CodingFilePreviewSession(),codingSetup=CodingMCPSetupSession(),provisioning=FixtureProvisioning(),computer=FixtureComputer()
 var providerBinding:(threadId:String,token:UUID)?;var providerBindingAlert:UUID?;var setupAlertID:String?,codingGrants=Set<String>(),codingTerminals=[String:String](),codingInteractive=CodingTerminalGrants(),routineReads=[String:(kind:String,hash:String)]()
 let run="11111111-1111-4111-8111-111111111111",step="22222222-2222-4222-8222-222222222222",generation="33333333-3333-4333-8333-333333333333"
 var tool="run_command",arguments:[String:Any]=["command":"printf fixture","cwd":"/fixture"]
 var flow=[String](),effects=[[String:Any]](),claims=[[String:Any]](),outcomes=[[String:Any]](),declines=0,reviews=0
 var approveResult=true,holdReview=false,holdClaim=false,holdEffect=false,holdComplete=false,holdStopForCompletion=false,acceptedClaim=false,claimID:String?,stopping=false
 var malformedInspect=false,wrongClaim=false,lostClaim=false,rejectClaim=false,failComplete=false,badComplete=false
 var effectResult:[String:Any]=["message":"fixture result"]
 let reviewGate=Gate(),claimGate=Gate(),effectGate=Gate(),completeGate=Gate(),stopGate=Gate()
 func inspected()->[String:Any]{["version":1,"runId":run,"stepId":step,"stepDigest":String(repeating:"a",count:64),"generation":generation,"name":tool,"arguments":arguments,"state":"pending"]}
 func snapshot(_ status:String)->[String:Any]{["run":["version":2,"kind":"agent","runId":run,"revision":2,"receipts":[["id":step,"status":status]]],"live":true,"durableRevision":2,"persistence":"saved","saveError":NSNull()]}
 func signedRequest(_ operation:String,_ input:[String:Any])async throws->[String:Any]{
  precondition(operation=="agentStep","Fixture must not send any real request")
  let action=input["action"] as! String;flow.append(action)
  switch action {
  case "inspect":var value=inspected();if malformedInspect{value["arguments"]=["x":String(repeating:"x",count:64001)]};return value
  case "claim":
   claims.append(input);claimID=input["claimId"] as? String
   if rejectClaim{throw ComputerError.message("No claim accepted")}
   acceptedClaim=true;if holdClaim{await claimGate.wait()};if lostClaim{throw ComputerError.message("Claim reply lost")}
   var value=inspected();value["state"]="claimed";value["claimId"]=claimID!;if wrongClaim{value["name"]="wrong"};return value
  case "decline":precondition(!acceptedClaim,"A claimed step cannot be declined");declines+=1;return snapshot("cancelled")
  case "complete":
   precondition(Set(input.keys)==["action","runId","stepId","claimId","outcome"])
   guard acceptedClaim,input["claimId"] as? String==claimID else{throw ComputerError.message("No issued claim")}
   let outcome=input["outcome"] as! [String:Any];outcomes.append(outcome)
   if holdComplete{await completeGate.wait()};if failComplete{throw ComputerError.message("Injected durable save failure")}
   let kind=outcome["kind"] as! String,result=outcome["result"] as? [String:Any] ?? [:]
   let status=kind=="not-started" ? "cancelled":kind=="unconfirmed" ? "unconfirmed":result["cancelled"] as? Bool==true ? "cancelled":result["isError"] as? Bool==true ? "error":"returned"
   var value=snapshot(status);value["completion"]=["runId":run,"stepId":step,"claimId":claimID!,"outcomeKind":kind,"revision":2]
   if badComplete{value["durableRevision"]=1};flow.append("saved");stopGate.release();return value
  default:preconditionFailure("Unexpected Agent request")
  }
 }
 func request(_ operation:String,_ input:[String:Any])async throws->[String:Any]{
  flow.append(operation)
  if operation=="stop" || operation=="depart" {stopping=true;if holdStopForCompletion && acceptedClaim && !flow.contains("saved"){await stopGate.wait()};return ["stopped":true,"message":"Fixture stopped"]}
  if operation=="shutdown" {return ["stopped":true]}
  guard ["command","call","search","catalog"].contains(operation) else{preconditionFailure("Unexpected effect route")}
  if let metadata=input["agentClaim"] as? [String:Any] {precondition(metadata["runId"] as? String==run && metadata["stepId"] as? String==step && metadata["claimId"] as? String==claimID && acceptedClaim)}
  if holdEffect{await effectGate.wait()}
  // Like the real backend, a delayed Agent request checks cancellation at dispatch.
  if input["agentClaim"] != nil && stopping {throw ComputerError.message("Claim stopped before dispatch")}
  effects.append(input);return effectResult
 }
 func approve(_ title:String,detail:String,button:String,expected:UUID,operational:Bool=false)async throws->Bool {try require(expected);reviews+=1;flow.append("review");if holdReview{await reviewGate.wait()};try require(expected);return approveResult}
 func connect(_ id:String,expected:UUID,beforeEffect:(()async throws->Void)?=nil,agentClaim:(()->[String:Any]?)?=nil)async throws->[String:Any]{preconditionFailure("Unrelated connection path")}
 func call(_ name:String,expected:UUID,beforeEffect:(()async throws->Void)?=nil)async throws->[String:Any]{preconditionFailure("No Contacts access in fixture")}
 // STOP_METHODS
 // BRIDGE_METHOD
 // AGENT_METHODS
 func send(_ extra:[String:Any]=[:])->Reply {var body:[String:Any]=["op":"agentStep","runId":run,"stepId":step];for(k,v)in extra{body[k]=v};let reply=Reply();userContentController(WKUserContentController(),didReceive:WKScriptMessage(webView:webView,body:body)){v,e in reply.value=v as? [String:Any];reply.error=e;reply.called=true};return reply}
}
@main struct Check {
 @MainActor static func until(_ predicate:()->Bool)async {for _ in 0..<20000{if predicate(){return};await Task.yield()};fatalError("Bounded fixture wait expired")}
 @MainActor static func main()async {
  var count=0
  func expect(_ condition:Bool,_ message:String){precondition(condition,message);count+=1}
  for extra:[String:Any] in [["arguments":[:]],["claimId":"injected"],["outcome":[:]],["runId":"bad"]] {let f=Fixture(),r=f.send(extra);await until{r.called};expect(r.error != nil && f.flow.isEmpty,"Page selectors accepted injected authority")}
  let normal=Fixture(),nr=normal.send();await until{nr.called};expect(nr.error==nil && normal.flow==["inspect","review","claim","command","complete","saved"] && normal.effects.count==1,"Review/claim/effect/durable acknowledgement order changed")
  let cancel=Fixture();cancel.approveResult=false;let cr=cancel.send();await until{cr.called};expect(cr.error==nil && cancel.declines==1 && cancel.claims.isEmpty && cancel.effects.isEmpty,"User Cancel dispatched or skipped durable decline")
  let review=Fixture();review.holdReview=true;let rr=review.send();await until{review.reviewGate.entered};review.stop();review.reviewGate.release();await until{rr.called};expect(rr.error != nil && review.claims.isEmpty && review.effects.isEmpty && review.declines==0,"Stop during review claimed or declined a departed step")
  let claim=Fixture();claim.holdClaim=true;let qr=claim.send();await until{claim.claimGate.entered};claim.stop();claim.claimGate.release();await until{qr.called};expect(qr.error != nil && claim.effects.isEmpty && claim.outcomes.first?["kind"] as? String=="not-started" && claim.agentStepSettlementError==nil,"Stop after claim did not durably settle without effect")
  for accepted in [false,true] {let f=Fixture();f.rejectClaim = !accepted;f.lostClaim=accepted;let r=f.send();await until{r.called};expect(r.error != nil && f.effects.isEmpty && f.claims.count==1 && (accepted ? f.outcomes.first?["kind"] as? String=="not-started":f.declines==1) && f.agentStepSettlementError==nil,"Lost claim acknowledgement retried or leaked uncertainty")}
  let wrong=Fixture();wrong.wrongClaim=true;let wr=wrong.send();await until{wr.called};expect(wr.error != nil && wrong.effects.isEmpty && wrong.outcomes.first?["kind"] as? String=="not-started","Mismatched claim executed")
  let invalid=Fixture();invalid.malformedInspect=true;let ir=invalid.send();await until{ir.called};expect(ir.error != nil && invalid.claims.isEmpty && invalid.effects.isEmpty,"Oversized pending arguments were accepted")
  let delayed=Fixture();delayed.holdEffect=true;let dr=delayed.send();await until{delayed.effectGate.entered};delayed.stop();await until{delayed.stopping};delayed.effectGate.release();await until{dr.called};expect(dr.error != nil && delayed.effects.isEmpty && delayed.outcomes.first?["kind"] as? String=="unconfirmed","Delayed backend effect escaped Stop fence")
  let departure=Fixture();departure.holdComplete=true;let pr=departure.send();await until{departure.completeGate.entered};departure.departPage();await until{departure.stopping};expect(!pr.called,"Page acknowledged before durable completion");departure.completeGate.release();await until{pr.called};expect(pr.error != nil && departure.effects.count==1 && departure.outcomes.first?["kind"] as? String=="returned" && departure.flow.contains("saved"),"Departure lost an already returned result")
  let quit=Fixture();quit.holdComplete=true;quit.holdStopForCompletion=true;let qu=quit.send();await until{quit.completeGate.entered};var quitDone=false,quitError=false;let task=Task {do{try await quit.shutdown()}catch{quitError=true};quitDone=true};await until{quit.stopping};expect(!quitDone && !quit.flow.contains("shutdown"),"Quit skipped pending native completion");quit.completeGate.release();await task.value;await until{qu.called};expect(quitDone && !quitError && quit.flow.firstIndex(of:"saved")! < quit.flow.firstIndex(of:"shutdown")!,"Quit did not drain before shutdown")
  for corrupt in [false,true] {let f=Fixture();f.failComplete = !corrupt;f.badComplete=corrupt;let r=f.send();await until{r.called};var refused=false;do{try await f.shutdown()}catch{refused=true};expect(r.error != nil && f.agentStepSettlementError != nil && refused && !f.flow.contains("shutdown"),"Unconfirmed result allowed truthful Quit")}
  let large=Fixture();large.effectResult=["message":String(repeating:"x",count:3_900_001)];let lr=large.send();await until{lr.called};expect(lr.error != nil && large.outcomes.first?["kind"] as? String=="unconfirmed" && large.outcomes.first?["result"]==nil && large.agentStepSettlementError==nil,"Large result was silently clipped or not settled")
  let mcp=Fixture();mcp.tool="execute_tool";mcp.arguments=["server":"fixture","name":"read","arguments":["path":"/fixture"]];mcp.routineReads["fixture"]=("fixture","hash");let mr=mcp.send();await until{mr.called};expect(mr.error==nil && mcp.reviews==1 && mcp.effects.count==1 && mcp.effects[0]["readOnlyConfigHash"]==nil && mcp.effects[0]["agentClaim"] != nil,"Agent MCP tool escaped exact review or claim metadata")
  let manual=Fixture();manual.routineReads["fixture"]=("fixture","hash");do{_ = try await manual.execute("execute_tool",arguments:["server":"fixture","name":"read","arguments":["path":"/fixture"]],expected:manual.epoch);expect(manual.reviews==0 && manual.effects.count==1 && manual.effects[0]["readOnlyConfigHash"] as? String=="hash" && manual.effects[0]["agentClaim"]==nil,"Manual routine grant changed")}catch{preconditionFailure("Manual routine path failed")}
  print("PASS: \(count) native Agent bridge checks; inert synthetic transport and reviews, no app/model/permission/store access")
 }
}
'''

worktree_fixture = r'''
import Foundation
import CoreFoundation
enum ComputerError: LocalizedError { case message(String);var errorDescription:String? { if case .message(let value)=self{return value};return nil } }
// POLICIES
// SKILLS_STUB
@MainActor final class NSWorkspace {static let shared=NSWorkspace();var revealed=[URL]();func activateFileViewerSelecting(_ urls:[URL]){revealed += urls}}
@MainActor final class FixtureProvisioning {func finishSetup(_ id:String){preconditionFailure("Unrelated provisioning must not run in a worktree fixture")}}
final class WKWebView {}
final class WKUserContentController {}
struct FixtureOrigin { let `protocol`="http",host="127.0.0.1",port=8787 }
struct FixtureFrame { let securityOrigin=FixtureOrigin(),isMainFrame=true }
struct WKScriptMessage { let webView:WKWebView?;let body:Any;let frameInfo=FixtureFrame() }
enum FixtureResponse { case abort }
@MainActor final class FixtureParent {
 var ended=0;var onEnd:(()->Void)?
 func endSheet(_ window:FixtureWindow,returnCode:FixtureResponse){ended+=1;onEnd?()}
}
@MainActor final class FixtureWindow { let sheetParent:FixtureParent?=FixtureParent() }
@MainActor final class FixtureAlert { let window=FixtureWindow() }
@MainActor final class Gate {
 var entered=false;var continuation:CheckedContinuation<Bool,Never>?
 func wait() async -> Bool {entered=true;return await withCheckedContinuation{continuation=$0}}
 func release(_ value:Bool=true){let pending=continuation;continuation=nil;pending?.resume(returning:value)}
}
@MainActor final class Reply { var called=false;var error:String?;var value:[String:Any]? }
@MainActor final class Fixture {
 var webView:WKWebView?=WKWebView(),epoch=UUID(),busy=false,alert:FixtureAlert?
 let codingQueue=CodingQueueSession();var queueAlertRoot:String?
 var recoveryStartup=false,worktreeEpoch=UUID(),worktreeBusy=false,scheduleEpoch=UUID(),authenticate:(()async->Bool)?
 var scheduleBusy=false,gitBusy=false
 // SCOPED_STOP
 var codingInteractive=CodingTerminalGrants()
 let codingSkills=CodingSkillsSession()
 let codingFilePreview=CodingFilePreviewSession()
 let codingSetup=CodingMCPSetupSession();var providerBinding:(threadId:String,token:UUID)?;var providerBindingAlert:UUID?;var setupAlertID:String?;let provisioning=FixtureProvisioning()
 var gitEpoch=UUID(),gitRequest:String?
 var requests=[String](),approvals=0,holdReview=false,holdPrepare=false,holdExecute=false,accept=true,codingInputs=[[String:Any]](),executed=[[String:Any]](),details=[String](),titles=[String](),buttons=[String](),recoveryMode="restore",refuseExecute=false;let review=Gate(),preparing=Gate(),executing=Gate()
 var reviewNumber=1,answers=[Bool](),flow=[String]();var afterApproval:((Int)->Void)?
 var codingGrants:Set<String>=["local:/fixture-managed","cloud:/fixture-managed/child","local:/unrelated"],prepareReply:[String:Any]?
 var codingTerminals=[String:String](),completionReply:[String:Any]?,stopReply:[String:Any]=["stopped":true,"busy":false]
 func stop(){stopTools()};func departPage(){stopTools(departure:true)}
 func stopTools(includeCoding:Bool=false,departure:Bool=false){epoch=UUID();worktreeEpoch=UUID()}
 // REQUIRE_METHOD
 func request(_ op:String,_ input:[String:Any]) async throws -> [String:Any] {
  precondition(op=="worktrees","Fixture must not access another backend")
  let action=input["action"] as! String;requests.append(action);flow.append("request:"+action)
  switch action {
  case "prepareRecoveryCopy":
   precondition(Set(input.keys)==["action","id"]);if holdPrepare{_ = await preparing.wait()};return prepareReply ?? ["plan":copyPlan()]
  case "createRecoveryCopy":
   precondition(Set(input.keys)==["action","planId"]);executed.append(input);if holdExecute{_ = await executing.wait()};return completionReply ?? copyResult()
  case "prepareReconnect":
   precondition(Set(input.keys)==["action"]);if holdPrepare{_ = await preparing.wait()}
   return prepareReply ?? ["plan":reconnectPlan()]
  case "commitReconnect":
   precondition(Set(input.keys)==["action","planId"]);executed.append(input);if holdExecute{_ = await executing.wait()}
   return completionReply ?? reconnectResult()
  case "prepareHandoffRecovery":
   precondition(Set(input.keys)==["action","id","mode"]);recoveryMode=input["mode"] as! String;if holdPrepare{_ = await preparing.wait()}
   return prepareReply ?? ["plan":recoveryPlan(recoveryMode)]
  case "recoverHandoff":
   precondition(Set(input.keys)==["action","planId"]);executed.append(input);if holdExecute{_ = await executing.wait()}
   if refuseExecute{throw ComputerError.message("Reviewed recovery changed or process exit unconfirmed.")}
   return completionReply ?? recoveryResult(recoveryMode)
  case "prepareHandoff":
   precondition(Set(input.keys)==["action","id","threadId"]);if holdPrepare{_ = await preparing.wait()}
   return prepareReply ?? ["plan":handoffPlan()]
  case "handoff":
   precondition(Set(input.keys)==["action","planId"]);executed.append(input);if holdExecute{_ = await executing.wait()}
   return completionReply ?? handoffResult()
  case "prepare":
   precondition(Set(input.keys)==Set(["action","cwd","ref"]).union(input["copyChanges"] == nil ? []:["copyChanges"]))
   return prepareReply ?? ["plan":creationPlan(input["copyChanges"] as? Bool ?? false)]
  case "prepareArchive","prepareRestore":
   precondition(Set(input.keys)==["action","id"]);if holdPrepare{_ = await preparing.wait()}
   return prepareReply ?? ["plan":["id":"84fb82b6-daf8-4d42-ac55-43a1612c806d","operation":action=="prepareArchive" ? "archive":"restore","worktreeId":input["id"]!,"cwd":"/fixture-managed","source":"/fixture","commonDir":"/fixture/.git","commit":String(repeating:"a",count:40),"files":8,"bytes":100,"expiresAt":Date().timeIntervalSince1970*1000+60000]]
  case "archive","restore":
   precondition(Set(input.keys)==["action","planId"]);precondition(codingGrants==["local:/unrelated"]);executed.append(input)
   return ["worktree":["id":"84fb82b6-daf8-4d42-ac55-43a1612c806c","state":action=="archive" ? "archived":"ready"]]
  case "create":return ["worktree":["state":"ready"]]
  case "stop":return stopReply
  case "resolve":return ["worktree":["cwd":"/fixture-managed","state":"ready"]]
  default:preconditionFailure("Unexpected backend action: \(action)")
  }
 }
 func approve(_ title:String,detail:String,button:String,expected:UUID,setupId:String?=nil) async throws -> Bool {
  try require(expected);approvals+=1;details.append(detail);titles.append(title);buttons.append(button);flow.append("approve:\(approvals)")
  if !holdReview || approvals != reviewNumber {afterApproval?(approvals);return approvals<=answers.count ? answers[approvals-1]:accept}
  let dialog=FixtureAlert();dialog.window.sheetParent!.onEnd={self.review.release(false)};alert=dialog
  let result=await review.wait();alert=nil;afterApproval?(approvals);return result
 }
 func coding(_ input:[String:Any],expected:UUID) async throws -> [String:Any]{codingInputs.append(input);return ["thread":["id":"empty-fixture-thread"]]}
 // BRIDGE_METHOD
 // WORKTREE_METHOD
 func send(_ input:[String:Any]) -> Reply {
  let reply=Reply()
  userContentController(WKUserContentController(),didReceive:WKScriptMessage(webView:webView,body:["op":"codingWorktrees","input":input])){value,error in reply.value=value as? [String:Any];reply.error=error;reply.called=true}
  return reply
 }
}
func creationPlan(_ copying:Bool=false) -> [String:Any] {
 let changes:[String:Any]=["files":3,"bytes":10,"changes":[["path":"file.txt","index":"M","worktree":"M"]],"excludedScratch":[".saleh-coding-tmp-fixture"],"ignoredRemainders":[String]() ]
 return ["id":"84fb82b6-daf8-4d42-ac55-43a1612c806d","source":"/fixture","cwd":"/fixture-managed","commonDir":"/fixture/.git","commit":String(repeating:"a",count:40),"dirty":true,"expiresAt":floor(Date().timeIntervalSince1970*1000)+60000,"copyChanges":copying,"localChanges":copying ? changes as Any:NSNull(),"localSetup":["files":0,"bytes":0,"paths":[String]()]]
}
func copyPlan() -> [String:Any] {
 return ["id":"84fb82b6-daf8-4d42-ac55-43a1612c806d","operation":"handoff-original-copy","handoffId":"84fb82b6-daf8-4d42-ac55-43a1612c806e","rootThreadId":"root-1","source":"/fixture","target":"/fixture-data/Recovered Projects/84fb82b6-daf8-4d42-ac55-43a1612c806d/project","head":String(repeating:"a",count:40),"indexTree":String(repeating:"b",count:40),"files":8,"bytes":100,"omittedCount":2,"expiresAt":floor(Date().timeIntervalSince1970*1000)+60000]
}
func copyResult() -> [String:Any] {var p=copyPlan();p.removeValue(forKey:"expiresAt");p["receiptPath"]="/fixture-data/Recovered Projects/84fb82b6-daf8-4d42-ac55-43a1612c806d/receipt.json";p["independent"]=true;p["originalRecoveryComplete"]=false;return ["copy":p]}
func reconnectPlan() -> [String:Any] {
 let root="/fixture-data/Worktrees",record="84fb82b6-daf8-4d42-ac55-43a1612c806c",cwd="/fixture-data/Worktrees/84fb82b6-daf8-4d42-ac55-43a1612c806c"
 let binding:(String,String)->[String:Any]={path,ino in ["path":path,"before":["dev":"9","ino":ino],"after":["dev":"7","ino":ino,"volumeUUID":"DA5786BC-3563-4A7A-865E-A1E8A7805C94"]]}
 return ["id":"84fb82b6-daf8-4d42-ac55-43a1612c806d","operation":"reconnect","root":root,"expiresAt":floor(Date().timeIntervalSince1970*1000)+60000,"ledgerSHA256":String(repeating:"a",count:64),"historicalContinuity":false,"records":[["id":record,"source":"/fixture","commit":String(repeating:"b",count:40),"cwd":cwd,"createdAt":1,"state":"ready","message":"Detached worktree ready.","head":String(repeating:"b",count:40),"dirty":true]],"bindings":[binding(root,"1"),binding("/fixture","2"),binding(cwd,"3")],"content":[["path":"/fixture","hash":String(repeating:"c",count:64),"files":1,"bytes":5],["path":cwd,"hash":String(repeating:"d",count:64),"files":1,"bytes":8]]]
}
func reconnectResult() -> [String:Any] {
 let p=reconnectPlan(),base="/fixture-data/managed-worktrees.json."+(p["id"] as! String)
 return ["reconnected":true,"backupPath":base+".v1.backup","receiptPath":base+".reconnect.receipt.json","worktrees":p["records"]!,"message":"Retained worktrees reconnected on this boot."]
}
func handoffPlan() -> [String:Any] {
 let a=String(repeating:"a",count:40),b=String(repeating:"b",count:40)
 return ["id":"84fb82b6-daf8-4d42-ac55-43a1612c806d","operation":"handoff","worktreeId":"84fb82b6-daf8-4d42-ac55-43a1612c806c","rootThreadId":"root-1","source":"/fixture","destination":"/fixture-managed","branch":["sourceBefore":"ref: refs/heads/main\n","destinationBefore":b+"\n","sourceAfter":a+"\n","destinationAfter":"ref: refs/heads/main\n","retainedDestinationBranch":NSNull(),"retention":["source":a,"destination":b],"branchRefsUnchanged":true],"family":[["id":"root-1","archived":false],["id":"child-1","archived":true]],"files":40000,"bytes":268435456,"nativePolicy":"Reviewed native metadata policy.","synthesized":["source":[["path":"file","metadataFrom":NSNull(),"mode":420]],"destination":[]],"recoveryDirectory":"/fixture-recovery/84fb82b6-daf8-4d42-ac55-43a1612c806d","expiresAt":floor(Date().timeIntervalSince1970*1000)+60000]
}
func handoffResult() -> [String:Any] {
 let p=handoffPlan(),compatibility:[String:Any]=["version":1,"headerHash":String(repeating:"c",count:64),"identity":["dev":"1","ino":"2"]]
 let members:[[String:Any]]=[("root-1",false,NSNull() as Any),("child-1",true,"root-1" as Any)].map{id,archived,parent in ["id":id,"parentThreadId":parent,"archived":archived,"cwd":p["destination"]!,"model":"fixture-model","modelProvider":"saleh_local","lastTurnId":"turn-1","compatibility":compatibility]}
 return ["handoff":["id":p["id"]!,"rootThreadId":p["rootThreadId"]!,"source":p["source"]!,"destination":p["destination"]!,"state":"complete","recoveryDirectory":p["recoveryDirectory"]!],"family":["rootThreadId":"root-1","cwd":p["destination"]!,"model":"fixture-model","modelProvider":"saleh_local","fingerprint":String(repeating:"d",count:64),"members":members]]
}
func recoveryPlan(_ mode:String) -> [String:Any] {
 var p=handoffPlan();p.removeValue(forKey:"synthesized");p["operation"]="handoff-recovery";p["handoffId"]="84fb82b6-daf8-4d42-ac55-43a1612c806e";p["mode"]=mode;p["target"]=p[mode=="restore" ? "source":"destination"];p["phase"]="family-resume-intent";p["retainedFiles"]=40000;return p
}
func recoveryResult(_ mode:String) -> [String:Any] {
 let p=recoveryPlan(mode);var value=handoffResult(),h=value["handoff"] as! [String:Any],family=value["family"] as! [String:Any]
 h["id"]=p["handoffId"];h["mode"]=mode;h["target"]=p["target"];family["cwd"]=p["target"];family["members"]=(family["members"] as! [[String:Any]]).map{row in var result=row;result["cwd"]=p["target"];return result};value["handoff"]=h;value["family"]=family;return value
}
@main struct Check {
 @MainActor static func until(_ condition:()->Bool) async {for _ in 0..<10000{if condition(){return};await Task.yield()};preconditionFailure("Fixture continuation did not reach its deterministic checkpoint")}
 @MainActor static func main() async {
  var failures=[String](),checks=0;func expect(_ value:Bool,_ message:String){checks+=1;if !value{failures.append(message)}}
  RecoveryStartupPolicy.check()
  for action in ["archive","restore"] {
   let f=Fixture();f.recoveryStartup=true;f.authenticate={true}
   let reply=f.send(["action":action,"id":"84fb82b6-daf8-4d42-ac55-43a1612c806c"]);await until{reply.called}
   expect(reply.error==nil && f.requests==[action=="archive" ? "prepareArchive":"prepareRestore",action] && f.executed.count==1 && f.approvals==1 && f.codingInputs.isEmpty,"Recovery startup must admit only the reviewed native "+action+" plan without opening execution")
  }
  let held=Fixture();held.recoveryStartup=true;held.authenticate={true}
  let blocked=held.send(["action":"handoff","id":"84fb82b6-daf8-4d42-ac55-43a1612c806c","threadId":"root-1"]);await until{blocked.called}
  expect(blocked.error?.contains("Recovery startup")==true && held.requests.isEmpty && held.approvals==0,"Recovery hold must reject ordinary native mutation before preparation or review")
  let heldStop=held.send(["action":"stop"]);await until{heldStop.called};expect(heldStop.error==nil && held.requests==["stop"],"Recovery hold must preserve scoped Stop")
  let copy:[String:Any]=["action":"recoverCopy","id":"84fb82b6-daf8-4d42-ac55-43a1612c806e"]
  expect(CodingWorktreePolicy.action(copy)=="recoverCopy","Copy request rejected")
  let copied=Fixture();copied.authenticate={true};let priorGrants=copied.codingGrants,copyReply=copied.send(copy);await until{copyReply.called}
  expect(copyReply.error==nil && copied.requests==["prepareRecoveryCopy","createRecoveryCopy"] && copied.approvals==1 && copied.codingInputs.isEmpty && copied.codingGrants==priorGrants,"Copy must review and create a new project without touching chat access")
  expect(copied.details.first?.contains("does not finish the original handoff")==true && NSWorkspace.shared.revealed.count==1,"Copy review or verified folder reveal missing")
  let heldCopy=Fixture();heldCopy.recoveryStartup=true;heldCopy.authenticate={true};let heldCopyReply=heldCopy.send(copy);await until{heldCopyReply.called}
  expect(heldCopyReply.error==nil && heldCopy.requests==["prepareRecoveryCopy","createRecoveryCopy"] && heldCopy.codingInputs.isEmpty,"Recovery startup must retain the reviewed independent-copy path")
  for key in ["target","handoffId","operation","head","indexTree","expiresAt","bytes","files","extra"] {let f=Fixture();f.authenticate={true};var p=copyPlan();p[key]=NSNull();f.prepareReply=["plan":p];let r=f.send(copy);await until{r.called};expect(r.error != nil && f.approvals==0 && f.executed.isEmpty,"Copy accepted invalid plan "+key)}
  for key in ["target","receiptPath","independent","originalRecoveryComplete","handoffId","files","extra"] {let f=Fixture();f.authenticate={true};var value=copyResult(),p=value["copy"] as! [String:Any];p[key]=NSNull();value["copy"]=p;f.completionReply=value;let r=f.send(copy);await until{r.called};expect(r.error != nil,"Copy accepted invalid result "+key)}
  let cancelledCopy=Fixture();cancelledCopy.authenticate={true};cancelledCopy.accept=false;let cancelledReply=cancelledCopy.send(copy);await until{cancelledReply.called};expect(cancelledCopy.executed.isEmpty,"Cancelled copy was dispatched")
  let stoppedCopy=Fixture();stoppedCopy.authenticate={true};stoppedCopy.holdExecute=true;let lateCopy=stoppedCopy.send(copy);await until{stoppedCopy.executing.entered};let stopCopy=stoppedCopy.send(["action":"stop"]);await until{stopCopy.called};stoppedCopy.executing.release();await until{lateCopy.called};expect(lateCopy.error != nil && stoppedCopy.executed.count==1,"Stopped copy was accepted or retried")
  let reconnect:[String:Any]=["action":"reconnect"]
  expect(CodingWorktreePolicy.action(reconnect)=="reconnect","Explicit reconnect action unavailable")
  for forged:[String:Any] in [["action":"reconnect","root":"/forged"],["action":"reconnect","planId":"84fb82b6-daf8-4d42-ac55-43a1612c806d"]] {expect(CodingWorktreePolicy.action(forged)==nil,"Reconnect accepted page-supplied authority")}
  let reconnected=Fixture();reconnected.authenticate={true};let reconnectReply=reconnected.send(reconnect);await until{reconnectReply.called}
  expect(reconnectReply.error==nil && reconnected.requests==["prepareReconnect","commitReconnect"] && reconnected.approvals==1 && reconnected.codingInputs.isEmpty,"Reconnect must prepare, review, then commit without executing a chat")
  expect(reconnected.details.first?.contains("does not establish historical volume identity")==true,"Reconnect review hides identity limitation")
  for key in ["historicalContinuity","ledgerSHA256","records","bindings"] {let f=Fixture();f.authenticate={true};var p=reconnectPlan();p[key]=key=="historicalContinuity" ? true:NSNull();f.prepareReply=["plan":p];let reply=f.send(reconnect);await until{reply.called};expect(reply.error != nil && f.approvals==0 && f.executed.isEmpty,"Reconnect reviewed malformed plan "+key)}

  var retainedPlan=reconnectPlan();let retainedRecord=(retainedPlan["records"] as! [[String:Any]])[0]
  let retained:[String:Any] = ["id":"84fb82b6-daf8-4d42-ac55-43a1612c806e","worktreeId":retainedRecord["id"]!,"rootThreadId":"root-1","source":retainedRecord["source"]!,"destination":retainedRecord["cwd"]!,"ownerId":"84fb82b6-daf8-4d42-ac55-43a1612c806f","manifestSHA256":String(repeating:"e",count:64),"receipts":40,"committedSequence":39]
  retainedPlan["handoffs"]=[retained];expect(CodingWorktreePolicy.reconnectPlan(retainedPlan),"Owner-bound reconnect plan rejected")
  var retainedResult=reconnectResult();retainedResult["backupPath"]=(retainedResult["backupPath"] as! String).replacingOccurrences(of:".v1.backup",with:".v2.backup")
  let retainedFixture=Fixture();retainedFixture.authenticate={true};retainedFixture.prepareReply=["plan":retainedPlan];retainedFixture.completionReply=retainedResult
  let retainedReply=retainedFixture.send(reconnect);await until{retainedReply.called}
  expect(retainedReply.error==nil && retainedFixture.executed.count==1 && retainedFixture.codingInputs.isEmpty,"Owner-bound reconnect did not review then commit without chat execution")
  expect(retainedFixture.details.first?.contains("Original chat: root-1")==true && retainedFixture.details.first?.contains("interrupted handoff remains fenced")==true,"Owner-bound reconnect review hides original owner or remaining recovery")
  for key in ["ownerId","manifestSHA256","committedSequence","source"] {var p=retainedPlan,h=retained;h[key]=key=="committedSequence" ? 41:NSNull();p["handoffs"]=[h];expect(!CodingWorktreePolicy.reconnectPlan(p),"Owner-bound reconnect accepted malformed "+key)}
  var wrongPair=retainedPlan,swapped=retained;swapped["destination"]=swapped["source"];wrongPair["handoffs"]=[swapped];expect(!CodingWorktreePolicy.reconnectPlan(wrongPair),"Owner reconnect accepted the wrong checkout pair")

  var crossRecord=retainedPlan,other=retainedRecord;let otherID="84fb82b6-daf8-4d42-ac55-43a1612c8070",otherSource="/fixture-other",otherCwd=(retainedPlan["root"] as! String)+"/"+otherID
  other["id"]=otherID;other["source"]=otherSource;other["cwd"]=otherCwd;crossRecord["records"]=[retainedRecord,other]
  var extraBindings=retainedPlan["bindings"] as! [[String:Any]]
  for (name,ino) in [(otherSource,"4"),(otherCwd,"5")] {var b=extraBindings[0];b["path"]=name;var before=b["before"] as! [String:String],after=b["after"] as! [String:String];before["ino"]=ino;after["ino"]=ino;b["before"]=before;b["after"]=after;extraBindings.append(b)}
  crossRecord["bindings"]=extraBindings;var extraContent=retainedPlan["content"] as! [[String:Any]]
  for name in [otherSource,otherCwd] {var c=extraContent[0];c["path"]=name;extraContent.append(c)};crossRecord["content"]=extraContent
  var crossed=retained;crossed["worktreeId"]=otherID;crossRecord["handoffs"]=[crossed]
  expect(!CodingWorktreePolicy.reconnectPlan(crossRecord),"Owner reconnect paired a handoff with another retained record")
  let stoppedReconnect=Fixture();stoppedReconnect.authenticate={true};stoppedReconnect.holdReview=true;let reconnectPending=stoppedReconnect.send(reconnect);await until{stoppedReconnect.review.entered};let reconnectStop=stoppedReconnect.send(["action":"stop"]);await until{reconnectStop.called && reconnectPending.called};expect(stoppedReconnect.executed.isEmpty,"Stopped reconnect dispatched a commit")
  let lateReconnect=Fixture();lateReconnect.authenticate={true};lateReconnect.holdExecute=true;let lateReply=lateReconnect.send(reconnect);await until{lateReconnect.executing.entered};let lateStop=lateReconnect.send(["action":"stop"]);await until{lateStop.called};lateReconnect.executing.release();await until{lateReply.called};expect(lateReply.error != nil && lateReconnect.executed.count==1,"Late reconnect reply falsely claimed completion or retried")
  let handoff:[String:Any]=["action":"handoff","id":"84fb82b6-daf8-4d42-ac55-43a1612c806c","threadId":"root-1"]
  guard CodingWorktreePolicy.action(handoff)=="handoff" else {print("FAIL: exact native handoff request is rejected");exit(1)}
  var canonical=handoffPlan();canonical["source"]="/private/tmp/fixture/source";canonical["destination"]="/private/tmp/fixture/destination";canonical["recoveryDirectory"]="/private/tmp/fixture/recovery"
  expect(CodingWorktreePolicy.handoffPlan(canonical,input:handoff),"Native validation rewrote the manager's canonical /private/tmp paths")
  let decoded=try! JSONSerialization.jsonObject(with:JSONSerialization.data(withJSONObject:canonical)) as! [String:Any]
  expect(CodingWorktreePolicy.handoffPlan(decoded,input:handoff),"JSON-decoded handoff plan was rejected")
  for (key,value):(String,Any) in [("cwd","/forged"),("planId","opaque"),("provider","cloud"),("id",true),("threadId","../root"),("threadId",String(repeating:"x",count:161))] {
   var bad=handoff;bad[key]=value;expect(CodingWorktreePolicy.action(bad)==nil,"Handoff accepted forged request fields")
  }
  let moved=Fixture();moved.authenticate={true};moved.codingGrants.formUnion(["local:/fixture","cloud:/fixture/sub","local:/fixture-managed-sibling"])
  moved.codingTerminals=["source":"/fixture/sub","destination":"/fixture-managed","unrelated":"/unrelated"]
  for (id,folder) in moved.codingTerminals {let token=moved.codingInteractive.begin(id);_ = moved.codingInteractive.allow(id,token:token,folder:folder,threadId:id)}
  let movedEpoch=moved.worktreeEpoch,done=moved.send(handoff);await until{done.called}
  expect(done.error==nil && done.value?["handoff"] != nil && moved.requests==["prepareHandoff","handoff"] && moved.executed.first?["planId"] as? String=="84fb82b6-daf8-4d42-ac55-43a1612c806d","Handoff failed to review and execute exactly the prepared plan")
  expect(moved.worktreeEpoch != movedEpoch && moved.approvals==1 && moved.codingInputs.isEmpty,"Handoff changed chat identity or skipped a fresh native review")
  expect(moved.codingGrants==["local:/unrelated","local:/fixture-managed-sibling"] && Set(moved.codingTerminals.keys)==["unrelated"] && Set(moved.codingInteractive.entries.keys)==["unrelated"],"Handoff did not revoke both affected checkout/terminal grants while retaining unrelated scope")
  expect(moved.details.first?.contains("Stop") == true && moved.details.first?.contains("/fixture-managed") == true,"Handoff review omitted effect or destination")
  let deniedHandoff=Fixture();deniedHandoff.authenticate={true};deniedHandoff.accept=false;let denial=deniedHandoff.send(handoff);await until{denial.called}
  expect(denial.value?["cancelled"] as? Bool==true && deniedHandoff.executed.isEmpty && deniedHandoff.requests.last=="stop","Cancelled handoff executed or retained review lease")
  for (key,value):(String,Any) in [("operation","archive"),("worktreeId","84fb82b6-daf8-4d42-ac55-43a1612c806e"),("rootThreadId","other"),("source","relative"),("source","/"),("source","/fixture/../other"),("source","/fixture/./other"),("source","/fixture//other"),("source","/fixture/"),("destination","/fixture"),("files",40001),("bytes",268435457),("bytes",true),("expiresAt",0),("family",[["id":"root-1","archived":false],["id":"root-1","archived":false]]),("nativePolicy","")] {
   var plan=handoffPlan();plan[key]=value;let f=Fixture();f.authenticate={true};f.prepareReply=["plan":plan];let reply=f.send(handoff);await until{reply.called}
   expect(reply.error != nil && f.approvals==0 && f.executed.isEmpty,"Malformed handoff plan \(key) reached review/dispatch")
  }
  for mutation in 0..<8 {
   var plan=handoffPlan()
   switch mutation {
   case 0: plan["extra"]=true
   case 1: plan["family"]=[["id":"root-1","archived":0]]
   case 2: plan["family"]=[["id":"root-1","archived":true]]
   case 3: var branch=plan["branch"] as! [String:Any];branch["branchRefsUnchanged"]=false;plan["branch"]=branch
   case 4: var branch=plan["branch"] as! [String:Any];branch["sourceAfter"]=String(repeating:"f",count:40)+"\n";plan["branch"]=branch
   case 5: plan["synthesized"]=["source":[["path":".git/HEAD","metadataFrom":NSNull(),"mode":420]],"destination":[]]
   case 6: plan["synthesized"]=["source":[["path":"file","metadataFrom":"unknown","mode":420]],"destination":[]]
   default: plan["synthesized"]=["source":[["path":"file","metadataFrom":NSNull(),"mode":true]],"destination":[]]
   }
   let f=Fixture();f.authenticate={true};f.prepareReply=["plan":plan];let reply=f.send(handoff);await until{reply.called}
   expect(reply.error != nil && f.approvals==0 && f.executed.isEmpty,"Nested malformed handoff plan \(mutation) reached review/dispatch")
  }
  for gate in ["auth","prepare","review","execute"] {
   let f=Fixture(),auth=Gate();var calls=0;f.holdPrepare=gate=="prepare";f.holdReview=gate=="review";f.holdExecute=gate=="execute";f.authenticate={calls+=1;return gate=="auth" && calls==1 ? await auth.wait():true}
   let reply=f.send(handoff);await until{gate=="auth" ? auth.entered:gate=="prepare" ? f.preparing.entered:gate=="review" ? f.review.entered:f.executing.entered}
   f.stopReply=["stopped":false,"busy":false,"message":"Exit unconfirmed; recovery retained."]
   let stop=f.send(["action":"stop"]);await until{stop.called};expect(stop.value?["stopped"] as? Bool==false,"Scoped handoff Stop lost unconfirmed result")
   if gate=="auth"{auth.release()};if gate=="prepare"{f.preparing.release()};if gate=="execute"{f.executing.release()};await until{reply.called}
   expect(reply.value?["handoff"]==nil && (gate=="execute" ? f.executed.count==1:f.executed.isEmpty),"Stop allowed stale handoff dispatch/completion at \(gate)")
  }
  for field in ["id","rootThreadId","source","destination","state","recoveryDirectory"] {
   let f=Fixture();f.authenticate={true};var value=handoffResult(),result=value["handoff"] as! [String:Any];result[field]="mismatch";value["handoff"]=result;f.completionReply=value
   let reply=f.send(handoff);await until{reply.called};expect(reply.error != nil && reply.value==nil && f.executed.count==1,"Mismatched handoff completion \(field) reported success")
  }
  for field in ["rootThreadId","cwd","members"] {
   let f=Fixture();f.authenticate={true};var value=handoffResult(),family=value["family"] as! [String:Any];family[field]=field=="members" ? [] as [Any]:"mismatch" as Any;value["family"]=family;f.completionReply=value
   let reply=f.send(handoff);await until{reply.called};expect(reply.error != nil && reply.value==nil,"Mismatched returned family \(field) reported success")
  }
  for (field,value):(String,Any) in [("archived",false),("modelProvider","changed"),("cwd","/different"),("parentThreadId","child-1"),("lastTurnId","../turn"),("compatibility",NSNull())] {
   let f=Fixture();f.authenticate={true};var result=handoffResult(),family=result["family"] as! [String:Any],members=family["members"] as! [[String:Any]];members[1][field]=value;family["members"]=members;result["family"]=family;f.completionReply=result
   let reply=f.send(handoff);await until{reply.called};expect(reply.error != nil && reply.value==nil,"Mismatched family member \(field) reported success")
  }
  let stale=Fixture(),oldAuthentication=Gate();var staleCalls=0;stale.holdReview=true;stale.authenticate={staleCalls+=1;return staleCalls==1 ? await oldAuthentication.wait():true}
  let oldHandoffStop=stale.send(["action":"stop"]);await until{oldAuthentication.entered};let pendingHandoffGeneration=stale.worktreeEpoch
  let blockedHandoff=stale.send(handoff);await until{blockedHandoff.called}
  expect(blockedHandoff.error != nil && stale.worktreeEpoch==pendingHandoffGeneration && stale.requests.isEmpty && stale.approvals==0 && stale.executed.isEmpty,"Handoff escaped pending Stop authentication or changed its generation")
  oldAuthentication.release();await until{oldHandoffStop.called}
  expect(oldHandoffStop.error==nil && stale.requests==["stop"],"Accepted handoff Stop did not settle exactly once after authentication")
  let activeHandoff=stale.send(handoff);await until{stale.review.entered}
  expect(stale.alert!.window.sheetParent!.ended==0 && stale.requests.filter{$0=="stop"}.count==1,"Settled Stop dismissed the fresh handoff review or dispatched again")
  stale.review.release();await until{activeHandoff.called};expect(activeHandoff.error==nil && stale.executed.count==1,"Fresh handoff did not complete once after Stop settled")
  let navigation=Fixture();navigation.authenticate={true};navigation.holdExecute=true;let navigated=navigation.send(handoff);await until{navigation.executing.entered};navigation.stopTools();navigation.executing.release();await until{navigated.called}
  expect(navigated.error != nil && navigated.value==nil && navigation.executed.count==1,"Page/global revocation exposed late handoff completion")
  for mode in ["restore","finish"] {
   let input:[String:Any]=["action":"recoverHandoff","id":"84fb82b6-daf8-4d42-ac55-43a1612c806e","mode":mode]
   guard CodingWorktreePolicy.action(input)=="recoverHandoff" else {print("FAIL: exact native \(mode) recovery request is rejected");exit(1)}
   for (key,value):(String,Any) in [("mode","other"),("mode",true),("id",true),("id","invalid"),("planId","opaque"),("threadId","root-1"),("target","/forged"),("provider","cloud")] {
    var bad=input;bad[key]=value;let f=Fixture();f.authenticate={true};let old=f.worktreeEpoch,reply=f.send(bad);await until{reply.called}
    expect(reply.error != nil && f.requests.isEmpty && f.worktreeEpoch==old,"Recovery accepted malformed page input \(key)")
   }
   let initialCancel=Fixture();initialCancel.authenticate={true};initialCancel.accept=false
   let keptGrants=initialCancel.codingGrants,cancelledInspection=initialCancel.send(input);await until{cancelledInspection.called}
   guard cancelledInspection.value?["cancelled"] as? Bool==true && initialCancel.requests.isEmpty else {print("FAIL: Initial recovery compatibility Cancel must send no backend request");exit(1)}
   expect(initialCancel.approvals==1 && initialCancel.executed.isEmpty && initialCancel.codingGrants==keptGrants,"Initial recovery Cancel changed grants or executed work")
   let initialStop=Fixture();initialStop.authenticate={true};initialStop.holdReview=true
   let stoppedInspection=initialStop.send(input);await until{initialStop.review.entered}
   expect(initialStop.requests.isEmpty,"Recovery preparation ran before compatibility approval")
   let inspectionStop=initialStop.send(["action":"stop"]);await until{inspectionStop.called && stoppedInspection.called}
   expect(initialStop.requests==["stop"] && initialStop.executed.isEmpty && stoppedInspection.value?["handoff"]==nil,"Stop during compatibility disclosure admitted recovery preparation")
   for scope in ["page","worktree"] {
    let revoked=Fixture();revoked.authenticate={true};revoked.afterApproval={number in if number==1 {if scope=="page"{revoked.epoch=UUID()}else{revoked.worktreeEpoch=UUID()}}}
    let revokedReply=revoked.send(input);await until{revokedReply.called}
    expect(revokedReply.error != nil && revoked.requests.isEmpty && revoked.executed.isEmpty,"Compatibility approval did not recheck the \(scope) generation before preparation")
   }
   let f=Fixture();f.authenticate={true};f.codingGrants.formUnion(["local:/fixture","cloud:/fixture/sub","local:/fixture-managed-sibling","local:/"]);f.codingTerminals=["source":"/fixture/sub","destination":"/fixture-managed","ancestor":"/","unrelated":"/unrelated"]
   for (id,folder) in f.codingTerminals {let token=f.codingInteractive.begin(id);_ = f.codingInteractive.allow(id,token:token,folder:folder,threadId:id)}
   let old=f.worktreeEpoch,reply=f.send(input);await until{reply.called}
   expect(reply.error==nil && reply.value?["handoff"] != nil && f.requests==["prepareHandoffRecovery","recoverHandoff"] && f.executed.count==1 && f.executed.first?["planId"] as? String==recoveryPlan(mode)["id"] as? String,"Recovery did not dispatch only its approved opaque plan")
   expect(f.worktreeEpoch != old && f.approvals==2 && f.codingInputs.isEmpty,"Recovery skipped compatibility/plan review or started/submitted a chat")
   expect(f.flow==["approve:1","request:prepareHandoffRecovery","approve:2","request:recoverHandoff"],"Recovery did not preserve compatibility approval, exact plan review, then commit ordering")
   expect(f.codingGrants==["local:/unrelated","local:/fixture-managed-sibling"] && Set(f.codingTerminals.keys)==["unrelated"] && Set(f.codingInteractive.entries.keys)==["unrelated"],"Recovery retained affected project/legacy/PTY grants or revoked unrelated ones")
   expect(f.titles==["Inspect this retained handoff?",mode=="restore" ? "Restore this interrupted handoff?":"Finish this interrupted handoff?"] && f.buttons==["Inspect recovery",mode=="restore" ? "Restore handoff":"Finish handoff"],"Recovery used the wrong compatibility or mode-specific approval")
   let compatibility=f.details.first ?? ""
   expect(["retained Coding history","permanently","Build80 and earlier","Cancel","Stop","separate review"].allSatisfy{compatibility.contains($0)},"Recovery inspection omitted its irreversible compatibility boundary")
   let detail=f.details.last ?? ""
   expect(["Both checkouts","staged","working","ignored","scratch","history","model","provider","No prompt","Stop","partial","recovery",mode=="restore" ? "Before":"After"].allSatisfy{detail.contains($0)},"Recovery review omitted a required effect")
   expect(["Recorded ignored paths and currently verified app scratch stay in place.","Unverified scratch is reviewed as ordinary content.","nativePolicy describes native metadata."].allSatisfy{detail.contains($0)},"Recovery review misstates frozen ignored and verified scratch exclusions")
   let denied=Fixture();denied.authenticate={true};denied.answers=[true,false];let cancelled=denied.send(input);await until{cancelled.called}
   expect(cancelled.value?["cancelled"] as? Bool==true && denied.approvals==2 && denied.executed.isEmpty && denied.requests==["prepareHandoffRecovery","stop"],"Cancelled final recovery review executed or kept a review lease")
   let refused=Fixture();refused.authenticate={true};refused.refuseExecute=true;let refusedReply=refused.send(input);await until{refusedReply.called}
   expect(refusedReply.error != nil && refusedReply.value==nil && refused.executed.count==1 && refused.requests.last=="stop","Manager recovery refusal became success or automatic retry")
   for (key,value):(String,Any) in [("operation","handoff"),("id","invalid"),("handoffId","84fb82b6-daf8-4d42-ac55-43a1612c806f"),("worktreeId","invalid"),("rootThreadId","../root"),("mode",mode=="restore" ? "finish":"restore"),("target","/forged"),("source","/fixture/../other"),("source","/"),("destination","/fixture/sub"),("recoveryDirectory","/fixture/sub"),("phase","bad\nphase"),("phase","bad\n"),("phase",String(repeating:"x",count:81)),("files",40001),("files",true),("bytes",268435457),("bytes",true),("retainedFiles",40001),("retainedFiles",true),("retainedFiles",0.5),("expiresAt",0),("expiresAt",true),("nativePolicy",""),("nativePolicy",String(repeating:"x",count:4097)),("family",[["id":"root-1","archived":false],["id":"root-1","archived":false]]),("family",[["id":"root-1","archived":0]]),("family",[["id":"root-1","archived":false],["id":"child-1\n","archived":true]]),("extra",true)] {
    var p=recoveryPlan(mode);p[key]=value;let f=Fixture();f.authenticate={true};f.prepareReply=["plan":p];let reply=f.send(input);await until{reply.called}
    expect(reply.error != nil && f.approvals==1 && f.executed.isEmpty,"Malformed recovery plan \(key) reached final review/dispatch")
   }
   for key in ["sourceBefore","destinationBefore","sourceAfter","destinationAfter","retainedDestinationBranch","retention","branchRefsUnchanged","extra"] {
    var p=recoveryPlan(mode),branch=p["branch"] as! [String:Any];branch[key]=false;p["branch"]=branch;let f=Fixture();f.authenticate={true};f.prepareReply=["plan":p];let reply=f.send(input);await until{reply.called}
    expect(reply.error != nil && f.approvals==1 && f.executed.isEmpty,"Malformed recovery branch \(key) reached final approval")
   }
   let decoded=Fixture();decoded.authenticate={true};decoded.prepareReply=try! JSONSerialization.jsonObject(with:JSONSerialization.data(withJSONObject:["plan":recoveryPlan(mode)])) as? [String:Any];let decodedReply=decoded.send(input);await until{decodedReply.called};expect(decodedReply.error==nil,"JSON-decoded recovery was rejected")
   let extra=Fixture();extra.authenticate={true};extra.prepareReply=["plan":recoveryPlan(mode),"extra":true];let extraReply=extra.send(input);await until{extraReply.called};expect(extraReply.error != nil && extra.approvals==1,"Unknown recovery envelope key reached final review")
   for field in ["id","rootThreadId","source","destination","mode","target","state","recoveryDirectory","extra"] {
    let f=Fixture();f.authenticate={true};var value=recoveryResult(mode),h=value["handoff"] as! [String:Any];h[field]="mismatch";value["handoff"]=h;f.completionReply=value;let reply=f.send(input);await until{reply.called}
    expect(reply.error != nil && reply.value==nil && f.executed.count==1,"Mismatched recovery completion \(field) reached page")
   }
   for field in ["rootThreadId","cwd","model","modelProvider","fingerprint","members","extra"] {
    let f=Fixture();f.authenticate={true};var value=recoveryResult(mode),family=value["family"] as! [String:Any];family[field]=field=="members" ? [] as [Any]:"mismatch" as Any;value["family"]=family;f.completionReply=value;let reply=f.send(input);await until{reply.called}
    expect(reply.error != nil && reply.value==nil,"Mismatched recovery family \(field) reached page")
   }
   for (field,value):(String,Any) in [("id","other"),("archived",false),("archived",1),("modelProvider","changed"),("cwd","/different"),("parentThreadId","child-1"),("lastTurnId","../turn"),("lastTurnId","turn-1\n"),("compatibility",NSNull()),("extra",true)] {
    let f=Fixture();f.authenticate={true};var result=recoveryResult(mode),family=result["family"] as! [String:Any],members=family["members"] as! [[String:Any]];members[1][field]=value;family["members"]=members;result["family"]=family;f.completionReply=result;let reply=f.send(input);await until{reply.called}
    expect(reply.error != nil && reply.value==nil,"Mismatched recovery member \(field) reached page")
   }
   for gate in ["auth","prepare","review","execute"] {
    let f=Fixture(),auth=Gate();var calls=0;f.holdPrepare=gate=="prepare";f.holdReview=gate=="review";f.reviewNumber=2;f.holdExecute=gate=="execute";f.authenticate={calls+=1;return gate=="auth" && calls==1 ? await auth.wait():true}
    let reply=f.send(input);await until{gate=="auth" ? auth.entered:gate=="prepare" ? f.preparing.entered:gate=="review" ? f.review.entered:f.executing.entered}
    if gate=="review" {expect(f.codingGrants==["local:/unrelated"],"Recovery grants survived until native approval")}
    f.stopReply=["stopped":false,"busy":false,"message":"Exit unconfirmed; recovery retained."];let stop=f.send(["action":"stop"]);await until{stop.called};expect(stop.value?["stopped"] as? Bool==false,"Recovery Stop lost unconfirmed result")
    if gate=="auth"{auth.release()};if gate=="prepare"{f.preparing.release()};if gate=="execute"{f.executing.release()};await until{reply.called}
    expect(reply.value?["handoff"]==nil && (gate=="execute" ? f.executed.count==1:f.executed.isEmpty),"Stop allowed stale recovery dispatch/completion at \(gate)")
   }
   let stale=Fixture(),auth=Gate();var calls=0;stale.holdReview=true;stale.reviewNumber=2;stale.authenticate={calls+=1;return calls==1 ? await auth.wait():true};let oldStop=stale.send(["action":"stop"]);await until{auth.entered};let generation=stale.worktreeEpoch
   let blockedRecovery=stale.send(input);await until{blockedRecovery.called}
   expect(blockedRecovery.error != nil && stale.worktreeEpoch==generation && stale.requests.isEmpty && stale.approvals==0 && stale.executed.isEmpty,"Recovery escaped pending Stop authentication or changed its generation")
   auth.release();await until{oldStop.called};expect(oldStop.error==nil && stale.requests==["stop"],"Accepted recovery Stop did not settle exactly once after authentication")
   let active=stale.send(input);await until{stale.review.entered}
   expect(stale.alert!.window.sheetParent!.ended==0 && stale.requests.filter{$0=="stop"}.count==1,"Settled Stop dismissed the fresh recovery review or dispatched again")
   stale.review.release();await until{active.called};expect(active.error==nil && stale.executed.count==1,"Fresh recovery failed after Stop settled")
   for mutation in ["fingerprint","headerHash","identity"] {
    let f=Fixture();f.authenticate={true};var result=recoveryResult(mode),family=result["family"] as! [String:Any],members=family["members"] as! [[String:Any]]
    if mutation=="fingerprint" {family["fingerprint"]=String(repeating:"d",count:64)+"\n"}
    else {var compatibility=members[1]["compatibility"] as! [String:Any];if mutation=="headerHash" {compatibility[mutation]=String(repeating:"c",count:64)+"\n"}else{compatibility[mutation]=["dev":"1\n","ino":"2"]};members[1]["compatibility"]=compatibility;family["members"]=members}
    result["family"]=family;f.completionReply=result;let reply=f.send(input);await until{reply.called};expect(reply.error != nil && reply.value==nil,"Trailing newline in recovery \(mutation) reached page")
   }
   let navigation=Fixture();navigation.authenticate={true};navigation.holdExecute=true;let navigated=navigation.send(input);await until{navigation.executing.entered};navigation.stopTools();navigation.executing.release();await until{navigated.called};expect(navigated.error != nil && navigated.value==nil,"Page/global revocation exposed late recovery completion")
  }
  expect(moved.details.first?.contains("Build80 and earlier")==true && moved.details.first?.contains("compatible newer version")==true,"Normal handoff omitted the Coding storage compatibility boundary")
  // ACTUAL_HANDOFF
  let create:[String:Any]=["action":"create","cwd":"/fixture","ref":"HEAD"]
  let copying:[String:Any]=["action":"create","cwd":"/fixture","ref":"HEAD","copyChanges":true]
  let copiedChanges=Fixture();copiedChanges.authenticate={true};let copiedReply=copiedChanges.send(copying);await until{copiedReply.called}
  expect(copiedReply.error==nil && copiedChanges.requests==["prepare","create"] && copiedChanges.approvals==1,"Explicit copy option was not prepared/reviewed/dispatched exactly once")
  expect(copiedChanges.details.first?.contains("Staged edits stay staged; working edits stay unstaged.")==true && copiedChanges.codingInputs.isEmpty,"Copy review lost stage separation or sent a model prompt")
  for bad:Any in [0,1,"true",NSNull()] {var value=copying;value["copyChanges"]=bad;expect(CodingWorktreePolicy.action(value)==nil,"Non-boolean copy mode accepted")}
  var forged=[creationPlan(false)]
  for (key,value):(String,Any) in [("commit","fixture"),("copyChanges",1),("localChanges",NSNull())] {var plan=creationPlan(true);plan[key]=value;forged.append(plan)}
  var unsafe=creationPlan(true),contents=unsafe["localChanges"] as! [String:Any];contents["excludedScratch"]=["ordinary-file"];unsafe["localChanges"]=contents;forged.append(unsafe)
  var unreviewed=creationPlan(true),remainderContents=unreviewed["localChanges"] as! [String:Any];remainderContents["ignoredRemainders"]=["file.txt"];unreviewed["localChanges"]=remainderContents;forged.append(unreviewed)
  var deletion=creationPlan(true),deletionContents=deletion["localChanges"] as! [String:Any];deletionContents["changes"]=[["path":"file.txt","index":"D","worktree":" "]];deletionContents["ignoredRemainders"]=["file.txt"];deletion["localChanges"]=deletionContents;expect(CodingWorktreePolicy.creationPlan(deletion,input:copying),"Reviewed ignored remainder of a staged deletion rejected")
  for plan in forged {let bad=Fixture();bad.authenticate={true};bad.prepareReply=["plan":plan];let reply=bad.send(copying);await until{reply.called};expect(reply.error != nil && bad.approvals==0 && !bad.requests.contains("create"),"Mismatched or malformed copy plan reached review/dispatch")}

  let pending=Fixture(),createAuth=Gate();var authCalls=0
  pending.authenticate={authCalls+=1;return authCalls==1 ? await createAuth.wait():true}
  let cancelledCreate=pending.send(create);await until{createAuth.entered}
  let stop=pending.send(["action":"stop"]);await until{stop.called}
  expect(pending.requests==["stop"],"Scoped Stop must resolve while create authentication waits")
  createAuth.release();await until{cancelledCreate.called}
  expect(!pending.requests.contains("prepare"),"Create admitted before Stop prepared after delayed authentication")
  expect(pending.approvals==0,"Create admitted before Stop presented native review after delayed authentication")
  expect(!pending.requests.contains("create"),"Create admitted before Stop dispatched checkout after delayed authentication")
  expect(cancelledCreate.error != nil || cancelledCreate.value?["cancelled"] as? Bool == true,"Stopped pending create was reported as success")

  let newer=Fixture(),stopAuth=Gate();authCalls=0;newer.holdReview=true
  newer.authenticate={authCalls+=1;return authCalls==1 ? await stopAuth.wait():true}
  let oldStop=newer.send(["action":"stop"]);await until{stopAuth.entered};let pendingCreateGeneration=newer.worktreeEpoch
  let blockedCreate=newer.send(create);await until{blockedCreate.called}
  expect(blockedCreate.error != nil && newer.worktreeEpoch==pendingCreateGeneration && newer.requests.isEmpty && newer.approvals==0,"Create escaped pending Stop authentication or changed its generation")
  stopAuth.release();await until{oldStop.called}
  expect(oldStop.error==nil && newer.requests==["stop"],"Accepted create Stop did not settle exactly once after authentication")
  let freshCreate=newer.send(create);await until{newer.review.entered}
  let generation=newer.worktreeEpoch,parent=newer.alert!.window.sheetParent!
  let busyCreate=newer.send(create);expect(busyCreate.called && busyCreate.error != nil,"Busy bridge must reject another create before rotating its generation")
  expect(newer.worktreeEpoch==generation,"Rejected busy create changed the active generation")
  expect(parent.ended==0,"Settled Stop dismissed a newer native review")
  expect(newer.requests.filter{$0=="stop"}.count==1,"Settled Stop dispatched backend cancellation again for a newer create")
  newer.review.release();await until{freshCreate.called}
  expect(freshCreate.error==nil && freshCreate.value?["worktree"] != nil && newer.requests.filter{$0=="create"}.count==1,"Fresh create did not finish exactly once after Stop settled")
  let invalid=Fixture();invalid.authenticate={true};let invalidGeneration=invalid.worktreeEpoch
  let malformed=invalid.send(["action":"create","cwd":"/fixture"]);await until{malformed.called}
  expect(malformed.error != nil && invalid.worktreeEpoch==invalidGeneration && invalid.requests.isEmpty,"Malformed create rotated a generation or reached the backend")
  let opening=Fixture();opening.authenticate={true}
  let opened=opening.send(["action":"open","id":"84FB82B6-DAF8-4D42-AC55-43A1612C806C","provider":"cloud"]);await until{opened.called}
  expect(opened.error==nil && opened.value?["thread"] != nil && opening.requests==["resolve"],"Managed Open must use the resolved worktree record")
  expect(opening.codingInputs.count==1 && opening.codingInputs[0]["action"] as? String=="start" && opening.codingInputs[0]["cwd"] as? String=="/fixture-managed" && opening.codingInputs[0]["provider"] as? String=="cloud","Managed Open must start one empty chat with its explicit provider and resolved path")
  expect(opening.codingInputs.first?["executionMode"] as? String=="vm","Managed Open without mode must retain VM compatibility")
  for mode in ["native","vm"] {
   let selected=Fixture();selected.authenticate={true}
   let reply=selected.send(["action":"open","id":"84FB82B6-DAF8-4D42-AC55-43A1612C806C","provider":"local","model":"fixture-model","executionMode":mode]);await until{reply.called}
   expect(reply.error==nil && selected.requests==["resolve"] && selected.codingInputs.count==1,"Managed Open must accept explicit execution mode and resolve the managed path")
   expect(selected.codingInputs.first?["executionMode"] as? String==mode && selected.codingInputs.first?["model"] as? String=="fixture-model" && selected.codingInputs.first?["cwd"] as? String=="/fixture-managed","Managed Open must forward exact mode/model through the existing Coding permission route")
  }
  for mode:Any in ["", "other", false, 3, NSNull()] {
   let invalidMode=Fixture();invalidMode.authenticate={true}
   let reply=invalidMode.send(["action":"open","id":"84FB82B6-DAF8-4D42-AC55-43A1612C806C","provider":"local","executionMode":mode]);await until{reply.called}
   expect(reply.error != nil && invalidMode.requests.isEmpty && invalidMode.codingInputs.isEmpty,"Malformed worktree mode must be refused before resolving or creating a chat")
  }
  expect(pending.codingInputs.isEmpty && newer.codingInputs.isEmpty,"Worktree creation must never start a coding chat")
  let owned="84fb82b6-daf8-4d42-ac55-43a1612c806c"
  for action in ["archive","restore"] {
   let input:[String:Any]=["action":action,"id":owned]
   expect(CodingWorktreePolicy.action(input)==action,"Archive/restore policy rejected exact owned ID")
   for (key,value):(String,Any) in [("cwd","/forged"),("planId",owned),("command","rm"),("id",true),("id","invalid")] {
    var bad=input;bad[key]=value;expect(CodingWorktreePolicy.action(bad)==nil,"Archive/restore accepted forged fields")
   }
   let accepted=Fixture();accepted.authenticate={true};let old=accepted.worktreeEpoch,done=accepted.send(input);await until{done.called}
   expect(done.error==nil && accepted.executed.count==1 && accepted.executed[0]["planId"] as? String=="84fb82b6-daf8-4d42-ac55-43a1612c806d","Archive/restore did not execute exact reviewed opaque plan")
   expect(old != accepted.worktreeEpoch && accepted.approvals==1 && accepted.codingInputs.isEmpty,"Archive/restore epoch/review/chat behavior invalid")
   expect(accepted.details.first?.contains(action=="archive" ? "recovery":"original") == true,"Archive/restore effect missing from review")
   let denied=Fixture();denied.authenticate={true};denied.accept=false;let d=denied.send(input);await until{d.called}
   expect(denied.executed.isEmpty && d.value?["cancelled"] as? Bool==true && denied.requests.last=="stop","Cancelled archive/restore executed or retained review lease")
   for gate in ["auth","prepare","review"] {
    let stopped=Fixture(),authentication=Gate();var calls=0;stopped.holdPrepare=gate=="prepare";stopped.holdReview=gate=="review"
    stopped.authenticate={calls+=1;return gate=="auth" && calls==1 ? await authentication.wait():true}
    let pending=stopped.send(input);await until{gate=="auth" ? authentication.entered:gate=="prepare" ? stopped.preparing.entered:stopped.review.entered}
    let cancellation=stopped.send(["action":"stop"]);await until{cancellation.called}
    if gate=="auth"{authentication.release()};if gate=="prepare"{stopped.preparing.release()};await until{pending.called}
    expect(stopped.executed.isEmpty && (gate=="review" || stopped.approvals==0),"Stop allowed later archive/restore review or dispatch")
   }
   for wrong:[String:Any] in [["id":owned,"operation":action,"worktreeId":"84fb82b6-daf8-4d42-ac55-43a1612c806e","cwd":"/fixture-managed"],["id":owned,"operation":action=="archive" ? "restore":"archive","worktreeId":owned,"cwd":"/fixture-managed"],["id":owned,"operation":action,"worktreeId":owned,"cwd":"relative"]] {
    let malformed=Fixture();malformed.authenticate={true};malformed.prepareReply=["plan":wrong];let bad=malformed.send(input);await until{bad.called}
    expect(bad.error != nil && malformed.approvals==0 && malformed.executed.isEmpty,"Mismatched plan reached review or mutation")
   }
  }
  if failures.isEmpty{print("PASS: \(checks) native worktree checks; create/open/archive/restore/handoff/recovery validates exact reviewed plans and completions, revokes affected grants, preserves unrelated scope and blocks late dispatch/completion after Cancel/Stop")}
  else{for failure in failures{print("FAIL: \(failure)")};exit(1)}
 }
}
'''

focus_fixture = r'''
import AppKit
import ApplicationServices
enum ComputerError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { return s }; return nil } }
enum ComputerAction {
    static func canPrepareWindow(frontmost: pid_t?, selected: pid_t, controller: pid_t) -> Bool {
        guard let frontmost, frontmost > 0, selected > 0, controller > 0 else { return false }
        return frontmost == selected || frontmost == controller
    }
}
@MainActor final class FixtureWorkspace {
    static let shared = FixtureWorkspace()
    var frontmostApplication: FixtureApp? = FixtureApp(processIdentifier:20)
}
@MainActor final class FixtureApp {
    let processIdentifier: pid_t
    init?(processIdentifier: pid_t) { self.processIdentifier = processIdentifier }
    func activate() -> Bool { Fixture.activateCount += 1; if Fixture.activation { FixtureWorkspace.shared.frontmostApplication = self }; return Fixture.activation }
}
struct FixtureWindow { let frame = CGRect(x:0,y:0,width:100,height:80); let owningApplication: FixtureOwner? = FixtureOwner() }
struct FixtureOwner { let processID: pid_t = 20 }
@MainActor func FixtureTrusted() -> Bool { true }
@MainActor func FixtureAXCreateApplication(_ pid: pid_t) -> CFString { "app" as CFString }
func FixtureAXGetTypeID() -> CFTypeID { CFStringGetTypeID() }
@MainActor func FixtureAXPerformAction(_ window: CFString, _ action: CFString) -> AXError {
    Fixture.raiseCount += 1
    if Fixture.raiseStatus == .success { Fixture.focused = true }
    return Fixture.raiseStatus
}
@MainActor final class Fixture {
    static var activation = true, activateCount = 0, raiseCount = 0, focused = false, changed = false, focusReadFailure = false
    static var raiseStatus = AXError.actionUnsupported
    var selected: FixtureWindow? = FixtureWindow()
    let epoch = UUID()
    func require(_ expected: UUID) throws { if expected != epoch { throw ComputerError.message("Stopped") } }
    func liveWindows() throws -> [Int] { [] }
    func sharedBounds(_ windows: [Int]) throws -> CGRect { selected!.frame }
    func currentWindow() throws -> CFString { Self.changed && Self.raiseCount > 0 ? "replaced" as CFString : "selected" as CFString }
    func checkedValue(_ app: CFString, _ attribute: String, optional: Bool = false) throws -> CFTypeRef? {
        if Self.focusReadFailure { throw ComputerError.message("Focus read unsupported (AX status -25205)") }
        return (Self.focused ? "selected" : "other") as CFString
    }
    // PREPARE_METHOD
}
func outcome(_ value: Bool) -> (prepared:Bool,failure:String?) { (value,nil) }
func outcome(_ value: (prepared:Bool,failure:String?)) -> (prepared:Bool,failure:String?) { value }
@main struct Check {
    @MainActor static func main() async {
        var failures = [String]()
        func expect(_ condition: Bool, _ message: String) { if !condition { failures.append(message) } }
        func reset(front: pid_t, focused: Bool = false) -> Fixture {
            FixtureWorkspace.shared.frontmostApplication = FixtureApp(processIdentifier:front)
            Fixture.activation = true; Fixture.activateCount = 0; Fixture.raiseCount = 0
            Fixture.raiseStatus = .actionUnsupported; Fixture.focused = focused; Fixture.changed = false; Fixture.focusReadFailure = false
            return Fixture()
        }
        var fixture = reset(front:20,focused:true)
        do { let result = outcome(try await fixture.prepareSharedWindow(expected:fixture.epoch)); expect(result.prepared && result.failure == nil && Fixture.raiseCount == 0,"already-focused window must skip unsupported AXRaise") }
        catch { failures.append("already-focused capture failed: \(error.localizedDescription)") }
        fixture = reset(front:ProcessInfo.processInfo.processIdentifier)
        do { let result = outcome(try await fixture.prepareSharedWindow(expected:fixture.epoch)); expect(!result.prepared && result.failure?.contains(String(AXError.actionUnsupported.rawValue)) == true && Fixture.raiseCount == 1,"unsupported AXRaise must return diagnostic capture fallback") }
        catch { failures.append("unsupported AXRaise must not throw: \(error.localizedDescription)") }
        fixture = reset(front:ProcessInfo.processInfo.processIdentifier); Fixture.activation = false
        do { let result = outcome(try await fixture.prepareSharedWindow(expected:fixture.epoch)); expect(!result.prepared && result.failure != nil && Fixture.raiseCount == 0,"activation failure must permit read-only capture") }
        catch { failures.append("activation failure blocked capture: \(error.localizedDescription)") }
        fixture = reset(front:20); Fixture.focusReadFailure = true
        do { let result = outcome(try await fixture.prepareSharedWindow(expected:fixture.epoch)); expect(!result.prepared && result.failure?.contains("AX status") == true,"unsupported focus read must retain diagnostic capture fallback") }
        catch { failures.append("focus read blocked capture: \(error.localizedDescription)") }
        fixture = reset(front:20); Fixture.changed = true
        do { _ = try await fixture.prepareSharedWindow(expected:fixture.epoch); failures.append("changed selected identity must reject observation") } catch {}
        fixture = reset(front:20); Fixture.raiseStatus = .success
        do { let result = outcome(try await fixture.prepareSharedWindow(expected:fixture.epoch)); expect(result.prepared && Fixture.raiseCount == 1,"successful preparation must remain eligible") }
        catch { failures.append("successful preparation rejected: \(error.localizedDescription)") }
        fixture = reset(front:30)
        do { let result = outcome(try await fixture.prepareSharedWindow(expected:fixture.epoch)); expect(!result.prepared && Fixture.activateCount == 0 && Fixture.raiseCount == 0,"must not steal focus from another app") }
        catch { failures.append("background observation rejected") }
        fixture = reset(front:20)
        do { _ = try await fixture.prepareSharedWindow(expected:UUID()); failures.append("stopped epoch accepted") } catch {}
        if failures.isEmpty { print("PASS: actual preparation decision flow with synthetic focus/AX responses; no live AX capture claimed") }
        else { for failure in failures { print("FAIL: \(failure)") }; exit(1) }
    }
}
'''

config_fixture = r'''
import AppKit
func FixtureUnexpectedPermissionQuery() -> Bool { preconditionFailure("Config fixture must not query TCC or secure input") }
enum FixtureNoNetwork {
 static func data(for request:URLRequest) async throws -> (Data,URLResponse) { preconditionFailure("Config fixture must not send network requests") }
}
@MainActor final class FixturePanel {
    var canChooseFiles = false, canChooseDirectories = false, allowsMultipleSelection = false
    var message = ""
    var url: URL? = URL(fileURLWithPath:"/tmp/synthetic-folder")
    static var replacement: Data?
    func runModal() -> NSApplication.ModalResponse {
        if let replacement = Self.replacement { try! replacement.write(to: URL(fileURLWithPath:CommandLine.arguments[1]), options:.atomic) }
        return .OK
    }
}
@main struct Check {
    @MainActor static func main() async throws {
        try ComputerAction.check(); PhoneTarget.check(); RoutineReadPolicy.check()
        let url = URL(fileURLWithPath:CommandLine.arguments[1])
        let initial = Data(#"{"mcpServers":{"A":{"command":"synthetic-A"}}}"#.utf8)
        let replacement = Data(#"{ "mcpServers" : { "A" : {"command":"synthetic-A"}, "B" : {"command":"synthetic-B"} } }"#.utf8)
        let computer = ComputerController()
        let controller = NativeToolsController(computer:computer,token:"synthetic-unused")
        let paths=try controller.runtimePaths.get(),dataDir=url.deletingLastPathComponent().appendingPathComponent("Coding",isDirectory:true)
        precondition(paths.mcpConfig.path==url.path && paths.dataDir.path==dataDir.path && paths.providerMetadata.path==dataDir.appendingPathComponent("providers.json").path && paths.shutdown.path==dataDir.appendingPathComponent("shutdown",isDirectory:true).path,"All config fixture paths must remain inside its private directory")
        var failures = [String]()
        let image = CGContext(data:nil,width:1,height:1,bitsPerComponent:8,bytesPerRow:4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
        precondition(computer.directSelection == nil, "Config fixture must not retain any real application selection")
        let snapshot = ComputerController.AgentSnapshot(id:"synthetic",generation:computer.epoch,created:ProcessInfo.processInfo.systemUptime,bounds:CGRect(x:0,y:0,width:1,height:1),image:image,windows:[],focus:nil,cursor:.zero,documentURL:nil,documentFailure:nil,/* INPUT_FAILURE */chromeTitle:nil,controls:[:])
        do { _ = try await computer.performAgent("computer_key",arguments:[:],saved:snapshot); failures.append("foreground input accepted after focus preparation failed") }
        catch { if !error.localizedDescription.contains("Synthetic focus failure") { failures.append("foreground input did not reject the failed-preparation snapshot before dispatch") } }
        for previous in [initial, nil] as [Data?] {
            if let previous { try previous.write(to:url) } else { try? FileManager.default.removeItem(at:url) }
            FixturePanel.replacement = replacement
            do { _ = try await controller.configure("addFilesystem",expected:controller.epoch); failures.append("changed config must report a conflict") }
            catch { if !error.localizedDescription.lowercased().contains("changed") { failures.append("unexpected conflict error: \(error.localizedDescription)") } }
            if try Data(contentsOf:url) != replacement { failures.append("chooser overwrote another writer's exact configuration bytes") }
        }
        try initial.write(to:url); FixturePanel.replacement = nil
        _ = try await controller.configure("addFilesystem",expected:controller.epoch)
        let root = try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any]
        let servers = root["mcpServers"] as! [String:Any]
        if servers["A"] == nil || servers["files"] == nil { failures.append("ordinary add did not preserve existing server and add files") }
        let duplicate = try Data(contentsOf:url)
        _ = try await controller.configure("addFilesystem",expected:controller.epoch)
        if try Data(contentsOf:url) != duplicate { failures.append("duplicate preset rewrote config") }
        try FileManager.default.removeItem(at:url)
        _ = try await controller.configure("addFilesystem",expected:controller.epoch)
        let emptyRoot = try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any]
        if (emptyRoot["mcpServers"] as? [String:Any])?["files"] == nil { failures.append("missing config could not be created") }
        if failures.isEmpty { print("PASS: actual config flow preserves exact competing bytes and rejects conflict for existing/missing files; unchanged and duplicate presets work") }
        else { for failure in failures { print("FAIL: \(failure)") }; exit(1) }
    }
}
'''

capture_fixture = r'''
import Foundation
import CoreGraphics
struct CGImage { let width: Int; let height: Int }
struct Filter { let contentRect: CGRect }
final class SCStreamConfiguration {
    var width = 0, height = 0
    var scalesToFit = false, showsCursor = true, ignoreShadowsSingleWindow = false, includeChildWindows = true
}
enum SCScreenshotManager {
    static func captureImage(contentFilter: Filter, configuration: SCStreamConfiguration) async throws -> CGImage {
        precondition(configuration.scalesToFit, "Window pixels must fill the configured image canvas for screenshot coordinates to match AX bounds")
        precondition(!configuration.showsCursor && configuration.ignoreShadowsSingleWindow && !configuration.includeChildWindows)
        return CGImage(width:configuration.width, height:configuration.height)
    }
}
enum ComputerError: Error { case message(String) }
final class Capture {
    var filter: Filter? = Filter(contentRect:CGRect(x:0,y:0,width:380,height:232))
    let selected: Int? = 1
    func captureError(_ error: Error) -> Error { error }
    // CAPTURE_METHOD
    func legacyImage() async throws -> CGImage {
        // LEGACY_CAPTURE
        return image
    }
}
@main struct Check {
    static func main() async throws {
        let capture = Capture()
        for box in [CGRect(x:0,y:0,width:380,height:232), CGRect(x:0,y:0,width:2000,height:1000)] {
            capture.filter = Filter(contentRect:box)
            let image = try await capture.captureAgentImage(bounds:box)
            let scale = min(2,1600/max(box.width,box.height))
            precondition(image.width == Int(box.width*scale) && image.height == Int(box.height*scale))
            let legacy = try await capture.legacyImage()
            precondition(legacy.width == Int(box.width*min(2,1280/max(box.width,box.height))))
        }
        capture.filter = nil
        do { _ = try await capture.captureAgentImage(bounds:.zero); preconditionFailure("Stopped sharing must fail") }
        catch ComputerError.message { }
        print("PASS: actual agent and supervised capture configurations request full-canvas window scaling, retain limits and reject stopped sharing")
    }
}
'''

panel_fixture = r'''
import Foundation
class WKWebView {}
class WKFrameInfo {}
struct WKOpenPanelParameters { let allowsMultipleSelection: Bool }
enum Response { case OK, cancel }
@MainActor final class NSOpenPanel {
    var canChooseDirectories = false, allowsMultipleSelection = false, message = ""
    static var response = Response.OK
    var urls: [URL] { (allowsMultipleSelection ? ["one.json", "two.json"] : ["one.json"]).map { URL(fileURLWithPath:"/tmp/" + $0) } }
    func runModal() -> Response { Self.response }
}
@MainActor final class Delegate {
    // PANEL_METHOD
}
@main struct Check {
    @MainActor static func main() {
        let delegate = Delegate()
        for multiple in [false, true] {
            delegate.webView(WKWebView(), runOpenPanelWith:WKOpenPanelParameters(allowsMultipleSelection:multiple), initiatedByFrame:WKFrameInfo()) { urls in
                precondition(urls?.count == (multiple ? 2 : 1), "Native chooser must preserve the HTML input's multiple-file setting")
            }
        }
        NSOpenPanel.response = .cancel
        delegate.webView(WKWebView(), runOpenPanelWith:WKOpenPanelParameters(allowsMultipleSelection:true), initiatedByFrame:WKFrameInfo()) { urls in precondition(urls == nil) }
        print("PASS: actual native chooser honors single/multiple inputs and cancellation")
    }
}
'''

response_fixture = r'''
import Foundation
import CryptoKit

enum ComputerError: LocalizedError {
 case message(String)
 var errorDescription:String? {if case .message(let s)=self{return s};return nil}
}
func proposalContent(_ response:[String:Any],model:String) throws -> String {
    // RESPONSE_GUARD
    return content
}
// Observation capture and action parsing are inert here; the real parser is
// exercised by config. This target checks actual Observe's model/epoch wiring.
enum ComputerAction {
 struct Action {let action:String;let target:String;let text:String}
 static func validSnapshot(_ source:String,id:String,generation:UUID,current:UUID,created:TimeInterval,now:TimeInterval)->Bool {generation==current && now-created<180}
 static func parse(_ data:Data,targets:[String:String])throws->Action {let value=try JSONSerialization.jsonObject(with:data) as! [String:String];return Action(action:value["action"]!,target:value["target"]!,text:value["text"]!)}
}
@MainActor final class Observer {
 struct Control {let label:String;let operation:String}
 var controls=["fixture_control":Control(label:"Note",operation:"fill")],title="Synthetic practice",epoch=UUID()
 var propose:(([String:Any])async throws->[String:Any])?
 var proposal:(String,ComputerAction.Action,UUID,TimeInterval)?
 func discover(expected:UUID)async throws->String {"Synthetic discovery"}
 func snapshot()async throws->Data {Data([255,216,255,217])}
 func require(_ expected:UUID)throws {guard expected==epoch && !Task.isCancelled else{throw ComputerError.message("Stopped")}}
 func describe(_ action:ComputerAction.Action)->String {action.text}
 // OBSERVE_METHOD
}
// URLProtocol intercepts every request; no original server or socket is used.
final class ProposalProtocol:URLProtocol {
 static var started=0,stopped=0
 override class func canInit(with request:URLRequest)->Bool {true}
 override class func canonicalRequest(for request:URLRequest)->URLRequest {request}
 override func startLoading(){precondition(request.url?.absoluteString=="http://127.0.0.1:8787/api/tools/computerProposal");Self.started+=1}
 override func stopLoading(){Self.stopped+=1}
}
@MainActor final class ProposalTools {
 var epoch=UUID();let token="synthetic-unused-token",session:URLSession
 init(){let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[ProposalProtocol.self];session=URLSession(configuration:config)}
 // PROPOSAL_TOOLS_METHODS
}
@main struct Check {
 @MainActor static func main()async throws {
  let model="local/nonlegacy-8bit",content=#"{"action":"done","target":"","text":"Synthetic observation"}"#
  guard try proposalContent(["model":model,"content":content],model:model)==content else{exit(1)}
  for bad:[String:Any] in [["model":"wrong","content":content],["model":model,"content":String(repeating:"x",count:16001)],["model":model,"content":17],["content":content]] {
   do{_ = try proposalContent(bad,model:model);print("FAIL: invalid proposal exposed");exit(1)}catch{}
  }
  let observer=Observer();var calls=0
  observer.propose={input in calls+=1;precondition(input["model"] as? String==model && input["task"] as? String=="Inspect only" && input["controls"] is [[String:String]] && (input["image"] as? String)?.hasPrefix("data:image/jpeg;base64,")==true);return ["model":model,"content":content]}
  let result=try await observer.observe("Inspect only",model:model,expected:observer.epoch)
  precondition(calls==1 && result["proposal"] as? String=="Synthetic observation" && observer.proposal==nil)
  observer.propose={_ in calls+=1;observer.epoch=UUID();return ["model":model,"content":content]}
  do{_ = try await observer.observe("Inspect only",model:model,expected:observer.epoch);print("FAIL: late proposal survived Stop");exit(1)}catch{}
  precondition(calls==2 && observer.proposal==nil)
  let tools=ProposalTools();let request=Task{try await tools.computerProposal(["model":model])}
  for _ in 0..<100 {if ProposalProtocol.started>0{break};try await Task.sleep(for:.milliseconds(5))}
  precondition(ProposalProtocol.started==1);request.cancel()
  do{_ = try await request.value;print("FAIL: cancelled proposal returned");exit(1)}catch{}
  for _ in 0..<100 {if ProposalProtocol.stopped>0{break};try await Task.sleep(for:.milliseconds(5))}
  precondition(ProposalProtocol.stopped==1)
  tools.session.invalidateAndCancel()
  print("PASS: actual manual Observe uses captured nonlegacy model and controls; exact response identity, bounds, late Stop rejection and actual signed URLSession Task cancellation")
 }
}
'''

with tempfile.TemporaryDirectory(prefix="qwen-native-repair-") as directory:
    work = pathlib.Path(directory)
    if "--errors-only" in sys.argv:
        check = work / "Errors.swift"
        check.write_text("""import Foundation
@main struct Check {static func main(){
 let cases:[(Error,String)]=[(CodingTemporary.fail("Preview cannot read linked files"),"Preview cannot read linked files"),(CodingSkills.Failure(code:"changed",description:"Skill changed; refresh inventory"),"Skill changed; refresh inventory")]
 for (error,expected) in cases {guard error.localizedDescription==expected else {print("FAIL: explicit native error message lost");exit(1)}}
 print("PASS: actual preview and skill errors retain corrective localized messages")
}}
""")
        output = work / "errors"
        subprocess.run(["xcrun","swiftc","-parse-as-library","-target","arm64-apple-macos15.2",str(check),*[str(source / name) for name in ["CodingTemporary.swift","HandoffFiles.swift","CodingSkills.swift"]],"-o",str(output)],check=True)
        sys.exit(subprocess.run([str(output)]).returncode)
    if "--agent-step-only" in sys.argv:
        native_tools = (source / "Tools.swift").read_text()
        bridge_start = native_tools.index("    func userContentController(")
        bridge_end = native_tools.index("    private func execute(", bridge_start)
        bridge = native_tools[bridge_start:bridge_end]
        branches_start = bridge.index('                case ', bridge.index('switch op {'))
        selected_start = bridge.index('                case "agentStep":')
        selected_end = bridge.index('                default: throw ComputerError.message("Unknown native operation.")')
        bridge = bridge[:branches_start] + bridge[selected_start:selected_end] + bridge[selected_end:]
        stop_start = native_tools.index("    func stop() {", native_tools.index("final class NativeToolsController"))
        stop_end = native_tools.index("    private func request(", stop_start)
        methods = native_tools[bridge_end:native_tools.index("    private func chooseCodingFolder(", bridge_end)].replace("private ", "")
        policy = native_tools[native_tools.index("private enum NativeAgentStep {"):native_tools.index("@MainActor\nfinal class NativeToolsController")].replace("private ", "")
        policies = native_tools[native_tools.index("enum CodingControlPolicy {"):native_tools.index("enum ShutdownInspection {")]
        fixture = agent_step_fixture.replace("// SCOPED_STOP",scoped_stop_source(native_tools)).replace("// POLICIES",policies).replace("// AGENT_POLICY",policy).replace("// SKILLS_STUB",skills_stub).replace(" // STOP_METHODS",native_tools[stop_start:stop_end].replace("private ","")).replace(" // BRIDGE_METHOD",bridge).replace(" // AGENT_METHODS",methods)
        (work / "AgentStep.swift").write_text(fixture)
        output = work / "agent-step"
        subprocess.run(["xcrun","swiftc","-parse-as-library","-target","arm64-apple-macos15.2",str(work / "AgentStep.swift"),str(source / "CodingMCPSetup.swift"),"-o",str(output)],check=True)
        sys.exit(subprocess.run([str(output)]).returncode)
    if "--quit-only" in sys.argv:
        (work / "Quit.swift").write_text(quit_source((source / "App.swift").read_text()))
        output = work / "quit"
        subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos15.2", str(work / "Quit.swift"), "-o", str(output)], check=True)
        sys.exit(subprocess.run([str(output)]).returncode)
    app = (source / "App.swift").read_text()
    if "--worktrees-only" not in sys.argv and "--lifecycle-only" not in sys.argv:
        start = app.index("    func webView(_ webView: WKWebView, runOpenPanelWith")
        end = app.index("    func webView(_ webView: WKWebView, navigationAction:", start)
        (work / "Panel.swift").write_text(panel_fixture.replace("    // PANEL_METHOD", app[start:end]))
        computer = (source / "Computer.swift").read_text()
        response_start = computer.index('        guard response["model"] as? String == model', computer.index("    private func observe("))
        response_end = computer.index("        guard ComputerAction.validSnapshot", response_start)
        observe_start=computer.index("    private func observe(")
        observe_end=computer.index("    private func describe(",observe_start)
        proposal_tools=(source / "Tools.swift").read_text()
        tools_begin=proposal_tools.index("    func computerProposal(")
        tools_end=proposal_tools.index("    private func approve(",tools_begin)
        require_begin=proposal_tools.index("    private func require(",proposal_tools.index("final class NativeToolsController"))
        require_end=proposal_tools.index("    private func request(",require_begin)
        proposal_methods=(proposal_tools[require_begin:require_end]+proposal_tools[tools_begin:tools_end]).replace("private ","")
        (work / "Response.swift").write_text(response_fixture.replace("    // RESPONSE_GUARD", computer[response_start:response_end]).replace(" // OBSERVE_METHOD",computer[observe_start:observe_end].replace("private ","")).replace(" // PROPOSAL_TOOLS_METHODS",proposal_methods))
        start = computer.index("    private func prepareSharedWindow(")
        end = computer.index("    private func scoped(", start)
        method = computer[start:end].replace("private func", "func", 1)
        for original, substitute in {
            "NSWorkspace": "FixtureWorkspace", "NSRunningApplication": "FixtureApp",
            "AXIsProcessTrusted": "FixtureTrusted", "AXUIElementCreateApplication": "FixtureAXCreateApplication",
            "AXUIElementGetTypeID": "FixtureAXGetTypeID", "AXUIElementPerformAction": "FixtureAXPerformAction",
        }.items():
            method = method.replace(original, substitute)
        (work / "Focus.swift").write_text(focus_fixture.replace("    // PREPARE_METHOD", method))
        capture_start = computer.index("    private func captureAgentImage(")
        capture_end = computer.index("    private func confirmAgent(", capture_start)
        capture_method = computer[capture_start:capture_end].replace("private func", "func", 1)
        legacy_start = computer.index("        guard let filter, selected != nil else", computer.index("    private func snapshot()"))
        legacy_end = computer.index("        guard let data = NSBitmapImageRep", legacy_start)
        (work / "Capture.swift").write_text(capture_fixture.replace("    // CAPTURE_METHOD", capture_method).replace("        // LEGACY_CAPTURE", computer[legacy_start:legacy_end]))
        tools = (source / "Tools.swift").read_text().replace("private ", "")
        paths_line = 'let runtimePaths:Result<OwnedRuntimePaths,Error> = Result {try OwnedRuntimePaths(resources:Bundle.main.resourceURL)}'
        assert tools.count(paths_line) == 1, "Owned runtime initialization changed; inspect fixture isolation before running"
        assert [line.strip() for line in tools.splitlines() if "runtimePaths.get()" in line] == [
            'let path=try runtimePaths.get().shutdown.path',
            'let paths=try runtimePaths.get()',
            *['let configURL=try runtimePaths.get().mcpConfig'] * 3,
        ], "Owned runtime consumers changed; inspect every fixture path before running"
        # Use the actual fail-closed parser with fixture-owned resources. Every
        # derived config/provider/shutdown path remains inside this private tempdir.
        resources = work / "synthetic-resources"
        resources.mkdir(mode=0o700)
        (work / "Coding").mkdir(mode=0o700)
        runtime_config = resources / "owned-runtime.json"
        runtime_config.write_text(json.dumps({"dataDir": str(work / "Coding"), "executor": {}, "limits": {}}))
        runtime_config.chmod(0o600)
        fixture_paths = 'let runtimePaths:Result<OwnedRuntimePaths,Error> = Result {try OwnedRuntimePaths(resources:URL(fileURLWithPath:CommandLine.arguments[1]).deletingLastPathComponent().appendingPathComponent("synthetic-resources",isDirectory:true))}'
        tools = tools.replace(paths_line, fixture_paths).replace("NSOpenPanel()", "FixturePanel()")
        runtime_line = 'guard let resources=Bundle.main.resourceURL, let node=["/opt/homebrew/bin/node","/usr/local/bin/node"].first(where:{FileManager.default.isExecutableFile(atPath:$0)}) else { throw ComputerError.message("Node runtime is unavailable.") }'
        assert tools.count(runtime_line) == 1, "Config runtime selection changed; inspect fixture isolation before running"
        tools = tools.replace(runtime_line, 'let resources=configURL.deletingLastPathComponent().appendingPathComponent("synthetic-resources"), node=resources.appendingPathComponent("synthetic-node").path')
        assert tools.count("session.data(for:") == 1, "Tools network boundary changed; inspect before running"
        tools = tools.replace("session.data(for:", "FixtureNoNetwork.data(for:")
        (work / "Tools.swift").write_text(tools)
        assert computer.count("session.data(for:") == 0, "Computer must use its injected signed proposal boundary, never direct model networking"
        isolated_computer = computer.replace("private ", "").replace("session.data(for:", "FixtureNoNetwork.data(for:")
        for query in ["AXIsProcessTrusted()", "CGPreflightPostEventAccess()", "CGPreflightScreenCaptureAccess()", "IsSecureEventInputEnabled()"]:
            assert query in isolated_computer, "Permission boundary changed; inspect fixture isolation before running"
            isolated_computer = isolated_computer.replace(query, "FixtureUnexpectedPermissionQuery()")
            assert query[:-2] not in isolated_computer, "Unreplaced permission boundary; inspect fixture isolation before running"
        (work / "Computer.swift").write_text(isolated_computer)
        input_failure = 'foregroundInputFailure:"Synthetic focus failure",' if "let foregroundInputFailure: String?" in computer else ""
        (work / "Config.swift").write_text(config_fixture.replace("/* INPUT_FAILURE */", input_failure))
    native_tools = (source / "Tools.swift").read_text()
    # Retain real admission, Task/authentication, worktree branch and reply handling.
    # Only unrelated operation branches are omitted; requests/review are inert spies.
    bridge_start = native_tools.index("    func userContentController(")
    bridge_end = native_tools.index("    private func execute(", bridge_start)
    bridge = native_tools[bridge_start:bridge_end]
    branches_start = bridge.index('                case ', bridge.index('switch op {'))
    worktree_branch = bridge[bridge.index('                case "codingWorktrees":'):bridge.index('                case "coding":')]
    branches_end = bridge.index('                default: throw ComputerError.message("Unknown native operation.")')
    bridge = bridge[:branches_start] + worktree_branch + bridge[branches_end:]
    policies = native_tools[native_tools.index("enum CodingControlPolicy {"):native_tools.index("enum ShutdownInspection {")]
    require_start = native_tools.index("    private func require(", native_tools.index("final class NativeToolsController"))
    require_end = native_tools.index("    private func request(", require_start)
    worktree_start = native_tools.index("    private func worktrees(")
    worktree_end = native_tools.index("    private func gitWorkflow(", worktree_start)
    actual_checks = ""
    if evidence_path:
        # Read retained JSON only; never invoke its engine, native helper, or Git.
        evidence = json.loads(evidence_path.read_text())
        actual = []
        for move in evidence.get("moves", []):
            result = move["result"]
            directory = pathlib.Path(result["handoff"]["recoveryDirectory"])
            manifest = json.loads((directory / "manifest.json").read_text())
            plan = {key: manifest[key] for key in ["id", "worktreeId", "source", "destination"]}
            plan.update(operation="handoff", rootThreadId=manifest["family"]["rootThreadId"],
                        branch=manifest["candidate"]["branch"],
                        family=[{key: row[key] for key in ["id", "archived"]} for row in manifest["family"]["members"]],
                        files=sum(len(row["stamps"]) for row in manifest["native"].values()),
                        bytes=sum(row["bytes"] for row in manifest["native"].values()),
                        nativePolicy=manifest["stages"]["policy"],
                        synthesized={label: manifest["stages"][label]["synthesized"] for label in ["source", "destination"]},
                        recoveryDirectory=str(directory), expiresAt=0)
            actual.append({"plan": plan, "result": result, "input": {"action": "handoff", "id": plan["worktreeId"], "threadId": plan["rootThreadId"]}})
        for recovery in evidence.get("recoveries", []):
            plan = recovery["plan"]
            actual.append({"plan": plan, "result": recovery["result"], "input": {"action": "recoverHandoff", "id": plan["handoffId"], "mode": plan["mode"]}})
        assert actual, "Saved handoff evidence contains no completed moves or recoveries"
        encoded = base64.b64encode(json.dumps(actual).encode()).decode()
        actual_checks = r'''
  let actual=try! JSONSerialization.jsonObject(with:Data(base64Encoded:"ENCODED")!) as! [[String:Any]]
  for (index,row) in actual.enumerated() {
   var plan=row["plan"] as! [String:Any];plan["expiresAt"]=floor(Date().timeIntervalSince1970*1000)+60000
   let input=row["input"] as! [String:Any]
   let f=Fixture();f.authenticate={true};f.prepareReply=["plan":plan];f.completionReply=row["result"] as? [String:Any]
   let reply=f.send(input);await until{reply.called}
   expect(reply.error==nil && reply.value?["handoff"] != nil && f.approvals==(input["action"] as? String=="recoverHandoff" ? 2:1) && f.executed.count==1 && f.executed.first?["planId"] as? String==plan["id"] as? String,"Saved actual handoff \(index) was not accepted: \(reply.error ?? "missing completion")")
  }
  print("Checked \(actual.count) saved manager handoff/recovery plans/results; JSON evidence only")
'''.replace("ENCODED", encoded)
    (work / "Worktrees.swift").write_text(worktree_fixture.replace("// SCOPED_STOP",scoped_stop_source(native_tools)).replace("// POLICIES",policies).replace("// SKILLS_STUB",skills_stub).replace(" // REQUIRE_METHOD",native_tools[require_start:require_end].replace("private ","")).replace(" // BRIDGE_METHOD",bridge).replace(" // WORKTREE_METHOD",native_tools[worktree_start:worktree_end].replace("private ","")).replace("  // ACTUAL_HANDOFF",actual_checks))
    if "--worktrees-only" in sys.argv:
        output = work / "worktrees"
        subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos15.2", str(work / "Worktrees.swift"), str(source / "CodingMCPSetup.swift"), "-o", str(output)], check=True)
        sys.exit(subprocess.run([str(output)]).returncode)
    stop_start = native_tools.index("    func stop() {",native_tools.index("final class NativeToolsController"))
    stop_end = native_tools.index("    private func request(",stop_start)
    handler = next(line.strip() for line in app.splitlines() if "process.terminationHandler =" in line)
    (work / "Lifecycle.swift").write_text(lifecycle_fixture.replace("// SCOPED_STOP",scoped_stop_source(native_tools)).replace("// POLICIES",policies).replace("// SKILLS_STUB",skills_stub).replace(" // STOP_METHODS",native_tools[stop_start:stop_end].replace("private ","")).replace(" // TERMINATION_HANDLER",handler))
    (work / "Quit.swift").write_text(quit_source(app))
    failures = 0
    # These actual dependencies are compiled, but the config checks never invoke
    # their project/retained-state readers. No app entry point is included.
    setup_dependency = source / "CodingMCPSetup.swift"
    config_dependencies = [source / name for name in [
        "CodingTemporary.swift", "HandoffFiles.swift", "CodingFilePreview.swift", "CodingSkills.swift",
        "CodingSkillsSession.swift", "CodingQueue.swift", "CodingMCPReview.swift", "OwnedRuntimePaths.swift", "CodingProvisioning.swift",
        "CodingDiskReclamation.swift", "HandoffProcess.swift", "GuestDiskDisposal.swift",
    ]] + [setup_dependency]
    for name, files in [("worktrees", [work / "Worktrees.swift", setup_dependency]), ("lifecycle", [work / "Lifecycle.swift", setup_dependency]), ("quit", [work / "Quit.swift"]), ("response", [work / "Response.swift"]), ("capture", [work / "Capture.swift"]), ("panel", [work / "Panel.swift"]), ("focus", [work / "Focus.swift"]), ("config", [work / "Computer.swift", work / "Tools.swift", work / "Config.swift", *config_dependencies])]:
        if "--worktrees-only" in sys.argv and name != "worktrees":
            continue
        if "--lifecycle-only" in sys.argv and name not in ("lifecycle","quit"):
            continue
        output = work / name
        subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos15.2", *map(str, files), "-o", str(output)], check=True)
        result = subprocess.run([str(output), str(work / "mcp.json")])
        failures += result.returncode != 0
    sys.exit(1 if failures else 0)
