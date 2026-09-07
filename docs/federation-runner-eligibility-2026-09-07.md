## Purpose

This is a read-only eligibility record for the replacement-first federation
plan. It is evidence for review, not authorization to change runners, services,
logs, or PPP state.

## Observed inventory and provenance

Source: issue assessment digest `c7fb99f981ffcd9c4768f5df8e093131438037127b4b59c46d4c63f97b9e7713`,
recorded 2026-09-07T01:49:19Z. The assessment selected only `agentId`,
`agentName`, `gitHubUrl`, `poolName`, and `workFolder` from UTF-8-SIG `.runner`
files. GitHub online/busy and labels are response fields, not `.runner` fields.

| Pool | Runner | GitHub URL | Pool/work folder | Observed state |
| --- | --- | --- | --- | --- |
| GSP | 23 `gsp-gsp-desk-1` | `timrecursify/gsp-desk` | Default / `_work` | online, not busy |
| GSP | 24 `gsp-skci-1` | `timrecursify/sk-cli` | Default / `_work` | online, not busy |
| GSP | 25 `gsp-skci-2` | `timrecursify/sk-cli` | Default / `_work` | online, not busy |
| GSP | 26 `gsp-skci-3` | `timrecursify/sk-cli` | Default / `_work` | online, busy |
| Mint | 121 | — | — | online, not busy |
| Mint | 122 | — | — | online, busy |
| Mint | 123 | — | — | online, not busy |
| PPP | 98 `ppp-deploy-1` | — | — | online, not busy; label `prod-lax2` |
| PPP | 109–113 | — | — | online, not busy; labels `vps-prod`, `ppp-ci`, `ci-only`, `ci-build` (as observed) |

Capacity assumptions are bounded to the observation: four active GSP fedci
units, with `gsp-ci.slice` limits of 28 CPU cores and 214748364800 bytes of
memory. A target of 14 GSP runners is therefore **conditional**, not an
available capacity claim.

Runtime evidence: `/etc/systemd/system/gsp-runner-fedci@.service` uses
`User=gsp-runner`, `Slice=gsp-ci.slice`, and `/opt/gsp/runners/fedci-%i`; four
active roots had `.runner` and `.credentials` markers at bounded depth, with
no `_work` traversal. No package install, start, relabel, registration,
deregistration, reboot, PM2 action, or protected-log mutation was performed.

## Promotion and retirement checklist

Each gate must link to durable evidence before the decision is made. Missing or
stale evidence is a deterministic **HOLD** and causes no guest or runner
change.

- [ ] **Gate 1 — ownership/isolation:** identify the owning infrastructure
  repository, guest backend, immutable image, control-account boundary, lease
  store, audit sink, and outputs for escape/residue, cross-job residue,
  duplicate-placement, and crash-recovery tests. Sol-high approval recorded.
- [ ] **Gate 2 — GitHub tenancy:** verify GitHub App runner-group permission;
  run positive and negative selected-repository workflow tests in scratch
  tenant groups; keep production repositories untouched. Sol-high approval
  recorded.
- [ ] **Gate 3 — live capacity/eligibility:** rerun live capacity and workflow
  eligibility checks. Only if capacity and eligibility support it may a GSP
  target of 14 be proposed; otherwise retain the current target and HOLD.
- [ ] **Gate 4 — continuity/rollback:** deploy replacement first, verify
  workflow continuity and rollback, then document least privilege and
  boot/destroy latency. Retain Mint in the managed pool.
- [ ] **PPP retirement:** retire PPP only after replacement deployment and
  continuity verification are complete. Until Gates 1–2 are approved, do not
  relabel, register, deregister, or start stopped `gsp-runner-ppp-ci@` units.

Decision rule: any unchecked gate, unavailable live capacity, failed workflow
test, or missing provenance remains **HOLD**. This record does not authorize
production mutation; Sol-low QC sign-off is required for risk-path changes.
