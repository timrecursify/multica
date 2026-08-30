-- Historical imports left issue.creator_type NULL. The read path remains
-- nullable for compatibility, but repair the existing rows so list and
-- creator-dependent consumers receive a stable actor kind.
UPDATE issue
SET creator_type = 'agent'
WHERE creator_type IS NULL;
