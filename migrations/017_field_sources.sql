-- Which sites answer requests in each field (src/field-routing.ts): judged-good and judged-poor results per field and
-- domain, learned from real searches. It suggests where to look; it never makes a result more relevant.
CREATE TABLE field_sources (
  field text NOT NULL CHECK (field ~ '^[a-z0-9_]{2,40}$'),
  domain text NOT NULL CHECK (domain ~ '^[a-z0-9.-]{3,253}$'),
  good integer NOT NULL DEFAULT 0 CHECK (good >= 0),
  poor integer NOT NULL DEFAULT 0 CHECK (poor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field, domain)
);
CREATE INDEX field_sources_rank_idx ON field_sources(field, (good - poor) DESC);
