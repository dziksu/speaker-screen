import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionBridge, outputMode, outputLocation, outputUrl, popupFeatures } from '../web/projection.js';

class MemoryChannel {
  static rooms = new Map();
  constructor(name) {
    this.name = name;
    if (!MemoryChannel.rooms.has(name)) MemoryChannel.rooms.set(name, new Set());
    MemoryChannel.rooms.get(name).add(this);
  }
  postMessage(data) {
    for (const channel of MemoryChannel.rooms.get(this.name)) {
      if (channel !== this) channel.onmessage?.({ data: structuredClone(data) });
    }
  }
  close() { MemoryChannel.rooms.get(this.name).delete(this); }
}

const state = (text = 'Pierwsze zdanie.') => ({ items: [{ id: '1-1', text, revision: 1 }], translations: [], settings: { fontSize: 44, sourceSize: 44, targetLanguage: 'en' }, phase: 'recording', language: 'pl', modelState: 'ready', translationState: 'ready' });
const bridge = args => new ProjectionBridge({ channelClass: MemoryChannel, windowRef: null, timers: false, room: 'test-room-1234567890', ...args });

test('output URLs isolate a projection session and normalize its view', () => {
  const url = outputUrl('http://localhost:8765/?other=1#test', 'room-1234567890123456', 'display-123456789012', 'translation');
  const info = outputLocation(url);
  assert.equal(info.viewer, true);
  assert.equal(info.mode, 'translation');
  assert.equal(info.room, 'room-1234567890123456');
  assert.equal(new URL(url).searchParams.has('other'), false);
  assert.equal(outputMode('unknown'), 'both');
  assert.equal(outputLocation('http://localhost:8765/?output=source&room=bad').room, null);
  assert.equal(outputLocation('http://localhost:8765/').viewer, false);
});

test('monitor geometry supports a display to the left of the primary screen', () => {
  assert.equal(popupFeatures({ availLeft: -1920, availTop: 25, availWidth: 1920, availHeight: 1055 }), 'popup,left=-1920,top=25,width=1920,height=1055');
  assert.equal(popupFeatures(null), 'popup,width=1280,height=800');
});

test('a late opened projection gets full history, then revisions and clear', () => {
  const received = [];
  const source = bridge({ role: 'controller', id: 'controller' });
  const initial = state();
  source.publish(initial);
  const viewer = bridge({ role: 'viewer', id: 'viewer', onState: value => received.push(value) });
  assert.equal(received[0].items[0].text, 'Pierwsze zdanie.');
  source.publish(initial);
  assert.equal(received.length, 1, 'unchanged data is not repeatedly broadcast');
  source.publish(state('Poprawione zdanie.'));
  assert.equal(received.at(-1).items[0].text, 'Poprawione zdanie.');
  source.publish({ ...state(), items: [], translations: [] });
  assert.equal(received.at(-1).items.length, 0);
  viewer.dispose(); source.dispose();
});

test('different sessions cannot see each other and old snapshots cannot roll back captions', () => {
  const received = [];
  const source = bridge({ role: 'controller', id: 'controller' });
  const viewer = bridge({ role: 'viewer', id: 'viewer', onState: value => received.push(value) });
  const isolated = bridge({ role: 'viewer', id: 'isolated', room: 'different-room', onState: () => assert.fail('Wrong session') });
  source.publish(state('Latest.'));
  source.send('state', { revision: 0, state: state('Old.') });
  assert.equal(received.length, 1);
  assert.equal(received[0].items[0].text, 'Latest.');
  isolated.dispose(); viewer.dispose(); source.dispose();
});

test('each projection changes its own view without changing other viewers', () => {
  const source = bridge({ role: 'controller', id: 'controller' });
  const first = bridge({ role: 'viewer', id: 'first', view: 'source' });
  const second = bridge({ role: 'viewer', id: 'second', view: 'translation' });
  first.setView('both');
  assert.equal(source.peers.get('first').view, 'both');
  assert.equal(source.peers.get('second').view, 'translation');
  first.dispose();
  const received = [];
  second.onState = value => received.push(value);
  source.publish(state('Still recording.'));
  assert.equal(received[0].items[0].text, 'Still recording.');
  second.dispose(); source.dispose();
});

test('controller close signals disconnection while retaining the last readable state', () => {
  let now = 0;
  const statuses = [];
  const received = [];
  const source = bridge({ role: 'controller', id: 'controller', now: () => now });
  const viewer = bridge({ role: 'viewer', id: 'viewer', now: () => now, onState: value => received.push(value), onStatus: value => statuses.push(value) });
  source.publish(state('Keep this text.'));
  assert.equal(statuses.at(-1), 'connected');
  source.dispose();
  now = 10_000;
  viewer.tick();
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(received.at(-1).items[0].text, 'Keep this text.');
  viewer.dispose();
});

test('popup postMessage fallback synchronizes without BroadcastChannel', () => {
  const handlers = { parent: new Set(), child: new Set() };
  const parent = { location: { origin: 'http://localhost:8765' }, addEventListener: (_, fn) => handlers.parent.add(fn), removeEventListener: (_, fn) => handlers.parent.delete(fn) };
  const child = { location: parent.location, opener: parent, addEventListener: (_, fn) => handlers.child.add(fn), removeEventListener: (_, fn) => handlers.child.delete(fn) };
  parent.postMessage = message => { for (const handler of handlers.parent) handler({ data: structuredClone(message), origin: parent.location.origin, source: child }); };
  child.postMessage = message => { for (const handler of handlers.child) handler({ data: structuredClone(message), origin: parent.location.origin, source: parent }); };
  const source = bridge({ role: 'controller', id: 'controller', channelClass: null, windowRef: parent });
  source.publish(state('Fallback works.'));
  const received = [];
  const viewer = bridge({ role: 'viewer', id: 'viewer', channelClass: null, windowRef: child, onState: value => received.push(value) });
  assert.equal(received[0].items[0].text, 'Fallback works.');
  viewer.dispose(); source.dispose();
});
