UPDATE relay_stage_config SET workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid WHERE workspace_id IS NULL;

ALTER TABLE relay_stage_config ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE relay_stage_config DROP CONSTRAINT relay_stage_config_stage_name_key;

INSERT INTO relay_stage_config (id, workspace_id, stage_name, next_stage, agent_id, agent_name)
VALUES
  (12, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Registered', 'Spec', 'ba76cf8c-09c6-459b-991c-5af887a63e06', 'ppp-spec-sol-low'),
  (13, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Spec', 'Queue', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 'ppp-build-terra-low-01'),
  (14, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Queue', 'In Progress', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 'ppp-build-terra-low-01'),
  (15, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'In Progress', 'In Review', '76818b0c-09c6-459b-991c-5af887a63e06', 'ppp-qc-sol-low-1'),
  (16, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'In Review', 'CI/CD & Deploy', '325c3138-ad54-4041-95c1-b77857569da6', 'ppp-deploy-sol-low-1'),
  (17, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Human Review', 'CI/CD & Deploy', '325c3138-ad54-4041-95c1-b77857569da6', 'ppp-deploy-sol-low-1'),
  (18, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'CI/CD & Deploy', 'Done', '325c3138-ad54-4041-95c1-b77857569da6', 'ppp-deploy-sol-low-1'),
  (19, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Done', 'Archived', NULL, NULL),
  (20, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Archived', NULL, NULL, NULL),
  (21, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Cancelled', NULL, NULL, NULL),
  (22, 'da3c5c5c-a123-4567-b999-c3ed1820da00', 'Parked', 'Queue', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 'ppp-build-terra-low-01');
