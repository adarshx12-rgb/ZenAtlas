DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='search_app') THEN
   GRANT SELECT,INSERT,UPDATE,DELETE ON embeddings,evidence_embeddings TO search_app;
 END IF;
END $$;
