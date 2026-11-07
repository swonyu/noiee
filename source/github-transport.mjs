export function githubTarget(value){
  const m=typeof value==='string'&&/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,104})$/.exec(value),repo=m?.[2].replace(/\.git$/,'');
  if(!m||m[1].startsWith('-')||m[1].endsWith('-')||!repo||repo.length>100||['.','..'].includes(repo))throw Error('Use one canonical GitHub HTTPS repository URL without credentials, query or fragment.');
  return {host:'github.com',owner:m[1],repo,fullName:m[1]+'/'+repo,url:`https://github.com/${m[1]}/${repo}.git`};
}
export function githubBranch(value){
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>200||value!==value.toWellFormed()||value==='HEAD'||value.startsWith('-')||value.startsWith('refs/')||/[\x00-\x20\x7f~^:?*\[\\]/.test(value)||value.includes('..')||value.includes('@{')||value.endsWith('.')||value.split('/').some(p=>!p||p.startsWith('.')||p.endsWith('.lock')))throw Error('Choose an unambiguous branch name, not a full ref.');
  return value;
}

import {mkdir,lstat,realpath,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {GitRunner,GIT,CORE,SANDBOX,GIT_FLAGS,gitPolicy} from './git-runner.mjs';
const GH='/opt/homebrew/bin/gh',OID=/^[a-f0-9]{40}$/,MAX=2097152;
const sha=value=>createHash('sha256').update(value).digest('hex');
const error=(message='GitHub request could not be verified. Check the connection and inspect any submitted action.',code='GITHUB_ERROR')=>Object.assign(Error(message),{code});
const demand=(ok,message)=>{if(!ok)throw error(message);};
const target=value=>githubTarget(typeof value==='string'?value:value?.url);
const integer=value=>Number.isSafeInteger(value)&&value>0;
const account=value=>{demand(integer(value?.id)&&typeof value.login==='string'&&/^[A-Za-z0-9-]{1,39}$/.test(value.login),'GitHub account identity is unavailable.');return {id:value.id,login:value.login};};
function pullResult(value,t){
  demand(integer(value?.number)&&integer(value.id)&&typeof value.html_url==='string'&&value.html_url.toLowerCase()===`https://github.com/${t.fullName}/pull/${value.number}`.toLowerCase()&&['open','closed'].includes(value.state)&&typeof value.draft==='boolean'&&typeof value.title==='string'&&typeof(value.body??'')==='string','GitHub pull request identity is unavailable.');
  const ref=value=>{demand(integer(value?.repo?.id)&&typeof value.repo.full_name==='string'&&OID.test(value.sha),'GitHub pull request refs are unavailable.');return {repoId:value.repo.id,fullName:value.repo.full_name,ref:githubBranch(value.ref),sha:value.sha};};
  return {id:value.id,number:value.number,url:value.html_url,state:value.state,draft:value.draft,head:ref(value.head),base:ref(value.base),titleSHA256:sha(value.title),bodySHA256:sha(value.body??'')};
}
// Reuse process-group observation and Stop; the ordinary Git policy stays local-only.
class GitHubProcess extends GitRunner{
  constructor(options,kind,token){super(options);Object.assign(this,{kind,token,timeoutMs:kind==='git'?120000:20000,ghIdentity:null,gh:null});}
  async verify(){
    await super.verify();const gh=await realpath(GH);demand(/^\/opt\/homebrew\/Cellar\/gh\/[A-Za-z0-9_.+-]+\/bin\/gh$/.test(gh),'Install GitHub CLI using Homebrew, then check the connection.');
    const st=await lstat(gh);demand(st.isFile()&&[0,process.getuid()].includes(st.uid)&&!(st.mode&0o022),'GitHub CLI permissions are unsafe.');
    const identity=JSON.stringify([gh,String(st.dev),String(st.ino),st.size,sha(await readFile(gh))]);demand(!this.ghIdentity||this.ghIdentity===identity,'GitHub CLI identity changed; restart and inspect.');this.ghIdentity=identity;this.gh=gh;
    for(const path of [join(CORE,'git-remote-https'),join(CORE,'git-remote-http'),'/bin/sh','/bin/bash','/usr/bin/security']){const p=await realpath(path),s=await lstat(p);demand(s.isFile()&&s.uid===0&&!(s.mode&0o022),'Trusted GitHub Git helpers are unavailable.');}
  }
  launchSpec(args,{scope,env,record}){
    demand(!record,'GitHub transport cannot use retained handoff authority.');
    // gh auth token uses the system Keychain reader. No login, write or credential-management action is exposed.
    const executables=[this.gh,...(this.kind==='git'?[GIT,join(CORE,'git'),join(CORE,'git-remote-https'),join(CORE,'git-remote-http'),'/bin/sh','/bin/bash']:['/usr/bin/security'])];
    let policy=gitPolicy(scope).replace(/\(allow process-exec[^\n]+\)/,'(allow process-exec '+executables.map(x=>'(literal '+JSON.stringify(x)+')').join(' ')+')');
    // ponytail: Seatbelt filters ports, not DNS names; fixed HTTPS URLs, private config and disabled redirects bind GitHub.
    if(this.kind==='git')policy=policy.replace('(deny network*)','(allow network-outbound (remote tcp "*:443") (literal "/private/var/run/mDNSResponder"))');
    const clean={HOME:this.kind==='git'?this.dataDir:homedir(),PATH:dirname(GIT)+':'+CORE,LANG:'en_US.UTF-8',LC_ALL:'C',GIT_EXEC_PATH:CORE,GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GH_CONFIG_DIR:join(homedir(),'.config/gh'),GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1',NO_COLOR:'1',...env};
    if(this.kind==='git'){clean.GH_TOKEN=this.token();demand(typeof clean.GH_TOKEN==='string'&&clean.GH_TOKEN.length>0,'Connect GitHub before publishing.');}
    const flags=this.kind==='git'?[...GIT_FLAGS,'-c','credential.helper=','-c',`credential.helper=!'${this.gh}' auth git-credential`,'-c','credential.useHttpPath=true','-c','protocol.file.allow=never','-c','http.followRedirects=false']:[];
    return {file:SANDBOX,args:['-p',policy,this.kind==='git'?GIT:this.gh,...flags,...args],options:{cwd:'/private/var/empty',env:clean,detached:true,stdio:['pipe','pipe','pipe']}};
  }
  async run(args,options){try{const result=await super.run(args,options);await this.verify();return result;}catch(e){throw error(this.kind==='auth'?'GitHub connection unavailable. Install GitHub CLI and sign in with gh auth login.':'GitHub command did not complete normally. Inspect the remote before repeating any submitted action.',e.code==='CANCELLED'?'CANCELLED':'GITHUB_ERROR');}}
}

export class GitHubTransport{
  #token=null;#controller=null;#httpBlocked=false;
  constructor({dataDir,spawnProcess,fetchImpl=globalThis.fetch}={}){demand(isAbsolute(dataDir),'Private GitHub data directory required.');this.dataDir=dataDir;this.fetchHTTP=fetchImpl;this.auth=new GitHubProcess({dataDir,spawnProcess},'auth',()=>null);this.git=new GitHubProcess({dataDir,spawnProcess},'git',()=>this.#token);}
  get blocked(){return this.#httpBlocked||this.auth.blocked||this.git.blocked;}
  cancel(){this.#controller?.abort();this.auth.cancel();this.git.cancel();}
  clearCredentials(){this.#token=null;}
  async #api(method,path,check,body,allow404=false){
    demand(!this.blocked&&!this.#controller&&this.#token,'GitHub transport is unavailable or busy.');demand(['GET','POST'].includes(method)&&path.startsWith('/')&&!/[\x00-\x20\x7f#]/.test(path),'Invalid fixed GitHub API operation.');check();
    const controller=new AbortController();this.#controller=controller;let grace,settled=false;
    const url='https://api.github.com'+path,timer=setTimeout(()=>controller.abort(),20000);
    const unavailable=new Promise(resolve=>controller.signal.addEventListener('abort',()=>{grace=setTimeout(()=>resolve(false),2500);},{once:true}));
    const task=(async()=>{
      const response=await this.fetchHTTP(url,{method,redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+this.#token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      demand(response.url===url&&response.status>=200&&response.status<300||response.url===url&&allow404&&response.status===404,'GitHub returned an unexpected response.');
      const reader=response.body?.getReader();demand(reader,'GitHub response body is missing.');let bytes=0;const chunks=[];
      try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;demand(bytes<=MAX,'GitHub response exceeds its bounded limit.');chunks.push(Buffer.from(value));}return {status:response.status,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))};}finally{await reader.cancel().catch(()=>{});}
    })().finally(()=>{settled=true;});
    try{const answer=await Promise.race([task,unavailable]);if(answer===false){this.#httpBlocked=true;throw error();}check();return answer;}catch{controller.abort();throw error();}finally{clearTimeout(timer);clearTimeout(grace);if(settled&&this.#controller===controller)this.#controller=null;}
  }
  async account(check,refresh=false){
    if(refresh||!this.#token){this.#token=null;const value=(await this.auth.run(['auth','token','--hostname','github.com'],{check,maxOutputBytes:8192})).stdout.trim();demand(/^[\x21-\x7e]{1,4096}$/.test(value),'GitHub connection unavailable.');this.#token=value;}
    return account((await this.#api('GET','/user',check)).value);
  }
  async repository(value,check){const t=target(value),v=(await this.#api('GET','/repos/'+t.fullName,check)).value;demand(integer(v?.id)&&typeof v.full_name==='string'&&v.full_name.toLowerCase()===t.fullName.toLowerCase(),'GitHub repository identity differs from the selected destination.');return {id:v.id,fullName:v.full_name,defaultBranch:githubBranch(v.default_branch),canPush:v.permissions?.push===true};}
  async ref(value,branch,check){const t=target(value);githubBranch(branch);const r=await this.#api('GET','/repos/'+t.fullName+'/git/ref/heads/'+encodeURIComponent(branch),check,undefined,true);if(r.status===404)return null;demand(r.value?.ref==='refs/heads/'+branch&&r.value.object?.type==='commit'&&OID.test(r.value.object.sha),'GitHub branch identity is unavailable.');return r.value.object.sha;}
  async prepareRepository(dir,source,check){
    demand(isAbsolute(dir)&&await realpath(dirname(dir))===dirname(dir)&&isAbsolute(source?.commonDir)&&await realpath(source.commonDir)===source.commonDir,'Private GitHub repository paths differ.');await mkdir(dir,{mode:0o700});const st=await lstat(dir),p={path:dir,sourceObjects:join(source.commonDir,'objects'),identity:JSON.stringify([String(st.dev),String(st.ino)])};
    await this.runGit(p,['init','--bare','--template=/private/var/empty',dir],check);return p;
  }
  async runGit(p,args,check,options={}){
    const verify=async()=>{const s=await lstat(p.path);demand(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077)&&JSON.stringify([String(s.dev),String(s.ino)])===p.identity,'Private GitHub repository identity changed.');};
    await verify();const result=await this.git.run(['--git-dir='+p.path,...args],{...options,check,scope:{dirs:[p.path]},env:{GIT_ALTERNATE_OBJECT_DIRECTORIES:JSON.stringify(p.sourceObjects)}});await verify();return result;
  }
  async fetch(p,value,branch,check){const t=target(value);githubBranch(branch);const ref='refs/saleh-observed/'+randomUUID();await this.runGit(p,['fetch','--no-tags','--no-write-fetch-head','--no-recurse-submodules',t.url,'refs/heads/'+branch+':'+ref],check);const oid=(await this.runGit(p,['rev-parse','--verify',ref+'^{commit}'],check)).stdout.trim();demand(OID.test(oid),'Fetched GitHub branch is unavailable.');return oid;}
  async push(p,value,branch,oldOID,newOID,check,beforeDispatch=async()=>{}){
    const t=target(value);githubBranch(branch);demand(OID.test(newOID)&&(oldOID===null||OID.test(oldOID)),'GitHub commit identity is invalid.');demand((await this.runGit(p,['cat-file','-t',newOID],check)).stdout.trim()==='commit','Published object is not a commit.');
    if(oldOID!==null){if(await this.fetch(p,t,branch,check)!==oldOID)throw error('The reviewed remote branch changed; check the target again.','STALE');if((await this.runGit(p,['merge-base','--is-ancestor',oldOID,newOID],check,{allowCodes:[0,1]})).code!==0)throw error('Only fast-forward publication is supported; the old commit is not an ancestor.','STALE');}
    await beforeDispatch();check();const output=(await this.runGit(p,['push','--porcelain','--no-follow-tags','--recurse-submodules=no','--signed=no','--force-with-lease=refs/heads/'+branch+':'+(oldOID??''),t.url,newOID+':refs/heads/'+branch],check)).stdout;
    const rows=output.split('\n').filter(row=>row.includes('\t')).map(row=>/^([ *+=!\-])\t([^\t\r\n]+)\t[^\r\n]*$/.exec(row));
    if(rows.length!==1||!rows[0]||rows[0][1]!== (oldOID===null?'*':' ')||rows[0][2]!==newOID+':refs/heads/'+branch)throw error('The remote changed or was already up to date; this publication was not verified. Inspect the target.','STALE');
  }
  async pulls(value,head,base,check,state='open'){
    const t=target(value);githubBranch(head);githubBranch(base);const rows=[],ids=new Set();
    demand(['open','all'].includes(state),'Invalid pull request lookup state.');
    // ponytail: bounded1000-result inspection; refuse unknown absence rather than silently create beyond it.
    for(let page=1;page<=11;page++){
      const data=(await this.#api('GET','/repos/'+t.fullName+'/pulls?state='+state+'&head='+encodeURIComponent(t.owner+':'+head)+'&base='+encodeURIComponent(base)+'&per_page=100&page='+page,check)).value;
      demand(Array.isArray(data)&&data.length<=100&&rows.length+data.length<=1000,'GitHub pull request lookup exceeds its complete pagination limit.');
      for(const row of data){const r=pullResult(row,t);demand(!ids.has(r.id),'GitHub pull request lookup is incomplete or duplicated.');ids.add(r.id);rows.push(r);}if(data.length<100)return rows;
    }
    throw error('GitHub pull request lookup is incomplete.');
  }
  async createPR(value,input,check){
    const t=target(value);demand(input&&Object.keys(input).sort().join()=== 'base,body,head,title'&&typeof input.title==='string'&&input.title.trim()&&Buffer.byteLength(input.title)<=256&&!/[\0\r\n]/.test(input.title)&&typeof input.body==='string'&&Buffer.byteLength(input.body)<=65536&&!input.body.includes('\0'),'GitHub PR title/body is invalid.');githubBranch(input.head);githubBranch(input.base);
    return pullResult((await this.#api('POST','/repos/'+t.fullName+'/pulls',check,{head:input.head,base:input.base,title:input.title,body:input.body,draft:true,maintainer_can_modify:false})).value,t);
  }
  async pull(value,number,check){const t=target(value);demand(integer(number),'GitHub pull request number is invalid.');return pullResult((await this.#api('GET','/repos/'+t.fullName+'/pulls/'+number,check)).value,t);}
}

export function githubRemotes(config){
  const parts=config.split('\0'),remotes=new Map();let rewritten=false;
  for(let i=1;i<parts.length;i+=2){const end=parts[i].indexOf('\n');if(end<0)continue;const key=parts[i].slice(0,end),value=parts[i].slice(end+1);rewritten||=/^url\..*\.(insteadof|pushinsteadof)$/i.test(key);const match=/^remote\.(.+)\.(url|pushurl|mirror)$/i.exec(key);if(!match)continue;const row=remotes.get(match[1])??{url:[],pushurl:[],mirror:[]};row[match[2].toLowerCase()].push(value);remotes.set(match[1],row);}
  demand(remotes.size<=32,'GitHub remote inventory exceeds32 configured remotes.');
  return [...remotes].map(([name,row])=>{demand(name&&Buffer.byteLength(name)<=100&&!/[\x00-\x20\x7f]/.test(name),'Git remote names are unsupported.');try{demand(!rewritten&&row.url.length===1&&row.pushurl.length<=1&&row.mirror.every(x=>x==='false'));return {name,supported:true,...githubTarget(row.pushurl[0]??row.url[0])};}catch{return {name,supported:false,reason:'Use one canonical GitHub HTTPS destination without URL rewriting, credentials or mirror settings.'};}});
}
