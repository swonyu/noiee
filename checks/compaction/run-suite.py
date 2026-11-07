"""Run only isolated compaction/recovery fixtures; never launch the app or real model."""
from pathlib import Path
import argparse,datetime,hashlib,json,os,subprocess,sys,uuid
ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser()
parser.add_argument("--node",default="/opt/homebrew/bin/node")
args=parser.parse_args()
node=Path(args.node).resolve(strict=True)
OUT=ROOT/".artifacts/compaction/runs"/(datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+uuid.uuid4().hex[:8])
OUT.mkdir(parents=True)
(ROOT/".artifacts/compaction").mkdir(parents=True,exist_ok=True)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def source_pins():
 result={}
 for directory,dirs,files in os.walk(ROOT/"source",followlinks=False):
  dirs[:]=sorted(name for name in dirs if name!="node_modules")
  for name in sorted(files):
   path=Path(directory)/name
   if path.is_symlink():raise RuntimeError("Unexpected source file symlink: "+str(path))
   result[str(path.relative_to(ROOT/"source"))]=sha(path)
 return result
before=source_pins()
specs=[
 ("manual-check.mjs",22),("chunked-check.mjs",33),("ui-handler-check.mjs",6),("review-r2-check.mjs",23),
 ("state-races-check.mjs",29),("recovery-ui-check.mjs",11),
 ("recovery-native-check.py",14),("browser-check.mjs",13)
]
rows=[]
for name,expected in specs:
 script=Path(__file__).resolve().parent/name
 command=[sys.executable,str(script)] if name.endswith(".py") else [str(node),"--preserve-symlinks",str(script)]
 result=subprocess.run(command,cwd=ROOT,text=True,capture_output=True)
 log=OUT/(name+".log");log.write_text(result.stdout+result.stderr)
 summaries=[]
 for line in result.stdout.splitlines():
  try:
   value=json.loads(line)
   if isinstance(value,dict) and "passed" in value and "failed" in value:summaries.append(value)
  except (ValueError,TypeError):pass
 summary=summaries[-1] if summaries else {}
 ok=result.returncode==0 and summary.get("failed")==0 and summary.get("passed")==expected
 row={"name":name,"command":command,"exitCode":result.returncode,"expected":expected,"passed":summary.get("passed",0),"failed":summary.get("failed",1),"qualified":ok,"scriptSHA256":sha(script),"logPath":str(log),"logSHA256":sha(log),"summary":summary}
 rows.append(row)
 print(("PASS " if ok else "FAIL ")+name+" "+str(row["passed"])+"/"+str(expected),flush=True)
 if not ok:print((result.stdout+result.stderr)[-5000:],flush=True)
after=source_pins()
report={"schemaVersion":1,"root":str(ROOT),"source":str(ROOT/"source"),"node":{"path":str(node),"version":subprocess.check_output([str(node),"--version"],text=True).strip(),"sha256":sha(node)},"nodeModulesRealPath":str((ROOT/"source/node_modules").resolve()),"sourcePins":before,"sourceUnchanged":before==after,"checks":rows,"passed":sum(row["passed"] for row in rows),"failed":sum(0 if row["qualified"] else 1 for row in rows)+(before!=after),"limitations":["Fake inference only; no live-model quality/performance claim.","Swift recovery method is compiled with fake dialogs/transports; integrated native build remains a release gate.","Browser data/profile use a unique Caches directory to avoid macOS provenance metadata writes in Documents. Logs, reports and screenshots remain under .artifacts.","Explicit resumable UTF-8 fragments use a 24,000-byte input envelope and 12,000-byte compaction-only carry/output budget. Partial exchanges stay fully projected; no automatic inference/replay.","All attempt records are retained within 64 current + 2,048 archived records and 32 MiB compaction metadata; existing 256 MiB chat snapshot and 128 MiB backend receipt-store bounds remain."]}
report["exitCode"]=0 if report["failed"]==0 else 1
path=OUT/"RESULT.json";path.write_text(json.dumps(report,indent=2)+"\n")
print(json.dumps({"report":str(path),"sha256":sha(path),"passed":report["passed"],"failed":report["failed"],"sourceUnchanged":report["sourceUnchanged"]}),flush=True)
raise SystemExit(0 if report["failed"]==0 else 1)
