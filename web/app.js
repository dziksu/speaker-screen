import { upsertTranscript, sentenceRows, formatTime, translationForRow, upsertTranslation } from './captions.js';
import { OUTPUT_LABELS, outputMode, outputLocation, outputUrl, popupFeatures, ProjectionBridge } from './projection.js';
import { sermonSettings, sermonConfig } from './sermon.js';

const $ = id => document.getElementById(id);
const outputInfo = outputLocation(location.href);
const isOutput = outputInfo.viewer;
const projectionRoom = isOutput ? outputInfo.room : crypto.randomUUID();
const projectionId = outputInfo.id || crypto.randomUUID();
let viewMode = isOutput ? outputInfo.mode : 'both';
let projectionBridge = null;
let screenDetails = null;
let outputToolsTimer;
const openedOutputs = new Map();
let phase = 'idle';
let modelState = 'loading';
let items = [];
let session = null;
let sessionNumber = 0;
let demoTimer = null;
let clockTimer = null;
let startedAt = 0;
let fullscreenTimer;
let frame;
let latestId = 0;
let ignoredThrough = 0;
let translations = [];
let readingPaused = false;
const following = { source: true, translation: true };
const highlightSentences = new Intl.Segmenter('pl', { granularity: 'sentence' });
let translationState = 'loading';
const settings = { fontSize: 44, sourceSize: 44, noiseGate: 8, targetLanguage: 'en', layoutVersion: 5 };
try {
  const saved = JSON.parse(localStorage.getItem('speaker-screen-settings') || '{}');
  Object.assign(settings, saved);
  settings.layoutVersion = 5;
} catch { /* Storage may be unavailable. */ }
settings.sermon = sermonSettings(settings.sermon);

function notice(message) {
  $('notice-text').textContent = message;
  $('notice').hidden = !message;
}
$('dismiss-notice').onclick = () => notice('');

function updateControls() {
  const active = phase === 'recording' || phase === 'demo';
  const busy = phase === 'connecting' || phase === 'stopping';
  $('start-button').disabled = busy || (!active && modelState !== 'ready');
  $('start-button').classList.toggle('recording', active);
  $('start-label').textContent = ({ recording: 'Zatrzymaj', demo: 'Zatrzymaj demo', connecting: 'Łączenie mikrofonu…', stopping: 'Kończę tłumaczenie…' })[phase] || (modelState === 'ready' ? 'Rozpocznij nasłuch' : modelState === 'loading' ? 'Ładowanie modelu…' : 'Model niedostępny');
  $('microphone').disabled = phase !== 'idle';
  $('language').disabled = phase !== 'idle';
  $('target-language').disabled = phase !== 'idle';
  $('sermon-fields').disabled = phase !== 'idle';
  $('session-label').textContent = ({ recording: 'Słucham na żywo', demo: 'Podgląd działania', connecting: 'Przygotowuję mikrofon', stopping: 'Domykam tłumaczenia' })[phase] || (items.length ? 'Sesja zatrzymana' : 'Gotowy do startu');
  $('session-dot').classList.toggle('active', active);
  $('demo-badge').hidden = phase !== 'demo';
  $('stage-label').textContent = phase === 'demo' ? 'TAK WYGLĄDAJĄ TWOJE SŁOWA NA ŻYWO' : active ? 'SŁOWA NA ŻYWO' : 'TWÓJ GŁOS, W CENTRUM UWAGI';
  $('demo-button').hidden = phase !== 'idle';
  render();
}

function renderFeed(kind, entries) {
  const feed = $(`${kind}-feed`);
  const container = $(`${kind}-text`);
  const existing = new Map([...container.children].map(node => [node.dataset.id, node]));
  const wanted = new Set(entries.map(entry => entry.id));
  const currentIndex = entries.findLastIndex(entry => !entry.error && entry.text.trim());
  for (const node of [...container.children]) if (!wanted.has(node.dataset.id)) node.remove();
  for (const [position, entry] of entries.entries()) {
    let node = existing.get(entry.id);
    if (!node) {
      node = document.createElement('p');
      node.dataset.id = entry.id;
      node.dir = 'auto';
    }
    if (node.textContent !== entry.text) {
      const content = document.createDocumentFragment();
      for (const { segment } of highlightSentences.segment(entry.text)) {
        const sentence = document.createElement('span');
        sentence.className = 'sentence';
        sentence.textContent = segment;
        content.append(sentence);
      }
      node.replaceChildren(content);
    }
    node.className = (entry.error ? 'feed-error' : entry.final ? 'committed' : 'draft') + (position === currentIndex ? ' current-paragraph' : '');
    node.lang = entry.language || '';
    // Move only if out of order; existing paragraphs stay in place for readers.
    if (container.children[position] !== node) container.insertBefore(node, container.children[position] || null);
  }
  if (following[kind] && !readingPaused) feed.scrollTop = feed.scrollHeight;
}

function updateFollowButton() {
  const live = !readingPaused && following.source && following.translation;
  $('follow-button').textContent = live ? 'Wstrzymaj przewijanie Ⅱ' : 'Wróć do najnowszych ↓';
  $('follow-button').classList.toggle('paused', !live);
  $('follow-button').setAttribute('aria-pressed', String(!live));
  $('viewer-follow').textContent = live ? 'Wstrzymaj przewijanie' : 'Wróć do najnowszych';
  $('viewer-follow').setAttribute('aria-pressed', String(!live));
}

function resetReading() {
  readingPaused = false;
  following.source = following.translation = true;
}

for (const kind of ['source', 'translation']) {
  $(`${kind}-feed`).addEventListener('scroll', () => {
    const feed = $(`${kind}-feed`);
    if (!readingPaused) following[kind] = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    updateFollowButton();
  }, { passive: true });
}
$('follow-button').onclick = () => {
  if (readingPaused || !following.source || !following.translation) {
    resetReading();
    for (const kind of ['source', 'translation']) $(`${kind}-feed`).scrollTop = $(`${kind}-feed`).scrollHeight;
  } else {
    readingPaused = true;
    following.source = following.translation = false;
  }
  updateFollowButton();
};

function render() {
  // Publish before requestAnimationFrame: background operator tabs may not paint,
  // but the audience must still receive every live caption and translation.
  publishProjection();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const active = ['recording', 'stopping', 'connecting'].includes(phase);
    const isDemo = items.some(item => item.demoTranslations);
    const target = isDemo ? 'en' : settings.targetLanguage;
    const count = sentenceRows(items).length;
    $('empty-state').hidden = items.length > 0 || active;
    $('listening-state').hidden = items.length > 0 || !active;
    $('caption-area').hidden = items.length === 0;
    $('sentence-count').textContent = count ? `${count} ${count === 1 ? 'ZDANIE' : 'ZDAŃ'} W HISTORII SESJI` : 'EKRAN GOTOWY NA TWOJE SŁOWA';
    $('source-language').textContent = (items.at(-1)?.language || $('language').value).toUpperCase();
    $('translation-language').textContent = target.toUpperCase();
    const showSource = viewMode !== 'translation';
    const showTranslation = viewMode !== 'source' && target !== 'off';
    $('source-panel').hidden = !showSource;
    $('translation-panel').hidden = !showTranslation;
    $('empty-output').hidden = showSource || showTranslation;
    $('caption-area').classList.toggle('source-only', showSource && !showTranslation);
    $('caption-area').classList.toggle('translation-only', !showSource && showTranslation);
    $('sentence-label').textContent = isDemo ? 'PRZYKŁADOWE TEKSTY · TRYB DEMO · PL → EN' : 'HISTORIA POZOSTAJE DOSTĘPNA · PRZEWIŃ, ABY WRÓCIĆ DO WCZEŚNIEJSZYCH ZDAŃ';
    renderFeed('source', items.filter(item => item.text).map(item => ({ ...item, text: item.text })));
    const candidates = new Map(translations.filter(item => item.target_language === target).map(item => [item.id, item]));
    const translated = [];
    let pending = 0;
    let failed = 0;
    for (const source of items) {
      if (source.demoTranslations) {
        if (source.final) translated.push({ id: source.id, text: source.demoTranslations.join(' '), final: true, language: 'en' });
        else pending++;
        continue;
      }
      if (source.target_language !== target) continue;
      const result = translationForRow(source, candidates.get(source.id), target);
      if (result?.error) {
        failed++;
        translated.push({ id: source.id, text: `Tłumaczenie niedostępne: ${result.error}`, error: true, language: 'pl' });
      } else if (result) {
        translated.push({ id: source.id, text: result.text, final: result.final, language: target });
        if (source.final && !result.final) pending++;
      } else pending++;
    }
    renderFeed('translation', translated);
    $('translation-progress').textContent = failed ? `Nie udało się przetłumaczyć ${failed} fragmentów. Sprawdź Ollama.`
      : !isDemo && translationState !== 'ready' && target !== 'off' ? 'Tłumacz niedostępny. Uruchom Ollama; oryginał jest zachowany.'
      : pending ? `Tłumaczę kolejne fragmenty (${pending})… Poprzednie pozostają do przeczytania.`
      : translated.length ? (active ? 'Słucham dalej. Każdy kolejny fragment zostanie dopisany.' : 'Tłumaczenie zakończone. Cała historia pozostaje do przeczytania.')
      : 'Tłumaczenie pojawi się tutaj podczas nasłuchu.';
    updateFollowButton();
  });
}

function startClock() {
  clearInterval(clockTimer);
  startedAt = Date.now();
  $('session-time').textContent = '00:00';
  clockTimer = setInterval(() => { $('session-time').textContent = formatTime((Date.now() - startedAt) / 1000); }, 1000);
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const selected = $('microphone').value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const options = [new Option('Domyślny mikrofon', '')];
    for (const [index, device] of devices.entries()) {
      if (device.deviceId && device.deviceId !== 'default') options.push(new Option(device.label || `Mikrofon ${index + 1}`, device.deviceId));
    }
    $('microphone').replaceChildren(...options);
    if ([...$('microphone').options].some(o => o.value === selected)) $('microphone').value = selected;
  } catch { /* Device names become available after microphone permission. */ }
}
if (!isOutput) navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);

async function releaseAudio(s) {
  s.node?.disconnect();
  s.source?.disconnect();
  s.stream?.getTracks().forEach(track => track.stop());
  if (s.context && s.context.state !== 'closed') await s.context.close().catch(() => {});
}

function finish(s, error = '') {
  if (session !== s) return;
  session = null;
  s.cancelled = true;
  clearTimeout(s.stopTimeout);
  clearInterval(clockTimer);
  releaseAudio(s);
  if (s.ws && s.ws.readyState < 2) s.ws.close();
  phase = 'idle';
  if (error) notice(error);
  updateControls();
}

async function start() {
  if (isOutput) return;
  if (phase !== 'idle' || modelState !== 'ready') return;
  let sermon;
  try { sermon = sermonConfig(settings.sermon); }
  catch (error) { notice(error.message); $('sermon-settings').showPopover(); return; }
  stopDemo();
  notice('');
  if (items.some(item => item.demoTranslations)) { items = []; translations = []; resetReading(); }
  latestId = ignoredThrough = 0;
  phase = 'connecting';
  const s = { number: ++sessionNumber };
  session = s;
  $('privacy-note').textContent = 'Dźwięk zostaje na Twoim komputerze.';
  updateControls();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Mikrofon wymaga bezpiecznej strony. Otwórz aplikację przez http://localhost:8765 lub HTTPS.');
    s.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('microphone').value ? { exact: $('microphone').value } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (s.cancelled) { await releaseAudio(s); return; }
    await refreshDevices();
    s.context = new AudioContext();
    await s.context.audioWorklet.addModule('/assets/audio-worklet.js');
    s.source = s.context.createMediaStreamSource(s.stream);
    s.node = new AudioWorkletNode(s.context, 'pcm-capture');
    const silence = s.context.createGain();
    silence.gain.value = 0;
    s.node.connect(silence).connect(s.context.destination);
    s.node.port.onmessage = ({ data }) => {
      if (data.flushed) { s.onFlushed?.(); return; }
      if (data.audio && session === s && s.ws?.readyState === WebSocket.OPEN) {
        if (s.ws.bufferedAmount > 128000) { finish(s, 'Połączenie nie nadąża za dźwiękiem. Rozpocznij nową sesję.'); return; }
        s.ws.send(data.audio);
      }
    };
    s.stream.getAudioTracks()[0].addEventListener('ended', () => { if (session === s) stop(); });
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    s.ws = new WebSocket(`${protocol}//${location.host}/ws`);
    s.ws.onopen = () => s.ws.send(JSON.stringify({ type: 'start', language: $('language').value, target_language: settings.targetLanguage, threshold: Number(settings.noiseGate) / 1000, sermon }));
    s.ws.onmessage = async ({ data }) => {
      if (session !== s) return;
      const event = JSON.parse(data);
      if (event.type === 'ready') {
        s.source.connect(s.node);
        await s.context.resume();
        if (session !== s) return;
        phase = 'recording';
        startClock();
        $('latency').textContent = 'czekam na pierwsze słowa';
        updateControls();
      } else if (event.type === 'transcript') {
        latestId = Math.max(latestId, event.id);
        if (event.id <= ignoredThrough) return;
        items = upsertTranscript(items, { ...event, id: `${s.number}-${event.id}`, target_language: settings.targetLanguage });
        $('latency').textContent = `rozpoznawanie ${(event.elapsed_ms / 1000).toFixed(1)} s · ${event.language.toUpperCase()}`;
        render();
      } else if (event.type === 'translation' || event.type === 'translation_error') {
        if (!event.id) { notice(event.message); return; }
        if (event.id <= ignoredThrough) return;
        const candidate = {
          ...event,
          id: `${s.number}-${event.id}`,
          error: event.type === 'translation_error' ? event.message : null
        };
        translations = upsertTranslation(translations, candidate, items, settings.targetLanguage);
        render();
      } else if (event.type === 'error') finish(s, event.message);
      else if (event.type === 'stopped') finish(s);
    };
    s.ws.onerror = () => finish(s, 'Nie można połączyć się z backendem. Sprawdź, czy ./start.sh nadal działa.');
    s.ws.onclose = () => { if (session === s) finish(s, 'Połączenie zostało przerwane. Napisy zachowano na ekranie; możesz rozpocząć ponownie.'); };
  } catch (error) {
    const messages = { NotAllowedError: 'Udostępnij mikrofon tej stronie w ustawieniach przeglądarki i spróbuj ponownie.', NotFoundError: 'Nie znaleziono mikrofonu. Podłącz go i spróbuj ponownie.', NotReadableError: 'Mikrofon jest niedostępny lub używany przez inną aplikację.', OverconstrainedError: 'Wybrany mikrofon nie jest dostępny. Wybierz inny.' };
    finish(s, messages[error.name] || error.message || 'Nie udało się uruchomić mikrofonu.');
  }
}

async function stop() {
  if (phase === 'demo') { stopDemo(); return; }
  if (phase !== 'recording' || !session) return;
  const s = session;
  phase = 'stopping';
  updateControls();
  await Promise.race([new Promise(resolve => { s.onFlushed = resolve; s.node.port.postMessage('flush'); }), new Promise(resolve => setTimeout(resolve, 300))]);
  if (session !== s) return;
  if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'stop' }));
  await releaseAudio(s);
  // Keep the socket open to drain every queued translation after stopping the mic.
  // Each model request has its own server-side timeout.
}

$('start-button').onclick = () => phase === 'idle' ? start() : stop();
$('clear-button').onclick = () => {
  if (phase === 'demo') stopDemo();
  items = [];
  translations = [];
  resetReading();
  ignoredThrough = latestId;
  $('latency').textContent = phase === 'recording' ? 'czekam na kolejne słowa' : 'bez pośpiechu, bez rozpraszania';
  notice('');
  updateControls();
};

const demoSentences = [
  'Dobre pomysły zaczynają się od rozmowy.',
  'Każde słowo zasługuje na to, żeby je usłyszeć.',
  'A teraz można je również zobaczyć.',
  'To, co najważniejsze, dzieje się właśnie teraz.',
  'Ty mówisz. Reszta płynie dalej.'
];
const demoTranslations = [
  ['Good ideas begin with a conversation.'],
  ['Every word deserves to be heard.'],
  ['And now you can see them, too.'],
  ['What matters most is happening right now.'],
  ['You speak.', 'The rest flows on.']
];
function stopDemo() {
  clearTimeout(demoTimer);
  demoTimer = null;
  if (phase === 'demo') { clearInterval(clockTimer); phase = 'idle'; $('target-language').value = settings.targetLanguage; $('privacy-note').textContent = 'Dźwięk zostaje na Twoim komputerze.'; updateControls(); }
}
$('demo-button').onclick = () => {
  if (isOutput) return;
  if (phase !== 'idle') return;
  notice('');
  items = [];
  translations = [];
  resetReading();
  phase = 'demo';
  $('target-language').value = 'en';
  startClock();
  $('latency').textContent = 'przykładowy tekst · mikrofon wyłączony';
  $('privacy-note').textContent = 'Tryb demo. To przykładowy tekst, mikrofon jest wyłączony.';
  updateControls();
  let sentence = 0;
  let word = 0;
  function tick() {
    if (phase !== 'demo') return;
    const words = demoSentences[sentence].split(' ');
    word++;
    items = upsertTranscript(items, { id: `demo-${sentence}`, revision: word, text: words.slice(0, word).join(' '), final: word === words.length, language: 'pl', demoTranslations: demoTranslations[sentence] });
    render();
    if (word === words.length) { sentence++; word = 0; }
    if (sentence === demoSentences.length) { demoTimer = setTimeout(() => { stopDemo(); $('privacy-note').textContent = 'Dźwięk zostaje na Twoim komputerze.'; }, 3000); return; }
    demoTimer = setTimeout(tick, word === 0 ? 1650 : 240);
  }
  tick();
};

$('settings-button').onclick = () => $('settings').togglePopover();
$('settings').addEventListener('toggle', event => $('settings-button').setAttribute('aria-expanded', String(event.newState === 'open')));
$('sermon-button').onclick = () => $('sermon-settings').togglePopover();
$('sermon-settings').addEventListener('toggle', event => $('sermon-button').setAttribute('aria-expanded', String(event.newState === 'open')));
const sermonInputs = [['sermon-enabled', 'enabled'], ['polish-edition', 'polishEdition'], ['english-edition', 'englishEdition'], ['sermon-names', 'names'], ['sermon-glossary', 'glossary']];
for (const [id, key] of sermonInputs) {
  $(id).addEventListener('input', () => {
    settings.sermon[key] = key === 'enabled' ? $(id).checked : $(id).value;
    applySettings();
  });
}
function applySettings() {
  if (![...$('target-language').options].some(option => option.value === settings.targetLanguage)) settings.targetLanguage = 'en';
  $('target-language').value = settings.targetLanguage;
  settings.fontSize = Math.max(32, Math.min(88, Number(settings.fontSize) || 44));
  settings.sourceSize = Math.max(32, Math.min(88, Number(settings.sourceSize) || 44));
  settings.noiseGate = Math.max(2, Math.min(30, Number(settings.noiseGate) || 8));
  settings.sermon = sermonSettings(settings.sermon);
  for (const [id, key] of sermonInputs) {
    if (key === 'enabled') $(id).checked = settings.sermon.enabled;
    else { $(id).value = settings.sermon[key]; $(id).disabled = !settings.sermon.enabled; }
  }
  $('sermon-button').classList.toggle('sermon-active', settings.sermon.enabled);
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--source-size', `${settings.sourceSize}px`);
  document.documentElement.style.setProperty('--source-column', `${settings.sourceSize}fr`);
  document.documentElement.style.setProperty('--translation-column', `${settings.fontSize}fr`);
  for (const [id, key] of [['font-size', 'fontSize'], ['source-size', 'sourceSize'], ['noise-gate', 'noiseGate']]) {
    $(id).value = settings[key];
    $(`${id}-value`).textContent = `${settings[key]}${key === 'fontSize' || key === 'sourceSize' ? ' px' : ''}`;
  }
  if (!isOutput) {
    try { localStorage.setItem('speaker-screen-settings', JSON.stringify(settings)); } catch { /* Optional persistence. */ }
  }
  render();
}
$('target-language').onchange = () => {
  settings.targetLanguage = $('target-language').value;
  applySettings();
};
for (const [id, key] of [['font-size', 'fontSize'], ['source-size', 'sourceSize'], ['noise-gate', 'noiseGate']]) {
  $(id).addEventListener('input', () => {
    const value = Number($(id).value);
    settings[key] = value;
    applySettings();
  });
}

function revealControls() {
  revealOutputTools();
  if (!document.body.classList.contains('projecting')) return;
  document.body.classList.add('controls-visible');
  $('fullscreen-hint').hidden = false;
  clearTimeout(fullscreenTimer);
  fullscreenTimer = setTimeout(() => {
    if (['settings', 'display-settings', 'sermon-settings'].some(id => $(id).matches(':popover-open'))) return;
    document.body.classList.remove('controls-visible');
    $('fullscreen-hint').hidden = true;
  }, 2600);
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else throw new Error('Ta przeglądarka nie udostępnia pełnego ekranu. Użyj Chrome lub Edge.');
  } catch (error) { notice(error.message); }
}
$('fullscreen-button').onclick = fullscreen;
document.addEventListener('fullscreenchange', () => {
  const enabled = Boolean(document.fullscreenElement);
  document.body.classList.toggle('projecting', enabled);
  if (enabled) { $('settings').hidePopover(); $('display-settings').hidePopover(); $('sermon-settings').hidePopover(); revealControls(); }
  else { document.body.classList.remove('controls-visible'); $('fullscreen-hint').hidden = true; }
  render();
});
document.addEventListener('mousemove', revealControls);
document.addEventListener('touchstart', revealControls, { passive: true });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || event.target.isContentEditable) return;
  if (!isOutput && event.code === 'Space' && (document.fullscreenElement || !['BUTTON', 'A'].includes(event.target.tagName))) { event.preventDefault(); phase === 'idle' ? start() : stop(); }
  if (event.code === 'KeyF') { event.preventDefault(); fullscreen(); }
});
window.addEventListener('resize', render);
window.addEventListener('pagehide', () => {
  projectionBridge?.dispose();
  if (session) { session.stream?.getTracks().forEach(track => track.stop()); session.ws?.close(); }
});

async function pollStatus() {
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('status');
    const data = await response.json();
    translationState = data.translation?.state || 'offline';
    $('translation-badge').className = `model-badge ${translationState === 'ready' ? 'ready' : translationState === 'loading' ? 'loading' : 'error'}`;
    $('translation-badge').title = data.translation?.error || 'TranslateGemma 4B · tłumaczenie lokalne przez Ollama';
    modelState = data.state;
    $('model-badge').className = `model-badge ${modelState === 'ready' ? 'ready' : modelState === 'loading' ? 'loading' : 'error'}`;
    $('model-label').textContent = modelState === 'ready' ? data.model : modelState === 'loading' ? 'Ładowanie modelu MLX' : 'Model niedostępny';
    $('model-badge').title = data.error || `${data.runtime} · przetwarzanie lokalne`;
    if ((modelState === 'missing' || modelState === 'error') && !session) notice(data.error);
  } catch {
    translationState = 'offline';
    $('translation-badge').className = 'model-badge error';
    modelState = 'error';
    $('model-label').textContent = 'Backend niedostępny';
    $('model-badge').className = 'model-badge error';
    if (phase === 'idle') notice('Uruchom lokalny serwer poleceniem ./start.sh. Podgląd demo jest dostępny bez modelu.');
  }
  updateControls();
  setTimeout(pollStatus, modelState === 'loading' ? 1500 : 10000);
}

function publishProjection() {
  if (isOutput || !projectionBridge) return;
  projectionBridge.publish({
    items, translations, phase, modelState, translationState,
    language: $('language').value,
    settings: { fontSize: settings.fontSize, sourceSize: settings.sourceSize, targetLanguage: settings.targetLanguage, noiseGate: settings.noiseGate }
  });
}

function updateOutputList(peers) {
  const list = $('output-list');
  list.replaceChildren();
  const liveIds = new Set(peers.map(peer => peer.id));
  for (const [id, record] of openedOutputs) {
    if (record.window.closed) openedOutputs.delete(id);
  }
  const rows = new Map([...openedOutputs].map(([id, record]) => [id, { id, view: record.view, label: record.label }]));
  for (const peer of peers) rows.set(peer.id, { ...rows.get(peer.id), ...peer });
  for (const row of rows.values()) {
    const element = document.createElement('div');
    element.className = 'output-row';
    const label = document.createElement('a');
    label.textContent = `${OUTPUT_LABELS[row.view]}${liveIds.has(row.id) ? ' · połączono' : ' · łączenie…'}`;
    label.href = outputUrl(location.href, projectionRoom, row.id, row.view);
    label.target = `speaker-screen-${row.id}`;
    label.title = `${row.label || 'Osobne okno'} · pokaż projekcję`;
    label.onclick = event => {
      const child = openedOutputs.get(row.id)?.window;
      if (child && !child.closed) { event.preventDefault(); child.focus(); }
    };
    const close = document.createElement('button');
    close.textContent = 'Zamknij';
    close.onclick = () => { projectionBridge.closeViewer(row.id); openedOutputs.delete(row.id); updateOutputList([...projectionBridge.peers.values()]); };
    element.append(label, close);
    list.append(element);
  }
  $('open-outputs').hidden = rows.size === 0;
  $('cast-count').hidden = rows.size === 0;
  $('cast-count').textContent = rows.size;
}

function populateMonitors() {
  const previous = $('output-monitor').value;
  const options = [new Option('Osobne okno — przeniosę ręcznie', 'manual')];
  for (const [index, screen] of screenDetails.screens.entries()) {
    const name = screen.label || `Ekran ${index + 1}`;
    options.push(new Option(`${name} · ${screen.width}×${screen.height}${screen === screenDetails.currentScreen ? ' · bieżący' : ''}`, String(index)));
  }
  $('output-monitor').replaceChildren(...options);
  const external = screenDetails.screens.findIndex(screen => screen !== screenDetails.currentScreen);
  $('output-monitor').value = options.some(option => option.value === previous) && previous !== 'manual' ? previous : external >= 0 ? String(external) : 'manual';
}

function setupControllerProjection() {
  projectionBridge = new ProjectionBridge({ role: 'controller', room: projectionRoom, id: projectionId, onPeers: updateOutputList });
  $('cast-button').onclick = () => $('display-settings').togglePopover();
  $('display-settings').addEventListener('toggle', event => $('cast-button').setAttribute('aria-expanded', String(event.newState === 'open')));
  $('main-output').onchange = () => { viewMode = outputMode($('main-output').value); render(); };
  $('main-output-fullscreen').onclick = () => { $('display-settings').hidePopover(); fullscreen(); };
  if (typeof window.getScreenDetails !== 'function') {
    $('detect-monitors').disabled = true;
    $('display-help').textContent = 'W tej przeglądarce przenieś osobne okno ręcznie na drugi monitor, a następnie włącz w nim pełny ekran.';
  }
  $('detect-monitors').onclick = async () => {
    try {
      screenDetails = await window.getScreenDetails();
      populateMonitors();
      screenDetails.addEventListener('screenschange', populateMonitors);
      $('display-help').textContent = 'Wybierz monitor. Przeglądarka może wymagać osobnego kliknięcia „Pełny ekran” w oknie projekcji.';
    } catch {
      $('display-help').textContent = 'Nie uzyskano dostępu do monitorów. Możesz nadal otworzyć okno i przenieść je ręcznie.';
    }
  };
  $('open-output').onclick = () => {
    const mode = outputMode($('external-output').value);
    const selected = $('output-monitor').value;
    const screen = selected === 'manual' ? null : screenDetails?.screens[Number(selected)];
    const id = crypto.randomUUID();
    const url = outputUrl(location.href, projectionRoom, id, mode);
    // Must be synchronous with this click, otherwise popup blockers reject it.
    let windowRef;
    try { windowRef = window.open(url, `speaker-screen-${id}`, popupFeatures(screen)); } catch { windowRef = null; }
    if (!windowRef) {
      $('display-help').textContent = 'Przeglądarka zablokowała nowe okno. Zezwól na wyskakujące okna dla tej aplikacji i spróbuj ponownie.';
      return;
    }
    projectionBridge.attach(id, windowRef);
    openedOutputs.set(id, { window: windowRef, view: mode, label: screen?.label || 'Osobne okno' });
    updateOutputList([...projectionBridge.peers.values()]);
    publishProjection();
    $('display-help').textContent = 'Okno projekcji otwarte. W nim możesz włączyć pełny ekran lub zmienić wyświetlaną treść.';
  };
  publishProjection();
}

function revealOutputTools() {
  if (!isOutput) return;
  document.body.classList.add('output-tools-visible');
  clearTimeout(outputToolsTimer);
  outputToolsTimer = setTimeout(() => document.body.classList.remove('output-tools-visible'), 3000);
}

function setupOutputViewer() {
  document.body.classList.add('output-window', 'output-disconnected');
  document.title = `Speaker Screen — ${OUTPUT_LABELS[viewMode]}`;
  $('output-toolbar').hidden = false;
  $('viewer-output').value = viewMode;
  $('empty-state').querySelector('h1').textContent = 'Czekam na napisy.';
  $('empty-state').querySelector('p').textContent = 'Rozpocznij nasłuch w panelu sterowania.';
  $('listening-state').querySelector('h2').textContent = 'Czekam na słowa.';
  $('listening-state').querySelector('p').textContent = 'Napisy pojawią się automatycznie.';
  $('viewer-fullscreen').onclick = event => {
    fullscreen();
    if (event.detail) event.currentTarget.blur();
  };
  $('viewer-follow').onclick = () => $('follow-button').click();
  $('viewer-output').onchange = () => {
    viewMode = outputMode($('viewer-output').value);
    const url = new URL(location.href);
    url.searchParams.set('output', viewMode);
    history.replaceState(null, '', url);
    projectionBridge?.setView(viewMode);
    document.title = `Speaker Screen — ${OUTPUT_LABELS[viewMode]}`;
    render();
  };
  if (!projectionRoom) {
    $('output-connection').textContent = 'Otwórz projekcję z ikony ekranów w panelu sterowania.';
    document.body.classList.add('output-disconnected');
    applySettings();
    return;
  }
  projectionBridge = new ProjectionBridge({
    role: 'viewer', room: projectionRoom, id: projectionId, view: viewMode,
    onState: state => {
      items = state.items;
      translations = state.translations;
      for (const key of ['fontSize', 'sourceSize', 'targetLanguage', 'noiseGate']) if (Object.hasOwn(state.settings, key)) settings[key] = state.settings[key];
      phase = ['idle', 'recording', 'stopping', 'connecting', 'demo'].includes(state.phase) ? state.phase : 'idle';
      modelState = state.modelState;
      translationState = state.translationState;
      if ([...$('language').options].some(option => option.value === state.language)) $('language').value = state.language;
      applySettings();
    },
    onStatus: status => {
      document.body.classList.toggle('output-disconnected', status !== 'connected');
      $('output-connection').textContent = status === 'connected' ? 'Połączono z panelem' : 'Panel rozłączony · ostatnie napisy zachowane';
    },
    onClose: () => window.close()
  });
  applySettings();
  revealOutputTools();
}

if (isOutput) {
  setupOutputViewer();
} else {
  applySettings();
  refreshDevices();
  pollStatus();
  setupControllerProjection();
}
