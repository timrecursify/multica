-- Roll back the effective-verdict projection and write guards without deleting
-- any audit row. Derived internal idem_key values remain unique and preserve
-- events written after the forward migration.
DROP VIEW IF EXISTS public.qc_effective_verdict;

DROP TRIGGER IF EXISTS qc_attempt_immutable ON public.qc_attempt;
DROP FUNCTION IF EXISTS public.reject_qc_attempt_mutation();
DROP TRIGGER IF EXISTS qc_attempt_event_defaults ON public.qc_attempt;
DROP FUNCTION IF EXISTS public.prepare_qc_attempt_event();

ALTER TABLE public.qc_attempt
  DROP CONSTRAINT IF EXISTS qc_attempt_event_kind_check,
  DROP CONSTRAINT IF EXISTS qc_attempt_scope_revision_check,
  DROP CONSTRAINT IF EXISTS qc_attempt_payload_hash_check,
  DROP CONSTRAINT IF EXISTS qc_attempt_sha_binding_check,
  DROP COLUMN IF EXISTS source_idem_key,
  DROP COLUMN IF EXISTS event_kind,
  DROP COLUMN IF EXISTS checker_id,
  DROP COLUMN IF EXISTS evidence_task_id,
  DROP COLUMN IF EXISTS scope_revision,
  DROP COLUMN IF EXISTS payload_hash;
