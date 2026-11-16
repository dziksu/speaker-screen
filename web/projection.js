// Local browser-to-browser projection. A projector never opens an audio connection.
export const OUTPUT_LABELS = { both: 'Oryginał i tłumaczenie', source: 'Tylko oryginał', translation: 'Tylko tłumaczenie' };
const MARKER = 'speaker-screen-projection-v1';
const tokenPattern = /^[a-zA-Z0-9_-]{16,128}$/;
export const outputMode = value => Object.hasOwn(OUTPUT_LABELS, value) ? value : 'both';

export function outputLocation(url) {
  const params = new URL(url).searchParams;
  return {
    viewer: params.has('output'),
    mode: outputMode(params.get('output')),
    room: tokenPattern.test(params.get('room') || '') ? params.get('room') : null,
    id: tokenPattern.test(params.get('display') || '') ? params.get('display') : null,
  };
}

export function outputUrl(base, room, id, mode) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('output', outputMode(mode));
  url.searchParams.set('room', room);
  url.searchParams.set('display', id);
  return url.href;
}

export function popupFeatures(screen) {
  if (!screen) return 'popup,width=1280,height=800';
  const number = (value, fallback) => Number.isFinite(value) ? Math.round(value) : fallback;
  return `popup,left=${number(screen.availLeft, 0)},top=${number(screen.availTop, 0)},width=${Math.max(320, number(screen.availWidth, 1280))},height=${Math.max(240, number(screen.availHeight, 800))}`;
}

export class ProjectionBridge {
  constructor({ role, room, id, view = 'both', onState = () => {}, onStatus = () => {}, onPeers = () => {}, onClose = () => {}, windowRef = globalThis.window, channelClass = globalThis.BroadcastChannel, now = Date.now, timers = true }) {
    Object.assign(this, { role, room, id, onState, onStatus, onPeers, onClose, windowRef, now });
    this.view = outputMode(view);
    this.epoch = globalThis.crypto.randomUUID();
    this.revision = 0;
    this.sequence = 0;
    this.lastSeen = now();
    this.state = null;
    this.appliedRevision = -1;
    this.appliedEpoch = null;
    this.seen = new Set();
    this.peers = new Map();
    this.windows = new Map();
    this.disposed = false;
    this.origin = windowRef?.location.origin;
    if (channelClass) {
      try {
        this.channel = new channelClass(`${MARKER}-${room}`);
        this.channel.onmessage = event => this.receive(event.data);
      } catch { /* postMessage remains available for popup windows. */ }
    }
    this.messageHandler = event => {
      if (event.origin !== this.origin) return;
      if (this.role === 'viewer' && event.source !== this.windowRef.opener) return;
      this.receive(event.data, event.source);
    };
    windowRef?.addEventListener('message', this.messageHandler);
    if (timers) this.timer = setInterval(() => this.tick(), 2000);
    if (role === 'viewer') this.send('hello', { view: this.view, revision: -1 });
  }

  send(kind, payload = {}, to = null) {
    if (this.disposed) return;
    const message = { marker: MARKER, room: this.room, from: this.id, role: this.role, sequence: ++this.sequence, epoch: this.epoch, kind, payload, to };
    this.channel?.postMessage(message);
    // Also support environments without BroadcastChannel. Messages are deduplicated.
    if (this.role === 'controller') {
      for (const [id, window] of this.windows) {
        if (!to || id === to) {
          try { if (!window.closed) window.postMessage(message, this.origin); } catch { /* Closed window. */ }
        }
      }
    } else {
      try { this.windowRef?.opener?.postMessage(message, this.origin); } catch { /* Parent closed. */ }
    }
  }

  receive(message, senderWindow = null) {
    if (this.disposed || !message || message.marker !== MARKER || message.room !== this.room || message.from === this.id || (message.to && message.to !== this.id)) return;
    if (message.role !== (this.role === 'controller' ? 'viewer' : 'controller')) return;
    const key = `${message.from}:${message.epoch}:${message.sequence}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
    const payload = message.payload || {};
    if (this.role === 'controller') {
      if (!['hello', 'ping', 'bye'].includes(message.kind)) return;
      if (senderWindow) this.windows.set(message.from, senderWindow);
      if (message.kind === 'bye') {
        this.peers.delete(message.from);
        if (this.windows.get(message.from)?.closed) this.windows.delete(message.from);
        this.onPeers([...this.peers.values()]);
        return;
      }
      const previous = this.peers.get(message.from);
      const peer = { id: message.from, view: outputMode(payload.view), lastSeen: this.now() };
      this.peers.set(message.from, peer);
      if (!previous || previous.view !== peer.view) this.onPeers([...this.peers.values()]);
      this.send('heartbeat', {}, peer.id);
      if (this.state && (message.kind === 'hello' || payload.revision !== this.revision || payload.epoch !== this.epoch)) this.sendState(peer.id);
      return;
    }
    this.lastSeen = this.now();
    if (message.kind === 'offline') { this.setStatus('disconnected'); return; }
    if (message.kind === 'close') { this.onClose(); return; }
    if (message.kind === 'state') {
      const state = payload.state;
      if (!state || !Array.isArray(state.items) || !Array.isArray(state.translations) || !state.settings) return;
      if (this.appliedEpoch === message.epoch && payload.revision <= this.appliedRevision) return;
      this.appliedEpoch = message.epoch;
      this.appliedRevision = payload.revision;
      this.onState(state);
    }
    if (this.appliedRevision >= 0) this.setStatus('connected');
  }

  publish(state) {
    if (this.role !== 'controller') return;
    const meta = JSON.stringify([state.settings, state.phase, state.modelState, state.translationState, state.language]);
    if (this.state?.items === state.items && this.state?.translations === state.translations && this.meta === meta) return;
    this.meta = meta;
    this.state = state;
    this.revision++;
    this.sendState();
  }

  sendState(to = null) { this.send('state', { state: this.state, revision: this.revision }, to); }

  attach(id, window) { this.windows.set(id, window); }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  closeViewer(id) {
    this.send('close', {}, id);
    try { this.windows.get(id)?.close(); } catch { /* Viewer can still use its own close button. */ }
    this.windows.delete(id);
    this.peers.delete(id);
    this.onPeers([...this.peers.values()]);
  }

  tick() {
    if (this.role === 'viewer') {
      if (this.now() - this.lastSeen > 8000) this.setStatus('disconnected');
      this.send('ping', { view: this.view, revision: this.appliedRevision, epoch: this.appliedEpoch });
    } else {
      this.send('heartbeat');
      let changed = false;
      for (const [id, window] of this.windows) {
        if (window.closed) { this.windows.delete(id); this.peers.delete(id); changed = true; }
      }
      if (changed) this.onPeers([...this.peers.values()]);
    }
  }

  setView(view) {
    this.view = outputMode(view);
    this.send('ping', { view: this.view, revision: this.appliedRevision, epoch: this.appliedEpoch });
  }

  dispose() {
    if (this.disposed) return;
    this.send(this.role === 'controller' ? 'offline' : 'bye');
    this.disposed = true;
    clearInterval(this.timer);
    this.channel?.close();
    this.windowRef?.removeEventListener('message', this.messageHandler);
  }
}
