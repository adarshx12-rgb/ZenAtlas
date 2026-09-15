-- Apply explicitly with npm run migrate -- --vectors. Lexical search does not depend on this extension.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE embeddings (
 content_id uuid PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
 model text NOT NULL, content_hash text NOT NULL, embedding vector NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Exact cosine search initially. Add a dimension-specific partial HNSW index after measuring scale.
REVOKE ALL ON embeddings FROM PUBLIC;
