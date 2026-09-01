-- The relay bridge is the only authority allowed to change an existing issue
-- stage. Agent CLI, UI, gateway, and background-worker writes must use the
-- bridge's transaction-local capability instead of bypassing relay audit and
-- admission checks.
CREATE OR REPLACE FUNCTION require_relay_status_authority()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('multica.relay_authorized', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'issue status changes require relay authority'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issue_status_relay_authority ON issue;
CREATE TRIGGER issue_status_relay_authority
BEFORE UPDATE OF status ON issue
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION require_relay_status_authority();
