import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

export function terminalSize(cols=100,rows=30) {
  if(!Number.isInteger(cols)||cols<20||cols>240||!Number.isInteger(rows)||rows<5||rows>100)throw new Error('Terminal size requires 20–240 columns and 5–100 rows.');
  return {cols,rows};
}
export function terminalInput(value) {
  if(typeof value!=='string'||!value.length||value.length>21336||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid terminal input encoding.');
  const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>16000||bytes.toString('base64')!==value)throw new Error('Terminal input requires 1–16000 canonical base64 bytes.');return bytes;
}

// One parser is authoritative. Clients receive full frames, never a raw suffix
// that would lose the parser's unfinished UTF-8 or escape sequence on reload.
export class CodingTerminal {
  constructor({cols=100,rows=30,onReply=()=>{},onError=()=>{}}={}) {
    terminalSize(cols,rows);this.terminal=new headless.Terminal({cols,rows,scrollback:500,allowProposedApi:true});
    this.serializer=new serialize.SerializeAddon();this.terminal.loadAddon(this.serializer);
    this.state='running';this.revision=1;this.pendingBytes=0;this.queue=Promise.resolve();this.onError=onError;this.disposed=false;
    this.terminal.onData(data=>{if(this.state==='running')onReply(Buffer.from(data));});
  }
  metadata(){return {mode:'pty',state:this.state,cols:this.terminal.cols,rows:this.terminal.rows,revision:this.revision,scrollback:500,...(this.exitCode!==undefined?{exitCode:this.exitCode}:{}),...(this.error?{error:this.error}:{})};}
  fault(error){if(!this.error){this.error=String(error.message??error).slice(0,2000);this.revision++;this.onError(new Error(this.error));}return error;}
  enqueue(operation){const work=this.queue.then(()=>{if(this.disposed)throw new Error('Terminal screen was released.');return operation();});this.queue=work.catch(()=>{});return work;}
  write(bytes){
    if(this.pendingBytes+bytes.length>4*1024*1024)throw this.fault(new Error('Terminal parser backlog exceeds its 4 MiB limit; session is stopping.'));
    this.pendingBytes+=bytes.length;
    return this.enqueue(()=>new Promise(resolve=>this.terminal.write(bytes,()=>{this.revision++;resolve();}))).finally(()=>{this.pendingBytes-=bytes.length;});
  }
  resize(cols,rows,apply=async()=>{}) {terminalSize(cols,rows);return this.enqueue(async()=>{await apply();this.terminal.resize(cols,rows);this.revision++;});}
  transition(state,result={}){if(this.state!==state||Object.keys(result).length){this.state=state;Object.assign(this,result);this.revision++;}}
  async drain(){await this.queue;}
  snapshot(after) {return this.enqueue(()=>{
    let screen;if(after!==this.revision){screen=this.serializer.serialize();if(Buffer.byteLength(JSON.stringify({screen}))>3000000-32768){this.fault(new Error('Terminal screen exceeds its 3 MB representation limit; session is stopping.'));screen='Terminal screen exceeded its representation limit. Session stopping; earlier output cannot be represented.';}}
    return {...this.metadata(),...(screen!==undefined?{screen}:{})};
  });}
  dispose(){if(this.disposed)return;this.disposed=true;this.terminal.dispose();}
}
