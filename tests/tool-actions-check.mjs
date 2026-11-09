// Offline checks of the shipped Tools controller. No native app, backend or model.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(path.join(root,'source/tools.js'),'utf8');
const html=readFileSync(path.join(root,'source/index.html'),'utf8');
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.disabled=false;this.textContent='';this.value='';}
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children);}
  setAttribute(name,value){this.attributes[name]=String(value);}
}
function fixture({installed=false,scope=true,available=true,enabled=false,connectionHeld=false}={}){
  const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
  const calls=[],listeners=new Map();
  const state={skillInstalled:installed,fetchInstalled:installed,available,enabled,connectionHeld,hold:null,fail:null};
  const bridge={async postMessage(body){
    calls.push(structuredClone(body));
    if(state.hold)await state.hold;
    if(state.fail)throw Error(state.fail);
    if(body.op==='projectSkills'){
      if(body.input.action==='catalog')return {scope:scope?{scopeId:'fixture-scope',project:'/synthetic'}:null,catalog:[{id:'fixture-skill',name:'Fixture skill',description:'A synthetic skill'}]};
      if(body.input.action==='list')return {skills:[{id:'fixture-skill',installed:state.skillInstalled,state:state.skillInstalled?'installed':'not_installed'}]};
      if(body.input.action==='install'){state.skillInstalled=true;return {message:'Installed fixture'};}
      if(body.input.action==='read')return {text:'Synthetic read-only skill'};
    }
    if(body.op==='fetchPlugin'){
      if(body.input.action==='install')state.fetchInstalled=true;
      if(body.input.action==='set_enabled')state.enabled=body.input.enabled;
      return {available:state.available,installed:state.fetchInstalled,enabled:state.enabled,connectionHeld:state.connectionHeld};
    }
    if(body.op==='describe')return {servers:[{id:'fixture-server',connected:false}]};
    if(body.op==='catalog')return {tools:[],total:0};
    throw Error('Unexpected synthetic operation '+JSON.stringify(body));
  }};
  const window={webkit:{messageHandlers:{tools:bridge}},addEventListener:(name,fn)=>{listeners.set(name,[...(listeners.get(name)||[]),fn]);}};
  vm.runInNewContext(source,{window,document:{getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag)},setContext(){}});
  return {nodes,calls,state,async skills(){await nodes.get('skills-refresh').onclick();},async fetch(){await nodes.get('fetch-refresh').onclick();},emit(name){for(const fn of listeners.get(name)||[])fn();}};
}
function actions(f,id,label){
  const row=f.nodes.get(id).children[0];assert(row,'rendered row');
  const group=row.children[2];assert.equal(group.className,'tool-server-actions');
  assert.equal(group.attributes.role,'group');assert.equal(group.attributes['aria-label'],label);
  assert.equal(row.children.length,3,'buttons must not occupy sibling grid slots');
  assert.equal(group.children.length,2);
  for(const button of group.children){assert.equal(button.parentElement,group);assert.equal(button.type,'button');}
  return group.children;
}
test('skill actions have separate grouped controls and preserve install/read dispatch',async()=>{
  const f=fixture();await f.skills();
  let [install,read]=actions(f,'skills-catalog','Fixture skill actions');
  assert.equal(install.textContent,'Install');assert.equal(install.disabled,false);assert.equal(read.disabled,true);
  await install.onclick();[install,read]=actions(f,'skills-catalog','Fixture skill actions');
  assert.equal(install.textContent,'Installed');assert.equal(install.disabled,true);assert.equal(read.disabled,false);
  await read.onclick();assert.equal(f.nodes.get('skills-preview').textContent,'Synthetic read-only skill');
  assert.deepEqual(f.calls.filter(row=>row.input?.action==='install'||row.input?.action==='read'),[
    {op:'projectSkills',input:{action:'install',scopeId:'fixture-scope',id:'fixture-skill'}},
    {op:'projectSkills',input:{action:'read',scopeId:'fixture-scope',id:'fixture-skill'}}
  ]);
});
test('missing skill scope disables both actions without removing their labels',async()=>{
  const f=fixture({scope:false});await f.skills();const buttons=actions(f,'skills-catalog','Fixture skill actions');
  assert.deepEqual(buttons.map(row=>row.textContent),['Install','Read']);assert(buttons.every(row=>row.disabled));
});
test('Fetch install and enable remain separate through installed, enabled and disabled states',async()=>{
  const f=fixture();await f.fetch();let [install,enabled]=actions(f,'fetch-catalog','Fetch actions');
  assert.equal(install.disabled,false);assert.equal(enabled.disabled,true);
  await install.onclick();[install,enabled]=actions(f,'fetch-catalog','Fetch actions');
  assert.equal(install.disabled,true);assert.equal(enabled.disabled,false);assert.equal(enabled.textContent,'Enable');
  await enabled.onclick();[,enabled]=actions(f,'fetch-catalog','Fetch actions');assert.equal(enabled.textContent,'Disable');
  await enabled.onclick();assert.equal(actions(f,'fetch-catalog','Fetch actions')[1].textContent,'Enable');
  assert.deepEqual(f.calls.filter(row=>row.op==='fetchPlugin'&&row.input.action!=='catalog'),[
    {op:'fetchPlugin',input:{action:'install'}},
    {op:'fetchPlugin',input:{action:'set_enabled',enabled:true}},
    {op:'fetchPlugin',input:{action:'set_enabled',enabled:false}}
  ]);
});
test('unavailable Fetch preserves disabled controls; held connections offer explicit Enable',async()=>{
  const absent=fixture({available:false});await absent.fetch();assert(actions(absent,'fetch-catalog','Fetch actions').every(row=>row.disabled));
  const held=fixture({installed:true,enabled:true,connectionHeld:true});await held.fetch();const [,enable]=actions(held,'fetch-catalog','Fetch actions');
  assert.equal(enable.textContent,'Enable');assert.equal(enable.disabled,false);
});
test('repeated activation stays fenced; errors and Stop clear stale grouped actions',async()=>{
  const f=fixture();await f.fetch();const [install]=actions(f,'fetch-catalog','Fetch actions');
  let release;f.state.hold=new Promise(resolve=>{release=resolve;});
  const first=install.onclick(),second=install.onclick();assert.equal(f.calls.filter(row=>row.op==='fetchPlugin'&&row.input.action==='install').length,1);
  f.emit('tools-stopped');release();await Promise.all([first,second]);assert.equal(f.nodes.get('fetch-catalog').children.length,0,'late install response must not repopulate after Stop');
  f.state.hold=null;await f.fetch();f.state.fail='Synthetic error';await actions(f,'fetch-catalog','Fetch actions')[1].onclick();
  assert.equal(f.nodes.get('fetch-catalog').children.length,0);assert.match(f.nodes.get('fetch-status').textContent,/Synthetic error/);
});
test('single connection action retains its existing direct-child layout',async()=>{
  const f=fixture();await f.nodes.get('tools-refresh').onclick();const row=f.nodes.get('tool-servers').children[0];
  assert.equal(row.children.length,3);assert.equal(row.children[2].tagName,'button');assert.equal(row.children[2].textContent,'Connect…');
});
test('only single direct actions receive grid placement; grouped actions wrap in flex flow',()=>{
  const css=readFileSync(path.join(root,'source/style.css'),'utf8');
  const rule=selector=>{const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const match=css.match(new RegExp(escaped+'\\s*\\{([^}]+)\\}'));assert(match,'missing rule '+selector);return match[1];};
  assert.match(rule('.tool-server > button'),/grid-row:\s*1\s*\/\s*3/);
  assert.doesNotMatch(rule('.tool-server button'),/grid-(?:row|column)/);
  assert.match(rule('.tool-server-actions'),/display:\s*flex/);assert.match(rule('.tool-server-actions'),/flex-wrap:\s*wrap/);assert.match(rule('.tool-server-actions'),/grid-column:\s*1\s*\/\s*-1/);
  assert.match(rule('.tool-server-actions > button'),/max-width:\s*100%/);assert.match(rule('.tool-server-actions > button'),/white-space:\s*normal/);
});
