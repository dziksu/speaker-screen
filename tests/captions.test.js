import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertTranscript, sentenceRows, formatTime, translationForRow, upsertTranslation } from '../web/captions.js';

test('a revision replaces a draft, a final can never be rewritten', () => {
  let rows = upsertTranscript([], { id: 1, revision: 1, text: 'Mój glos', final: false });
  rows = upsertTranscript(rows, { id: 1, revision: 2, text: 'Mój głos.', final: true });
  assert.equal(rows.length, 1);
  assert.equal(upsertTranscript(rows, { id: 1, revision: 3, text: 'błąd' }), rows);
  assert.equal(rows[0].text, 'Mój głos.');
});

test('out of order drafts do not roll back text', () => {
  const rows = [{ id: 1, revision: 3, text: 'Całe zdanie', final: false }];
  assert.equal(upsertTranscript(rows, { id: 1, revision: 2, text: 'Całe' }), rows);
});

test('only the last sentence stays active while earlier sentences become history', () => {
  const rows = sentenceRows([{ id: 1, text: 'To pierwsze zdanie. A to następne! Ostatnie jeszcze trwa' }]);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).text, 'Ostatnie jeszcze trwa');
  assert.equal(rows[0].id, '1:0');
});

test('long speech without punctuation gets bounded display phrases', () => {
  const rows = sentenceRows([{ id: 1, text: Array(90).fill('słowo').join(' ') }]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.text.split(' ').length <= 28));
});

test('long sessions retain earlier text for the audience to read', () => {
  let rows = [];
  for (let i = 0; i < 1000; i++) rows = upsertTranscript(rows, { id: i, revision: 1, text: 'Zdanie.' });
  assert.equal(rows.length, 1000);
  assert.equal(rows[0].id, 0);
});

test('late translations update their own paragraph after newer speech has arrived', () => {
  const sources = [{ id: '1-1', text: 'Pierwsze zdanie.' }, { id: '1-2', text: 'Drugie zdanie.' }];
  let translations = upsertTranslation([], { id: '1-2', source_text: 'Drugie zdanie.', text: 'Second sentence.', target_language: 'en', revision: 2, final: true }, sources, 'en');
  translations = upsertTranslation(translations, { id: '1-1', source_text: 'Pierwsze zdanie.', text: 'First sentence.', target_language: 'en', revision: 3, final: true }, sources, 'en');
  assert.equal(translations.length, 2);
  assert.equal(translations.find(item => item.id === '1-1').text, 'First sentence.');
  assert.equal(upsertTranslation(translations, { id: '1-1', source_text: 'Pierwsze zdanie.', text: 'Old draft', target_language: 'en', revision: 1 }, sources, 'en'), translations);
});

test('session clock does not wrap after an hour', () => {
  assert.equal(formatTime(3601), '60:01');
  assert.equal(formatTime(9.8), '00:09');
});

test('backend display rows are authoritative for translation alignment', () => {
  const rows = sentenceRows([{ id: '1-2', text: 'One. Two.', sentences: ['One.', 'Two.'], language: 'en', revision: 4, final: true }]);
  assert.equal(rows.at(-1).id, '1-2:1');
  assert.equal(rows.at(-1).text, 'Two.');
  assert.equal(rows.at(-1).language, 'en');
});

test('late translations never attach to another sentence, language or corrected meaning', () => {
  const row = { id: '1-2:0', text: 'Poszedłem do banku nad rzeką.' };
  const translation = { id: row.id, source_text: 'Poszedłem do banku.', target_language: 'en', text: 'I went to the bank.' };
  assert.equal(translationForRow(row, translation, 'en'), translation);
  assert.equal(translationForRow({ ...row, id: '1-2:1' }, translation, 'en'), null);
  assert.equal(translationForRow({ ...row, text: 'Nie poszedłem do banku.' }, translation, 'en'), null);
  assert.equal(translationForRow(row, translation, 'de'), null);
});
