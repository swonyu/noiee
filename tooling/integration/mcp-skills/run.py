"""Fresh current-source MCP/skills fixtures; no old receipt is reused."""
from pathlib import Path
import datetime,hashlib,json,os,re,subprocess,sys,tempfile,uuid
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
SOURCE=ROOT/"source"
NODE=Path("/opt/homebrew/bin/node").resolve(strict=True)
CACHE=Path(tempfile.mkdtemp(prefix="NoieeMCP172-",dir="/Users/saleh/Library/Caches"))
CHECKS=CACHE/"checks";CHECKS.mkdir(mode=0o700)
OUT=ROOT/".artifacts/integration"/("mcp-skills-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+uuid.uuid4().hex[:8]);OUT.mkdir(parents=True)
for name in ["tmp","native-fixtures","swift-cache","skills"]:(CACHE/name).mkdir(mode=0o700)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def ref(path):return {"path":str(path),"sha256":sha(path)}
def pins():return {p.name:sha(p) for p in sorted(SOURCE.iterdir()) if p.is_file() and not p.is_symlink()}
before=pins();manifest=json.loads((HERE/"TEMPLATES.json").read_text());adapted=[]
for item in manifest["files"]:
 template=HERE/"templates"/item["template"];assert sha(template)==item["sha256"]
 if "predecessorTemplate" in item:
  assert sha(HERE/"templates"/item["predecessorTemplate"])==item["predecessorSHA256"]
 text=template.read_text().replace("../../source/",str(SOURCE)+"/")
 target=CHECKS/item.get("generatedName",item["template"].removesuffix(".in"));target.write_text(text);target.chmod(0o600)
 adapted.append({"template":ref(template),"generated":ref(target),"routingOnly":"adaptation" not in item,**({"adaptation":item["adaptation"],"predecessorTemplate":ref(HERE/"templates"/item["predecessorTemplate"])} if "adaptation" in item else {})})
env={key:os.environ[key] for key in ["HOME","USER","LOGNAME"] if key in os.environ}
env.update(PATH="/opt/homebrew/bin:/usr/bin:/bin",LANG="C",TMPDIR=str(CACHE/"tmp")+"/",PYTHONDONTWRITEBYTECODE="1",NOIEE_TOOLS_FIXTURE_ROOT=str(CACHE),SALEH_SKILLS_FIXTURE_ROOT=str(CACHE/"skills"))
rows=[]
def run(name,command,expected=None,style="json"):
 log=OUT/(name+".log");start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with log.open("xb") as stream:result=subprocess.run(command,cwd=CACHE,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,timeout=120)
 text=log.read_text();passed=0;failed=0
 if expected is not None and result.returncode==0:
  if style=="tap":
   match=re.search(r"^# pass (\d+)$",text,re.M);bad=re.search(r"^# fail (\d+)$",text,re.M);assert match and bad
   passed=int(match[1]);failed=int(bad[1])
  elif style=="native":
   value=json.loads(text);assert value["passed"] is True;passed=value["checks"]
  else:
   values=[]
   for line in text.splitlines():
    try:
     value=json.loads(line)
     if isinstance(value,dict) and type(value.get("passed")) is int and "failed" in value:values.append(value)
    except ValueError:pass
   assert values,"Missing actual fixture result";value=values[-1];passed=value["passed"];failed=value["failed"]
 good=result.returncode==0 and (expected is None or passed==expected and failed==0)
 row={"name":name,"command":command,"exitCode":result.returncode,"passed":passed,"failed":failed if good else max(failed,1),"expected":expected,"log":ref(log),"startedUTC":start,"qualified":good}
 rows.append(row);print(json.dumps(row),flush=True)
 if not good:print(text[-10000:],flush=True);raise RuntimeError(name+" failed")
result={"schemaVersion":1,"name":"mcp-skills","sourceDirectory":str(SOURCE),"sourcePins":before,"fixtureDirectory":str(CACHE),"rows":rows,"adaptations":adapted,"scope":"77 fresh generated MCP recovery, project-skills native/agent/UI checks. Fake transports; no installed app, model or original stores."}
try:
 for fixture,binary in [("ProjectSkillsHarness.swift","project-skills-native-fixture"),("ProjectSkillsClientFixture.swift","project-skills-native-client-fixture")]:
  run(binary+"-compile",["/usr/bin/xcrun","swiftc","-parse-as-library","-target","arm64-apple-macos15.2","-module-cache-path",str(CACHE/"swift-cache"),*[str(SOURCE/name) for name in ["CodingTemporary.swift","HandoffFiles.swift","CodingSkills.swift","ProjectSkills.swift"]],str(CHECKS/fixture),"-o",str(CHECKS/binary)])
 for name,file,count in [("mcp-recovery-lifecycle","recovery-check.mjs",25),("mcp-recovery-unavailable","unavailable-check.mjs",10),("mcp-recovery-tools-ui","tools-ui-check.mjs",5)]:
  run(name,[str(NODE),"--preserve-symlinks",str(CHECKS/file)],count)
 run("project-skills-native",[str(CHECKS/"project-skills-native-fixture"),str(CACHE/"native-fixtures")],26,"native")
 for name,file,count in [("project-skills-agent","project-skills-agent-check.mjs",7),("project-skills-ui","project-skills-ui-check.mjs",4)]:
  run(name,[str(NODE),"--preserve-symlinks","--test","--test-reporter=tap",str(CHECKS/file)],count,"tap")
 assert pins()==before,"Source changed during fixtures"
 assert all(sha(HERE/"templates"/item["template"])==item["sha256"] for item in manifest["files"])
 result.update(exitCode=0,passed=sum(row["passed"] for row in rows),failed=0,sourceUnchanged=True)
except BaseException as error:
 result.update(exitCode=1,passed=sum(row["passed"] for row in rows),failed=1,error=str(error),sourceUnchanged=pins()==before)
finally:
 result["completedUTC"]=datetime.datetime.now(datetime.timezone.utc).isoformat();path=OUT/"RESULT.json";path.write_text(json.dumps(result,indent=2)+"\n");print(json.dumps({"result":str(path),"sha256":sha(path),"passed":result["passed"],"failed":result["failed"]}),flush=True)
sys.exit(result["exitCode"])
