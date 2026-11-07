// Execute the real composer handler in a capability-free VM; no browser/model.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const SOURCE=fileURLToPath(new URL('../../source/',import.meta.url));
await import(SOURCE+'context-compaction.js');
const raw=fs.readFileSync(SOURCE+'app.js','utf8'),a=raw.indexOf("$('composer').onsubmit = event => {"),b=raw.indexOf("window.addEventListener('computer-busy'",a);assert(a>=0&&b>a);
let count=0;
for(const [value,expected]of [['/compact','compact'],[' \n/compact\t ','compact'],['/compact extra','invalid'],['/compact\nnew task','invalid'],['Explain /compact','text'],['/compactor','text']]){
 const files=[{kind:'text',name:'مسودة😀.txt',text:'  keep\n'}],chat={id:'fixture',title:'Existing',draft:value,draftAttachments:files,messages:[{id:'old',role:'user',content:'Keep original'}]},before=structuredClone(chat),nodes={prompt:{value},composer:{}},ordinary=[],compacted=[],notices=[];
 const c=vm.createContext({$:id=>nodes[id],crypto:{randomUUID},contextCompaction:globalThis.SalehContextCompaction,storageHydrating:false,storageBlocked:false,restoring:false,structuralPending:false,deletingChats:new Set(),current:()=>chat,runBlocked:()=>false,computerBusy:false,attachmentReads:new Map(),textRunsReady:true,draftAttachments:chat=>chat.draftAttachments??[],chatModelState:()=>({ready:true}),messageRoom:()=>true,attachments:{normalize:files=>files},notice:s=>notices.push(s),generate:chat=>ordinary.push(chat.messages.at(-1).content),compactCurrent:()=>compacted.push(chat.id)},{codeGeneration:{strings:false,wasm:false}});
 vm.runInContext(raw.slice(a,b),c,{timeout:1000,importModuleDynamically:()=>{throw Error('No product imports');}});nodes.composer.onsubmit({preventDefault(){}});
 if(expected==='text')assert.equal(ordinary.length,1);else{assert.equal(ordinary.length,0,'Control text must not enter ordinary generation');assert.deepEqual(chat,before,'Control must preserve draft, originals and attachments');assert.equal(compacted.length,expected==='compact'?1:0);if(expected==='invalid')assert(notices.length);}
 count++;
}
console.log(JSON.stringify({passed:count,failed:0,network:0,productImports:0,claim:'Actual composer form interception with Unicode draft/attachments'}));
