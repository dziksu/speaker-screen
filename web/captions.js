// Pure state helpers. The model can revise the live utterance without rewriting history.
export function upsertTranscript(items, event) {
  const index = items.findIndex(item => item.id === event.id);
  if (index >= 0) {
    const old = items[index];
    if (old.final || event.revision <= old.revision) return items;
    const next = items.slice();
    next[index] = { ...event };
    return next;
  }
  return [...items, { ...event }];
}

const segmenter = new Intl.Segmenter('pl', { granularity: 'sentence' });
export function sentenceRows(items) {
  return items.flatMap(item => {
    if (Array.isArray(item.sentences)) {
      return item.sentences.map((text, index) => ({ id: `${item.id}:${index}`, text, final: item.final, language: item.language, revision: item.revision }));
    }
    let n = 0;
    return [...segmenter.segment(item.text.trim())].flatMap(({ segment }) => {
      // A long unpunctuated speech still needs to move up instead of filling the screen.
      const words = segment.trim().split(/\s+/).filter(Boolean);
      const rows = [];
      while (words.length) {
        rows.push({ id: `${item.id}:${n}`, text: words.splice(0, 28).join(' '), final: item.final, language: item.language, revision: item.revision, demoTranslation: item.demoTranslations?.[n++] });
      }
      return rows;
    });
  });
}

function normalized(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// An older prefix can remain visible while its continuation is translated.
// Corrections to its meaning, another sentence or another language invalidate it.
export function translationForRow(row, translation, target) {
  if (!row || !translation || row.id !== translation.id || target !== translation.target_language) return null;
  const current = normalized(row.text);
  const source = normalized(translation.source_text);
  return source && (current === source || current.startsWith(`${source} `)) ? translation : null;
}

export function upsertTranslation(items, event, sources, target) {
  const source = sources.find(item => item.id === event.id);
  if (!translationForRow(source, event, target)) return items;
  const index = items.findIndex(item => item.id === event.id && item.target_language === event.target_language);
  if (index < 0) return [...items, { ...event }];
  const old = items[index];
  if (old.revision > event.revision || (old.final && !old.error && old.revision === event.revision)) return items;
  const result = items.slice();
  result[index] = { ...event };
  return result;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
