-- agent_task_queue UUID integrity is a hard prerequisite for task usage rollups.
-- Do not coerce legacy integer IDs: an authoritative UUID parent export is required
-- to repair that history with cmd/repair_task_history before this migration can pass.

-- This migration must be one transaction.  The runner deliberately permits
-- non-transactional migrations, so BEGIN/COMMIT is required to hold both locks
-- through the type and orphan postcondition checks below.
BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('agent_task_queue_uuid_integrity', 0));

-- This lock order is shared with repair_task_history. SHARE ROW EXCLUSIVE blocks
-- concurrent INSERT/UPDATE/DELETE while the type and orphan postcondition is checked.
LOCK TABLE agent_task_queue, task_message, task_usage IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    column_name TEXT;
    actual_type REGTYPE;
BEGIN
    FOREACH column_name IN ARRAY ARRAY[
        'agent_task_queue.id',
        'task_message.task_id',
        'task_usage.task_id'
    ]
    LOOP
        SELECT attribute.atttypid::REGTYPE
          INTO actual_type
          FROM pg_attribute AS attribute
          JOIN pg_class AS relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND relation.relname = split_part(column_name, '.', 1)
           AND attribute.attname = split_part(column_name, '.', 2)
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped;

        IF actual_type IS DISTINCT FROM 'uuid'::REGTYPE THEN
            RAISE EXCEPTION '% must be uuid; found %', column_name, COALESCE(actual_type::TEXT, 'missing')
                USING ERRCODE = '42804';
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    orphan_messages BIGINT;
    orphan_usage BIGINT;
BEGIN
    SELECT count(*) INTO orphan_messages
      FROM task_message AS message
      LEFT JOIN agent_task_queue AS task ON task.id = message.task_id
     WHERE message.task_id IS NOT NULL AND task.id IS NULL;

    SELECT count(*) INTO orphan_usage
      FROM task_usage AS usage
      LEFT JOIN agent_task_queue AS task ON task.id = usage.task_id
     WHERE usage.task_id IS NOT NULL AND task.id IS NULL;

    IF orphan_messages <> 0 OR orphan_usage <> 0 THEN
        RAISE EXCEPTION 'agent task UUID integrity failed: task_message_orphans=%, task_usage_orphans=%; run repair_task_history with an authoritative parent export before retrying', orphan_messages, orphan_usage
            USING ERRCODE = '23503';
    END IF;
END $$;

COMMIT;
