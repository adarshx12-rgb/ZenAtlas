from __future__ import annotations

import re
from bisect import bisect_right
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .subtitles import Cue, clean_text

TOLERANCE_SECONDS = 1.0
MAX_SCENES = 150
MAX_DESCRIPTION = 1000
MAX_TAGS = 12
MAX_TAG_LENGTH = 40
MAX_CITED_CUES = 50
MAX_DIALOGUE = 4000

# Gemini accepts only a subset of JSON Schema (no pattern or length keywords); strict checks happen below.
RESPONSE_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "media_viewable": {"type": "boolean", "description": "false if the video could not be watched; scenes must then be empty."},
        "scenes": {
            "type": "array",
            "maxItems": MAX_SCENES,
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "string", "description": "Scene start as MM:SS measured from the first frame of this video."},
                    "end": {"type": "string", "description": "Scene end as MM:SS measured from the first frame of this video."},
                    "description": {"type": "string", "description": "Observable action, setting, people, objects, on-screen text and non-speech sounds; at most 1000 characters."},
                    "tags": {"type": "array", "maxItems": MAX_TAGS, "items": {"type": "string"}},
                    "subtitle_cue_ids": {"type": "array", "maxItems": MAX_CITED_CUES, "items": {"type": "integer", "minimum": 1}},
                },
                "required": ["start", "end", "description", "tags", "subtitle_cue_ids"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["media_viewable", "scenes"],
    "additionalProperties": False,
}


class _Scene(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    start: str = Field(max_length=16)
    end: str = Field(max_length=16)
    description: str = Field(max_length=4 * MAX_DESCRIPTION)
    tags: list[str] = Field(max_length=MAX_TAGS)
    subtitle_cue_ids: list[int] = Field(max_length=MAX_CITED_CUES)


class _Response(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    media_viewable: bool
    scenes: list[_Scene] = Field(max_length=MAX_SCENES)


@dataclass(frozen=True)
class AcceptedScene:
    media_start: float
    media_end: float
    start: float
    end: float
    description: str
    tags: tuple[str, ...]
    dialogue: str | None
    segment_ids: tuple[str, ...]


@dataclass(frozen=True)
class ValidatedScenes:
    scenes: list[AcceptedScene]
    rejected: Counter[str]
    adjusted: int


class ModelOutputRejected(Exception):
    def __init__(self, code: str, rejected: Counter[str] | None = None):
        super().__init__(code)
        self.code = code
        self.rejected = rejected or Counter()


_TIMESTAMP = re.compile(r"(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?")


def parse_timestamp(value: str) -> float | None:
    match = _TIMESTAMP.fullmatch(value.strip())
    if not match:
        return None
    hours, minutes, seconds, fraction = match.groups()
    if hours is not None and int(minutes) > 59:
        return None
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + (int(fraction.ljust(3, "0")) / 1000 if fraction else 0.0)


def _tags(values: Sequence[str]) -> tuple[str, ...]:
    tags: list[str] = []
    for value in values:
        tag = clean_text(value).lower()
        if tag and len(tag) <= MAX_TAG_LENGTH and tag not in tags:
            tags.append(tag)
    return tuple(tags)


def validate_scenes(
    text: str, *, media_duration: float, timeline_offset: float, content_duration: float | None, cues: Sequence[Cue]
) -> ValidatedScenes:
    """Accept only well-formed scenes inside the analysed media and the content timeline.

    Timestamps may be moved by at most the one-second granularity of MM:SS output. Anything further out is
    rejected, and a response where most scenes are rejected is discarded entirely rather than partially trusted.
    """
    try:
        parsed = _Response.model_validate_json(text)
    except ValidationError:
        raise ModelOutputRejected("invalid_model_output") from None
    if not parsed.media_viewable:
        raise ModelOutputRejected("model_could_not_view_media")
    lower = max(0.0, -timeline_offset)
    upper = media_duration if content_duration is None else min(media_duration, content_duration - timeline_offset)
    if upper <= lower:
        raise ModelOutputRejected("no_timeline_overlap")
    by_id = {cue.id: cue for cue in cues}
    rejected: Counter[str] = Counter()
    adjusted = 0
    candidates: list[tuple[float, float, str, tuple[str, ...]]] = []
    for scene in parsed.scenes:
        start, end = parse_timestamp(scene.start), parse_timestamp(scene.end)
        if start is None or end is None:
            rejected["bad_timestamp"] += 1
            continue
        if start < lower:
            if lower - start > TOLERANCE_SECONDS:
                rejected["outside_timeline"] += 1
                continue
            start, adjusted = lower, adjusted + 1
        if end > upper:
            if end - upper > TOLERANCE_SECONDS:
                rejected["outside_timeline"] += 1
                continue
            end, adjusted = upper, adjusted + 1
        if end <= start:
            rejected["non_positive_duration"] += 1
            continue
        description = clean_text(scene.description)
        if not description:
            rejected["empty_description"] += 1
            continue
        if len(description) > MAX_DESCRIPTION:
            rejected["description_too_long"] += 1
            continue
        cited = [by_id.get(cue_id) for cue_id in scene.subtitle_cue_ids]
        if any(cue is None or cue.end < start - TOLERANCE_SECONDS or cue.start > end + TOLERANCE_SECONDS for cue in cited):
            rejected["subtitle_reference_mismatch"] += 1
            continue
        candidates.append((start, end, description, _tags(scene.tags)))

    candidates.sort(key=lambda item: (item[0], item[1]))
    ordered: list[tuple[float, float, str, tuple[str, ...]]] = []
    for start, end, description, tags in candidates:
        if ordered and start < ordered[-1][1]:
            previous_end = ordered[-1][1]
            if previous_end - start > TOLERANCE_SECONDS or end <= previous_end:
                rejected["overlap"] += 1
                continue
            start, adjusted = previous_end, adjusted + 1
        ordered.append((start, end, description, tags))

    if sum(rejected.values()) * 2 > len(parsed.scenes):
        raise ModelOutputRejected("model_timestamps_unreliable", rejected)
    return ValidatedScenes(_attach_dialogue(ordered, cues, timeline_offset, content_duration), rejected, adjusted)


def _attach_dialogue(
    scenes: list[tuple[float, float, str, tuple[str, ...]]], cues: Sequence[Cue], offset: float, content_duration: float | None
) -> list[AcceptedScene]:
    """Quote subtitle text deterministically: each cue belongs to the scene containing its midpoint."""
    starts = [scene[0] for scene in scenes]
    assigned: list[list[Cue]] = [[] for _ in scenes]
    for cue in cues:
        middle = (cue.start + cue.end) / 2
        index = bisect_right(starts, middle) - 1
        if index >= 0 and middle < scenes[index][1]:
            assigned[index].append(cue)
    accepted: list[AcceptedScene] = []
    for (start, end, description, tags), matched in zip(scenes, assigned):
        texts: list[str] = []
        segment_ids: list[str] = []
        length = 0
        for cue in matched:
            if length + len(cue.text) + 1 > MAX_DIALOGUE:
                break
            texts.append(cue.text)
            length += len(cue.text) + 1
            if cue.segment_id:
                segment_ids.append(cue.segment_id)
        canonical_end = end + offset if content_duration is None else min(end + offset, content_duration)
        accepted.append(AcceptedScene(start, end, max(0.0, start + offset), canonical_end, description, tags,
                                      " ".join(texts) or None, tuple(segment_ids)))
    return accepted
