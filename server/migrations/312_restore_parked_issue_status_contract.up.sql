-- GSP-2676: restore the live twelve-status issue contract without rewriting
-- existing dispositions or changing the Parked release route.
ALTER TABLE issue
    DROP CONSTRAINT issue_status_check,
    ADD CONSTRAINT issue_status_check CHECK (status IN
        ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
         'Human Review', 'Parked', 'Rejected', 'CI/CD & Deploy', 'Done',
         'Archived', 'Cancelled'));
