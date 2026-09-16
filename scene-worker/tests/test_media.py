from __future__ import annotations

import hashlib
import io
import urllib.error

import pytest
from support import make_video

from zenatlas_scenes.media import (MediaCheckUnavailable, MediaInaccessible, check_youtube, normalise_reference, probe_local,
                                   resolve_under_root, verify_local, youtube_id)

URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"


@pytest.mark.parametrize("reference", ["", "/etc/passwd", "C:/media/clip.mp4", "c:clip.mp4", "../outside.mp4",
                                       "clips/../../outside.mp4", "\\\\server\\share\\clip.mp4"])
def test_references_must_stay_relative_to_the_media_root(reference):
    with pytest.raises(MediaInaccessible):
        normalise_reference(reference)


def test_resolution_requires_a_configured_existing_root(tmp_path):
    with pytest.raises(MediaInaccessible) as unconfigured:
        resolve_under_root(None, "clip.mp4")
    with pytest.raises(MediaInaccessible) as absent:
        resolve_under_root(tmp_path / "absent", "clip.mp4")
    assert (unconfigured.value.code, absent.value.code) == ("media_root_not_configured", "media_root_missing")
    assert resolve_under_root(tmp_path, "clips\\a.mp4") == (tmp_path / "clips" / "a.mp4").resolve()


def test_probe_reads_duration_and_fingerprint_of_decodable_video(tmp_path):
    clip = make_video(tmp_path / "clip.mp4", seconds=3)
    media = probe_local(clip, max_bytes=10_000_000)
    assert media.mime_type == "video/mp4" and abs(media.duration - 3.0) < 0.25 and not media.has_audio
    assert media.sha256 == hashlib.sha256(clip.read_bytes()).hexdigest()
    assert probe_local(make_video(tmp_path / "speech.mp4", seconds=2, audio=True), max_bytes=10_000_000).has_audio
    verified = verify_local(tmp_path, "clip.mp4", fingerprint=media.sha256, duration=media.duration, max_bytes=10_000_000)
    assert verified.path == clip.resolve()


@pytest.mark.parametrize(("name", "content", "limit", "expected"), [
    ("missing.mp4", None, 1000, "file_missing"),
    ("empty.mp4", b"", 1000, "empty_file"),
    ("notes.txt", b"hello", 1000, "unsupported_media_type"),
    ("fake.mp4", b"this is not a video" * 10, 10_000, "undecodable"),
    ("large.mp4", b"0" * 2000, 1000, "file_too_large"),
])
def test_inaccessible_local_media_is_reported_explicitly(tmp_path, name, content, limit, expected):
    path = tmp_path / name
    if content is not None:
        path.write_bytes(content)
    with pytest.raises(MediaInaccessible) as raised:
        probe_local(path, max_bytes=limit)
    assert raised.value.code == expected


def test_changed_bytes_or_duration_break_version_identity(tmp_path):
    make_video(tmp_path / "clip.mp4", seconds=2)
    media = probe_local(tmp_path / "clip.mp4", max_bytes=10_000_000)
    with pytest.raises(MediaInaccessible) as changed:
        verify_local(tmp_path, "clip.mp4", fingerprint="0" * 64, duration=media.duration, max_bytes=10_000_000)
    with pytest.raises(MediaInaccessible) as recut:
        verify_local(tmp_path, "clip.mp4", fingerprint=media.sha256, duration=media.duration + 5, max_bytes=10_000_000)
    assert (changed.value.code, recut.value.code) == ("fingerprint_mismatch", "duration_mismatch")


class _Response(io.BytesIO):
    def __init__(self, status: int, body: bytes):
        super().__init__(body)
        self.status = status


def opener_for(status=200, body=b'{"title":"Big Buck Bunny"}', error=None):
    def opener(request, timeout):
        opener.seen.append(request.full_url)
        if error is not None:
            raise error
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO())
        return _Response(status, body)
    opener.seen = []
    return opener


def test_youtube_ids_come_only_from_canonical_watch_urls():
    assert youtube_id(URL) == "aqz-KE-bpKQ"
    assert youtube_id("https://youtu.be/aqz-KE-bpKQ") is None and youtube_id(URL + "&t=4") is None


def test_public_youtube_video_passes_the_oembed_check():
    opener = opener_for()
    check_youtube(URL, opener=opener)
    assert opener.seen == ["https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ&format=json"]


@pytest.mark.parametrize(("status", "expected"), [(400, "not_found"), (401, "restricted"), (403, "restricted"), (404, "not_found"), (410, "not_found")])
def test_unavailable_youtube_video_is_inaccessible(status, expected):
    with pytest.raises(MediaInaccessible) as raised:
        check_youtube(URL, opener=opener_for(status=status))
    assert raised.value.code == expected


@pytest.mark.parametrize("opener", [opener_for(error=urllib.error.URLError("offline")), opener_for(status=503),
                                    opener_for(body=b"<html></html>"), opener_for(error=TimeoutError())])
def test_unknown_youtube_availability_is_not_reported_as_inaccessible(opener):
    with pytest.raises(MediaCheckUnavailable):
        check_youtube(URL, opener=opener)
