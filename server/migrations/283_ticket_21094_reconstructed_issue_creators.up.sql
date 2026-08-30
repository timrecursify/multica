-- The 2026-08-25 reconstruction created some ticket rows without creator
-- attribution. Keep the nullable historical-import contract from migration
-- 278, but give reconstructed tickets a stable synthetic agent attribution so
-- every issue read path can resolve them consistently.
UPDATE issue
SET creator_type = COALESCE(creator_type, 'agent'),
    creator_id = COALESCE(creator_id, '00000000-0000-0000-0000-000000000000')
WHERE title LIKE 'RECONSTRUCTED%'
  AND (creator_type IS NULL OR creator_id IS NULL);
