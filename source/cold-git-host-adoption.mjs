// Exact reviewed resource; a request or an arbitrary file on disk is not authority.
import {isFilesystemIdentity} from './filesystem-identity.mjs';
export const COLD_GIT_ADOPTION_SHA256="aa201b6e538e241fe4db8834015c41426780868c645f51599cee1d2e926c5ff8";
export const COLD_GIT_ADOPTION_RESOURCE='cold-git-host-adoption.json';
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('Invalid cold Git host adoption shape.');};
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(v)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
const raw=v=>{shape(v,['dev','ino','mode','uid']);if(!['dev','ino'].every(k=>typeof v[k]==='string'&&/^[1-9][0-9]{0,19}$/.test(v[k]))||v.mode!==0o40700||!Number.isSafeInteger(v.uid)||v.uid<0)throw Error('Invalid cold host raw identity.');};
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const runtime='/Users/saleh/Library/Application Support/Saleh Uncensored Runtime/Executors';
const fixed=[
 ['0dd0958d-51a4-4b72-8dc2-d23bbb0ba591','2ce7917d-cb2a-4634-958c-96a2199495ae','saleh-build43-native-no1udx1j','31555315','c258ebde9bc309dfdd84988c783a35b360252df5a8db2d101a2e0a7d2de5b315','16777233'],
 ['3475d914-e443-462e-8700-72a5ad4ab48c','ce986b3b-a937-4921-984b-1261f982869b','saleh-coding-pilot-0jbfhiqn','32536734','3bca538c4de1a0921a71ffae0e62bc84d8c460521e85401bec704b1e0b044a0a','16777233'],
 ['9b36bd26-88cc-4568-9cb4-6cd15146969b','a8de1d3c-5e4e-4b4e-8eef-8f0dd05c5520','saleh-coding-pilot57-smqzqo89','32857601','fbaf7b5b92751ca036b6fdd460c5c5afeae39d00cf0759aa1e26f2946a8858ae','16777233'],
 ['76abfabc-4ad0-425b-9f11-4cd248f8ad64','f847a1ad-60b4-4b9f-a074-961d25b9ef1d','saleh-coding-pilot69-z_ltbc4i','34909467','1e69c09e1dbf936221d70be4862bf03945eca5cb1641e4e81e9e9ab50648806f','16777230']
];
// Enabled fixed-owner adoption always requires stable identity, even if a later
// boot reuses the old raw device number. Other owners retain the existing path.
export const coldGitAdoptionRequired=ownerId=>digest(COLD_GIT_ADOPTION_SHA256)&&fixed.some(row=>row[0]===ownerId);
// Validation is not authentication. Only the branded legacy verifier may load
// this document from its fixed, freshly authenticated successor resource.
export function validateColdGitAdoption(value,proof){
 shape(value,['version','kind','historicalHostUUIDEstablished','captureBootSession','dataDirectory','evidence','rows']);
 if(value.version!==1||value.kind!=='reviewed-current-host-adoption-for-cold-git-exclusion'||value.historicalHostUUIDEstablished!==false||!uuid(value.captureBootSession)||!uuid(proof?.owner?.bootSession)||proof?.version!==3)throw Error('Cold Git adoption authority or boot evidence is invalid.');
 shape(value.dataDirectory,['path','volumeUUID','ino','uid']);
 if(value.dataDirectory.path!=='/Users/saleh/Library/Application Support/Qwen Local/Coding'||!isFilesystemIdentity({volumeUUID:value.dataDirectory.volumeUUID,ino:value.dataDirectory.ino})||!Number.isSafeInteger(value.dataDirectory.uid)||value.dataDirectory.uid!==proof.owner.uid||!['path','volumeUUID','ino','uid'].every(k=>value.dataDirectory[k]===proof.dataDirectory[k]))throw Error('Cold Git adoption catalog identity differs.');
 shape(value.evidence,['stoppedSnapshotSHA256','hostObservationSHA256','reviewSHA256','predecessorSourceManifestSHA256']);
 if(!Object.values(value.evidence).every(digest)||!Array.isArray(value.rows)||value.rows.length!==fixed.length)throw Error('Cold Git adoption evidence or exact scope differs.');
 for(let i=0;i<fixed.length;i++){
  const row=value.rows[i],[ownerId,generation,name,ino,allocationSHA256,historicalDev]=fixed[i];
  shape(row,['ownerId','generation','cwd','allocationDirectory','allocationSHA256','historicalHostIdentity','currentHostIdentity']);shape(row.allocationDirectory,['path','identity']);
  if(row.ownerId!==ownerId||row.generation!==generation||row.cwd!=='/Users/saleh/Library/Caches/'+name||row.allocationDirectory.path!==runtime+'/'+ownerId+'-'+generation||row.allocationSHA256!==allocationSHA256||!isFilesystemIdentity(row.allocationDirectory.identity))throw Error('Cold Git adoption exceeds the exact reviewed allocation scope.');
  raw(row.historicalHostIdentity);shape(row.currentHostIdentity,['dev','volumeUUID','ino','mode','uid']);
  const {volumeUUID,...current}=row.currentHostIdentity;raw(current);
  if(!isFilesystemIdentity({volumeUUID,ino:current.ino})||row.historicalHostIdentity.dev!==historicalDev||row.historicalHostIdentity.ino!==ino||row.historicalHostIdentity.uid!==501||current.uid!==value.dataDirectory.uid||current.dev===row.historicalHostIdentity.dev||!['ino','mode','uid'].every(k=>current[k]===row.historicalHostIdentity[k]))throw Error('Cold Git adoption is not the exact reviewed dev-only host case.');
 }
 return freeze(structuredClone(value));
}
export function coldGitHostEntry(document,input){
 shape(input,['ownerId','generation','cwd','allocationDirectory','allocationSHA256','historicalHostIdentity']);shape(input.allocationDirectory,['path','identity']);raw(input.historicalHostIdentity);
 const row=document.rows.find(r=>r.ownerId===input.ownerId&&r.generation===input.generation);
 if(!row||row.cwd!==input.cwd||row.allocationSHA256!==input.allocationSHA256||row.allocationDirectory.path!==input.allocationDirectory.path||!isFilesystemIdentity(input.allocationDirectory.identity)||!['volumeUUID','ino'].every(k=>row.allocationDirectory.identity[k]===input.allocationDirectory.identity[k])||!['dev','ino','mode','uid'].every(k=>row.historicalHostIdentity[k]===input.historicalHostIdentity[k]))throw Error('Cold Git adoption does not bind this allocation and host.');
 return row;
}
