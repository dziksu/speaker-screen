import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../web/audio-worklet.js', import.meta.url), 'utf8');
for (const sampleRate of [16000, 44100, 48000]) {
  test(`audio worklet emits 16 kHz PCM without drift from ${sampleRate} Hz`, () => {
    const messages = [];
    let Processor;
    const context = { sampleRate, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } }, registerProcessor: (_, value) => { Processor = value; } };
    vm.runInNewContext(source, context);
    const worklet = new Processor();
    const signal = new Float32Array(sampleRate);
    for (let i = 0; i < signal.length; i++) signal[i] = 0.25 * Math.sin(2 * Math.PI * 220 * i / sampleRate);
    for (let i = 0; i < signal.length; i += 128) worklet.process([[signal.subarray(i, i + 128)]]);
    worklet.port.onmessage({ data: 'flush' });
    const packets = messages.filter(m => m.audio).map(m => new Int16Array(m.audio));
    assert.equal(packets.reduce((n, p) => n + p.length, 0), 16000);
    assert.ok(Math.max(...packets[0]) > 8000);
    assert.ok(Math.max(...packets[0]) < 8300);
    assert.equal(messages.at(-1).flushed, true);
    const count = messages.length;
    worklet.process([[signal.subarray(0, 128)]]);
    assert.equal(messages.length, count);
  });
}
