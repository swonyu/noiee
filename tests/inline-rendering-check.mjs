import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {chromium} from '../source/node_modules/playwright/index.mjs';

const sources = ['app.js', 'coding.js'].map(name => fs.readFileSync(new URL('../source/' + name, import.meta.url), 'utf8'));
const snippets = sources.map(s => s.slice(s.indexOf('// INLINE TOKENIZER BEGIN'), s.indexOf('// INLINE TOKENIZER END')));
assert.equal(snippets[0], snippets[1], 'Chat and Tasks use the same tokenizer');
const legacy = [/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g, /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:<[^>\n]+>|[^\s)]+)\))/g];
const tokenize = new Function('text', 'fileLinks', snippets[0] + ';return parts;');
// Count actual characters traversed by searches and loop iterations, not elapsed-time ratios.
const counted = new Function('text', 'fileLinks', 'let steps=0;' + snippets[0]
  .replace('found = input.indexOf(delimiter, from);', 'found = input.indexOf(delimiter, from); steps += (found < 0 ? input.length : found + 1) - from;')
  .replace('targetStop = targetBoundary.exec(input)?.index ?? input.length;', 'targetStop = targetBoundary.exec(input)?.index ?? input.length; steps += targetStop - start + 1;')
  .replace('let end = -1;', 'steps++; let end = -1;') + ';return {parts,steps};');
const examples = ['', 'plain <script>alert(1)</script>', '**bold** and `code`', '[web](https://example.com/a)', '[file](<src/my file.js>)', '[file](./src/main.js)', '[unsafe](javascript:alert)', '[bad](https://)', '[[[label](https://example.com)', '**bad*bold**', '`unclosed', '[x](<bad>suffix)', '[x](<a)b>)', '[x](<a\nb>)'];
let seed = 715;
const random = n => {seed = (Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
const alphabet = ['[',']','(',')','*','`','\n','\r',' ','a','<','>','https://','http://','./','\t','💡'];
for (let i=0;i<12000;i++) examples.push(Array.from({length:random(60)},()=>alphabet[random(alphabet.length)]).join(''));
for (const fileLinks of [false,true]) for (const text of examples) assert.deepEqual(tokenize(text,fileLinks),text.split(legacy[Number(fileLinks)]),JSON.stringify({fileLinks,text}));
console.log(`Legacy token parity: ${examples.length * 2} cases across both dialects.`);
const adversaries = [n=>'['.repeat(n),n=>'['.repeat(n)+'](<'+ 'a'.repeat(n),n=>'**'.repeat(n),n=>'[x](<'.repeat(n),n=>'[x]('.repeat(n),n=>'`'.repeat(n),n=>'[x](https://'.repeat(n),n=>'['.repeat(n)+'](https://example.com)',n=>'[x](<'+ '['.repeat(n)+'](./a)'];
for (const fileLinks of [false,true]) for (const make of adversaries) for (const size of [1000,10000,100000]) {
  const text=make(size), result=counted(text,fileLinks);
  assert.ok(result.steps <= 10*text.length+10, `${result.steps} steps for ${text.length} chars`);
  assert.equal(result.parts.join(''),text,'No user text discarded');
}
console.log(`Deterministic linear scan bounds: ${2 * adversaries.length * 3} adversarial cases.`);
for (const regex of legacy) {
  const child=spawnSync(process.execPath,['-e',`'['.repeat(262144).split(${regex});`],{timeout:750});
  assert.equal(child.error?.code,'ETIMEDOUT','Baseline must fail bounded watchdog');
}
const start=performance.now();
for (const fileLinks of [false,true]) assert.equal(tokenize('['.repeat(2*1024*1024),fileLinks).join('').length,2*1024*1024);
console.log(`Both 2 MiB candidate tokenizations completed in ${Math.round(performance.now()-start)} ms; baseline 256 KiB exceeded 750 ms watchdog for each renderer.`);

const renderers=sources.map((s,i)=>s.slice(s.indexOf('function inlineText('),s.indexOf(i?'  async function copyText':'function syncNode',s.indexOf('function inlineText('))));
const filePreview=sources[1].slice(sources[1].indexOf('  function codingLocalFileLink'),sources[1].indexOf('  function codingFileButton'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page=await browser.newPage();
  await page.setContent('<main></main>');
  await page.addScriptTag({content:fs.readFileSync(new URL('../source/work.js',import.meta.url),'utf8')});
  const result=await page.evaluate(({renderers,filePreview,legacy,examples})=>{
    const element=(tag,cls='',text='')=>{const node=document.createElement(tag);node.className=cls;node.textContent=text;return node;};
    const qwenWork=globalThis.qwenWork;
    const codingFileButton=(path,label)=>{const b=element('button','',label);b.dataset.path=path;return b;};
    const results=[];
    for(const [index,source] of renderers.entries()){
      const render=new Function('element','qwenWork','codingFileButton',filePreview+source+';return inlineText;')(element,qwenWork,codingFileButton);
      const parent=document.querySelector('main');parent.replaceChildren();
      const originalSource=source.slice(0,source.indexOf('{')+1)+'for (const part of String(text).split('+legacy[index]+')) {'+source.slice(source.indexOf('const link'));
      const original=new Function('element','qwenWork','codingFileButton',filePreview+originalSource+';return inlineText;')(element,qwenWork,codingFileButton);
      const edges=[...examples.slice(0,400), '[user](https://user:secret@example.com)', '[long](https://example.com/'+ 'a'.repeat(2100)+')', '[encoded](src/my%20file.js)', '[bad](%00src/main.js)', '[bad](%ZZ)', '[bad](//example.com)', '[bad](#anchor)', '[bad](file:///tmp/a)', '[bad](data:text/html,x)', '[bad](<javascript:alert>)', '[unicode 💡](./src/💡.js)', '[label\r\nline](./a)', '[x](<path with spaces>)', '[**label**](./a)', '[x](./a)[y](./b)', '**[brackets]** `[x](./a)`'];
      for(const text of edges) for(const allow of [true,false]) {
        const expected=document.createElement('div'),actual=document.createElement('div');original(expected,text,allow);render(actual,text,allow);
        if(actual.innerHTML!==expected.innerHTML || actual.textContent!==expected.textContent) throw new Error('DOM parity mismatch '+JSON.stringify({index,text,allow}));
      }

      render(parent,'**bold** `code` [web](https://example.com) <img src=x onerror=alert(1)> [bad](javascript:alert) [file](<src/my file.js>)');
      results.push({domParityCases:edges.length*2,strong:parent.querySelector('strong')?.textContent,code:parent.querySelector('code')?.textContent,links:[...parent.querySelectorAll('a')].map(a=>[a.href,a.rel,a.target]),images:parent.querySelectorAll('img').length,buttons:[...parent.querySelectorAll('button')].map(b=>b.dataset.path),text:parent.textContent});
      parent.replaceChildren();const text='['.repeat(2*1024*1024);const start=performance.now();render(parent,text);results.at(-1).large={length:parent.textContent.length,ms:performance.now()-start,nodes:parent.childNodes.length};
      parent.replaceChildren();render(parent,'[file](./src/main.js)',false);results.at(-1).disabledPreviewButtons=parent.querySelectorAll('button').length;
    }
    return results;
  },{renderers,filePreview,legacy:legacy.map(String),examples});
  for(const row of result){assert.equal(row.strong,'bold');assert.equal(row.code,'code');assert.deepEqual(row.links,[['https://example.com/','noopener noreferrer','_blank']]);assert.equal(row.images,0);assert.ok(row.text.includes('[bad](javascript:alert)'));assert.equal(row.large.length,2*1024*1024);assert.equal(row.large.nodes,1);assert.equal(row.disabledPreviewButtons,0);}
  assert.deepEqual(result[0].buttons,[]);assert.deepEqual(result[1].buttons,['src/my file.js']);
  console.log('Real Chrome renderer fixture:',JSON.stringify(result.map(r=>({domParityCases:r.domParityCases,buttons:r.buttons,large:r.large}))));
} finally {await browser.close();}
console.log('inline-rendering-check: PASS (legacy parity, linear work bounds, watchdog reproduction, actual Chat/Tasks DOM fixtures)');
