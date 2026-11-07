import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const path=new URL('./github-transport.mjs',import.meta.url);
const api=existsSync(path)?await import(path):{};
assert.equal(typeof api.githubTarget,'function','Missing canonical GitHub destination validation');
assert.deepEqual(api.githubTarget('https://github.com/owner/repo.git'),{host:'github.com',owner:'owner',repo:'repo',fullName:'owner/repo',url:'https://github.com/owner/repo.git'});
assert.equal(api.githubTarget('https://github.com/Owner/Repo').url,'https://github.com/Owner/Repo.git');
for(const value of ['https://token@github.com/owner/repo','https://github.com/owner/repo?token=x','https://github.com/owner/repo#x','http://github.com/owner/repo','https://github.com:443/owner/repo','https://evil.example/owner/repo','https://github.com/owner/../repo','https://github.com/owner/%72epo','git@github.com:owner/repo.git','file:///private/fixture.git','https://github.com/owner/repo/','https://github.com/owner/repo/other'])assert.throws(()=>api.githubTarget(value),/GitHub/);
assert.equal(api.githubBranch('feature/مرحبا'),'feature/مرحبا');
for(const value of ['','-branch','refs/heads/main','HEAD','a..b','a@{b','a.lock','a//b','.hidden','a/.hidden','a/','a\\b','a\nb','a?b'])assert.throws(()=>api.githubBranch(value),/branch/);
assert.equal(typeof api.githubRemotes,'function','Missing secret-free configured GitHub remote inventory');
const config=rows=>rows.flatMap(([key,value])=>['file:/private/fixture/config',key+'\n'+value]).join('\0')+'\0';
assert.equal(api.githubRemotes(config([['remote.origin.url','https://github.com/owner/repo.git']]))[0].supported,true);
for(const rows of [
  [['remote.origin.url','https://token@github.com/owner/repo']],
  [['remote.origin.url','https://github.com/owner/repo'],['remote.origin.pushurl','https://github.com/owner/one'],['remote.origin.pushurl','https://github.com/owner/two']],
  [['remote.origin.url','https://github.com/owner/repo'],['url.https://evil.example/.pushinsteadof','https://github.com/']],
  [['remote.origin.url','https://github.com/owner/repo'],['remote.origin.mirror','true']]
]){const rowsOut=api.githubRemotes(config(rows));assert.equal(rowsOut[0].supported,false);assert(!JSON.stringify(rowsOut).includes('token@'));assert(!Object.hasOwn(rowsOut[0],'url'));}
console.log('PASS: exact GitHub destination and branch validation; credentialed, ambiguous and unsupported targets refused');

const {GitHubTransport}=api;
assert.equal(typeof GitHubTransport,'function','Missing isolated GitHub publication transport');
const {mkdtemp,mkdir,writeFile,readFile,realpath}=await import('node:fs/promises');
const {join}=await import('node:path');
const {spawn,execFile,execFileSync}=await import('node:child_process');
const {promisify}=await import('node:util');
const {GitRunner,GIT,CORE,SANDBOX,gitPolicy}=await import('./git-runner.mjs');
const exec=promisify(execFile),root=await realpath(await mkdtemp(join(new URL('../checks/',import.meta.url).pathname,'publish-fixture-'))),source=join(root,'source'),bare=join(root,'remote.git');
await mkdir(source,{mode:0o700});
const raw=async(cwd,args)=>exec(GIT,['--no-optional-locks','-C',cwd,...args],{env:{...process.env,GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'}});
await raw(source,['init','-b','main']);await writeFile(join(source,'file.txt'),'BASE\n');await raw(source,['add','file.txt']);await raw(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
const base=(await raw(source,['rev-parse','HEAD'])).stdout.trim();await raw(root,['init','--bare',bare]);
await writeFile(join(source,'file.txt'),'MIDDLE\n');await raw(source,['add','file.txt']);await raw(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','middle']);const middle=(await raw(source,['rev-parse','HEAD'])).stdout.trim();
await writeFile(join(source,'file.txt'),'NEXT\n');await raw(source,['add','file.txt']);await raw(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','next']);
const next=(await raw(source,['rev-parse','HEAD'])).stdout.trim();await writeFile(join(source,'file.txt'),'UNSENT SOURCE EDIT\n');const index=await readFile(join(source,'.git/index')),sourceConfig=await readFile(join(source,'.git/config'));
const target=api.githubTarget('https://github.com/fixture/repo'),calls=[],events=[];let raceOnPush=false,equalNewRace=null;
const spawnFixture=(file,args,options)=>{
  if(args.includes('auth')&&args.includes('token')){events.push('auth');return spawn('/usr/bin/printf',['fixture-opaque-token'],options);}
  const at=args.indexOf(GIT);assert(at>=0,'Only fixed Git or auth helper is launched');const actual=args.slice(at+1).map(x=>x===target.url?bare:x==='protocol.file.allow=never'?'protocol.file.allow=always':x);
  const policy=gitPolicy({dirs:[root]}).replace('(deny network*)','(allow process-exec (literal "/bin/sh") (literal "/bin/bash") (literal '+JSON.stringify(join(CORE,'git-receive-pack'))+') (literal '+JSON.stringify(join(CORE,'git-upload-pack'))+'))\n(deny network*)');
  if(raceOnPush&&actual.includes('push')){raceOnPush=false;execFileSync(GIT,['--git-dir='+bare,'update-ref','refs/heads/feature',middle,base]);}
  if(equalNewRace&&actual.includes('push')){const {branch,oldOID}=equalNewRace;equalNewRace=null;execFileSync(GIT,['--git-dir='+bare,'update-ref','refs/heads/'+branch,next,oldOID??'0'.repeat(40)]);}
  calls.push(actual);return spawn(SANDBOX,['-p',policy,GIT,...actual],options);
};
let accountId=7,httpMode='',postCount=0,workflowMode=false,hasPR=false,lastPR=null;const apiRequests=[];
const oid=async branch=>{try{return(await raw(bare,['rev-parse','--verify','refs/heads/'+branch])).stdout.trim();}catch{return null;}};
const pr=(number=12)=>({number,id:55+number,html_url:`https://github.com/fixture/repo/pull/${number}`,state:'open',draft:true,title:'Fixture PR',body:'draft body',head:{ref:'feature',sha:next,repo:{id:21,full_name:'fixture/repo'}},base:{ref:'main',sha:base,repo:{id:21,full_name:'fixture/repo'}}});
const fetchFixture=async(url,options)=>{
  assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer fixture-opaque-token');apiRequests.push({url,method:options.method,body:options.body});
  let data,status=200;const u=new URL(url);
  if(httpMode==='wait'||httpMode==='hang')return new Promise((resolve,reject)=>{if(httpMode==='wait')options.signal.addEventListener('abort',()=>reject(Error('fixture aborted')),{once:true});});
  if(httpMode==='redirect'){status=302;data={};}
  else if(httpMode==='oversize')data='x'.repeat(3*1024*1024);
  else if(u.pathname==='/user')data={id:accountId,login:'fixture'};
  else if(u.pathname==='/repos/fixture/repo')data={id:21,full_name:'fixture/repo',default_branch:'main',permissions:{push:true}};
  else if(u.pathname.startsWith('/repos/fixture/repo/git/ref/heads/')){const branch=decodeURIComponent(u.pathname.split('/heads/')[1]),sha=await oid(branch);if(sha)data={ref:'refs/heads/'+branch,object:{type:'commit',sha}};else{status=404;data={message:'Not Found'};}}
  else if(u.pathname==='/repos/fixture/repo/pulls'&&options.method==='POST'){postCount++;data=pr();if(workflowMode){const payload=JSON.parse(options.body);data={...data,title:payload.title,body:payload.body,head:{...data.head,ref:payload.head},base:{...data.base,ref:payload.base}};if(httpMode==='mismatchedPR')data.head.ref='renamed-during-creation';hasPR=true;lastPR=data;if(httpMode==='lostPR')throw Error('synthetic lost reply');}}
  else if(u.pathname==='/repos/fixture/repo/pulls'&&httpMode==='incomplete')data=Array.from({length:100},(_,i)=>pr(i+1+(Number(u.searchParams.get('page'))-1)*100));
  else if(u.pathname==='/repos/fixture/repo/pulls')data=workflowMode&&hasPR?[lastPR]:[];
  else if(u.pathname==='/repos/fixture/repo/pulls/12'){data=workflowMode&&lastPR?lastPR:pr();if(httpMode==='canonicalCase')data.html_url='https://github.com/Fixture/Repo/pull/12';}
  else throw Error('Unexpected fixture API request');
  const response=new Response(JSON.stringify(data),{status});Object.defineProperty(response,'url',{value:url});return response;
};
const transport=new GitHubTransport({dataDir:root,spawnProcess:spawnFixture,fetchImpl:fetchFixture}),check=()=>{};
assert.deepEqual(await transport.account(check,true),{id:7,login:'fixture'});
assert.deepEqual(await transport.repository(target,check),{id:21,fullName:'fixture/repo',defaultBranch:'main',canPush:true});
assert.equal(await transport.ref(target,'feature',check),null);
const remote=await transport.prepareRepository(join(root,'private-one'),{commonDir:join(source,'.git')},check);
const nativePolicy=transport.git.launchSpec(['--version'],{scope:{dirs:[remote.path]},env:{},record:null}).args[1];await exec(SANDBOX,['-p',nativePolicy,'/bin/sh','-c','exit 0']);await assert.rejects(exec(SANDBOX,['-p',gitPolicy(),'/bin/sh','-c','exit 0']));
const authPolicy=transport.auth.launchSpec(['--version'],{scope:{},env:{},record:null}).args[1];await exec(SANDBOX,['-p',authPolicy,'/usr/bin/security','help','find-generic-password']);
const fixtureGH=join(root,'fixture-gh');await mkdir(fixtureGH,{mode:0o700});await writeFile(join(fixtureGH,'hosts.yml'),'github.com:\n  user: fixture\n  oauth_token: fixture-opaque-token\n  git_protocol: https\n',{mode:0o600});
await writeFile(join(fixtureGH,'config.yml'),'version: \"1\"\n',{mode:0o600});
const nativeAuth=new GitHubTransport({dataDir:root,fetchImpl:fetchFixture});assert.equal((await nativeAuth.auth.run(['auth','token','--hostname','github.com'],{env:{HOME:root,GH_CONFIG_DIR:fixtureGH}})).stdout.trim(),'fixture-opaque-token','Actual GitHub CLI reads only the disposable synthetic connection');
await transport.push(remote,target,'feature',null,base,check);assert.equal(await oid('feature'),base);
await transport.push(remote,target,'feature',base,next,check);assert.equal(await oid('feature'),next);
const pushCalls=calls.filter(args=>args.includes('push'));assert.equal(pushCalls.length,2);assert(pushCalls[0].includes('--force-with-lease=refs/heads/feature:'));assert(pushCalls[1].includes('--force-with-lease=refs/heads/feature:'+base));assert(pushCalls[1].includes(next+':refs/heads/feature'));assert(!pushCalls.some(args=>args.some(x=>['--force','--mirror','--tags','--set-upstream','--delete'].includes(x))));
await assert.rejects(transport.push(remote,target,'feature',next,base,check),/fast-forward|ancestor/);assert.equal(calls.filter(args=>args.includes('push')).length,2);
await raw(bare,['update-ref','refs/heads/feature',base,next]);
await assert.rejects(transport.push(remote,target,'feature',next,next,check),/changed|stale/);assert.equal(await oid('feature'),base);
raceOnPush=true;await assert.rejects(transport.push(remote,target,'feature',base,next,check),/GitHub command/);assert.equal(await oid('feature'),middle,'A compatible remote advance after the last client check must not be overwritten');
await raw(bare,['update-ref','refs/heads/feature',next,middle]);
equalNewRace={branch:'creation-equal-race',oldOID:null};await assert.rejects(transport.push(remote,target,'creation-equal-race',null,next,check),/changed|stale|up.to.date/);assert.equal(await oid('creation-equal-race'),next);
await raw(bare,['update-ref','refs/heads/update-equal-race',base]);equalNewRace={branch:'update-equal-race',oldOID:base};await assert.rejects(transport.push(remote,target,'update-equal-race',base,next,check),/changed|stale|up.to.date/);assert.equal(await oid('update-equal-race'),next);
assert.deepEqual(await transport.pulls(target,'feature','main',check),[]);
const created=await transport.createPR(target,{head:'feature',base:'main',title:'Fixture PR',body:'draft body'},check);assert.equal(created.number,12);assert.equal(created.url,'https://github.com/fixture/repo/pull/12');assert.equal(postCount,1);assert.equal((await transport.pull(target,12,check)).head.sha,next);
const payload=JSON.parse(apiRequests.find(x=>x.method==='POST').body);assert.deepEqual(payload,{head:'feature',base:'main',title:'Fixture PR',body:'draft body',draft:true,maintainer_can_modify:false});
assert.equal(calls.filter(args=>args.includes('push')).length,5,'PR-only operations never invoke push');
httpMode='incomplete';await assert.rejects(transport.pulls(target,'feature','main',check),/complete|limit|pagination/);httpMode='redirect';await assert.rejects(transport.repository(target,check),/GitHub/);httpMode='oversize';await assert.rejects(transport.repository(target,check),/GitHub/);httpMode='';
assert.deepEqual(await readFile(join(source,'.git/index')),index);assert.deepEqual(await readFile(join(source,'.git/config')),sourceConfig);assert.equal(await readFile(join(source,'file.txt'),'utf8'),'UNSENT SOURCE EDIT\n');assert.equal((await raw(source,['rev-parse','HEAD'])).stdout.trim(),next);
httpMode='canonicalCase';assert.equal((await transport.pull(target,12,check)).number,12);httpMode='wait';const stopped=transport.repository(target,check);await new Promise(resolve=>setImmediate(resolve));transport.cancel();await assert.rejects(stopped,/GitHub/);assert.equal(transport.blocked,false);httpMode='';
const stalled=new GitHubTransport({dataDir:root,spawnProcess:spawnFixture,fetchImpl:fetchFixture});await stalled.account(check,true);httpMode='hang';const uncertain=stalled.repository(target,check);await new Promise(resolve=>setImmediate(resolve));stalled.cancel();await assert.rejects(uncertain,/GitHub/);assert.equal(stalled.blocked,true);httpMode='';transport.cancel();
assert(gitPolicy().endsWith('(deny network*)'));assert(!gitPolicy().includes('github.com'));
console.log('PASS: real bare creation/fast-forward and stale/nonancestor refusal; PR-only fixed API; account binding, redirect/oversize/pagination guards; source HEAD/index/config/edit exact; no real account or network used');

const {GitWorkflow}=await import('./git-workflow.mjs');
await raw(source,['remote','add','origin',target.url]);await raw(bare,['update-ref','refs/heads/main',base]);const workflowConfig=await readFile(join(source,'.git/config'));
const dataDir=join(root,'workflow-data');let held=0;
const workflowOptions={dataDir,remoteTransport:transport,reserveMutation:async resolve=>{await resolve();held++;return {release(){held--;}};}};
let workflow=new GitWorkflow(workflowOptions);
const inspect=async()=> (await workflow.handle({action:'inspect',cwd:source})).snapshot;
const first=await inspect();assert.equal(first.remotes?.[0]?.url,target.url,'Missing configured safe remote snapshot in Changes');
const prior={requestId:crypto.randomUUID(),cwd:source,repositoryId:first.repositoryId,kind:'stage',at:Date.now(),state:'completed',message:'Prior fixture receipt must stay exact'};workflow.receipts.push({...prior});await workflow.save();
const remoteView=async(branch='feature')=>{const snapshot=await inspect();const answer=await workflow.handle({action:'remoteInspect',cwd:source,snapshotId:snapshot.id,requestId:crypto.randomUUID(),remote:'origin',branch,base:'main'});assert(answer.remoteSnapshot,JSON.stringify(answer));return {snapshot,remote:answer.remoteSnapshot};};
const prepareRemote=async(kind,view,extra={})=>workflow.handle({action:'prepare',cwd:source,snapshotId:view.snapshot.id,requestId:crypto.randomUUID(),request:{kind,remoteSnapshotId:view.remote.id,...extra}});
const execute=plan=>workflow.handle({action:'execute',requestId:plan.requestId,planId:plan.id});
const view=await remoteView('published-fixture');assert.equal(view.remote.account.id,7);assert.equal(view.remote.repository.id,21);assert.equal(view.remote.oldOID,null);
const publication=await prepareRemote('publishBranch',view);assert(publication.plan,JSON.stringify(publication));
const runGit=transport.runGit.bind(transport);transport.runGit=async(p,args,...rest)=>{if(args[0]==='push'){const saved=JSON.parse(await readFile(join(dataDir,'git-workflow.json'),'utf8')),receipt=saved.receipts.find(row=>row.requestId===publication.plan.requestId);assert.equal(receipt.state,'executing');assert.equal(receipt.remoteIntent.repository.id,21);assert.equal(receipt.remoteIntent.head.oid,next);assert.equal(receipt.remoteIntent.account.id,7);assert(!JSON.stringify(receipt).includes('fixture-opaque-token'));}return runGit(p,args,...rest);};
const published=await execute(publication.plan);assert.equal(published.state,'completed',JSON.stringify(published));assert.equal(published.disposition,'published');assert.equal(await oid('published-fixture'),next);assert.equal(held,0);transport.runGit=runGit;
workflowMode=true;const prView=await remoteView();const draftPlan=await prepareRemote('createPR',prView,{title:'Lost reply fixture',body:'Keep this draft'});assert(draftPlan.plan,JSON.stringify(draftPlan));httpMode='lostPR';const beforePost=postCount,uncertainResult=await execute(draftPlan.plan);httpMode='';assert.equal(uncertainResult.state,'unknown',JSON.stringify(uncertainResult));assert.equal(postCount,beforePost+1);assert.equal(hasPR,true);assert.equal(held,0);
await workflow.close();workflow=new GitWorkflow(workflowOptions);
const retryView=await remoteView();const fenced=await prepareRemote('createPR',retryView,{title:'Do not resend',body:'Kept'});assert.equal(fenced.state,'failed');assert.match(fenced.message,/inspect|uncertain/i);assert.equal(postCount,beforePost+1);
await assert.rejects(workflow.handle({action:'prepare',cwd:source,snapshotId:retryView.snapshot.id,requestId:draftPlan.plan.requestId,request:{kind:'createPR',remoteSnapshotId:retryView.remote.id,title:'replay',body:'no'}}),/consumed/);
const observation=await workflow.handle({action:'inspectRemoteOutcome',cwd:source,requestId:draftPlan.plan.requestId});assert(observation.observation,JSON.stringify(observation));assert.equal(observation.observation.matches[0].url,'https://github.com/fixture/repo/pull/12');
await assert.rejects(workflow.handle({action:'acknowledgeRemoteOutcome',cwd:source,requestId:draftPlan.plan.requestId,observationId:crypto.randomUUID()}),/observation|inspection/i);
const acknowledged=await workflow.handle({action:'acknowledgeRemoteOutcome',cwd:source,requestId:draftPlan.plan.requestId,observationId:observation.observation.id});assert.equal(acknowledged.acknowledged,true);
const existingView=await remoteView(),existingPlan=await prepareRemote('createPR',existingView,{title:'My new unsent title',body:'Do not overwrite the existing PR'});assert(existingPlan.plan,JSON.stringify(existingPlan));const existing=await execute(existingPlan.plan);assert.equal(existing.state,'completed');assert.equal(existing.disposition,'existing');assert.equal(postCount,beforePost+1,'Existing PR never causes another POST');
const accountView=await remoteView('account-change'),accountPlan=await prepareRemote('publishBranch',accountView);assert(accountPlan.plan);accountId=8;const changedAccount=await execute(accountPlan.plan);accountId=7;assert.equal(changedAccount.state,'stale');assert.equal(await oid('account-change'),null);assert.equal(held,0);
const saved=JSON.parse(await readFile(join(dataDir,'git-workflow.json'),'utf8'));assert.deepEqual(saved.receipts.find(row=>row.requestId===prior.requestId),prior);assert(!JSON.stringify(saved).includes('fixture-opaque-token'));const uncertainReceipt=saved.receipts.find(row=>row.requestId===draftPlan.plan.requestId);assert.equal(uncertainReceipt.state,'unknown');assert.equal(uncertainReceipt.remoteAcknowledged,true);assert.equal(uncertainReceipt.remoteIntent.head.ref,'feature');assert.equal(uncertainReceipt.remoteIntent.base.ref,'main');assert.equal(typeof uncertainReceipt.remoteIntent.payload.bodySHA256,'string');
const configView=await remoteView('late-config'),configPlan=await prepareRemote('publishBranch',configView);assert(configPlan.plan);await raw(source,['config','fixture.late','true']);const beforeLate=calls.filter(args=>args.includes('push')).length;assert.equal((await execute(configPlan.plan)).state,'stale');assert.equal(calls.filter(args=>args.includes('push')).length,beforeLate);await writeFile(join(source,'.git/config'),workflowConfig);
const sourceView=await remoteView('late-source'),sourcePlan=await prepareRemote('publishBranch',sourceView);assert(sourcePlan.plan);await writeFile(join(source,'file.txt'),'NEWER DRAFT EDIT\n');assert.equal((await execute(sourcePlan.plan)).state,'stale');await writeFile(join(source,'file.txt'),'UNSENT SOURCE EDIT\n');assert.equal(held,0);
const stopView=await remoteView('stopped-before-dispatch'),stopPlan=await prepareRemote('publishBranch',stopView);assert(stopPlan.plan);const saveBeforeStop=workflow.save.bind(workflow);let stopTriggered=false;workflow.save=async()=>{await saveBeforeStop();if(!stopTriggered && workflow.receipts.some(row=>row.requestId===stopPlan.plan.requestId && row.state==='executing')){stopTriggered=true;void workflow.stop(stopPlan.plan.requestId);}};const beforeStoppedPush=calls.filter(args=>args.includes('push')).length,stoppedPlanResult=await execute(stopPlan.plan);workflow.save=saveBeforeStop;assert.equal(stoppedPlanResult.state,'unknown');assert.equal(calls.filter(args=>args.includes('push')).length,beforeStoppedPush);assert.equal(await oid('stopped-before-dispatch'),null);assert.equal(held,0);const stopObservation=await workflow.handle({action:'inspectRemoteOutcome',cwd:source,requestId:stopPlan.plan.requestId});await workflow.handle({action:'acknowledgeRemoteOutcome',cwd:source,requestId:stopPlan.plan.requestId,observationId:stopObservation.observation.id});
hasPR=false;const mismatchView=await remoteView(),mismatchPlan=await prepareRemote('createPR',mismatchView,{title:'Keep verified URL',body:'Changed ref fixture'});assert(mismatchPlan.plan);const countBeforeMismatch=postCount;httpMode='mismatchedPR';const mismatchResult=await execute(mismatchPlan.plan);httpMode='';assert.equal(mismatchResult.state,'unknown');assert.equal(postCount,countBeforeMismatch+1);assert.equal(mismatchResult.url,'https://github.com/fixture/repo/pull/12','A verified canonical URL must survive stricter ref mismatch');await workflow.close();workflow=new GitWorkflow(workflowOptions);await inspect();assert.equal(workflow.receipts.find(r=>r.requestId===mismatchPlan.plan.requestId).remoteURL,mismatchResult.url);
assert.deepEqual(await readFile(join(source,'.git/index')),index);assert.deepEqual(await readFile(join(source,'.git/config')),workflowConfig);assert.equal(await readFile(join(source,'file.txt'),'utf8'),'UNSENT SOURCE EDIT\n');await workflow.close();
console.log('PASS: durable consumed intent before push; real ref result, lost PR reply/restart fence/inspection/explicit acknowledgement, existing PR without POST, changed account refusal and exact old receipt/source state');

const {ManagedWorktrees}=await import('./managed-worktrees.mjs'),{CodingOwners}=await import('./coding-owners.mjs'),{createServer}=await import('./server.mjs'),{nativeSignature}=await import('./agent.mjs'),{once}=await import('node:events');
const routeData=join(root,'route-data'),manager=new ManagedWorktrees({dataDir:routeData,managedMutationBlocked:true}),owners=new CodingOwners({dataDir:routeData,managedMutationBlocked:true,openExecutor:async()=>{throw Error('No model executor is part of Git publication');},engineOptions:{fullAccess:true,assertProject:p=>manager.assertProject(p)}});
const routed=new GitWorkflow({dataDir:routeData,remoteTransport:transport,reserveMutation:(resolve,policy)=>owners.reserveProjectMutation(resolve,policy),assertProject:p=>manager.assertProject(p)}),token=crypto.randomUUID(),server=createServer({instanceToken:token,fullAccess:true,unconfinedBoot:true,coding:owners,worktrees:manager,gitWorkflow:routed,hub:{stop:async()=>{},close:async()=>{}}});server.listen(0,'127.0.0.1');await once(server,'listening');
const call=async(input,status=200)=>{const route='/api/tools/git',body=JSON.stringify(input),nonce=crypto.randomUUID(),time=String(Date.now()),response=await fetch(`http://127.0.0.1:${server.address().port}`+route,{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Nonce':nonce,'X-Qwen-Time':time,'X-Qwen-Permit':nativeSignature(token,route,nonce,time,body)},body});const answer=await response.json();assert.equal(response.status,status,JSON.stringify(answer));return answer;};
try{
  const snapshot=(await call({action:'inspect',cwd:source})).snapshot,remoteSnapshot=(await call({action:'remoteInspect',cwd:source,snapshotId:snapshot.id,requestId:crypto.randomUUID(),remote:'origin',branch:'signed-route-fixture',base:'main'})).remoteSnapshot;
  const plan=(await call({action:'prepare',cwd:source,snapshotId:snapshot.id,requestId:crypto.randomUUID(),request:{kind:'publishBranch',remoteSnapshotId:remoteSnapshot.id}})).plan;assert(plan);await call({action:'execute',requestId:crypto.randomUUID(),planId:plan.id},409);const answer=await call({action:'execute',requestId:plan.requestId,planId:plan.id});assert.equal(answer.state,'completed');assert.equal(await oid('signed-route-fixture'),next);
  const largeSnapshot=(await call({action:'inspect',cwd:source})).snapshot,largeView=(await call({action:'remoteInspect',cwd:source,snapshotId:largeSnapshot.id,requestId:crypto.randomUUID(),remote:'origin',branch:'feature',base:'main'})).remoteSnapshot;const beforeLarge=postCount;for(const body of ['\\'.repeat(50000),'\x01'.repeat(65536)]){const largePlan=(await call({action:'prepare',cwd:source,snapshotId:largeSnapshot.id,requestId:crypto.randomUUID(),request:{kind:'createPR',remoteSnapshotId:largeView.id,title:'Escaped body fixture',body}})).plan;assert(largePlan);await call({action:'stop',requestId:largePlan.requestId});}assert.equal(postCount,beforeLarge,'Preparing legal escaped bodies never posts');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/tools/git`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'inspect',cwd:source})})).status,403);
}finally{await server.shutdownTools();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log('PASS: signed Full Access route publishes through actual owner/project leases; mismatched execution and unsigned requests refused; no model executor');

hasPR=false;let heldBlocked=0,postStarted;const reachedPost=new Promise(resolve=>{postStarted=resolve;}),blockedTransport=new GitHubTransport({dataDir:root,spawnProcess:spawnFixture,fetchImpl:async(url,options)=>{if(options.method==='POST'){postStarted();return new Promise(()=>{});}return fetchFixture(url,options);}});
const blockedWorkflow=new GitWorkflow({dataDir:join(root,'blocked-data'),remoteTransport:blockedTransport,reserveMutation:async resolve=>{await resolve();heldBlocked++;return {release(){heldBlocked--;}};}}),blockedSnapshot=(await blockedWorkflow.handle({action:'inspect',cwd:source})).snapshot;
const blockedView=(await blockedWorkflow.handle({action:'remoteInspect',cwd:source,snapshotId:blockedSnapshot.id,requestId:crypto.randomUUID(),remote:'origin',branch:'feature',base:'main'})).remoteSnapshot;
const blockedPlan=(await blockedWorkflow.handle({action:'prepare',cwd:source,snapshotId:blockedSnapshot.id,requestId:crypto.randomUUID(),request:{kind:'createPR',remoteSnapshotId:blockedView.id,title:'Unconfirmed transport fixture',body:'Keep me'}})).plan;assert(blockedPlan);
const blockedRun=blockedWorkflow.handle({action:'execute',requestId:blockedPlan.requestId,planId:blockedPlan.id});await reachedPost;await blockedWorkflow.stop(blockedPlan.requestId);assert.equal((await blockedRun).state,'unknown');assert.equal(blockedWorkflow.blocked,true);assert.equal(heldBlocked,1,'Unconfirmed transport retains its project lease and private evidence');assert(existsSync(join(blockedWorkflow.root,blockedPlan.id)));assert.equal(blockedWorkflow.receipts.find(row=>row.requestId===blockedPlan.requestId).state,'unknown');await blockedWorkflow.close();assert.equal(heldBlocked,1);
console.log('PASS: Stop after consumed intent with unconfirmed HTTP exit preserves unknown receipt, private evidence and project lease; no replay');
