
## Seat order 2026-09-07T05:12Z (Tim, via DELTA-000944)
- Astra over-engineers. Use Astra for consulting only. Strip every Astra design to the smallest correct change before any Luna packet: no new layers, abstractions, tools, limits, or timeouts that the acceptance test does not need. Record in WORKBOOK.md what you removed from the Astra proposal.
- Every issue you find outside your scope: file a ticket (sk multica for GSP/PPP; sk-cli stream for sk defects) and list it in RESULT.md. Never fix it silently, never leave it as a note.

## Seat data 2026-09-07T05:20Z (DELTA-000944) — belt churn measured on disk
- /var/lib/gsp/multica/workspaces: 3467 per-task clone dirs, ALL younger than 24 h: 2154 in the last 6 h, 816 in 6-12 h, 497 in 12-24 h. That is ~360 task workspaces per hour, each a full clone (~130 MB avg; sk-cli/ppp clones + node_modules). 442 GB, +10.5 MiB/s. Worker PrivateTmp holds ~413 multica-task-* dirs of 0.5-2 GB (venv/pnpm per task, GSP-2400).
- No GC anywhere (ticket GSP-2422). The seat is reclaiming dirs older than 2 h with no live process now; ALPHA-000163 owns the GC + sentinel work. YOUR lever is the task count: 360 tasks/h with closures at 3-6/h is the waste. Item 2 in your brief (tasks completing with no stage change) is the priority; measure tasks/h and closures/h before and after each change.
- Live task cwds observed: 44 (two daemons, max-concurrent 30 each).
