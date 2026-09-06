# Federation runners plan v2.0

This plan is a design and deployment gate, not authorization to modify any
production runner. The existing runner freeze remains in force until gates 1
and 2 below are approved by Sol-high.

## Isolation model

Every overflow job is assigned a fresh, immutable, content-addressed guest.
The guest receives a single-use runner registration token through a broker;
control credentials are never mounted, persisted, or exposed to the job. The
guest is destroyed on completion, timeout, or failure. The broker reaps guests
whose lease has expired and records claim, start, completion, destroy, and
failure events in an append-only audit stream. No host workspace, image layer,
network volume, or credential is shared between jobs.

Placement uses a database transaction with a unique job key and fencing token:
claim, lease renewal, and completion all reject stale tokens. Policy is checked
at claim time and again immediately before guest start. Retries therefore
cannot produce duplicate placement or allow a job to cross a tenant boundary.

## Tenant and routing policy

The versioned policy source maps tenant to selected repositories and runner
group. Native execution is preferred; federation is an up-only overflow path
from a client box to an approved federation box (gsp, mint, or noc2), never
sideways or downward. The same policy is evaluated by placement and guest
startup. A repository not selected for a group must receive a deterministic
policy denial and no guest.

GitHub organization runner groups are created per tenant with selected-
repository visibility. The GitHub App permission required for runner-group
administration must be verified and widened by the owning infrastructure team
before any group or runner registration change.

## Gates and ownership

1. **Gate 1 — infrastructure ownership and guest isolation:** confirm the
   owning infrastructure repository, guest backend, immutable image source,
   control-account boundary, lease store, audit sink, and escape/residue,
   cross-job residue, duplicate-placement, and crash-recovery test outputs.
2. **Gate 2 — GitHub tenancy:** confirm the App permission, create scratch
   tenant groups, and record positive and negative selected-repository workflow
   tests. Production repositories remain untouched until approval.
3. **Gate 3 — operations:** record boot/destroy latency and capacity, review
   least privilege, remove and audit the `91-gsp-runner` sudoers fragment, and
   exercise rollback. Rollback must never re-enable that fragment.

Until gates 1–2 are explicitly approved, do not relabel, re-register, or
deregister runners, and do not start the stopped `gsp-runner-ppp-ci@` units.
