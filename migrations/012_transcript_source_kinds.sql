-- Which kind of caption a transcript came from, so creator captions can outrank auto-generated ones.
-- youtube_unknown: fetched through Supadata while YouTube blocked the track list, so the kind is not known.
-- NULL covers every earlier origin (publisher files, PeerTube and archive.org captions, local speech-to-text).
ALTER TABLE transcript_segments ADD COLUMN source_kind text CHECK (source_kind IN ('youtube_manual','youtube_auto','youtube_unknown'));
ALTER TABLE moments ADD COLUMN source_kind text CHECK (source_kind IN ('youtube_manual','youtube_auto','youtube_unknown'));
-- Background fetching of existing YouTube captions (src/captions.ts).
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discovery','collect','enrich','source_health','source_discovery','scene_analysis','audit','critic_review','youtube_captions'));
-- A provider that blocked or ran out stays paused until `until`; strikes lengthen the next pause and reset on success.
CREATE TABLE lane_pauses (lane text PRIMARY KEY, until timestamptz NOT NULL, strikes integer NOT NULL DEFAULT 1, reason text NOT NULL);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='search_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON lane_pauses TO search_app;
 END IF;
END $$;
