CREATE TABLE evidence_embeddings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 moment_id uuid UNIQUE REFERENCES moments(id) ON DELETE CASCADE,
 scene_id uuid UNIQUE REFERENCES video_scenes(id) ON DELETE CASCADE,
 model text NOT NULL,
 content_hash text NOT NULL,
 embedding vector NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (num_nonnulls(moment_id,scene_id)=1)
);
CREATE INDEX evidence_embeddings_content_idx ON evidence_embeddings(content_id);
REVOKE ALL ON evidence_embeddings FROM PUBLIC;
