"""Read-only reproduction of the reviewed static worktree map from pinned saved evidence."""
from pathlib import Path
import ast,ctypes,hashlib,importlib.util,json,os,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
SOURCE=Path(os.environ['NOIEE_WORKTREE_SOURCE'])
forbidden=['/Users/saleh/Library/Application Support/Qwen Local','/Users/saleh/Applications','/Users/saleh/Library/Preferences','/Users/saleh/Library/WebKit','/Users/saleh/Library/HTTPStorages']
events=[]
def audit(event,args):
    if event.startswith(('subprocess.','socket.','ctypes.dlopen','os.exec','os.spawn')) or event in ('os.system','os.fork','os.posix_spawn','os.kill','os.killpg','os.mkdir','os.rmdir','os.remove','os.rename','os.chmod','os.chown','os.link','os.symlink','os.truncate'):
        events.append(event);raise AssertionError('Process, network, native execution or filesystem mutation forbidden')
    if event=='open':
        if isinstance(args[0],(str,bytes)):
            path=os.fsdecode(args[0])
            if any(path==root or path.startswith(root+'/') for root in forbidden):
                events.append('original-read');raise AssertionError('Original store or managed root read forbidden')
        if isinstance(args[1],str) and any(c in args[1] for c in 'wax+') or isinstance(args[2],int) and args[2]&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC):
            events.append('write');raise AssertionError('Read-only authentic map verification')
sys.addaudithook(audit)
checks=[]
def passed(name):
    checks.append(name)
def sha(raw):
    return hashlib.sha256(raw).hexdigest()
producer=HERE/'capture-v1-map-disabled.py'
assert sha(producer.read_bytes())=='bb9e5878bd95a7bd1243244324a0e897e4e6f40f9da23360262c3e37311348b8'
spec=importlib.util.spec_from_file_location('disabled_map_proposal',producer)
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
assert p.EXECUTION_ENABLED is False
passed('unchanged disabled producer loaded without executing capture')
enabled={'path':'/Users/saleh/Documents/Codex/2026-10-16/sa/work/build171-parity-integration/worktree-map-root-v3/capture-v1-map-enabled.py','sha256':'c67f794992f4267c009dbc96ce435a00e30bd976ea0d2f8cbb016adc3ff7152c'}
assert p.checked(enabled)==producer.read_bytes().replace(b'EXECUTION_ENABLED=False',b'EXECUTION_ENABLED=True',1)
passed('saved observation producer is exact reviewed bool-only enabled derivative; read only')
observation_ref={'path':'/Users/saleh/Library/Caches/SalehWorktreeMap170/capture-v3/observation.json','sha256':'c7cdf643735268ba8af3be4a6182517944b396fa28dde78e44aa4a32484b1ab8'}
review_ref={'path':'/Users/saleh/Library/Caches/SalehWorktreeMap170/review-v3/review.json','sha256':'f771ad683eacef57fa2118e2647be3ccd0b7a10e1d92382cb613aca3ada45376'}
map_ref={'path':'/Users/saleh/Library/Caches/SalehWorktreeMap170/review-v3/map-candidate.json','sha256':'af1c4ef07e863d6b9c7f032f09b0ba648c0f025f7365ce9f7fc5c9e04169b1d5'}
observation=json.loads(p.checked(observation_ref,64*p.MAX,0o600))
review=json.loads(p.checked(review_ref,64*p.MAX,0o600))
original_map=p.checked(map_ref,p.MAX,0o600)
assert observation['source']==enabled and review['source']==enabled
passed('authentic observation, component review and original candidate match exact SHA256 pins')
cp,prior,plan=p.saved_inputs()
forbidden.extend(plan['roles'])
assert len(plan['ledger']['records'])==9
assert sum(bool(record.get('archive')) for record in plan['ledger']['records'])==2
passed('saved closed copies preserve exact nine-record ledger and two archives')
for reference in (p.COLLECTOR170,p.DISABLED170,p.VIEW_SOURCE,p.VERIFIER_SOURCE,p.VIEW_REVIEW):
    p.checked(reference)
passed('historical collector, consumer and verifier evidence remains pinned')
parts=p.review_observation(plan,observation,p.saved_proof_verifier())
assert len(parts['rows'])==84 and len(parts['namespaces'])==22
passed('all 84 authentic rows, 22 control namespaces and both saved native closure proofs revalidated')
expected_review={'version':1,'kind':'generated-v1-map-component-review','source':enabled,'observation':observation_ref,'closedCheckpoint':p.CLOSED170,'prebootCheckpoint':p.HISTORICAL169,'viewSource':p.VIEW_SOURCE,'viewReview':p.VIEW_REVIEW,'result':'component checks passed; independent root review and signed activation pending','independentRootReviewCompleted':False,'actualMapActivated':False,'records':9,'restoredArchives':2,'rowSetSHA256':p.sha(p.encode(parts)),'historicalContinuity':False}
assert review==expected_review
passed('component review exactly binds revalidated row set and saved lineage')
document=p.map_document(parts,observation_ref['sha256'],review_ref['sha256'])
assert p.encode(document)==original_map
passed('pure map reproduction matches original candidate byte for byte')
bundled=p.checked({'path':str(SOURCE/'worktree-handoff-adoption.json'),'sha256':map_ref['sha256']},p.MAX)
assert bundled==original_map
assert ('WORKTREE_HANDOFF_ADOPTION_SHA256="'+map_ref['sha256']+'";') in (SOURCE/'legacy-admission.mjs').read_text()
passed('Noiee bundled map and verifier constant match authentic reviewed bytes')
assert not set(row['path'] for row in document['namespaces']).intersection(plan['workingRoots'])
assert document['historicalContinuity'] is False
assert document['dataDirectory']=={'path':p.CODING,'volumeUUID':p.VOLUME,'ino':'26838645','uid':501}
passed('working-root child lists absent and original volume identity retained')
assert not events and p.EXECUTION_ENABLED is False
passed('no original-store reads, live native calls, capture, processes, network or writes')
print(json.dumps({'name':'authentic-v3-map-read-only-reproduction','sourceDirectory':str(SOURCE),'passed':len(checks),'failed':0,'checks':checks,'mapSHA256':sha(bundled),'rows':84,'controlNamespaces':22,'records':9,'restoredArchives':2,'effects':events,'originalReads':0,'nativeHelperExecutions':0,'liveMapCaptureExecuted':False,'mapActivated':False,'currentBootAuthenticated':False,'scope':'Revalidates saved historical observation and bundled static map; live successor admission remains an independent runtime gate.','evidence':[enabled,observation_ref,review_ref,map_ref]},indent=2))
