import test from 'node:test';
import assert from 'node:assert/strict';
import { sermonSettings, sermonConfig } from '../web/sermon.js';

test('existing saved screen preferences acquire the sermon defaults', () => {
  const defaults = sermonConfig(undefined);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.polish_edition, 'bw');
  assert.equal(defaults.english_edition, 'kjv');
});

test('settings reach the backend intact and can be explicitly disabled', () => {
  const saved = { enabled: true, polishEdition: 'ubg', englishEdition: 'mkjv', names: 'Habakuk', glossary: 'przymierze = covenant' };
  assert.deepEqual(sermonConfig(sermonSettings(saved)), { enabled: true, polish_edition: 'ubg', english_edition: 'mkjv', names: 'Habakuk', glossary: 'przymierze = covenant' });
  assert.deepEqual(sermonConfig({ enabled: false, glossary: 'unfinished draft' }), { enabled: false });
});

test('invalid glossary is rejected before acquiring the microphone', () => {
  assert.throws(() => sermonConfig({ glossary: 'missing separator' }), /Popraw słownik/);
  assert.throws(() => sermonConfig({ glossary: Array(13).fill('a = b').join('\n') }), /12 wpisów/);
  assert.throws(() => sermonConfig({ glossary: 'a = ' + 'b'.repeat(61) }), /Popraw słownik/);
});
