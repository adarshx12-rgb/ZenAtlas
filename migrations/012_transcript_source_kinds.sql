-- Which kind of caption a transcript came from, so creator captions can outrank auto-generated ones.
-- NULL covers every earlier origin (publisher files, PeerTube and archive.org captions, local speech-to-text).
ALTER TABLE transcript_segments ADD COLUMN source_kind text CHECK (source_kind IN ('youtube_manual','youtube_auto'));
ALTER TABLE moments ADD COLUMN source_kind text CHECK (source_kind IN ('youtube_manual','youtube_auto'));
-- Background fetching of existing YouTube captions (src/captions.ts).
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discovery','collect','enrich','source_health','source_discovery','scene_analysis','audit','critic_review','youtube_captions'));
