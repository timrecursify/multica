DROP VIEW IF EXISTS issue_funnel_stage_duration;
DROP TRIGGER IF EXISTS issue_funnel_insert_activity_trigger ON issue;
DROP TRIGGER IF EXISTS issue_funnel_update_activity_trigger ON issue;
DROP FUNCTION IF EXISTS record_issue_funnel_activity();
