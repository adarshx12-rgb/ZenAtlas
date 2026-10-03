-- A search the catalogue alone answers has its matches judged by a catalogue review job (src/catalogue-review.ts).
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN
 ('discovery','collect','enrich','source_health','source_discovery','scene_analysis','audit','critic_review','youtube_captions','scene_review','catalogue_review'));
