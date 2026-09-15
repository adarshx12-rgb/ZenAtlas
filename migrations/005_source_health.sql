ALTER TABLE sources ADD COLUMN active_domain text;
UPDATE sources SET active_domain=domain;
ALTER TABLE sources ALTER COLUMN active_domain SET NOT NULL;
CREATE UNIQUE INDEX sources_active_domain_idx ON sources(active_domain);
CREATE FUNCTION initialise_active_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active_domain IS NULL THEN NEW.active_domain=NEW.domain; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_initial_domain BEFORE INSERT ON sources FOR EACH ROW EXECUTE FUNCTION initialise_active_domain();
ALTER TABLE sources ADD COLUMN health_status text NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown','healthy','degraded','down','blocked'));
ALTER TABLE sources ADD COLUMN health_failures integer NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN health_checked_at timestamptz;
ALTER TABLE sources ADD COLUMN health_next_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sources ADD COLUMN health_code text;
ALTER TABLE sources ADD COLUMN alternatives_next_search_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX sources_health_due_idx ON sources(health_next_at) WHERE status<>'rejected';
CREATE TABLE source_alternatives (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 domain text NOT NULL,status text NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','verified','rejected')),
 feed_url text,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,last_health text,
 UNIQUE(source_id,domain)
);
CREATE UNIQUE INDEX source_alternative_verified_domain_idx ON source_alternatives(domain) WHERE status='verified';
CREATE TABLE source_health_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('check','switch')),from_domain text NOT NULL,to_domain text,
 code text NOT NULL,job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_health_events_job_idx ON source_health_events(job_id);
CREATE UNIQUE INDEX source_health_check_job_idx ON source_health_events(job_id) WHERE kind='check';
CREATE INDEX source_health_events_source_idx ON source_health_events(source_id,created_at DESC);
CREATE INDEX source_health_events_expiry_idx ON source_health_events(created_at);
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discovery','collect','enrich','source_health','source_discovery'));
CREATE UNIQUE INDEX jobs_health_active_idx ON jobs((payload->>'source_id')) WHERE kind='source_health' AND status IN ('queued','running');
REVOKE ALL ON source_alternatives,source_health_events FROM PUBLIC;
