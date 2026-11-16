"""Local translation with a durable-in-session queue of complete speech fragments."""

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import os
import re
import time
from urllib.parse import urlsplit

import httpx

LANGUAGE_NAMES = {
    "pl": "Polish", "en": "English", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "pt": "Portuguese", "uk": "Ukrainian", "ru": "Russian", "cs": "Czech",
    "sk": "Slovak", "nl": "Dutch", "sv": "Swedish", "da": "Danish", "no": "Norwegian",
    "fi": "Finnish", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ar": "Arabic",
    "tr": "Turkish", "hi": "Hindi", "he": "Hebrew", "el": "Greek", "hu": "Hungarian",
    "ro": "Romanian", "bg": "Bulgarian", "lt": "Lithuanian", "lv": "Latvian", "et": "Estonian",
    "vi": "Vietnamese", "id": "Indonesian", "th": "Thai",
}
TARGET_LANGUAGES = {"en", "pl", "de", "uk", "fr", "es", "it", "pt", "cs", "ja", "zh", "ar"}


def display_sentences(text):
    """Authoritative display rows, sent with the transcript so translation aligns exactly."""
    rows = []
    for part in re.split(r"(?<=[.!?。！？])\s+|(?<=[。！？])(?=\S)", text.strip()):
        words = part.split()
        for index in range(0, len(words), 28):
            rows.append(" ".join(words[index:index + 28]))
    return rows


@dataclass(frozen=True)
class TranslationJob:
    id: int
    sentence_index: int
    revision: int
    source_text: str
    language: str
    target_language: str
    final: bool


class TranslationUnavailable(Exception):
    pass


class OllamaTranslator:
    def __init__(self, client=None):
        self.url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
        # Keep the promised local-only default, including environment configuration.
        parsed = urlsplit(self.url)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username:
            raise ValueError("OLLAMA_URL musi wskazywać lokalny serwer HTTP (localhost / 127.0.0.1 / ::1).")
        self.model = os.environ.get("TRANSLATION_MODEL", "translategemma:4b")
        self.client = client
        self.state = "loading"
        self.error = None
        self.last_check = 0.0
        self.check_lock = asyncio.Lock()

    def status(self):
        return {"state": self.state, "error": self.error, "model": self.model, "runtime": "Ollama · lokalnie"}

    def get_client(self):
        if self.client is None:
            self.client = httpx.AsyncClient(base_url=self.url, timeout=httpx.Timeout(20, connect=1), trust_env=False)
        return self.client

    async def check(self, force=False):
        async with self.check_lock:
            if not force and time.monotonic() - self.last_check < 10:
                return self.status()
            try:
                response = await self.get_client().get("/api/tags", timeout=2)
                response.raise_for_status()
                names = {model["name"] for model in response.json().get("models", [])}
                if self.model not in names:
                    self.state = "missing"
                    self.error = f"Brakuje modelu tłumaczącego. Uruchom: ollama pull {self.model}"
                else:
                    self.state, self.error = "ready", None
            except (httpx.HTTPError, ValueError, KeyError):
                self.state = "offline"
                self.error = "Tłumacz jest niedostępny. Uruchom Ollama (ollama serve). Same napisy nadal działają."
            self.last_check = time.monotonic()
            return self.status()

    async def prepare(self):
        await self.check(force=True)
        if self.state == "ready":
            try:
                # Load a small KV cache, not the model's maximum context window.
                response = await self.get_client().post("/api/generate", json={"model": self.model, "keep_alive": "10m", "stream": False, "options": {"num_ctx": 2048}}, timeout=45)
                response.raise_for_status()
            except httpx.HTTPError:
                # A slow preload must not prevent speech recognition from starting.
                pass

    async def translate(self, text, source, target, profile=None):
        if source not in LANGUAGE_NAMES or target not in TARGET_LANGUAGES:
            raise TranslationUnavailable("Ten język nie jest obsługiwany przez tłumacza w prototypie.")
        if source == target:
            return {"text": text, "elapsed_ms": 0, "same_language": True}
        await self.check()
        if self.state != "ready":
            raise TranslationUnavailable(self.error)
        prompt = (
            f"You are a professional {LANGUAGE_NAMES[source]} ({source}) to {LANGUAGE_NAMES[target]} ({target}) translator. "
            f"Translate the passage below into {LANGUAGE_NAMES[target]}. Preserve its meaning, names, numbers and tone. "
            f"{profile.translation_hints(text, source, target) if profile else ''}"
            "Return only the translation, with no explanations or commentary.\n\n\n"
            f"{text}"
        )
        started = time.perf_counter()
        try:
            response = await self.get_client().post("/api/chat", json={
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "keep_alive": "10m",
                "options": {"temperature": 0, "num_ctx": 2048, "num_predict": 256},
            })
            response.raise_for_status()
            data = response.json()
            translated = data.get("message", {}).get("content", "").strip()
            if not translated or data.get("done_reason") == "length":
                raise TranslationUnavailable("Nie udało się uzyskać pełnego tłumaczenia tego zdania.")
            return {"text": translated, "elapsed_ms": round((time.perf_counter() - started) * 1000), "same_language": False}
        except httpx.HTTPError as exc:
            self.last_check = 0
            raise TranslationUnavailable("Tłumaczenie nie odpowiedziało na czas. Same napisy nadal działają.") from exc

    async def close(self):
        if self.client:
            await self.client.aclose()
            self.client = None


class TranslationPipeline:
    """Coalesce revisions of the same fragment; preserve every different fragment in order."""

    def __init__(self, translator, send, min_interval=1.5, queue_limit=64, profile=None):
        self.translator = translator
        self.send = send
        self.min_interval = min_interval
        self.pending = OrderedDict()
        self.queue_limit = queue_limit
        self.wake = asyncio.Event()
        self.closed = False
        self.last_started = 0.0
        self.cache = OrderedDict()
        # Immutable per session: neither cache nor preferences cross sessions.
        self.profile = profile

    def submit(self, job):
        # Very short drafts contain too little context. Finals always get translated.
        if not job.final and len(job.source_text.split()) < 4 and len(job.source_text) < 20:
            return
        key = job.id
        old = self.pending.get(key)
        if old and (old.final or old.revision >= job.revision):
            return
        if key not in self.pending and len(self.pending) >= self.queue_limit:
            raise OverflowError("Tłumacz nie nadąża za mową. Zatrzymaj sesję, aby dokończyć zaległe tłumaczenia.")
        self.pending[key] = job
        self.wake.set()

    def finish(self):
        self.closed = True
        self.wake.set()

    async def run(self):
        while True:
            await self.wake.wait()
            if not self.pending:
                if self.closed:
                    return
                self.wake.clear()
                continue
            if not next(iter(self.pending.values())).final:
                await asyncio.sleep(max(0, self.last_started + self.min_interval - time.monotonic()))
            _, job = self.pending.popitem(last=False)
            self.wake.clear()
            key = (job.source_text, job.language, job.target_language)
            self.last_started = time.monotonic()
            base = {"id": job.id, "sentence_index": job.sentence_index, "revision": job.revision, "source_text": job.source_text, "target_language": job.target_language, "final": job.final}
            try:
                result = self.cache.get(key)
                if result is None:
                    result = await self.translator.translate(*key, profile=self.profile) if self.profile and self.profile.enabled else await self.translator.translate(*key)
                    self.cache[key] = result
                    if len(self.cache) > 64:
                        self.cache.popitem(last=False)
                await self.send({"type": "translation", "pending_count": len(self.pending), **base, **result})
            except (TranslationUnavailable, ValueError, KeyError) as exc:
                await self.send({"type": "translation_error", **base, "message": str(exc)})
            if self.pending:
                self.wake.set()
            if self.closed and not self.pending:
                return
