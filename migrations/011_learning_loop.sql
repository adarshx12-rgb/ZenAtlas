-- Learning loop, step 1: what each discovery search did, a critic model's audit of it, and what the searcher said.
-- Traces outlive the short-lived searches table on purpose (TRACE_RETENTION_DAYS); feedback cascades with them.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discovery','collect','enrich','source_health','source_discovery','scene_analysis','audit','critic_review'));
CREATE TABLE search_traces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid UNIQUE,
 query text NOT NULL,
 depth text NOT NULL CHECK(depth IN ('quick','deep')),
 ranking_version text NOT NULL,
 trace jsonb NOT NULL,
 metrics jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_traces_created_idx ON search_traces(created_at DESC);
CREATE TABLE search_audits (
 trace_id uuid PRIMARY KEY REFERENCES search_traces(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('complete','failed','skipped')),
 code text,
 model text,
 audit jsonb,
 probes jsonb,
 review jsonb,
 review_model text,
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz
);
CREATE INDEX search_audits_unreviewed_idx ON search_audits(created_at) WHERE status='complete' AND reviewed_at IS NULL;
-- search_id has no foreign key: searches expire after SEARCH_TTL_SECONDS, feedback about them does not.
CREATE TABLE result_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner text NOT NULL,
 search_id uuid NOT NULL,
 trace_id uuid REFERENCES search_traces(id) ON DELETE CASCADE,
 query text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('vote','open','missing')),
 url text,
 useful boolean,
 reason text CHECK(reason IN ('off_topic','low_quality','wrong_format','duplicate')),
 note text CHECK(char_length(note)<=500),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='missing')=(url IS NULL)),
 CHECK(kind<>'vote' OR useful IS NOT NULL)
);
CREATE UNIQUE INDEX result_feedback_once_idx ON result_feedback(owner,search_id,kind,url) WHERE kind IN ('vote','open');
CREATE INDEX result_feedback_trace_idx ON result_feedback(trace_id);
CREATE INDEX result_feedback_created_idx ON result_feedback(created_at);
REVOKE ALL ON search_traces,search_audits,result_feedback FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='search_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON search_traces,search_audits,result_feedback TO search_app;
 END IF;
END $$;
