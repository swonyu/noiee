import subprocess, tempfile
from pathlib import Path
source=Path(__file__).with_name("Tools.swift").read_text()
policy=source[source.index("enum CodingGitPolicy {"):source.index("// Read-only diagnostics; process IDs")]
swift='''import Foundation
'''+policy+'''
let id="11111111-1111-4111-8111-111111111111"
let core:[String:Any] = ["action":"publishBranch","threadId":"fixture","snapshotId":id,"requestId":id,"remoteSnapshotId":id]
precondition(CodingGitPolicy.action(core)=="publishBranch","Missing native publication policy")
var pr=core;pr["action"]="createPR";pr["title"]="Draft";pr["body"]=""
precondition(CodingGitPolicy.action(pr)=="createPR")
var inspect:[String:Any] = ["action":"remoteInspect","threadId":"fixture","snapshotId":id,"requestId":id,"remote":"origin","branch":"feature/مرحبا","base":"main"]
precondition(CodingGitPolicy.action(inspect)=="remoteInspect")
let saved:[String:Any] = ["action":"inspectRemoteOutcome","threadId":"fixture","requestId":id]
precondition(CodingGitPolicy.action(saved)=="inspectRemoteOutcome")
var ack=saved;ack["action"]="acknowledgeRemoteOutcome";ack["observationId"]=id
precondition(CodingGitPolicy.action(ack)=="acknowledgeRemoteOutcome")
for input in [core,pr,inspect,saved,ack] {var bad=input;bad["cwd"]="/other";precondition(CodingGitPolicy.action(bad)==nil)}
for key in ["remoteSnapshotId","snapshotId","requestId"] {var bad=core;bad[key]="wrong";precondition(CodingGitPolicy.action(bad)==nil)}
for title in ["",String(repeating:"x",count:257),"a\\nb"] {var bad=pr;bad["title"]=title;precondition(CodingGitPolicy.action(bad)==nil)}
var bad=pr;bad["body"]=String(repeating:"é",count:32769);precondition(CodingGitPolicy.action(bad)==nil)
for branch in ["-x","refs/heads/main","HEAD","a..b","a/.secret","a.lock","a b"] {inspect["branch"]=branch;precondition(CodingGitPolicy.action(inspect)==nil)}
print("PASS native GitHub request fields, Unicode/byte limits, branches and saved-outcome token policy")
'''
with tempfile.TemporaryDirectory(prefix="saleh-github-native-") as folder:
    path=Path(folder)/"main.swift";path.write_text(swift)
    subprocess.run(["/usr/bin/swift",str(path)],check=True)
