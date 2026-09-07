CREATE TABLE IF NOT EXISTS issue_work_product (
  issue_id                  uuid        NOT NULL,
  scope_revision            bigint      NOT NULL CHECK (scope_revision > 0),
  kind                      text        NOT NULL CHECK (kind IN ('implementation', 'no_change', 'operational')),
  repository                text        NULL,
  branch                    text        NULL,
  pr_number                 integer     NULL CHECK (pr_number IS NULL OR pr_number > 0),
  head_sha                  text        NULL CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  acceptance_evidence       jsonb       NOT NULL,
  replaces_scope_revision   bigint      NULL CHECK (
    replaces_scope_revision IS NULL OR (
      replaces_scope_revision > 0 AND replaces_scope_revision <> scope_revision
    )
  ),
  consuming_stage           text        NOT NULL CHECK (consuming_stage IN (
    'In Progress', 'In Review', 'CI/CD & Deploy', 'Done'
  )),
  dependency_issue_ids      uuid[]      NOT NULL DEFAULT '{}'::uuid[],
  status                    text        NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'superseded', 'consumed')
  ),
  created_at                timestamptz NOT NULL DEFAULT NOW(),
  updated_at                timestamptz NOT NULL DEFAULT NOW(),
  CHECK (
    jsonb_typeof(acceptance_evidence) = 'object'
    AND acceptance_evidence <> '{}'::jsonb
  ),
  CHECK (
    (
      kind = 'implementation'
      AND repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
      AND NULLIF(branch, '') IS NOT NULL
      AND pr_number IS NOT NULL
      AND head_sha IS NOT NULL
    )
    OR (
      kind IN ('no_change', 'operational')
      AND repository IS NULL
      AND branch IS NULL
      AND pr_number IS NULL
      AND head_sha IS NULL
      AND acceptance_evidence->>'verified' = 'true'
    )
  )
);
