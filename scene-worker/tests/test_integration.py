"""End-to-end checks against a real PostgreSQL server, the repository's Node migrations and its HTTP search API.

The Gemini client is replaced by FakeModel; no live model call is made. Every stored scene comes from a prepared,
clearly labelled reply that passed the same validation as production output.
"""
from __future__ import annotations

import io
import json
import os
import random
import shutil
import socket
import string
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from support import FakeModel, make_video, scenes_reply

from zenatlas_scenes import store
from zenatlas_scenes.cli import main
from zenatlas_scenes.config import Settings
from zenatlas_scenes.media import check_youtube
from zenatlas_scenes.pipeline import ScenePipeline

pgserver = pytest.importorskip("pgserver")
REPO = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None or not (REPO / "node_modules").is_dir(),
                                reason="Node.js and installed npm dependencies are required for the real migrations and search API")
APP_PASSWORD = "scene-worker-integration-password-2026"
MODEL = "gemini-3.8-flash"
POLICY = {"metadata": True, "transcripts": True, "video_analysis": True, "retention_days": 30}


@pytest.fixture(scope="module")
def database(tmp_path_factory):
    server = pgserver.get_server(tmp_path_factory.mktemp("postgres"), cleanup_mode="stop")
    owner = server.get_uri()
    env = {**os.environ, "MIGRATION_DATABASE_URL": owner, "APP_DATABASE_PASSWORD": APP_PASSWORD}
    for script in ("src/migrate.ts", "scripts/app-user.ts"):
        subprocess.run([NODE, "--import", "tsx", script], cwd=REPO, env=env, check=True, capture_output=True, timeout=180)
    # The worker runs as the restricted runtime role, proving its grants are sufficient.
    return {"owner": owner, "app": owner.replace("postgres:@", f"search_app:{APP_PASSWORD}@", 1)}


def rows(url, sql, params=()):
    with psycopg.connect(url, autocommit=True, row_factory=dict_row) as conn:
        return conn.execute(sql, params).fetchall()


def make_content(owner, *, domain="media.example.org", url=None, duration=20.0, policy=POLICY):
    source = rows(owner, """INSERT INTO sources(domain,display_name,status,policy,provenance)
        VALUES(%s,'TEST FIXTURE source','active',%s,'{"fixture":true}')
        ON CONFLICT(domain) DO UPDATE SET policy=excluded.policy RETURNING id::text AS id""", (domain, Jsonb(policy)))[0]["id"]
    return rows(owner, """INSERT INTO content(source_id,canonical_url,title,description,duration,language,availability,expires_at,provenance)
        VALUES(%s,%s,'TEST FIXTURE clip','Fixture metadata only',%s,'en','available',now()+interval '1 day','{"fixture":true}')
        RETURNING id::text AS id""", (source, url or f"https://{domain}/watch/{uuid.uuid4()}", duration))[0]["id"]


def settings_for(database, media_root, **env):
    return Settings.from_env({"DATABASE_URL": database["app"], "SCENE_MEDIA_ROOT": str(media_root), "SCENE_ANALYSIS_DAILY_BUDGET": "100", **env})


def cli(monkeypatch, capsys, database, media_root, *argv):
    monkeypatch.setenv("DATABASE_URL", database["app"])
    monkeypatch.setenv("SCENE_MEDIA_ROOT", str(media_root))
    capsys.readouterr()
    code = main(["--env-file", str(media_root / "absent.env"), *argv])
    captured = capsys.readouterr()
    assert code == 0, captured.err
    return json.loads(captured.out)


def run_job(settings, model, **options):
    with store.connect(settings.database_url) as conn:
        job = store.claim(conn, settings.lease_seconds)
        assert job is not None, "expected a due scene analysis job"
        return ScenePipeline(conn, settings, model, **options).run(job)


@contextmanager
def search_api(database_url):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = {**os.environ, "DATABASE_URL": database_url, "HOST": "127.0.0.1", "PORT": str(port), "PUBLIC_ORIGIN": f"http://127.0.0.1:{port}",
           "SESSION_SECRET": "scene-worker-integration-session-secret-value", "ADMIN_TOKEN": "scene-worker-integration-admin-token-value"}
    process = subprocess.Popen([NODE, "--import", "tsx", "src/main.ts"], cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                with urllib.request.urlopen(f"{base}/health/ready", timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode(errors="replace")) from None
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.5)
        yield base
    finally:
        process.terminate()
        process.wait(timeout=15)


def search(base, **params):
    with urllib.request.urlopen(f"{base}/api/search?{urllib.parse.urlencode(params)}", timeout=15) as response:
        return json.load(response)


def result_for(response, content_id):
    [result] = [item for item in response["results"] if item["id"] == content_id]
    return result


def test_local_version_is_analysed_stored_and_served_by_the_search_api(database, tmp_path, monkeypatch, capsys):
    owner = database["owner"]
    content_id = make_content(owner)
    make_video(tmp_path / "harbour.mp4", seconds=12)
    (tmp_path / "harbour.srt").write_text("1\n00:00:01,000 --> 00:00:03,000\nWelcome aboard the night ferry.\n\n"
                                          "2\n00:00:07,000 --> 00:00:09,000\nLights on the <i>harbour</i> wall.\n", encoding="utf-8")
    register = ["register", content_id, "--version-key", "harbour-master-v1", "--file", "harbour.mp4", "--offset", "4",
                "--offset-basis", "TEST FIXTURE: the file starts 4 seconds into the canonical clip",
                "--subtitles", "harbour.srt", "--subtitle-offset", "0.5", "--subtitle-language", "en"]
    version = cli(monkeypatch, capsys, database, tmp_path, *register)
    assert (version["status"], version["timeline_offset_seconds"], version["subtitle_offset_seconds"]) == ("current", 4, 0.5)
    assert cli(monkeypatch, capsys, database, tmp_path, *register)["id"] == version["id"], "re-registering the same identity is idempotent"
    queued = cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    settings = settings_for(database, tmp_path)
    duration = version["duration_seconds"]

    model = FakeModel(scenes_reply(
        {"start": "00:00", "end": "00:05", "description": "Passengers board a ferry at night.", "tags": ["Ferry", "night"], "subtitle_cue_ids": [1]},
        {"start": "00:05", "end": "00:12", "description": "Harbour wall lights reflect on dark water.", "tags": ["harbour"], "subtitle_cue_ids": [2]},
        {"start": "00:13", "end": "00:20", "description": "A scene claimed after the file has ended."}))
    outcome = run_job(settings, model)
    assert (outcome.status, outcome.scenes) == ("complete", 2)
    [request] = model.requests
    assert request.local_path == (tmp_path / "harbour.mp4").resolve() and request.mime_type == "video/mp4"
    assert [(c.start, c.end, c.text) for c in request.cues] == [(1.5, 3.5, "Welcome aboard the night ferry."), (7.5, 9.5, "Lights on the harbour wall.")]

    media_end = min(12.0, duration)
    scenes = rows(owner, """SELECT media_start_seconds,media_end_seconds,start_seconds,end_seconds,tags,dialogue,dialogue_source
        FROM video_scenes WHERE media_version_id=%s ORDER BY media_start_seconds""", (version["id"],))
    assert [(s["media_start_seconds"], s["media_end_seconds"], s["start_seconds"], s["end_seconds"]) for s in scenes] == [
        (0, 5, 4, 9), (5, media_end, 9, media_end + 4)]
    assert [(s["dialogue"], s["dialogue_source"]) for s in scenes] == [
        ("Welcome aboard the night ferry.", "sidecar_file"), ("Lights on the harbour wall.", "sidecar_file")]
    assert scenes[0]["tags"] == ["ferry", "night"]
    assert rows(owner, "SELECT start_seconds,end_seconds,timing_quality,origin FROM transcript_segments WHERE content_id=%s ORDER BY start_seconds", (content_id,)) == [
        {"start_seconds": 5.5, "end_seconds": 7.5, "timing_quality": "provided", "origin": "scene-worker:sidecar_file"},
        {"start_seconds": 11.5, "end_seconds": 13.5, "timing_quality": "provided", "origin": "scene-worker:sidecar_file"}]
    [analysis] = rows(owner, "SELECT subtitle_source,rejection_codes,inspected_ranges,model FROM scene_analyses WHERE media_version_id=%s", (version["id"],))
    assert analysis == {"subtitle_source": "sidecar_file", "rejection_codes": {"outside_timeline": 1},
                        "inspected_ranges": [[4, round(min(duration + 4, 20), 3)]], "model": MODEL}
    assert rows(owner, "SELECT access_status,analysis_status FROM media_versions WHERE id=%s", (version["id"],)) == [
        {"access_status": "accessible", "analysis_status": "complete"}]
    assert rows(owner, "SELECT status,result->>'status' AS result FROM jobs WHERE id=%s", (queued["job_id"],)) == [{"status": "complete", "result": "complete"}]

    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    assert run_job(settings, FakeModel()).status == "cached", "an unchanged version and model reuse the stored analysis"

    with search_api(database["app"]) as base:
        result = result_for(search(base, q="harbour lights", mode="catalogue", evidence="video_analysed"), content_id)
        [moment] = result["moments"]
        assert (moment["start_seconds"], moment["end_seconds"], moment["evidence_type"]) == (9, media_end + 4, "video_analysed")
        assert {key: moment["scene"][key] for key in ("media_version", "media_start_seconds", "timeline_offset_seconds", "model", "dialogue")} == {
            "media_version": "harbour-master-v1", "media_start_seconds": 5, "timeline_offset_seconds": 4, "model": MODEL,
            "dialogue": "Lights on the harbour wall."}
        assert result["scene_analysis"]["status"] == "complete"

        with (tmp_path / "harbour.mp4").open("ab") as handle:
            handle.write(b"replaced bytes")
        cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
        assert run_job(settings, FakeModel()).code == "fingerprint_mismatch"
        status = result_for(search(base, q="ferry", mode="catalogue"), content_id)["scene_analysis"]
        assert status["status"] == "inaccessible" and "no longer matches the registered version" in status["message"]


def test_untrustworthy_model_output_is_retried_then_failed_without_storing_scenes(database, tmp_path, monkeypatch, capsys):
    owner = database["owner"]
    content_id = make_content(owner)
    make_video(tmp_path / "clip.mp4", seconds=6)
    version = cli(monkeypatch, capsys, database, tmp_path, "register", content_id, "--version-key", "clip-v1", "--file", "clip.mp4",
                  "--offset", "0", "--offset-basis", "TEST FIXTURE: identical export of the canonical clip")
    job = cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    settings = settings_for(database, tmp_path)
    replies = ["not json",
               scenes_reply({"start": "00:00", "end": "00:03", "description": "Claimed although unviewable"}, viewable=False),
               scenes_reply({"start": "00:00", "end": "00:02", "description": "Plausible"}, {"start": "04:00", "end": "04:30", "description": "Invented"},
                            {"start": "09:00", "end": "09:30", "description": "Invented"})]
    outcomes = []
    for reply in replies:
        outcomes.append(run_job(settings, FakeModel(reply)))
        rows(owner, "UPDATE jobs SET run_after=now() WHERE id=%s RETURNING id", (job["job_id"],))
    assert [(o.status, o.code) for o in outcomes] == [("retrying", "invalid_model_output"), ("retrying", "model_could_not_view_media"),
                                                      ("failed", "model_timestamps_unreliable")]
    assert rows(owner, "SELECT (SELECT count(*) FROM video_scenes WHERE media_version_id=%s)::int AS scenes,"
                       "(SELECT count(*) FROM scene_analyses WHERE media_version_id=%s)::int AS analyses", (version["id"], version["id"])) == [
        {"scenes": 0, "analyses": 0}]
    assert rows(owner, "SELECT analysis_status,analysis_code FROM media_versions WHERE id=%s", (version["id"],)) == [
        {"analysis_status": "failed", "analysis_code": "model_timestamps_unreliable"}]


def test_access_policy_budget_and_lease_boundaries_never_store_scenes(database, tmp_path, monkeypatch, capsys):
    owner = database["owner"]
    video_id = "".join(random.choices(string.ascii_letters + string.digits, k=11))
    content_id = make_content(owner, domain="www.youtube.com", url=f"https://www.youtube.com/watch?v={video_id}", duration=634.0)
    version = cli(monkeypatch, capsys, database, tmp_path, "register", content_id, "--version-key", f"youtube:{video_id}", "--youtube")
    assert (version["media_kind"], version["duration_seconds"], version["timeline_offset_seconds"]) == ("youtube", 634, 0)
    settings = settings_for(database, tmp_path)
    scene_count = "SELECT count(*)::int AS n FROM video_scenes WHERE media_version_id=%s"

    def removed(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO())

    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    outcome = run_job(settings, FakeModel(), youtube_check=lambda url: check_youtube(url, opener=removed))
    assert (outcome.status, outcome.code) == ("inaccessible", "not_found")
    assert rows(owner, "SELECT access_status,access_code,analysis_status FROM media_versions WHERE id=%s", (version["id"],)) == [
        {"access_status": "inaccessible", "access_code": "not_found", "analysis_status": "inaccessible"}]

    def public(url):
        return None

    rows(owner, """UPDATE sources SET policy=policy||'{"video_analysis":false}' WHERE domain='www.youtube.com' RETURNING id""")
    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    assert run_job(settings, FakeModel(), youtube_check=public).code == "video_analysis_not_permitted"
    rows(owner, """UPDATE sources SET policy=policy||'{"video_analysis":true}' WHERE domain='www.youtube.com' RETURNING id""")

    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    assert run_job(settings_for(database, tmp_path, SCENE_ANALYSIS_DAILY_BUDGET="0"), FakeModel(), youtube_check=public).status == "deferred"
    assert rows(owner, "SELECT status,attempts,run_after>now() AS later FROM jobs WHERE payload->>'media_version_id'=%s", (version["id"],)) == [
        {"status": "queued", "attempts": 0, "later": True}]
    rows(owner, "UPDATE jobs SET run_after=now() WHERE payload->>'media_version_id'=%s RETURNING id", (version["id"],))

    class LeaseStealingModel(FakeModel):
        def analyse(self, request, heartbeat):
            rows(owner, "UPDATE jobs SET lease_token=gen_random_uuid() WHERE payload->>'media_version_id'=%s AND status='running' RETURNING id",
                 (version["id"],))
            return scenes_reply({"start": "00:00", "end": "00:30", "description": "Opening titles over a meadow."})

    assert run_job(settings, LeaseStealingModel(), youtube_check=public).status == "lease_lost"
    assert rows(owner, scene_count, (version["id"],)) == [{"n": 0}]


def test_retained_transcripts_are_reused_with_offsets_and_speech_to_text_is_the_fallback(database, tmp_path, monkeypatch, capsys):
    owner = database["owner"]
    content_id = make_content(owner, duration=30.0)
    make_video(tmp_path / "talk.mp4", seconds=10, audio=True)
    version = cli(monkeypatch, capsys, database, tmp_path, "register", content_id, "--version-key", "talk-v2", "--file", "talk.mp4",
                  "--offset", "10", "--offset-basis", "TEST FIXTURE: this recut starts at content second 10")
    insert_segment = """INSERT INTO transcript_segments(content_id,start_seconds,end_seconds,text,language,origin,content_version,timing_quality)
        VALUES(%s,%s,%s,%s,'en','TEST FIXTURE',%s,'provided') RETURNING id::text AS id"""
    [segment] = rows(owner, insert_segment, (content_id, 12, 14, "TEST FIXTURE retained subtitle", "talk-v2"))
    rows(owner, insert_segment, (content_id, 2, 4, "Subtitle for a different version", "talk-v1"))
    settings = settings_for(database, tmp_path)

    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    model = FakeModel(scenes_reply({"start": "00:00", "end": "00:05", "description": "A speaker walks to a podium.", "subtitle_cue_ids": [1]}))
    transcribed = []
    assert run_job(settings, model, transcriber=lambda path, beat: transcribed.append(path) or []).status == "complete"
    assert transcribed == [], "retained subtitles for this exact version are reused before speech-to-text"
    assert [(c.start, c.end, c.segment_id) for c in model.requests[0].cues] == [(2.0, 4.0, segment["id"])]
    assert rows(owner, """SELECT start_seconds,dialogue,dialogue_source,transcript_segment_refs::text[] AS refs FROM video_scenes
        WHERE media_version_id=%s""", (version["id"],)) == [
        {"start_seconds": 10, "dialogue": "TEST FIXTURE retained subtitle", "dialogue_source": "database_transcript", "refs": [segment["id"]]}]

    rows(owner, "DELETE FROM transcript_segments WHERE id=%s RETURNING id", (segment["id"],))
    assert rows(owner, "SELECT status FROM video_scenes WHERE media_version_id=%s", (version["id"],)) == [{"status": "stale"}]
    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)
    fallback = FakeModel(scenes_reply({"start": "00:00", "end": "00:04", "description": "The speaker greets the audience."}))
    assert run_job(settings, fallback, transcriber=lambda path, beat: [(0.5, 2.5, "TEST FIXTURE recognised speech")]).status == "complete"
    assert rows(owner, "SELECT dialogue,dialogue_source FROM video_scenes WHERE media_version_id=%s AND status='active'", (version["id"],)) == [
        {"dialogue": "TEST FIXTURE recognised speech", "dialogue_source": "faster_whisper"}]
    latest = rows(owner, "SELECT analysis_version FROM scene_analyses WHERE media_version_id=%s ORDER BY completed_at DESC LIMIT 1", (version["id"],))
    assert latest[0]["analysis_version"].endswith(":asr:large-v3-turbo")


def test_media_without_an_audio_track_never_uses_speech_to_text(database, tmp_path, monkeypatch, capsys):
    content_id = make_content(database["owner"])
    make_video(tmp_path / "silent.mp4", seconds=4)
    version = cli(monkeypatch, capsys, database, tmp_path, "register", content_id, "--version-key", "silent-v1", "--file", "silent.mp4",
                  "--offset", "0", "--offset-basis", "TEST FIXTURE: identical export of the canonical clip")
    cli(monkeypatch, capsys, database, tmp_path, "enqueue", version["id"], "--model", MODEL)

    def unexpected(path, heartbeat):
        raise AssertionError("speech-to-text must not run without an audio track")

    assert run_job(settings_for(database, tmp_path), FakeModel(scenes_reply()), transcriber=unexpected).status == "complete"
    assert rows(database["owner"], "SELECT subtitle_source,accepted_scenes FROM scene_analyses WHERE media_version_id=%s", (version["id"],)) == [
        {"subtitle_source": "none", "accepted_scenes": 0}]
