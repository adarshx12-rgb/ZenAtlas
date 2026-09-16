ALTER TABLE sources ADD COLUMN discovery_appearances integer NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN discovery_last_seen_at timestamptz;
CREATE INDEX sources_candidate_appearances_idx ON sources(discovery_appearances DESC) WHERE status='candidate';
CREATE TABLE source_policy_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 pattern text NOT NULL UNIQUE,
 policy jsonb NOT NULL,
 review_note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON source_policy_rules FROM PUBLIC;
