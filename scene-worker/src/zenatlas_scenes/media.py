from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import av

YOUTUBE_WATCH = re.compile(r"https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})")
OEMBED_ENDPOINT = "https://www.youtube.com/oembed"
DURATION_TOLERANCE_SECONDS = 0.5
VIDEO_MIME_TYPES = {
    ".mp4": "video/mp4", ".mov": "video/mov", ".webm": "video/webm", ".mpeg": "video/mpeg", ".mpg": "video/mpg",
    ".avi": "video/avi", ".wmv": "video/wmv", ".flv": "video/x-flv", ".3gp": "video/3gpp",
}


class MediaInaccessible(Exception):
    """The media cannot be analysed as registered. Retrying without operator action will not help."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class MediaCheckUnavailable(Exception):
    """Accessibility could not be determined right now (network or provider outage)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class LocalMedia:
    path: Path
    mime_type: str
    size: int
    duration: float
    sha256: str
    has_audio: bool


def youtube_id(url: str) -> str | None:
    match = YOUTUBE_WATCH.fullmatch(url)
    return match[1] if match else None


def normalise_reference(reference: str) -> str:
    """Media references are stored as POSIX paths relative to SCENE_MEDIA_ROOT."""
    candidate = PurePosixPath(reference.replace("\\", "/"))
    if not reference.strip() or candidate.is_absolute() or ".." in candidate.parts or re.match(r"^[A-Za-z]:", reference):
        raise MediaInaccessible("outside_media_root")
    return candidate.as_posix()


def resolve_under_root(root: Path | None, reference: str) -> Path:
    if root is None:
        raise MediaInaccessible("media_root_not_configured")
    relative = normalise_reference(reference)
    try:
        base = root.resolve(strict=True)
    except OSError:
        raise MediaInaccessible("media_root_missing") from None
    target = (base / relative).resolve()
    if not target.is_relative_to(base):
        raise MediaInaccessible("outside_media_root")
    return target


def probe_local(path: Path, *, max_bytes: int) -> LocalMedia:
    mime_type = VIDEO_MIME_TYPES.get(path.suffix.lower())
    if mime_type is None:
        raise MediaInaccessible("unsupported_media_type")
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        raise MediaInaccessible("file_missing") from None
    except OSError:
        raise MediaInaccessible("unreadable") from None
    if not path.is_file():
        raise MediaInaccessible("file_missing")
    if size == 0:
        raise MediaInaccessible("empty_file")
    if size > max_bytes:
        raise MediaInaccessible("file_too_large")
    try:
        with av.open(str(path)) as container:
            if not container.streams.video:
                raise MediaInaccessible("no_video_stream")
            stream = container.streams.video[0]
            if container.duration:
                duration = container.duration / av.time_base
            elif stream.duration and stream.time_base:
                duration = float(stream.duration * stream.time_base)
            else:
                raise MediaInaccessible("duration_unknown")
            has_audio = bool(container.streams.audio)
            if next(container.decode(stream), None) is None:
                raise MediaInaccessible("undecodable")
    except MediaInaccessible:
        raise
    except PermissionError:
        raise MediaInaccessible("unreadable") from None
    except (av.FFmpegError, OSError, ValueError):
        raise MediaInaccessible("undecodable") from None
    if duration <= 0:
        raise MediaInaccessible("duration_unknown")
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise MediaInaccessible("unreadable") from None
    return LocalMedia(path, mime_type, size, round(duration, 3), digest.hexdigest(), has_audio)


def verify_local(root: Path | None, reference: str, *, fingerprint: str, duration: float, max_bytes: int) -> LocalMedia:
    """Confirm the file is still the exact registered version: same bytes and same decoded duration."""
    media = probe_local(resolve_under_root(root, reference), max_bytes=max_bytes)
    if media.sha256 != fingerprint:
        raise MediaInaccessible("fingerprint_mismatch")
    if abs(media.duration - duration) > DURATION_TOLERANCE_SECONDS:
        raise MediaInaccessible("duration_mismatch")
    return media


def check_youtube(url: str, *, opener=urllib.request.urlopen, timeout: float = 10.0) -> None:
    """Use YouTube oEmbed to confirm public availability without fetching media."""
    if youtube_id(url) is None:
        raise MediaInaccessible("unsupported_media_reference")
    query = urllib.parse.urlencode({"url": url, "format": "json"})
    request = urllib.request.Request(f"{OEMBED_ENDPOINT}?{query}", headers={"User-Agent": "ZenAtlas-scenes/0.1", "Accept": "application/json"})
    try:
        with opener(request, timeout=timeout) as response:
            status, body = response.status, response.read(65537)
    except urllib.error.HTTPError as error:
        status, body = error.code, b""
        error.close()
    except (urllib.error.URLError, TimeoutError, OSError):
        raise MediaCheckUnavailable("media_check_unavailable") from None
    if status in (401, 403):
        raise MediaInaccessible("restricted")
    if status in (400, 404, 410):
        # oEmbed answers 400 for some well-formed IDs that do not identify a video.
        raise MediaInaccessible("not_found")
    if status != 200 or len(body) > 65536:
        raise MediaCheckUnavailable("media_check_unavailable")
    try:
        data = json.loads(body)
    except ValueError:
        raise MediaCheckUnavailable("media_check_unavailable") from None
    if not isinstance(data, dict) or not isinstance(data.get("title"), str):
        raise MediaCheckUnavailable("media_check_unavailable")
