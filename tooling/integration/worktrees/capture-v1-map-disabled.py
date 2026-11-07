"""Disabled exact v1-ready map capture/review; root alone may review and enable.

Use /usr/bin/python3 -B. Never execute the historical Build109/110 generator.
Original paths are read only by capture after the first execution guard and all
fresh170 closed-boundary checks. No ledger/owner/Git/model mutation is implemented.
"""
from pathlib import Path
import argparse, ast, base64, copy, datetime, hashlib, json, os, re, stat, sys, types, unicodedata
sys.dont_write_bytecode=True
EXECUTION_ENABLED=False
CURRENT_BOOT='1DBF7593-0C6B-4F7C-88D1-0607CEAAECDC'
CODING='/Users/saleh/Library/Application Support/Qwen Local/Coding'
ROOT=CODING+'/Worktrees'
LEDGER=CODING+'/managed-worktrees.json'
VOLUME='DA5786BC-3563-4A7A-865E-A1E8A7805C94'
CURRENT_DEVICE=16777232
OUTPUTS=Path('/Users/saleh/Library/Caches/SalehWorktreeMap170')
CLOSED170={'path':'/Users/saleh/Library/Caches/SalehCapture170/currentboot-1DBF7593/closed-v1/checkpoint.json','sha256':'183a2ea46739ee20db28aded111f1aef822194adbae2407d73c7a70d2fe535c0'}
BEFORE170={'path':'/Users/saleh/Library/Caches/SalehCapture170/currentboot-1DBF7593/before-v1.json','sha256':'fd54f1b30bad132191b97775a74d60cc5d8d67cc6ae77ff673037ab33ccf50ba'}
COLLECTOR170={'path':'/Users/saleh/Documents/Codex/2026-10-16/sa/work/build170-model-transport-release/acceptance170-root-v1/capture170-currentboot-enabled.py','sha256':'f9243a0690f51f2d841ba901ce7614860fb21923d8867a28fe0e36d215fe4c7b'}
DISABLED170={'path':'/Users/saleh/Documents/Codex/2026-10-16/sa/work/build170-model-transport-release/acceptance170-proposal-v1/capture170-currentboot-disabled.py','sha256':'966e6ed5075dc34a163a285ae80aa25a56b0c71a27fb47ea27ea04fed5bbc79f'}
HISTORICAL169={'path':'/Users/saleh/Library/Caches/SalehStorage169/chat-snapshot-u429tb8c/acceptance-local/build169-final-closed-v2/checkpoint.json','sha256':'cb6e46f6f7ccc229d4270c3904affbf555c233d2e0b0ffd7db2a2bb9ea125aec'}
LEDGER_SHA='a64b5437d2d4fd4003ac0bf53bca1ae371cd29a10cb677d4272240d4db512d45'
VIEW_SOURCE={'path':'/Users/saleh/Library/Caches/SalehWorktreeReadOnly171/v3-bundle-mode-1tomu59a/source/managed-worktrees.mjs','sha256':'6c9ab127fdbc47290e3c4f80eb24f8dfe4fbd965dd021d8705524839762af7c1'}
VERIFIER_SOURCE={'path':'/Users/saleh/Library/Caches/SalehWorktreeReadOnly171/root-v2-review-si9epm3r/source/legacy-admission.mjs','sha256':'96b8a516d45a24c353bc778ccff2d4792d7ede6865e546a24e226bdafa36ffd5'}
VIEW_REVIEW={'path':'/Users/saleh/Library/Caches/SalehWorktreeReadOnly171/v3-bundle-mode-1tomu59a/check-result.json','sha256':'c80de89f89437b72ef23f1adcb86c6fd057d0863b231dc381f8c8a2720c5e4ac'}
PATTERN_ONLY={'path':'/Users/saleh/Library/Caches/materialize-quffrw86/capture-handoff.py','sha256':'7bd2c611da3a6fd05e7fcedc609f5236e4aafc9185065166e2a76e99c5b210d8'}
PYTHON_REAL='/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9'
MAX=1048576
FIELDS=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
ID=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')


def require(ok,why):
    if not ok:raise ValueError(why)


def sha(raw):return hashlib.sha256(raw).hexdigest()
def same(a,b):return json.dumps(a,sort_keys=True,separators=(',',':'),allow_nan=False)==json.dumps(b,sort_keys=True,separators=(',',':'),allow_nan=False)
def encode(value):return (json.dumps(value,indent=2,ensure_ascii=False,allow_nan=False)+'\n').encode()
def fold(value):return unicodedata.normalize('NFD',value).casefold()


def shape(value,keys):
    require(type(value) is dict and set(value)==set(keys),'Unexpected object fields')


def canonical(path):
    require(type(path) is str and path.startswith('/') and str(Path(path))==path and '..' not in Path(path).parts and '\x00' not in path and len(path.encode())<=4096,'Canonical absolute path required')
    return path


def historical(value):
    shape(value,('dev','ino'));require(all(type(value[k]) is str and re.fullmatch('[0-9]+',value[k]) for k in value),'Historical device/inode required')
    return value


def plan_from_ledger(raw):
    require(type(raw) is bytes and len(raw)==11188 and sha(raw)==LEDGER_SHA,'Only the exact original nine-record ledger is admitted')
    ledger=json.loads(raw);shape(ledger,('version','root','records'));historical(ledger['root'])
    require(type(ledger['version']) is int and ledger['version']==1 and ledger['root']=={'dev':'16777233','ino':'27125711'} and len(ledger['records'])==9 and all(r['state']=='ready' for r in ledger['records']),'Exact retained v1 nine-ready ledger required')
    roles={};namespaces=set();working=set();pointers=[];archives=[]
    def add(path,kind,hist=None,private=False,limit=None,artifact=None,role=None):
        canonical(path)
        if hist is not None:historical(hist);require(hist['dev']==ledger['root']['dev'],'Historical roles span an unadmitted device')
        new={'type':kind,'historicalIdentity':hist,'private':private,'limit':limit,'artifact':artifact,'roles':[role]}
        if path in roles:
            old=roles[path];require(old['type']==kind and (old['historicalIdentity'] is None or hist is None or old['historicalIdentity']==hist) and (old['artifact'] is None or artifact is None or old['artifact']==artifact),'Conflicting shared role identity')
            old['historicalIdentity']=old['historicalIdentity'] or hist;old['private']|=private;old['artifact']=old['artifact'] or artifact;old['roles'].append(role)
            if limit is not None:old['limit']=min(old['limit'],limit) if old['limit'] is not None else limit
        else:roles[path]=new
    add(CODING,'directory',private=True,role='data-control');add(LEDGER,'file',private=True,limit=MAX,role='ledger');add(ROOT,'directory',ledger['root'],True,role='root-control');namespaces.add(ROOT)
    ids=set()
    for r in ledger['records']:
        require(type(r['id']) is str and ID.fullmatch(r['id']) and r['id'] not in ids,'Exact unique worktree IDs required');ids.add(r['id'])
        shape(r['identities'],('source','common','sourceGit','cwd','admin','gitfile'))
        require(r['cwd']==ROOT+'/'+r['id'] and r['admin']==r['commonDir']+'/worktrees/'+r['id'],'Original record path relation differs')
        for key,path in [('source',r['source']),('common',r['commonDir']),('sourceGit',r['gitDir']),('cwd',r['cwd']),('admin',r['admin']),('gitfile',r['cwd']+'/.git')]:
            add(path,'file' if key=='gitfile' else 'directory',r['identities'][key],limit=8192 if key=='gitfile' else None,role=key)
        working.update((r['source'],r['cwd']));namespaces.update((r['commonDir'],r['gitDir'],r['admin']))
        for suffix,kind,target in [('/.git','cwd-git',r['admin'])]:pointers.append({'path':r['cwd']+suffix,'kind':kind,'target':target})
        for name,kind,target in [('gitdir','admin-gitdir',r['cwd']+'/.git'),('commondir','admin-common',r['commonDir']),('locked','lock',None)]:
            path=r['admin']+'/'+name;add(path,'file',limit=8192,role=kind);pointers.append({'path':path,'kind':kind,'target':target})
        source_link=r['source']+'/.git'
        if source_link!=r['gitDir']:
            add(source_link,'file',limit=8192,role='source-git');pointers.append({'path':source_link,'kind':'source-git','target':r['gitDir']})
        if r.get('archive'):
            a=r['archive'];require(a['phase']=='restored' and ID.fullmatch(a['id']),'Only complete restored archives are admitted')
            parent=ROOT+'/.archives';directory=parent+'/'+a['id'];add(parent,'directory',a['parent'],True,role='archive-parent');add(directory,'directory',a['directory'],True,role='archive-directory');namespaces.update((parent,directory))
            for key,name,limit in [('index','original-index',4*MAX),('manifest','manifest.json',8*MAX),('bundle','recovery.bundle',512*MAX)]:
                item=a[key];shape(item,('identity','hash','bytes'));require(type(item['bytes']) is int and 1<=item['bytes']<=limit and re.fullmatch('[0-9a-f]{64}',item['hash']),'Original archive role bound differs')
                add(directory+'/'+name,'file',item['identity'],key!='bundle',limit,item,key)
            archives.append({'id':r['id'],'path':directory,'head':a['head'],'descriptor':a})
    require(len(archives)==2,'Exactly two original restored archives required')
    controls=set(roles)-working
    for path in working:
        require(path not in controls and roles[path]['type']=='directory' and roles[path]['roles']==['source' if path in [r['source'] for r in ledger['records']] else 'cwd'],'Working/control role collision')
        require(not any(c not in (ROOT,CODING) and path.startswith(c+'/') for c in controls),'Working root is inside a control role')
    require(not working.intersection(namespaces),'Working child namespaces are forbidden')
    require(len({fold(path) for path in roles})==len(roles),'Canonical role aliases require inspection')
    return {'ledger':ledger,'roles':roles,'namespaces':sorted(namespaces),'workingRoots':sorted(working),'pointers':pointers,'archives':archives}


def stat_policy(path,role,record):
    shape(record,('path','stat','filesystem'))
    s=record['stat'];identity=record['filesystem'];shape(identity,('volumeUUID','ino'))
    require(all(type(s[k]) is int for k in FIELDS) and s['st_dev']==CURRENT_DEVICE and s['st_ino']>0 and all(s[k]>=0 for k in ('st_mode','st_uid','st_gid','st_nlink','st_size')),'Current role stat fields/device differ')
    require(record['path']==path and identity=={'volumeUUID':VOLUME,'ino':str(s['st_ino'])} and type(s['st_uid']) is int and s['st_uid']==501,'Current persistent volume/inode/owner differs')
    require((stat.S_ISDIR(s['st_mode']) if role['type']=='directory' else stat.S_ISREG(s['st_mode'])) and not s['st_mode']&(0o077 if role['private'] else 0o022) and (s['st_nlink']>=1 if role['type']=='directory' else s['st_nlink']==1),'Role type/permissions/links differ')
    hist=role['historicalIdentity'];require(hist is None or hist['ino']==identity['ino'],'Historical role inode changed')
    if path==CODING:require(identity['ino']=='26838645','Original Coding identity changed')
    row={'path':path,'historicalIdentity':hist,'identity':identity,'mode':s['st_mode'],'uid':s['st_uid'],'type':role['type']}
    if role['type']=='file':
        minimum=0 if 'lock' in role['roles'] else 1
        require(type(s['st_size']) is int and minimum<=s['st_size']<=role['limit'],'File exceeds its exact role bound')
    return row


def row_from_record(path,role,record):
    shape(record,('path','stat','filesystem',*(['sha256'] if role['type']=='file' else [])))
    row=stat_policy(path,role,{k:record[k] for k in ('path','stat','filesystem')});s=record['stat']
    if role['type']=='file':
        require(type(record['sha256']) is str and re.fullmatch('[0-9a-f]{64}',record['sha256']),'File hash required')
        row.update(sha256=record['sha256'],bytes=s['st_size'])
        if role['artifact']:require(row['sha256']==role['artifact']['hash'] and row['bytes']==role['artifact']['bytes'],'Original archive artifact changed')
        if path==LEDGER:require(row['sha256']==LEDGER_SHA and row['bytes']==11188 and stat.S_IMODE(row['mode'])==0o600,'Original private ledger bytes changed')
    return row


def pointer_check(plan,payloads):
    require(set(payloads)=={p['path'] for p in plan['pointers']},'Exact Git pointer/lock byte set required')
    for item in plan['pointers']:
        raw=payloads[item['path']];require(type(raw) is bytes and len(raw)<=8192,'Pointer exceeds8KiB')
        text=raw.decode('utf-8');text=text[:-1] if text.endswith('\n') else text;kind=item['kind']
        if kind=='lock':continue
        require(text and '\x00' not in text,'Invalid pointer bytes')
        if kind=='cwd-git':require(text=='gitdir: '+item['target'],'Cwd Git registration pointer changed')
        elif kind=='admin-gitdir':require(text==item['target'],'Reverse Git registration pointer changed')
        else:
            if kind=='source-git':require(text.startswith('gitdir: '),'Source Git pointer prefix changed');text=text[8:]
            base=str(Path(item['path']).parent)
            require(os.path.normpath(os.path.join(base,text))==item['target'],'Relative Git control target changed')


def review_observation(plan,value,verify_proof):
    shape(value,('version','kind','source','captureBootSession','historicalContinuity','closedCheckpoint','prebootCheckpoint','viewSource','verifierSource','viewReview','ledgerSHA256','rows','namespaces','observations','pointerBytes','beforeBoundary','afterBoundary'))
    require(type(value['version']) is int and value['version']==1 and value['kind']=='stable-current-v1-worktree-map-observation' and value['captureBootSession']==CURRENT_BOOT and value['historicalContinuity'] is False and value['closedCheckpoint']==CLOSED170 and value['prebootCheckpoint']==HISTORICAL169 and value['viewSource']==VIEW_SOURCE and value['verifierSource']==VERIFIER_SOURCE and value['viewReview']==VIEW_REVIEW and value['ledgerSHA256']==LEDGER_SHA,'Observation source/closure/ledger lineage differs')
    require(len(value['rows'])==len(plan['roles']) and len(value['rows'])<=20000 and len(value['namespaces'])<=256 and set(value['observations'])==set(plan['roles']),'Exact derived row set required')
    rows={row['path']:row for row in value['rows']};require(len(rows)==len(value['rows']) and set(rows)==set(plan['roles']),'Duplicate, missing or foreign row')
    inode_paths={};devices=set()
    for path,role in plan['roles'].items():
        pair=value['observations'][path];shape(pair,('before','after'));require(same(pair['before'],pair['after']),'Metadata/content changed during capture')
        require(same(rows[path],row_from_record(path,role,pair['before'])),'Published row differs from its full observation')
        devices.add(pair['before']['stat']['st_dev']);key=(rows[path]['identity']['volumeUUID'],rows[path]['identity']['ino'])
        require(key not in inode_paths or inode_paths[key]==path,'Different canonical roles alias one inode');inode_paths[key]=path
    require(len(devices)==1 and str(next(iter(devices)))!=plan['ledger']['root']['dev'],'Only same-volume retained device drift may be adopted')
    namespaces={row['path']:row['names'] for row in value['namespaces']};require(len(namespaces)==len(value['namespaces']) and set(namespaces)==set(plan['namespaces']) and not set(namespaces).intersection(plan['workingRoots']),'Exact control namespaces only; no working-root children')
    for path,names in namespaces.items():require(type(names) is list and len(names)<=20000 and names==sorted(set(names)) and all(type(n) is str and n not in ('','.','..') and '/' not in n and '\x00' not in n for n in names),'Invalid control namespace')
    payloads={path:base64.b64decode(raw,validate=True) for path,raw in value['pointerBytes'].items()}
    pointer_check(plan,payloads)
    for path,raw in payloads.items():require(sha(raw)==rows[path]['sha256'] and len(raw)==rows[path]['bytes'],'Pointer bytes are not bound to row hash/length')
    for key in ('beforeBoundary','afterBoundary'):
        boundary=value[key];shape(boundary,('checkpoint','before','boot','allSevenNativeRequestClosed','leaseAbsent','fourStoresExact','originalCatalogExact','currentAbsence'));require(boundary['checkpoint']==CLOSED170 and boundary['before']==BEFORE170 and boundary['boot']==CURRENT_BOOT and boundary['allSevenNativeRequestClosed'] is True and boundary['leaseAbsent'] is True and boundary['fourStoresExact'] is True and boundary['originalCatalogExact'] is True,'Fresh170 boundary required')
        require(callable(verify_proof),'Source-pinned pure absence verifier required');verify_proof(boundary['currentAbsence'])
    require(len(encode({'rows':value['rows'],'namespaces':value['namespaces']}))<MAX-4096,'Map candidate exceeds existing immutable resource limit')
    return {'rows':[rows[path] for path in sorted(rows)],'namespaces':[{'path':path,'names':namespaces[path]} for path in sorted(namespaces)]}


def map_document(parts,observation_sha,review_sha):
    shape(parts,('rows','namespaces'))
    require(all(type(value) is str and re.fullmatch('[0-9a-f]{64}',value) for value in (observation_sha,review_sha)),'Exact observation/review pins required')
    document={'version':1,'kind':'reviewed-current-worktree-handoff-admission','historicalContinuity':False,'captureBootSession':CURRENT_BOOT,'dataDirectory':{'path':CODING,'volumeUUID':VOLUME,'ino':'26838645','uid':501},'evidence':{'prebootCheckpointSHA256':HISTORICAL169['sha256'],'closedCheckpointSHA256':CLOSED170['sha256'],'observationSHA256':observation_sha,'reviewSHA256':review_sha},**parts}
    require(len(encode(document))<=MAX,'Map exceeds existing immutable resource bound')
    return document


def checked(reference,limit=64*MAX,mode=None):
    shape(reference,('path','sha256'));canonical(reference['path']);require(re.fullmatch('[0-9a-f]{64}',reference['sha256']),'Exact pin required')
    path=Path(reference['path']);before=path.lstat();require(path.resolve(strict=True)==path and stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1 and not before.st_mode&0o022 and 0<before.st_size<=limit and (mode is None or stat.S_IMODE(before.st_mode)==mode),'Unsafe pinned input')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
        on_open=os.fstat(f.fileno());require(all(getattr(on_open,k)==getattr(before,k) for k in FIELDS),'Input changed on open');raw=f.read(limit+1);after=os.fstat(f.fileno())
    require(all(getattr(before,k)==getattr(after,k)==getattr(path.lstat(),k) for k in FIELDS) and path.resolve(strict=True)==path and len(raw)==before.st_size and sha(raw)==reference['sha256'],'Input changed or pin differs')
    return raw


def saved_inputs():
    cp=json.loads(checked(CLOSED170));prior=json.loads(checked(BEFORE170));old=json.loads(checked(HISTORICAL169))
    require(cp['source']==prior['source']==COLLECTOR170 and cp['beforeCapture']==BEFORE170 and cp['boot']==prior['boot']==CURRENT_BOOT and cp['phase']=='current-preservation-baseline' and prior['phase']=='before-quit','Exact fresh170 checkpoint/before/source required')
    require(all(cp[k] is True for k in ('capturedCurrentSessionClosed','fourStoreStableCopyPassed','preservationBaselineOnly')) and all(cp[k] is False for k in ('sourceStoresOpenedBySQLite','historical88AcceptanceCompleted','fullParity')),'Fresh170 closure flags differ')
    key='Coding/managed-worktrees.json';expected={'mode':0o600,'type':'file','size':11188,'sha256':LEDGER_SHA}
    require(cp['dataManifests']['Qwen Local'][key]==old['dataManifests']['Qwen Local'][key]==expected and old['boot']!=CURRENT_BOOT,'Historical and fresh170 closed ledger evidence differ')
    path=Path(cp['copyRoot'])/'Qwen Local'/key;raw=checked({'path':str(path),'sha256':LEDGER_SHA},MAX,0o600)
    return cp,prior,plan_from_ledger(raw)


def own():
    path=Path(__file__).resolve();return {'path':str(path),'sha256':sha(path.read_bytes())}


def saved_proof_verifier():
    cp=json.loads(checked(CLOSED170));prior=json.loads(checked(BEFORE170))
    def pure(reference,functions,classes=(),constants=()):
        tree=ast.parse(checked(reference));nodes=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom)) or isinstance(n,ast.FunctionDef) and n.name in functions or isinstance(n,ast.ClassDef) and n.name in classes or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in constants for t in n.targets)]
        require({n.name for n in nodes if isinstance(n,ast.FunctionDef)}==set(functions),'Pinned pure native guard changed')
        module=types.ModuleType('saved_native_guards');module.__file__=reference['path'];exec(compile(ast.Module(body=nodes,type_ignores=[]),reference['path']+' [pure saved table parser]','exec'),module.__dict__);return module
    native=pure(cp['leafSources']['native'],{'require','abi','list_check','info_check','table'},('ShortInfo',),('KIND','MAX_BYTES'))
    closer=pure(cp['leafSources']['closer'],{'require','absent'})
    def verify(proof):
        shape(proof,('priorPath','priorSHA256','savedIncarnations','pidQueries','groups','groupOrParentMembers'))
        require(proof['priorPath']==BEFORE170['path'] and proof['priorSHA256']==BEFORE170['sha256'] and prior['boot']==CURRENT_BOOT,'Saved proof is not a fresh170 cohort proof')
        closer.absent(types.SimpleNamespace(ABSENT={'bytes':0,'errno':3},table=native.table),proof,[r['identity'] for r in prior['processesAfter']])
    return verify


def load_context():
    require(sys.version_info[:3]==(3,9,6) and os.path.realpath(sys.executable)==PYTHON_REAL and sys.flags.dont_write_bytecode,'Use the reviewed /usr/bin/python3 -B interpreter; never bypass code_shape')
    raw=checked(COLLECTOR170);disabled=checked(DISABLED170)
    require(disabled.count(b'EXECUTION_ENABLED = False')==1 and raw==disabled.replace(b'EXECUTION_ENABLED = False',b'EXECUTION_ENABLED = True',1),'Only the root-reviewed bool-only170 collector derivative may load')
    checked(VIEW_SOURCE);checked(VERIFIER_SOURCE);review=json.loads(checked(VIEW_REVIEW));require(review['passed']==review['cases']==77 and review['failed']==0 and not any(review['effects'].values()) and review['actualMapActivated'] is False,'Reviewed a490 profile evidence differs')
    module=types.ModuleType('reviewed170_closed_source');module.__file__=COLLECTOR170['path'];exec(compile(raw,module.__file__,'exec'),module.__dict__)
    context=module.context170();cp,prior,plan=saved_inputs()
    require(cp['releaseBinding']==prior['releaseBinding']==module.binding170(module.STAGE,module.PACKAGE_SHA,module.BUNDLE_SHA) and cp['leafSources']==prior['leafSources'] and cp['predecessorClosureWitness']==module.PREDECESSOR,'170 source/package/leaf/predecessor differs')
    require(cp['catalogAdmissionCase']==module.qualify_current170(context['reviewed'],prior,context['saved'],context['admission170'],context['witness']),'170 captured admission case differs')
    observation=json.loads(context['reviewed'].private_ref(context['recipe'],cp['normalQuitObservation'],MAX))
    module.qualify_observation170(context['reviewed'],observation,prior,{'absolutePath':BEFORE170['path'],'sha256':BEFORE170['sha256']},int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000))
    evidence={'normal-quit':cp['normalQuitObservation'],**observation['evidence']}
    require(set(cp['normalQuitEvidenceCopies'])==set(evidence),'Exact170 root-evidence copies required')
    for name,reference in evidence.items():
        limit=MAX if name=='normal-quit' else 16*MAX
        require(context['reviewed'].private_ref(context['recipe'],reference,limit)==context['reviewed'].private_ref(context['recipe'],cp['normalQuitEvidenceCopies'][name],limit),'170 root-evidence copy changed')
    for boundary in (cp['before'],cp['after']):
        context['reviewed'].qualify_boundary(context['base'],prior,boundary['catalog'],boundary['shutdownManifest'],boundary['quitReceipt'],boundary['quitReceipt']['json']['updatedAt'])
        module.qualify_absence170(context['reviewed'],context['modules']['native'],context['modules']['closer'],prior,{'absolutePath':BEFORE170['path'],'sha256':BEFORE170['sha256']},boundary['closure'])
    return module,context,cp,prior,plan


def closed_boundary(module,context,cp,prior):
    h=context['h'];m,c,native,closer=[context['modules'][k] for k in ('m','c','native','closer')];old=context['old'];reviewed=context['reviewed']
    require(json.loads(checked(CLOSED170))==cp and json.loads(checked(BEFORE170))==prior,'Pinned170 closed inputs changed')
    for reference in (COLLECTOR170,DISABLED170,VIEW_SOURCE,VERIFIER_SOURCE,VIEW_REVIEW):checked(reference)
    observation=json.loads(reviewed.private_ref(context['recipe'],cp['normalQuitObservation'],MAX))
    for name,reference in {'normal-quit':cp['normalQuitObservation'],**observation['evidence']}.items():
        limit=MAX if name=='normal-quit' else 16*MAX
        require(reviewed.private_ref(context['recipe'],reference,limit)==reviewed.private_ref(context['recipe'],cp['normalQuitEvidenceCopies'][name],limit),'170 root Quit evidence changed across map capture')
    h['require_stopped']();require(m.boot()==CURRENT_BOOT and not m.processes() and old.lease_record(m.CODING,m.record) is None and not os.path.lexists(LEDGER+'.reconnect'),'Fresh170 app/cohort/lease/reconnect boundary changed')
    proof=c.current_closure(m,prior,Path(BEFORE170['path']),BEFORE170['sha256']);module.qualify_absence170(reviewed,native,closer,prior,{'absolutePath':BEFORE170['path'],'sha256':BEFORE170['sha256']},proof)
    for key,path in [('catalog',m.CODING/'coding-owners.json'),('quitReceipt',Path(cp['after']['quitReceipt']['path']))]:require(same(m.record(path,True,True),cp['after'][key]),'Fresh170 closed leaf changed')
    require(h['manifest'](m.CODING/'shutdown',True)==cp['after']['shutdownManifest'],'Fresh170 shutdown namespace changed')
    bindings=reviewed.binding_snapshot(m,cp['after']['catalog']['json']);reviewed.current_bindings(prior['bindingSnapshot'],bindings);require(same(bindings,cp['after']['bindingSnapshot']),'Fresh170 owner/root bindings changed')
    h['verify_data'](cp);module.recheck_inputs(context);module.recheck_sources(context)
    requirement=h['requirement'](module.APP);module.qualify_bundle170(h['manifest'](module.APP),context['documents']['bundle'],__import__('plistlib').loads(context['recipe'].checked_bytes(module.APP/'Contents/Info.plist'))['CFBundleVersion'],requirement,cp['after']['installedRequirement'])
    return {'checkpoint':CLOSED170,'before':BEFORE170,'boot':CURRENT_BOOT,'allSevenNativeRequestClosed':True,'leaseAbsent':True,'fourStoresExact':True,'originalCatalogExact':True,'currentAbsence':proof}


def observe(m,path,role,retain=False):
    initial=m.record(Path(path),False,True,False);stat_policy(path,role,initial)
    raw=None;out=copy.deepcopy(initial)
    if role['type']=='file':
        before=initial['stat'];digest=hashlib.sha256();parts=[];count=0
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
            require(all(getattr(os.fstat(f.fileno()),k)==before[k] for k in FIELDS),'Role changed on bounded open')
            while True:
                chunk=f.read(min(MAX,role['limit']+1-count))
                if not chunk:break
                count+=len(chunk);require(count<=role['limit'] and count<=before['st_size'],'Role grew beyond its limit');digest.update(chunk)
                if retain:parts.append(chunk)
            require(count==before['st_size'] and all(getattr(os.fstat(f.fileno()),k)==before[k] for k in FIELDS),'Role changed during bounded stream: '+path)
        out['sha256']=digest.hexdigest();raw=b''.join(parts) if retain else None
    require(same(initial,m.record(Path(path),False,True,False)),'Path identity/volume/stat changed during observation')
    row_from_record(path,role,out)
    return out,raw


def write_new(path,raw):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    fd=os.open(str(Path(path).parent),os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)


def main(argv=None):
    require(EXECUTION_ENABLED is True,'Disabled v1-map proposal: root review and explicit enabled derivative required')
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('capture','review'));parser.add_argument('paths',nargs='+');args=parser.parse_args(argv)
    require(len(args.paths)==(1 if args.mode=='capture' else 3),'Use capture NEW_DIRECTORY or review OBSERVATION OBS_SHA NEW_DIRECTORY')
    target=Path(args.paths[-1]);require(target.is_absolute() and target.parent==OUTPUTS and OUTPUTS.resolve(strict=True)==OUTPUTS and not os.path.lexists(target),'Fresh private output directly inside the fixed map series required')
    info=OUTPUTS.lstat();require(stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'Private output root required')
    source=own()
    if args.mode=='capture':
        module,context,cp,prior,plan=load_context();first=closed_boundary(module,context,cp,prior);m=context['modules']['m'];observations={};payloads={};rows=[]
        pointer_paths={p['path'] for p in plan['pointers']}
        for path,role in sorted(plan['roles'].items()):
            record,raw=observe(m,path,role,path in pointer_paths);observations[path]={'before':record};rows.append(row_from_record(path,role,record))
            if path in pointer_paths:payloads[path]=base64.b64encode(raw).decode()
            if path.startswith(CODING+'/') and role['type']=='file':
                entry=cp['dataManifests']['Qwen Local'][str(Path(path).relative_to(Path(CODING).parent))]
                require(entry=={'mode':stat.S_IMODE(record['stat']['st_mode']),'type':'file','size':record['stat']['st_size'],'sha256':record['sha256']},'Retained control/artifact differs from exact170 closed copy')
        namespaces=[{'path':path,'names':sorted(p.name for p in Path(path).iterdir())} for path in plan['namespaces']]
        for path,role in sorted(plan['roles'].items()):observations[path]['after']=observe(m,path,role)[0]
        require(all(row['names']==sorted(p.name for p in Path(row['path']).iterdir()) for row in namespaces),'Control namespace changed during capture')
        last=closed_boundary(module,context,cp,prior)
        value={'version':1,'kind':'stable-current-v1-worktree-map-observation','source':source,'captureBootSession':CURRENT_BOOT,'historicalContinuity':False,'closedCheckpoint':CLOSED170,'prebootCheckpoint':HISTORICAL169,'viewSource':VIEW_SOURCE,'verifierSource':VERIFIER_SOURCE,'viewReview':VIEW_REVIEW,'ledgerSHA256':LEDGER_SHA,'rows':rows,'namespaces':namespaces,'observations':observations,'pointerBytes':payloads,'beforeBoundary':first,'afterBoundary':last}
        review_observation(plan,value,saved_proof_verifier());require(own()==source,'Generator source changed during capture');target.mkdir(mode=0o700);path=target/'observation.json';write_new(path,encode(value))
    else:
        ref={'path':args.paths[0],'sha256':args.paths[1]};require(Path(ref['path']).parent.parent==OUTPUTS,'Observation must belong to the fixed preservation series')
        value=json.loads(checked(ref,64*MAX,0o600));cp,prior,plan=saved_inputs();require(value['source']==source,'Capture source changed before review');parts=review_observation(plan,value,saved_proof_verifier())
        review={'version':1,'kind':'generated-v1-map-component-review','source':source,'observation':ref,'closedCheckpoint':CLOSED170,'prebootCheckpoint':HISTORICAL169,'viewSource':VIEW_SOURCE,'viewReview':VIEW_REVIEW,'result':'component checks passed; independent root review and signed activation pending','independentRootReviewCompleted':False,'actualMapActivated':False,'records':9,'restoredArchives':2,'rowSetSHA256':sha(encode(parts)),'historicalContinuity':False}
        require(own()==source,'Generator source changed during review')
        target.mkdir(mode=0o700);review_path=target/'review.json';write_new(review_path,encode(review))
        document=map_document(parts,ref['sha256'],sha(review_path.read_bytes()));path=target/'map-candidate.json';write_new(path,encode(document))
    print(json.dumps({'path':str(path),'sha256':sha(path.read_bytes()),'actualMapActivated':False}))


if __name__=='__main__':main()
