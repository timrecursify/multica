-- The repair is intentionally non-destructive. A later down migration must
-- never discard tasks created after the queue was restored.
SELECT 1;
