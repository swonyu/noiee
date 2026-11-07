import {createHash} from 'node:crypto';

const NAME='com.apple.decmpfs',FILE=32*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const require=(ok,message)=>{if(!ok)throw Error('Invalid native storage metadata: '+message);};
const keys=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
// Only the observed dataless representation is supported. Its tail is opaque,
// bound to the original inode, and never replayed onto an independent copy.
export function storageValues(row){
  require(object(row)&&object(row.xattrs)&&!Object.hasOwn(row.xattrs,NAME),'managed payload in ordinary xattrs');
  require(row.kind!=='file'||!(row.flags&0x20),'compressed files are unsupported');
  if(!Object.hasOwn(row,'storageXattrs'))return [];
  require(row.kind==='file'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=FILE&&Number.isSafeInteger(row.flags)&&row.flags>=0&&row.flags<=0xffffffff,'storage requires a bounded regular file');
  require(keys(row.storageXattrs,[NAME]),'storage attribute namespace');const value=row.storageXattrs[NAME];
  require(keys(value,['bytes','sha256','rawBase64'])&&Number.isSafeInteger(value.bytes)&&value.bytes>=16&&value.bytes<=FILE&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&typeof value.rawBase64==='string'&&value.rawBase64.length<=Math.ceil(FILE/3)*4,'storage declaration');
  const bytes=Buffer.from(value.rawBase64,'base64');
  require(bytes.length===value.bytes&&bytes.toString('base64')===value.rawBase64&&createHash('sha256').update(bytes).digest('hex')===value.sha256,'storage bytes or digest');
  require(bytes.readUInt32LE(0)===0x636d7066&&bytes.readUInt32LE(4)===0x80000001&&bytes.readBigUInt64LE(8)===BigInt(row.bytes),'unsupported dataless header');
  return [value];
}
export function nativeByteSizes(row){
  return [row.kind==='file'?row.bytes:row.kind==='symlink'?Buffer.from(row.targetBase64,'base64').length:0,...Object.values(row.xattrs).map(value=>value.bytes),...storageValues(row).map(value=>value.bytes)];
}
export function independentCopyContent(row){
  storageValues(row);
  return Object.fromEntries(Object.entries(row).filter(([key])=>!['identity','ctime','storageXattrs',...(row.kind==='directory'?['nlink']:[])].includes(key)));
}
