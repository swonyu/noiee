import {spawn} from 'node:child_process';
import {lstat,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifyHandoffHelper,releaseHandoffProcess} from './handoff-process.mjs';

export const GIT='/Applications/Xcode.app/Contents/Developer/usr/bin/git',CORE='/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core',SANDBOX='/usr/bin/sandbox-exec';
export const GIT_FLAGS=['--no-pager','--no-optional-locks','--no-replace-objects','--no-lazy-fetch','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','maintenance.auto=false','-c','gc.auto=0','-c','submodule.recurse=false','-c','core.attributesFile=/dev/null','-c','worktree.guessRemote=false','-c','worktree.useRelativePaths=false'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function gitPolicy({dirs=[],files=[],create=[],checkout}={}){return `(version 1)\n(deny default)\n(allow file-read*)\n(allow process-fork)\n(allow process-exec (literal ${JSON.stringify(GIT)}) (literal ${JSON.stringify(join(CORE,'git'))}))\n(allow sysctl-read)\n(allow mach-lookup)\n(allow signal (target self))\n(allow file-write* (literal "/dev/null"))\n${dirs.map(p=>`(allow file-write* (subpath ${JSON.stringify(p)}))`).join('\n')}\n${checkout?`(allow file-write* (require-all (subpath ${JSON.stringify(checkout.path)}) ${checkout.exclude.map(p=>`(require-not (subpath ${JSON.stringify(p)}))`).join(' ')}))`:''}\n${files.map(p=>`(allow file-write* (literal ${JSON.stringify(p)}))`).join('\n')}\n${create.map(p=>`(allow file-write-create (literal ${JSON.stringify(p)}))`).join('\n')}\n(deny network*)`;}
export class GitRunner {
  constructor({dataDir,spawnProcess=spawn,nativeHelper=null,processGuard=null}){Object.assign(this,{dataDir,spawnProcess,nativeHelper,processGuard,child:null,blocked:false,identity:null,helperIdentity:null});}
  async verify(){
    for(const path of [GIT,SANDBOX]){const s=await lstat(path,{bigint:true});if(!s.isFile()||s.uid!==0n||(s.mode&0o022n))throw new Error('Trusted native Git runner is unavailable.');if(path===GIT){const id=`${s.dev}:${s.ino}`;if(this.identity&&this.identity!==id)throw new Error('Trusted Git executable changed.');this.identity=id;}}
    if(await realpath(join(CORE,'git'))!==GIT)throw new Error('Git helper does not resolve to trusted Git.');
  }
  cancel(){this.child?.cancel();}
  launchSpec(args,{scope,env,record,nonce}){
    const clean={HOME:this.dataDir,PATH:dirname(GIT)+':'+CORE,LANG:'en_US.UTF-8',LC_ALL:'C',GIT_EXEC_PATH:CORE,GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',...env};
    return {file:record?this.nativeHelper:SANDBOX,args:record?['--handoff-process','git',nonce,gitPolicy(scope),...GIT_FLAGS,...args]:['-p',gitPolicy(scope),GIT,...GIT_FLAGS,...args],options:{cwd:'/private/var/empty',env:clean,detached:true,stdio:record?['pipe','pipe','pipe','pipe','pipe']:['pipe','pipe','pipe']}};
  }
  async run(args,{scope={},input='',env={},check=()=>{},allowCodes=[0],raw=false,prepared,onUnavailable,maxOutputBytes=2097152}={}){
    if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>41943040)throw new Error('Invalid bounded Git output limit.');
    const timeoutMs=this.timeoutMs??20000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new Error('Invalid bounded Git process timeout.');
    if(this.blocked)throw new Error('Previous Git process exit was not confirmed; restart and inspect retained work.');if(this.child)throw new Error('Another Git process is running.');check();await this.verify();check();
    const record=this.processGuard?.({args,scope})??null;if(record!==null&&typeof record!=='function')throw new Error('Invalid handoff process record callback.');
    if(record){this.helperIdentity=await verifyHandoffHelper(this.nativeHelper,this.helperIdentity);check();}
    const nonce=record?randomUUID():null,spec=this.launchSpec(args,{scope,env,record,nonce});
    const child=this.spawnProcess(spec.file,spec.args,spec.options);
    const state={child,pid:child.pid,cancelled:false};this.child=state;let expire;const limit=new Promise(resolve=>{expire=resolve;});
    let bytes=0,overflow=false,error,code,signal,protocol='',preparedWork;const out=[],err=[];
    const unavailable=()=>{if(state.unavailable)return;state.unavailable=true;try{onUnavailable?.();}catch(e){error??=e;}};
    const kill=signal=>{if(Number.isInteger(state.pid)&&state.pid>1)try{process.kill(-state.pid,signal);}catch(e){if(e.code!=='ESRCH')state.killError=e.message;}};
    state.cancel=()=>{state.cancelled=true;unavailable();kill('SIGTERM');state.escalate??=setTimeout(()=>kill('SIGKILL'),1000);state.exitLimit??=setTimeout(()=>expire(false),2500);};
    const collect=target=>chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes){overflow=true;state.cancel();return;}target.push(chunk);};
    child.stdout.on('data',chunk=>{collect(out)(chunk);if(prepared&&!preparedWork){protocol+=chunk.toString('ascii');if(protocol.includes('prepare: ok\n'))preparedWork=Promise.resolve().then(()=>{check();return prepared();}).then(()=>{check();if(state.cancelled||state.exited)throw new Error('Git transaction cancelled.');child.stdin.end('commit\n');}).catch(e=>{error=e;if(!child.stdin.destroyed)child.stdin.end('abort\n');});}});
    child.stderr.on('data',collect(err));child.stdin.on('error',()=>{});
    const timer=setTimeout(()=>{state.timedOut=true;state.cancel();},timeoutMs);
    // Process exit ends transaction authority immediately; stream close and group exit still govern cleanup.
    child.once('exit',()=>{state.exited=true;unavailable();});
    const finished=new Promise(resolve=>{child.on('error',e=>{error=e;state.cancel();});child.on('close',(c,s)=>{state.exited=true;unavailable();code=c;signal=s;resolve();});});
    const gateCheck=()=>{check();if(this.child!==state||state.cancelled||state.exited)throw new Error('Git transaction cancelled.');};
    try{try{
        gateCheck();if(record)await releaseHandoffProcess(child,nonce,{check:gateCheck,abort:limit,record:async receipt=>{await verifyHandoffHelper(this.nativeHelper,this.helperIdentity);gateCheck();await record(receipt);await verifyHandoffHelper(this.nativeHelper,this.helperIdentity);gateCheck();}});
        gateCheck();if(prepared)child.stdin.write(input);else child.stdin.end(input);
      }catch(e){error=e;state.cancel();}
      if(!await Promise.race([finished.then(()=>true),limit])){this.blocked=true;throw new Error('Git process exit was not confirmed; partial work retained.');}
      const deadline=Date.now()+1500;let alive=false;do{try{if(!state.pid)break;process.kill(-state.pid,0);alive=true;}catch(e){if(e.code==='ESRCH'){alive=false;break;}alive=true;}if(alive){kill('SIGKILL');await sleep(25);}}while(alive&&Date.now()<deadline);
      if(alive){this.blocked=true;throw new Error('Git process group exit was not confirmed; partial work retained.');}
      if(error)throw error;check();if(state.cancelled||signal||state.timedOut)throw new Error('Git operation cancelled or timed out.');await preparedWork;if(error)throw error;check();if(overflow)throw new Error('Git output exceeded its bounded limit.');if(record){await verifyHandoffHelper(this.nativeHelper,this.helperIdentity);check();if(state.cancelled)throw new Error('Git operation cancelled.');}
      const output=Buffer.concat(out),diagnostic=Buffer.concat(err),decode=x=>new TextDecoder('utf-8',{fatal:true}).decode(x);
      if(!allowCodes.includes(code))throw new Error((decode(diagnostic).trim()||'Git command failed.').slice(0,1600));
      if(prepared&&!preparedWork)throw new Error('Git transaction did not prepare.');return {stdout:raw?output:decode(output),stderr:decode(diagnostic),code};
    }finally{clearTimeout(timer);clearTimeout(state.escalate);clearTimeout(state.exitLimit);if(this.child===state)this.child=null;}
  }
}
