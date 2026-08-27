-- Allow NULL agent_task_queue.issue_id so issue-less dispatch paths work.
--
-- run_only autopilot dispatch (dispatchRunOnly) enqueues a direct agent task
-- that has no issue: it inserts issue_id = NULL with autopilot_run_id as the
-- source link, exactly like chat tasks (issue_id IS NULL + chat_session_id).
-- Migration 033_chat already dropped NOT NULL for chat, but instances seeded
-- from a schema lineage where that DROP never took effect (the constraint is
-- reasserted on the column) reject those inserts with SQLSTATE 23502. This
-- re-drops NOT NULL unconditionally so the deployed schema matches the
-- migration-derived schema and the run_only dispatch contract.
--
-- The down migration restores NOT NULL only after clearing NULL-issue rows,
-- mirroring 033_chat.down.sql.
ALTER TABLE agent_task_queue
    ALTER COLUMN issue_id DROP NOT NULL;
