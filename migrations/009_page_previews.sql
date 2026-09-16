-- First-screen captures of checked web pages. They belong to a discovery job's results and are erased once no search
-- could still show them (SEARCH_TTL_SECONDS), or with the job.
CREATE TABLE page_previews (
 job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 result_id uuid NOT NULL,
 image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 300000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (job_id, result_id)
);
CREATE INDEX page_previews_created_idx ON page_previews(created_at);
