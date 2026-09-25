from __future__ import annotations

import json
from dataclasses import dataclass

from youtube_transcript_api import NoTranscriptFound, RequestBlocked, TranscriptsDisabled

from zenatlas_scenes.captions import captions, choose_track, cues, supadata


@dataclass
class Snippet:
    text: str
    start: float
    duration: float


class Track:
    def __init__(self, language_code: str, is_generated: bool, snippets: list[Snippet] | None = None):
        self.language_code = language_code
        self.is_generated = is_generated
        self.snippets = snippets or [Snippet("hello", 0.0, 1.0)]

    def fetch(self):
        return self


class Api:
    def __init__(self, tracks: list[Track] | None = None, error: Exception | None = None):
        self.tracks, self.error, self.asked = tracks or [], error, []

    def list(self, video_id: str):
        self.asked.append(video_id)
        if self.error:
            raise self.error
        return self.tracks


def test_creator_captions_win_over_auto_captions_in_the_videos_language():
    auto_hi, manual_en = Track("hi", True), Track("en", False)
    assert choose_track([auto_hi, manual_en], "hi") == (manual_en, "youtube_manual")


def test_creator_captions_prefer_the_videos_language_then_english():
    en, fr, de = Track("en", False), Track("fr-FR", False), Track("de", False)
    assert choose_track([de, en, fr], "fr")[0] is fr
    assert choose_track([de, en, fr], "ja")[0] is en
    assert choose_track([de], None)[0] is de


def test_auto_captions_prefer_the_videos_own_language_over_a_translated_track():
    dubbed, original = Track("en-US", True), Track("es", True)
    assert choose_track([dubbed, original], "es") == (original, "youtube_auto")
    assert choose_track([dubbed, original], None) == (dubbed, "youtube_auto")
    assert choose_track([], "es") is None


def test_cues_end_where_the_next_begins_and_drop_sound_tags_and_empty_lines():
    fetched = [Snippet("[Music]", 0.0, 2.0), Snippet("first\nline", 2.0, 4.0), Snippet("  ", 3.0, 1.0),
               Snippet("second", 4.5, 3.0), Snippet("second", 4.5, 3.0), Snippet("zero", 9.0, 0.0)]
    assert cues(fetched) == [(2.0, 4.5, "first line"), (4.5, 7.5, "second")]


def test_fetched_captions_carry_their_kind_and_primary_language():
    api = Api([Track("hi", True, [Snippet("नमस्ते दोस्तों", 1.0, 2.0)]), Track("en-GB", False, [Snippet("Hello friends", 1.0, 2.0)])])
    assert captions("dQw4w9WgXcQ", "hi", api) == {"status": "ok", "kind": "youtube_manual", "language": "en",
                                                   "track": "en-GB", "segments": [{"start": 1.0, "end": 3.0, "text": "Hello friends"}]}
    assert api.asked == ["dQw4w9WgXcQ"]


def test_videos_without_captions_are_a_final_answer_and_blocking_is_a_retryable_error():
    assert captions("dQw4w9WgXcQ", None, Api(error=TranscriptsDisabled("dQw4w9WgXcQ"))) == {"status": "none", "reason": "TranscriptsDisabled"}
    assert captions("dQw4w9WgXcQ", None, Api([Track("en", True, [Snippet("[Music]", 0, 1)])]))["status"] == "none"
    assert captions("dQw4w9WgXcQ", None, Api(error=NoTranscriptFound("dQw4w9WgXcQ", ["en"], []))) == {"status": "none", "reason": "NoTranscriptFound"}
    assert captions("dQw4w9WgXcQ", None, Api(error=RequestBlocked("dQw4w9WgXcQ"))) == {"status": "error", "code": "RequestBlocked"}


def test_only_real_video_ids_are_requested():
    api = Api([Track("en", False)])
    assert captions("../../etc", None, api) == {"status": "error", "code": "invalid_video_id"}
    assert api.asked == []
    json.dumps(captions("dQw4w9WgXcQ", None, api))


class Response:
    def __init__(self, status: int, body: dict):
        self.status_code, self._body, self.headers = status, body, {"content-type": "application/json"}

    def json(self):
        return self._body


class Http:
    def __init__(self, *responses: Response):
        self.responses, self.calls = list(responses), []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers))
        return self.responses.pop(0)


def test_a_block_after_the_track_list_reports_the_chosen_track():
    class Blocked(Track):
        def fetch(self):
            raise RequestBlocked("dQw4w9WgXcQ")
    answer = captions("dQw4w9WgXcQ", "hi", Api([Blocked("hi", True)]))
    assert answer == {"status": "error", "code": "RequestBlocked", "kind": "youtube_auto", "track": "hi", "language": "hi"}


def test_supadata_returns_cleaned_native_captions_in_seconds():
    http = Http(Response(200, {"lang": "hi", "availableLangs": ["hi"], "content": [
        {"text": "[संगीत]", "offset": 0, "duration": 1000, "lang": "hi"}, {"text": "नमस्ते मेरे भाई", "offset": 1000, "duration": 4560, "lang": "hi"},
        {"text": "पहली चीज", "offset": 4000, "duration": 2000, "lang": "hi"}]}))
    answer = supadata("dQw4w9WgXcQ", "hi", "key", http)
    assert answer == {"status": "ok", "kind": "youtube_unknown", "language": "hi", "track": "hi",
                      "segments": [{"start": 1.0, "end": 4.0, "text": "नमस्ते मेरे भाई"}, {"start": 4.0, "end": 6.0, "text": "पहली चीज"}]}
    url, params, headers = http.calls[0]
    assert params == {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "mode": "native", "lang": "hi"}, "never AI-generated"
    assert headers == {"x-api-key": "key"}


def test_supadata_long_videos_are_polled_until_the_job_completes():
    http = Http(Response(202, {"jobId": "job-1"}), Response(200, {"status": "active"}),
                Response(200, {"status": "completed", "lang": "en", "content": [{"text": "hello", "offset": 500, "duration": 1500}]}))
    answer = supadata("dQw4w9WgXcQ", None, "key", http, sleep=lambda s: None)
    assert answer["segments"] == [{"start": 0.5, "end": 2.0, "text": "hello"}]
    assert [c[0] for c in http.calls][1:] == ["https://api.supadata.ai/v1/transcript/job-1"] * 2


def test_supadata_answers_map_to_final_or_retryable_outcomes():
    unavailable = Response(206, {"error": "transcript-unavailable"})
    assert supadata("dQw4w9WgXcQ", None, "key", Http(unavailable))["status"] == "none"
    assert supadata("dQw4w9WgXcQ", None, "key", Http(Response(403, {})))["status"] == "none", "a sign-in-only video is final"
    assert supadata("dQw4w9WgXcQ", None, "key", Http(Response(429, {"error": "limit-exceeded"}))) == {"status": "error", "code": "SupadataLimit"}
    assert supadata("dQw4w9WgXcQ", None, "key", Http(Response(401, {}))) == {"status": "error", "code": "SupadataUnauthorized"}
    assert supadata("dQw4w9WgXcQ", None, "", Http()) == {"status": "error", "code": "SupadataUnauthorized"}
    assert supadata("dQw4w9WgXcQ", None, "key", Http(Response(500, {}))) == {"status": "error", "code": "Supadata500"}
