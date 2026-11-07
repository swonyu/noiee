"""Fresh current-source Fetch qualification. The reviewed dependent sequence is unchanged."""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,sys,tempfile,uuid
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2];SOURCE=ROOT/"source"
PYTHON=Path("/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/bin/python3.14")
NODE=Path("/opt/homebrew/bin/node").resolve(strict=True)
CACHE=Path(tempfile.mkdtemp(prefix="NoieeFetchQualification172-",dir="/Users/saleh/Library/Caches"))
CHECKS=CACHE/"checks";CHECKS.mkdir(mode=0o700)
CROSS=CACHE/"cross-recovery";CROSS.mkdir(mode=0o700);(CROSS/"fixtures").mkdir(mode=0o700)
for name in ["tmp","swift-cache"]:(CACHE/name).mkdir(mode=0o700)
OUT=ROOT/".artifacts/integration"/("fetch-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+uuid.uuid4().hex[:8]);OUT.mkdir(parents=True)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def ref(path):return {"path":str(path),"sha256":sha(path)}
def pins():return {p.name:sha(p) for p in sorted(SOURCE.iterdir()) if p.is_file() and not p.is_symlink()}
def save(path,value):path.write_text(json.dumps(value,indent=2)+"\n");path.chmod(0o600)
before=pins();manifest=json.loads((HERE/"TEMPLATES.json").read_text());adapted=[]
old_root="/Users/saleh/Library/Caches/NoieeFetchQualification-current-ds23jv0w"
old_checks="/Users/saleh/Documents/Noiee/checks/fetch/current-runtime"
old_source="/Users/saleh/Documents/Noiee/source"
for item in manifest["files"]:
 template=HERE/"templates"/item["template"];assert sha(template)==item["sha256"]
 text=template.read_text().replace(old_root,str(CACHE)).replace(old_checks,str(CHECKS)).replace(old_source,str(SOURCE))
 target=CHECKS/item["template"].removesuffix(".in");target.write_text(text);target.chmod(0o600)
 adapted.append({"template":ref(template),"generatedPath":str(target),"routingOnly":True})
env={key:os.environ[key] for key in ["HOME","USER","LOGNAME"] if key in os.environ}
env.update(PATH="/opt/homebrew/bin:/usr/bin:/bin",LANG="C",TMPDIR=str(CACHE/"tmp")+"/",PYTHONDONTWRITEBYTECODE="1")
rows=[]
def run(name,command,timeout=180):
 log=OUT/(name+".log")
 with log.open("xb") as stream:r=subprocess.run(command,cwd=CACHE,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,timeout=timeout)
 row={"name":name,"command":command,"exitCode":r.returncode,"log":ref(log)};rows.append(row);print(json.dumps(row),flush=True)
 if r.returncode:print(log.read_text()[-12000:],flush=True);raise RuntimeError(name+" failed")
result={"schemaVersion":1,"name":"fetch","sourceDirectory":str(SOURCE),"sourcePins":before,"fixtureDirectory":str(CACHE),"rows":rows,"adaptations":adapted,"sequence":["installer17","native14","guards9","durable6","UI6","admission7","recoveryCross15"],"scope":"74 fresh isolated Fetch checks, using only generated private runtime payload copies/fake transports. No external installation, real model, original config/data or native UI."}
try:
 assert SOURCE.stat().st_mode&0o077==0,"Strict legacy wrapper requires the source directory to remain private (0700); no mode is silently changed."
 for fixture,binary in [("FetchPluginCheck.swift","fetch-native-check"),("FetchPluginClientFixture.swift","fetch-native-client")]:
  run(binary+"-compile",["/usr/bin/xcrun","swiftc","-parse-as-library","-target","arm64-apple-macos15.2","-module-cache-path",str(CACHE/"swift-cache"),str(SOURCE/"FetchPlugin.swift"),str(CHECKS/fixture),"-o",str(CHECKS/binary)])
 # Keep the original wrapper's strict input pins, refreshed only for exact routed templates
 # and newly compiled fixtures. Qualified Python/Node executable pins are not changed.
 wrapper=CHECKS/"fetch-native-suite.py";text=wrapper.read_text();start=text.index("PINS={");end=text.index("\nRUNTIMES=",start)
 fixed=["test-fetch-plugin.py","fetch-native-check","fetch-native-client","fetch-guards-check.mjs","fetch-durable-check.mjs","model-http171-stdio-guard.mjs"]
 text=text[:start]+"PINS="+repr({name:(sha(CHECKS/name),(CHECKS/name).stat().st_size) for name in fixed})+text[end:];wrapper.write_text(text);wrapper.chmod(0o600)
 files=["FetchPlugin.swift","fetch-plugin-runtime.py","fetch-runtime-v20261024-manifest.json","managed-fetch.mjs","mcp.mjs","mcp-recovery.mjs","mcp-transport.mjs","agent.mjs","server.mjs","chat-runs.mjs","tools.js","index.html"]
 details={name:{"absolutePath":str(SOURCE/name),"sha256":sha(SOURCE/name),"bytes":(SOURCE/name).stat().st_size} for name in files}
 save(CHECKS/"SOURCE-BEFORE.json",details)
 save(CHECKS/"ADAPTATION.json",{"root":str(CACHE),"checks":str(CHECKS),"source":str(SOURCE),"crossRoot":str(CROSS),"sequence":result["sequence"][:4],"sourcePins":details,"fixturePins":{p.name:ref(p) for p in CHECKS.iterdir() if p.is_file()},"changes":"Only exact source/check/output namespace routing and freshly compiled fixture pins; all behavioral assertions and runtime/environment/socket guards retained."})
 save(CROSS/"SOURCE-BEFORE.json",{"files":details,"dependencyRealpath":str((SOURCE/"node_modules").resolve())})
 shutil.copyfile(CHECKS/"fake-endpoints.mjs",CROSS/"fake-endpoints.mjs")
 run("sequential-fetch-qualification",[str(PYTHON),"-I","-B",str(CHECKS/"run-qualification.py")],600)
 actual=json.loads((CHECKS/"RESULT.json").read_text())
 assert actual["passed"]==74 and actual["failed"]==0 and actual["sourceUnchanged"] is True
 assert pins()==before,"Current source changed during Fetch fixtures"
 assert all(sha(HERE/"templates"/item["template"])==item["sha256"] for item in manifest["files"])
 result.update(exitCode=0,passed=actual["passed"],failed=0,sourceUnchanged=True,counts=actual["counts"],effects=actual["effects"])
except BaseException as error:
 result.update(exitCode=1,passed=0,failed=1,error=str(error),sourceUnchanged=pins()==before)
finally:
 # Preserve fresh evidence in the checkout artifact namespace, never old171 output.
 refs={}
 for prefix,directory in [("checks",CHECKS),("cross",CROSS)]:
  for path in sorted(directory.iterdir()):
   if path.is_file() and path.suffix in [".json",".log"]:
    target=OUT/(prefix+"-"+path.name);shutil.copyfile(path,target);target.chmod(0o600);refs[prefix+"/"+path.name]=ref(target)
 result["artifacts"]=refs
 result["generatedFixturePins"]={p.name:sha(p) for p in CHECKS.iterdir() if p.is_file() and p.suffix not in [".json",".log"]}
 result["completedUTC"]=datetime.datetime.now(datetime.timezone.utc).isoformat();path=OUT/"RESULT.json";save(path,result)
 print(json.dumps({"result":str(path),"sha256":sha(path),"passed":result["passed"],"failed":result["failed"]}),flush=True)
sys.exit(result["exitCode"])
