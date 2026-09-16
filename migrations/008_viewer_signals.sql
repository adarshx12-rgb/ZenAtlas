-- Timestamps that viewers wrote in public comments, kept only as evidence for viewer_timestamp moments.
CREATE TABLE viewer_timestamps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('youtube')),
 provider_comment_id text NOT NULL,
 seconds double precision NOT NULL CHECK (seconds >= 0),
 excerpt text NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 500),
 like_count integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
 fetched_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 UNIQUE (content_id, provider_comment_id, seconds)
);
CREATE INDEX viewer_timestamps_content_idx ON viewer_timestamps(content_id);
CREATE INDEX viewer_timestamps_expiry_idx ON viewer_timestamps(expires_at);
REVOKE ALL ON viewer_timestamps FROM PUBLIC;

ALTER TABLE moments DROP CONSTRAINT moments_evidence_type_check;
ALTER TABLE moments ADD CONSTRAINT moments_evidence_type_check
 CHECK (evidence_type IN ('transcript_supported','video_analysed','viewer_timestamp'));

CREATE OR REPLACE FUNCTION validate_timing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duration_limit double precision;
BEGIN
 SELECT duration INTO duration_limit FROM content WHERE id=NEW.content_id FOR UPDATE;
 IF duration_limit IS NOT NULL AND NEW.end_seconds > duration_limit THEN
 RAISE EXCEPTION 'Timing exceeds content duration'; END IF;
 IF TG_TABLE_NAME='moments' THEN
 IF NEW.evidence_type='transcript_supported' THEN
 IF EXISTS (SELECT 1 FROM unnest(NEW.evidence_refs) ref WHERE NOT EXISTS
 (SELECT 1 FROM transcript_segments t WHERE t.id=ref AND t.content_id=NEW.content_id
 AND t.start_seconds >= NEW.start_seconds AND t.end_seconds <= NEW.end_seconds)) THEN
 RAISE EXCEPTION 'Invalid transcript evidence'; END IF; END IF;
 IF NEW.evidence_type='viewer_timestamp' THEN
 IF EXISTS (SELECT 1 FROM unnest(NEW.evidence_refs) ref WHERE NOT EXISTS
 (SELECT 1 FROM viewer_timestamps v WHERE v.id=ref AND v.content_id=NEW.content_id
 AND v.seconds >= NEW.start_seconds AND v.seconds <= NEW.end_seconds)) THEN
 RAISE EXCEPTION 'Invalid viewer timestamp evidence'; END IF; END IF; END IF;
 RETURN NEW;
END $$;

-- A moment never outlives the comments it cites.
CREATE FUNCTION remove_viewer_moments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM moments WHERE evidence_type='viewer_timestamp' AND OLD.id=ANY(evidence_refs);
 RETURN OLD;
END $$;
CREATE TRIGGER viewer_timestamp_removed AFTER DELETE ON viewer_timestamps
 FOR EACH ROW EXECUTE FUNCTION remove_viewer_moments();
