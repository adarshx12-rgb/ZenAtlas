-- 017 left field_sources without runtime privileges: every learned site was refused (permission denied) and the error
-- swallowed, so field routing learned nothing.
REVOKE ALL ON field_sources FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='search_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON field_sources TO search_app;
 END IF;
END $$;
