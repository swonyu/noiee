import {randomUUID} from 'node:crypto';
import {isAbsolute,normalize,dirname,basename} from 'node:path';

const LIMIT=8*1024*1024, METHODS=new Set(['command/exec','command/exec/write','command/exec/resize','command/exec/terminate']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const bytes=value=>{
  if(typeof value!=='string'||value.length>LIMIT||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid executor output encoding.');
  return Buffer.from(value,'base64');
};

export function executorBinding({url,authToken,launch}) {
    const endpoint=new URL(url);
    if(!(endpoint.protocol==='wss:'||endpoint.protocol==='ws:'&&['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname))||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Executor requires a secure or loopback WebSocket URL.');
    if(typeof authToken!=='string'||!authToken||authToken.length>16000||/[\s\x00-\x1f\x7f]/.test(authToken))throw new Error('Invalid executor capability token.');
    if(!object(launch)||!Array.isArray(launch.argv)||!launch.argv.length||launch.argv.length>128||launch.argv.some(s=>typeof s!=='string'||s.includes('\0')||s.length>16000)||!launch.argv[0].startsWith('/')||typeof launch.cwd!=='string'||!launch.cwd.startsWith('file:///')||!object(launch.env)||Object.entries(launch.env).some(([k,v])=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)||typeof v!=='string'||v.includes('\0')||v.length>16000)||JSON.stringify(launch).length>64000)throw new Error('Invalid trusted executor command launch.');
    if(Object.keys(launch.env).some(k=>k.startsWith('CODEX_EXEC_SERVER')))throw new Error('Command sidecar must omit CODEX_EXEC_SERVER bootstrap variables.');
    if(Object.hasOwn(launch.env,'GIT_EXEC_PATH')){
      const canonical=p=>typeof p==='string'&&isAbsolute(p)&&normalize(p)===p&&!p.endsWith('/')&&p.length<=4096&&!/[:\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(p);
      const home=launch.env.HOME,bin=launch.env.GIT_EXEC_PATH;
      // Lexical binding to the admitted home; guest bootstrap verifies the files.
      if(!canonical(home)||basename(home)!=='sidecar'||!canonical(bin)||bin!==dirname(home)+'/Git/bin'||![bin+':/usr/bin:/bin:/usr/sbin:/sbin',bin+':'+dirname(home)+'/Node/bin:/usr/bin:/bin:/usr/sbin:/sbin'].includes(launch.env.PATH))throw new Error('Invalid trusted Git runtime environment.');
    }
    return Object.freeze({url:endpoint.href,authToken,launch:Object.freeze({argv:Object.freeze([...launch.argv]),cwd:launch.cwd,env:Object.freeze({...launch.env})})});
}

// One connection owns one command app-server. Connection loss never replays work.
export class ExecutorCommands {
  #launchEnv;
  constructor({url,authToken,launch,WebSocketImpl=WebSocket,onOutput=()=>{},onFailure=()=>{}}) {
    ({url,authToken,launch}=executorBinding({url,authToken,launch}));
    this.#launchEnv=launch.env;
    Object.assign(this,{onOutput,onFailure,processId:randomUUID(),next:0,seq:0,outer:new Map(),inner:new Map(),commands:new Map(),commandOutputs:new Map(),buffer:Buffer.alloc(0),writes:Promise.resolve(),failed:null,closing:false,startSent:false,exited:false,outputClosed:false});
    this.processClosed=new Promise(resolve=>this.resolveProcessClosed=resolve);
    this.socket=new WebSocketImpl(url,{headers:{Authorization:`Bearer ${authToken}`}});
    this.opened=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('Executor connection timed out; exit unconfirmed.')),5000);
      this.rejectOpen=error=>{clearTimeout(timer);reject(error);};
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    });
    this.socket.addEventListener('message',event=>{if(this.failed||this.closed)return;try{if(typeof event.data!=='string'||Buffer.byteLength(event.data)>LIMIT)throw new Error('Invalid executor frame.');this.receive(JSON.parse(event.data));}catch(error){this.fail(error);}});
    this.socket.addEventListener('error',()=>this.fail(new Error('Executor connection failed; exit unconfirmed.')));
    this.socket.addEventListener('close',()=>{if(!this.closing||!this.exited||!this.outputClosed)this.fail(new Error('Executor connection closed; exit unconfirmed.'));});
    this.ready=this.start(structuredClone(launch)).catch(error=>{this.fail(error);throw error;});
    void this.ready.catch(()=>{});
  }
  send(message) {
    if(this.failed)throw this.failed;
    if(this.closed)throw new Error('Executor command transport is closed.');
    const data=JSON.stringify(message);
    if(this.socket.readyState!==1||Buffer.byteLength(data)>LIMIT||this.socket.bufferedAmount+Buffer.byteLength(data)>LIMIT)throw new Error('Executor connection closed or output queue exceeded.');
    this.socket.send(data);
  }
  rpc(pending,method,params,timeout=5000) {
    if(this.failed||this.closed)return Promise.reject(this.failed??new Error('Executor command transport is closed.'));
    if(pending.size>=128)return Promise.reject(new Error('Executor pending request limit exceeded.'));
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=timeout===null?null:setTimeout(()=>this.fail(new Error(`Executor ${method} timed out; exit unconfirmed.`)),timeout);
      pending.set(id,{resolve,reject,timer,method,processId:params?.processId});
      try{
        const message={id,method,params};
        if(pending===this.outer)this.send(message);
        else void this.write(message).catch(error=>this.fail(error));
      }catch(error){this.fail(error);}
    });
  }
  write(message) {
    const chunk=Buffer.from(JSON.stringify(message)+'\n').toString('base64');
    if(chunk.length>LIMIT)return Promise.reject(new Error('Executor input exceeded its limit.'));
    const work=this.writes.then(async()=>{
      const result=await this.rpc(this.outer,'process/write',{processId:this.processId,writeId:randomUUID(),chunk});
      if(result?.status!=='accepted')throw new Error('Executor command write was not accepted; exit unconfirmed.');
    });
    this.writes=work;void work.catch(()=>{});return work;
  }
  async start(launch) {
    await this.opened;
    await this.rpc(this.outer,'initialize',{clientName:'saleh-command-transport'});
    this.send({method:'initialized',params:{}});
    if(this.closing)throw new Error('Executor startup cancelled.');
    this.startSent=true;
    const argv=['/usr/bin/env','-i',...Object.entries(launch.env).map(([key,value])=>`${key}=${value}`),...launch.argv];
    const result=await this.rpc(this.outer,'process/start',{processId:this.processId,...launch,argv,tty:false,pipeStdin:true,arg0:null});
    if(result?.processId!==this.processId)throw new Error('Executor launched an unexpected process.');
    const initialized=await this.rpc(this.inner,'initialize',{clientInfo:{name:'saleh_commands',version:'1'},capabilities:{experimentalApi:true}});
    if(!launch.env.CODEX_HOME?.startsWith('/')||initialized?.codexHome!==launch.env.CODEX_HOME)throw new Error('Executor command home does not match its trusted launch.');
    await this.write({method:'initialized',params:{}});
    const account=await this.rpc(this.inner,'account/read',{refreshToken:false});
    if(account?.account!==null)throw new Error('Unexpected account in executor command home.');
    const mcp=await this.rpc(this.inner,'mcpServerStatus/list',{limit:100});
    if(!Array.isArray(mcp?.data)||mcp.data.length||mcp.nextCursor)throw new Error('Unexpected executor command integration.');
  }
  response(message,pending) {
    if(message.method)throw new Error('Unexpected executor server request.');
    const task=pending.get(message.id);
    if(!task)throw new Error('Uncorrelated executor response.');
    if(Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw new Error('Malformed executor response.');
    pending.delete(message.id);clearTimeout(task.timer);
    if(message.error){task.reject(new Error(`Executor ${task.method} failed.`));if(task.method==='command/exec')this.fail(new Error('Executor command result missing; exit unconfirmed.'));return;}
    if(pending===this.inner&&task.method==='command/exec'){
      if(!Number.isInteger(message.result?.exitCode)||typeof message.result?.stdout!=='string'||typeof message.result?.stderr!=='string'){task.reject(new Error('Executor command exit is unconfirmed.'));this.fail(new Error('Executor command exit is unconfirmed.'));return;}
      this.commands.delete(task.processId);
      this.commandOutputs.delete(task.processId);
    }
    task.resolve(message.result);
  }
  receive(message) {
    if(!object(message))throw new Error('Malformed executor message.');
    if(Object.hasOwn(message,'id'))return this.response(message,this.outer);
    const p=message.params;
    if(!['process/output','process/exited','process/closed'].includes(message.method)||!object(p)||p.processId!==this.processId||!Number.isSafeInteger(p.seq)||p.seq!==this.seq+1||this.outputClosed)throw new Error('Unexpected executor process event.');
    this.seq=p.seq;
    if(message.method==='process/exited'){
      if(this.exited||!Number.isInteger(p.exitCode))throw new Error('Invalid executor process exit.');
      this.exited=true;
      if(!this.closing)this.fail(new Error('Executor command server exited; command exits unconfirmed.'));
    }else if(message.method==='process/closed'){
      if(!this.exited||this.buffer.length)throw new Error('Executor closed before output was drained.');
      this.outputClosed=true;this.resolveProcessClosed();
    }else{
      const chunk=bytes(p.chunk);
      if(p.stream==='stderr')return;
      if(p.stream!=='stdout'||this.buffer.length+chunk.length>LIMIT)throw new Error('Invalid or oversized executor command output.');
      this.buffer=Buffer.concat([this.buffer,chunk]);
      for(let end;(end=this.buffer.indexOf(10))!==-1;){
        const line=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);
        if(!line.length)continue;
        this.receiveInner(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));
        if(this.failed)return;
      }
    }
  }
  receiveInner(message) {
    if(!object(message))throw new Error('Malformed executor command message.');
    if(Object.hasOwn(message,'id'))return this.response(message,this.inner);
    if(message.method==='remoteControl/status/changed')return;
    const p=message.params;
    if(message.method!=='command/exec/outputDelta'||!object(p)||!this.commands.has(p.processId)||!['stdout','stderr'].includes(p.stream)||typeof p.capReached!=='boolean')throw new Error('Unexpected executor command event.');
    bytes(p.deltaBase64);(this.commandOutputs.get(p.processId)??this.onOutput)(p);
  }
  async request(method,params,timeout=15000,onOutput) {
    if(!METHODS.has(method)||!object(params)||!(timeout===null||Number.isSafeInteger(timeout)&&timeout>0&&timeout<=610000))throw new Error('Invalid executor command request.');
    if(onOutput!==undefined&&(method!=='command/exec'||typeof onOutput!=='function'))throw new Error('Invalid executor output collector.');
    await this.ready;
    if(this.failed)throw this.failed;
    if(this.closing)throw new Error('Executor command transport is closed.');
    if(method==='command/exec'){
      params={...params,...(this.#launchEnv.GIT_EXEC_PATH?{env:{...params.env,GIT_EXEC_PATH:this.#launchEnv.GIT_EXEC_PATH,PATH:this.#launchEnv.PATH}}:{}),processId:params.processId??randomUUID()};
      if(typeof params.processId!=='string'||!params.processId||params.processId.length>256||this.commands.has(params.processId)||this.commands.size>=64)throw new Error('Invalid or duplicate executor command ID.');
      if(onOutput)this.commandOutputs.set(params.processId,onOutput);
      const work=this.rpc(this.inner,method,params,timeout);this.commands.set(params.processId,work);void work.catch(()=>{});return work;
    }
    if(!this.commands.has(params.processId))throw new Error('Executor command is no longer active.');
    return this.rpc(this.inner,method,params,timeout);
  }
  fail(error) {
    if(this.failed||this.closed)return;
    this.failed=error instanceof Error?error:new Error('Executor command transport failed.');
    this.rejectOpen(this.failed);
    this.commandOutputs.clear();
    for(const pending of [this.outer,this.inner]){for(const task of pending.values()){clearTimeout(task.timer);task.reject(this.failed);}pending.clear();}
    this.socket.close();this.onFailure(this.failed);
  }
  close() {
    if(this.closeWork)return this.closeWork;
    this.closing=true;
    this.closeWork=(async()=>{
      try{
        await this.ready;
        if(this.failed)return false;
        const commands=[...this.commands];
        await Promise.allSettled(commands.map(([processId])=>this.rpc(this.inner,'command/exec/terminate',{processId})));
        let timer;
        try{await Promise.race([Promise.all(commands.map(([,work])=>work)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Executor command exit unconfirmed.')),5000);})]);}finally{clearTimeout(timer);}
        await this.rpc(this.outer,'process/terminate',{processId:this.processId});
        try{await Promise.race([this.processClosed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Executor process closure unconfirmed.')),5000);})]);}finally{clearTimeout(timer);}
        this.closed=!this.failed&&!this.commands.size&&this.exited&&this.outputClosed;
        if(this.closed){
          const error=new Error('Executor command transport is closed.');
          for(const pending of [this.outer,this.inner]){for(const task of pending.values()){clearTimeout(task.timer);task.reject(error);}pending.clear();}
        }
        return this.closed;
      }catch(error){this.fail(error);return !this.startSent;}
      finally{this.socket.close();}
    })();
    return this.closeWork;
  }
}
