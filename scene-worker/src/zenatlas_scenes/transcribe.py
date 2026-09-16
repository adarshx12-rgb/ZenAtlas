from __future__ import annotations

import importlib.util
import time
from collections.abc import Callable
from pathlib import Path

from .subtitles import clean_text

HEARTBEAT_SECONDS = 30


def transcription_installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def transcribe(path: Path, *, model_name: str, device: str, compute_type: str, heartbeat: Callable[[], None]) -> list[tuple[float, float, str]]:
    """Speech-to-text fallback for authorised local media that has no reusable subtitles."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    heartbeat()
    segments, _info = model.transcribe(str(path), vad_filter=True)
    cues: list[tuple[float, float, str]] = []
    last = time.monotonic()
    for segment in segments:
        text = clean_text(segment.text)
        if text and segment.end > segment.start:
            cues.append((float(segment.start), float(segment.end), text))
        if time.monotonic() - last >= HEARTBEAT_SECONDS:
            heartbeat()
            last = time.monotonic()
    return cues
