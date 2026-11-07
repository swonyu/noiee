// Actual compaction source in a capability-free VM. Generated in-memory history
// only: no product imports, network, child processes, native bridge, or stores.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {randomUUID,webcrypto,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const SOURCE=fileURLToPath(new URL('../../source/',import.meta.url)).replace(/\/$/,'');
const helper=fs.readFileSync(SOURCE+'/context-compaction.js','utf8'),app=fs.readFileSync(SOURCE+'/app.js','utf8');
const rows=[],clone=value=>structuredClone(value),json=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
const hash=raw=>createHash('sha256').update(raw).digest('hex'),byteLength=value=>Buffer.byteLength(value,'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function test(name,fn){try{await fn();rows.push({name,passed:true});console.log('PASS '+name);}catch(error){rows.push({name,passed:false,error:error.stack});console.log('FAIL '+name+' '+error.stack);}}
function environment(){
  let waiting=false,release,gate=Promise.resolve(),uuidCalls=0,digestCalls=0;
  const crypto={randomUUID(){uuidCalls++;return randomUUID();},subtle:{digest:async(...args)=>{digestCalls++;if(waiting)await gate;return webcrypto.subtle.digest(...args);}}};
  const context=vm.createContext({TextEncoder,TextDecoder,structuredClone,crypto},{codeGeneration:{strings:false,wasm:false}});
  vm.runInContext(helper,context,{timeout:2000});
  return {compact:context.SalehContextCompaction,context,get uuidCalls(){return uuidCalls;},get digestCalls(){return digestCalls;},pause(){waiting=true;gate=new Promise(resolve=>release=resolve);},release(){waiting=false;release?.();}};
}
function chat(count=8){
  return {id:'chunk-fixture',model:'fixture-model',mode:'chat',thinking:'standard',longOutput:false,project:'Generated fixture',notes:'Keep uncertainty',file:null,draft:'  unsent العربية😀\n ',draftAttachments:[{kind:'text',name:'draft.txt',text:'exact\n'}],unknown:{kept:true},messages:Array.from({length:count},(_,n)=>({id:'message-'+n,role:n%2?'assistant':'user',state:'complete',content:'Message '+n,unknown:{kept:n}}))};
}
const storage=()=>({revision:1,commitId:randomUUID()});
function result(input,job,content='Derived fixture summary'){
  return {run:{version:5,purpose:'compact',runId:job.runId,chatId:input.id,userMessageId:job.userMessageId,assistantMessageId:job.assistantMessageId,inputDigest:job.inputDigest,sourceDigest:job.source.digest,revision:3,status:'complete',requestedModel:input.model,resolvedModel:input.model,content,finishReason:'stop'},live:false,persistence:'saved',durableRevision:3,saveError:null};
}
async function round(env,input,summary='Derived fixture summary'){
  const source=await env.compact.capture(input,storage()),job=env.compact.create(source);job.inputDigest='a'.repeat(64);
  const admitted=env.compact.append(input,job),value=result(input,job,summary),next=await env.compact.activate(admitted,job,value);
  return {chat:next,source,job:next.contextCompactions.records.find(row=>row.id===job.id),value};
}
async function legacy(env,input,count,summary){
  const settings={model:input.model,mode:input.mode,thinking:input.thinking,longOutput:input.longOutput,project:input.project,notes:input.notes,file:input.file};
  const covered=[];for(const message of input.messages.slice(0,count)){const {reasoningOpen,...facts}=message;covered.push({id:message.id,hash:await env.compact.digest(facts)});}
  const source={version:1,chatId:input.id,model:input.model,mode:input.mode,thinking:input.thinking,settingsHash:await env.compact.digest(settings),storage:storage(),covered,prior:null,excerpt:canonical({priorSummary:null,messages:input.messages.slice(0,count)})};source.digest=await env.compact.digest(source);
  const job=env.compact.create(source);Object.assign(job,{inputDigest:'a'.repeat(64),status:'complete',revision:3,summary,summaryHash:await env.compact.digest(summary)});
  return {...input,contextCompactions:{version:1,activeId:job.id,records:[job],unknownDerived:{kept:true}}};
}
function terminal(job){return {...clone(job),id:randomUUID(),runId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),status:'error',revision:2,summary:'',summaryHash:null,note:'Generated failed attempt',unknownAttempt:{retained:true}};}
function facts(message){const {reasoningOpen,...value}=message;return value;}
function chunks(source){return JSON.parse(source.excerpt).fragments;}
async function archivedChat(env,count=66){
  let current=chat();const source=await env.compact.capture(current,storage()),base=env.compact.create(source);
  for(let i=0;i<count;i++)current=env.compact.append(current,terminal(base));
  return current;
}

await test('ordinary complete exchanges still compact as one bounded prefix',async()=>{
  const env=environment(),original=chat(),before=clone(original),r=await round(env,original);
  assert.equal(r.source.version,2);assert.equal(r.source.covered.length,6);assert.equal(env.compact.coveredCount(r.source),6);
  assert.equal(byteLength(r.source.excerpt)<=24000,true);assert.equal(byteLength(env.compact.prompt(r.source))<=32000,true);
  const projected=await env.compact.project(r.chat);assert.equal(projected[0].state,'complete');assert.deepEqual(clone(projected.slice(1)),original.messages.slice(6));assert.deepEqual(original,before);assert.deepEqual(r.chat.messages,before.messages);assert.equal(r.chat.draft,before.draft);
});
await test('oversized single exchange resumes losslessly with no partial hiding',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='FIRST '+('abcdefghij'.repeat(11000))+' LAST';original.messages[1].content='Original response evidence';const before=clone(original),pieces=[];let current=original,previous=0,rounds=0;
  do{
    const r=await round(env,current,'Retained summary '+rounds);rounds++;assert(rounds<20);
    const fragment=chunks(r.source)[0];assert.equal(fragment.fromByte,previous);pieces.push(fragment.text);previous=fragment.toByte;
    assert(byteLength(r.source.excerpt)<=env.compact.MAX_INPUT);assert.equal(r.source.covered.length,2);
    if(r.source.progress.end.offset){assert.equal(env.compact.coveredCount(r.source),0);assert.deepEqual(clone(await env.compact.project(r.chat)),before.messages);assert.match((await env.compact.describe(r.chat)).message,/full original history is still in use/);}
    current=r.chat;
  }while(current.contextCompactions.records.at(-1).source.progress.end.offset);
  assert(rounds>1);assert.equal(pieces.join(''),canonical({messages:before.messages.slice(0,2).map(facts)}));
  assert.equal(env.compact.coveredCount(current.contextCompactions.records.at(-1).source),2);assert.deepEqual(current.messages,before.messages);assert.equal(current.draft,before.draft);assert.deepEqual(current.draftAttachments,before.draftAttachments);
});
await test('UTF-8 cursors preserve emoji, Arabic, CJK, quotes and escaped newlines',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content=('😀𠮷東京 العربية "\\\n').repeat(2500);const before=clone(original),pieces=[];let current=original,offset=0,rounds=0;
  do{
    const r=await round(env,current,'حافظ على السياق');rounds++;assert(rounds<30);
    for(const fragment of chunks(r.source)){assert.equal(fragment.fromByte,offset);assert.equal(byteLength(fragment.text),fragment.toByte-fragment.fromByte);assert(!fragment.text.includes('\uFFFD'));offset=fragment.toByte;pieces.push(fragment.text);}
    assert(byteLength(r.source.excerpt)<=24000);current=json(r.chat);
  }while(current.contextCompactions.records.at(-1).source.progress.end.offset);
  assert.equal(pieces.join(''),canonical({messages:before.messages.slice(0,2).map(facts)}));assert.deepEqual(current.messages,before.messages);
});
await test('a full prefix hides only completed exchanges before a partial next exchange',async()=>{
  const env=environment(),original=chat(6);original.messages[2].content='x'.repeat(40000);const r=await round(env,original);
  assert.equal(r.source.progress.end.message,2);assert(r.source.progress.end.offset>0);assert.equal(r.source.covered.length,4);
  const projected=await env.compact.project(r.chat);assert.deepEqual(clone(projected.slice(1)),original.messages.slice(2));assert.match(projected[0].content,/still supplied in full/);
  assert.match(env.compact.operationMessage(r.chat,r.job),/covers 2 earlier messages/);assert.match(env.compact.rangeLabel(r.chat,r.job),/Messages 3–4/);
});
await test('tool receipts, reasoning and unknown message facts survive fragment reconstruction',async()=>{
  const env=environment(),original=chat(4);original.messages[1].reasoning='Stored explanation';original.messages[1].receipts=[{id:randomUUID(),tool:'generated_tool',status:'error',message:'Observed failure',input:'x'.repeat(30000),output:'No success was observed'}];original.messages[1].unknown={nested:{keep:'tail-marker'}};const pieces=[];let current=original;
  for(let n=0;n<10;n++){const r=await round(env,current);pieces.push(...chunks(r.source).map(row=>row.text));current=r.chat;if(!r.source.progress.end.offset)break;}
  assert.equal(pieces.join(''),canonical({messages:original.messages.slice(0,2).map(facts)}));assert.deepEqual(current.messages,original.messages);assert(pieces.join('').includes('Observed failure'));
});
await test('image pixels remain original-only references and are still source-hash bound',async()=>{
  const env=environment(),original=chat(4),dataURL='data:image/png;base64,'+'A'.repeat(40000);original.messages[0].attachments=[{kind:'image',name:'generated.png',dataURL,unknownImage:'keep metadata'}];
  const source=await env.compact.capture(original,storage()),text=chunks(source).map(row=>row.text).join('');
  assert(!source.excerpt.includes(dataURL));assert(text.includes(hash(dataURL)));assert(text.includes('keep metadata'));assert.equal(original.messages[0].attachments[0].dataURL,dataURL);
  original.messages[0].attachments[0].dataURL+='A';assert.equal(await env.compact.matches(original,source),false);
});
await test('valid legacy 32,000-byte summary restarts explicitly from intact originals',async()=>{
  const env=environment(),original=await legacy(env,chat(),4,'أ'.repeat(16000)),before=clone(original);
  assert.equal(byteLength(original.contextCompactions.records[0].summary),32000);assert.equal((await env.compact.describe(original)).status,'active');
  const r=await round(env,original);assert.equal(r.source.progress.restarted,true);assert.deepEqual(json(r.source.progress.start),{message:0,offset:0});assert.equal(JSON.parse(r.source.excerpt).priorSummary,null);
  assert(byteLength(r.source.excerpt)<=24000);assert.deepEqual(clone(r.chat.contextCompactions.records[0]),before.contextCompactions.records[0]);assert.deepEqual(r.chat.messages,before.messages);assert.match(env.compact.operationMessage(r.chat,r.job),/oversized prior summary was retained/);
});
await test('a legacy summary exactly at the carry limit continues without restart',async()=>{
  const env=environment(),original=await legacy(env,chat(),2,'é'.repeat(6000)),source=await env.compact.capture(original,storage());
  assert.equal(source.progress.restarted,false);assert.deepEqual(json(source.progress.start),{message:2,offset:0});assert.equal(JSON.parse(source.excerpt).priorSummary,original.contextCompactions.records[0].summary);assert(byteLength(source.excerpt)<=24000);
});
await test('new summary over the UTF-8 carry budget cannot activate',async()=>{
  const env=environment(),original=chat(),source=await env.compact.capture(original,storage()),job=env.compact.create(source);job.inputDigest='a'.repeat(64);const admitted=env.compact.append(original,job),before=clone(admitted);
  await assert.rejects(env.compact.activate(admitted,job,result(original,job,'é'.repeat(6001))),/carry budget/);assert.deepEqual(clone(admitted),before);assert.equal(admitted.contextCompactions.activeId,null);
});
await test('cold restore resumes exactly the saved fragment cursor without implicit work',async()=>{
  const warm=environment(),original=chat(4);original.messages[0].content='x'.repeat(60000);const first=await round(warm,original),cold=environment(),restored=json(first.chat),before=clone(restored),calls=cold.uuidCalls;
  const view=await cold.compact.describe(restored);assert.equal(view.status,'partial');assert.equal(cold.uuidCalls,calls);assert.deepEqual(restored,before);
  const source=await cold.compact.capture(restored,storage());assert.deepEqual(json(source.progress.start),json(first.source.progress.end));assert.equal(chunks(source)[0].fromByte,first.source.progress.end.offset);assert.equal(cold.uuidCalls,calls);
});
await test('pending first fragment blocks another admission without moving progress',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(40000);const source=await env.compact.capture(original,storage()),job=env.compact.create(source),pending=env.compact.append(original,job),before=clone(pending);
  await assert.rejects(env.compact.capture(pending,storage()),/earlier compaction/);assert.deepEqual(clone(pending),before);job.status='stopped';const retry=await env.compact.capture(pending,storage());assert.deepEqual(json(retry.progress.start),{message:0,offset:0});
});
await test('interrupted later fragment retries from last activated progress only',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(90000);const first=await round(env,original),source=await env.compact.capture(first.chat,storage()),job=env.compact.create(source);job.inputDigest='a'.repeat(64);let interrupted=env.compact.append(first.chat,job);Object.assign(job,{status:'error',summary:'Partial failed response',summaryHash:null});
  const next=await env.compact.capture(interrupted,storage());assert.deepEqual(json(next.progress.start),json(first.source.progress.end));assert.deepEqual(json(next.progress.start),json(source.progress.start));assert.equal(interrupted.contextCompactions.activeId,first.job.id);assert.deepEqual(clone(await env.compact.project(interrupted)),original.messages);
});
await test('large conversation crosses64 rounds with every attempt and byte retained',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(1600000);let current=original,offset=0,count=0;const seen=[];
  do{
    const r=await round(env,current,'short rolling summary');count++;assert(count<100);
    assert.equal(chunks(r.source)[0].fromByte,offset);offset=chunks(r.source)[0].toByte;seen.push(clone(r.job));current=r.chat;
    if(count===65){current=json(current);assert.equal(env.compact.state(current).archivedRecords.length,1);}
  }while(current.contextCompactions.records.at(-1).source.progress.end.offset);
  assert(count>64);assert.equal(current.contextCompactions.records.length,64);assert.equal(current.contextCompactions.archivedRecords.length,count-64);
  const retained=[...current.contextCompactions.archivedRecords,...current.contextCompactions.records];assert.equal(retained.length,seen.length);
  for(const record of seen)assert.deepEqual(clone(retained.find(row=>row.id===record.id)),record);
  assert.equal(offset,byteLength(canonical({messages:original.messages.slice(0,2).map(facts)})));assert.deepEqual(current.messages,original.messages);
});
await test('archival preserves unknown record and chat fields through cold restore',async()=>{
  const env=environment(),current=await archivedChat(env),restored=json(current),before=clone(restored);assert.equal(restored.contextCompactions.version,2);assert.equal(restored.contextCompactions.archivedRecords.length,2);
  assert(restored.contextCompactions.archivedRecords.every(row=>row.unknownAttempt.retained));assert.deepEqual(env.compact.state(restored),restored.contextCompactions);await environment().compact.describe(restored);assert.deepEqual(restored,before);
});
await test('an active old record remains current while older settled failures archive',async()=>{
  const env=environment();let current=await legacy(env,chat(),2,'active prefix'),active=current.contextCompactions.activeId;const source=await env.compact.capture(current,storage()),base=env.compact.create(source);
  for(let n=0;n<65;n++)current=env.compact.append(current,terminal(base));
  assert(current.contextCompactions.records.some(row=>row.id===active));assert(!current.contextCompactions.archivedRecords.some(row=>row.id===active));assert.equal((await env.compact.describe(current)).status,'active');
});
await test('archive count bound refuses without pruning or resetting retained records',async()=>{
  const env=environment(),original=chat(),source=await env.compact.capture(original,storage()),base=env.compact.create(source);original.contextCompactions={version:2,activeId:null,records:Array.from({length:64},()=>terminal(base)),archivedRecords:Array.from({length:2048},()=>terminal(base))};const before=hash(canonical(original));
  assert.throws(()=>env.compact.append(original,terminal(base)),/2,048 archived.*No record was discarded.*exporting does not reset/);assert.equal(hash(canonical(original)),before);
});
await test('actual metadata byte bound reserves result space and preserves oversized legacy state',async()=>{
  const env=environment(),original=chat(),source=await env.compact.capture(original,storage()),base=terminal(env.compact.create(source));base.unknownLargeField='x'.repeat(env.compact.MAX_METADATA);original.contextCompactions={version:1,activeId:null,records:[base]};const before=base.unknownLargeField.length;
  assert.throws(()=>env.compact.append(original,terminal(env.compact.create(source))),/32 MiB bound/);assert.equal(original.contextCompactions.version,1);assert.equal(original.contextCompactions.records.length,1);assert.equal(base.unknownLargeField.length,before);
});
await test('actual import transform retains archived records and never resumes foreign jobs',async()=>{
  const env=environment(),original=await archivedChat(env),metadata=clone(original.contextCompactions),imported={...clone(original),id:'imported-chat'};
  const a=app.indexOf('      for(const chat of added){'),b=app.indexOf('      const merged=',a);assert(a>=0&&b>a);
  const context=vm.createContext({added:[imported]},{codeGeneration:{strings:false,wasm:false}});vm.runInContext(app.slice(a,b),context,{timeout:2000});
  assert.equal(imported.contextCompactions.activeId,null);assert.deepEqual(clone(imported.contextCompactions.records),[]);assert.deepEqual(imported.contextCompactions.imports[0],metadata);assert.equal(imported.contextCompactions.imports[0].archivedRecords.length,2);assert.deepEqual(imported.messages,original.messages);
});
await test('actual snapshot serializer and portable export keep the entire archive and provenance',async()=>{
  const env=environment(),current=await archivedChat(env),serializer=vm.createContext({TextEncoder,SalehAttachments:{normalize:rows=>rows??[]}},{codeGeneration:{strings:false,wasm:false}});
  vm.runInContext(fs.readFileSync(SOURCE+'/attachment-storage.js','utf8'),serializer,{timeout:2000});
  const stored=serializer.SalehAttachmentStorage.serialize({version:1,chats:[current],selectedId:current.id},'chat'),payload=JSON.stringify({exportedAt:'2026-11-07T00:00:00.000Z',chats:JSON.parse(stored).chats}),restored=JSON.parse(payload).chats[0];
  assert.deepEqual(restored.contextCompactions,clone(current.contextCompactions));for(const record of [...restored.contextCompactions.archivedRecords,...restored.contextCompactions.records])assert.equal(await env.compact.digest((({digest,...body})=>body)(record.source)),record.source.digest);
});
await test('edits anywhere in a partially processed exchange invalidate the saved source',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(50000);const r=await round(env,original);
  for(const edit of [input=>input.messages[0].content='y'+input.messages[0].content.slice(1),input=>input.messages[0].content=input.messages[0].content.slice(0,-1)+'y',input=>input.messages[1].unknown.kept='changed']){
    const changed=clone(r.chat);edit(changed);assert.equal(await env.compact.matches(changed,r.source,r.job.id),false);await assert.rejects(env.compact.project(changed),/stale|changed/);
  }
});
await test('reasoning disclosure never changes chunk bytes but reasoning facts do',async()=>{
  const env=environment(),original=chat(4);original.messages[1].reasoning='Exact historical explanation';original.messages[1].reasoningOpen=false;const source=await env.compact.capture(original,storage());original.messages[1].reasoningOpen=true;assert.equal(await env.compact.matches(original,source),true);original.messages[1].reasoning+=' changed';assert.equal(await env.compact.matches(original,source),false);
});
await test('active-summary CAS token detects text changes even when its ID stays the same',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(50000);const first=await round(env,original),source=await env.compact.capture(first.chat,storage()),token=env.compact.compareToken(first.chat,source);
  first.chat.contextCompactions.records.find(row=>row.id===first.job.id).summary+=' changed';assert.notEqual(env.compact.compareToken(first.chat,source),token);assert.equal(await env.compact.matches(first.chat,source),false);
});
await test('projection rejects original edits during asynchronous validation',async()=>{
  const env=environment(),r=await round(env,chat());env.pause();const pending=env.compact.project(r.chat);await tick();r.chat.messages[0].content+=' raced edit';env.release();await assert.rejects(pending,/stale|changed/);
});
await test('draft-only edits preserve CAS and partial progress',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(50000);const r=await round(env,original),source=await env.compact.capture(r.chat,storage()),token=env.compact.compareToken(r.chat,source);r.chat.draft='new exact draft😀\n ';r.chat.draftAttachments.push({kind:'text',name:'more.txt',text:'new'});assert.equal(env.compact.compareToken(r.chat,source),token);assert.equal(await env.compact.matches(r.chat,source),true);
});
await test('forged cursor advance cannot skip unprocessed bytes even with a new digest',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(50000);const source=clone(await env.compact.capture(original,storage())),data=JSON.parse(source.excerpt);source.progress.start.offset=2;data.fragments[0].fromByte=2;data.fragments[0].text=data.fragments[0].text.slice(2);source.excerpt=canonical(data);const {digest,...body}=source;source.digest=await env.compact.digest(body);assert.equal(await env.compact.matches(original,source),false);
});
await test('unsettled exchanges remain blocking and no prefix can hide them',async()=>{
  const env=environment(),original=chat(6);original.messages[2].content='x'.repeat(50000);original.messages[3].pendingStep={id:'pending'};const source=await env.compact.capture(original,storage());assert.equal(env.compact.coveredCount(source),2);assert.equal(source.covered.length,2);assert.equal(source.excerpt.includes('pending'),false);
  const r=await round(env,original);await assert.rejects(env.compact.capture(r.chat,storage()),/unfinished or unsettled/);assert.deepEqual(clone((await env.compact.project(r.chat)).slice(1)),original.messages.slice(2));
});
await test('removing the newest boundary makes prior partial progress stale',async()=>{
  const env=environment(),original=chat(4);original.messages[0].content='x'.repeat(50000);const r=await round(env,original);r.chat.messages.splice(2);assert.equal((await env.compact.describe(r.chat)).status,'stale');await assert.rejects(env.compact.project(r.chat),/stale|changed/);
});
await test('new archive format rejects duplicate IDs and unfinished archived attempts',async()=>{
  const env=environment(),current=await archivedChat(env),duplicate=clone(current);duplicate.contextCompactions.archivedRecords[0].id=duplicate.contextCompactions.records[0].id;assert.throws(()=>env.compact.state(duplicate),/record is invalid/);
  const pending=clone(current);pending.contextCompactions.archivedRecords[0].status='running';assert.throws(()=>env.compact.state(pending),/unfinished summary cannot be archived/);
});
await test('full-history selection keeps every archived attempt and original unchanged',async()=>{
  const env=environment(),current=await archivedChat(env),before=clone(current),full=env.compact.fullHistory(current);assert.deepEqual(clone(full.contextCompactions.archivedRecords),before.contextCompactions.archivedRecords);assert.deepEqual(clone(full.contextCompactions.records),before.contextCompactions.records);assert.deepEqual(full.messages,before.messages);assert.equal(full.draft,before.draft);assert.deepEqual(clone(await env.compact.project(full)),before.messages);
});

await test('escaped legacy summaries restart rather than falsely claiming no older exchange',async()=>{
  for(const summary of ['\\'.repeat(12000),'"'.repeat(12000),'\u0000'.repeat(3000)]){
    const env=environment(),original=await legacy(env,chat(),2,summary),before=clone(original),source=await env.compact.capture(original,storage());
    assert(byteLength(summary)<=12000);assert(byteLength(JSON.stringify(summary))>env.compact.MAX_CARRY_JSON);
    assert.equal(source.progress.restarted,true);assert.deepEqual(json(source.progress.start),{message:0,offset:0});assert.equal(JSON.parse(source.excerpt).priorSummary,null);assert(chunks(source).length>0);assert(byteLength(source.excerpt)<=24000);assert.deepEqual(clone(original),before);
  }
});
await test('maximum encoded carry still leaves actual envelope room for a nonempty fragment',async()=>{
  const env=environment(),summary='\\'.repeat(7999),original=await legacy(env,chat(),2,summary),source=await env.compact.capture(original,storage());
  assert.equal(byteLength(JSON.stringify(summary)),env.compact.MAX_CARRY_JSON);assert.equal(source.progress.restarted,false);assert.equal(JSON.parse(source.excerpt).priorSummary,summary);assert(chunks(source)[0].toByte>chunks(source)[0].fromByte);assert(byteLength(source.excerpt)<=24000);
});
await test('new summaries that exceed only encoded carry cannot activate',async()=>{
  const env=environment(),original=chat(),source=await env.compact.capture(original,storage()),job=env.compact.create(source);job.inputDigest='a'.repeat(64);const admitted=env.compact.append(original,job),before=clone(admitted);
  for(const summary of ['\\'.repeat(8000),'"'.repeat(8000),'\u0000'.repeat(2667)]){
    assert(byteLength(summary)<=12000);assert(byteLength(JSON.stringify(summary))>16000);await assert.rejects(env.compact.activate(admitted,job,result(original,job,summary)),/carry budget/);assert.deepEqual(clone(admitted),before);
  }
});
await test('near metadata capacity reserves encoded valid summary output without discarding history',async()=>{
  const env=environment(),original=chat(),source=await env.compact.capture(original,storage()),old=terminal(env.compact.create(source)),job=env.compact.create(source);old.retainedPadding='';job.inputDigest='a'.repeat(64);original.contextCompactions={version:1,activeId:null,records:[old]};
  const initial=env.compact.append(original,job),reserve=env.compact.MAX_CARRY_JSON+8192,padding=env.compact.MAX_METADATA-reserve-env.compact.metadataBytes(initial.contextCompactions);
  assert(padding>0);old.retainedPadding='x'.repeat(padding);const admitted=env.compact.append(original,job);assert.equal(env.compact.metadataBytes(admitted.contextCompactions)+reserve,env.compact.MAX_METADATA);
  const activated=await env.compact.activate(admitted,job,result(original,job,'\\'.repeat(7999)));assert(env.compact.metadataBytes(activated.contextCompactions)<=env.compact.MAX_METADATA);assert.equal(activated.contextCompactions.records[0].retainedPadding.length,padding);assert.equal(activated.contextCompactions.activeId,job.id);
});

const failed=rows.filter(row=>!row.passed).length;
console.log(JSON.stringify({passed:rows.length-failed,failed,rows,source:SOURCE,sourcePins:Object.fromEntries(['context-compaction.js','app.js','attachment-storage.js'].map(name=>[name,hash(fs.readFileSync(SOURCE+'/'+name))])),network:0,childProcess:0,productImports:0,originalStore:0,claim:'Lossless input-fragment coverage and retained-state fixtures only; no live model summary quality or native acceptance claim.'}));
if(failed)process.exitCode=1;
