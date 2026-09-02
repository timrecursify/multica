-- Required before deploying the SHA-bound merge admission worker.
-- qc_verdict is the authoritative current QC record; these fields make its
-- Sol-low qualification and reviewed commit queryable instead of comment text.
BEGIN;
ALTER TABLE public.qc_verdict ADD COLUMN IF NOT EXISTS bound_sha text;
ALTER TABLE public.qc_verdict ADD COLUMN IF NOT EXISTS qualifying boolean;
ALTER TABLE public.qc_verdict ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE public.qc_verdict ADD COLUMN IF NOT EXISTS effort text;
CREATE INDEX IF NOT EXISTS idx_qc_verdict_admission
  ON public.qc_verdict (issue_id, created_at DESC);
COMMIT;
