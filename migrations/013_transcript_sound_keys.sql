-- Sound-tolerant transcript matching (src/phonetic.ts). search_text is the Latin romanization of Devanagari captions,
-- sound_keys the consonant skeletons of a caption line and the next one. Both are for matching only; quotes show text.
ALTER TABLE transcript_segments ADD COLUMN search_text text;
ALTER TABLE transcript_segments ADD COLUMN sound_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE moments ADD COLUMN sound_keys text[] NOT NULL DEFAULT '{}';
CREATE INDEX moments_sound_keys_idx ON moments USING gin(sound_keys) WHERE status='active';
