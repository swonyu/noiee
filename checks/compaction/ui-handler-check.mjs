// Execute the real composer handler in a capability-free VM; no browser/model.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const SOURCE=fileURLToPath(new URL('../../source/',import.meta.url));
assert(process.argv[2]===undefined||process.argv[2]===SOURCE.replace(/\/$/,''),'Only the Noiee continuation source is allowed');
await import(SOURCE+'context-compaction.js');
const raw=fs.readFileSync(SOURCE+'app.js','utf8'),a=raw.indexOf("$('composer').onsubmit = event => {"),b=raw.indexOf("window.addEventListener('computer-busy'",a);assert(a>=0&&b>a);
const runs=fs.readFileSync(SOURCE+'chat-runs.js','utf8'),extract=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);return source.slice(a,b);};
// Use the actual pure validator and origin declarations without starting the page event loop.
const submissionValidation=extract(runs,'  const uuid=','  const statuses='),submissionHelpers=extract(raw,'let composerSubmission=','function requestComposerSubmit(');
let count=0;
for(const [value,expected]of [['/compact','compact'],[' \n/compact\t ','compact'],['/compact extra','invalid'],['/compact\nnew task','invalid'],['Explain /compact','text'],['/compactor','text']]){
 const files=[{kind:'text',name:'مسودة😀.txt',text:'  keep\n'}],chat={id:'fixture',title:'Existing',draft:value,draftAttachments:files,messages:[{id:'old',role:'user',content:'Keep original'}]},before=structuredClone(chat),nodes={prompt:{value},composer:{},send:{}},ordinary=[],submissions=[],compacted=[],notices=[];
 const c=vm.createContext({$:id=>nodes[id],Event,TextEncoder,document:{body:{},activeElement:nodes.prompt,hasFocus:()=>true,visibilityState:'visible'},window:{SalehChatRuns:{}},crypto:{randomUUID},contextCompaction:globalThis.SalehContextCompaction,storageHydrating:false,storageBlocked:false,restoring:false,structuralPending:false,deletingChats:new Set(),current:()=>chat,runBlocked:()=>false,computerBusy:false,attachmentReads:new Map(),textRunsReady:true,draftAttachments:chat=>chat.draftAttachments??[],chatModelState:()=>({ready:true}),messageRoom:()=>true,attachments:{normalize:files=>files},notice:s=>notices.push(s),generate:(chat,_preserveDraft,submission)=>{ordinary.push(chat.messages.at(-1).content);submissions.push(submission);},compactCurrent:()=>compacted.push(chat.id)},{codeGeneration:{strings:false,wasm:false}});
 vm.runInContext(submissionValidation+'\nwindow.SalehChatRuns.submission=normalizeSubmission;\n'+submissionHelpers+'\n'+raw.slice(a,b),c,{timeout:1000,importModuleDynamically:()=>{throw Error('No product imports');}});nodes.composer.onsubmit(new Event('submit',{cancelable:true}));
 if(expected==='text')assert.equal(ordinary.length,1);else{assert.equal(ordinary.length,0,'Control text must not enter ordinary generation');assert.deepEqual(chat,before,'Control must preserve draft, originals and attachments');assert.equal(compacted.length,expected==='compact'?1:0);if(expected==='invalid')assert(notices.length);}
 assert.equal(submissions.length,ordinary.length);for(const submission of submissions){assert.equal(submission.path,'form-submit');assert.equal(submission.eventType,'submit');assert.equal(submission.isTrusted,false);assert.equal(submission.submitter,'none');}
 count++;
}
console.log(JSON.stringify({passed:count,failed:0,network:0,productImports:0,claim:'Actual composer form interception with Unicode draft/attachments'}));
