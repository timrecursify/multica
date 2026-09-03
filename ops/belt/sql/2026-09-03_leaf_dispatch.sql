-- Leaf dispatch (2026-09-03).
-- Old rule: reject a builder task for any issue whose parent is still open
-- ("the MEGA is the unit of work"). That starved every MEGA child: 41 Queue
-- issues (26 GSP, 15 PPP) could never get a task, and the belt ran 2 builders.
-- New rule: a rollup - an issue that still has a non-terminal child - takes no
-- task of its own; a leaf dispatches whether or not it has a parent.
CREATE OR REPLACE FUNCTION public.reject_bundled_child_task()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.issue_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM issue c
              WHERE c.parent_issue_id = NEW.issue_id
                AND c.status NOT IN ('Done','Cancelled','Archived')) THEN
    RAISE EXCEPTION 'rollup_has_open_children: issue % still has open children; the children are the unit of work', NEW.issue_id;
  END IF;
  RETURN NEW;
END $function$;
