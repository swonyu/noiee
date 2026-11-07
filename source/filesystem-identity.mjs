import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,normalize} from 'node:path';
import {spawn} from 'node:child_process';
import {verifyHandoffHelper} from './handoff-process.mjs';

const uuid=/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
export const isFilesystemIdentity=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='ino,volumeUUID'&&typeof value.volumeUUID==='string'&&uuid.test(value.volumeUUID)&&value.volumeUUID!=='00000000-0000-0000-0000-000000000000'&&typeof value.ino==='string'&&/^[1-9][0-9]{0,19}$/.test(value.ino)&&BigInt(value.ino)<=18446744073709551615n;
export const sameFilesystemIdentity=(a,b)=>isFilesystemIdentity(a)&&isFilesystemIdentity(b)&&a.volumeUUID===b.volumeUUID&&a.ino===b.ino;
// APFS directory link counts change with child entries; file link counts stay exact.
const same=(a,b)=>['dev','ino','mode','uid'].every(key=>a[key]===b[key])&&a.nlink>0n&&b.nlink>0n&&(a.isDirectory()||a.nlink===b.nlink);
const check=signal=>{if(signal?.aborted)throw Error('Filesystem identity inspection cancelled.');};

// Persistent identity is separate from the strict live descriptor/namespace pin.
export async function readFilesystemIdentity({path,nativeHelper,signal}={}){
 check(signal);
 if(typeof path!=='string'||!isAbsolute(path)||normalize(path)!==path||path.includes('\0')||path.length>4096||await realpath(path)!==path)throw Error('Filesystem identity path is not canonical.');
 const helper=await verifyHandoffHelper(nativeHelper),before=await lstat(path,{bigint:true});check(signal);
 if((!before.isFile()&&!before.isDirectory())||before.isSymbolicLink())throw Error('Filesystem identity requires a regular file or directory.');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  if(!same(before,await file.stat({bigint:true})))throw Error('Filesystem identity changed while opening.');check(signal);
  const child=spawn(nativeHelper,['--handoff-process','filesystem-identity'],{stdio:['ignore','pipe','pipe',file.fd]});
  let failure,bytes=0;const chunks=[];
  const fail=error=>{failure??=error;child.kill('SIGKILL');},abort=()=>fail(Error('Filesystem identity inspection cancelled.'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>fail(Error('Filesystem identity inspection timed out.')),5000);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail(Error('Filesystem identity receipt exceeds its bound.'));else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail(Error('Filesystem identity receipt exceeds its bound.'));});
  child.once('error',error=>{failure??=error;});child.stdout.on('error',fail);child.stderr.on('error',fail);
  let value;
  try{
   const {code,termination}=await new Promise(resolve=>child.once('close',(code,termination)=>resolve({code,termination})));
   check(signal);if(failure)throw failure;if(code!==0||termination)throw Error('Native filesystem identity inspection failed.');
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   if(!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1||(raw.match(/"(?:[^"\\]|\\.)*"\s*:/g)??[]).length!==2)throw Error('Invalid filesystem identity receipt framing.');
   value=JSON.parse(raw);if(!isFilesystemIdentity(value)||value.ino!==String(before.ino))throw Error('Invalid filesystem identity receipt.');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  await verifyHandoffHelper(nativeHelper,helper);check(signal);
  if(!same(before,await file.stat({bigint:true}))||!same(before,await lstat(path,{bigint:true}))||await realpath(path)!==path)throw Error('Filesystem identity changed during inspection.');
  return Object.freeze({...value});
 }finally{await file.close();}
}

// One fresh bounded inspection of held descriptors; no identity is cached.
export async function readFilesystemIdentities({paths,nativeHelper,signal}={}){
 check(signal);
 if(!Array.isArray(paths)||paths.length<1||paths.length>32||new Set(paths).size!==paths.length)throw Error('Filesystem identity batch requires 1 to 32 distinct paths.');
 paths=[...paths];
 const held=[];let helper;
 try{
  for(const path of paths){
   check(signal);
   if(typeof path!=='string'||!isAbsolute(path)||normalize(path)!==path||path.includes('\0')||path.length>4096||await realpath(path)!==path)throw Error('Filesystem identity path is not canonical.');
   helper=await verifyHandoffHelper(nativeHelper,helper);const before=await lstat(path,{bigint:true});check(signal);
   if((!before.isFile()&&!before.isDirectory())||before.isSymbolicLink())throw Error('Filesystem identity requires a regular file or directory.');
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);held.push({path,before,file});
   if(!same(before,await file.stat({bigint:true})))throw Error('Filesystem identity changed while opening.');check(signal);
  }
  const child=spawn(nativeHelper,['--handoff-process','filesystem-identities',String(paths.length)],{stdio:['ignore','pipe','pipe',...held.map(({file})=>file.fd)]});
  let failure,bytes=0;const chunks=[];
  const fail=error=>{failure??=error;child.kill('SIGKILL');},abort=()=>fail(Error('Filesystem identity inspection cancelled.'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>fail(Error('Filesystem identity inspection timed out.')),5000);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail(Error('Filesystem identity receipt exceeds its bound.'));else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail(Error('Filesystem identity receipt exceeds its bound.'));});
  child.once('error',error=>{failure??=error;});child.stdout.on('error',fail);child.stderr.on('error',fail);
  let values;
  try{
   const {code,termination}=await new Promise(resolve=>child.once('close',(code,termination)=>resolve({code,termination})));
   check(signal);if(failure)throw failure;if(code!==0||termination)throw Error('Native filesystem identity inspection failed.');
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   if(!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1||(raw.match(/"(?:[^"\\]|\\.)*"\s*:/g)??[]).length!==2*paths.length+1)throw Error('Invalid filesystem identity receipt framing.');
   const value=JSON.parse(raw);
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='identities'||!Array.isArray(value.identities)||value.identities.length!==paths.length||!value.identities.every((row,index)=>isFilesystemIdentity(row)&&row.ino===String(held[index].before.ino)))throw Error('Invalid filesystem identity receipt.');
   values=value.identities;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  for(const {path,before,file} of held){
   await verifyHandoffHelper(nativeHelper,helper);check(signal);
   if(!same(before,await file.stat({bigint:true}))||!same(before,await lstat(path,{bigint:true}))||await realpath(path)!==path)throw Error('Filesystem identity changed during inspection.');
  }
  return Object.freeze(values.map(value=>Object.freeze({...value})));
 }finally{
  const closed=await Promise.allSettled(held.map(({file})=>file.close())),failure=closed.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
 }
}
