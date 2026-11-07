// Chat snapshots use their own database; legacy bytes and image assets stay untouched.
(() => {
  'use strict';
  const KEY='qwen-local-chats-v1',DB='saleh-chat-snapshots-v1',STORE='snapshots',LIMIT=256*1024*1024;
  const fields=['version','state','revision','commitId','hash','payload','legacyHash'],hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  let opening,head,legacy,legacyHash,bound=false,loaded=false,blocked=null,recovery=null,queue=Promise.resolve();
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const same=(a,b)=>b===undefined?a===undefined:exact(a,fields)&&fields.every(k=>a[k]===b[k]);
  const conflict=message=>blocked=Object.assign(Error(message),{code:'conflict'});
  const available=()=>{if(blocked)throw blocked;};
  function unchanged(){available();if(bound&&localStorage.getItem(KEY)!==legacy)throw conflict('Legacy chat storage changed in another window. Export and reload before saving.');}
  function ready(){unchanged();if(!loaded)throw Error('Chat storage has not finished loading.');}
  async function bindLegacy(){
    available();if(!bound){legacy=localStorage.getItem(KEY);bound=true;}unchanged();
    if(legacyHash===undefined)legacyHash=legacy===null?null:await digest(legacy);unchanged();
  }
  const identityOf=record=>({revision:record?.revision??0,commitId:record?.commitId??null});
  const matches=(pinned,record)=>pinned.revision===(record?.revision??0)&&pinned.commitId===(record?.commitId??null);
  function pin(expected){
    if(!exact(expected,['revision','commitId'])||!Number.isSafeInteger(expected.revision)||expected.revision<0||(expected.revision===0?expected.commitId!==null:typeof expected.commitId!=='string'||!uuid.test(expected.commitId)))throw Error('Expected chat snapshot identity is invalid.');
    return {revision:expected.revision,commitId:expected.commitId};
  }
  function enqueue(operation){const result=queue.then(operation);queue=result.catch(()=>{});return result;}
  async function digest(payload){
    if(typeof payload!=='string')throw Error('Chat snapshot must be a serialized string.');
    if(payload.length>LIMIT)throw Error('Chat history exceeds the 256 MB recovery limit.');
    const bytes=new TextEncoder().encode(payload);if(bytes.length>LIMIT)throw Error('Chat history exceeds the 256 MB recovery limit.');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  }
  function database(){
    unchanged();
    if(!opening)opening=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB,1);let failed=false;
      const fail=error=>{failed=true;reject(error);};
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
      request.onerror=()=>fail(request.error||Error('Chat storage could not be opened.'));
      request.onblocked=()=>fail(Error('Chat storage is busy in another window. Close that window and retry.'));
      request.onsuccess=()=>{const db=request.result;if(failed){db.close();return;}const invalidate=()=>conflict('Chat storage changed in another window. Export and reload before saving.');db.onclose=invalidate;db.onversionchange=()=>{invalidate();db.close();};resolve(db);};
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function snapshot(expected,next,preservePrevious=false){
    const compare=arguments.length>0,db=await database();unchanged();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,next===undefined?'readonly':'readwrite'),store=tx.objectStore(STORE),request=store.get('head');let result,failure;
      request.onsuccess=()=>{
        try{
          unchanged();result=request.result;
          if(compare&&!same(result,expected))throw conflict('Chat snapshot changed in another window. Export and reload before saving.');
          if(next!==undefined){if(preservePrevious&&expected!==undefined)store.add(expected,'previous:'+next.commitId);store.put(next,'head');result=next;}
        }catch(error){failure=error;tx.abort();}
      };
      tx.oncomplete=()=>{try{unchanged();resolve(result);}catch(error){reject(error);}};
      tx.onerror=()=>{};
      tx.onabort=()=>reject(failure||tx.error||Error('Chat storage transaction did not complete.'));
    });
  }
  async function validate(record){
    if(!exact(record,fields)||record.version!==1||!['pending','authoritative'].includes(record.state)||!Number.isSafeInteger(record.revision)||record.revision<1||typeof record.commitId!=='string'||!uuid.test(record.commitId)||typeof record.hash!=='string'||!hex.test(record.hash)||(record.legacyHash!==null&&(typeof record.legacyHash!=='string'||!hex.test(record.legacyHash))))throw Error('Stored chat snapshot is invalid. Export was kept available.');
    if(record.legacyHash!==legacyHash)throw conflict('Legacy chat source differs from the stored snapshot. Export and reload before saving.');
    if(await digest(record.payload)!==record.hash)throw Error('Stored chat snapshot failed its content hash. History was kept.');
    if(record.revision===1&&record.legacyHash!==null&&(record.hash!==record.legacyHash||record.payload!==legacy))throw Error('First chat migration differs from its original legacy source. Both sources were kept.');
    if(record.state==='pending'&&(record.revision!==1||record.legacyHash===null))throw Error('Pending chat migration is invalid. Both sources were kept.');
  }
  function load(verify){
    return enqueue(async()=>{
      available();if(typeof verify!=='function')throw Error('Chat history must be verified before it is loaded.');
      if(loaded){await snapshot(head);if(head!==undefined)await verify(head.payload);await snapshot(head);return head?.payload??null;}
      await bindLegacy();
      const record=await snapshot();
      if(record!==undefined){
        await validate(record);
        if(record.state==='pending')throw Object.assign(Error('A pending chat migration needs explicit recovery. Both sources were kept.'),{code:'pending'});
        await verify(record.payload);await snapshot(record);head=record;loaded=true;return head.payload;
      }
      if(legacy===null){await snapshot(undefined);head=undefined;loaded=true;return null;}
      await verify(legacy);unchanged();
      const pending={version:1,state:'pending',revision:1,commitId:crypto.randomUUID(),hash:legacyHash,payload:legacy,legacyHash};
      await snapshot(undefined,pending);
      const readback=await snapshot(pending);await validate(readback);await verify(readback.payload);unchanged();
      head=await snapshot(pending,{...pending,state:'authoritative'});loaded=true;return head.payload;
    });
  }
  function commit(payload,{preservePrevious=false,expected}={}){
    let pinned;
    try{
      if(typeof preservePrevious!=='boolean')throw Error('Recovery predecessor choice is invalid.');
      if(expected!==undefined)pinned=pin(expected);
    }catch(error){return Promise.reject(error);}
    return enqueue(async()=>{
      ready();
      if(pinned&&!matches(pinned,head))throw Object.assign(Error('Recovery destination changed after it was selected. Select it again before restoring.'),{code:'conflict'});
      const hash=await digest(payload),revision=(head?.revision??0)+1;
      if(!Number.isSafeInteger(revision))throw Error('Chat snapshot revision limit was reached. Export history before continuing.');
      const next={version:1,state:'authoritative',revision,commitId:crypto.randomUUID(),hash,payload,legacyHash};
      head=await snapshot(head,next,preservePrevious);
    });
  }
  function recoveryBase(){
    return enqueue(async()=>{
      await bindLegacy();
      const record=loaded?await snapshot(head):recovery?await snapshot(recovery.head):await snapshot();
      if(record!==undefined)await validate(record);
      else if(legacy!==null)throw Error('Legacy chat history must finish verified migration before recovery. Both sources were kept.');
      await snapshot(record);recovery={head:record};return {payload:record?.payload??null,identity:identityOf(record)};
    });
  }
  function recover(payload,expected,verify){
    let pinned;try{pinned=pin(expected);if(typeof verify!=='function')throw Error('Recovered history must be verified before saving.');}catch(error){return Promise.reject(error);}
    return enqueue(async()=>{
      await bindLegacy();if(!recovery)throw Error('Select and verify the recovery destination before restoring.');
      const base=recovery.head;
      if(!matches(pinned,base))throw Object.assign(Error('Recovery destination changed after it was selected. Select it again before restoring.'),{code:'conflict'});
      await snapshot(base);
      const hash=await digest(payload),revision=(base?.revision??0)+1;
      if(!Number.isSafeInteger(revision))throw Error('Chat snapshot revision limit was reached. Export history before continuing.');
      await verify(payload,base?.payload??null);unchanged();
      const next={version:1,state:'authoritative',revision,commitId:crypto.randomUUID(),hash,payload,legacyHash};
      head=await snapshot(base,next,true);loaded=true;recovery=null;
    });
  }
  function check(){return enqueue(async()=>{ready();await snapshot(head);});}
  addEventListener('storage',event=>{if(bound&&event.storageArea===localStorage&&(event.key===KEY||event.key===null)){try{if(event.key===null?legacy!==null:event.oldValue!==legacy||event.newValue!==legacy)throw conflict('Legacy chat storage was changed by another window. Export and reload before saving.');unchanged();}catch{}}});
  globalThis.SalehChatStorage={load,commit,check,recoveryBase,recover,get identity(){return loaded?identityOf(head):null;}};
})();
