-- Reconstructed historical issues may have no attributable creator. Keep the
-- identifier nullable with creator_type (migration 273) so both fields retain
-- the imported row's absence of attribution.
ALTER TABLE issue
    ALTER COLUMN creator_id DROP NOT NULL;
