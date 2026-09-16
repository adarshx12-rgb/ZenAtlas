from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .validation import ValidatedScenes

Row = dict[str, Any]


class LeaseLost(Exception):
    """Another worker owns the job now; this attempt must not write results."""


class ContextChanged(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RegistrationError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def connect(url: str) -> psycopg.Connection[Row]:
    return psycopg.connect(url, autocommit=True, row_factory=dict_row, connect_timeout=5)


@dataclass(frozen=True)
class JobContext:
    version_id: str
    content_id: str
    version_key: str
    media_kind: str
    media_reference: str
    fingerprint: str
    duration: float
    timeline_offset: float
    subtitle_reference: str | None
    subtitle_offset: float
    content_duration: float | None
    policy: Mapping[str, Any]
    ineligible: str | None

    def identity(self) -> tuple[Any, ...]:
        return (self.media_kind, self.media_reference, self.fingerprint, self.duration, self.timeline_offset,
                self.subtitle_reference, self.subtitle_offset, self.content_duration)


@dataclass(frozen=True)
class AnalysisRecord:
    analysis_version: str
    model: str
    subtitle_source: str
    subtitle_sha256: str | None
    dialogue_source: str | None
    inspected_ranges: list[list[float]]
    frame_sampling_fps: float
    media_resolution: str
    validated: ValidatedScenes


# Mirrors the catalogue eligibility used by search, plus the source's explicit video-analysis permission.
_CONTEXT = """SELECT mv.id::text AS version_id, mv.content_id::text AS content_id, mv.version_key, mv.media_kind, mv.media_reference,
 mv.fingerprint, mv.duration_seconds, mv.timeline_offset_seconds, mv.subtitle_reference, mv.subtitle_offset_seconds,
 c.duration AS content_duration, s.policy,
 CASE WHEN mv.status<>'current' THEN 'version_superseded'
  WHEN s.status<>'active' OR (s.policy->>'metadata') IS DISTINCT FROM 'true' THEN 'source_inactive'
  WHEN (s.policy->>'video_analysis') IS DISTINCT FROM 'true' THEN 'video_analysis_not_permitted'
  WHEN s.health_status='down' OR split_part(split_part(c.canonical_url,'://',2),'/',1)<>s.active_domain THEN 'source_unavailable'
  WHEN c.expires_at<=now() OR c.availability='unavailable' THEN 'content_unavailable' END AS ineligible
 FROM media_versions mv JOIN content c ON c.id=mv.content_id JOIN sources s ON s.id=c.source_id WHERE mv.id=%s"""


def load_context(conn: psycopg.Connection[Row], version_id: str, *, lock: bool = False) -> JobContext | None:
    row = conn.execute(_CONTEXT + (" FOR UPDATE OF mv" if lock else ""), (version_id,)).fetchone()
    if row is None:
        return None
    return JobContext(row["version_id"], row["content_id"], row["version_key"], row["media_kind"], row["media_reference"],
                      row["fingerprint"], row["duration_seconds"], row["timeline_offset_seconds"], row["subtitle_reference"],
                      row["subtitle_offset_seconds"], row["content_duration"], row["policy"], row["ineligible"])


def claim(conn: psycopg.Connection[Row], lease_seconds: int) -> Row | None:
    """Claim one scene job with the same lease/attempt protocol as the Node worker, which never claims this kind."""
    conn.execute("""WITH exhausted AS (UPDATE jobs SET status='failed',error_code='retry_exhausted',lease_until=NULL,updated_at=now()
        WHERE kind='scene_analysis' AND attempts>=3 AND ((status='running' AND lease_until<now()) OR status='queued')
        RETURNING payload->>'media_version_id' AS version_id)
        UPDATE media_versions SET analysis_status='failed',analysis_code='retry_exhausted',analysis_updated_at=now()
        WHERE id::text IN (SELECT version_id FROM exhausted)""")
    return conn.execute("""UPDATE jobs SET status='running',attempts=attempts+1,lease_token=%s,
        lease_until=now()+(%s*interval '1 second'),updated_at=now() WHERE id=(SELECT id FROM jobs
        WHERE kind='scene_analysis' AND attempts<3 AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now()))
        ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id::text AS id,lease_token::text AS lease_token,payload,attempts""", (uuid.uuid4(), lease_seconds)).fetchone()


def renew(conn: psycopg.Connection[Row], job: Row, lease_seconds: int) -> None:
    if conn.execute("""UPDATE jobs SET lease_until=now()+(%s*interval '1 second'),updated_at=now()
        WHERE id=%s AND lease_token=%s AND status='running' RETURNING 1""", (lease_seconds, job["id"], job["lease_token"])).fetchone() is None:
        raise LeaseLost()


def _finish(conn: psycopg.Connection[Row], job: Row, status: str, result: Mapping[str, Any] | None, code: str | None) -> None:
    if conn.execute("""UPDATE jobs SET status=%s,result=%s,error_code=%s,lease_until=NULL,updated_at=now()
        WHERE id=%s AND lease_token=%s AND status='running' RETURNING 1""",
                    (status, None if result is None else Jsonb(dict(result)), code, job["id"], job["lease_token"])).fetchone() is None:
        raise LeaseLost()


def _set_analysis(conn: psycopg.Connection[Row], version_id: str, status: str, code: str | None) -> None:
    conn.execute("UPDATE media_versions SET analysis_status=%s,analysis_code=%s,analysis_updated_at=now() WHERE id=%s",
                 (status, code, version_id))


def record_access(conn: psycopg.Connection[Row], version_id: str, inaccessible_code: str | None) -> None:
    conn.execute("UPDATE media_versions SET access_status=%s,access_code=%s,access_checked_at=now() WHERE id=%s",
                 ("inaccessible" if inaccessible_code else "accessible", inaccessible_code, version_id))


def complete(conn: psycopg.Connection[Row], job: Row, result: Mapping[str, Any]) -> None:
    _finish(conn, job, "complete", result, None)


def not_permitted(conn: psycopg.Connection[Row], job: Row, version_id: str, code: str) -> None:
    with conn.transaction():
        _finish(conn, job, "complete", {"status": "not_permitted", "code": code}, None)
        _set_analysis(conn, version_id, "not_permitted", code)


def inaccessible(conn: psycopg.Connection[Row], job: Row, version_id: str, code: str) -> None:
    with conn.transaction():
        _finish(conn, job, "complete", {"status": "inaccessible", "code": code}, None)
        record_access(conn, version_id, code)
        _set_analysis(conn, version_id, "inaccessible", code)


def fail(conn: psycopg.Connection[Row], job: Row, version_id: str | None, code: str) -> None:
    with conn.transaction():
        _finish(conn, job, "failed", None, code)
        if version_id:
            _set_analysis(conn, version_id, "failed", code)


def retry(conn: psycopg.Connection[Row], job: Row, version_id: str | None, code: str) -> bool:
    with conn.transaction():
        row = conn.execute("""UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
            run_after=now()+(power(2,attempts)*interval '30 seconds'),error_code=%s,lease_until=NULL,updated_at=now()
            WHERE id=%s AND lease_token=%s AND status='running' RETURNING status""", (code, job["id"], job["lease_token"])).fetchone()
        if row is None:
            raise LeaseLost()
        retrying = row["status"] == "queued"
        if version_id:
            _set_analysis(conn, version_id, "pending" if retrying else "failed", code)
    return retrying


def defer_for_budget(conn: psycopg.Connection[Row], job: Row, version_id: str) -> None:
    """An exhausted budget is not a failed attempt: requeue for the next budget window without consuming an attempt."""
    with conn.transaction():
        if conn.execute("""UPDATE jobs SET status='queued',attempts=greatest(attempts-1,0),
            run_after=date_trunc('day',now())+interval '1 day',error_code='budget_exhausted',lease_until=NULL,updated_at=now()
            WHERE id=%s AND lease_token=%s AND status='running' RETURNING 1""", (job["id"], job["lease_token"])).fetchone() is None:
            raise LeaseLost()
        _set_analysis(conn, version_id, "pending", "budget_exhausted")


def cached(conn: psycopg.Connection[Row], job: Row, version_id: str, analysis_id: str) -> None:
    with conn.transaction():
        _finish(conn, job, "complete", {"status": "cached", "analysis_id": analysis_id}, None)
        _set_analysis(conn, version_id, "complete", None)


def take_budget(conn: psycopg.Connection[Row], bucket: str, limit: int) -> bool:
    if limit <= 0:
        return False
    return conn.execute("""INSERT INTO budgets(bucket,window_start,used) VALUES(%s,date_trunc('day',now()),1)
        ON CONFLICT(bucket,window_start) DO UPDATE SET used=budgets.used+1 WHERE budgets.used<%s RETURNING used""",
                        (bucket, limit)).fetchone() is not None


def transcript_segments(conn: psycopg.Connection[Row], content_id: str, version_key: str) -> list[Row]:
    return conn.execute("""SELECT id::text AS id,start_seconds,end_seconds,text FROM transcript_segments
        WHERE content_id=%s AND content_version=%s ORDER BY start_seconds,end_seconds,id""", (content_id, version_key)).fetchall()


def cached_analysis(conn: psycopg.Connection[Row], version_id: str, analysis_version: str) -> str | None:
    """Reuse only the latest analysis for the version, and only while none of its scenes have gone stale."""
    row = conn.execute("""SELECT a.id::text AS id FROM scene_analyses a WHERE a.media_version_id=%s AND a.analysis_version=%s
        AND a.completed_at=(SELECT max(completed_at) FROM scene_analyses WHERE media_version_id=%s)
        AND NOT EXISTS(SELECT 1 FROM video_scenes v WHERE v.analysis_id=a.id AND v.status<>'active')""",
                       (version_id, analysis_version, version_id)).fetchone()
    return row["id"] if row else None


def store_analysis(conn: psycopg.Connection[Row], job: Row, context: JobContext, record: AnalysisRecord) -> str:
    scenes = record.validated.scenes
    rejected = sum(record.validated.rejected.values())
    with conn.transaction():
        if conn.execute("SELECT 1 FROM jobs WHERE id=%s AND lease_token=%s AND status='running' FOR UPDATE",
                        (job["id"], job["lease_token"])).fetchone() is None:
            raise LeaseLost()
        # Same source-then-content lock order as catalogue ingestion and content removal.
        conn.execute("SELECT 1 FROM sources s JOIN content c ON c.source_id=s.id WHERE c.id=%s FOR UPDATE OF s", (context.content_id,))
        conn.execute("SELECT 1 FROM content WHERE id=%s FOR UPDATE", (context.content_id,))
        current = load_context(conn, context.version_id, lock=True)
        if current is None:
            raise ContextChanged("media_version_missing")
        if current.ineligible:
            raise ContextChanged(current.ineligible)
        if current.identity() != context.identity():
            raise ContextChanged("version_changed")
        conn.execute("DELETE FROM scene_analyses WHERE media_version_id=%s AND analysis_version=%s", (context.version_id, record.analysis_version))
        conn.execute("UPDATE video_scenes SET status='stale' WHERE media_version_id=%s AND status='active'", (context.version_id,))
        analysis_id = conn.execute("""INSERT INTO scene_analyses(media_version_id,content_id,analysis_version,model,subtitle_source,
            subtitle_sha256,inspected_ranges,frame_sampling_fps,media_resolution,accepted_scenes,rejected_scenes,rejection_codes,job_id)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id::text AS id""",
                                   (context.version_id, context.content_id, record.analysis_version, record.model, record.subtitle_source,
                                    record.subtitle_sha256, Jsonb(record.inspected_ranges), record.frame_sampling_fps,
                                    record.media_resolution, len(scenes), rejected, Jsonb(dict(record.validated.rejected)),
                                    job["id"])).fetchone()["id"]
        with conn.cursor() as cursor:
            cursor.executemany("""INSERT INTO video_scenes(analysis_id,content_id,media_version_id,media_start_seconds,media_end_seconds,
                start_seconds,end_seconds,description,tags,dialogue,dialogue_source,transcript_segment_refs)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::text[],%s,%s,%s::uuid[])""",
                               [(analysis_id, context.content_id, context.version_id, s.media_start, s.media_end, s.start, s.end,
                                 s.description, list(s.tags), s.dialogue, record.dialogue_source if s.dialogue else None,
                                 [uuid.UUID(ref) for ref in s.segment_ids]) for s in scenes])
        record_access(conn, context.version_id, None)
        _set_analysis(conn, context.version_id, "complete", None)
        _finish(conn, job, "complete", {"status": "complete", "analysis_id": analysis_id, "scenes": len(scenes), "rejected": rejected}, None)
    return analysis_id


_IDENTITY = ("media_kind", "media_reference", "fingerprint", "duration_seconds", "duration_source", "timeline_offset_seconds",
             "offset_basis", "subtitle_reference", "subtitle_offset_seconds", "subtitle_language")
_SUMMARY = ("id", "content_id", "version_key", "media_kind", "media_reference", "duration_seconds", "timeline_offset_seconds",
            "subtitle_reference", "subtitle_offset_seconds", "status", "access_status", "analysis_status")


def content_row(conn: psycopg.Connection[Row], content_id: str) -> Row | None:
    return conn.execute("SELECT id::text AS id,canonical_url,duration FROM content WHERE id=%s", (content_id,)).fetchone()


def register_version(conn: psycopg.Connection[Row], content_id: str, version_key: str, fields: Mapping[str, Any],
                     provenance: Mapping[str, Any]) -> Row:
    """Register an immutable media version and make it current; re-registering identical identity is idempotent."""
    with conn.transaction():
        if conn.execute("SELECT 1 FROM content WHERE id=%s FOR UPDATE", (content_id,)).fetchone() is None:
            raise RegistrationError("content_not_found")
        existing = conn.execute("SELECT * FROM media_versions WHERE content_id=%s AND version_key=%s", (content_id, version_key)).fetchone()
        if existing is not None:
            if any(existing[name] != fields[name] for name in _IDENTITY):
                raise RegistrationError("version_key_conflict")
            if existing["status"] != "current":
                raise RegistrationError("version_superseded")
            return {name: existing[name] for name in _SUMMARY}
        conn.execute("UPDATE media_versions SET status='superseded' WHERE content_id=%s AND status='current'", (content_id,))
        row = conn.execute(f"""INSERT INTO media_versions(content_id,version_key,{",".join(_IDENTITY)},provenance)
            VALUES(%s,%s,{",".join(["%s"] * len(_IDENTITY))},%s) RETURNING *""",
                           (content_id, version_key, *(fields[name] for name in _IDENTITY), Jsonb(dict(provenance)))).fetchone()
        return {name: row[name] for name in _SUMMARY}


def enqueue(conn: psycopg.Connection[Row], version_id: str, model: str, pipeline_version: str) -> Row:
    key = f"scene:{version_id}:{model}:{pipeline_version}"
    with conn.transaction():
        if conn.execute("SELECT 1 FROM media_versions WHERE id=%s AND status='current' FOR UPDATE", (version_id,)).fetchone() is None:
            raise RegistrationError("media_version_not_current")
        try:
            with conn.transaction():
                row = conn.execute("""INSERT INTO jobs(kind,dedupe_key,payload) VALUES('scene_analysis',%s,%s)
                    ON CONFLICT(dedupe_key) DO UPDATE SET status='queued',attempts=0,run_after=now(),result=NULL,error_code=NULL,
                    lease_until=NULL,lease_token=NULL,updated_at=now() WHERE jobs.status IN ('complete','failed')
                    RETURNING id::text AS id,status""", (key, Jsonb({"media_version_id": version_id, "model": model}))).fetchone()
        except psycopg.errors.UniqueViolation:
            raise RegistrationError("analysis_already_active") from None
        if row is None:
            row = conn.execute("SELECT id::text AS id,status FROM jobs WHERE dedupe_key=%s", (key,)).fetchone()
        else:
            _set_analysis(conn, version_id, "pending", "queued")
    return {"job_id": row["id"], "status": row["status"], "media_version_id": version_id, "model": model}


def version_status(conn: psycopg.Connection[Row], content_id: str) -> list[Row]:
    return conn.execute("""SELECT mv.id::text AS id,mv.version_key,mv.media_kind,mv.status,mv.duration_seconds,mv.timeline_offset_seconds,
        mv.access_status,mv.access_code,mv.analysis_status,mv.analysis_code,mv.analysis_updated_at,
        (SELECT count(*) FROM video_scenes v WHERE v.media_version_id=mv.id AND v.status='active')::int AS active_scenes
        FROM media_versions mv WHERE mv.content_id=%s ORDER BY mv.created_at DESC""", (content_id,)).fetchall()
