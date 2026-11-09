// Optional rendering check. Isolated Chrome + synthetic bridge only, all network blocked.
// node --preserve-symlinks tests/tool-actions-browser-check.mjs
// NOIEE_PLAYWRIGHT_ENTRY may point to an existing, verified Playwright index.mjs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const entry=process.env.NOIEE_PLAYWRIGHT_ENTRY||path.join(root,'source/node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(entry));
const html=readFileSync(path.join(root,'source/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
let checks=0;
try{
  const context=await browser.newContext({viewport:{width:760,height:900}});
  const requests=[],errors=[];await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(html);
  for(const file of ['style.css','workspace.css'])await page.addStyleTag({content:readFileSync(path.join(root,'source',file),'utf8')});
  // Present the production inspector alone without booting app.js or accessing stores.
  await page.addStyleTag({content:'#sidebar,main{display:none!important}#context-panel{position:relative!important;inset:auto!important;width:min(360px,100vw)!important;display:block!important;height:100vh;overflow:auto}'});
  await page.evaluate(()=>{
    document.getElementById('context-panel').hidden=false;document.getElementById('context-fields').hidden=true;document.getElementById('tools-panel').hidden=false;
    window.fixture={installed:false,available:true,enabled:false,connectionHeld:false};
    window.setContext=()=>{};
    window.webkit={messageHandlers:{tools:{postMessage:async body=>{
      if(body.op==='projectSkills'&&body.input.action==='catalog')return {scope:{scopeId:'synthetic',project:'/synthetic'},catalog:[{id:'example',name:'A long synthetic skill name that must wrap inside the inspector',description:'Generated skill description for isolated layout coverage.'}]};
      if(body.op==='projectSkills'&&body.input.action==='list')return {skills:[{id:'example',installed:fixture.installed,state:fixture.installed?'installed':'not_installed'}]};
      if(body.op==='fetchPlugin'&&body.input.action==='catalog')return {...fixture};
      if(body.op==='describe')return {servers:[]};
      if(body.op==='catalog')return {tools:[],total:0};
      throw Error('Rendering fixture refuses action '+JSON.stringify(body));
    }}}};
  });
  await page.addScriptTag({content:readFileSync(path.join(root,'source/tools.js'),'utf8')});
  for(const width of [280,320,360,760]){
    await page.setViewportSize({width,height:900});
    for(const state of [
      {installed:false,available:true,enabled:false,connectionHeld:false},
      {installed:true,available:true,enabled:false,connectionHeld:false},
      {installed:true,available:true,enabled:true,connectionHeld:false},
      {installed:true,available:true,enabled:true,connectionHeld:true},
      {installed:false,available:false,enabled:false,connectionHeld:false}
    ]){
      await page.evaluate(async state=>{window.fixture=state;await document.getElementById('skills-refresh').onclick();await document.getElementById('fetch-refresh').onclick();},state);
      for(const id of ['skills-catalog','fetch-catalog']){
        const buttons=page.locator('#'+id+' .tool-server button');assert.equal(await buttons.count(),2);
        for(let i=0;i<2;i++){
          await buttons.nth(i).evaluate(button=>button.scrollIntoView({block:'center',inline:'nearest'}));
          const geometry=await buttons.nth(i).evaluate(button=>{
            const box=button.getBoundingClientRect(),row=button.closest('.tool-server').getBoundingClientRect();
            const overlap=[...button.closest('.tool-server').querySelectorAll('button')].filter(other=>other!==button).some(other=>{const b=other.getBoundingClientRect();return Math.min(box.right,b.right)>Math.max(box.left,b.left)&&Math.min(box.bottom,b.bottom)>Math.max(box.top,b.top);});
            return {overlap,inside:box.left>=row.left&&box.right<=row.right,hit:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===button};
          });
          assert.equal(geometry.overlap,false,`${id}/${width}: actions overlap`);assert.equal(geometry.inside,true,`${id}/${width}: action overflows row`);assert.equal(geometry.hit,true,`${id}/${width}: action center is covered`);
          if(await buttons.nth(i).isEnabled()){
            await buttons.nth(i).focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
            assert(await buttons.nth(i).evaluate(button=>document.activeElement===button&&button.matches(':focus-visible')&&getComputedStyle(button).outlineStyle!=='none'),`${id}/${width}: keyboard focus is not visible`);
          }
          checks++;
        }
      }
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log(JSON.stringify({passed:true,controlChecks:checks,realModels:0,nativeCalls:0,originalStoresTouched:false}));
}finally{await browser.close();}
