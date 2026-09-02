CREATE OR REPLACE FUNCTION public.require_qc_attempt_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verdict <> 'PASS' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM qc_attempt qa JOIN agent_task_queue t ON t.issue_id=qa.issue_id
    AND t.id::text=substring(qa.notes FROM 'relay_task_id=([0-9a-f-]{36})') AND t.status='completed'
    JOIN agent a ON a.id=t.agent_id WHERE qa.issue_id=NEW.issue_id AND qa.work_product_md5=NEW.work_product_md5
    AND qa.verdict=NEW.verdict AND qa.qualifying=true AND qa.bound_sha ~* '^[0-9a-f]{40}$'
    AND lower(qa.bound_sha)=lower(qa.observed_head) AND t.agent_id=NEW.checker_id
    AND a.model='gpt-5.6-sol' AND a.thinking_level='low') THEN
    RAISE EXCEPTION 'qc_attempt_binding_required' USING ERRCODE='23514';
  END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS qc_verdict_attempt_binding ON qc_verdict;
CREATE TRIGGER qc_verdict_attempt_binding BEFORE INSERT OR UPDATE OF verdict, checker_id, work_product_md5 ON qc_verdict
FOR EACH ROW EXECUTE FUNCTION public.require_qc_attempt_binding();
