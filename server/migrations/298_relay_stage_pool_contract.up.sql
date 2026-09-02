CREATE TABLE relay_stage_pool (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    stage_name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, stage_name)
);

-- Import every legacy membership group before making pool identity mandatory.
INSERT INTO relay_stage_pool (workspace_id, stage_name, enabled)
SELECT workspace_id, stage_name, bool_or(enabled)
FROM relay_stage_agent_pool GROUP BY workspace_id, stage_name;

ALTER TABLE relay_stage_agent_pool ADD COLUMN pool_id uuid;
UPDATE relay_stage_agent_pool m SET pool_id = p.id FROM relay_stage_pool p
WHERE p.workspace_id = m.workspace_id AND p.stage_name = m.stage_name;
ALTER TABLE relay_stage_agent_pool ALTER COLUMN pool_id SET NOT NULL;
ALTER TABLE relay_stage_agent_pool ADD CONSTRAINT relay_stage_agent_pool_pool_id_fkey
  FOREIGN KEY (pool_id) REFERENCES relay_stage_pool(id) ON DELETE CASCADE;
CREATE INDEX relay_stage_agent_pool_pool_id_idx ON relay_stage_agent_pool(pool_id);

CREATE OR REPLACE FUNCTION relay_stage_pool_require_member()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'relay_stage_agent_pool' THEN
    target := COALESCE(NEW.pool_id, OLD.pool_id);
  ELSIF TG_TABLE_NAME = 'relay_stage_pool' THEN
    target := COALESCE(NEW.id, OLD.id);
  ELSE
    SELECT m.pool_id INTO target FROM relay_stage_agent_pool m WHERE m.agent_id = COALESCE(NEW.id, OLD.id) LIMIT 1;
  END IF;
  IF EXISTS (SELECT 1 FROM relay_stage_pool p WHERE p.id = target AND p.enabled
    AND NOT EXISTS (SELECT 1 FROM relay_stage_agent_pool m JOIN agent a ON a.id = m.agent_id
      WHERE m.pool_id = p.id AND m.enabled AND a.archived_at IS NULL AND a.workspace_id = p.workspace_id)) THEN
    RAISE EXCEPTION 'enabled relay stage pool must contain an enabled live same-workspace member';
  END IF;
  RETURN NULL;
END $$;

-- Deferred checks allow an atomic replacement of a pool's members.
CREATE CONSTRAINT TRIGGER relay_stage_pool_members_required
AFTER INSERT OR UPDATE OR DELETE ON relay_stage_agent_pool DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION relay_stage_pool_require_member();
CREATE CONSTRAINT TRIGGER relay_stage_pool_enabled_requires_member
AFTER INSERT OR UPDATE OF enabled ON relay_stage_pool DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION relay_stage_pool_require_member();
CREATE CONSTRAINT TRIGGER relay_stage_pool_agent_liveness
AFTER UPDATE OF archived_at, workspace_id ON agent DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION relay_stage_pool_require_member();

ALTER TABLE agent_task_queue
  ADD COLUMN relay_pool_id uuid REFERENCES relay_stage_pool(id) ON DELETE SET NULL,
  ADD COLUMN relay_pool_stage text;
