CREATE TABLE sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), domain text NOT NULL UNIQUE,
 display_name text NOT NULL, categories text[] NOT NULL DEFAULT '{}', language text,
 adapter text NOT NULL DEFAULT 'link_only' CHECK (adapter IN ('link_only','json_feed')),
 capabilities jsonb NOT NULL DEFAULT '{"transcripts":false,"comments":false,"embeds":false,"accessible_media":false}',
 policy jsonb NOT NULL DEFAULT '{"metadata":false,"transcripts":false,"retention_days":30}',
 status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','paused','rejected')),
 provenance jsonb NOT NULL, feed_url text, cursor text,
 reliability real NOT NULL DEFAULT 0.5 CHECK (reliability BETWEEN 0 AND 1),
 last_success_at timestamptz, failure_count integer NOT NULL DEFAULT 0,
 next_check_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_due_idx ON sources(next_check_at) WHERE status='active';
CREATE TABLE content (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 provider_id text, canonical_url text NOT NULL UNIQUE, title text NOT NULL, description text,
 creator text, published_at timestamptz, duration double precision CHECK (duration > 0), language text,
 thumbnail text, embeddable boolean, rights_status text NOT NULL DEFAULT 'unknown'
 CHECK (rights_status IN ('unknown','restricted','licensed','public_domain')), license_url text,
 fetched_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
 availability text NOT NULL DEFAULT 'unknown' CHECK (availability IN ('unknown','available','unavailable')),
 expires_at timestamptz NOT NULL, provenance jsonb NOT NULL,
 search_vector tsvector GENERATED ALWAYS AS (
 setweight(to_tsvector('english',coalesce(title,'')),'A') ||
 setweight(to_tsvector('english',coalesce(description,'')),'B')) STORED,
 UNIQUE (source_id,provider_id)
);
CREATE INDEX content_source_idx ON content(source_id);
CREATE INDEX content_search_idx ON content USING gin(search_vector);
CREATE INDEX content_expiry_idx ON content(expires_at);
CREATE TABLE transcript_segments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 start_seconds double precision NOT NULL CHECK (start_seconds >= 0),
 end_seconds double precision NOT NULL CHECK (end_seconds > start_seconds),
 text text NOT NULL, language text NOT NULL, origin text NOT NULL, content_version text NOT NULL,
 timing_quality text NOT NULL CHECK (timing_quality IN ('provided','aligned','human_verified')),
 UNIQUE(content_id,content_version,start_seconds,end_seconds)
);
CREATE INDEX transcript_content_idx ON transcript_segments(content_id);
CREATE TABLE moments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 start_seconds double precision NOT NULL CHECK (start_seconds >= 0),
 end_seconds double precision NOT NULL CHECK (end_seconds > start_seconds),
 summary text NOT NULL, tags text[] NOT NULL DEFAULT '{}', evidence_refs uuid[] NOT NULL,
 evidence_type text NOT NULL CHECK (evidence_type IN ('transcript_supported','video_analysed')),
 analysis_method text NOT NULL, analysis_version text NOT NULL,
 inspected_ranges jsonb NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','rejected')),
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english',summary)) STORED,
 UNIQUE(content_id,analysis_version,start_seconds,end_seconds),
 CHECK(cardinality(evidence_refs)>0)
);
CREATE INDEX moments_content_idx ON moments(content_id);
CREATE INDEX moments_search_idx ON moments USING gin(search_vector) WHERE status='active';
CREATE FUNCTION validate_timing() RETURNS trigger LANGUAGE plpgsql AS $$
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
 RAISE EXCEPTION 'Invalid transcript evidence'; END IF; END IF; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transcript_timing BEFORE INSERT OR UPDATE ON transcript_segments FOR EACH ROW EXECUTE FUNCTION validate_timing();
CREATE TRIGGER moment_timing BEFORE INSERT OR UPDATE ON moments FOR EACH ROW EXECUTE FUNCTION validate_timing();
CREATE FUNCTION validate_duration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.duration IS NOT NULL AND (EXISTS(SELECT 1 FROM moments WHERE content_id=NEW.id AND end_seconds>NEW.duration)
 OR EXISTS(SELECT 1 FROM transcript_segments WHERE content_id=NEW.id AND end_seconds>NEW.duration)) THEN
 RAISE EXCEPTION 'Duration conflicts with retained evidence'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER content_duration BEFORE UPDATE OF duration ON content FOR EACH ROW EXECUTE FUNCTION validate_duration();
CREATE TABLE jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('discovery','collect','enrich')),
 dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
 attempts integer NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs(run_after) WHERE status IN ('queued','running');
CREATE TABLE searches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL, query text NOT NULL, filters jsonb NOT NULL,
 ranking_version text NOT NULL, results jsonb NOT NULL DEFAULT '[]',
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 provider_status jsonb NOT NULL DEFAULT '[]', cancelled boolean NOT NULL DEFAULT false,
 discovery_applied boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX searches_owner_idx ON searches(owner);
CREATE INDEX searches_job_idx ON searches(job_id);
CREATE INDEX searches_expiry_idx ON searches(expires_at);
CREATE TABLE feedback (
 owner text NOT NULL, content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 useful boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,content_id)
);
CREATE INDEX feedback_content_idx ON feedback(content_id);
CREATE TABLE provider_health (
 provider text PRIMARY KEY, failure_count integer NOT NULL DEFAULT 0,
 last_success_at timestamptz, last_error_code text, checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE budgets (
 bucket text NOT NULL, window_start timestamptz NOT NULL, used integer NOT NULL CHECK(used >= 0),
 PRIMARY KEY(bucket,window_start)
);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
