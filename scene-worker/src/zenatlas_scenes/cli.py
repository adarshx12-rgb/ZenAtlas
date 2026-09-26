from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import sys
import threading
import time
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg

from . import store
from .config import MODEL_PATTERN, ConfigError, Settings, load_env_file
from .media import MediaCheckUnavailable, MediaInaccessible, normalise_reference, probe_local, resolve_under_root, youtube_id
from .pipeline import PIPELINE_VERSION, ScenePipeline, verify_media
from .subtitles import MAX_SUBTITLE_BYTES, SubtitleError, parse_subtitles


class CliError(Exception):
    pass


def log(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, "time": datetime.now(UTC).isoformat(), **fields}), file=sys.stderr, flush=True)


def _emit(value: Any) -> None:
    print(json.dumps(value, indent=2, default=str))


def _uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise argparse.ArgumentTypeError("must be a UUID") from None


def _seconds(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or abs(number) > 86400:
        raise argparse.ArgumentTypeError("must be a finite number of seconds between -86400 and 86400")
    return number


def _pattern(expression: str, message: str):
    compiled = re.compile(expression)

    def check(value: str) -> str:
        if not compiled.fullmatch(value):
            raise argparse.ArgumentTypeError(message)
        return value
    return check


def register(args: argparse.Namespace, settings: Settings) -> int:
    with store.connect(settings.database_url) as conn:
        content = store.content_row(conn, args.content_id)
        if content is None:
            raise CliError("Content not found")
        if args.youtube:
            if args.offset is not None or args.offset_basis:
                raise CliError("A YouTube version is the content's canonical media, so its offset is always 0")
            video_id = youtube_id(content["canonical_url"])
            if video_id is None:
                raise CliError("The content's canonical URL is not a YouTube watch URL")
            if content["duration"] is None:
                raise CliError("The content duration is unknown. Import verified duration metadata first, or register an authorised local file")
            fields: dict[str, Any] = {"media_kind": "youtube", "media_reference": content["canonical_url"], "fingerprint": video_id,
                                      "duration_seconds": content["duration"], "duration_source": "content_metadata",
                                      "timeline_offset_seconds": 0.0, "offset_basis": "The media is this content's canonical YouTube URL."}
            evidence: dict[str, Any] = {"duration": "content_metadata"}
        else:
            if args.offset is None or not args.offset_basis:
                raise CliError("Local files need --offset and --offset-basis explaining how the timeline offset was established")
            reference = normalise_reference(args.file)
            media = probe_local(resolve_under_root(settings.media_root, reference), max_bytes=settings.max_upload_bytes)
            fields = {"media_kind": "local_file", "media_reference": reference, "fingerprint": media.sha256,
                      "duration_seconds": media.duration, "duration_source": "media_probe",
                      "timeline_offset_seconds": args.offset, "offset_basis": args.offset_basis}
            evidence = {"duration": "pyav_probe", "bytes": media.size, "mime_type": media.mime_type}
        offset, duration = fields["timeline_offset_seconds"], fields["duration_seconds"]
        if duration + offset <= 0 or (content["duration"] is not None and offset >= content["duration"]):
            raise CliError("With this offset the media does not overlap the content timeline")
        subtitle_reference = None
        if args.subtitles:
            subtitle_reference = normalise_reference(args.subtitles)
            path = resolve_under_root(settings.media_root, subtitle_reference)
            try:
                if path.stat().st_size > MAX_SUBTITLE_BYTES:
                    raise SubtitleError("subtitle_too_large")
                parse_subtitles(path.read_bytes(), name=path.name)
            except OSError:
                raise MediaInaccessible("subtitle_missing") from None
        elif args.subtitle_offset or args.subtitle_language:
            raise CliError("--subtitle-offset and --subtitle-language require --subtitles")
        fields |= {"subtitle_reference": subtitle_reference, "subtitle_offset_seconds": args.subtitle_offset if subtitle_reference else 0.0,
                   "subtitle_language": args.subtitle_language if subtitle_reference else None}
        _emit(store.register_version(conn, args.content_id, args.version_key, fields,
                                     {"method": "scene_worker_cli", "registered_at": datetime.now(UTC).isoformat(), "media": evidence}))
    return 0


def enqueue(args: argparse.Namespace, settings: Settings) -> int:
    model = args.model or settings.gemini_model
    if not MODEL_PATTERN.fullmatch(model):
        raise CliError("--model must be a Gemini model code such as gemini-3.8-flash")
    with store.connect(settings.database_url) as conn:
        _emit(store.enqueue(conn, args.media_version_id, model, PIPELINE_VERSION))
    return 0


def check_media(args: argparse.Namespace, settings: Settings) -> int:
    with store.connect(settings.database_url) as conn:
        context = store.load_context(conn, args.media_version_id)
        if context is None:
            raise CliError("Media version not found")
        try:
            verify_media(settings, context)
            code = None
        except MediaInaccessible as error:
            code = error.code
        except MediaCheckUnavailable as error:
            _emit({"access_status": "unknown", "code": error.code})
            return 1
        store.record_access(conn, context.version_id, code)
    _emit({"access_status": "inaccessible" if code else "accessible", "code": code})
    return 3 if code else 0


def status(args: argparse.Namespace, settings: Settings) -> int:
    with store.connect(settings.database_url) as conn:
        _emit(store.version_status(conn, args.content_id))
    return 0


def work(args: argparse.Namespace, settings: Settings) -> int:
    settings.require_gemini()
    from .gemini import GeminiSceneModel

    from .openrouter import OpenRouterSceneModel, RoutedSceneModel

    # Fallback models named "google/..." go through OpenRouter when this instance has an OpenRouter key.
    openrouter = OpenRouterSceneModel(settings.openrouter_api_key, settings.openrouter_base_url, settings.gemini_timeout_seconds,
                                      site_url=os.environ.get("OPENROUTER_SITE_URL", ""), site_name=os.environ.get("OPENROUTER_SITE_NAME", ""))         if settings.openrouter_api_key else None
    model = RoutedSceneModel(GeminiSceneModel.from_api_key(settings.gemini_api_key, settings.gemini_timeout_seconds), openrouter)
    stopping = threading.Event()
    for name in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, name), lambda *_: stopping.set())
    log("scene_worker_started", default_model=settings.gemini_model,
        fallback_models=[m for m in settings.gemini_fallback_models if "/" not in m or openrouter is not None])
    while not stopping.is_set():
        try:
            with store.connect(settings.database_url) as conn:
                pipeline = ScenePipeline(conn, settings, model)
                while not stopping.is_set():
                    job = store.claim(conn, settings.lease_seconds)
                    if job is None:
                        if args.once:
                            return 0
                        stopping.wait(settings.poll_seconds)
                        continue
                    started = time.monotonic()
                    try:
                        outcome = pipeline.run(job)
                        log("scene_job_finished", job_id=job["id"], status=outcome.status, code=outcome.code,
                            scenes=outcome.scenes, seconds=round(time.monotonic() - started, 1))
                    except psycopg.OperationalError:
                        raise
                    except Exception as error:
                        log("scene_job_crashed", job_id=job["id"], error=type(error).__name__)
                        try:
                            store.retry(conn, job, None, "processing_failed")
                        except store.LeaseLost:
                            pass
                    if args.once:
                        return 0
        except psycopg.OperationalError:
            log("scene_worker_database_unavailable")
            if args.once:
                return 1
            stopping.wait(5)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="zenatlas-scenes", description="Analyse registered video versions into searchable scenes with Gemini.")
    parser.add_argument("--env-file", default=".env", help="KEY=VALUE file; variables already set in the environment take precedence")
    commands = parser.add_subparsers(dest="command", required=True)

    reg = commands.add_parser("register", help="register an immutable media version for a catalogue content record")
    reg.add_argument("content_id", type=_uuid)
    reg.add_argument("--version-key", required=True, type=_pattern(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,99}", "use letters, digits, '.', '_', ':' or '-'"))
    media = reg.add_mutually_exclusive_group(required=True)
    media.add_argument("--youtube", action="store_true", help="use the content's canonical public YouTube URL")
    media.add_argument("--file", help="authorised video file path relative to SCENE_MEDIA_ROOT")
    reg.add_argument("--offset", type=_seconds, help="content-timeline seconds at this file's first frame (local files)")
    reg.add_argument("--offset-basis", help="how the offset was established, for example 'identical export of the canonical upload'")
    reg.add_argument("--subtitles", help="SRT or WebVTT file relative to SCENE_MEDIA_ROOT")
    reg.add_argument("--subtitle-offset", type=_seconds, default=0.0, help="seconds added to subtitle cue times to reach media time")
    reg.add_argument("--subtitle-language", type=_pattern(r"[a-z]{2,3}(-[A-Za-z]{2,4})?", "use a language code such as en or pt-BR"))
    reg.set_defaults(handler=register)

    enq = commands.add_parser("enqueue", help="queue scene analysis for a current media version")
    enq.add_argument("media_version_id", type=_uuid)
    enq.add_argument("--model", help="Gemini model code; defaults to GEMINI_MODEL")
    enq.set_defaults(handler=enqueue)

    check = commands.add_parser("check-media", help="verify that a media version is still accessible and unchanged")
    check.add_argument("media_version_id", type=_uuid)
    check.set_defaults(handler=check_media)

    stat = commands.add_parser("status", help="show media versions, access and analysis status for a content record")
    stat.add_argument("content_id", type=_uuid)
    stat.set_defaults(handler=status)

    run = commands.add_parser("work", help="run the background worker")
    run.add_argument("--once", action="store_true", help="process at most one queued job, then exit")
    run.set_defaults(handler=work)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    environ = dict(os.environ)
    load_env_file(Path(args.env_file), environ)
    try:
        return args.handler(args, Settings.from_env(environ))
    except (ConfigError, CliError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2
    except (MediaInaccessible, SubtitleError, store.RegistrationError) as error:
        print(json.dumps({"error": error.code}), file=sys.stderr)
        return 2
