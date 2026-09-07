\set ON_ERROR_STOP on

BEGIN;

WITH target_workspace AS (
  SELECT id
  FROM public.workspace
  WHERE slug = 'gsp-multica'
)
INSERT INTO public.workflow_state (
  workspace_id,
  name,
  description,
  color,
  position,
  archived
)
SELECT
  target_workspace.id,
  stage.name,
  stage.description,
  stage.color,
  stage.position,
  false
FROM target_workspace
CROSS JOIN (
  VALUES
    ('Registered', 'Ticket registered for relay intake', '#64748b', 0),
    ('Spec', 'Specification and acceptance criteria', '#0ea5e9', 1),
    ('Queue', 'Ready for automated assignment', '#8b5cf6', 2),
    ('In Progress', 'Implementation is active', '#f59e0b', 3),
    ('In Review', 'Automated quality review', '#ec4899', 4),
    ('Human Review', 'Human approval gate', '#ef4444', 5),
    ('CI/CD & Deploy', 'Build, deploy, and runtime verification', '#14b8a6', 6),
    ('Done', 'Work completed', '#22c55e', 7)
) AS stage(name, description, color, position)
ON CONFLICT (workspace_id, name) DO UPDATE
SET description = EXCLUDED.description,
    color = EXCLUDED.color,
    position = EXCLUDED.position,
    archived = false,
    updated_at = now();

INSERT INTO public.relay_stage_config (
  workspace_id,
  stage_name,
  next_stage,
  agent_id,
  agent_name
)
SELECT
  target_workspace.id,
  stage.stage_name,
  stage.next_stage,
  stage.agent_id::uuid,
  stage.agent_name
FROM target_workspace
CROSS JOIN (
  VALUES
    ('Registered', 'Spec', 'c08369aa-042d-4b73-8e5f-c07e17758b52', 'gsp-spec-luna-01'),
    ('Spec', 'Queue', '30585378-1bcf-4b87-a047-e84f16dda2ef', 'gsp-build-terra-low-02'),
    ('Queue', 'In Progress', '30585378-1bcf-4b87-a047-e84f16dda2ef', 'gsp-build-terra-low-02'),
    ('In Progress', 'In Review', 'a9063165-1d42-4c8a-af98-19751e36f9d5', 'gsp-qc-sol-low-1'),
    ('In Review', 'CI/CD & Deploy', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 'gsp-deploy-sol-low-1'),
    ('Human Review', 'CI/CD & Deploy', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 'gsp-deploy-sol-low-1'),
    ('CI/CD & Deploy', 'Done', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 'gsp-deploy-sol-low-1'),
    ('Parked', 'Queue', '30585378-1bcf-4b87-a047-e84f16dda2ef', 'gsp-build-terra-low-02'),
    ('Done', 'Archived', NULL, 'multica-archiver'),
    ('Archived', NULL, NULL, NULL),
    ('Cancelled', NULL, NULL, NULL)
) AS stage(stage_name, next_stage, agent_id, agent_name)
ON CONFLICT (workspace_id, stage_name) DO UPDATE
SET next_stage = EXCLUDED.next_stage,
    agent_id = EXCLUDED.agent_id,
    agent_name = EXCLUDED.agent_name;

-- Snapshot read from the live database on 2026-09-07. Capacity is enforced by
-- agent.max_concurrent_tasks; the stage budget is the sum of enabled members.
CREATE TEMP TABLE seed_agent_capacity (
  workspace_slug text NOT NULL,
  agent_id uuid NOT NULL,
  max_concurrent_tasks integer NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_agent_capacity VALUES
  ('gsp-multica', 'c08369aa-042d-4b73-8e5f-c07e17758b52', 30),
  ('gsp-multica', '5670ec31-ae48-4fa5-9a3f-b010061c946c', 30),
  ('gsp-multica', '17bc14d0-ee16-41b3-a085-f869480ce15e', 30),
  ('gsp-multica', '04c7ed2a-8ec8-43ed-ae3e-0982f3aa55b3', 30),
  ('gsp-multica', 'd1bf6210-682c-4928-90bb-78cdf3eed20f', 30),
  ('gsp-multica', '0c71c235-835b-40dc-9e31-09db9b4286e4', 1),
  ('gsp-multica', '5383d459-66ed-4ecb-80ca-97e555852895', 30),
  ('gsp-multica', 'e1d6f6fc-ea08-4ebd-9975-1c1efd26527e', 30),
  ('gsp-multica', 'a64ba775-9a8f-42fd-a0e5-b3190d778b77', 30),
  ('gsp-multica', '8361db55-a739-475b-ba51-60dcdf9dfb28', 30),
  ('gsp-multica', '30585378-1bcf-4b87-a047-e84f16dda2ef', 30),
  ('gsp-multica', '80dd7d94-04e8-4875-ac5d-8dea0fd8485a', 30),
  ('gsp-multica', '361384c3-21e1-4445-ba6e-2693de53c7f2', 30),
  ('gsp-multica', '499c7aa0-dc42-4bb9-b3a8-ddb091646846', 30),
  ('gsp-multica', '08c8ac5e-46d7-4e16-a7a0-a4f83fa3fe2e', 30),
  ('gsp-multica', 'd1baf8b3-1d06-44c2-a5ff-896309f982a1', 30),
  ('gsp-multica', '3595340d-e9b4-4605-a65c-dace0e114eee', 30),
  ('gsp-multica', 'f8fe783b-140b-48a1-9df3-5e5e5a18ab54', 30),
  ('gsp-multica', '1c3bf347-2aeb-4cff-926f-938c8aae648b', 30),
  ('gsp-multica', '158499bc-8acf-4d45-b582-74db569752c0', 30),
  ('gsp-multica', '8dd48209-f5c2-4d7c-a430-c8cb4a6a637b', 30),
  ('gsp-multica', '0baa3f10-a0db-41ef-97c8-4b2a7af8daa5', 15),
  ('gsp-multica', 'a9063165-1d42-4c8a-af98-19751e36f9d5', 15),
  ('gsp-multica', 'bea71b75-f4c7-4db6-8cfe-ab895904e8f7', 15),
  ('gsp-multica', 'b0d92c8a-0eab-4c5e-893a-917a8852c5cd', 15),
  ('gsp-multica', '4f161584-2d28-4825-8502-5d7b5006238f', 15),
  ('gsp-multica', '96964243-b005-4b08-a77d-604f705feab8', 15),
  ('gsp-multica', '10eb0f4b-c3e8-474f-bce1-87cba360432d', 15),
  ('gsp-multica', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', 15),
  ('ppp-production', 'ba76cf8c-09c6-459b-991c-5af887a63e06', 30),
  ('ppp-production', '47b9ab16-f7db-48c5-abad-acebc5f7bec6', 30),
  ('ppp-production', 'a06eb06b-2f6f-42bc-b402-1e1991fb10d9', 30),
  ('ppp-production', 'd963ac6e-8b28-4705-9635-4a7b8c688216', 30),
  ('ppp-production', '7f56f7da-0a18-4c9f-bdd7-d6bcab6f0738', 1),
  ('ppp-production', '453b39f4-fb93-4e10-8639-8acc50e98435', 1),
  ('ppp-production', '0e996f75-3b48-46d9-876d-c557bf9debc1', 1),
  ('ppp-production', '7de5fa7a-c80d-407d-8a69-dc145e4880de', 30),
  ('ppp-production', '605d17db-5009-4858-b211-c82c033457ef', 30),
  ('ppp-production', 'be3fe887-639c-469c-8be0-f4006050f5b8', 30),
  ('ppp-production', '868c3c25-7506-4b2e-89a4-5caf5704bb69', 30),
  ('ppp-production', '7b249881-bb5a-4133-b456-9452ded9ccf1', 30),
  ('ppp-production', '99ac8ed4-fde2-4ec5-8412-6cbd6bf3fe12', 30),
  ('ppp-production', 'd86e8a6c-c6f1-49d9-add2-d091c1cf46e6', 30),
  ('ppp-production', 'a20301f1-eb4b-41f6-bf69-ed771c58bf09', 30),
  ('ppp-production', 'c469db30-6ce4-48dd-b110-aa5ce69c61d2', 30),
  ('ppp-production', '0b473275-dcf8-49e5-bee9-5619a6629191', 30),
  ('ppp-production', '9f292155-86d9-479b-8d45-6929bfca01cc', 30),
  ('ppp-production', '7550521d-8f4b-4a98-bbb7-26e191305c02', 30),
  ('ppp-production', '062f6553-2b1d-474b-bc45-bd9c05108d8d', 15),
  ('ppp-production', '3924bda1-178c-4bc6-aff8-87a1f6208ce4', 15),
  ('ppp-production', '76818b0c-a30e-487c-9cc6-1682d8601ac4', 15),
  ('ppp-production', '61fac0f4-a96d-4f94-aba0-d1e08fbc1206', 15),
  ('ppp-production', '23a231a1-beb6-4e33-8b09-bf45d1511f70', 15),
  ('ppp-production', '3a126b81-d4c6-443a-b669-79515b2ed8fd', 15),
  ('ppp-production', '650452f6-a8ff-48ee-babd-7e3ffd9eea20', 15),
  ('ppp-production', 'bfb1b5f8-1753-461e-bc94-21b4606e45ca', 15),
  ('ppp-production', '325c3138-ad54-4041-95c1-b77857569da6', 15);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM seed_agent_capacity desired
    LEFT JOIN public.workspace workspace ON workspace.slug = desired.workspace_slug
    LEFT JOIN public.agent agent
      ON agent.id = desired.agent_id AND agent.workspace_id = workspace.id
    WHERE agent.id IS NULL
  ) THEN
    RAISE EXCEPTION 'stage capacity seed references a missing agent';
  END IF;
END
$$;

UPDATE public.agent agent
SET max_concurrent_tasks = desired.max_concurrent_tasks,
    updated_at = now()
FROM seed_agent_capacity desired
JOIN public.workspace workspace ON workspace.slug = desired.workspace_slug
WHERE agent.id = desired.agent_id
  AND agent.workspace_id = workspace.id
  AND agent.max_concurrent_tasks IS DISTINCT FROM desired.max_concurrent_tasks;

CREATE TEMP TABLE seed_stage_budget (
  workspace_slug text NOT NULL,
  stage_name text NOT NULL,
  enabled boolean NOT NULL,
  member_count integer NOT NULL,
  capacity_budget integer NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_stage_budget VALUES
  ('gsp-multica', 'CI/CD & Deploy', true, 3, 45),
  ('gsp-multica', 'Human Review', true, 1, 15),
  ('gsp-multica', 'In Progress', true, 15, 450),
  ('gsp-multica', 'In Review', true, 5, 75),
  ('gsp-multica', 'Parked', true, 1, 30),
  ('gsp-multica', 'Queue', true, 15, 450),
  ('gsp-multica', 'Registered', true, 5, 150),
  ('gsp-multica', 'Spec', true, 5, 150),
  ('ppp-production', 'CI/CD & Deploy', true, 3, 45),
  ('ppp-production', 'Human Review', true, 1, 15),
  ('ppp-production', 'In Progress', true, 15, 363),
  ('ppp-production', 'In Review', true, 6, 90),
  ('ppp-production', 'Parked', true, 1, 30),
  ('ppp-production', 'Queue', true, 15, 363),
  ('ppp-production', 'Registered', true, 4, 120),
  ('ppp-production', 'Spec', true, 5, 150);

INSERT INTO public.relay_stage_pool (workspace_id, stage_name, enabled)
SELECT workspace.id, desired.stage_name, desired.enabled
FROM seed_stage_budget desired
JOIN public.workspace workspace ON workspace.slug = desired.workspace_slug
ON CONFLICT (workspace_id, stage_name) DO UPDATE
SET enabled = EXCLUDED.enabled,
    updated_at = now();

CREATE TEMP TABLE seed_stage_membership (
  workspace_slug text NOT NULL,
  stage_name text NOT NULL,
  agent_id uuid NOT NULL,
  enabled boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_stage_membership VALUES
  ('gsp-multica', 'CI/CD & Deploy', '96964243-b005-4b08-a77d-604f705feab8', true),
  ('gsp-multica', 'CI/CD & Deploy', '10eb0f4b-c3e8-474f-bce1-87cba360432d', true),
  ('gsp-multica', 'CI/CD & Deploy', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', true),
  ('gsp-multica', 'Human Review', '91a73cdc-ac5c-4948-a17e-7874330e0eb6', true),
  ('gsp-multica', 'In Progress', '5383d459-66ed-4ecb-80ca-97e555852895', true),
  ('gsp-multica', 'In Progress', 'e1d6f6fc-ea08-4ebd-9975-1c1efd26527e', true),
  ('gsp-multica', 'In Progress', 'a64ba775-9a8f-42fd-a0e5-b3190d778b77', true),
  ('gsp-multica', 'In Progress', '8361db55-a739-475b-ba51-60dcdf9dfb28', true),
  ('gsp-multica', 'In Progress', '30585378-1bcf-4b87-a047-e84f16dda2ef', true),
  ('gsp-multica', 'In Progress', '80dd7d94-04e8-4875-ac5d-8dea0fd8485a', true),
  ('gsp-multica', 'In Progress', '361384c3-21e1-4445-ba6e-2693de53c7f2', true),
  ('gsp-multica', 'In Progress', '499c7aa0-dc42-4bb9-b3a8-ddb091646846', true),
  ('gsp-multica', 'In Progress', '08c8ac5e-46d7-4e16-a7a0-a4f83fa3fe2e', true),
  ('gsp-multica', 'In Progress', 'd1baf8b3-1d06-44c2-a5ff-896309f982a1', true),
  ('gsp-multica', 'In Progress', '3595340d-e9b4-4605-a65c-dace0e114eee', true),
  ('gsp-multica', 'In Progress', 'f8fe783b-140b-48a1-9df3-5e5e5a18ab54', true),
  ('gsp-multica', 'In Progress', '1c3bf347-2aeb-4cff-926f-938c8aae648b', true),
  ('gsp-multica', 'In Progress', '158499bc-8acf-4d45-b582-74db569752c0', true),
  ('gsp-multica', 'In Progress', '8dd48209-f5c2-4d7c-a430-c8cb4a6a637b', true),
  ('gsp-multica', 'In Review', '0baa3f10-a0db-41ef-97c8-4b2a7af8daa5', true),
  ('gsp-multica', 'In Review', 'a9063165-1d42-4c8a-af98-19751e36f9d5', true),
  ('gsp-multica', 'In Review', 'bea71b75-f4c7-4db6-8cfe-ab895904e8f7', true),
  ('gsp-multica', 'In Review', 'b0d92c8a-0eab-4c5e-893a-917a8852c5cd', true),
  ('gsp-multica', 'In Review', '4f161584-2d28-4825-8502-5d7b5006238f', true),
  ('gsp-multica', 'Parked', '30585378-1bcf-4b87-a047-e84f16dda2ef', true),
  ('gsp-multica', 'Queue', '5383d459-66ed-4ecb-80ca-97e555852895', true),
  ('gsp-multica', 'Queue', 'e1d6f6fc-ea08-4ebd-9975-1c1efd26527e', true),
  ('gsp-multica', 'Queue', 'a64ba775-9a8f-42fd-a0e5-b3190d778b77', true),
  ('gsp-multica', 'Queue', '8361db55-a739-475b-ba51-60dcdf9dfb28', true),
  ('gsp-multica', 'Queue', '30585378-1bcf-4b87-a047-e84f16dda2ef', true),
  ('gsp-multica', 'Queue', '80dd7d94-04e8-4875-ac5d-8dea0fd8485a', true),
  ('gsp-multica', 'Queue', '361384c3-21e1-4445-ba6e-2693de53c7f2', true),
  ('gsp-multica', 'Queue', '499c7aa0-dc42-4bb9-b3a8-ddb091646846', true),
  ('gsp-multica', 'Queue', '08c8ac5e-46d7-4e16-a7a0-a4f83fa3fe2e', true),
  ('gsp-multica', 'Queue', 'd1baf8b3-1d06-44c2-a5ff-896309f982a1', true),
  ('gsp-multica', 'Queue', '3595340d-e9b4-4605-a65c-dace0e114eee', true),
  ('gsp-multica', 'Queue', 'f8fe783b-140b-48a1-9df3-5e5e5a18ab54', true),
  ('gsp-multica', 'Queue', '1c3bf347-2aeb-4cff-926f-938c8aae648b', true),
  ('gsp-multica', 'Queue', '158499bc-8acf-4d45-b582-74db569752c0', true),
  ('gsp-multica', 'Queue', '8dd48209-f5c2-4d7c-a430-c8cb4a6a637b', true),
  ('gsp-multica', 'Registered', 'c08369aa-042d-4b73-8e5f-c07e17758b52', true),
  ('gsp-multica', 'Registered', '5670ec31-ae48-4fa5-9a3f-b010061c946c', true),
  ('gsp-multica', 'Registered', '17bc14d0-ee16-41b3-a085-f869480ce15e', true),
  ('gsp-multica', 'Registered', '04c7ed2a-8ec8-43ed-ae3e-0982f3aa55b3', true),
  ('gsp-multica', 'Registered', 'd1bf6210-682c-4928-90bb-78cdf3eed20f', true),
  ('gsp-multica', 'Registered', '0c71c235-835b-40dc-9e31-09db9b4286e4', false),
  ('gsp-multica', 'Spec', 'c08369aa-042d-4b73-8e5f-c07e17758b52', true),
  ('gsp-multica', 'Spec', '5670ec31-ae48-4fa5-9a3f-b010061c946c', true),
  ('gsp-multica', 'Spec', '17bc14d0-ee16-41b3-a085-f869480ce15e', true),
  ('gsp-multica', 'Spec', '04c7ed2a-8ec8-43ed-ae3e-0982f3aa55b3', true),
  ('gsp-multica', 'Spec', 'd1bf6210-682c-4928-90bb-78cdf3eed20f', true),
  ('gsp-multica', 'Spec', '0c71c235-835b-40dc-9e31-09db9b4286e4', false),
  ('ppp-production', 'CI/CD & Deploy', '650452f6-a8ff-48ee-babd-7e3ffd9eea20', true),
  ('ppp-production', 'CI/CD & Deploy', 'bfb1b5f8-1753-461e-bc94-21b4606e45ca', true),
  ('ppp-production', 'CI/CD & Deploy', '325c3138-ad54-4041-95c1-b77857569da6', true),
  ('ppp-production', 'Human Review', '325c3138-ad54-4041-95c1-b77857569da6', true),
  ('ppp-production', 'In Progress', '7f56f7da-0a18-4c9f-bdd7-d6bcab6f0738', true),
  ('ppp-production', 'In Progress', '453b39f4-fb93-4e10-8639-8acc50e98435', true),
  ('ppp-production', 'In Progress', '0e996f75-3b48-46d9-876d-c557bf9debc1', true),
  ('ppp-production', 'In Progress', '7de5fa7a-c80d-407d-8a69-dc145e4880de', true),
  ('ppp-production', 'In Progress', '605d17db-5009-4858-b211-c82c033457ef', true),
  ('ppp-production', 'In Progress', 'be3fe887-639c-469c-8be0-f4006050f5b8', true),
  ('ppp-production', 'In Progress', '868c3c25-7506-4b2e-89a4-5caf5704bb69', true),
  ('ppp-production', 'In Progress', '7b249881-bb5a-4133-b456-9452ded9ccf1', true),
  ('ppp-production', 'In Progress', '99ac8ed4-fde2-4ec5-8412-6cbd6bf3fe12', true),
  ('ppp-production', 'In Progress', 'd86e8a6c-c6f1-49d9-add2-d091c1cf46e6', true),
  ('ppp-production', 'In Progress', 'a20301f1-eb4b-41f6-bf69-ed771c58bf09', true),
  ('ppp-production', 'In Progress', 'c469db30-6ce4-48dd-b110-aa5ce69c61d2', true),
  ('ppp-production', 'In Progress', '0b473275-dcf8-49e5-bee9-5619a6629191', true),
  ('ppp-production', 'In Progress', '9f292155-86d9-479b-8d45-6929bfca01cc', true),
  ('ppp-production', 'In Progress', '7550521d-8f4b-4a98-bbb7-26e191305c02', true),
  ('ppp-production', 'In Review', '062f6553-2b1d-474b-bc45-bd9c05108d8d', true),
  ('ppp-production', 'In Review', '3924bda1-178c-4bc6-aff8-87a1f6208ce4', true),
  ('ppp-production', 'In Review', '76818b0c-a30e-487c-9cc6-1682d8601ac4', true),
  ('ppp-production', 'In Review', '61fac0f4-a96d-4f94-aba0-d1e08fbc1206', true),
  ('ppp-production', 'In Review', '23a231a1-beb6-4e33-8b09-bf45d1511f70', true),
  ('ppp-production', 'In Review', '3a126b81-d4c6-443a-b669-79515b2ed8fd', true),
  ('ppp-production', 'Parked', '7de5fa7a-c80d-407d-8a69-dc145e4880de', true),
  ('ppp-production', 'Queue', '7f56f7da-0a18-4c9f-bdd7-d6bcab6f0738', true),
  ('ppp-production', 'Queue', '453b39f4-fb93-4e10-8639-8acc50e98435', true),
  ('ppp-production', 'Queue', '0e996f75-3b48-46d9-876d-c557bf9debc1', true),
  ('ppp-production', 'Queue', '7de5fa7a-c80d-407d-8a69-dc145e4880de', true),
  ('ppp-production', 'Queue', '605d17db-5009-4858-b211-c82c033457ef', true),
  ('ppp-production', 'Queue', 'be3fe887-639c-469c-8be0-f4006050f5b8', true),
  ('ppp-production', 'Queue', '868c3c25-7506-4b2e-89a4-5caf5704bb69', true),
  ('ppp-production', 'Queue', '7b249881-bb5a-4133-b456-9452ded9ccf1', true),
  ('ppp-production', 'Queue', '99ac8ed4-fde2-4ec5-8412-6cbd6bf3fe12', true),
  ('ppp-production', 'Queue', 'd86e8a6c-c6f1-49d9-add2-d091c1cf46e6', true),
  ('ppp-production', 'Queue', 'a20301f1-eb4b-41f6-bf69-ed771c58bf09', true),
  ('ppp-production', 'Queue', 'c469db30-6ce4-48dd-b110-aa5ce69c61d2', true),
  ('ppp-production', 'Queue', '0b473275-dcf8-49e5-bee9-5619a6629191', true),
  ('ppp-production', 'Queue', '9f292155-86d9-479b-8d45-6929bfca01cc', true),
  ('ppp-production', 'Queue', '7550521d-8f4b-4a98-bbb7-26e191305c02', true),
  ('ppp-production', 'Registered', 'ba76cf8c-09c6-459b-991c-5af887a63e06', true),
  ('ppp-production', 'Registered', '47b9ab16-f7db-48c5-abad-acebc5f7bec6', true),
  ('ppp-production', 'Registered', 'a06eb06b-2f6f-42bc-b402-1e1991fb10d9', true),
  ('ppp-production', 'Registered', 'd963ac6e-8b28-4705-9635-4a7b8c688216', true),
  ('ppp-production', 'Spec', '7de5fa7a-c80d-407d-8a69-dc145e4880de', true),
  ('ppp-production', 'Spec', 'ba76cf8c-09c6-459b-991c-5af887a63e06', true),
  ('ppp-production', 'Spec', '47b9ab16-f7db-48c5-abad-acebc5f7bec6', true),
  ('ppp-production', 'Spec', 'a06eb06b-2f6f-42bc-b402-1e1991fb10d9', true),
  ('ppp-production', 'Spec', 'd963ac6e-8b28-4705-9635-4a7b8c688216', true);

INSERT INTO public.relay_stage_agent_pool (
  workspace_id,
  stage_name,
  agent_id,
  enabled
)
SELECT workspace.id, desired.stage_name, desired.agent_id, desired.enabled
FROM seed_stage_membership desired
JOIN public.workspace workspace ON workspace.slug = desired.workspace_slug
ON CONFLICT (workspace_id, stage_name, agent_id) DO UPDATE
SET enabled = EXCLUDED.enabled;

UPDATE public.relay_stage_agent_pool membership
SET enabled = false
FROM public.workspace workspace
WHERE membership.workspace_id = workspace.id
  AND workspace.slug IN ('gsp-multica', 'ppp-production')
  AND EXISTS (
    SELECT 1 FROM seed_stage_budget budget
    WHERE budget.workspace_slug = workspace.slug
      AND budget.stage_name = membership.stage_name
  )
  AND NOT EXISTS (
    SELECT 1 FROM seed_stage_membership desired
    WHERE desired.workspace_slug = workspace.slug
      AND desired.stage_name = membership.stage_name
      AND desired.agent_id = membership.agent_id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM seed_stage_budget desired
    JOIN public.workspace workspace ON workspace.slug = desired.workspace_slug
    JOIN public.relay_stage_pool policy
      ON policy.workspace_id = workspace.id AND policy.stage_name = desired.stage_name
    LEFT JOIN public.relay_stage_agent_pool membership
      ON membership.workspace_id = policy.workspace_id
      AND membership.stage_name = policy.stage_name
      AND membership.enabled
    LEFT JOIN public.agent agent ON agent.id = membership.agent_id
    GROUP BY desired.workspace_slug, desired.stage_name, desired.member_count,
      desired.capacity_budget, desired.enabled, policy.enabled
    HAVING count(membership.agent_id) <> desired.member_count
      OR COALESCE(sum(agent.max_concurrent_tasks), 0) <> desired.capacity_budget
      OR bool_and(policy.enabled) IS DISTINCT FROM desired.enabled
  ) THEN
    RAISE EXCEPTION 'stage capacity seed does not match its declared board budget';
  END IF;
END
$$;

COMMIT;
