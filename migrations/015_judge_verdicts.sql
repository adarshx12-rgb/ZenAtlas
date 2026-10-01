-- Final judge verdicts remembered per request, contract, judge setup, candidate address and the evidence the judge saw
-- (src/verdict-cache.ts), so a repeat search judges the same evidence the same way. key: sha256 hex of those parts.
CREATE TABLE judge_verdicts (
  key text PRIMARY KEY,
  verdict jsonb NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
-- Expired rows are ignored on read and deleted in batches by expiry.
CREATE INDEX judge_verdicts_expires_idx ON judge_verdicts(expires_at);
REVOKE ALL ON judge_verdicts FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='search_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON judge_verdicts TO search_app;
 END IF;
END $$;
