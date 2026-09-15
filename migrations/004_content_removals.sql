CREATE TABLE content_removals (
 canonical_url text PRIMARY KEY,
 source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
 provider_id text,
 removed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_removals_source_idx ON content_removals(source_id,provider_id);
REVOKE ALL ON content_removals FROM PUBLIC;
