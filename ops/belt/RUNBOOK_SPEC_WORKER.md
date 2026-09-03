# Runbook — native spec agent

This document uses the air-traffic-control terminology defined in `BELT.md`:
Tower, Flight, Aircrew, Approach Control, Ground, Flow Control, Fuel, Field.


Read `WORKER_COMMON.md` first. Use this runbook when the issue is in `Spec`.
The required lane is `gpt-5.6-sol` with `low` effort.

## Procedure

1. Bundle FIRST, before any other work. See "Bundling". Every flight you scope
   either folds into a mega or is proved to be its own unit of work. This step
   is never skipped and never left to QC.
2. Read the issue and identify its one requested outcome.
3. Reconcile every named path, identifier, and command against current source.
4. Search precedent once with `sk brain search` before deciding.
5. Use `sk graph impact <file>` before changing a known source file. Treat an
   empty, caveated answer as unknown.
6. Post a minimum, independently checkable specification on the unit of work:
   the mega if you folded, otherwise the flight itself.
7. Advance `Spec` to `Queue`; the relay queues the native build task.

Bundling is step 1 because a bundle made after a specification is written has
already spent that specification.

The relay refuses `Spec` to `Queue` for a flight that carries no specification,
and answers `spec_required`. Post the specification first; a build never starts
from an unwritten spec.

## Check out the source

The managed workdir is not a repository. It ships only `.multica` and
`.agent_context`, so steps 2 and 4 have no source to read until you create a
checkout. A flight does not carry a repository or a ref: resolve both yourself.
"The required source repository/ref is not attached" is not a blocker, it is
this step.

Pick the repository the issue names. When it names none, pick from the
workspace's own list and state the choice in the `## Repository` heading:

| Board | Repositories |
| --- | --- |
| `gsp` | `sk-cli`, `multica`, `ppp` |
| `prod` | `ppp`, `sk-cli` |

`sk multica qc-checkout` takes a full 40-character commit SHA, so resolve the
default branch head first:

```bash
REPO="https://github.com/timrecursify/<repo>"
SHA="$(git ls-remote "$REPO" HEAD | awk '{print $1}')"
[ -n "$SHA" ] || exit 1                          # unresolved head: SPEC-BLOCKED
CHECKOUT="$(sk multica qc-checkout "$REPO" --ref "$SHA" | jq -r .path)"
```

Read source with `$CHECKOUT` as the working directory, and cite `path:line`
against it. `sk graph impact` needs a git working directory, so run it there
too. Record the `SHA` in the `## Evidence` block: it is what makes a cited line
independently checkable.

The checkout is read-only and is never reaped, so remove it when the
specification is posted (GSP #763):

```bash
chmod -R u+w "$CHECKOUT" && rm -rf "$CHECKOUT"
```

Report `SPEC-BLOCKED` for missing source only after this procedure fails.
Reporting it without running the resolve step strands the flight in `Spec` with
no specification, which is what stalled 36 flights on 2026-08-31.

## Bundling

Fleet intake arrives in bursts, and a burst usually holds one defect reported
many times. Specifying each report separately spends a build, a review and a
merge on every copy of one change.

Bundle when two or more parked flights would be closed by the same change. The
count is not the test: shared root cause is. Two reports of one broken function
bundle; twenty unrelated requests against one file do not.

Bundling belongs to the scoping agent and to nobody else. It happens on
arrival, before a specification exists. QC does not bundle: by the time a flight
reaches review its build has already been paid for, so a bundle made there saves
nothing that was worth saving.

### Join an existing mega before you create one

Most arriving flights belong to a mega that already exists. Search open megas
for the same root cause first, and fold into the match rather than opening a
second one:

```bash
sk multica issue-list --board gsp --status Spec --search "MEGA" | head -40
sk multica issue-update <this-flight> --parent <existing-mega-id> --no-start
python3 /home/newadmin/tools/multica-bundle.py --mega <existing-mega-number> --apply
```

A second mega for a root cause that already has one splits the work in two, and
both halves get built.

### Tooling-gap reports

Two thirds of intake is `sk` gap reports: 649 of the 963 flights raised in the
24h to 2026-08-31. The contract requires filing them, so that volume is correct
and must not be suppressed. What is wrong is filing one flight per SYMPTOM.
`sk github REST facade cannot retrieve git refs` and `sk github REST facade:
repeated --query filters are ignored on actions runs` are one broken facade, not
two units of work.

Fold tooling-gap reports by module and root cause: one mega per broken surface,
with each symptom folded in as evidence for it.

A mega flight is the ONLY unit of work its children have. A worker must never
be shown both a mega and one of its children: given two canonical options it
builds the wrong one, or both. So bundling is not finished when the children
are attached -- it is finished when their content lives on the mega and the
children are no longer visible.

### Procedure

1. Search `Registered` and `Spec` for siblings before writing anything.
2. Create the mega flight:
   `sk multica issue-create --status Registered --title "MEGA: <subsystem> — <shared outcome>"`.
   The title must begin with `MEGA`: both dispatch guards match on that prefix.
3. Attach every sibling: `sk multica issue-update <child> --parent <mega-id> --no-start`.
4. Fold the children in and hide them:

   ```bash
   python3 /home/newadmin/tools/multica-bundle.py --mega <mega-number> --apply
   ```

   This copies each child's title, description and acceptance criteria into a
   `## Bundled work` section on the mega, reads the mega back to confirm the
   content is actually there, and only then sets the child to `Archived` with
   `metadata.bundled_into` pointing at the mega. A child whose content did not
   land is reported `BLOCKED` and is left open: never archive it by hand.
   Re-running is safe -- an unchanged child is skipped, and the section is
   rebuilt from the mega's own text rather than appended to.
5. Write the specification on the mega flight against the folded content, not
   against the child list. One shared change, one acceptance test.
6. Advance only the mega flight.

### A bucket is not a bundle

Bundling by subsystem and defect class produces a classification report, not a
unit of work. `MEGA: sk-repo — capability-gap (59 tickets)` names a subsystem and
a category; it does not name one fix, and no single change set closes 59
unrelated capability gaps. Handed to a builder it produces a change that cannot
pass review, and it fails again on every retry.

Before writing a specification on a mega, apply the shared-root-cause test to
the folded content itself:

- If every folded ticket is closed by one change, specify it and advance.
- If not, the mega is a bucket. Split it before specifying: create narrower
  megas, each named for the one outcome it delivers, and move members across
  with

  ```bash
  python3 /home/newadmin/tools/multica-bundle.py --unbundle <ticket-number> --apply
  python3 /home/newadmin/tools/multica-bundle.py --mega <new-mega-number> --apply
  ```

  `--unbundle` returns one folded ticket to `Registered` and detaches it, so
  regrouping never has to be done by hand against an archived row.

Treat a title of the form `<subsystem> — <defect_class> (N tickets)`, or a mega
carrying more than roughly eight folded tickets, as a bucket until the content
proves otherwise. Say in the specification which test the mega passed.

### What you must not do

- Do not list bare child numbers as the specification. A list of integers is
  not a work product: it sent MEGA #643 to a builder as `100 12 172 4 62` and
  nothing else, and archiving its children would have destroyed the only copy
  of the requirement.
- Do not copy child comment threads into the mega. They are build and QC
  transcripts, and on the live board they outweigh the actual reports 20:1.
  The archived child keeps its own thread; the mega links to it.
- Do not archive a child that is already past `In Progress`. It has a work
  product of its own in flight; leave it to finish and say so on the mega.
- Do not advance a child. Both the bridge and the requeue daemon withhold a
  paid task for a child of an open mega, so an advanced child moves stage,
  spends nothing, and simply stops.

## Spec comment

The workspace holds more than one repository, so a specification that does not
name its target lets the builder choose. Name the repository every time.

```markdown
## Goal
One sentence describing the completed behavior.

## Repository
The one repository the change lands in.

## Evidence
- `path:line` — verified current behavior.
- Not checked: explicit omissions.

## Spec
1. Minimum implementation step.
2. Independently checkable acceptance criteria.

## ETA
Size and the condition that could extend it.
```

A question receives an answer, not a build. Stop rather than guessing when the
code cannot support a verifiable specification.
