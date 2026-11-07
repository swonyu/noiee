(() => {
  const el = id => document.getElementById(`computer-${id}`);
  const bridge = window.webkit?.messageHandlers?.computer;
  let serial = 0, proposal = null, selected = false, busy = false, chatBusy = false;
  const status = text => { el('status').textContent = text; };
  function controls() {
    el('observe').disabled = !bridge || !selected || busy || chatBusy || !el('task').value.trim();
    for (const key of ['practice', 'choose']) el(key).disabled = !bridge || busy || chatBusy;
    el('apply').disabled = !proposal || busy || chatBusy;
    el('stop').disabled = !bridge;
    window.dispatchEvent(new CustomEvent('computer-busy', {detail:busy}));
  }
  function clear() {
    serial++; proposal = null; selected = false; busy = false;
    el('image').removeAttribute('src'); el('image').hidden = true;
    el('proposal').textContent = ''; el('proposal').hidden = true; el('apply').hidden = true;
    el('target').textContent = 'No window shared'; controls();
  }
  async function call(op) {
    if (!bridge || busy || chatBusy) return;
    if (op === 'practice' || op === 'choose') clear();
    const own = ++serial; busy = true; controls();
    const body = { op };
    if (op === 'observe') {
      body.task = el('task').value; body.model = current()?.model; proposal = null; el('apply').hidden = true;
      el('image').removeAttribute('src'); el('image').hidden = true; el('proposal').hidden = true;
    }
    if (op === 'apply') { body.id = proposal; proposal = null; el('apply').hidden = true; }
    status(op === 'observe' ? 'Capturing the selected window and asking local Qwen…' : op === 'apply' ? 'Review the native confirmation. Cancel discards this proposal.' : 'Waiting for window selection…');
    try {
      if(op==='observe'&&(typeof body.model!=='string'||!body.model))throw Error('Select a loaded local vision model in this chat first.');
      const result = await bridge.postMessage(body);
      if (own !== serial) return;
      status(result.message);
      if (result.title) { selected = true; el('target').textContent = result.title; }
      if (result.image) { el('image').src = result.image; el('image').hidden = false; }
      if (result.proposal) { el('proposal').textContent = result.proposal; el('proposal').hidden = false; }
      if (result.id) { proposal = result.id; el('apply').hidden = false; }
    } catch (error) { if (own === serial) status(String(error.message || error)); }
    finally { if (own === serial) { busy = false; controls(); } }
  }
  for (const key of ['practice','choose','observe','apply']) el(key).onclick = () => call(key);
  el('stop').onclick = () => { clear(); status('Stopped. Window access and pending actions cleared.'); if(window.qwenAgent?.available)window.qwenAgent.stop();else bridge?.postMessage({ op:'stop' }).catch(() => {}); };
  window.addEventListener('computer-stopped', () => {
    clear(); status('Stopped. Window access and pending actions cleared.');
  });
  window.addEventListener('pagehide', () => { clear(); bridge?.postMessage({op:'stop'}).catch(() => {}); });
  document.getElementById('open-computer').onclick = () => { setContext(true, 'computer'); el('task').focus(); };
  el('task').addEventListener('input', controls);
  window.addEventListener('chat-busy', event => { if (chatBusy !== event.detail) { chatBusy=event.detail; controls(); } });
  const handoff = document.getElementById('open-facetime');
  handoff.disabled = !bridge;
  handoff.onclick = async () => {
    try { const result = await bridge.postMessage({op:'openFaceTime'}); notice(result.message); }
    catch (error) { notice(String(error.message || error)); }
  };
  controls();
  if (bridge) status('Choose a window or try the disposable practice window.');
})();
