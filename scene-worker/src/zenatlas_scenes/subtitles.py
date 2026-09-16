from __future__ import annotations

import hashlib
import html
import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

MAX_SUBTITLE_BYTES = 2 * 1024 * 1024
MAX_CUES = 20000
MAX_PROMPT_CHARS = 120_000

_CUE_TIME = re.compile(r"(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})")
_TIMING = re.compile(r"(\S+)\s+-->\s+(\S+)(?:\s+.*)?")
_TAGS = re.compile(r"<[^>]*>")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class SubtitleError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Cue:
    """A subtitle cue on the analysed media timeline, in seconds."""

    id: int
    start: float
    end: float
    text: str
    segment_id: str | None = None


def clean_text(value: str) -> str:
    return " ".join(_CONTROL.sub(" ", html.unescape(_TAGS.sub(" ", value))).split())


def parse_cue_time(value: str) -> float:
    match = _CUE_TIME.fullmatch(value)
    if not match:
        raise SubtitleError("subtitle_malformed")
    hours, minutes, seconds, fraction = match.groups()
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(fraction.ljust(3, "0")) / 1000


def parse_subtitles(data: bytes, *, name: str) -> list[tuple[float, float, str]]:
    """Parse SRT or WebVTT cues on the subtitle file's own timeline. Malformed files are rejected, not repaired."""
    if len(data) > MAX_SUBTITLE_BYTES:
        raise SubtitleError("subtitle_too_large")
    lowered = name.lower()
    is_vtt = lowered.endswith(".vtt")
    if not is_vtt and not lowered.endswith(".srt"):
        raise SubtitleError("subtitle_unsupported_format")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise SubtitleError("subtitle_malformed") from None
    blocks = [block for block in re.split(r"\n[ \t]*\n", text.replace("\r\n", "\n").replace("\r", "\n").strip()) if block.strip()]
    if is_vtt:
        if not blocks or not re.fullmatch(r"WEBVTT(?:[ \t].*)?", blocks[0].split("\n", 1)[0]):
            raise SubtitleError("subtitle_malformed")
        blocks.pop(0)
    cues: list[tuple[float, float, str]] = []
    for block in blocks:
        rows = block.split("\n")
        if is_vtt and re.fullmatch(r"(?:NOTE|STYLE|REGION)(?:[ \t].*)?", rows[0]):
            continue
        index = next((i for i, row in enumerate(rows[:2]) if "-->" in row), None)
        match = _TIMING.fullmatch(rows[index].strip()) if index is not None else None
        if match is None:
            raise SubtitleError("subtitle_malformed")
        start, end = parse_cue_time(match[1]), parse_cue_time(match[2])
        if end <= start:
            raise SubtitleError("subtitle_malformed")
        body = clean_text(" ".join(rows[index + 1:]))
        if body:
            cues.append((start, end, body))
        if len(cues) > MAX_CUES:
            raise SubtitleError("subtitle_too_large")
    return sorted(cues)


def media_cues(raw: Iterable[tuple[float, float, str, str | None]], *, offset: float, media_duration: float) -> list[Cue]:
    """Shift cues onto the media timeline and keep only the portion inside the media."""
    cues: list[Cue] = []
    for start, end, text, segment_id in sorted(raw, key=lambda item: (item[0], item[1])):
        shifted_start, shifted_end = max(0.0, start + offset), min(media_duration, end + offset)
        if shifted_end > shifted_start:
            cues.append(Cue(len(cues) + 1, round(shifted_start, 3), round(shifted_end, 3), text, segment_id))
    if len(cues) > MAX_CUES:
        raise SubtitleError("subtitle_too_large")
    return cues


def cues_sha256(cues: Sequence[Cue]) -> str:
    payload = json.dumps([[c.start, c.end, c.text, c.segment_id] for c in cues], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def format_timestamp(seconds: float) -> str:
    minutes, remainder = divmod(int(seconds), 60)
    return f"{minutes:02d}:{remainder:02d}"


def prompt_block(cues: Sequence[Cue]) -> str:
    # JSON lines keep cue text from breaking out of the delimited data block.
    block = "\n".join(json.dumps({"id": c.id, "start": format_timestamp(c.start), "end": format_timestamp(c.end), "text": c.text},
                                 ensure_ascii=False) for c in cues)
    if len(block) > MAX_PROMPT_CHARS:
        raise SubtitleError("subtitle_too_large")
    return block
