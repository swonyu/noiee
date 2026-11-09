// Shared model selection and readiness presentation for Chat and Tasks.
(function(root) {
  'use strict';
  const DEFAULT_KEY='saleh-local-model-default-v1';
  function bind(storage) {
    function savedDefault() {
      try {const id=storage.getItem(DEFAULT_KEY);return {saved:id!==null,id:id??''};}
      catch {return {saved:true,id:''};}
    }
    function modelDefault(catalog,mode='chat') {
      const saved=savedDefault();if(saved.saved)return saved.id;
      return catalogDefault(catalog,mode);
    }
    function catalogDefault(catalog,mode='chat') {
      if(catalog?.online!==true||!Array.isArray(catalog.models))return '';
      const rows=catalog.models.filter(row=>row&&typeof row.id==='string'&&row.id&&row.available===true);
      const preferred=rows.find(row=>row.id===catalog.defaultModel);
      const ready=rows.filter(row=>row.loaded===true&&row.capabilities?.[mode]===true&&row.capabilities?.standard===true);
      if(preferred&&ready.includes(preferred))return preferred.id;
      if(ready.length===1)return ready[0].id;
      if(ready.length>1)return '';
      return preferred?.id??(rows.length===1?rows[0].id:'');
    }
    return Object.freeze({savedDefault,modelDefault,catalogDefault,modelEligibility,modelOptions,connectionState,capabilityOverview});
  }
  function modelEligibility(catalog,id,mode,deep=false,longOutput=false) {
    const entry=Array.isArray(catalog?.models)?catalog.models.find(row=>row&&row.id===id):null;
    const blocked=(code,reason)=>({ready:false,entry,code,reason});
    if(catalog?.online!==true)return blocked(catalog?.error?.code??'LOCAL_MODEL_INVENTORY_UNAVAILABLE',catalog?.message||'Local model inventory is unavailable. Refresh models to check again.');
    if(!id)return blocked('MODEL_NOT_SELECTED','Choose a local model before starting a request.');
    if(!entry)return blocked('MODEL_SELECTION_MISSING','The selected model is missing from the local inventory. Choose an installed model; no substitute will be used.');
    if(entry.available!==true)return blocked('MODEL_UNAVAILABLE','The selected local model is unavailable.');
    if(entry.loaded!==true)return blocked('MODEL_NOT_LOADED','Installed, not loaded. Load this exact model in LM Studio, then refresh. This picker does not load or download models.');
    if(entry.capabilities?.[mode]!==true)return blocked('MODEL_MODE_UNAVAILABLE',entry.reasons?.[mode]||('This model is not ready for '+(mode==='coding'?'Tasks':mode==='agent'?'Agent':'Chat')+'.'));
    if(longOutput&&deep)return blocked('MODEL_STYLE_UNAVAILABLE','Detailed uses reasoning off. Choose Detailed or Deep reasoning separately.');
    const reasoning=deep?'deep':'standard';
    if(entry.capabilities?.[reasoning]!==true)return blocked('MODEL_STYLE_UNAVAILABLE',entry.reasons?.[reasoning]||(deep?'Deep reasoning':'Concise and Detailed')+' is unavailable for this model.');
    return {ready:true,entry,code:null,reason:'Loaded locally · no API fees.'};
  }
  function modelOptions(select,catalog,selected) {
    const choices=[],seen=new Set();
    if(!selected)choices.push(['',catalog?.online===null?'Checking local models…':'Choose a local model']);
    for(const row of Array.isArray(catalog?.models)?catalog.models:[]) {
      if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id))continue;
      seen.add(row.id);
      const state=catalog?.online!==true?'not verified':row.state==='unsupported'?'Unsupported':row.loaded===true?'Loaded':'Installed · not loaded';
      choices.push([row.id,(row.label||row.id)+' · '+state]);
    }
    if(selected&&!seen.has(selected))choices.push([selected,selected+' · '+(catalog?.online===true?'unavailable':'not verified')]);
    if(select.options.length!==choices.length||choices.some(([value,label],i)=>select.options[i].value!==value||select.options[i].textContent!==label))select.replaceChildren(...choices.map(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;return option;}));
    if(select.value!==selected)select.value=selected;
  }
  function connectionState(catalog,choice) {
    if(catalog?.online===null)return {label:'Checking local models…',state:'checking'};
    if(catalog?.online!==true) {
      const labels={authentication:'LM Studio authentication required',invalid:'Model inventory error',ambiguous:'Model identity conflict',timeout:'LM Studio timed out','server-error':'LM Studio server error',offline:'LM Studio offline'};
      return {label:labels[catalog?.status]||'Model inventory unavailable',state:'offline'};
    }
    if(choice.ready)return {label:'Local model ready',state:'online'};
    if(choice.code==='MODEL_NOT_SELECTED'||choice.code==='MODEL_SELECTION_MISSING')return {label:'Choose a local model',state:'unavailable'};
    if(choice.code==='MODEL_NOT_LOADED')return {label:'Selected model not loaded',state:'unavailable'};
    if(choice.entry?.loaded)return {label:'Model loaded · selection unavailable',state:'unavailable'};
    return {label:'Selected model unavailable',state:'unavailable'};
  }
  function capabilityOverview(catalog,id) {
    if(catalog?.online!==true)return catalog?.message||'Refresh local models to check availability.';
    const row=catalog.models?.find(value=>value.id===id);
    if(!row)return 'Choose a model to see which features are ready.';
    if(!row.loaded)return 'This model is installed but not loaded. Load it in LM Studio, then refresh.';
    const names=[['chat','Chat'],['agent','Agent'],['coding','Tasks'],['standard','Concise / Detailed'],['deep','Deep reasoning']];
    const ready=names.filter(([key])=>row.capabilities?.[key]===true).map(([,label])=>label);
    const unavailable=names.filter(([key])=>row.capabilities?.[key]!==true).map(([key,label])=>label+': '+(row.reasons?.[key]||'unavailable'));
    const window=Number.isSafeInteger(row.contextLength)?row.contextLength.toLocaleString()+' tokens loaded. ':'Loaded context is unconfirmed. ';
    return window+(ready.length?'Ready: '+ready.join(', ')+'. ':'')+(unavailable.length?unavailable.join(' '):'');
  }
  root.NoieeModelPicker=Object.freeze({DEFAULT_KEY,bind,modelEligibility,modelOptions,connectionState,capabilityOverview});
})(globalThis);
