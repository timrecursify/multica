# ALPHA-000262 result

Status: PASS

- Tickets: GSP-2454 (workdir leak); PPP-24208 (backup fixture notifications); GSP-2456 (graph build unavailable). Inbox transport duplicate is tracked by GSP-2448.
- Findings: terminal cleanup is scheduled at `server/internal/daemon/daemon.go:4820-4826`; authoritative DB gating is returned at `server/internal/handler/daemon.go:4331-4358`; the reclaim safety gate now recognizes nested repositories at `server/internal/daemon/gc.go:420-443`; the DB/meta cleaner and 200-row cap are at `ops/belt/workspace-gc.sh:8-56`.
- PRs: #693 merged as `6ceb75993f4861d192f3ef6c5d2339c1ee0ecf9c`; production-layout correction #696 merged as `4c94da05a5d3792ed96ce2e75aa173f6960d1db6`.
- CI: run `34101072658` PASS for #693; run `34102866804` PASS for #696. Local `workspace-gc.test.sh`, Bash syntax, and `git diff --check` PASS.
- Reclaim proposal: 589 directories, 5,853,643,872 bytes; 373 skipped as unpushed/unverifiable or descriptor-mismatched; 0 dirty. Seat receipt `DELETED-0856Z.paths` lists the executed paths, and the post-delete check found 0 still present.
- No deploy and no worker restart performed; release remains supervisor-owned.

Next action: TASK:79 deploy lane deploys merge `4c94da05a5d3792ed96ce2e75aa173f6960d1db6` and restarts workers under its authority.
