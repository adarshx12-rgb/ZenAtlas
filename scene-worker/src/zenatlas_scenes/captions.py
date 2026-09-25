"""Existing YouTube captions for the Node worker. Only caption text is fetched, never media.

Usage: python -m zenatlas_scenes.captions <video_id> [language] [--via=supadata]
By default youtube-transcript-api reads YouTube directly. With --via=supadata the Supadata API (SUPADATA_API_KEY) returns the
same captions; the Node worker uses it only while YouTube blocks direct requests.
Prints one JSON object: {"status": "ok", "kind", "language", "track", "segments": [{"start", "end", "text"}]},
{"status": "none", "reason"} when the video has no usable captions (a final answer), or {"status": "error", "code"} to retry later.
A block after the track list was read also carries the chosen "kind", "track" and "language".
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

import time
from dataclasses import dataclass

import requests
from youtube_transcript_api import (CouldNotRetrieveTranscript, NoTranscriptFound, TranscriptsDisabled, VideoUnavailable,
                                    YouTubeTranscriptApi)
from youtube_transcript_api.proxies import GenericProxyConfig

VIDEO_ID = re.compile(r"[\w-]{11}")
# Sound tags such as [Music] or [Applause] carry no speech and would match queries about music or applause.
SOUND_TAG = re.compile(r"\[[^\]]*\]|\([^)]*\)")
FINAL = (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable)
SUPADATA = "https://api.supadata.ai/v1/transcript"
SUPADATA_WAIT_SECONDS = 90


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
    chosen = None
    try:
        chosen = choose_track(list(api.list(video_id)), primary(language))
        if chosen is None:
            return {"status": "none", "reason": "no_tracks"}
        track, kind = chosen
        segments = cues(track.fetch().snippets)
    except FINAL as error:
        return {"status": "none", "reason": type(error).__name__}
    except CouldNotRetrieveTranscript as error:
        blocked = {"status": "error", "code": type(error).__name__}
        if chosen is not None:
            blocked |= {"kind": chosen[1], "track": chosen[0].language_code, "language": primary(chosen[0].language_code) or "und"}
        return blocked
    if not segments:
        return {"status": "none", "reason": "no_speech"}
    return {"status": "ok", "kind": kind, "language": primary(track.language_code) or "und", "track": track.language_code,
            "segments": [{"start": start, "end": end, "text": text} for start, end, text in segments]}


@dataclass
class _Chunk:
    text: str
    start: float
    duration: float


def supadata(video_id: str, language: str | None, key: str, http: Any = requests, sleep: Any = time.sleep) -> dict[str, Any]:
    """The same YouTube captions through Supadata, which fetches them on its own servers. Never AI-generated (mode=native).
    Supadata does not say whether captions are creator-made or auto-generated, so the kind is unknown here."""
    if not VIDEO_ID.fullmatch(video_id):
        return {"status": "error", "code": "invalid_video_id"}
    if not key:
        return {"status": "error", "code": "SupadataUnauthorized"}
    headers = {"x-api-key": key}
    params = {"url": f"https://www.youtube.com/watch?v={video_id}", "mode": "native", **({"lang": language} if language else {})}
    response = http.get(SUPADATA, params=params, headers=headers, timeout=60)
    body = response.json() if "json" in response.headers.get("content-type", "") else {}
    # Long videos are processed asynchronously: 202 with a job id, polled until the job leaves queued/active.
    if response.status_code == 202 and body.get("jobId"):
        job, deadline = body["jobId"], time.monotonic() + SUPADATA_WAIT_SECONDS
        while True:
            sleep(2)
            response = http.get(f"{SUPADATA}/{job}", headers=headers, timeout=60)
            body = response.json() if "json" in response.headers.get("content-type", "") else {}
            if body.get("status") not in ("queued", "active"):
                body = body.get("result", body) if body.get("status") == "completed" else body
                break
            if time.monotonic() > deadline:
                return {"status": "error", "code": "SupadataTimeout"}
    if response.status_code == 200 and isinstance(body.get("content"), list):
        segments = cues(_Chunk(str(c.get("text", "")), float(c["offset"]) / 1000, float(c["duration"]) / 1000) for c in body["content"])
        if not segments:
            return {"status": "none", "reason": "no_speech"}
        return {"status": "ok", "kind": "youtube_unknown", "language": primary(body.get("lang")) or "und", "track": str(body.get("lang") or "und"),
                "segments": [{"start": start, "end": end, "text": text} for start, end, text in segments]}
    error = str(body.get("error", ""))
    # 206: no transcript (still one credit); 404: missing or private video; 403: the video needs sign-in.
    if error == "transcript-unavailable" or response.status_code in (206, 403, 404):
        return {"status": "none", "reason": error or f"supadata_{response.status_code}"}
    if response.status_code == 401 or error == "unauthorized":
        return {"status": "error", "code": "SupadataUnauthorized"}
    if response.status_code in (402, 429) or error in ("limit-exceeded", "upgrade-required"):
        return {"status": "error", "code": "SupadataLimit"}
    return {"status": "error", "code": f"Supadata{response.status_code}"}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    via = "supadata" if "--via=supadata" in args else "youtube"
    args = [a for a in args if not a.startswith("--via=")]
    if not args or len(args) > 2:
        print(json.dumps({"status": "error", "code": "usage"}))
        return 2
    language = args[1] if len(args) > 1 else None
    try:
        answer = supadata(args[0], language, os.environ.get("SUPADATA_API_KEY", "").strip()) if via == "supadata"             else captions(args[0], language)
    except Exception as error:  # noqa: BLE001 - network failures become a retryable answer, never a traceback on stdout
        answer = {"status": "error", "code": type(error).__name__}
    sys.stdout.write(json.dumps(answer) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
