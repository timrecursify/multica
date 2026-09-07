-- Enforce the QC verdict hash contract for new writes without rewriting
-- historical malformed rows. NOT VALID keeps legacy data auditable while
-- PostgreSQL still checks every INSERT and UPDATE going forward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.qc_verdict'::regclass
      AND conname = 'qc_verdict_work_product_md5_check'
  ) THEN
    ALTER TABLE public.qc_verdict
      ADD CONSTRAINT qc_verdict_work_product_md5_check
      CHECK (work_product_md5 ~* '^[0-9a-f]{32}$') NOT VALID;
  END IF;
END $$;
