(() => {
  const bridge=window.webkit?.messageHandlers?.tools;
  const $=id=>document.getElementById(id);
  let panelBusy=false, nextOffset=null, catalogQuery='', recoveryUnavailable=false, statusText='';
  const native=body=>bridge ? bridge.postMessage(body) : Promise.reject(new Error('Agent tools require the native Mac app.'));
  const status=text=>{statusText=text;$('tools-status').textContent=text+(recoveryUnavailable?' Automatic MCP recovery is unavailable. Retained connection state needs inspection.':'');};
  let skillScope=null,skillGeneration=0;
  const skillNative=async input=>{const value=await native({op:'projectSkills',input});if(value.isError)throw Error(value.message||'Project skill access is held.');return value;};
  async function refreshSkills(){
    const generation=skillGeneration,catalog=await skillNative({action:'catalog'});
    if(generation!==skillGeneration)return;
    skillScope=catalog.scope&&typeof catalog.scope.scopeId==='string'?catalog.scope:null;
    const installed=skillScope?await skillNative({action:'list',scopeId:skillScope.scopeId}):{skills:[]};
    if(generation!==skillGeneration)return;
    $('skills-project').textContent=skillScope?skillScope.project:'No project selected.';$('skills-catalog').replaceChildren();
    for(const entry of catalog.catalog||[]){
      const state=installed.skills.find(row=>row.id===entry.id),row=document.createElement('div');row.className='tool-server';
      const name=document.createElement('strong');name.textContent=entry.name;
      const detail=document.createElement('small');detail.textContent=entry.description+' · '+(state?.installed?'Installed':state&&state.state!=='not_installed'?'Existing files retained · '+state.state:'Not installed');
      const install=document.createElement('button');install.textContent=state?.installed?'Installed':'Install';install.disabled=!skillScope||state?.installed||!!state&&state.state!=='not_installed';
      install.onclick=()=>skillAction(()=>skillNative({action:'install',scopeId:skillScope.scopeId,id:entry.id}));
      const read=document.createElement('button');read.textContent='Read';read.disabled=!skillScope||!state?.installed;
      read.onclick=()=>skillAction(()=>skillNative({action:'read',scopeId:skillScope.scopeId,id:entry.id}),false);
      row.append(name,detail,install,read);$('skills-catalog').append(row);
    }
  }
  function skillAction(fn,reload=true){
    return panelAction(async()=>{
      const generation=skillGeneration;
      try {
        const value=await fn();if(generation!==skillGeneration)return {message:'Project skill action stopped. Inspect its state before retrying.'};
        if(reload&&!value.cancelled)await refreshSkills();
        if(generation===skillGeneration){
          if(typeof value.text==='string'){$('skills-preview').textContent=value.text;$('skills-preview').hidden=false;}
          $('skills-status').textContent=value.message||(typeof value.text==='string'?'Read the installed skill. Its text grants no additional permissions.':'Project skills refreshed.');
        }
        return value;
      } catch(error){
        if(generation===skillGeneration){skillScope=null;$('skills-catalog').replaceChildren();$('skills-preview').textContent='';$('skills-preview').hidden=true;$('skills-project').textContent='Project state unavailable. Refresh to inspect the selected project.';$('skills-status').textContent=error.message||String(error);}
        throw error;
      }
    },false);
  }
  let fetchGeneration=0;
  async function fetchNative(input){const value=await native({op:'fetchPlugin',input});if(value.isError)throw Error(value.message||'Fetch access is held.');return value;}
  function renderFetch(value){
    $('fetch-catalog').replaceChildren();const row=document.createElement('div');row.className='tool-server';
    const name=document.createElement('strong');name.textContent='Fetch · free · Agent tools';
    const active=value.enabled===true&&!value.connectionHeld;
    const detail=document.createElement('small');detail.textContent=!value.available?'Unavailable · see status':!value.installed?'Not installed':value.connectionHeld?'Connection held · enable explicitly to release':active?'Enabled · connection status below':'Installed · disabled';
    const install=document.createElement('button');install.textContent=value.installed?'Installed':'Install';install.disabled=!value.available||value.installed!==false;install.onclick=()=>fetchAction({action:'install'});
    const enabled=document.createElement('button');enabled.textContent=active?'Disable':'Enable';enabled.disabled=!value.available||!value.installed;enabled.onclick=()=>fetchAction({action:'set_enabled',enabled:!active});
    row.append(name,detail,install,enabled);$('fetch-catalog').append(row);$('fetch-status').textContent=value.message||'Install and enable do not connect or call Fetch.';
  }
  async function refreshFetch(){const generation=fetchGeneration,value=await fetchNative({action:'catalog'});if(generation===fetchGeneration)renderFetch(value);}
  function fetchAction(input){return panelAction(async()=>{
    const generation=fetchGeneration;
    try{const value=await fetchNative(input);if(generation!==fetchGeneration)return {message:'Fetch work stopped. Refresh its state before retrying.'};if(!value.cancelled)renderFetch(value);return value;}
    catch(error){if(generation===fetchGeneration){$('fetch-catalog').replaceChildren();$('fetch-status').textContent=error.message||String(error);}throw error;}
  });}
  async function refresh() {
    if(!bridge){status('Open Noiee.app to use native tools.');return;}
    const result=await native({op:'describe'});recoveryUnavailable=result.recoveryUnavailable===true;status(statusText);$('tool-servers').replaceChildren();
    for(const server of result.servers){
      const row=document.createElement('div');row.className='tool-server';
      const label=document.createElement('strong');label.textContent=server.id;
      const recovering=['checking','reconnecting'].includes(server.recoveryState);
      const detail=document.createElement('small');detail.textContent=server.configRemoved?'Configuration removed · disconnect this session':server.configChanged?'Configuration changed · reconnect':server.catalogRefreshing?'Verifying catalog':server.statusReason?`Unavailable · ${server.statusReason}`:server.connected?'Connected':server.recoveryState||'Not connected';
      const button=document.createElement('button');button.textContent=recovering?'Cancel reconnect':server.connected||server.configRemoved?'Disconnect':'Connect…';
      button.onclick=()=>panelAction(()=>native({op:server.connected||server.configRemoved||recovering?'disconnect':'connect',id:server.id}));
      row.append(label,detail,button);$('tool-servers').append(row);
    }
    await catalog($('tools-query').value.trim(),0);
    if(!result.servers.length)status('Add a folder or browser, then choose Connect. No MCP servers are active yet.');
  }
  async function panelAction(fn,reload=true){
    if(panelBusy)return;panelBusy=true;
    try { const result=await fn();status(result.message||JSON.stringify(result));if(reload)await refresh(); }
    catch(error){status(error.message||String(error));}
    finally{panelBusy=false;}
  }
  async function catalog(query,offset){
    const result=await native({op:'catalog',query,offset});
    if(offset===0){$('tool-catalog').replaceChildren();catalogQuery=query;}
    const rows=offset===0?(result.builtins||[]).filter(t=>(t.name+' '+t.description).toLowerCase().includes(query.toLowerCase())).map(t=>({...t,server:'Built in'})):[];
    rows.push(...(result.tools||[]));
    for(const tool of rows){
      const row=document.createElement('details');row.className='tool-catalog-entry';
      const title=document.createElement('summary');title.textContent=`${tool.server} · ${tool.name}`;
      const detail=document.createElement('p');detail.textContent=tool.description;row.append(title,detail);
      if(tool.inputSchema){const schema=document.createElement('pre');schema.textContent=JSON.stringify(tool.inputSchema,null,2);schema.tabIndex=0;row.append(schema);}
      $('tool-catalog').append(row);
    }
    nextOffset=result.nextOffset??null;$('tools-more').hidden=nextOffset===null;
    $('tools-count').textContent=`${result.total||0} matching connected tools · ${Math.min(offset+(result.tools?.length||0),result.total||0)} shown`+(result.truncated&&nextOffset===null?' · provider catalog is incomplete':'');
    return {message:'Tool inventory read. Built-in entries describe capabilities; system permission or action review may still be needed.'};
  }
  $('tools-search').onclick=()=>panelAction(()=>catalog($('tools-query').value.trim(),0),false);
  $('tools-query').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();$('tools-search').click();}};
  $('tools-more').onclick=()=>{if(nextOffset!==null)panelAction(()=>catalog(catalogQuery,nextOffset),false);};
  for(const [id,op] of [['tools-files','addFilesystem'],['tools-browser','addBrowser'],['tools-config','editConfig']]){
    $(id).disabled=!bridge;$(id).onclick=()=>panelAction(()=>native({op}));
  }
  $('tools-refresh').onclick=()=>panelAction(async()=>{await refresh();return{message:'Tool connections refreshed.'};},false);
  $('open-tools').onclick=()=>{setContext(true,'tools');panelAction(async()=>{await refresh();await refreshSkills();await refreshFetch();return{message:'Native computer, calls, terminal, fixed project skills and optional free Fetch are available in Agent mode. Connect MCP servers below for more tools.'};},false);};
  $('fetch-refresh').disabled=!bridge;$('fetch-refresh').onclick=()=>fetchAction({action:'catalog'});
  $('skills-choose').disabled=!bridge;$('skills-refresh').disabled=!bridge;
  $('skills-choose').onclick=()=>skillAction(()=>native({op:'projectSkillsChoose'}));
  $('skills-refresh').onclick=()=>skillAction(async()=>{await refreshSkills();return {message:'Project skill states refreshed.'};},false);
  $('tools-share').disabled=!bridge;
  $('tools-share').onclick=()=>panelAction(()=>native({op:'execute',name:'computer_share',arguments:{}}));
  for(const event of ['agent-stopped','tools-stopped'])window.addEventListener(event,()=>{fetchGeneration++;$('fetch-catalog').replaceChildren();$('fetch-status').textContent='Stopped. Refresh Fetch before another task.';skillGeneration++;skillScope=null;$('skills-catalog').replaceChildren();$('skills-project').textContent='Refresh to inspect the selected project.';$('skills-preview').textContent='';$('skills-preview').hidden=true;$('skills-status').textContent='Stopped. Refresh skills before another task.';$('tool-servers').replaceChildren();$('tool-catalog').replaceChildren();nextOffset=null;$('tools-more').hidden=true;$('tools-count').textContent='Connections stopping · refresh to check current state';status('Stopped. Refresh to inspect connections before another task.');});
  function stop(){native({op:'cancelTools'}).catch(()=>{});}
  window.addEventListener('pagehide',()=>native({op:'departPage'}).catch(()=>{}));
  window.qwenAgent={available:!!bridge,stop};
})();
