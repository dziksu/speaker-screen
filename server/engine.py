"""The GPU model lives on one dedicated thread, outside the ASGI event loop."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
import os
from pathlib import Path
import platform
import time

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL_REPO = "mlx-community/whisper-large-v3-turbo"
MODEL_PATH = Path(os.environ.get("WHISPER_MODEL_PATH", ROOT / ".models" / "whisper-large-v3-turbo"))


class WhisperEngine:
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper-mlx")
        self.state = "loading"
        self.error = None
        self.started = time.monotonic()

    def status(self):
        return {"state": self.state, "error": self.error, "model": "Whisper large-v3-turbo", "runtime": "MLX · Apple Silicon"}

    async def prepare(self):
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            self.state = "error"
            self.error = "Ten backend MLX wymaga macOS z Apple Silicon."
            return
        if not (MODEL_PATH / "config.json").is_file() or not (MODEL_PATH / "weights.safetensors").is_file():
            self.state = "missing"
            self.error = "Pobierz model: ./setup.sh"
            return
        try:
            await asyncio.get_running_loop().run_in_executor(self.executor, self._warmup)
            self.state = "ready"
        except Exception:
            logging.exception("Model initialization failed")
            self.state = "error"
            self.error = "Nie udało się wczytać modelu. Sprawdź log serwera i uruchom ./setup.sh."

    def _warmup(self):
        # Runtime never downloads anything; download_model.py is the network step.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        self._transcribe(np.zeros(16_000, dtype=np.float32), "pl")

    def _transcribe(self, audio, language, initial_prompt=None):
        import mlx_whisper

        started = time.perf_counter()
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=str(MODEL_PATH),
            language=None if language == "auto" else language,
            task="transcribe",
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt,
            word_timestamps=False,
            verbose=None,
        )
        segments = result.get("segments", [])
        text = " ".join(
            s["text"].strip() for s in segments
            if s.get("no_speech_prob", 0) < 0.8 and s.get("avg_logprob", 0) > -1.2
        ).strip()
        return {"text": text, "language": result.get("language", language), "elapsed_ms": round((time.perf_counter() - started) * 1000)}

    async def transcribe(self, audio, language, initial_prompt=None):
        return await asyncio.get_running_loop().run_in_executor(self.executor, self._transcribe, audio, language, initial_prompt)
