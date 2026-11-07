import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('coding.js',import.meta.url),'utf8');
const begin=source.indexOf('function codingVerificationSummary('),end=source.indexOf('// CODING RESULT PRESENTATION END');
assert(begin>=0&&end>begin);
const api=vm.runInNewContext(source.slice(begin,end)+'\n({codingOwnResultTurns,codingExecutionLabel,codingChildResult,codingStartupRecovery,CODING_RETAINED_STARTUP_WARNING})');
const inherited={id:'parent-copy',status:'inheritedStopped',items:[{id:'parent-report',type:'agentMessage',text:'Parent says all checks passed.'},{id:'parent-command',type:'commandExecution',command:'false',cwd:'/fixture/parent',status:'completed',exitCode:1}]};
const command=(overrides={})=>({id:'command',type:'commandExecution',command:'printf result',cwd:'/fixture/project',status:'completed',exitCode:0,...overrides});
const turn=(overrides={})=>({id:'own',status:'completed',items:[command(),{id:'report',type:'agentMessage',text:'Model says everything passed.'}],...overrides});
const child=(turns=[inherited])=>({id:'child',parentThreadId:'parent',turns});
test('An explicit inherited-only history has no child result or inherited model report',()=>{
 const value=api.codingChildResult(child());assert.equal(value.status,'No agent result recorded');assert.equal(value.turnId,null);assert.equal(value.inheritedCount,1);assert.equal(value.report,'');
});
test('Only the explicit inherited marker is excluded; identical content is retained',()=>{
 const own=turn({items:inherited.items});assert.equal(api.codingOwnResultTurns(child([inherited,own])).length,1);assert.equal(api.codingChildResult(child([inherited,own])).turnId,'own');
});
test('Inherited parent command failure never becomes a child command result',()=>{
 const value=api.codingChildResult(child([inherited,turn()]));assert.equal(value.status,'Turn finished');assert.equal(value.receiptSummary,'Command receipts: 1 exited 0.');assert.equal(value.verification,'Verification: not established');
});
test('A child failure is retained and separate from inherited context',()=>{
 const value=api.codingChildResult(child([inherited,turn({status:'failed',error:{message:'Fixture child failure'},items:[command({status:'failed',exitCode:2})]})]));assert.match(value.status,/Error.*Fixture child failure/);assert.match(value.receiptSummary,/1 failed/);
});
test('A child interruption is its own stopped outcome',()=>{
 assert.equal(api.codingChildResult(child([inherited,turn({status:'interrupted'})])).status,'Stopped');
});
test('A new empty turn never borrows a prior model report',()=>{
 const value=api.codingChildResult(child([turn(),turn({id:'next',status:'inProgress',items:[]})]));assert.equal(value.report,'');assert.equal(value.turnId,'next');assert.equal(value.status,'Working…');
});
test('A live working observation supersedes an older completed snapshot',()=>{
 assert.equal(api.codingChildResult(child([turn()]),{working:true}).status,'Working…');
});
test('Stop and review states stay visible while a child is active',()=>{
 assert.equal(api.codingChildResult(child([turn()]),{working:true,stopping:true}).status,'Stopping…');assert.equal(api.codingChildResult(child([turn()]),{working:true,waiting:true}).status,'Waiting for review');
});
test('A local Stop awaiting confirmation is not presented as finished',()=>{
 assert.equal(api.codingChildResult({...child([turn()]),localStopped:true}).status,'Stop requested · checking state');
});
test('Pending history does not expose an obsolete model report as current',()=>{
 for(const input of [{...child([turn()]),metadataPending:true},child([turn()])]){const value=api.codingChildResult(input,{historyPending:true});assert.equal(value.status,'Loading agent history…');assert.equal(value.report,'');}
});
test('Unavailable history is stated without borrowing a prior model report',()=>{
 const value=api.codingChildResult({...child([turn()]),draftReadError:'fixture'});assert.match(value.status,/History unavailable/);assert.equal(value.report,'');
});
test('All observed history gaps remain flagged',()=>{
 for(const flag of ['historyWarning','historyTruncated','verificationGap'])assert.equal(api.codingChildResult({...child([turn()]),[flag]:true}).incomplete,true);
 assert.equal(api.codingChildResult(child([turn()]),{updatesInterrupted:true}).incomplete,true);
});
test('Conflicting receipt identities cannot establish a passing result',()=>{
 const value=api.codingChildResult(child([turn({items:[command(),command({exitCode:1})]})]));assert.match(value.receiptSummary,/1 failed/);assert.equal(value.verification,'Verification: not established');
});
test('Model prose and malformed command exit codes cannot establish verification',()=>{
 const value=api.codingChildResult(child([turn({items:[command({exitCode:'0'}),{type:'agentMessage',text:'TESTS PASS'}]})]));assert.match(value.receiptSummary,/unknown or conflicting/);assert.equal(value.verification,'Verification: not established');
});
test('Model preview is bounded and does not mutate the original saved history',()=>{
 const original=child([turn({items:[{type:'agentMessage',text:'x'.repeat(900)}]})]),before=JSON.stringify(original),value=api.codingChildResult(original);assert.equal(value.report.length,401);assert.equal(value.reportTruncated,true);assert.equal(JSON.stringify(original),before);
});
test('Inherited and unknown status labels never impersonate a current Stop',()=>{
 assert.equal(api.codingExecutionLabel(inherited),'Inherited parent context');assert.equal(api.codingExecutionLabel({status:'unexpected'}),'Status unavailable');
});
test('Retained startup count is deduplicated by owner identity',()=>{
 const value=api.codingStartupRecovery([{id:'one',state:'creating'},{id:'one',state:'creating'},{id:'two',state:'creating'},{id:'active',state:'ready'}]);assert.equal(value.count,2);assert.equal(value.summary,'2 incomplete task startups');assert.equal(value.relevant,false);
});
test('A retained startup bound to the selected task stays explicitly relevant',()=>{
 const owners=[{id:'one',state:'creating',rootThreadId:'root'}];assert.equal(api.codingStartupRecovery(owners,'','root').relevant,true);assert.equal(api.codingStartupRecovery(owners,'','child','root').relevant,true);assert.equal(api.codingStartupRecovery(owners,'','unrelated').relevant,false);
});
test('Missing count evidence is shown as unavailable, never invented as zero',()=>{
 const value=api.codingStartupRecovery(undefined,api.CODING_RETAINED_STARTUP_WARNING);assert.equal(value.visible,true);assert.equal(value.count,null);assert.match(value.summary,/count unavailable/);assert.equal(value.historyWarning,'');
});
test('Only the exact retained-startup warning moves out of the live banner',()=>{
 const warning=api.CODING_RETAINED_STARTUP_WARNING+' Current history also failed.';assert.equal(api.codingStartupRecovery([],warning).historyWarning,warning);assert.equal(api.codingStartupRecovery([],'Worktree handoff unavailable.').historyWarning,'Worktree handoff unavailable.');
});
test('No warning and no creating owners removes the retained summary',()=>{
 assert.equal(api.codingStartupRecovery([{id:'done',state:'ready'}],'').visible,false);
});

test('A bounded model preview never cuts a surrogate pair',()=>{
 const value=api.codingChildResult(child([turn({items:[{type:'agentMessage',text:'x'.repeat(399)+'🌊'+ 'tail'}]})]));assert.equal(value.report,'x'.repeat(399)+'…');assert.equal(value.reportTruncated,true);
});
