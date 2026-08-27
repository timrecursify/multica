CREATE TABLE IF NOT EXISTS relay_stage_config (
    id integer PRIMARY KEY,
    stage_name text NOT NULL UNIQUE,
    next_stage text
);

INSERT INTO relay_stage_config (id, stage_name, next_stage)
VALUES
    (1, 'Registered', 'Spec'),
    (2, 'Spec', 'Queue'),
    (3, 'Queue', 'In Progress'),
    (4, 'In Progress', 'In Review'),
    (5, 'In Review', 'Fable QC'),
    (8, 'Fable QC', NULL),
    (9, 'Archived', NULL)
ON CONFLICT (id) DO NOTHING;
