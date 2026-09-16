from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from . import store
from .config import MODEL_PATTERN, Settings
from .gemini import FRAME_SAMPLING_FPS, MEDIA_RESOLUTION, AnalysisRequest, TerminalAnalysisError, TransientAnalysisError
from .media import LocalMedia, MediaCheckUnavailable, MediaInaccessible, check_youtube, resolve_under_root, verify_local
from .subtitles import MAX_SUBTITLE_BYTES, Cue, SubtitleError, cues_sha256, media_cues, parse_subtitles, prompt_block
from .transcribe import transcribe, transcription_installed
from .validation import ModelOutputRejected, validate_scenes

PIPELINE_VERSION = "gemini-scenes-v1"
DIALOGUE_SOURCES = frozenset({"database_transcript", "sidecar_file", "faster_whisper"})
Heartbeat = Callable[[], None]
Transcriber = Callable[[Path, Heartbeat], list[tuple[float, float, str]]]


class SceneModel(Protocol):
    def analyse(self, request: AnalysisRequest, heartbeat: Heartbeat) -> str: ...


@dataclass(frozen=True)
class Outcome:
    status: str
    code: str | None = None
    analysis_id: str | None = None
    scenes: int = 0


@dataclass(frozen=True)
class SubtitlePlan:
    source: str
    identity: str
    cues: tuple[Cue, ...] = ()


def verify_media(settings: Settings, context: store.JobContext, youtube_check: Callable[[str], None] = check_youtube) -> LocalMedia | None:
    if context.media_kind == "youtube":
        youtube_check(context.media_reference)
        return None
    return verify_local(settings.media_root, context.media_reference, fingerprint=context.fingerprint,
                        duration=context.duration, max_bytes=settings.max_upload_bytes)


def inspected_ranges(context: store.JobContext) -> list[list[float]]:
    """The whole media version is submitted; record that span on the content timeline."""
    end = context.duration + context.timeline_offset
    if context.content_duration is not None:
        end = min(end, context.content_duration)
    return [[round(max(0.0, context.timeline_offset), 3), round(end, 3)]]


def _job_payload(job: dict[str, Any]) -> tuple[str, str] | None:
    payload = job.get("payload")
    if not isinstance(payload, dict) or not isinstance(payload.get("model"), str) or not MODEL_PATTERN.fullmatch(payload["model"]):
        return None
    try:
        return str(uuid.UUID(str(payload.get("media_version_id")))), payload["model"]
    except ValueError:
        return None


class ScenePipeline:
    def __init__(self, conn: Any, settings: Settings, model: SceneModel, *,
                 youtube_check: Callable[[str], None] = check_youtube, transcriber: Transcriber | None = None):
        self.conn = conn
        self.settings = settings
        self.model = model
        self.youtube_check = youtube_check
        self.transcriber = transcriber

    def run(self, job: dict[str, Any]) -> Outcome:
        try:
            return self._settle(job)
        except store.LeaseLost:
            return Outcome("lease_lost")

    def _settle(self, job: dict[str, Any]) -> Outcome:
        parsed = _job_payload(job)
        if parsed is None:
            store.fail(self.conn, job, None, "invalid_job_payload")
            return Outcome("failed", "invalid_job_payload")
        version_id, model = parsed
        try:
            return self._analyse(job, version_id, model)
        except store.ContextChanged as changed:
            store.not_permitted(self.conn, job, version_id, changed.code)
            return Outcome("not_permitted", changed.code)
        except MediaInaccessible as error:
            store.inaccessible(self.conn, job, version_id, error.code)
            return Outcome("inaccessible", error.code)
        except (MediaCheckUnavailable, TransientAnalysisError, ModelOutputRejected) as error:
            retrying = store.retry(self.conn, job, version_id, error.code)
            return Outcome("retrying" if retrying else "failed", error.code)
        except (TerminalAnalysisError, SubtitleError) as error:
            store.fail(self.conn, job, version_id, error.code)
            return Outcome("failed", error.code)

    def _analyse(self, job: dict[str, Any], version_id: str, model: str) -> Outcome:
        def heartbeat() -> None:
            store.renew(self.conn, job, self.settings.lease_seconds)

        context = store.load_context(self.conn, version_id)
        if context is None:
            store.complete(self.conn, job, {"status": "not_permitted", "code": "media_version_missing"})
            return Outcome("not_permitted", "media_version_missing")
        if context.ineligible:
            raise store.ContextChanged(context.ineligible)
        if context.duration > self.settings.max_media_seconds:
            raise TerminalAnalysisError("media_too_long")
        local = verify_media(self.settings, context, self.youtube_check)
        store.record_access(self.conn, version_id, None)
        heartbeat()

        plan = self._subtitle_plan(context, local)
        analysis_version = f"{PIPELINE_VERSION}:{model}:fps{FRAME_SAMPLING_FPS:g}:{MEDIA_RESOLUTION}:{plan.identity}"
        cached = store.cached_analysis(self.conn, version_id, analysis_version)
        if cached:
            store.cached(self.conn, job, version_id, cached)
            return Outcome("cached", analysis_id=cached)
        cues = self._transcribe(context, local, heartbeat) if plan.source == "faster_whisper" else plan.cues

        if not store.take_budget(self.conn, "scene_analysis_requests", self.settings.daily_request_budget):
            store.defer_for_budget(self.conn, job, version_id)
            return Outcome("deferred", "budget_exhausted")
        text = self.model.analyse(AnalysisRequest(
            model=model, media_kind=context.media_kind,
            youtube_url=context.media_reference if context.media_kind == "youtube" else None,
            local_path=local.path if local else None, mime_type=local.mime_type if local else None,
            media_duration=context.duration, cues=cues), heartbeat)
        validated = validate_scenes(text, media_duration=context.duration, timeline_offset=context.timeline_offset,
                                    content_duration=context.content_duration, cues=cues)
        analysis_id = store.store_analysis(self.conn, job, context, store.AnalysisRecord(
            analysis_version=analysis_version, model=model, subtitle_source=plan.source,
            subtitle_sha256=cues_sha256(cues) if cues else None,
            dialogue_source=plan.source if plan.source in DIALOGUE_SOURCES else None,
            inspected_ranges=inspected_ranges(context), frame_sampling_fps=FRAME_SAMPLING_FPS,
            media_resolution=MEDIA_RESOLUTION, validated=validated))
        return Outcome("complete", analysis_id=analysis_id, scenes=len(validated.scenes))

    def _subtitle_plan(self, context: store.JobContext, local: LocalMedia | None) -> SubtitlePlan:
        """Prefer subtitles already retained for this exact version, then the registered sidecar file, then optional speech-to-text."""
        if context.policy.get("transcripts") is not True:
            return SubtitlePlan("not_permitted", "not_permitted")
        rows = store.transcript_segments(self.conn, context.content_id, context.version_key)
        if rows:
            # Retained transcript segments use the content timeline; the offset maps them back onto this media.
            cues = media_cues(((r["start_seconds"] - context.timeline_offset, r["end_seconds"] - context.timeline_offset, r["text"], r["id"])
                               for r in rows), offset=0.0, media_duration=context.duration)
            prompt_block(cues)
            return SubtitlePlan("database_transcript", f"db:{cues_sha256(cues)[:16]}", tuple(cues))
        if context.subtitle_reference:
            path = resolve_under_root(self.settings.media_root, context.subtitle_reference)
            try:
                if path.stat().st_size > MAX_SUBTITLE_BYTES:
                    raise SubtitleError("subtitle_too_large")
                data = path.read_bytes()
            except OSError:
                raise MediaInaccessible("subtitle_missing") from None
            cues = media_cues(((start, end, text, None) for start, end, text in parse_subtitles(data, name=path.name)),
                              offset=context.subtitle_offset, media_duration=context.duration)
            prompt_block(cues)
            return SubtitlePlan("sidecar_file", f"sidecar:{cues_sha256(cues)[:16]}", tuple(cues))
        if local is not None and local.has_audio and (self.transcriber is not None or (self.settings.transcribe_fallback and transcription_installed())):
            return SubtitlePlan("faster_whisper", f"asr:{self.settings.whisper_model}")
        return SubtitlePlan("none", "none")

    def _transcribe(self, context: store.JobContext, local: LocalMedia | None, heartbeat: Heartbeat) -> tuple[Cue, ...]:
        assert local is not None
        heartbeat()
        try:
            if self.transcriber is not None:
                raw = self.transcriber(local.path, heartbeat)
            else:
                raw = transcribe(local.path, model_name=self.settings.whisper_model, device=self.settings.whisper_device,
                                 compute_type=self.settings.whisper_compute_type, heartbeat=heartbeat)
        except store.LeaseLost:
            raise
        except Exception:
            raise TransientAnalysisError("transcription_failed") from None
        heartbeat()
        cues = media_cues(((start, end, text, None) for start, end, text in raw), offset=0.0, media_duration=context.duration)
        prompt_block(cues)
        return tuple(cues)
