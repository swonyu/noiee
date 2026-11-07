import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from '../source/node_modules/playwright/index.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'.artifacts','presentation-'+new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(out,{recursive:true});
const sources=Object.fromEntries(['app.js','coding.js','style.css','workspace.css'].map(name=>[name,fs.readFileSync(path.join(root,'source',name),'utf8')]));
const slice=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a);assert.ok(a>=0&&b>a,start);return text.slice(a,b);};
const chat=slice(sources['app.js'],'function inlineText','function appendReasoning')+slice(sources['app.js'],'function renderReasoning','// CHAT FIND BEGIN');
const task=slice(sources['coding.js'],'function inlineText','function receipt');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1100,height:850}});
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body class="workspace-chat"><main id="test" style="margin:24px;max-width:900px;height:auto;overflow:visible"></main></body></html>');
  await page.addStyleTag({content:sources['style.css']});
  await page.addStyleTag({content:sources['workspace.css']});
  await page.addStyleTag({content:'body{display:block;height:auto;overflow:auto}main{display:block}.message{display:block;margin:24px 0}.message p{margin:12px 0}'});
  await page.evaluate(({chat,task})=>{
    window.qwenWork={safeURL(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}}};
    window.notice=()=>{};window.scheduleSave=()=>{};window.reasoningPreview=value=>value;
    window.chatRenderer=new Function(chat+'\nreturn {formatContent,renderReasoning};')();
    window.taskRenderer=new Function('const element=(tag,cls="",text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};\n'+task+'\nreturn {formatContent};')();
  },{chat,task});
  const actual=await page.evaluate(()=>{
    window.injected=false;
    const fence=String.fromCharCode(96).repeat(3);
    const fixture=['Answer text.','','| Item | Result |','| --- | --- |','| **check** | <img src=x onerror="window.injected=true"> |','| link | [docs](https://example.com/docs) |','','> A quoted observation.','','---','',fence+'html','<script>window.injected=true</script>',fence,'','[unsafe](javascript:window.injected=true)','[file](file:///Users/saleh/private.txt)'].join('\n');
    const host=document.querySelector('#test'),result={};
    for(const [name,renderer] of [['chat',window.chatRenderer],['tasks',window.taskRenderer]]){
      const section=document.createElement('section');section.className='message content';host.append(section);renderer.formatContent(section,fixture,false);
      const wrap=section.querySelector('.table-scroll'),table=section.querySelector('table');
      result[name]={
        table:table?.querySelectorAll('th').length===2&&table?.querySelectorAll('tbody tr').length===2,
        accessibleTable:wrap?.tabIndex===0&&wrap?.getAttribute('role')==='region'&&[...table.querySelectorAll('th')].every(x=>x.scope==='col'),
        literalHTML:section.querySelectorAll('img,script').length===0&&section.textContent.includes('<img'),
        literalCode:section.querySelector('pre code')?.textContent.includes('<script>window.injected=true</script>'),
        accessibleCode:section.querySelector('pre')?.tabIndex===0,
        linkPolicy:section.querySelectorAll('a').length===1&&section.querySelector('a')?.href==='https://example.com/docs'&&section.querySelector('a')?.rel==='noopener noreferrer',
        noFileAction:section.querySelectorAll('button').length===1,
        quote:section.querySelector('blockquote')?.textContent==='A quoted observation.',
        rule:section.querySelectorAll('hr').length===1
      };
    }
    const article=document.createElement('article');article.className='message';const answer=document.createElement('div');answer.className='content';answer.textContent='The answer comes first.';article.append(answer);host.prepend(article);
    window.chatRenderer.renderReasoning(article,{reasoning:'Generated reasoning text',state:'complete'});
    const details=article.querySelector('details');
    const old=document.createElement('article');old.className='message';const oldAnswer=document.createElement('div');oldAnswer.className='content';oldAnswer.textContent='Existing answer';old.append(oldAnswer);host.append(old);
    window.chatRenderer.renderReasoning(old,{reasoning:'Previously opened detail',reasoningOpen:true,state:'complete'});
    result.reasoning={collapsedByDefault:details.open===false,afterAnswer:answer.nextElementSibling===details,honestNote:details.querySelector('.reasoning-note').textContent.includes('Recorded tool activity'),preservesExplicitOpen:old.querySelector('details').open===true};
    result.security={noScriptExecution:window.injected===false};
    return result;
  });
  const checks=[];
  for(const [group,values] of Object.entries(actual))for(const [key,value]of Object.entries(values)){assert.equal(value,true,group+'.'+key);checks.push(group+'.'+key);}
  await page.screenshot({path:path.join(out,'presentation.png'),fullPage:true});
  const report={status:'passed',checkedAt:new Date().toISOString(),checks:checks.length,names:checks,scope:'Actual current renderer functions in isolated headless Chrome. No app backend, native bridge, inference or original browser profile.',sourceHashes:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,crypto.createHash('sha256').update(value).digest('hex')]))};
  fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:checks.length,report:path.join(out,'RESULT.json'),screenshot:path.join(out,'presentation.png')}));
}finally{await browser.close();}
