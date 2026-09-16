-- Model-analysed video scenes. Scenes belong to one immutable media version; its offset maps media time to the content timeline.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discovery','collect','enrich','source_health','source_discovery','scene_analysis'));
CREATE UNIQUE INDEX jobs_scene_active_idx ON jobs((payload->>'media_version_id')) WHERE kind='scene_analysis' AND status IN ('queued','running');

CREATE TABLE media_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 version_key text NOT NULL CHECK(version_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 media_kind text NOT NULL CHECK(media_kind IN ('youtube','local_file')),
 media_reference text NOT NULL CHECK(char_length(media_reference) BETWEEN 1 AND 2048),
 fingerprint text NOT NULL CHECK(char_length(fingerprint) BETWEEN 11 AND 64),
 duration_seconds double precision NOT NULL CHECK(duration_seconds>0 AND duration_seconds<=604800),
 duration_source text NOT NULL CHECK(duration_source IN ('content_metadata','media_probe')),
 timeline_offset_seconds double precision NOT NULL CHECK(abs(timeline_offset_seconds)<=86400),
 offset_basis text NOT NULL CHECK(char_length(offset_basis) BETWEEN 3 AND 500),
 subtitle_reference text CHECK(char_length(subtitle_reference) BETWEEN 1 AND 2048),
 subtitle_offset_seconds double precision NOT NULL DEFAULT 0 CHECK(abs(subtitle_offset_seconds)<=86400),
 subtitle_language text CHECK(subtitle_language ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
 provenance jsonb NOT NULL,
 status text NOT NULL DEFAULT 'current' CHECK(status IN ('current','superseded')),
 access_status text NOT NULL DEFAULT 'unchecked' CHECK(access_status IN ('unchecked','accessible','inaccessible')),
 access_code text, access_checked_at timestamptz,
 analysis_status text NOT NULL DEFAULT 'pending' CHECK(analysis_status IN ('pending','complete','inaccessible','failed','not_permitted')),
 analysis_code text, analysis_updated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(content_id,version_key), UNIQUE(id,content_id),
 CHECK(media_kind<>'youtube' OR (duration_source='content_metadata' AND timeline_offset_seconds=0
   AND media_reference='https://www.youtube.com/watch?v='||fingerprint)),
 CHECK((access_status='inaccessible')=(access_code IS NOT NULL))
);
CREATE UNIQUE INDEX media_versions_current_idx ON media_versions(content_id) WHERE status='current';

CREATE TABLE scene_analyses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 media_version_id uuid NOT NULL, content_id uuid NOT NULL,
 FOREIGN KEY(media_version_id,content_id) REFERENCES media_versions(id,content_id) ON DELETE CASCADE,
 analysis_version text NOT NULL CHECK(char_length(analysis_version) BETWEEN 1 AND 300),
 model text NOT NULL CHECK(char_length(model) BETWEEN 1 AND 100),
 subtitle_source text NOT NULL CHECK(subtitle_source IN ('none','not_permitted','database_transcript','sidecar_file','faster_whisper')),
 subtitle_sha256 text CHECK(subtitle_sha256 ~ '^[0-9a-f]{64}$'),
 inspected_ranges jsonb NOT NULL,
 frame_sampling_fps real NOT NULL CHECK(frame_sampling_fps>0),
 media_resolution text NOT NULL,
 accepted_scenes integer NOT NULL CHECK(accepted_scenes>=0),
 rejected_scenes integer NOT NULL CHECK(rejected_scenes>=0),
 rejection_codes jsonb NOT NULL DEFAULT '{}',
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 completed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(media_version_id,analysis_version), UNIQUE(id,content_id,media_version_id)
);
CREATE INDEX scene_analyses_content_idx ON scene_analyses(content_id);

-- array_to_string is not declared immutable, but is deterministic for text[]; generated columns require an immutable wrapper.
CREATE FUNCTION scene_document(description text, tags text[], dialogue text) RETURNS tsvector LANGUAGE sql IMMUTABLE AS $$
 SELECT setweight(to_tsvector('english',description),'A') ||
   setweight(to_tsvector('english',array_to_string(tags,' ')),'B') ||
   setweight(to_tsvector('english',coalesce(dialogue,'')),'C')
$$;
CREATE TABLE video_scenes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 analysis_id uuid NOT NULL, content_id uuid NOT NULL, media_version_id uuid NOT NULL,
 FOREIGN KEY(analysis_id,content_id,media_version_id) REFERENCES scene_analyses(id,content_id,media_version_id) ON DELETE CASCADE,
 media_start_seconds double precision NOT NULL CHECK(media_start_seconds>=0),
 media_end_seconds double precision NOT NULL,
 start_seconds double precision NOT NULL CHECK(start_seconds>=0),
 end_seconds double precision NOT NULL,
 description text NOT NULL CHECK(char_length(description) BETWEEN 1 AND 1000),
 tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=12 AND array_position(tags,NULL) IS NULL),
 dialogue text CHECK(char_length(dialogue) BETWEEN 1 AND 4000),
 dialogue_source text CHECK(dialogue_source IN ('database_transcript','sidecar_file','faster_whisper')),
 transcript_segment_refs uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale')),
 search_vector tsvector GENERATED ALWAYS AS (scene_document(description,tags,dialogue)) STORED,
 CHECK(media_end_seconds>media_start_seconds), CHECK(end_seconds>start_seconds),
 CHECK((dialogue IS NULL)=(dialogue_source IS NULL)),
 UNIQUE(analysis_id,media_start_seconds,media_end_seconds)
);
CREATE INDEX video_scenes_content_idx ON video_scenes(content_id,start_seconds);
CREATE INDEX video_scenes_version_idx ON video_scenes(media_version_id);
CREATE INDEX video_scenes_search_idx ON video_scenes USING gin(search_vector) WHERE status='active';

CREATE FUNCTION protect_media_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical text;
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'current' THEN RAISE EXCEPTION 'New media versions must be current'; END IF;
   IF NEW.media_kind='youtube' THEN
     SELECT canonical_url INTO canonical FROM content WHERE id=NEW.content_id;
     IF canonical IS DISTINCT FROM NEW.media_reference THEN RAISE EXCEPTION 'YouTube media must be the content canonical URL'; END IF;
   END IF;
   RETURN NEW;
 END IF;
 IF (NEW.content_id,NEW.version_key,NEW.media_kind,NEW.media_reference,NEW.fingerprint,NEW.duration_seconds,NEW.duration_source,
   NEW.timeline_offset_seconds,NEW.offset_basis,NEW.subtitle_reference,NEW.subtitle_offset_seconds,NEW.subtitle_language,NEW.provenance)
   IS DISTINCT FROM (OLD.content_id,OLD.version_key,OLD.media_kind,OLD.media_reference,OLD.fingerprint,OLD.duration_seconds,OLD.duration_source,
   OLD.timeline_offset_seconds,OLD.offset_basis,OLD.subtitle_reference,OLD.subtitle_offset_seconds,OLD.subtitle_language,OLD.provenance) THEN
   RAISE EXCEPTION 'Media version identity and timestamp offsets are immutable; register a new version';
 END IF;
 IF OLD.status='superseded' AND NEW.status='current' THEN RAISE EXCEPTION 'Superseded media versions cannot be reactivated'; END IF;
 IF OLD.status='current' AND NEW.status='superseded' THEN
   UPDATE video_scenes SET status='stale' WHERE media_version_id=NEW.id AND status='active';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_version_identity BEFORE INSERT OR UPDATE ON media_versions FOR EACH ROW EXECUTE FUNCTION protect_media_version();

CREATE FUNCTION validate_video_scene() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version media_versions%ROWTYPE; content_duration double precision;
BEGIN
 SELECT duration INTO content_duration FROM content WHERE id=NEW.content_id FOR UPDATE;
 SELECT * INTO version FROM media_versions WHERE id=NEW.media_version_id;
 IF version.status<>'current' OR NEW.status<>'active' THEN RAISE EXCEPTION 'Scenes can only be added to the current media version'; END IF;
 IF NEW.media_end_seconds>version.duration_seconds THEN RAISE EXCEPTION 'Scene exceeds media version duration'; END IF;
 IF abs(NEW.start_seconds-(NEW.media_start_seconds+version.timeline_offset_seconds))>=0.001
   OR abs(NEW.end_seconds-(NEW.media_end_seconds+version.timeline_offset_seconds))>=0.001 THEN
   RAISE EXCEPTION 'Scene timing does not match the media version offset'; END IF;
 IF content_duration IS NOT NULL AND NEW.end_seconds>content_duration THEN RAISE EXCEPTION 'Scene exceeds content duration'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(NEW.transcript_segment_refs) ref WHERE NOT EXISTS(SELECT 1 FROM transcript_segments t
   WHERE t.id=ref AND t.content_id=NEW.content_id AND t.content_version=version.version_key
   AND t.start_seconds<NEW.end_seconds AND t.end_seconds>NEW.start_seconds)) THEN
   RAISE EXCEPTION 'Invalid scene transcript evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_scene_validation BEFORE INSERT ON video_scenes FOR EACH ROW EXECUTE FUNCTION validate_video_scene();

CREATE FUNCTION protect_video_scene() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.analysis_id,NEW.content_id,NEW.media_version_id,NEW.media_start_seconds,NEW.media_end_seconds,NEW.start_seconds,
   NEW.end_seconds,NEW.description,NEW.tags,NEW.dialogue,NEW.dialogue_source,NEW.transcript_segment_refs)
   IS DISTINCT FROM (OLD.analysis_id,OLD.content_id,OLD.media_version_id,OLD.media_start_seconds,OLD.media_end_seconds,OLD.start_seconds,
   OLD.end_seconds,OLD.description,OLD.tags,OLD.dialogue,OLD.dialogue_source,OLD.transcript_segment_refs) THEN
   RAISE EXCEPTION 'Scene records are immutable; store a new analysis'; END IF;
 IF OLD.status='stale' AND NEW.status='active' THEN RAISE EXCEPTION 'Stale scenes cannot be reactivated'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_scene_immutable BEFORE UPDATE ON video_scenes FOR EACH ROW EXECUTE FUNCTION protect_video_scene();

CREATE FUNCTION invalidate_transcript_scenes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE video_scenes SET status='stale' WHERE content_id=OLD.content_id AND status='active' AND OLD.id=ANY(transcript_segment_refs);
 RETURN OLD;
END $$;
CREATE TRIGGER transcript_scene_stale AFTER UPDATE OR DELETE ON transcript_segments FOR EACH ROW EXECUTE FUNCTION invalidate_transcript_scenes();

CREATE FUNCTION validate_scene_duration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.duration IS NOT NULL AND EXISTS(SELECT 1 FROM video_scenes WHERE content_id=NEW.id AND status='active' AND end_seconds>NEW.duration) THEN
   RAISE EXCEPTION 'Duration conflicts with retained scenes'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER content_scene_duration BEFORE UPDATE OF duration ON content FOR EACH ROW EXECUTE FUNCTION validate_scene_duration();

-- A changed canonical URL may point at different media, so its versions and their scenes no longer apply.
CREATE FUNCTION supersede_media_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE media_versions SET status='superseded' WHERE content_id=NEW.id AND status='current';
 RETURN NEW;
END $$;
CREATE TRIGGER content_url_media_versions AFTER UPDATE OF canonical_url ON content FOR EACH ROW
 WHEN (OLD.canonical_url IS DISTINCT FROM NEW.canonical_url) EXECUTE FUNCTION supersede_media_versions();

REVOKE ALL ON media_versions,scene_analyses,video_scenes FROM PUBLIC;
