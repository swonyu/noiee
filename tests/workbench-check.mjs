import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from '../source/node_modules/playwright/index.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=path.join(root,'source');
const out=path.join(root,'.artifacts','workbench-'+new Date().toISOString().replaceAll(':','-')+'-'+crypto.randomUUID().slice(0,8));
fs.mkdirSync(out,{recursive:true,mode:0o700});
const origin='http://127.0.0.1:18787',model='fixture/workbench',generation=crypto.randomUUID();
const assets=new Set(['index.html','style.css','workspace.css','model-policy.js','model-picker.js','work.js','context-compaction.js','chat-runs.js','attachments.js','attachment-storage.js','chat-storage.js','app.js','computer.js','tools.js','workspace-extensions.js','workspace.js']);
const sources=new Map(),errors=[],unexpected=[],operations=[],nativeOperations=[],names=[];
const read=name=>{if(!sources.has(name))sources.set(name,fs.readFileSync(path.join(source,name)));return sources.get(name);};
const check=(value,name)=>{assert.equal(value,true,name);names.push(name);};
const draft='KEEP exact draft α  \nsecond line ';
const chat={id:'workbench-active',title:'Daily work',updated:1,draft,project:'Fixture project',notes:'Kept notes',model,thinking:'standard',mode:'chat',file:null,messages:[{id:'original-user',role:'user',content:'Keep this original.',state:'complete'},{id:'original-answer',role:'assistant',content:'Retained answer.',state:'complete'}]};
const archived={...chat,id:'workbench-archived',title:'Older work',archived:true,draft:'ARCHIVED_DRAFT ',messages:[]};
const catalog={online:true,defaultModel:model,models:[{id:model,key:model,label:'Fixture local model',available:true,loaded:true,state:'loaded',contextLength:39424,capabilities:{chat:true,agent:true,coding:true,standard:true,deep:true,vision:false},reasons:{}}]};
const tasksHTML='<!doctype html><html><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css"><script src="/workspace.js" defer></script></head><body class="workspace-coding"><aside id="sidebar"><button id="new-chat">New chat</button><input id="search" aria-label="Search chats"><button id="workspace-settings-open">Settings</button><button id="workspace-extensions-open">Extensions</button><button id="back-chat">Chat</button></aside><main><header><button id="open-sidebar" aria-expanded="true">Sidebar</button><h1 id="thread-title">Child fixture</h1><button id="workspace-quick-open"><span>Quick actions</span><kbd>⌘J</kbd></button></header><button id="new-project">New project</button><button id="return-to-parent">Return to parent</button><button id="failed-startups" disabled data-command-disabled-reason="Fixture recovery inspection is busy">Failed startups</button><div id="child-actions"></div><textarea id="prompt" disabled>CHILD_DRAFT_KEPT</textarea><button id="stop" hidden>Stop</button><button id="terminal-toggle">Terminal</button></main><aside id="workspace-settings" hidden><button id="workspace-settings-close">Close</button></aside></body></html>';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
let failure=null;
async function makePage({access={mode:'full',managedChangesBlocked:true},initialMode='chat',tasks=false}={}){
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.exposeBinding('fixtureNativeRequest',(_source,value)=>{nativeOperations.push(value);throw Error('Fixture forbids native calls');});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){unexpected.push(request.url());return route.abort('blockedbyclient');}
    if(url.pathname==='/api/models')return route.fulfill({json:catalog});
    if(url.pathname==='/api/access')return route.fulfill({status:access===null?503:200,json:access??{error:'Fixture access unavailable'}});
    if(url.pathname==='/api/chat/runs'){
      const input=request.postDataJSON();operations.push(input.action);
      if(input.action!=='list'){unexpected.push('run action '+input.action);return route.fulfill({status:400,json:{error:'No model or tool operation is allowed by this fixture'}});}
      return route.fulfill({json:{generation,runs:[],truncated:false}});
    }
    if(url.pathname==='/fixture-tasks')return route.fulfill({body:tasksHTML,contentType:'text/html'});
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!assets.has(name)){unexpected.push(url.pathname);return route.fulfill({status:404,body:''});}
    return route.fulfill({body:read(name),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  await context.addInitScript(({chat,archived,model,tasks,initialMode})=>{
    localStorage.setItem('qwen-local-chats-v1',JSON.stringify({selectedId:chat.id,chats:[{...chat,mode:initialMode},archived]}));
    localStorage.setItem('saleh-local-model-default-v1',model);
    window.fixtureNativeCalls=[];
  },{chat,archived,model,tasks,initialMode});
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+(tasks?'/fixture-tasks':'/'));
  await page.waitForFunction(()=>!!window.salehWorkspace);
  if(!tasks){
    await page.waitForFunction(()=>document.getElementById('model-status').textContent.includes('Loaded locally'));
    await page.waitForFunction(()=>!document.getElementById('tool-access-status').textContent.startsWith('Checking'));
    await stable(page);
  }
  return {page,context};
}
async function stable(page){await page.waitForFunction(async()=>await window.salehSaveBeforeLeave()===true);}
async function snapshot(page){
  await stable(page);
  return page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('saleh-chat-snapshots-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    return new Promise((resolve,reject)=>{const tx=db.transaction('snapshots','readonly'),request=tx.objectStore('snapshots').get('head');let value;request.onsuccess=()=>{value=JSON.parse(request.result.payload);};tx.oncomplete=()=>{db.close();resolve(value);};tx.onabort=()=>reject(tx.error);});
  });
}
async function open(page,shortcut='Meta+Shift+p'){
  await page.keyboard.press(shortcut);
  await page.waitForFunction(()=>document.getElementById('workspace-quick-dialog').matches(':popover-open'));
}
async function search(page,value){await page.locator('#workspace-quick-query').fill(value);}
const commandRow=(page,id)=>page.locator('#workspace-quick-results [data-command="'+id+'"]');
try{
  const {page,context}=await makePage(),before=await snapshot(page);
  check(await page.locator('#workspace-access-chip').textContent()==='Chat · tools off','Chat explicitly has tools off under global Full Access');
  check((await page.locator('#tool-access-status').textContent()).startsWith('Full Access'),'global policy remains visible and separate in Settings');
  await page.locator('#prompt').focus();
  await page.locator('#prompt').evaluate(node=>node.setSelectionRange(3,11,'backward'));
  await open(page);
  check(await page.locator('#workspace-quick-query').evaluate(node=>document.activeElement===node),'Cmd Shift P focuses the palette search');
  check(await page.locator('#workspace-quick-query').getAttribute('role')==='combobox'&&await page.locator('#workspace-quick-results').getAttribute('role')==='listbox','palette exposes combobox and listbox roles');
  const initial=await page.locator('#workspace-quick-query').getAttribute('aria-activedescendant');
  await page.keyboard.press('ArrowDown');
  check(await page.locator('#workspace-quick-query').evaluate(node=>document.activeElement===node)&&await page.locator('#workspace-quick-query').getAttribute('aria-activedescendant')!==initial,'arrow navigation changes the active command while retaining search focus');
  await page.keyboard.type('preferences workspace');
  check(await page.locator('#workspace-quick-results [role=option]').count()===1&&await commandRow(page,'workspace-settings-open').isVisible(),'search matches unordered intent words after arrow navigation');
  await page.keyboard.press('Enter');
  check(await page.locator('#workspace-settings').isVisible()&&!await page.locator('#workspace-quick-dialog').isVisible(),'Enter dispatches the existing Settings control');
  await page.locator('#workspace-settings-close').click();
  check(JSON.stringify(await snapshot(page))===JSON.stringify(before),'navigation commands preserve exact chats, history, drafts and selection');

  await page.locator('#prompt').focus();await page.locator('#prompt').evaluate(node=>node.setSelectionRange(3,11,'backward'));
  await open(page,'Meta+j');await page.keyboard.press('Escape');
  check(await page.locator('#prompt').evaluate(node=>document.activeElement===node&&node.selectionStart===3&&node.selectionEnd===11&&node.selectionDirection==='backward'),'legacy Cmd J and Escape restore composer focus and caret selection');
  await open(page,'Control+Shift+p');await page.keyboard.press('Tab');
  check(await page.locator('#workspace-quick-dialog').evaluate(node=>node.contains(document.activeElement)),'Tab remains within the palette');
  await page.keyboard.press('Shift+Tab');
  check(await page.locator('#workspace-quick-dialog').evaluate(node=>node.contains(document.activeElement)),'reverse Tab remains within the palette');
  await search(page,'no such command xyz');await page.keyboard.press('Enter');
  check(await page.locator('#workspace-quick-dialog').isVisible()&&await page.locator('#workspace-quick-empty').isVisible()&&await page.locator('#workspace-quick-query').getAttribute('aria-activedescendant')===null,'empty search cannot dispatch a stale command');
  await page.keyboard.press('Escape');
  await page.locator('#rename-chat').click();await page.keyboard.press('Meta+Shift+p');
  check(await page.locator('#rename-dialog').isVisible()&&!await page.locator('#workspace-quick-dialog').isVisible(),'palette shortcut does not replace an existing guarded dialog');
  await page.locator('#rename-cancel').click();
  await page.evaluate(()=>document.body.inert=true);await page.keyboard.press('Meta+Shift+p');
  check(!await page.locator('#workspace-quick-dialog').isVisible(),'a departing inert page cannot open the palette');
  await page.evaluate(()=>document.body.inert=false);

  const sidebarToggle=page.locator('#sidebar-toggle, #open-sidebar').first();
  await sidebarToggle.click();
  check(await sidebarToggle.getAttribute('aria-expanded')==='false','sidebar fixture reaches its real collapsed state');
  await open(page);await search(page,'search chats');await page.keyboard.press('Enter');
  check(await sidebarToggle.getAttribute('aria-expanded')==='true'&&await page.locator('#search').evaluate(node=>document.activeElement===node),'sidebar search opens the existing collapsed sidebar and focuses its input');
  check(JSON.stringify(await snapshot(page))===JSON.stringify(before),'palette focus and sidebar operations preserve the exact saved snapshot');
  for(const width of [1280,760,390]){
    await page.setViewportSize({width,height:844});await open(page);await search(page,'context');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'palette fits '+width+'px without horizontal page overflow');
    if(width===1280||width===390)await page.screenshot({path:path.join(out,'palette-'+width+'.png'),fullPage:true});
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:1280,height:900});await page.locator('#prompt').focus();await page.keyboard.press('Meta+k');await stable(page);
  const afterNew=await snapshot(page);
  check(afterNew.selectedId!==before.selectedId&&afterNew.chats.length===before.chats.length+1,'Cmd K still invokes the existing New chat action');
  check(JSON.stringify(afterNew.chats.find(row=>row.id===chat.id))===JSON.stringify(before.chats.find(row=>row.id===chat.id)),'New chat retains the previous draft and history unchanged');
  check(await page.locator('#welcome-tasks').isVisible()&&await page.locator('#welcome-commands').isVisible(),'empty Chat offers Tasks and command discovery through existing navigation');
  await page.locator('#welcome-commands').click();check(await page.locator('#workspace-quick-dialog').isVisible(),'empty-state command discovery opens the same palette');await page.keyboard.press('Escape');
  await context.close();

  for(const [label,access,expected,notice] of [
    ['full',{mode:'full',managedChangesBlocked:true},'Agent · Full Access',false],
    ['reviewed',{mode:'reviewed',managedChangesBlocked:false},'Agent · Ask Before Tools',false],
    ['recovery',{mode:'full',managedChangesBlocked:false,recoveryStartup:true},'Agent · recovery hold',true],
    ['unknown',null,'Agent · access unconfirmed',true],
    ['invalid',{mode:'full',managedChangesBlocked:false},'Agent · access unconfirmed',true],
  ]){
    const {page,context}=await makePage({access});
    await page.evaluate(()=>{window.webkit={messageHandlers:{tools:{postMessage:value=>{window.fixtureNativeCalls.push(value);return window.fixtureNativeRequest(value);}}}};document.getElementById('chat-mode').dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator('#chat-mode').selectOption('agent');await stable(page);
    check(await page.locator('#workspace-access-chip').textContent()===expected&&await page.locator('#composer-authority-detail').isVisible()===notice,'Agent authority reflects '+label+' policy without changing permissions');
    check((await snapshot(page)).chats.find(row=>row.id==='workbench-active').draft===draft,'authority update preserves the exact '+label+' draft');
    await page.locator('#chat-mode').selectOption('chat');
    check(await page.locator('#workspace-access-chip').textContent()==='Chat · tools off','switching from '+label+' Agent to Chat restores tools-off status');
    check(await page.evaluate(()=>window.fixtureNativeCalls.length)===0,'authority presentation makes no native call for '+label);
    await context.close();
  }
  {
    const {page,context}=await makePage({initialMode:'agent'});
    check(await page.locator('#workspace-access-chip').textContent()==='Agent · Mac app required','saved Agent chat does not imply native authority in a browser');
    await context.close();
  }
  {
    const {page,context}=await makePage({tasks:true});
    await page.evaluate(()=>{
      window.fixtureActions=[];window.fixtureBinding=false;
      document.getElementById('return-to-parent').disabled=true;
      document.getElementById('return-to-parent').dataset.commandDisabledReason='Fixture parent binding is unverified';
      document.getElementById('return-to-parent').onclick=()=>{if(!window.fixtureBinding)return;window.fixtureActions.push('parent');};
      document.getElementById('stop').onclick=()=>window.fixtureActions.push('stop');
      document.getElementById('new-chat').onclick=()=>window.fixtureActions.push('new-chat');
    });
    const retained=await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1'));
    await open(page);await search(page,'parent');
    check(await commandRow(page,'return-to-parent').isDisabled()&&(await commandRow(page,'return-to-parent').textContent()).includes('binding is unverified'),'disabled parent action exposes the controller reason');
    await page.keyboard.press('Enter');
    check(await page.evaluate(()=>window.fixtureActions.length)===0&&await page.locator('#workspace-quick-dialog').isVisible(),'Enter cannot invoke an unavailable parent action');
    await page.evaluate(()=>{window.fixtureBinding=true;document.getElementById('return-to-parent').disabled=false;});
    await commandRow(page,'return-to-parent').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('[data-command="return-to-parent"]').disabled);
    await page.keyboard.press('Enter');
    check((await page.evaluate(()=>window.fixtureActions)).join(',')==='parent','palette observes an enabled binding and calls the existing parent handler once');

    await open(page);await search(page,'failed startup');
    check(await commandRow(page,'failed-startups').isDisabled()&&(await commandRow(page,'failed-startups').textContent()).includes('inspection is busy'),'recovery uses the existing disabled guard and reason');
    await search(page,'write message');
    check(await commandRow(page,'prompt').isDisabled(),'read-only child composer stays unavailable through the palette');
    await search(page,'stop current');
    check(await page.locator('#workspace-quick-results [role=option]').count()===0,'hidden Stop is not offered as an available command');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{const stop=document.getElementById('stop');document.getElementById('child-actions').append(stop);stop.hidden=false;});
    await open(page);await search(page,'stop current');await page.keyboard.press('Enter');
    check((await page.evaluate(()=>window.fixtureActions)).join(',')==='parent,stop','moving the existing Stop control keeps its original handler');

    await open(page);await search(page,'parent');
    await page.evaluate(()=>{
      const dialog=document.getElementById('workspace-quick-dialog'),original=dialog.close;
      dialog.close=function(){document.getElementById('return-to-parent').disabled=true;dialog.close=original;return original.call(dialog);};
    });
    await page.keyboard.press('Enter');
    check((await page.evaluate(()=>window.fixtureActions)).join(',')==='parent,stop','state changing during palette close prevents dispatch');
    check((await page.locator('#workspace-feedback').textContent()).includes('No action was taken'),'state-change refusal gives visible feedback');
    check(await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1'))===retained&&await page.locator('#prompt').inputValue()==='CHILD_DRAFT_KEPT','Tasks palette leaves retained history and child draft untouched');
    await context.close();
  }
  check(errors.length===0,'no frontend exceptions in generated workbench states');
  check(unexpected.length===0&&nativeOperations.length===0&&operations.every(action=>action==='list'),'all requests remain intercepted reads; no model, tool, native or provider dispatch');
}catch(error){failure=error;}
finally{
  await browser.close();
  const sourceHashes=Object.fromEntries([...sources].map(([name,bytes])=>[name,crypto.createHash('sha256').update(bytes).digest('hex')]));
  const sourceUnchanged=Object.entries(sourceHashes).every(([name,hash])=>crypto.createHash('sha256').update(fs.readFileSync(path.join(source,name))).digest('hex')===hash);
  if(!sourceUnchanged&&!failure)failure=Error('Source changed during workbench checks');
  const report={status:failure?'failed':'passed',checks:names.length,names,scope:'Current full Chat frontend plus shared-workspace Tasks control fixtures in isolated headless Chrome; all requests intercepted, generated browser storage only; no native app, model, external provider or original stores.',sourceHashes,sourceUnchanged,modelRequests:operations.filter(action=>action==='start').length,nativeCalls:nativeOperations.length,unexpectedRequests:unexpected,frontendErrors:errors,...(failure?{error:failure.stack}: {})};
  const reportPath=path.join(out,'RESULT.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:report.status,checks:report.checks,report:reportPath,sourceUnchanged}));
}
if(failure)throw failure;
