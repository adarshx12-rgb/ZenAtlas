-- Preserve evidence validity when source segments change or disappear outside the import pipeline.
CREATE FUNCTION invalidate_transcript_moments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE moments SET status='stale' WHERE evidence_type='transcript_supported' AND OLD.id=ANY(evidence_refs);
 RETURN OLD;
END $$;
CREATE TRIGGER transcript_evidence_stale AFTER UPDATE OR DELETE ON transcript_segments
 FOR EACH ROW EXECUTE FUNCTION invalidate_transcript_moments();
CREATE INDEX jobs_source_active_idx ON jobs((payload->>'source_id')) WHERE kind='collect' AND status IN ('queued','running');
CREATE INDEX feedback_retention_idx ON feedback(updated_at);
