import asyncio
from contextlib import asynccontextmanager, suppress
import json
import logging
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import numpy as np

from .audio import JobQueue, Segmenter
from .engine import ROOT, WhisperEngine
from .sermon import SermonProfile
from .translation import OllamaTranslator, TARGET_LANGUAGES, TranslationJob, TranslationPipeline, display_sentences

engine = WhisperEngine()
translator = OllamaTranslator()
microphone_lock = asyncio.Lock()
LANGUAGES = {"auto", "pl", "en", "de", "fr", "es", "it", "pt", "uk", "ru", "cs", "sk", "nl", "sv", "da", "no", "fi", "ja", "ko", "zh", "ar", "tr", "hi", "he", "el", "hu", "ro", "bg", "lt", "lv", "et", "vi", "id", "th"}


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(engine.prepare())
    translation_task = asyncio.create_task(translator.prepare())
    yield
    task.cancel()
    translation_task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    with suppress(asyncio.CancelledError):
        await translation_task
    await translator.close()
    engine.executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Speaker Screen", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=ROOT / "web"), name="assets")


@app.get("/")
async def index():
    return FileResponse(ROOT / "web" / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/status")
async def status():
    return {**engine.status(), "busy": microphone_lock.locked(), "translation": await translator.check()}


@app.websocket("/ws")
async def microphone(ws: WebSocket):
    # Do not let another website record into a locally running instance.
    origin = ws.headers.get("origin")
    if origin and urlsplit(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)
        return
    await ws.accept()
    if engine.state != "ready" or microphone_lock.locked():
        await ws.send_json({"type": "error", "message": "Mikrofon jest używany w innej karcie." if microphone_lock.locked() else engine.error or "Model jeszcze się ładuje."})
        await ws.close(code=1013)
        return
    async with microphone_lock:
        worker = None
        translation_worker = None
        try:
            config = await asyncio.wait_for(ws.receive_json(), timeout=10)
            language = config.get("language", "auto")
            threshold = float(config.get("threshold", 0.008))
            target_language = config.get("target_language", "en")
            profile = SermonProfile.from_config(config.get("sermon"))
            if language not in LANGUAGES or not 0.002 <= threshold <= 0.05 or target_language not in TARGET_LANGUAGES | {"off"}:
                raise ValueError("Nieprawidłowe ustawienia audio.")
            segmenter = Segmenter(threshold=threshold)
            queue = JobQueue()
            wake = asyncio.Event()
            stopping = False
            translations = TranslationPipeline(translator, ws.send_json, profile=profile)
            if target_language != "off":
                translation_worker = asyncio.create_task(translations.run())

            def submit(jobs):
                for job in jobs:
                    queue.put(job)
                if jobs:
                    wake.set()

            async def recognize():
                while True:
                    await wake.wait()
                    while queue:
                        job = queue.pop()
                        prompt = profile.asr_prompt(language)
                        result = await engine.transcribe(job.audio, language, initial_prompt=prompt) if prompt else await engine.transcribe(job.audio, language)
                        sentences = display_sentences(result["text"])
                        await ws.send_json({"type": "transcript", "id": job.id, "revision": job.revision, "final": job.final, "audio_seconds": round(len(job.audio) / 16000, 2), "sentences": sentences, **result})
                        if sentences and target_language != "off":
                            # Translate the complete fragment, including all its sentences.
                            # Only its draft is replaceable; later fragments must never erase it.
                            translations.submit(TranslationJob(job.id, 0, job.revision, result["text"], result["language"], target_language, job.final))
                    wake.clear()
                    if stopping:
                        return

            worker = asyncio.create_task(recognize())
            await ws.send_json({"type": "ready"})
            while True:
                incoming = asyncio.create_task(ws.receive())
                # Surface inference failures even if the microphone is quiet.
                done, _ = await asyncio.wait({incoming, worker}, return_when=asyncio.FIRST_COMPLETED)
                if worker in done:
                    incoming.cancel()
                    with suppress(asyncio.CancelledError):
                        await incoming
                    await worker
                    break
                message = incoming.result()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    data = message["bytes"]
                    if not 0 < len(data) <= 6400 or len(data) % 2:
                        raise ValueError("Nieprawidłowy pakiet audio (wymagane PCM16, mono, 16 kHz).")
                    audio = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
                    submit(segmenter.push(audio))
                elif message.get("text"):
                    command = json.loads(message["text"])
                    if command.get("type") == "stop":
                        submit(segmenter.flush())
                        stopping = True
                        wake.set()
                        await worker
                        translations.finish()
                        if translation_worker:
                            await translation_worker
                        await ws.send_json({"type": "stopped"})
                        await ws.close()
                        break
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            if isinstance(exc, (ValueError, OverflowError)):
                logging.warning("Audio session rejected: %s", exc)
            else:
                logging.exception("Audio session failed")
            with suppress(Exception):
                await ws.send_json({"type": "error", "message": str(exc) if isinstance(exc, (ValueError, OverflowError)) else "Błąd rozpoznawania. Sprawdź log serwera i spróbuj ponownie."})
                await ws.close(code=1011)
        finally:
            if translation_worker:
                translation_worker.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await translation_worker
            if worker:
                worker.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await worker
