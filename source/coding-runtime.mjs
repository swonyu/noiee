import {open,realpath,stat,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const contract=Object.freeze(JSON.parse(await readFile(new URL('./coding-runtime-contract.json',import.meta.url),'utf8')));
const unsupported=()=>Object.assign(new Error('This installed Codex runtime is not supported by this Noiee build. Update Noiee to a build qualified for this Codex version before using Tasks. Saved projects and history have been preserved.'),{code:'CODING_RUNTIME_UNSUPPORTED'});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
async function identify(path,expected) {
  const canonical=await realpath(path),handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.size!==BigInt(expected.size))throw unsupported();
    const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
    const after=await handle.stat({bigint:true}),atPath=await stat(canonical,{bigint:true});
    if(!same(before,after)||!same(after,atPath)||hash.digest('hex')!==expected.sha256)throw unsupported();
    return {canonical,identity:after};
  } finally {await handle.close();}
}
// The production auto-discovery path verifies bytes before executing --version.
// Explicit constructor binaries remain a trusted host/fixture injection only.
export async function verifyCodingRuntime(path,{expected=contract,readVersion=async binary=>(await execute(binary,['--version'],{timeout:5000,maxBuffer:4096})).stdout}={}) {
  if(expected?.version!==1||typeof expected.cliVersion!=='string'||!Number.isSafeInteger(expected.binary?.size)||expected.binary.size<1||!/^[a-f0-9]{64}$/.test(expected.binary.sha256))throw unsupported();
  let before;
  try {
    before=await identify(path,expected.binary);
    const version=await readVersion(before.canonical);
    if(typeof version!=='string'||version.trim()!==expected.cliVersion)throw unsupported();
    const after=await stat(before.canonical,{bigint:true});
    if(!same(before.identity,after)||await realpath(path)!==before.canonical)throw unsupported();
  } catch {throw unsupported();}
  return Object.freeze({path:before.canonical,cliVersion:expected.cliVersion,sha256:expected.binary.sha256,protocolRevision:expected.protocol?.revision});
}
export function verifyCodingInitialization(response,dataDir) {
  if(!response||response.codexHome!==dataDir||response.platformFamily!=='unix'||response.platformOs!=='macos'||typeof response.userAgent!=='string'||!response.userAgent.trim()||response.userAgent.length>1024)throw Object.assign(new Error('The Codex app-server initialization did not match the supported local Tasks protocol. Saved projects and history have been preserved.'),{code:'CODING_PROTOCOL_UNSUPPORTED'});
}
export const codingRuntimeContract=contract;
