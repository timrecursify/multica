-- Make qc_attempt an immutable event ledger. The original idem_key remains a
-- unique internal event key; source_idem_key records the caller's replay key,
-- so a changed payload can be retained as a distinct event.
ALTER TABLE public.qc_attempt
  ADD COLUMN IF NOT EXISTS source_idem_key text,
  ADD COLUMN IF NOT EXISTS event_kind text,
  ADD COLUMN IF NOT EXISTS checker_id uuid,
  ADD COLUMN IF NOT EXISTS evidence_task_id uuid,
  ADD COLUMN IF NOT EXISTS scope_revision bigint,
  ADD COLUMN IF NOT EXISTS payload_hash text;

UPDATE public.qc_attempt qa
   SET source_idem_key = COALESCE(qa.idem_key, 'legacy-qc-attempt-' || qa.id::text),
       event_kind = 'reviewer_verdict',
       evidence_task_id = CASE
         WHEN substring(COALESCE(qa.notes, '') FROM
           'relay_task_id=([0-9a-f-]{36})') ~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN substring(COALESCE(qa.notes, '') FROM
           'relay_task_id=([0-9a-f-]{36})')::uuid
         ELSE '00000000-0000-0000-0000-000000000000'::uuid
       END,
       checker_id = COALESCE((
         SELECT task.agent_id
           FROM public.agent_task_queue task
          WHERE task.id::text = substring(COALESCE(qa.notes, '') FROM
            'relay_task_id=([0-9a-f-]{36})')
          LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid),
       scope_revision = COALESCE((
         SELECT floor(extract(epoch FROM task.created_at) * 1000000)::bigint
           FROM public.agent_task_queue task
          WHERE task.id::text = substring(COALESCE(qa.notes, '') FROM
            'relay_task_id=([0-9a-f-]{36})')
          LIMIT 1),
         floor(extract(epoch FROM COALESCE(qa.created_at, clock_timestamp())) * 1000000)::bigint)
 WHERE source_idem_key IS NULL OR event_kind IS NULL OR checker_id IS NULL
    OR evidence_task_id IS NULL OR scope_revision IS NULL;

UPDATE public.qc_attempt
   SET payload_hash = md5(concat_ws(chr(31), issue_id::text, checker_id::text,
     COALESCE(checker_name, ''), event_kind, evidence_task_id::text,
     scope_revision::text, verdict, COALESCE(work_product_md5, ''),
     COALESCE(bound_sha, ''), COALESCE(observed_head, ''), failure_class,
     qualifying::text, COALESCE(model, ''), COALESCE(effort, ''),
     COALESCE(notes, '')))
 WHERE payload_hash IS NULL;

ALTER TABLE public.qc_attempt
  ALTER COLUMN source_idem_key SET NOT NULL,
  ALTER COLUMN event_kind SET DEFAULT 'reviewer_verdict',
  ALTER COLUMN event_kind SET NOT NULL,
  ALTER COLUMN checker_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  ALTER COLUMN checker_id SET NOT NULL,
  ALTER COLUMN evidence_task_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  ALTER COLUMN evidence_task_id SET NOT NULL,
  ALTER COLUMN scope_revision SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.qc_attempt'::regclass
       AND conname = 'qc_attempt_event_kind_check'
  ) THEN
    ALTER TABLE public.qc_attempt ADD CONSTRAINT qc_attempt_event_kind_check
      CHECK (event_kind IN ('reviewer_verdict', 'post_gate_disposition')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.qc_attempt'::regclass
       AND conname = 'qc_attempt_scope_revision_check'
  ) THEN
    ALTER TABLE public.qc_attempt ADD CONSTRAINT qc_attempt_scope_revision_check
      CHECK (scope_revision > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.qc_attempt'::regclass
       AND conname = 'qc_attempt_payload_hash_check'
  ) THEN
    ALTER TABLE public.qc_attempt ADD CONSTRAINT qc_attempt_payload_hash_check
      CHECK (payload_hash ~ '^[0-9a-f]{32}([0-9a-f]{32})?$') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.qc_attempt'::regclass
       AND conname = 'qc_attempt_sha_binding_check'
  ) THEN
    ALTER TABLE public.qc_attempt ADD CONSTRAINT qc_attempt_sha_binding_check
      CHECK (bound_sha ~* '^[0-9a-f]{40}$' AND
             observed_head ~* '^[0-9a-f]{40}$' AND
             lower(bound_sha) = lower(observed_head)) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.qc_effective_verdict AS
WITH normalized AS (
  SELECT qa.*,
         qa.bound_sha ~* '^[0-9a-f]{40}$' AND
         qa.observed_head ~* '^[0-9a-f]{40}$' AND
         lower(qa.bound_sha) = lower(qa.observed_head) AS binding_valid
    FROM public.qc_attempt qa
), ranked AS (
  SELECT normalized.*,
         row_number() OVER (
           PARTITION BY issue_id
           ORDER BY scope_revision DESC,
             CASE event_kind WHEN 'post_gate_disposition' THEN 1 ELSE 0 END DESC,
             CASE verdict WHEN 'FAIL' THEN 1 ELSE 0 END DESC,
             created_at DESC NULLS LAST, id DESC
         ) AS effective_rank
    FROM normalized
)
SELECT id, issue_id, source_idem_key, idem_key, event_kind, checker_id,
       checker_name, evidence_task_id, scope_revision,
       verdict AS recorded_verdict,
       CASE WHEN binding_valid THEN verdict ELSE 'FAIL' END AS verdict,
       work_product_md5, bound_sha, observed_head, failure_class,
       CASE WHEN binding_valid THEN qualifying ELSE false END AS qualifying,
       model, effort, payload_hash, notes, created_at
  FROM ranked
 WHERE effective_rank = 1;

-- Keep the migration safe across the migration/process rollout boundary and
-- for the legacy reconciliation utility. New bridge writes supply every field;
-- older writers are normalized into reviewer events before constraints run.
CREATE OR REPLACE FUNCTION public.prepare_qc_attempt_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_id_text text;
  bound_task_id uuid;
  bound_checker_id uuid;
  bound_scope_revision bigint;
BEGIN
  task_id_text := substring(COALESCE(NEW.notes, '') FROM
    'relay_task_id=([0-9a-f-]{36})');
  IF task_id_text ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    bound_task_id := task_id_text::uuid;
    SELECT task.agent_id,
           floor(extract(epoch FROM task.created_at) * 1000000)::bigint
      INTO bound_checker_id, bound_scope_revision
      FROM public.agent_task_queue task
     WHERE task.id = bound_task_id;
  END IF;
  NEW.source_idem_key := COALESCE(NEW.source_idem_key, NEW.idem_key);
  NEW.event_kind := COALESCE(NEW.event_kind, 'reviewer_verdict');
  NEW.evidence_task_id := COALESCE(
    NULLIF(NEW.evidence_task_id, '00000000-0000-0000-0000-000000000000'::uuid),
    bound_task_id, '00000000-0000-0000-0000-000000000000'::uuid);
  NEW.checker_id := COALESCE(
    NULLIF(NEW.checker_id, '00000000-0000-0000-0000-000000000000'::uuid),
    bound_checker_id, '00000000-0000-0000-0000-000000000000'::uuid);
  NEW.scope_revision := COALESCE(NEW.scope_revision, bound_scope_revision,
    floor(extract(epoch FROM COALESCE(NEW.created_at, clock_timestamp())) * 1000000)::bigint);
  NEW.payload_hash := COALESCE(NEW.payload_hash, md5(concat_ws(chr(31),
    NEW.issue_id::text, NEW.checker_id::text, COALESCE(NEW.checker_name, ''),
    NEW.event_kind, NEW.evidence_task_id::text, NEW.scope_revision::text,
    NEW.verdict, COALESCE(NEW.work_product_md5, ''), COALESCE(NEW.bound_sha, ''),
    COALESCE(NEW.observed_head, ''), NEW.failure_class, NEW.qualifying::text,
    COALESCE(NEW.model, ''), COALESCE(NEW.effort, ''), COALESCE(NEW.notes, ''))));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS qc_attempt_event_defaults ON public.qc_attempt;
CREATE TRIGGER qc_attempt_event_defaults
  BEFORE INSERT ON public.qc_attempt
  FOR EACH ROW EXECUTE FUNCTION public.prepare_qc_attempt_event();

CREATE OR REPLACE FUNCTION public.reject_qc_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'qc_attempt events are immutable' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS qc_attempt_immutable ON public.qc_attempt;
CREATE TRIGGER qc_attempt_immutable
  BEFORE UPDATE OR DELETE ON public.qc_attempt
  FOR EACH ROW EXECUTE FUNCTION public.reject_qc_attempt_mutation();
