from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from zenatlas_scenes.gemini import AnalysisRequest, TerminalAnalysisError, TransientAnalysisError
from zenatlas_scenes.openrouter import OpenRouterSceneModel, RoutedSceneModel
from zenatlas_scenes.pipeline import candidate_models
from zenatlas_scenes.config import Settings


def request(model="google/gemini-3.8-flash", kind="youtube"):
    return AnalysisRequest(model=model, media_kind=kind, youtube_url="https://www.youtube.com/watch?v=abc" if kind == "youtube" else None,
                           local_path=Path("clip.mp4") if kind == "local_file" else None, mime_type=None, media_duration=62.0, cues=())


def model_with(handler):
    return OpenRouterSceneModel("key-1", "https://openrouter.ai/api/v1", 60, transport=httpx.MockTransport(handler))


def test_the_youtube_url_system_instruction_and_json_schema_go_to_openrouter_and_the_reply_text_comes_back():
    seen = {}
    def handler(req: httpx.Request):
        seen["url"], seen["auth"], seen["body"] = str(req.url), req.headers["authorization"], json.loads(req.content)
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"media_viewable": true, "scenes": []}'}}]})
    beats = []
    assert model_with(handler).analyse(request(), lambda: beats.append(1)) == '{"media_viewable": true, "scenes": []}'
    body = seen["body"]
    assert seen["url"] == "https://openrouter.ai/api/v1/chat/completions" and seen["auth"] == "Bearer key-1"
    assert body["model"] == "google/gemini-3.8-flash"
    assert body["messages"][0]["role"] == "system" and "segment one video into scenes" in body["messages"][0]["content"]
    parts = body["messages"][1]["content"]
    assert parts[0] == {"type": "video_url", "video_url": {"url": "https://www.youtube.com/watch?v=abc"}}
    assert "This video lasts 01:02" in parts[1]["text"]
    assert body["response_format"]["type"] == "json_schema" and body["response_format"]["json_schema"]["schema"]["type"] == "object"
    assert "additionalProperties" not in json.dumps(body["response_format"]), "Gemini rejects schema keys outside its subset (400 invalid argument)"
    assert beats, "the lease is renewed before the long call"


@pytest.mark.parametrize(("status", "kind", "code"), [
    (503, TransientAnalysisError, "provider_unavailable"), (502, TransientAnalysisError, "provider_unavailable"),
    (408, TransientAnalysisError, "provider_unavailable"), (429, TransientAnalysisError, "provider_rate_limited"),
    (401, TerminalAnalysisError, "provider_access_denied"), (404, TerminalAnalysisError, "provider_rejected_request"),
])
def test_http_failures_are_classified_like_the_direct_client(status, kind, code):
    with pytest.raises(kind) as caught:
        model_with(lambda req: httpx.Response(status, json={"error": {"message": "secret detail"}})).analyse(request(), lambda: None)
    assert caught.value.code == code and "secret" not in str(caught.value)


def test_truncated_empty_or_timed_out_replies_are_not_scenes():
    for reply, code in [({"choices": [{"finish_reason": "length", "message": {"content": "{"}}]}, "model_output_truncated"),
                        ({"choices": []}, "model_no_output"), ({"choices": [{"finish_reason": "stop", "message": {"content": ""}}]}, "model_no_output")]:
        with pytest.raises(TerminalAnalysisError) as caught:
            model_with(lambda req, reply=reply: httpx.Response(200, json=reply)).analyse(request(), lambda: None)
        assert caught.value.code == code
    def slow(req):
        raise httpx.ReadTimeout("slow", request=req)
    with pytest.raises(TransientAnalysisError) as caught:
        model_with(slow).analyse(request(), lambda: None)
    assert caught.value.code == "provider_timeout"


def test_local_files_are_never_sent_to_openrouter():
    with pytest.raises(TerminalAnalysisError):
        model_with(lambda req: pytest.fail("no request")).analyse(request(kind="local_file"), lambda: None)


def test_router_sends_provider_prefixed_models_to_openrouter_and_plain_names_to_the_direct_key():
    calls = []
    class Stub:
        def __init__(self, name): self.name = name
        def analyse(self, req, heartbeat): calls.append((self.name, req.model)); return "{}"
    routed = RoutedSceneModel(Stub("direct"), Stub("openrouter"))
    routed.analyse(request("gemini-3.8-flash"), lambda: None)
    routed.analyse(request("google/gemini-3.5-flash"), lambda: None)
    assert calls == [("direct", "gemini-3.8-flash"), ("openrouter", "google/gemini-3.5-flash")]
    with pytest.raises(TerminalAnalysisError):
        RoutedSceneModel(Stub("direct"), None).analyse(request("google/gemini-3.5-flash"), lambda: None)


def test_candidates_start_with_the_job_model_and_skip_openrouter_without_a_key_or_for_local_files():
    base = {"DATABASE_URL": "postgresql://x", "GEMINI_FALLBACK_MODELS": "google/gemini-3.8-flash,gemini-3.8-flash,gemini-3.5-flash"}
    keyed = Settings.from_env({**base, "OPENROUTER_API_KEY": "k"})
    assert candidate_models("gemini-3.8-flash", keyed, "youtube") == ["gemini-3.8-flash", "google/gemini-3.8-flash", "gemini-3.5-flash"]
    assert candidate_models("gemini-3.8-flash", keyed, "local_file") == ["gemini-3.8-flash", "gemini-3.5-flash"]
    assert candidate_models("gemini-3.8-flash", Settings.from_env(base), "youtube") == ["gemini-3.8-flash", "gemini-3.5-flash"]
