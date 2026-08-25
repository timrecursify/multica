-- PPP-20833: roll back the nullable dedupe_key column.
ALTER TABLE issue DROP COLUMN dedupe_key;
