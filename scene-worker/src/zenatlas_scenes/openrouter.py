from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from .gemini import SYSTEM_INSTRUCTION, AnalysisRequest, TerminalAnalysisError, TransientAnalysisError, build_prompt, provider_schema
from .validation import RESPONSE_JSON_SCHEMA

# Gemini through OpenRouter: the fallback when the direct Gemini key is overloaded. Only Gemini models watch video, and
# OpenRouter passes a YouTube URL to Google without anything being downloaded. Frame rate and media resolution cannot be
# set here, so Gemini's defaults apply (the pipeline records the resolution as "default"). Local files are never sent.
# The schema is cut to Gemini's subset as for the direct call: Google answers 400 to keys such as additionalProperties.

MAX_OUTPUT_TOKENS = 32768


def _classify(status: int) -> Exception:
    if status == 429:
        return TransientAnalysisError("provider_rate_limited")
    if status == 408 or status >= 500:
        return TransientAnalysisError("provider_unavailable")
    if status in (401, 402, 403):
        return TerminalAnalysisError("provider_access_denied")
    return TerminalAnalysisError("provider_rejected_request")


class OpenRouterSceneModel:
    def __init__(self, api_key: str, base_url: str, timeout_seconds: int, *, transport: httpx.BaseTransport | None = None,
                 site_url: str = "", site_name: str = ""):
        headers = {"Authorization": f"Bearer {api_key}", **({"HTTP-Referer": site_url} if site_url else {}), **({"X-Title": site_name} if site_name else {})}
        self._client = httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=timeout_seconds, transport=transport)

    def analyse(self, request: AnalysisRequest, heartbeat: Callable[[], None]) -> str:
        if request.media_kind != "youtube" or not request.youtube_url:
            raise TerminalAnalysisError("provider_rejected_request")
        body: dict[str, Any] = {
            "model": request.model, "max_tokens": MAX_OUTPUT_TOKENS,
            "messages": [{"role": "system", "content": SYSTEM_INSTRUCTION},
                         {"role": "user", "content": [{"type": "video_url", "video_url": {"url": request.youtube_url}},
                                                      {"type": "text", "text": build_prompt(request.media_duration, request.cues, request.focus_query)}]}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "scenes", "strict": False, "schema": provider_schema(RESPONSE_JSON_SCHEMA)}},
        }
        heartbeat()
        try:
            response = self._client.post("/chat/completions", json=body)
        except httpx.TimeoutException:
            raise TransientAnalysisError("provider_timeout") from None
        except httpx.TransportError:
            raise TransientAnalysisError("provider_unreachable") from None
        if response.status_code != 200:
            raise _classify(response.status_code)
        try:
            choices = response.json().get("choices") or []
        except ValueError:
            raise TransientAnalysisError("provider_unavailable") from None
        if not choices:
            raise TerminalAnalysisError("model_no_output")
        if choices[0].get("finish_reason") == "length":
            raise TerminalAnalysisError("model_output_truncated")
        text = (choices[0].get("message") or {}).get("content")
        if not isinstance(text, str) or not text.strip():
            raise TerminalAnalysisError("model_no_output")
        return text


class RoutedSceneModel:
    """Provider-prefixed models ("google/...") go through OpenRouter; plain Gemini names use the direct key."""

    def __init__(self, direct: Any, openrouter: Any | None):
        self._direct = direct
        self._openrouter = openrouter

    def analyse(self, request: AnalysisRequest, heartbeat: Callable[[], None]) -> str:
        if "/" not in request.model:
            return self._direct.analyse(request, heartbeat)
        if self._openrouter is None:
            raise TerminalAnalysisError("provider_access_denied")
        return self._openrouter.analyse(request, heartbeat)
