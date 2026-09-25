"""Existing YouTube captions for the Node worker, read with youtube-transcript-api. Only caption text is fetched, never media.

Usage: python -m zenatlas_scenes.captions <video_id> [language]
Prints one JSON object: {"status": "ok", "kind", "language", "track", "segments": [{"start", "end", "text"}]},
{"status": "none", "reason"} when the video has no usable captions (a final answer), or {"status": "error", "code"} to retry later.
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from youtube_transcript_api import (CouldNotRetrieveTranscript, NoTranscriptFound, TranscriptsDisabled, VideoUnavailable,
                                    YouTubeTranscriptApi)
from youtube_transcript_api.proxies import GenericProxyConfig

VIDEO_ID = re.compile(r"[\w-]{11}")
# Sound tags such as [Music] or [Applause] carry no speech and would match queries about music or applause.
SOUND_TAG = re.compile(r"\[[^\]]*\]|\([^)]*\)")
FINAL = (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable)


def primary(code: str | None) -> str | None:
    first = (code or "").strip().lower().split("-")[0]
    return first if re.fullmatch(r"[a-z]{2,3}", first) else None


def choose_track(tracks: list[Any], language: str | None) -> tuple[Any, str] | None:
    """Creator captions whenever any exist (the video's language, then English, then the first); else auto captions in the video's language."""
    manual = [t for t in tracks if not t.is_generated]
    auto = [t for t in tracks if t.is_generated]
    if manual:
        return next((t for t in manual if primary(t.language_code) == language), None) or \
            next((t for t in manual if primary(t.language_code) == "en"), manual[0]), "youtube_manual"
    if auto:
        return next((t for t in auto if primary(t.language_code) == language), auto[0]), "youtube_auto"
    return None


def cues(snippets: Any) -> list[tuple[float, float, str]]:
    """Ordered, non-empty cues. Auto captions overlap the next line on screen, so a cue ends where the next one starts."""
    spoken = []
    for s in snippets:
        text = " ".join(SOUND_TAG.sub(" ", s.text).split())
        if text and s.duration > 0:
            spoken.append((float(s.start), float(s.start) + float(s.duration), text))
    spoken.sort(key=lambda c: c[0])
    out: list[tuple[float, float, str]] = []
    for i, (start, end, text) in enumerate(spoken):
        following = next((c[0] for c in spoken[i + 1:] if c[0] > start), None)
        end = min(end, following) if following is not None else end
        if (start, end, text) not in out and end > start:
            out.append((start, end, text))
    return out


def default_api() -> YouTubeTranscriptApi:
    # YouTube blocks many cloud and heavily used addresses; YOUTUBE_CAPTIONS_PROXY routes the requests through a proxy.
    proxy = os.environ.get("YOUTUBE_CAPTIONS_PROXY", "").strip()
    return YouTubeTranscriptApi(proxy_config=GenericProxyConfig(http_url=proxy, https_url=proxy) if proxy else None)


def captions(video_id: str, language: str | None, api: Any = None) -> dict[str, Any]:
    if not VIDEO_ID.fullmatch(video_id):
        return {"status": "error", "code": "invalid_video_id"}
    api = api or default_api()
    try:
        chosen = choose_track(list(api.list(video_id)), primary(language))
        if chosen is None:
            return {"status": "none", "reason": "no_tracks"}
        track, kind = chosen
        segments = cues(track.fetch().snippets)
    except FINAL as error:
        return {"status": "none", "reason": type(error).__name__}
    except CouldNotRetrieveTranscript as error:
        return {"status": "error", "code": type(error).__name__}
    if not segments:
        return {"status": "none", "reason": "no_speech"}
    return {"status": "ok", "kind": kind, "language": primary(track.language_code) or "und", "track": track.language_code,
            "segments": [{"start": start, "end": end, "text": text} for start, end, text in segments]}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or len(args) > 2:
        print(json.dumps({"status": "error", "code": "usage"}))
        return 2
    try:
        answer = captions(args[0], args[1] if len(args) > 1 else None)
    except Exception as error:  # noqa: BLE001 - network failures become a retryable answer, never a traceback on stdout
        answer = {"status": "error", "code": type(error).__name__}
    sys.stdout.write(json.dumps(answer) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
