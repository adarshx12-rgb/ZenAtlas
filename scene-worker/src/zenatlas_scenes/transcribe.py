from __future__ import annotations

import importlib.util
import time
from collections.abc import Callable
from pathlib import Path

from .subtitles import clean_text

HEARTBEAT_SECONDS = 30
# Whisper segments run up to 30 s; a cue this short starts within a few seconds of any word in it.
MAX_CUE_SECONDS = 8.0
PAUSE_SECONDS = 0.6


def transcription_installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def word_cues(words: list[tuple[float, float, str]]) -> list[tuple[float, float, str]]:
    """Group word timings into cues of at most MAX_CUE_SECONDS, ending at a sentence end or pause once half full."""
    cues: list[tuple[float, float, str]] = []
    current: list[tuple[float, float, str]] = []
    for i, word in enumerate(words):
        current.append(word)
        following = words[i + 1] if i + 1 < len(words) else None
        span = word[1] - current[0][0]
        boundary = word[2].rstrip().endswith((".", "?", "!")) or (following is not None and following[0] - word[1] >= PAUSE_SECONDS)
        if following is None or (span >= MAX_CUE_SECONDS / 2 and boundary) or following[1] - current[0][0] > MAX_CUE_SECONDS:
            text = clean_text("".join(w[2] for w in current))
            end = max(w[1] for w in current)
            if text and end > current[0][0]:
                cues.append((float(current[0][0]), float(end), text))
            current = []
    return cues


def transcribe(path: Path, *, model_name: str, device: str, compute_type: str, heartbeat: Callable[[], None]) -> list[tuple[float, float, str]]:
    """Speech-to-text fallback for authorised local media that has no reusable subtitles."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    heartbeat()
    # Word timestamps align each word to the audio, so cue edges sit on speech rather than on 30 s decoding windows.
    segments, _info = model.transcribe(str(path), vad_filter=True, word_timestamps=True)
    cues: list[tuple[float, float, str]] = []
    last = time.monotonic()
    for segment in segments:
        if segment.words:
            cues.extend(word_cues([(w.start, w.end, w.word) for w in segment.words]))
        elif (text := clean_text(segment.text)) and segment.end > segment.start:
            cues.append((float(segment.start), float(segment.end), text))
        if time.monotonic() - last >= HEARTBEAT_SECONDS:
            heartbeat()
            last = time.monotonic()
    return cues
