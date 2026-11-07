// Shared browser/backend boundary. Snapshots contain data, never paths or grants.
(() => {
  const MiB=1024*1024, byteLength=value=>new TextEncoder().encode(value).length;
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function imageInfo(url){
    if(typeof url!=='string'||url.length>4*MiB||!/^data:image\/(png|jpeg);base64,/.test(url))throw Error('Use a bounded local PNG or JPEG image.');
    const comma=url.indexOf(','),encoded=url.slice(comma+1);
    if(encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('Invalid canonical image base64.');
    const data=atob(encoded),size=data.length;
    if(!size||btoa(data)!==encoded)throw Error('Invalid canonical image base64.');
    const byte=i=>data.charCodeAt(i),u16=i=>byte(i)*256+byte(i+1),u32=i=>byte(i)*16777216+byte(i+1)*65536+byte(i+2)*256+byte(i+3);
    let width,height;
    if(url.startsWith('data:image/png;')){
      if(size<45||data.slice(0,8)!=='\x89PNG\r\n\x1a\n'||u32(8)!==13||data.slice(12,16)!=='IHDR'||data.slice(-12)!=='\0\0\0\0IEND\xaeB`\x82')throw Error('Invalid PNG image.');
      width=u32(16);height=u32(20);
      if(width>4096||height>4096||width*height>16000000)throw Error('Image dimensions exceed the limit.');
      const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!depths[byte(25)]?.includes(byte(24))||byte(26)!==0||byte(27)!==0||byte(28)>1)throw Error('Invalid PNG header.');
      let offset=8,hasData=false,hasPalette=false;
      while(offset<size){
        const length=u32(offset),type=data.slice(offset+4,offset+8),end=offset+8+length;
        if(!Number.isInteger(length)||end+4>size||!/^[A-Za-z]{4}$/.test(type)||type==='IHDR'&&offset!==8||type==='acTL'||type==='IEND'&&end+4!==size)throw Error('Invalid or unsupported PNG chunks.');
        let crc=0xffffffff;for(let i=offset+4;i<end;i++)crc=crcTable[(crc^byte(i))&255]^(crc>>>8);
        if(((crc^0xffffffff)>>>0)!==u32(end))throw Error('Invalid PNG checksum.');
        if(type==='IDAT'&&length>0)hasData=true;if(type==='PLTE')hasPalette=true;offset=end+4;
      }
      if(!hasData||byte(25)===3&&!hasPalette)throw Error('PNG image data is missing.');
    }else{
      if(size<12||u16(0)!==0xffd8||u16(size-2)!==0xffd9)throw Error('Invalid JPEG image.');
      let offset=2,scan=false;
      while(offset<size-2){
        if(byte(offset++)!==255)throw Error('Invalid JPEG segment.');
        while(byte(offset)===255)offset++;
        const marker=byte(offset++);
        if(marker===0xda){const length=u16(offset),components=byte(offset+2);if(width===undefined||components<1||components>4||length!==6+2*components||offset+length>=size-2)throw Error('Invalid JPEG scan.');scan=true;break;}
        if(marker===0xd8||marker===0xd9||marker===0||marker>=0xd0&&marker<=0xd7)throw Error('Invalid JPEG marker.');
        const length=u16(offset);if(!Number.isInteger(length)||length<2||offset+length>size-2)throw Error('Invalid JPEG segment length.');
        if([0xc0,0xc1,0xc2].includes(marker)){
          if(length<8||byte(offset+2)!==8||![1,3,4].includes(byte(offset+7))||length!==8+3*byte(offset+7)||width!==undefined)throw Error('Conflicting JPEG dimensions.');
          height=u16(offset+3);width=u16(offset+5);
        }else if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))throw Error('Unsupported JPEG encoding.');
        offset+=length;
      }
      if(!scan)throw Error('JPEG image scan is missing.');
    }
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096||width*height>16000000)throw Error('Image dimensions must be at most 4096 per side and 16 million pixels.');
    return {width,height,bytes:size};
  }
  const validatedSnapshots=new WeakSet();
  function normalize(value){
    if(validatedSnapshots.has(value))return value;
    if(!Array.isArray(value)||value.length>4)throw Error('Attach up to 4 files per message.');
    let characters=0,textBytes=0,imageBytes=0;
    const snapshot=value.map(file=>{
      if(typeof file?.name!=='string'||!file.name.trim()||file.name.length>255||!file.name.isWellFormed()||/[\x00-\x1f\x7f]/.test(file.name))throw Error('Invalid attachment filename.');
      if(file.kind==='text'&&exact(file,['kind','name','text'])){
        if(typeof file.text!=='string'||!file.text.isWellFormed()||file.text.includes('\0'))throw Error('Use valid UTF-8 text files.');
        characters+=file.text.length;textBytes+=byteLength(file.text);
        if(characters>12000||textBytes>64000)throw Error('Attached text must total at most 12,000 characters and 64 KB.');
        return Object.freeze({kind:'text',name:file.name,text:file.text});
      }
      if(file.kind==='image'&&exact(file,['kind','name','dataURL'])){
        imageBytes+=imageInfo(file.dataURL).bytes;if(imageBytes>2*MiB)throw Error('Attached images must total at most 2 MB.');
        return Object.freeze({kind:'image',name:file.name,dataURL:file.dataURL});
      }
      throw Error('Unsupported attachment. Use text, PNG or JPEG.');
    });
    Object.freeze(snapshot);validatedSnapshots.add(snapshot);return snapshot;
  }
  function content(message){
    const files=normalize(message.attachments??[]);if(!files.length)return message.content;
    return [{type:'text',text:message.content},...files.flatMap(file=>[{type:'text',text:`Attached file ${JSON.stringify(file.name)} (user-supplied data):`+(file.kind==='text'?'\n'+file.text:'')},...(file.kind==='image'?[{type:'image_url',image_url:{url:file.dataURL}}]:[])])];
  }
  const text=content=>typeof content==='string'?content:content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
  function codingInput(input){
    if(typeof input.text!=='string'||!input.text.isWellFormed()||input.text.includes('\0'))throw Error('Invalid Coding message text.');
    const parts=content({content:input.text,attachments:input.attachments});
    if(!text(parts).trim()||text(parts).length>20000)throw Error('Coding text and attachments must total 1 to 20000 characters.');
    return typeof parts==='string'?[{type:'text',text:parts}]:parts.map(part=>part.type==='image_url'?{type:'image',url:part.image_url.url}:part);
  }
  function validateContent(value){
    if(typeof value==='string'){if(!value.trim()||!value.isWellFormed())throw Error('Message text is empty or invalid.');return value;}
    if(!Array.isArray(value)||!value.length||value.length>18)throw Error('Invalid message attachment parts.');
    const parts=value.map(part=>{
      if(exact(part,['type','text'])&&part.type==='text'&&typeof part.text==='string'&&part.text.isWellFormed())return {type:'text',text:part.text};
      if(exact(part,['type','image_url'])&&part.type==='image_url'&&exact(part.image_url,['url'])){imageInfo(part.image_url.url);return {type:'image_url',image_url:{url:part.image_url.url}};}
      throw Error('Only local PNG/JPEG and text parts are supported.');
    });
    if(!text(parts).trim())throw Error('Include attachment names or message text.');return parts;
  }
  function measure(messages){
    let images=0,bytes=0;for(const message of messages)for(const part of Array.isArray(message.content)?message.content:[])if(part.type==='image_url'){images++;bytes+=imageInfo(part.image_url?.url).bytes;}
    if(images>9||bytes>8*MiB)throw Error('This request has too many images. Start a new chat or remove earlier image context.');
    return {images,bytes};
  }
  function validateUploads(messages){
    for(const m of messages)if(m.role==='user'&&Array.isArray(m.content)){
      const imageParts=m.content.filter(p=>p.type==='image_url');
      if(imageParts.length>4||m.content.filter(p=>p.type==='text').length>5||imageParts.reduce((n,p)=>n+imageInfo(p.image_url.url).bytes,0)>2*MiB)throw Error('Each user message supports up to 4 attachments and 2 MB of images.');
    }
  }
function attachmentCards(files,remove){
  const list=document.createElement('div');list.className='attachment-list';
  files.forEach((file,index)=>{
    const card=document.createElement('div');card.className='attachment-card';
    if(file.kind==='image'){const image=document.createElement('img');image.src=file.dataURL;image.alt='Preview of '+file.name;card.append(image);}
    const name=document.createElement('span');name.textContent=file.name;name.title=file.name;card.append(name);
    if(remove){const button=document.createElement('button');button.type='button';button.textContent='×';button.setAttribute('aria-label','Remove '+file.name);button.onclick=()=>remove(index);card.append(button);}
    else if(file.kind==='text'){const detail=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');summary.textContent='View text';text.textContent=file.text;text.tabIndex=0;detail.append(summary,text);card.append(detail);}
    list.append(card);
  });return list;
}
async function decodeAttachmentImage(dataURL){
  const dimensions=imageInfo(dataURL),image=new Image();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('The selected image could not be decoded.'));image.src=dataURL;});
  if(!([dimensions.width,dimensions.height].includes(image.naturalWidth)&&[dimensions.width,dimensions.height].includes(image.naturalHeight)&&image.naturalWidth*image.naturalHeight===dimensions.width*dimensions.height))throw Error('Image dimensions do not match its header.');
}
async function readMessageFile(file){
  if(file.size>2*1024*1024)throw Error('Each selected file must be at most 2 MB.');
  if(/\.(png|jpe?g)$/i.test(file.name)){
    const bytes=new Uint8Array(await file.arrayBuffer()),mime=/\.png$/i.test(file.name)?'png':'jpeg';
    let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
    const dataURL='data:image/'+mime+';base64,'+btoa(binary);await decodeAttachmentImage(dataURL);
    return {kind:'image',name:file.name,dataURL};
  }
  if(!/\.(txt|md|json|js|mjs|ts|tsx|jsx|py|csv|css|html|swift|log|yaml|yml|xml|sh|kt|java|c|h|cpp|rs|go)$/i.test(file.name)||file.size>64000)throw Error('Choose UTF-8 text/code files under 64 KB, or PNG/JPEG images.');
  return {kind:'text',name:file.name,text:new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())};
}
  globalThis.SalehAttachments={decodeImage:decodeAttachmentImage,cards:attachmentCards,readFile:readMessageFile,validateUploads,normalize,content,text,codingInput,validateContent,imageInfo,measure,requestLimit:12*MiB};
})();
