-- Public search templates; no credentials. Rejected templates need explicit operator replacement.
CREATE TABLE site_search (
 domain text PRIMARY KEY CHECK (domain ~ '^[a-z0-9.-]{3,253}$'),
 template text CHECK (length(template) <= 4096),
 status text NOT NULL CHECK (status IN ('active', 'absent', 'rejected', 'manual')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 hits bigint NOT NULL DEFAULT 0 CHECK (hits >= 0),
 good bigint NOT NULL DEFAULT 0 CHECK (good >= 0 AND good <= hits),
 CHECK ((status IN ('active', 'manual')) = (template IS NOT NULL))
);
REVOKE ALL ON site_search FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='search_app') THEN
  GRANT SELECT, INSERT, UPDATE ON site_search TO search_app;
 END IF;
END $$;
