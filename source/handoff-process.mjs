import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

const noncePattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bootPattern=/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
export function verifyHandoffProcessIdentity(value,{pid,uid,bootSession}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='bootSession,pgid,pid,startSec,startUsec,uid,version'||value.version!==1||!Number.isSafeInteger(value.pid)||value.pid<=1||value.pid>2147483647||!Number.isSafeInteger(value.pgid)||value.pgid<1||value.pgid>2147483647||!Number.isSafeInteger(value.uid)||value.uid<0||value.uid>4294967295||typeof value.startSec!=='string'||value.startSec.length>20||!/^[1-9][0-9]*$/.test(value.startSec)||BigInt(value.startSec).toString()!==value.startSec||BigInt(value.startSec)>18446744073709551615n||!Number.isSafeInteger(value.startUsec)||value.startUsec<0||value.startUsec>=1000000||typeof value.bootSession!=='string'||value.bootSession.length!==36||!bootPattern.test(value.bootSession)||(pid!==undefined&&value.pid!==pid)||(uid!==undefined&&value.uid!==uid)||(bootSession!==undefined&&value.bootSession!==bootSession))throw new Error('Invalid handoff process identity.');
  return Object.freeze({...value});
}
export function verifyHandoffProcessReceipt(value,{nonce,pid}){
  if(typeof nonce!=='string'||nonce.length!==36||!noncePattern.test(nonce)||!Number.isSafeInteger(pid)||pid<=1||pid>2147483647||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='bootSession,nonce,pgid,pid,startSec,startUsec,uid,version'||value.nonce!==nonce||value.pgid!==pid)throw new Error('Invalid handoff process identity receipt.');
  const {nonce:ignored,...identity}=value;verifyHandoffProcessIdentity(identity,{pid,uid:process.getuid()});
  return Object.freeze({...value});
}
export async function verifyHandoffHelper(path,expectedIdentity=null){
  if(typeof path!=='string'||!isAbsolute(path)||await realpath(path)!==path)throw new Error('Native handoff process helper must be canonical and absolute.');
  const info=await lstat(path,{bigint:true}),identity={dev:String(info.dev),ino:String(info.ino)};
  if(!info.isFile()||![0n,BigInt(process.getuid())].includes(info.uid)||(info.mode&0o022n)||!(info.mode&0o111n))throw new Error('Native handoff process helper has unsafe identity or permissions.');
  if(expectedIdentity&&(expectedIdentity.dev!==identity.dev||expectedIdentity.ino!==identity.ino))throw new Error('Native handoff process helper changed.');
  if(await realpath(path)!==path)throw new Error('Native handoff process helper changed.');
  return identity;
}
export async function releaseHandoffProcess(child,nonce,{record,check=()=>{},abort}={}){
  const receiptStream=child?.stdio?.[3],releaseStream=child?.stdio?.[4];
  if(typeof nonce!=='string'||nonce.length!==36||!noncePattern.test(nonce)||!Number.isSafeInteger(child?.pid)||child.pid<=1||child.pid>2147483647||typeof record!=='function'||typeof check!=='function'||(abort!==undefined&&typeof abort?.then!=='function')||!receiptStream?.on||!releaseStream?.end||receiptStream.readableEnded||receiptStream.destroyed)throw new Error('Invalid handoff process gate.');
  let rejectDeath,resolveReceipt,rejectReceipt,ended=false,dead=false,released=false,finished=false,bytes=0;const chunks=[];
  const death=new Promise((_,reject)=>{rejectDeath=reject;}),receipt=new Promise((resolve,reject)=>{resolveReceipt=resolve;rejectReceipt=reject;});
  void death.catch(()=>{});void receipt.catch(()=>{});
  const failed=error=>{dead=true;rejectDeath(error instanceof Error?error:new Error('Handoff process exited before its durable release.'));};
  const exited=()=>failed(new Error('Handoff process exited before its durable release.'));
  const data=chunk=>{bytes+=chunk.length;if(bytes>4096){failed(new Error('Handoff process identity receipt exceeds 4096 bytes.'));return;}chunks.push(Buffer.from(chunk));};
  const end=()=>{ended=true;try{const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1)throw new Error('Invalid handoff process receipt framing.');const value=verifyHandoffProcessReceipt(JSON.parse(raw),{nonce,pid:child.pid});if((raw.match(/"(?:[^"\\]|\\.)*"\s*:/g)??[]).length!==Object.keys(value).length)throw new Error('Duplicate handoff process receipt keys.');resolveReceipt(value);}catch(error){rejectReceipt(error);}};
  const closed=()=>{if(!ended)failed(new Error('Handoff process receipt closed before EOF.'));};
  const alive=()=>{check();if(dead||child.exitCode!=null||child.signalCode!=null||child.killed)throw new Error('Handoff process is no longer awaiting durable release.');};
  child.on('error',failed);child.on('exit',exited);child.on('close',exited);
  receiptStream.on('data',data);receiptStream.once('end',end);receiptStream.on('error',failed);receiptStream.once('close',closed);releaseStream.on('error',failed);
  const aborted=error=>{if(finished)return;releaseStream.destroy();failed(error instanceof Error?error:new Error('Handoff process release aborted.'));};
  if(abort)void Promise.resolve(abort).then(aborted,aborted);
  try{
    alive();const value=await Promise.race([receipt,death]);alive();
    // The losing callback remains observed if Stop or process exit wins this race.
    await Promise.race([Promise.resolve().then(()=>record(value)),death]);alive();
    await Promise.race([new Promise((resolve,reject)=>releaseStream.end(nonce+'\n',error=>error?reject(error):resolve())),death]);
    released=true;return value;
  }finally{
    finished=true;
    child.removeListener('error',failed);child.removeListener('exit',exited);child.removeListener('close',exited);
    receiptStream.removeListener('data',data);receiptStream.removeListener('end',end);receiptStream.removeListener('close',closed);
    receiptStream.removeListener('error',failed);releaseStream.removeListener('error',failed);
    // Closing a rejected gate must not leave the native child waiting for bytes.
    receiptStream.on('error',()=>{});releaseStream.on('error',()=>{});if(!released)releaseStream.destroy();
  }
}
