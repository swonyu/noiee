// Shared view of backend-owned Chat and Agent runs. Never resubmits recovered work.
(() => {
  const agentLimits=globalThis.qwenWork.agentLimits;
  const agentMode=document.getElementById('chat-mode');if(agentMode)agentMode.title=`Agent allows up to ${agentLimits.actions} tool actions and ${agentLimits.plans} plan updates, then a final review. Context limits may end the run earlier. Chat answers without tools.`;
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),id=v=>typeof v==='string'&&v.length>0&&v.length<=160&&!/[\x00-\x1f\x7f]/.test(v);
  const statuses=['intent','running','complete','length','stopped','error','unconfirmed'];
  let disposed=false,controller=null,watched=null,refreshing=null,timer=null,latest=null,sequence=0,stateEpoch=0,generation=null,currentChatId=null;const seen=new Map(),liveIds=new Set(),observedLive=new Set();
  const bridge=window.webkit?.messageHandlers?.tools,automaticReviews=new Set(),reviewedSteps=new Set();let reviewing=null;
  const review=document.getElementById('chat-background-review');
  const panel=document.getElementById('chat-background'),label=document.getElementById('chat-background-status'),open=document.getElementById('chat-background-open'),stop=document.getElementById('chat-background-stop'),receipt=document.getElementById('chat-background-receipt');
  const emit=(name,detail)=>window.dispatchEvent(new CustomEvent(name,{detail}));
  const older=(value,old)=>old&&(old.run.revision>value.run.revision||old.run.revision===value.run.revision&&!old.live&&value.live);
  function validate(value,summary=false){
    const row=value?.run;if(!row||!uuid(row.runId)||!id(row.chatId)||!id(row.userMessageId)||!id(row.assistantMessageId)||!/^[a-f0-9]{64}$/.test(row.inputDigest)||!statuses.includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(value.durableRevision)||value.durableRevision<0||value.durableRevision>row.revision||typeof value.live!=='boolean'||!['saved','pending','failed'].includes(value.persistence)||!(value.saveError===null||typeof value.saveError==='string')||!summary&&(typeof row.content!=='string'||typeof row.reasoning!=='string'||typeof row.userMessage!=='string'||new TextEncoder().encode(JSON.stringify(value)).length>16*1024*1024))throw Error('Invalid saved text-run observation.');
    if(![1,2,3,4,5].includes(row.version)||row.version===5&&(row.purpose!=='compact'||row.kind!==undefined||!/^[a-f0-9]{64}$/.test(row.sourceDigest)||row.thinking!=='standard')||[3,4].includes(row.version)&&!/^[a-f0-9]{64}$/.test(row.userContentDigest)||[2,4].includes(row.version)&&(row.kind!=='agent'||!Array.isArray(row.receipts)||row.receipts.length>agentLimits.receipts||!Array.isArray(row.plan)||row.plan.length>agentLimits.plans||!Array.isArray(row.sources)||row.sources.length>8||typeof row.budgetReached!=='boolean'||typeof row.nativeResult!=='boolean'))throw Error('Invalid saved Agent observation.');
    if(Object.hasOwn(value,'parallelText')&&typeof value.parallelText!=='boolean')throw Error('Invalid text-run parallel eligibility.');
    const step=row.pendingStep;if(step!=null&&(!uuid(step.stepId)||!/^[a-f0-9]{64}$/.test(step.stepDigest)||typeof step.name!=='string'||!['pending','claimed'].includes(step.state)))throw Error('Invalid pending Agent action.');return value;
  }
  async function request(input){
    if(['prepare','start','stop'].includes(input.action))stateEpoch++;
    const response=await fetch('/api/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Chat':'1'},body:JSON.stringify(input),cache:'no-store'}),value=await response.json();
    if(!response.ok)throw Error(value.error||'Text-run state is unavailable.');return value;
  }
  async function inspect(runId){const value=await request({action:'read',runId});if(value.run===null)return value;return validate(value);}
  const fullySaved=value=>value.persistence==='saved'&&value.durableRevision===value.run.revision&&!value.saveError;
  function render(value){
    if(!panel)return;panel.hidden=!value||!value.live&&value.run.status==='complete'&&fullySaved(value)&&value.run.chatId!==currentChatId&&!observedLive.has(value.run.runId);if(!value)return;
    const row=value.run,saved=fullySaved(value),scope=currentChatId===row.chatId?'This chat':document.body.classList.contains('workspace-coding')?'Another chat (Chat workspace)':'Another chat',prefix=(liveIds.size>1?liveIds.size+' running · ':'')+(row.purpose==='compact'?'Context compaction':row.kind==='agent'?'Agent':'Chat')+' · '+scope+' · ';
    label.textContent=prefix+(value.live?(row.pendingStep?(row.pendingStep.state==='claimed'?'Waiting for the action result…':row.kind==='agent'?(automaticReviews.has(row.runId)?'Preparing tool action…':'Paused — continue tool actions'):'Next tool action is pending'):row.status==='intent'?'Preparing run…':'Generating in the background…'):({complete:saved?'Reply saved':'Reply completed',length:'Length limit reached',stopped:saved?'Stopped; saved partial retained':'Stopped',error:'Reply failed; inspect result',unconfirmed:'Completion unconfirmed; no replay made'}[row.status]||row.status));
    if(!saved)label.textContent+=value.persistence==='failed'||value.saveError?' · Saving failed; latest result is not fully saved':' · Saving pending; latest result is not fully saved';
    if(review){review.textContent='Continue tool actions';review.hidden=!(value.live&&row.kind==='agent'&&row.pendingStep?.state==='pending');review.disabled=!!reviewing||!bridge;}
    if(value.saveError)label.textContent+=' · '+value.saveError;stop.hidden=!value.live;open.href='/?chatId='+encodeURIComponent(row.chatId);receipt.hidden=false;receipt.textContent=saved?'View saved result':'Inspect result';
  }
  window.addEventListener('chat-selection-change',event=>{const next=id(event.detail?.chatId)?event.detail.chatId:null;if(next===currentChatId)return;currentChatId=next;stateEpoch++;const own=[...seen.values()].find(value=>value.live&&liveIds.has(value.run.runId)&&value.run.chatId===currentChatId);if(own){latest=own;void watch(own.run.runId);}if(latest)render(latest);void refresh().catch(()=>{});});
  function observed(value,select=true){
    validate(value);if(disposed)return;const old=seen.get(value.run.runId);if(older(value,old))return;
    // Ownership changes fence older inventories, while same-run progress leaves other rows observable.
    if(!old&&value.live||old&&old.live!==value.live)stateEpoch++;
    seen.set(value.run.runId,{...value,image:undefined});if(value.live){liveIds.add(value.run.runId);observedLive.add(value.run.runId);}else liveIds.delete(value.run.runId);
    if(select&&(!latest?.live||latest.run.chatId!==currentChatId||value.run.chatId===currentChatId))latest=value;
    if(latest)render(latest);emit('chat-run-snapshot',value);
    if(select&&value.live&&value.run.kind==='agent'&&value.run.pendingStep?.state==='pending'&&automaticReviews.has(value.run.runId))void reviewStep(value);
  }
  function detach(){sequence++;controller?.abort();controller=null;watched=null;}
  async function watch(runId){
    if(disposed||watched===runId)return;detach();watched=runId;const epoch=sequence,own=new AbortController();controller=own;
    try{
      const response=await fetch('/api/chat/runs/'+encodeURIComponent(runId)+'/events',{headers:{'X-Qwen-Chat':'1'},cache:'no-store',signal:own.signal});if(!response.ok)throw Error((await response.json()).error||'Text updates are unavailable.');
      const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='';
      try{while(!disposed&&epoch===sequence){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});if(new TextEncoder().encode(buffer).length>16*1024*1024)throw Error('Text-run snapshot exceeds its limit.');let end;while((end=buffer.indexOf('\n\n'))>=0){const packet=buffer.slice(0,end);buffer=buffer.slice(end+2);if(packet.startsWith('data: ')&&epoch===sequence)observed(JSON.parse(packet.slice(6)));}if(done){if(buffer.trim())throw Error('Incomplete text-run snapshot.');break;}}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }catch(error){if(!own.signal.aborted&&!disposed){emit('chat-run-error',error.message);if(label)label.textContent='Chat updates interrupted. Saved evidence will be checked again.';}}
    finally{if(epoch===sequence){controller=null;watched=null;if(!disposed){clearTimeout(timer);timer=setTimeout(()=>{void refresh().catch(()=>{});},1000);}}}
  }
  async function refresh(){
    if(disposed)return;if(refreshing)return refreshing;clearTimeout(timer);
    return refreshing=(async()=>{
      try{
        const epoch=stateEpoch,value=await request({action:'list'});if(epoch!==stateEpoch)return;if(!Array.isArray(value.runs)||value.runs.length>128||typeof value.truncated!=='boolean'||!uuid(value.generation))throw Error('Invalid text-run inventory.');value.runs.forEach(row=>validate(row,true));generation=value.generation;
        // Focused progress cannot invalidate another run's inventory; reconcile each run monotonically.
        value.runs=value.runs.map(row=>{const old=seen.get(row.run.runId);return older(row,old)?old:row;});
        const active=value.runs.filter(row=>row.live);if(active.length>2||new Set(active.map(value=>value.run.chatId)).size!==active.length||active.length>1&&active.some(value=>value.parallelText!==true))throw Error('Text-run ownership is ambiguous.');
        liveIds.clear();for(const row of active)liveIds.add(row.run.runId);if(latest?.live&&!liveIds.has(latest.run.runId))latest=null;emit('chat-run-list',{runs:value.runs,truncated:value.truncated,generation:value.generation});
        const chosen=active.find(value=>value.run.chatId===currentChatId)??active[0]??value.runs.sort((a,b)=>b.run.updatedAt-a.run.updatedAt)[0];
        if(chosen){const full=await inspect(chosen.run.runId);if(disposed||epoch!==stateEpoch)return;observed(full);if(full.live)void watch(full.run.runId);}else{latest=null;render(null);}
        emit('chat-runs-ready',value.runs);return value.runs;
      }catch(error){emit('chat-run-error',error.message);throw error;}
      finally{refreshing=null;if(!disposed)timer=setTimeout(()=>{void refresh().catch(()=>{});},3000);}
    })();
  }
  async function stopRun(runId){automaticReviews.delete(runId);const stopping=request({action:'stop',runId});void stopping.catch(()=>{});const known=seen.get(runId)??await inspect(runId);if(known.run?.kind==='agent'&&bridge)await bridge.postMessage({op:'cancelTools'});const value=await stopping;if(value.run===null)return value;validate(value);observed(value);return value;}
  async function reviewStep(value,explicit=false){
    const row=value.run,step=row.pendingStep,key=row.runId+'/'+step?.stepId;
    if(disposed||!bridge||reviewing||!value.live||row.kind!=='agent'||step?.state!=='pending'||!explicit&&reviewedSteps.has(key))return;
    reviewedSteps.add(key);reviewing=key;render(value);
    try{const result=await bridge.postMessage({op:'agentStep',runId:row.runId,stepId:step.stepId});if(result?.run)observed(result);}
    catch(error){automaticReviews.delete(row.runId);emit('chat-run-review-error',String(error.message||error));if(label)label.textContent='Action review interrupted. Inspect the saved result before continuing.';}
    finally{reviewing=null;if(!disposed){if(latest)render(latest);void refresh().catch(()=>{});}}
  }
  if(review)review.onclick=()=>{if(latest){automaticReviews.add(latest.run.runId);void reviewStep(latest,true);}};
  for(const name of ['agent-stopped','tools-stopped'])window.addEventListener(name,()=>{automaticReviews.clear();if(latest&&!disposed)render(latest);});
  async function digest(input){
    const extra=Object.hasOwn(input,'longOutput')?{longOutput:input.longOutput}:{};
    const compact=Object.hasOwn(input,'purpose');
    if(compact&&(input.purpose!=='compact'||input.kind!==undefined||input.thinking!=='standard'||Object.hasOwn(input,'longOutput')||!/^[a-f0-9]{64}$/.test(input.sourceDigest)))throw Error('Invalid context compaction purpose.');
    if(Object.hasOwn(extra,'longOutput')&&(extra.longOutput!==true||input.thinking!=='standard'))throw Error('Long answer requires longOutput: true and Standard reasoning.');
    const bytes=new TextEncoder().encode(JSON.stringify({chatId:input.chatId,userMessageId:input.userMessageId,assistantMessageId:input.assistantMessageId,messages:input.messages,model:input.model,thinking:input.thinking,...extra,...(input.kind==='agent'?{kind:'agent',sources:input.sources}:{}),...(compact?{purpose:'compact',sourceDigest:input.sourceDigest}:{})}));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  }
  function metadata(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='admitted,draftCleared,imported,inputDigest,revision,runId,submittedDraft,userMessageId'||!uuid(value.runId)||!id(value.userMessageId)||!/^[a-f0-9]{64}$/.test(value.inputDigest)||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.submittedDraft!=='string'||value.submittedDraft.length>24000||['admitted','draftCleared','imported'].some(key=>typeof value[key]!=='boolean'))throw Error('Invalid saved text-run link.');return {...value};
  }
  if(open)open.onclick=async event=>{
    event.preventDefault();if(!latest)return;const body=document.body,url=location.href,chatId=latest.run.chatId;
    try{if(typeof window.salehCanNavigate==='function'&&window.salehCanNavigate()!==true)return;
      if(typeof window.salehSaveBeforeLeave!=='function'||await window.salehSaveBeforeLeave()!==true){label.textContent='The current draft could not be saved. Stay on this page and preserve the unsent text.';return;}
      if(disposed||document.body!==body||location.href!==url||typeof window.salehCanNavigate==='function'&&window.salehCanNavigate()!==true)return;
      location.href='/?chatId='+encodeURIComponent(chatId);
    }catch(error){label.textContent='Chat was not opened. '+error.message;}
  };
  if(stop)stop.onclick=async()=>{if(!latest?.live)return;stop.disabled=true;try{await stopRun(latest.run.runId);}catch(error){label.textContent=error.message;}finally{stop.disabled=false;}};
  if(receipt)receipt.onclick=async()=>{
    if(!latest||document.body.inert||document.querySelector('dialog[open]'))return;
    const runId=latest.run.runId,dialog=document.createElement('dialog'),title=document.createElement('h2'),note=document.createElement('p'),body=document.createElement('pre'),close=document.createElement('button');
    let presented=false;
    dialog.id='chat-run-receipt-dialog';title.id='chat-run-receipt-title';dialog.setAttribute('aria-labelledby',title.id);
    title.textContent='Loading saved result…';note.setAttribute('role','status');body.tabIndex=0;close.type='button';close.textContent='Close';
    close.onclick=()=>window.salehWorkspace.closeDialog(dialog);dialog.append(title,note,body,close);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());
    try{
      window.salehWorkspace.openDialog(dialog,receipt);
      presented=true;
      const value=await inspect(runId);if(disposed||!dialog.isConnected||!dialog.open)return;
      if(!value.run)throw Error('This saved run is unavailable. No history was recreated.');
      title.textContent=(fullySaved(value)?'Saved ':'')+(value.run.purpose==='compact'?'context summary':value.run.kind==='agent'?'Agent result':'Chat result');note.textContent=(fullySaved(value)?'':value.persistence==='failed'||value.saveError?'Saving failed; the latest result is not fully saved. ':'Saving pending; the latest result is not fully saved. ')+(value.saveError||'Read-only receipt. Missing or deleted chats are not recreated; this does not start another generation.');body.textContent=value.run.userMessage+'\n\n'+value.run.content+(value.run.reasoning?'\n\nModel reasoning · model output:\n'+value.run.reasoning:'')+(value.run.kind==='agent'?'\n\nAction receipts:\n'+JSON.stringify(value.run.receipts,null,2):'')+(value.run.error?'\n\n'+value.run.error:'');
    }catch(error){if(disposed||!dialog.isConnected)return;if(dialog.open){title.textContent='Result could not load';note.textContent=error.message;}else{dialog.remove();if(!presented)label.textContent=error.message;}}
  };
  window.addEventListener('pagehide',()=>{disposed=true;automaticReviews.clear();clearTimeout(timer);detach();});
  window.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh().catch(()=>{});});
  window.SalehChatRuns={contentDigest:async content=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(content))))].map(n=>n.toString(16).padStart(2,'0')).join(''),request,inspect,stop:stopRun,allowAgentReview:runId=>{if(!uuid(runId))throw Error('Invalid Agent run ID.');automaticReviews.add(runId);},digest,metadata,watch,refresh,validate,receive:observed,generation:async()=>{const value=await request({action:'list'});if(!uuid(value.generation))throw Error('Text admission is not ready. Refresh saved runs first.');generation=value.generation;return generation;}};
  timer=setTimeout(()=>{void refresh().catch(()=>{});},0);
})();
