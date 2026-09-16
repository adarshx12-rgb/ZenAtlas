from __future__ import annotations

import httpx
import pytest
from google.genai import errors, types

from zenatlas_scenes.gemini import (FRAME_SAMPLING_FPS, AnalysisRequest, GeminiSceneModel, TerminalAnalysisError, TransientAnalysisError,
                                    build_prompt)
from zenatlas_scenes.media import MediaInaccessible
from zenatlas_scenes.subtitles import Cue
from zenatlas_scenes.validation import RESPONSE_JSON_SCHEMA

EMPTY = '{"media_viewable":true,"scenes":[]}'


def reply(text=EMPTY, finish=types.FinishReason.STOP, block=None, candidates=True):
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=[types.Part(text=text)]), finish_reason=finish)] if candidates else [],
        prompt_feedback=types.GenerateContentResponsePromptFeedback(block_reason=block) if block else None)


class FakeFiles:
    def __init__(self, *states):
        self.states, self.uploads, self.deleted = list(states), [], []

    def _file(self, name):
        return types.File(name=name, uri=f"https://files.example.test/{name}", mime_type="video/mp4", state=self.states.pop(0))

    def upload(self, *, file, config):
        self.uploads.append((file, config.mime_type))
        return self._file("files/clip")

    def get(self, *, name):
        return self._file(name)

    def delete(self, *, name):
        self.deleted.append(name)


class FakeModels:
    def __init__(self, outcome):
        self.outcome, self.calls = outcome, []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class FakeClient:
    def __init__(self, outcome=None, *states):
        self.models = FakeModels(reply() if outcome is None else outcome)
        self.files = FakeFiles(*states)


def youtube_request(cues=()):
    return AnalysisRequest(model="gemini-3.8-flash", media_kind="youtube", youtube_url="https://www.youtube.com/watch?v=aqz-KE-bpKQ",
                           local_path=None, mime_type=None, media_duration=634.5, cues=list(cues))


def local_request(tmp_path):
    return AnalysisRequest(model="gemini-3.8-flash", media_kind="local_file", youtube_url=None, local_path=tmp_path / "clip.mp4",
                           mime_type="video/mp4", media_duration=12.0, cues=[])


def test_youtube_request_uses_the_url_explicit_sampling_and_the_json_schema():
    client, beats = FakeClient(), []
    assert GeminiSceneModel(client).analyse(youtube_request([Cue(1, 1.0, 2.0, "Hello")]), lambda: beats.append(1)) == EMPTY
    [call] = client.models.calls
    video, prompt = call["contents"][0].parts
    assert call["model"] == "gemini-3.8-flash" and client.files.uploads == [] and beats
    assert video.file_data.file_uri == "https://www.youtube.com/watch?v=aqz-KE-bpKQ" and video.video_metadata.fps == FRAME_SAMPLING_FPS
    assert "10:34 (634.500 seconds)" in prompt.text and '"text": "Hello"' in prompt.text
    config = call["config"]
    assert config.response_mime_type == "application/json" and config.response_json_schema == RESPONSE_JSON_SCHEMA
    assert config.media_resolution == types.MediaResolution.MEDIA_RESOLUTION_LOW and "Never invent" in config.system_instruction


def test_prompt_without_subtitles_requires_empty_citations():
    assert "subtitle_cue_ids must be empty" in build_prompt(30, [])


def test_local_media_is_uploaded_polled_until_active_and_always_deleted(tmp_path):
    client = FakeClient(reply(), types.FileState.PROCESSING, types.FileState.PROCESSING, types.FileState.ACTIVE)
    sleeps, beats = [], []
    GeminiSceneModel(client, sleep=sleeps.append, clock=lambda: 0.0).analyse(local_request(tmp_path), lambda: beats.append(1))
    assert client.files.uploads == [(tmp_path / "clip.mp4", "video/mp4")] and client.files.deleted == ["files/clip"]
    assert len(sleeps) == 2 and len(beats) == 3
    assert client.models.calls[0]["contents"][0].parts[0].file_data.file_uri == "https://files.example.test/files/clip"


def test_provider_processing_failure_is_inaccessible_media_and_cleans_up(tmp_path):
    client = FakeClient(reply(), types.FileState.FAILED)
    with pytest.raises(MediaInaccessible) as raised:
        GeminiSceneModel(client).analyse(local_request(tmp_path), lambda: None)
    assert raised.value.code == "provider_could_not_process" and client.files.deleted == ["files/clip"] and client.models.calls == []


def test_generation_errors_still_delete_the_uploaded_file(tmp_path):
    client = FakeClient(errors.ServerError(503, {"error": {"code": 503, "message": "fixture", "status": "UNAVAILABLE"}}), types.FileState.ACTIVE)
    with pytest.raises(TransientAnalysisError):
        GeminiSceneModel(client).analyse(local_request(tmp_path), lambda: None)
    assert client.files.deleted == ["files/clip"]


def _api_error(kind, code, status):
    return kind(code, {"error": {"code": code, "message": "fixture detail", "status": status}})


@pytest.mark.parametrize(("outcome", "kind", "code"), [
    (_api_error(errors.ClientError, 429, "RESOURCE_EXHAUSTED"), TransientAnalysisError, "provider_rate_limited"),
    (_api_error(errors.ServerError, 503, "UNAVAILABLE"), TransientAnalysisError, "provider_unavailable"),
    (_api_error(errors.ClientError, 400, "INVALID_ARGUMENT"), TerminalAnalysisError, "provider_rejected_request"),
    (_api_error(errors.ClientError, 403, "PERMISSION_DENIED"), TerminalAnalysisError, "provider_access_denied"),
    (httpx.ReadTimeout("timed out"), TransientAnalysisError, "provider_timeout"),
    (httpx.ConnectError("offline"), TransientAnalysisError, "provider_unreachable"),
    (reply(finish=types.FinishReason.MAX_TOKENS), TerminalAnalysisError, "model_output_truncated"),
    (reply(finish=types.FinishReason.SAFETY), TerminalAnalysisError, "model_output_incomplete"),
    (reply(block=types.BlockedReason.SAFETY), TerminalAnalysisError, "model_blocked"),
    (reply(candidates=False), TerminalAnalysisError, "model_no_output"),
    (reply(text=""), TerminalAnalysisError, "model_no_output"),
])
def test_provider_failures_are_classified_without_leaking_details(outcome, kind, code):
    with pytest.raises(kind) as raised:
        GeminiSceneModel(FakeClient(outcome)).analyse(youtube_request(), lambda: None)
    assert raised.value.code == code and "fixture" not in str(raised.value)
