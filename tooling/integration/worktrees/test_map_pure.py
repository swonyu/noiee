"""Generated map guards only, with saved closed copies and no original effects."""
from pathlib import Path
import ast,base64,copy,ctypes,hashlib,importlib.util,json,os,stat,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
forbidden=['/Users/saleh/Library/Application Support/Qwen Local','/Users/saleh/Applications/Saleh Uncensored.app'];events=[]


def audit(event,args):
    if event.startswith(('subprocess.','socket.','ctypes.dlopen','os.exec','os.spawn')) or event in ('os.system','os.fork','os.posix_spawn','os.kill','os.killpg'):
        events.append(event);raise AssertionError('Original/native/process/network operation forbidden')
    if event=='open':
        if isinstance(args[0],(str,bytes)):
            path=os.fsdecode(args[0])
            if any(path==root or path.startswith(root+'/') for root in forbidden):events.append('original-read');raise AssertionError('Original path read forbidden')
        if isinstance(args[1],str) and any(c in args[1] for c in 'wax+') or isinstance(args[2],int) and args[2]&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC):events.append('write');raise AssertionError('No fixture-store writes in pure tests')


sys.addaudithook(audit)
spec=importlib.util.spec_from_file_location('map_proposal',HERE/'capture-v1-map-disabled.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
cp,prior,plan=p.saved_inputs();verify=p.saved_proof_verifier();p.checked(p.VIEW_SOURCE);p.checked(p.VERIFIER_SOURCE);p.checked(p.VIEW_REVIEW);p.checked(p.PATTERN_ONLY)
forbidden.extend(plan['roles'])
ledger_raw=p.checked({'path':str(Path(cp['copyRoot'])/'Qwen Local/Coding/managed-worktrees.json'),'sha256':p.LEDGER_SHA})
pointer_data={}
for item in plan['pointers']:
    kind=item['kind'];text='' if kind=='lock' else 'gitdir: '+item['target'] if kind in ('cwd-git','source-git') else '../..' if kind=='admin-common' else item['target']
    pointer_data[item['path']]=text.encode()+b'\n' if text else b''
observations={};rows=[];serial=900000001
for path,role in sorted(plan['roles'].items()):
    if path==p.LEDGER:raw=ledger_raw
    elif path in pointer_data:raw=pointer_data[path]
    elif role['artifact']:
        copied=Path(cp['copyRoot'])/'Qwen Local'/str(Path(path).relative_to(Path(p.CODING).parent));raw=p.checked({'path':str(copied),'sha256':role['artifact']['hash']})
    else:raw=None
    inode=int(role['historicalIdentity']['ino']) if role['historicalIdentity'] else 26838645 if path==p.CODING else serial;serial+=1
    isdir=role['type']=='directory';mode=(stat.S_IFDIR if isdir else stat.S_IFREG)|(0o700 if isdir and role['private'] else 0o755 if isdir else 0o600 if role['private'] else 0o644)
    record={'path':path,'stat':{'st_dev':p.CURRENT_DEVICE,'st_ino':inode,'st_mode':mode,'st_uid':501,'st_gid':20,'st_nlink':2 if isdir else 1,'st_size':0 if isdir else len(raw),'st_mtime_ns':1900000000000000000,'st_ctime_ns':1900000000000000000},'filesystem':{'volumeUUID':p.VOLUME,'ino':str(inode)}}
    if not isdir:record['sha256']=p.sha(raw)
    observations[path]={'before':record,'after':copy.deepcopy(record)};rows.append(p.row_from_record(path,role,record))
namespaces=[]
for path in plan['namespaces']:
    if path.startswith(p.CODING+'/'):
        prefix=str(Path(path).relative_to(Path(p.CODING).parent))+'/'
        names=sorted({name[len(prefix):].split('/')[0] for name in cp['dataManifests']['Qwen Local'] if name.startswith(prefix)})
    elif 'admin' in plan['roles'][path]['roles']:names=['HEAD','commondir','gitdir','locked']
    else:names=['HEAD','config','objects','refs','worktrees']
    namespaces.append({'path':path,'names':names})
boundary={'checkpoint':p.CLOSED170,'before':p.BEFORE170,'boot':p.CURRENT_BOOT,'allSevenNativeRequestClosed':True,'leaseAbsent':True,'fourStoresExact':True,'originalCatalogExact':True,'currentAbsence':copy.deepcopy(cp['after']['closure'])}
fixture={'version':1,'kind':'stable-current-v1-worktree-map-observation','source':p.own(),'captureBootSession':p.CURRENT_BOOT,'historicalContinuity':False,'closedCheckpoint':p.CLOSED170,'prebootCheckpoint':p.HISTORICAL169,'viewSource':p.VIEW_SOURCE,'verifierSource':p.VERIFIER_SOURCE,'viewReview':p.VIEW_REVIEW,'ledgerSHA256':p.LEDGER_SHA,'rows':rows,'namespaces':namespaces,'observations':observations,'pointerBytes':{path:base64.b64encode(raw).decode() for path,raw in pointer_data.items()},'beforeBoundary':boundary,'afterBoundary':copy.deepcopy(boundary)}
cases=[]


def passed(name,fn):fn();cases.append(name)


def rejected(name,fn):
    try:fn()
    except (ValueError,KeyError,TypeError,UnicodeError):cases.append(name);return
    raise AssertionError('Invalid generated map accepted: '+name)


def mutate(value,path,new):
    value=copy.deepcopy(value);cursor=value
    for key in path[:-1]:cursor=cursor[key]
    cursor[path[-1]]=new;return value


passed('exact historical/fresh170 closed-copy ledger and two restored archives',lambda:p.plan_from_ledger(ledger_raw))
parts=p.review_observation(plan,fixture,verify);cases.append('generated exact six-role/control/archive observation')
document=p.map_document(parts,'1'*64,'2'*64)
assert set(document)=={'version','kind','historicalContinuity','captureBootSession','dataDirectory','evidence','rows','namespaces'}
assert list(document['dataDirectory'])==['path','volumeUUID','ino','uid'] and len(p.encode(document))<=p.MAX
cases.append('exact existing verifier map schema and dataDirectory field order')
assert not set(plan['workingRoots']).intersection(row['path'] for row in document['namespaces']);cases.append('no mutable source/cwd child namespace pins')
assert len(plan['archives'])==2 and len(plan['ledger']['records'])==9
rejected('changed ledger bytes cannot derive roles',lambda:p.plan_from_ledger(ledger_raw+b' '))
rejected('unknown map document fields cannot override authority',lambda:p.map_document({**parts,'evidence':{}},'1'*64,'2'*64))
rejected('unresolved observation digest',lambda:p.map_document(parts,None,'2'*64))
for key in ('source','common','sourceGit','cwd','admin','gitfile'):
    at=next(i for i,row in enumerate(rows) if key in plan['roles'][row['path']]['roles'])
    rejected('historical '+key+' identity',lambda at=at:p.review_observation(plan,mutate(fixture,['rows',at,'historicalIdentity','ino'],'1'),verify))
for path,new in [(['closedCheckpoint','sha256'],'0'*64),(['captureBootSession'],'old-boot'),(['historicalContinuity'],True),(['viewSource','sha256'],'0'*64),(['ledgerSHA256'],'0'*64),(['beforeBoundary','allSevenNativeRequestClosed'],False),(['afterBoundary','fourStoresExact'],False),(['afterBoundary','originalCatalogExact'],False),(['afterBoundary','leaseAbsent'],False),(['beforeBoundary','currentAbsence','priorSHA256'],'0'*64),(['afterBoundary','currentAbsence','pidQueries'],{}),(['beforeBoundary','currentAbsence','groupOrParentMembers'],[[1,2,3]])]:
    rejected('observation '+'.'.join(path),lambda path=path,new=new:p.review_observation(plan,mutate(fixture,path,new),verify))
for key in ('source','cwd'):
    path=next(path for path,role in plan['roles'].items() if key in role['roles'])
    rejected('ordinary '+key+' change during capture',lambda path=path:p.review_observation(plan,mutate(fixture,['observations',path,'after','stat','st_nlink'],3),verify))
    rejected('working '+key+' child namespace is rejected',lambda path=path:p.review_observation(plan,mutate(fixture,['namespaces'],fixture['namespaces']+[{'path':path,'names':['ordinary.txt']}]),verify))
path=p.LEDGER;role=plan['roles'][path];record=observations[path]['before']
for suffix,new in [(['filesystem','volumeUUID'],'00000000-0000-0000-0000-000000000000'),(['stat','st_dev'],999),(['stat','st_uid'],0),(['stat','st_nlink'],2),(['stat','st_mode'],stat.S_IFREG|0o644),(['stat','st_ino'],True),(['sha256'],'0'*64)]:
    rejected('ledger policy '+'.'.join(suffix),lambda suffix=suffix,new=new:p.row_from_record(path,role,mutate(record,suffix,new)))
lock=next(item['path'] for item in plan['pointers'] if item['kind']=='lock');passed('empty regular lock remains valid',lambda:p.row_from_record(lock,plan['roles'][lock],observations[lock]['before']))
rejected('symlink lock',lambda:p.row_from_record(lock,plan['roles'][lock],mutate(observations[lock]['before'],['stat','st_mode'],stat.S_IFLNK|0o777)))
for item in plan['pointers']:
    if item['kind'] in ('cwd-git','admin-gitdir','admin-common'):
        rejected('Git pointer '+item['kind'],lambda item=item:p.pointer_check(plan,{**pointer_data,item['path']:b'foreign\n'}))
        # One record per derived pointer kind is sufficient; no repeated matrix.
        if item['kind']=='admin-common':break
rejected('Git pointer byte set incomplete',lambda:p.pointer_check(plan,{k:v for k,v in pointer_data.items() if k!=lock}))
rejected('missing control namespace',lambda:p.review_observation(plan,mutate(fixture,['namespaces'],fixture['namespaces'][:-1]),verify))
rejected('duplicate control namespace',lambda:p.review_observation(plan,mutate(fixture,['namespaces'],fixture['namespaces']+[fixture['namespaces'][0]]),verify))
for key,bound in [('index',4*p.MAX),('manifest',8*p.MAX),('bundle',512*p.MAX)]:
    path=next(path for path,role in plan['roles'].items() if role['artifact'] and key in role['roles']);role=plan['roles'][path];record=observations[path]['before'];assert role['limit']==bound
    rejected('archive '+key+' exceeds existing role bound',lambda path=path,role=role,record=record,bound=bound:p.stat_policy(path,role,{k:v for k,v in mutate(record,['stat','st_size'],bound+1).items() if k!='sha256'}))
    rejected('archive '+key+' hash changed',lambda path=path,role=role,record=record:p.row_from_record(path,role,mutate(record,['sha256'],'0'*64)))

for key,mode,okay in [('bundle',0o644,True),('bundle',0o664,False),('index',0o644,False),('manifest',0o644,False)]:
    path=next(path for path,role in plan['roles'].items() if role['artifact'] and key in role['roles']);role=plan['roles'][path];record=mutate(observations[path]['before'],['stat','st_mode'],stat.S_IFREG|mode)
    fn=lambda path=path,role=role,record=record:p.row_from_record(path,role,record)
    (passed if okay else rejected)('producer mode '+key+' '+oct(mode),fn)
rejected('missing archive row',lambda:p.review_observation(plan,mutate(fixture,['rows'],fixture['rows'][:-1]),verify))
aliased=copy.deepcopy(fixture);paths=[path for path,role in plan['roles'].items() if role['type']=='file' and role['historicalIdentity'] is None and path!=p.LEDGER][:2]
inode=aliased['observations'][paths[0]]['before']['stat']['st_ino']
for phase in ('before','after'):
    aliased['observations'][paths[1]][phase]['stat']['st_ino']=inode;aliased['observations'][paths[1]][phase]['filesystem']['ino']=str(inode)
for row in aliased['rows']:
    if row['path']==paths[1]:row['identity']['ino']=str(inode)
rejected('distinct canonical roles alias one inode',lambda:p.review_observation(plan,aliased,verify))
rejected('unknown large file role',lambda:p.review_observation(plan,mutate(fixture,['rows'],fixture['rows']+[{**fixture['rows'][0],'path':'/generated/unknown.bundle'}]),verify))
tree=ast.parse((HERE/'capture-v1-map-disabled.py').read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
assert ast.unparse(main.body[0])=="require(EXECUTION_ENABLED is True, 'Disabled v1-map proposal: root review and explicit enabled derivative required')"
assert not any(isinstance(n,ast.Call) and ast.unparse(n.func) in ('subprocess.run','os.system','os.kill','os.killpg') for n in ast.walk(tree))
assert not any(isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value.startswith(('git ','lms ')) for n in ast.walk(tree))
cases.append('disabled first guard and no Git/model/process-control implementation')
rejected('disabled main before all live context loading',lambda:p.main([]))
assert not events and p.EXECUTION_ENABLED is False
print(json.dumps({'kind':'generated-v1-map-component-static-checks','passed':len(cases),'failed':0,'rows':len(rows),'controlNamespaces':len(namespaces),'workingRootsWithoutChildPins':len(plan['workingRoots']),'records':9,'restoredArchives':2,'effects':events,'originalReads':0,'nativeHelperExecutions':0,'liveMapCaptureExecuted':False,'mapActivated':False,'python':{'executable':sys.executable,'realExecutable':os.path.realpath(sys.executable),'version':sys.version,'bytecodeDisabled':bool(sys.flags.dont_write_bytecode)},'cases':cases},indent=2))
