-- Scene verification has its own worker lane and publishes revisions to existing searches.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN
 ('discovery','collect','enrich','source_health','source_discovery','scene_analysis','audit','critic_review','youtube_captions','scene_review'));
ALTER TABLE jobs ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 10);
CREATE INDEX jobs_scene_ready_idx ON jobs(priority DESC,run_after,id)
 WHERE kind='scene_analysis' AND status IN ('queued','running');
CREATE INDEX jobs_scene_review_ready_idx ON jobs(run_after,id)
 WHERE kind='scene_review' AND status IN ('queued','running');
ALTER TABLE searches ADD COLUMN applied_revision integer NOT NULL DEFAULT 0 CHECK(applied_revision>=0);
ALTER TABLE searches ADD COLUMN applied_run uuid;
ALTER TABLE service_heartbeats DROP CONSTRAINT service_heartbeats_service_check;
ALTER TABLE service_heartbeats ADD CONSTRAINT service_heartbeats_service_check CHECK(service IN ('api','worker','watchdog','scene-worker'));
