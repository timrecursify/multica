# Multica belt — FIX and OPTIMISE — Sol-low lead — scope with Astra, build with Luna, QC, deploy in scope

Tim's goal (2026-09-07 04:48Z): "watching and fixing Multica and optimising it for faster
processing, less token waste, and process all tickets overnight."
Seat: DELTA-000944. Worktree: this directory, detached multica origin/main 706c9b27b; create your
branch `fix/belt-throughput-20260907` from it. A read-only OBSERVER desk (ALPHA-000165) writes
~/dev/multica-watch-20260907/WATCH-REPORT.md every 15 min — read it each cycle; do not duplicate it.
A separate Sol-low desk (ALPHA-000164, ~/dev/belt-codex-gate-20260907) is fixing the P0 "codex
refused" gate-shim failure — do NOT touch that; read its RESULT.md when it lands.

## Known defects and waste (from the previous seat, evidence in ~/dev/belt-recovery-20260907/ckpt.md)
1. Re-dispatch gap: a ticket whose stage task completes WITHOUT advancing is never re-dispatched
   (90 frozen In Progress, 0 live tasks, 58/59 agents idle). GSP-2385: no sk path releases Parked
   or Human Review. Fix the relay/reconciler so a completed-no-advance ticket gets exactly one
   bounded re-dispatch with a reason, not a keeper script.
2. Token waste: 12.6 tasks per ticket; 564/1605 completed tasks (35%) produced no stage change;
   worst PPP-23828 at 44 tasks. Tasks 79/hr -> 589/hr while closures fell 25 -> 3-6/hr. Find WHY a
   task completes without a stage change (spec quality? stage-outcome parser? PR link missing?)
   and fix the cause. Hypothesis (unproven): specs written by luna-low never converge; 9 spec
   agents were moved to gpt-5.6-sol low at ~03:00Z (rollback table agent_backup_20260907_model_ladder)
   — VERIFY spec tasks now complete green before trusting it.
3. GSP-2400: belt is CPU-bound on per-task venv/pnpm reinstalls. Cache per repo+lockfile hash.
4. Re-park trap ops/belt/multica-bridge.cjs:675 — retry_escalation.trigger_stage never cleared,
   so a ticket that escalated once re-parks forever (78 tickets re-parked tonight).
5. ADVANCED downgraded to FAILED when no PR linked (#622 supposed fix; observer counted 3 in 2h).
6. Human Review is money-only; 7 non-money tickets sit there. Astra lane unconfigured (no
   gpt-6-astra agent row, no astra class). Propose the config; do not create the agent row without
   the seat's sign-off (it changes routing of every HR ticket).
7. Deploy-verify false red: bin/ppp-deploy-artifact:170-171 greps the health body for
   sha|gitSha|commitSha|version and no app publishes any (PPP-24178). Make verification use a
   signal that exists (or make one app publish it) — smallest correct change.
8. CI cannot catch bridge regressions: multica-bridge.test.cjs never runs in belt-runtime job;
   integration tests self-skip on DATABASE_URL=postgres://test (GSP #2417 filed). Fix in CI with a
   throwaway Postgres service container.

## Ladder
- Phase 1 recon (you, read-only): `sk brain search` (2 queries), read the observer report, query the
  belt DB (Docker pg17 :25432, role gsp_multica, read-only; dbq.sh method in belt-recovery) for the
  numbers behind items 1, 2, 4, 5. Rank by closures gained per hour of work.
- Phase 2 scope with ONE Astra desk (`~/tools/spawn-openai.sh -m astra -e low -r work -C <this wt>`,
  timeout 900): give it your numbers; get the design for 1, 2, 3 and the ordering. Write WORKBOOK.md:
  packets, disjoint write-sets, acceptance tests, budget (tokens and hours), rollback per packet.
- Phase 3 build with Luna (one Luna-low per packet, `env -u SK_CALLSIGN -u SK_TASK_CALLSIGN
  ~/tools/spawn-openai.sh -m luna -e low -r work -b -C <packet worktree> --file <brief> </dev/null`;
  each packet its own worktree under ~/dev/). Files ≤ 500 lines, functions ≤ 40. Tests required.
- Phase 4 QC (you): run the tests, then measure on the live belt for 30 min after deploy:
  closures/hr, tasks per closure, tasks with no stage change. Numbers or it did not happen.
- Deploy: PR to multica, rebase on origin/main, merge when CI green (self-merge allowed), deploy
  with the belt's own deploy path producing a receipt (belt-YYYYMMDDTHHMMSSZ). Both copies (PPP +
  GSP) of every component; prove with pm_exec_path + process start time vs file mtime. Never deploy
  from ~/belt-check/multica (HEAD 7fe9ffead unpushed).

## Hard rules
- PPP-23686 is excluded from EVERYTHING (money gate). Never close a belt ticket by hand.
  Never raise RECONCILE_LIFETIME_TASK_LIMIT. Never force past the load governor (nproc 36; stop
  spawning above load 30). Never edit /etc/sk/perm, /usr/local/bin/codex, spawn.sh,
  spawn-governor.sh. Never create users. Never rotate creds. Never print relay.secret/operator.secret.
- Human Review: money or structural architecture only goes to Tim. Do not move HR tickets.
- One bounded change at a time on the live belt, with a rollback receipt. If closures/hr drops after
  a deploy, roll back first, then report.
- Kill every Luna/Astra child when it reports.

## Report
RESULT.md here every 2 hours (overwrite) and at the end: per item — cause path:line, change (PR,
SHA, receipt), before/after numbers with the exact query; what remains and why; asks for the seat.
Then `sk report new --machine gsp --agent codex --task multica-optimise --body -`.
