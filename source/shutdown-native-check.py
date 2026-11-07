"""Compile the actual read-only shutdown inspector against disposable records."""
from pathlib import Path
import subprocess, tempfile, json

source=Path(__file__).resolve().parent
text=(source/'Tools.swift').read_text()
assert 'enum ShutdownInspection {' in text, 'Native shutdown inspection is missing'
body=text[text.index('enum ShutdownInspection {'):text.index('@MainActor\nfinal class NativeToolsController')]
app=(source/'App.swift').read_text()
refresh=app[app.index('    @objc private func refreshShutdownInspection()'):app.index('    private func dismissShutdownInspection()')].replace('@objc private func','func')
fixture=r'''
import Foundation
import CoreFoundation
import Darwin
enum ComputerError: LocalizedError {case message(String);var errorDescription:String? {switch self {case .message(let s):return s}}}
// INSPECTION
@MainActor final class InspectionText { var string="" }
@MainActor final class InspectionButton { var isEnabled=true }
@MainActor final class PendingStatus {
 var requests=0,pending=[CheckedContinuation<String,Never>]()
 func shutdownStatus() async -> String {requests+=1;return await withCheckedContinuation{pending.append($0)}}
}
@MainActor final class InspectionOwner {
 var shutdownReport:InspectionText?=InspectionText(),shutdownRefresh:InspectionButton?=InspectionButton(),shutdownInspectionRefreshing=false
 let tools=PendingStatus()
 // REFRESH
}
@main struct Check {
 @MainActor static func until(_ check:()->Bool) async {for _ in 0..<1000{if check(){return};try? await Task.sleep(for:.milliseconds(1))};preconditionFailure("Replacement inspection was not refreshed")}
 @MainActor static func main() async throws {
  let owner=InspectionOwner();owner.refreshShutdownInspection();await until{owner.tools.pending.count==1}
  owner.shutdownReport=InspectionText();owner.refreshShutdownInspection();owner.tools.pending.removeFirst().resume(returning:"old")
  await until{owner.tools.requests==2};owner.tools.pending.removeFirst().resume(returning:"new")
  await until{!owner.shutdownInspectionRefreshing};precondition(owner.shutdownReport?.string=="new")
  let actual=ShutdownInspection.saved(CommandLine.arguments[2]);precondition(actual.contains("Outcome: closed") && actual.contains("Malformed or unsupported: 0"))
  let root=URL(fileURLWithPath:CommandLine.arguments[1]),fm=FileManager.default
  func write(_ name:String,_ record:[String:Any]) throws {let p=root.appendingPathComponent(name).path;try JSONSerialization.data(withJSONObject:record).write(to:URL(fileURLWithPath:p));precondition(chmod(p,0o600)==0)}
  let id=UUID().uuidString.lowercased(),names=["command","inference","tools","worktrees","git","schedules","coding"]
  let record:[String:Any]=["version":1,"id":id,"pid":123,"startedAt":1000,"requestedAt":2000,"updatedAt":3000,"revision":2,"trigger":"parent-eof","state":"pending","executionRevoked":NSNull(),"subsystems":Dictionary(uniqueKeysWithValues:names.map{($0,$0=="coding" ? "pending":"closed")})]
  precondition(ShutdownInspection.saved(root.appendingPathComponent("absent").path).contains("No saved shutdown records"))
  precondition(ShutdownInspection.saved(root.path).contains("No completed record files"))
  try write(id+".json",record)
  let pending=ShutdownInspection.saved(root.path)
  precondition(pending.contains("Previous-run snapshots") && pending.contains("coding: pending") && pending.contains("no recorded terminal outcome"))
  let live=try ShutdownInspection.live(["record":record,"persistence":"saved","savedRevision":2])
  precondition(live.contains("Live signed status") && live.contains("Durability: saved"))
  var bad=record;bad["pid"]=true
  do{_=try ShutdownInspection.render(bad);preconditionFailure("Boolean PID accepted")}catch{}
  bad=record;bad["executionRevoked"]=1
  do{_=try ShutdownInspection.render(bad);preconditionFailure("Numeric revocation accepted")}catch{}
  bad=record;bad["secret"]="SECRET_PASSWORD"
  do{_=try ShutdownInspection.render(bad);preconditionFailure("Extra field accepted")}catch{}
  try write(id+".json",bad)
  let malformed=ShutdownInspection.saved(root.path);precondition(malformed.contains("Malformed or unsupported: 1") && !malformed.contains("SECRET"))
  try write(id+".json",record);precondition(chmod(root.appendingPathComponent(id+".json").path,0o644)==0)
  precondition(ShutdownInspection.saved(root.path).contains("Unsafe or unreadable: 1"))
  try fm.removeItem(at:root.appendingPathComponent(id+".json"))
  try fm.createSymbolicLink(atPath:root.appendingPathComponent(id+".json").path,withDestinationPath:"/etc/passwd")
  precondition(ShutdownInspection.saved(root.path).contains("Unsafe or unreadable: 1"))
  try fm.removeItem(at:root.appendingPathComponent(id+".json"))
  precondition(mkfifo(root.appendingPathComponent(id+".json").path,0o600)==0)
  precondition(ShutdownInspection.saved(root.path).contains("Unsafe or unreadable: 1"))
  try fm.removeItem(at:root.appendingPathComponent(id+".json"))
  for n in 0..<258{try Data().write(to:root.appendingPathComponent("ignored-\(n)"))}
  precondition(ShutdownInspection.saved(root.path).contains("Inspection limited"))
  print("PASS: actual native parser, live status, missing/empty/history, malformed schema, private file checks, symlink/FIFO refusal, and bounded directory scan")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='shutdown-native-') as temp:
    work=Path(temp).resolve(); records=work/'records';records.mkdir(mode=0o700)
    swift=work/'Check.swift';swift.write_text(fixture.replace('// INSPECTION',body).replace('// REFRESH',refresh))
    subprocess.run(['xcrun','swiftc','-parse-as-library',str(swift),str(source/'CodingTemporary.swift'),str(source/'HandoffFiles.swift'),'-o',str(work/'check')],check=True)
    actual=work/'actual'
    code='import {ShutdownDiagnostics} from '+json.dumps((source/'shutdown-diagnostics.mjs').as_uri())+';const d=new ShutdownDiagnostics('+json.dumps(str(actual))+');d.begin("parent-eof");for(const name of Object.keys(d.record.subsystems))d.observe(name,{stopped:true});if(!await d.finish({stopped:true,results:{coding:{executionRevoked:false}}}))process.exit(1);'
    subprocess.run(['/opt/homebrew/bin/node','--input-type=module','-e',code],check=True)
    subprocess.run([str(work/'check'),str(records),str(actual/'shutdown')],check=True,timeout=15)
