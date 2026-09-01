UPDATE relay_stage_config SET workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid WHERE workspace_id IS NULL;

INSERT INTO relay_stage_config
  (id, workspace_id, stage_name, next_stage, agent_id, agent_name, alt_next_stages)
VALUES
  (1, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Registered', 'Spec', '0c71c235-835b-40dc-9e31-09db9b4286e4', 'gsp-spec-sol-low-public', NULL),
  (2, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Spec', 'Queue', '30585378-1bcf-4b87-a047-e84f16dda2ef', 'gsp-build-terra-low-02', ARRAY['Cancelled']),
  (3, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Queue', 'In Progress', '30585378-1bcf-4b87-a047-e84f16dda2ef', 'gsp-build-terra-low-02', NULL),
  (4, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'In Progress', 'In Review', 'a9063165-1d42-4c8a-af98-19751e36f9d5', 'gsp-qc-sol-low-1', ARRAY['Queue']),
  (5, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'In Review', 'CI/CD & Deploy', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 'gsp-deploy-sol-low-1', ARRAY['Human Review','In Progress']),
  (6, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Human Review', 'CI/CD & Deploy', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 'gsp-deploy-sol-low-1', ARRAY['Cancelled','In Progress','In Review']),
  (7, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'CI/CD & Deploy', 'Done', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 'gsp-deploy-sol-low-1', ARRAY['In Progress','Queue','Spec']),
  (8, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Done', 'Archived', NULL, NULL, ARRAY['CI/CD & Deploy']),
  (9, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Archived', NULL, NULL, NULL, ARRAY['CI/CD & Deploy']),
  (10, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Cancelled', NULL, NULL, NULL, NULL),
  (11, 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f', 'Parked', 'Queue', '30585378-1bcf-4b87-a047-e84f16dda2ef', 'gsp-build-terra-low-02', NULL)
ON CONFLICT (id) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  stage_name = EXCLUDED.stage_name,
  next_stage = EXCLUDED.next_stage,
  agent_id = EXCLUDED.agent_id,
  agent_name = EXCLUDED.agent_name,
  alt_next_stages = EXCLUDED.alt_next_stages;

ALTER TABLE relay_stage_config ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE relay_stage_config DROP CONSTRAINT IF EXISTS relay_stage_config_stage_name_key;
DROP INDEX IF EXISTS relay_stage_config_stage_name_key;

INSERT INTO relay_stage_config
  (id, workspace_id, stage_name, next_stage, agent_id, agent_name, alt_next_stages)
VALUES
  (12, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Registered', 'Spec', 'ba76cf8c-09c6-459b-991c-5af887a63e06', 'ppp-spec-sol-low', NULL),
  (13, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Spec', 'Queue', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 'ppp-build-terra-low-01', ARRAY['Cancelled']),
  (14, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Queue', 'In Progress', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 'ppp-build-terra-low-01', NULL),
  (15, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'In Progress', 'In Review', '76818b0c-a30e-487c-9cc6-1682d8601ac4', 'ppp-qc-sol-low-1', ARRAY['Queue']),
  (16, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'In Review', 'CI/CD & Deploy', '325c3138-ad54-4041-95c1-b77857569da6', 'ppp-deploy-sol-low-1', ARRAY['Human Review','In Progress']),
  (17, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Human Review', 'CI/CD & Deploy', '325c3138-ad54-4041-95c1-b77857569da6', 'ppp-deploy-sol-low-1', ARRAY['Cancelled','In Progress','In Review']),
  (18, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'CI/CD & Deploy', 'Done', '325c3138-ad54-4041-95c1-b77857569da6', 'ppp-deploy-sol-low-1', ARRAY['In Progress','Queue','Spec']),
  (19, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Done', 'Archived', NULL, NULL, ARRAY['CI/CD & Deploy']),
  (20, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Archived', NULL, NULL, NULL, ARRAY['CI/CD & Deploy']),
  (21, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Cancelled', NULL, NULL, NULL, NULL),
  (22, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Parked', 'Queue', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 'ppp-build-terra-low-01', NULL);
