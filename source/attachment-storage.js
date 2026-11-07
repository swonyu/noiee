// Image bytes commit first; localStorage remains the synchronous metadata commit.
(() => {
  'use strict';
  const attachments=globalThis.SalehAttachments,known=new Map(),loaded=new Map(),limit=256*1024*1024;
  let opening,pending=0,invalidated=false;
  const available=()=>{if(invalidated)throw Error('Image storage changed in another window. Reload before saving.');};
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  function database(){
    available();
    if(!opening)opening=new Promise((resolve,reject)=>{
      const request=indexedDB.open('saleh-image-assets-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('images');
      request.onerror=()=>reject(request.error||Error('Image storage could not be opened.'));
      request.onblocked=()=>reject(Error('Image storage is busy in another window. Close that window and retry.'));
      request.onsuccess=()=>{const db=request.result;const invalidate=()=>{invalidated=true;known.clear();loaded.clear();};db.onclose=invalidate;db.onversionchange=()=>{invalidate();db.close();};resolve(db);};
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function asset(key,value){
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('images',value===undefined?'readonly':'readwrite'),store=tx.objectStore('images'),request=store.get(key);let result,failure;
      request.onsuccess=()=>{result=request.result;if(value!==undefined){if(result!==undefined&&result!==value){failure=Error('Stored image differs from its content key.');tx.abort();}else if(result===undefined)store.add(value,key);}};
      tx.oncomplete=()=>{try{available();resolve(value===undefined?result:value);}catch(error){reject(error);}};
      tx.onerror=()=>{};
      tx.onabort=()=>reject(failure||tx.error||Error('Image storage transaction did not complete.'));
    });
  }
  async function prepare(files){
    available();
    const images=attachments.normalize(files).filter(f=>f.kind==='image');pending++;
    try{for(const file of images){if(known.has(file.dataURL))continue;const key=await digest(file.dataURL);await asset(key,file.dataURL);available();known.set(file.dataURL,key);loaded.set(key,file.dataURL);}}
    finally{pending--;}
  }
  function groups(value,kind){
    if(kind==='coding')return Object.values(value?.attachmentDrafts??{});
    if(kind!=='chat')throw Error('Unknown image storage scope.');
    return (Array.isArray(value?.chats)?value.chats:[]).flatMap(c=>[c?.draftAttachments,...(Array.isArray(c?.messages)?c.messages.map(m=>m?.attachments):[])]);
  }
  const isRef=file=>file&&typeof file==='object'&&Object.hasOwn(file,'dataRef');
  function reference(file){
    if(!exact(file,['kind','name','dataRef'])||file.kind!=='image'||typeof file.dataRef!=='string'||! /^[a-f0-9]{64}$/.test(file.dataRef))throw Error('Saved image reference is invalid.');
    return file.dataRef;
  }
  function transform(value,kind,convert){
    const files=rows=>Array.isArray(rows)?rows.map(file=>convert(file,rows)):rows;
    if(kind==='coding')return {...value,...(value?.attachmentDrafts&&typeof value.attachmentDrafts==='object'&&!Array.isArray(value.attachmentDrafts)?{attachmentDrafts:Object.fromEntries(Object.entries(value.attachmentDrafts).map(([id,rows])=>[id,files(rows)]))}:{})};
    if(!Array.isArray(value?.chats))return value;
    return {...value,chats:value.chats.map(c=>c&&typeof c==='object'?{...c,...(Object.hasOwn(c,'draftAttachments')?{draftAttachments:files(c.draftAttachments)}:{}),...(Array.isArray(c.messages)?{messages:c.messages.map(m=>m&&typeof m==='object'&&Object.hasOwn(m,'attachments')?{...m,attachments:files(m.attachments)}:m)}:{})}:c)};
  }
  function hasRefs(value,kind){return groups(value,kind).some(rows=>Array.isArray(rows)&&rows.some(isRef));}
  async function hydrate(value,kind){
    available();
    pending++;
    try{
      let bytes=0;
      for(const rows of groups(value,kind))if(Array.isArray(rows))for(const file of rows){
        let url=file?.dataURL;
        if(isRef(file)){
          const key=reference(file);url=loaded.get(key);
          if(url===undefined){url=await asset(key);if(typeof url!=='string'||url.length>4*1024*1024||await digest(url)!==key)throw Error('Saved image data is missing or changed. Stored drafts were kept.');
            attachments.normalize([{kind:'image',name:file.name,dataURL:url}]);await attachments.decodeImage(url);available();loaded.set(key,url);known.set(url,key);}
        }
        if(typeof url==='string'){bytes+=url.length;if(bytes>limit)throw Error('Saved images exceed the 256 MB recovery limit. Stored contents were kept.');}
      }
      const hydrated=transform(value,kind,file=>isRef(file)?{kind:'image',name:file.name,dataURL:loaded.get(reference(file))}:file);
      const original=groups(value,kind),resolved=groups(hydrated,kind);
      original.forEach((rows,index)=>{if(Array.isArray(rows)&&rows.some(isRef))attachments.normalize(resolved[index]);});
      return hydrated;
    }finally{pending--;}
  }
  function serialize(value,kind){
    available();let expansion=0;const validity=new WeakMap();
    const projected=transform(value,kind,(file,rows)=>{
      if(!validity.has(rows)){try{attachments.normalize(rows);validity.set(rows,true);}catch{validity.set(rows,false);}}
      if(!validity.get(rows))return file; // Preserve invalid legacy Coding drafts exactly.
      if(isRef(file))throw Error('Saved images must be loaded before saving.');
      if(file?.kind==='image'&&typeof file.dataURL==='string'){
        const key=known.get(file.dataURL);
        if(key&&exact(file,['kind','name','dataURL'])){const ref={kind:'image',name:file.name,dataRef:key};expansion+=file.dataURL.length-key.length;return ref;}
      }
      return file; // Legacy inline data stays intact until explicitly imported again.
    });
    const serialized=JSON.stringify(projected),portable=kind==='chat'?JSON.stringify({exportedAt:'2000-01-01T00:00:00.000Z',chats:projected.chats}):serialized;
    if(new TextEncoder().encode(portable).length+expansion>limit)throw Error('History exceeds the 256 MB portable recovery limit.');
    return serialized;
  }
  // ponytail: retain unreferenced assets; deletion needs verified cross-chat reference accounting.
  globalThis.SalehAttachmentStorage={prepare,serialize,hydrate,hasRefs,get busy(){return pending>0;}};
})();
