"""Bounded, sample-clock driven audio segmentation. Input is 16 kHz mono PCM."""

from collections import deque
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16_000


@dataclass
class AudioJob:
    id: int
    revision: int
    audio: np.ndarray
    final: bool


class Segmenter:
    def __init__(self, threshold=0.008, silence_seconds=0.8, max_seconds=12.0):
        self.threshold = threshold
        self.silence_limit = round(silence_seconds * SAMPLE_RATE)
        self.max_samples = round(max_seconds * SAMPLE_RATE)
        self.preroll = deque(maxlen=3)  # Browser sends 100 ms packets.
        self.parts = []
        self.samples = self.voiced = self.silence = self.last_partial = 0
        self.id = self.revision = 0

    def push(self, audio: np.ndarray) -> list[AudioJob]:
        # Reject DC, which otherwise looks like a permanently open microphone.
        centered = audio - audio.mean()
        speaking = float(np.sqrt(np.mean(centered * centered))) >= self.threshold
        if not self.parts:
            if not speaking:
                self.preroll.append(audio.copy())
                return []
            self.id += 1
            self.revision = 0
            self.parts = list(self.preroll)
            self.samples = sum(len(p) for p in self.parts)
            self.preroll.clear()

        self.parts.append(audio.copy())
        self.samples += len(audio)
        self.voiced += len(audio) if speaking else 0
        self.silence = 0 if speaking else self.silence + len(audio)
        if self.silence >= self.silence_limit or self.samples >= self.max_samples:
            return self.flush()
        if self.voiced >= SAMPLE_RATE * 0.35 and self.samples - self.last_partial >= SAMPLE_RATE:
            self.last_partial = self.samples
            return [self.snapshot(final=False)]
        return []

    def snapshot(self, final: bool) -> AudioJob:
        self.revision += 1
        return AudioJob(self.id, self.revision, np.concatenate(self.parts), final)

    def flush(self) -> list[AudioJob]:
        jobs = [self.snapshot(final=True)] if self.parts and self.voiced >= SAMPLE_RATE * 0.25 else []
        self.parts = []
        self.samples = self.voiced = self.silence = self.last_partial = 0
        self.preroll.clear()
        return jobs


class JobQueue:
    """Replace waiting drafts with the newest snapshot; never drop a final."""

    def __init__(self, limit=8):
        self.items: deque[AudioJob] = deque()
        self.limit = limit

    def put(self, job: AudioJob):
        self.items = deque(old for old in self.items if old.id != job.id)
        if len(self.items) >= self.limit:
            raise OverflowError("Model nie nadąża za dźwiękiem. Zatrzymaj i rozpocznij ponownie.")
        self.items.append(job)

    def pop(self):
        return self.items.popleft()

    def __bool__(self):
        return bool(self.items)
