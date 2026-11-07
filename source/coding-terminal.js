(() => {
  'use strict';
  class CodingTerminal {
    constructor({host, status, follow, attach, call, changed}) {
      Object.assign(this, {host, status, follow, attach, call, changed});
      this.views = []; this.active = 0; this.epoch = 0; this.queue = []; this.queued = 0; this.revoked = false;
      this.follow.onclick = () => {this.paused = !(this.paused || this.selecting); this.selecting = false; this.clearQueue(); if (!this.paused) this.views[this.active]?.term.clearSelection(); this.paint(); this.state();};
      this.attach.onclick = () => this.authorize();
      this.observer = new ResizeObserver(() => this.fit()); this.observer.observe(host);
      this.pointerUp = () => {if (!this.selecting) return; this.selecting = false; if (this.views[this.active]?.term.hasSelection()) this.paused = true; this.paint(); this.state();};
      document.addEventListener('pointerup', this.pointerUp);
    }
    createViews() {
      if (this.views.length) return;
      if (!window.Terminal || !window.FitAddon) throw new Error('Interactive terminal assets are unavailable. Reload to retry.');
      for (let index = 0; index < 2; index++) {
        const node = document.createElement('div'); node.className = 'pty-view'; this.host.append(node);
        const term = new Terminal({cols: 100, rows: 30, scrollback: 500, screenReaderMode: true, disableStdin: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: {background: '#171717', foreground: '#eeeeee'}, allowProposedApi: false});
        const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(node);
        const view = {node, term, fit, revision: -1}; this.views.push(view);
        term.onData(data => {if (index === this.active && !this.swapping && this.writable()) this.enqueue(new TextEncoder().encode(data));});
        term.onBinary(data => {if (index === this.active && !this.swapping && this.writable()) this.enqueue(Uint8Array.from(data, value => value.charCodeAt(0)));});
        term.onSelectionChange(() => {if (index === this.active && term.hasSelection()) {this.paused = true; this.clearQueue(); this.state();}});
        term.onScroll(() => {if (index === this.active && !this.swapping && term.buffer.active.viewportY < term.buffer.active.baseY) {this.paused = true; this.clearQueue(); this.state();}});
        term.attachCustomKeyEventHandler(event => {if (event.key === 'Tab' && event.ctrlKey && event.shiftKey) {if (event.type === 'keydown') {event.preventDefault(); this.follow.focus();} return false;} return true;});
        // Xterm clears drag selection before emitting input; pause before its handlers run.
        const pauseSelectedInput = () => {if (index === this.active && this.selecting && term.hasSelection()) {this.paused = true; this.clearQueue(); this.state();}};
        for (const type of ['keydown', 'paste', 'beforeinput', 'compositionstart']) node.addEventListener(type, pauseSelectedInput, true);
        // Pointer ownership freezes redraw; only a nonempty selection pauses input.
        node.addEventListener('pointerdown', () => {if (index === this.active) {this.selecting = true; this.state();}});
        node.addEventListener('compositionstart', () => {if (index === this.active) this.composing = true;}, true);
        node.addEventListener('compositionend', () => {setTimeout(() => {this.composing = false; this.paint();}, 0);});
      }
      this.state();
    }
    show(session, visible, allowed) {
      if (this.disposed) return;
      const identity = session?.mode === 'pty' ? `${session.threadId}:${session.processId}` : '';
      if (identity !== this.identity) {
        this.epoch++; this.clearQueue(); clearTimeout(this.timer); this.timer = null; clearTimeout(this.resizeTimer); if (this.attachToken) this.attachToken.cancelled = true; if (this.resizeToken) this.resizeToken.cancelled = true; this.identity = identity; this.session = identity ? session : null; this.latest = null; this.granted = false; this.revoked = false; this.paused = false; this.selecting = false; this.composing = false; this.failure = ''; this.active = 0;
        for (const view of this.views) view.term.dispose(); this.views = []; this.host.replaceChildren(); this.painting = false;
      } else if (this.session) this.session = session;
      if (this.visible && !visible) this.clearQueue();
      const becameVisible = visible && !this.visible; this.visible = visible; this.allowed = allowed;
      this.host.hidden = !this.session; this.attach.hidden = !this.session; this.follow.hidden = !this.session;
      if (this.session) {try {this.createViews();} catch (error) {this.failure = error.message;} if (!this.timer && !this.polling) this.schedule(0); if (becameVisible) {this.paint(); this.fit();}}
      this.state();
    }
    availability(allowed) {if (this.allowed === allowed) return; this.allowed = allowed; if (!allowed) this.clearQueue(); this.state();}
    writable() {return !!(this.session && this.visible && !document.hidden && this.allowed && this.granted && !this.revoked && !this.failure && !this.paused && !this.views[this.active]?.term.hasSelection() && this.session.state === 'running' && this.views[this.active]?.revision >= 0);}
    state() {
      for (let index = 0; index < this.views.length; index++) {const view = this.views[index], active = index === this.active; view.term.options.disableStdin = !active || !this.writable(); view.node.style.visibility = active ? 'visible' : 'hidden'; view.node.inert = !active; view.node.setAttribute('aria-hidden', String(!active));}
      if (!this.session) {this.status.textContent = ''; return;}
      this.attach.hidden = this.session.state !== 'running' || (this.granted && !this.revoked); this.attach.disabled = !this.allowed || !!this.attaching;
      this.follow.disabled = false; const followLabel = this.paused ? 'Resume live display' : 'Pause display'; if (this.follow.textContent !== followLabel) this.follow.textContent = followLabel;
      this.status.textContent = this.failure || `${this.session.state}${this.session.exitCode != null ? ` · code ${this.session.exitCode}` : ''}${this.session.error ? ` · ${this.session.error}` : ''}${this.session.state !== 'running' ? '' : this.paused ? ' · Display paused; input disabled' : !this.granted || this.revoked ? ' · Read-only; review to enable input' : this.views[this.active]?.revision < 0 ? ' · Loading coherent screen…' : ' · Keyboard input enabled'}`;
    }
    schedule(delay) {clearTimeout(this.timer); if (!this.disposed && this.session) this.timer = setTimeout(() => {this.timer = null; this.poll();}, delay);}
    async poll() {
      if (this.polling || !this.session || this.disposed) return;
      this.polling = true; const epoch = this.epoch, processId = this.session.processId;
      try {const frame = await this.call('terminalSnapshot', {processId, ...(this.latest ? {after: this.latest.revision} : {})}); if (epoch !== this.epoch) return; this.accept(frame);}
      catch (error) {if (epoch === this.epoch) {this.failure = `Screen unavailable: ${error.message || error}. Input disabled.`; this.granted = false; this.clearQueue(); this.state();}}
      finally {this.polling = false; this.schedule(this.visible && !document.hidden ? 100 : 1000);}
    }
    accept(frame) {
      if (!frame || frame.mode !== 'pty' || frame.processId !== this.session?.processId || frame.threadId !== this.session.threadId || frame.cwd !== this.session.cwd || !['running','stopping','exited','failed'].includes(frame.state) || !Number.isSafeInteger(frame.revision) || frame.revision < 0 || !Number.isInteger(frame.cols) || frame.cols < 20 || frame.cols > 240 || !Number.isInteger(frame.rows) || frame.rows < 5 || frame.rows > 100 || (frame.screen !== undefined && (typeof frame.screen !== 'string' || new TextEncoder().encode(frame.screen).length > 3000000))) throw new Error('Invalid terminal snapshot');
      if (this.latest && frame.revision < this.latest.revision) return;
      if (frame.screen === undefined && (!this.latest || frame.revision !== this.latest.revision)) throw new Error('Terminal frame is missing');
      const hadGrant = this.granted; this.session = {...this.session, ...frame}; this.granted = frame.inputGranted === true && !this.revoked; this.failure = '';
      if (frame.screen !== undefined) this.latest = frame;
      if (!this.granted || frame.state !== 'running') this.clearQueue();
      this.changed?.(frame); this.paint(); this.state(); if (!hadGrant && this.granted) this.fit();
    }
    paint() {
      if (!this.latest || !this.visible || document.hidden || this.paused || this.selecting || this.composing || this.painting || !this.views.length || this.views[this.active].revision === this.latest.revision) return;
      const epoch = this.epoch, frame = this.latest, next = 1 - this.active, view = this.views[next], painting = {}; this.painting = painting;
      // The inactive view parses with input disabled; the coherent active view keeps fast typing intact.
      view.term.options.disableStdin = true; view.term.reset(); view.term.resize(frame.cols, frame.rows);
      view.term.write(frame.screen, () => {
        if (this.painting !== painting || this.disposed) return; this.painting = false; if (epoch !== this.epoch) {this.paint(); return;}
        if (this.paused || this.selecting || this.composing || !this.visible) return;
        const focused = this.views[this.active].node.contains(document.activeElement); this.swapping = true; this.active = next; view.revision = frame.revision; this.state(); if (focused) view.term.focus(); this.swapping = false; this.fit(); if (this.latest.revision !== frame.revision) this.paint();
      });
    }
    enqueue(bytes) {
      if (!bytes.length || !this.writable()) return;
      if (this.queued + bytes.length > 64000) {this.failure = 'Input queue limit reached. Unsent input discarded; review the terminal before continuing.'; this.revoke(); return;}
      this.queue.push(bytes); this.queued += bytes.length; if (!this.inputTimer && !this.sending) this.inputTimer = setTimeout(() => {this.inputTimer = null; this.flush();}, 8);
    }
    clearQueue() {this.queue = []; this.queued = 0; clearTimeout(this.inputTimer); this.inputTimer = null; if (this.inputToken) this.inputToken.cancelled = true;}
    async flush() {
      if (this.sending || !this.queued || !this.writable()) return;
      const size = Math.min(16000, this.queued), bytes = new Uint8Array(size); let offset = 0;
      while (offset < size) {const part = this.queue[0], count = Math.min(part.length, size - offset); bytes.set(part.subarray(0, count), offset); offset += count; if (count === part.length) this.queue.shift(); else this.queue[0] = part.subarray(count);}
      this.queued -= size; this.sending = true; const epoch = this.epoch, token = this.inputToken = {cancelled: false};
      try {await this.call('terminalInput', {processId: this.session.processId, dataBase64: btoa(String.fromCharCode(...bytes))}, token);}
      catch (error) {if (epoch === this.epoch) {this.failure = `Input not confirmed: ${error.message || error}. Unsent input discarded.`; this.revoke();}}
      finally {this.sending = false; if (this.queued) this.flush();}
    }
    fit() {
      clearTimeout(this.resizeTimer); if (!this.writable() || this.composing || this.host.clientWidth <= 0 || this.host.clientHeight <= 0) return;
      this.resizeTimer = setTimeout(async () => {
        if (!this.writable() || this.resizing) return; const dims = this.views[this.active].fit.proposeDimensions(); if (!dims) return;
        const cols = Math.max(20, Math.min(240, dims.cols)), rows = Math.max(5, Math.min(100, dims.rows)); if (cols === this.session.cols && rows === this.session.rows) return;
        const epoch = this.epoch, token = this.resizeToken = {cancelled: false}; this.resizing = true;
        try {await this.call('terminalResize', {processId: this.session.processId, cols, rows}, token); if (epoch === this.epoch) this.schedule(0);}
        catch (error) {if (epoch === this.epoch) {this.failure = `Resize not confirmed: ${error.message || error}`; this.revoke();}}
        finally {this.resizing = false; this.fit();}
      }, 100);
    }
    async authorize() {
      if (!this.session || this.session.state !== 'running' || !this.allowed || this.attaching) return;
      const epoch = this.epoch, token = this.attachToken = {cancelled: false}; this.attaching = true; this.state();
      try {const frame = await this.call('terminalAttach', {processId: this.session.processId}, token); if (epoch !== this.epoch || token.cancelled || frame.cancelled) return; this.revoked = false; this.accept(frame);}
      catch (error) {if (epoch === this.epoch) {this.failure = `Input review failed: ${error.message || error}`; this.state();}}
      finally {this.attaching = false; this.state();}
    }
    revoke() {this.epoch++; this.revoked = true; this.granted = false; this.clearQueue(); clearTimeout(this.resizeTimer); if (this.resizeToken) this.resizeToken.cancelled = true; if (this.attachToken) this.attachToken.cancelled = true; this.state();}
    focus() {this.views[this.active]?.term.focus();}
    ownsFocus() {return this.host.contains(document.activeElement);}
    dispose() {this.revoke(); this.disposed = true; clearTimeout(this.timer); this.observer.disconnect(); document.removeEventListener('pointerup', this.pointerUp); for (const view of this.views) view.term.dispose();}
  }
  window.CodingTerminal = CodingTerminal;
})();
