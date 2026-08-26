-- Fail closed: this migration deliberately does not attempt to coerce the
-- historical integer queue IDs.  A UUID parent export must be restored first.
DO $$
DECLARE
    bad_column text;
    orphan_messages bigint;
    orphan_usage bigint;
BEGIN
    SELECT format('%I.%I is %s, expected uuid', table_name, column_name, udt_name)
      INTO bad_column
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND (table_name, column_name) IN (
            ('agent_task_queue', 'id'),
            ('task_message', 'task_id'),
            ('task_usage', 'task_id')
       )
       AND udt_name <> 'uuid'
     ORDER BY table_name, column_name
     LIMIT 1;

    IF bad_column IS NOT NULL THEN
        RAISE EXCEPTION 'agent task queue UUID integrity check failed: %', bad_column;
    END IF;

    SELECT count(*) INTO orphan_messages
      FROM task_message m
      LEFT JOIN agent_task_queue q ON q.id = m.task_id
     WHERE q.id IS NULL;
    IF orphan_messages <> 0 THEN
        RAISE EXCEPTION 'agent task queue UUID integrity check failed: % orphaned task_message rows', orphan_messages;
    END IF;

    SELECT count(*) INTO orphan_usage
      FROM task_usage u
      LEFT JOIN agent_task_queue q ON q.id = u.task_id
     WHERE q.id IS NULL;
    IF orphan_usage <> 0 THEN
        RAISE EXCEPTION 'agent task queue UUID integrity check failed: % orphaned task_usage rows', orphan_usage;
    END IF;
END $$;
