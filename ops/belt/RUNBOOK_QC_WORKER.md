# Runbook — native QC agent

Read `WORKER_COMMON.md` first. Use this runbook for an issue in `In Review`.
Emit the model and effort your agent actually runs (see your task context); the accepted lane set is `QC_LANE_MODELS` at low effort.

## Review

1. Read every acceptance criterion and the builder work-product comment.
2. The task prompt supplies `NUMBER`, the pull-request HTTPS URL (`REPO`), and
   full bound SHA (`BOUND_SHA`). Run `sk multica qc-checkout "$REPO" --ref
   "$BOUND_SHA"`. Its JSON `.path` is `CHECKOUT` and `.sha` must equal
   `BOUND_SHA`; otherwise use the BLOCKED procedure.
3. Run the smallest check that can prove or disprove each criterion.
4. Compute the exact MD5 of the complete tracked-tree manifest at `BOUND_SHA`.
5. Use the verdict procedure below. Do not write `qc_verdict` with SQL.

The managed workdir is not a repository. If no pull request, repository,
checkout, bound SHA, or review evidence is available, use `FAIL` with a
`BLOCKED:` reason. Do not leave the issue without a verdict.

## Submit one verdict

`BOARD` comes from `MULTICA_WORKSPACE_ID` using `WORKER_COMMON.md`. `NUMBER`,
`REPO`, and `BOUND_SHA` come from the task prompt. `CHECKOUT` comes from the
`.path` field of `sk multica qc-checkout "$REPO" --ref "$BOUND_SHA"`. Run this
procedure once with `VERDICT=PASS` or `VERDICT=FAIL`. Use only `sk multica
verdict` and `sk multica advance` for state changes: never curl, use a secret,
or write SQL.

Minimum sk-cli requirement: `sk multica verdict` must accept `--board gsp`; if its help says prod only, the checker aborts with `BLOCKED`.

```bash
CHECKOUT_RESULT="$(sk multica qc-checkout "$REPO" --ref "$BOUND_SHA")"
CHECKOUT="$(jq -r '.path' <<<"$CHECKOUT_RESULT")"
OBSERVED_SHA="$(jq -r '.sha' <<<"$CHECKOUT_RESULT")"
test "$OBSERVED_SHA" = "$BOUND_SHA"
WORK_PRODUCT_MD5="$(git -C "$CHECKOUT" ls-tree -r --full-tree "$BOUND_SHA" | LC_ALL=C sort | md5sum | cut -d' ' -f1)"
FAILURE_CLASS=none; QUALIFYING=true
# For a defect: FAILURE_CLASS=implementation; QUALIFYING=false.
# For an unavailable prerequisite: FAILURE_CLASS=evidence|tool|access;
# QUALIFYING=false; BLOCKED_REASON='actionable reason'
IDEM_KEY="qc-${NUMBER}-${BOUND_SHA}-${VERDICT}"
QC_MODEL="${QC_MODEL:?set to the model from your task context}"
QC_EFFORT="${QC_EFFORT:?set to the effort from your task context}"
VERDICT_NOTES=''
if [ "$VERDICT" = FAIL ]; then
  VERDICT_NOTES="${REWORK_SUMMARY:?set a concise rework summary}"
  test -z "${BLOCKED_REASON:-}" || VERDICT_NOTES="BLOCKED: $BLOCKED_REASON"
fi
QC_EVIDENCE_JSON="$(jq -cn --arg verdict "$VERDICT" --arg work_product_md5 "$WORK_PRODUCT_MD5" \
  --arg bound_sha "$BOUND_SHA" --arg observed_sha "$OBSERVED_SHA" \
  --arg failure_class "$FAILURE_CLASS" --arg model "$QC_MODEL" --arg effort "$QC_EFFORT" \
  --argjson qualifying "$QUALIFYING" \
  '{verdict:$verdict,work_product_md5:$work_product_md5,bound_sha:$bound_sha,observed_sha:$observed_sha,failure_class:$failure_class,qualifying:$qualifying,model:$model,effort:$effort}')"
printf 'QC_EVIDENCE_JSON=%s\n' "$QC_EVIDENCE_JSON"
test -z "${BLOCKED_REASON:-}" || printf 'BLOCKED: %s\n' "$BLOCKED_REASON"
sk multica verdict "$NUMBER" --board "$BOARD" --verdict "$VERDICT" \
  --bound-sha "$BOUND_SHA" --observed-sha "$OBSERVED_SHA" \
  --work-product-md5 "$WORK_PRODUCT_MD5" --failure-class "$FAILURE_CLASS" \
  --qualifying "$QUALIFYING" --model "$QC_MODEL" --effort "$QC_EFFORT" --idem-key "$IDEM_KEY" \
  --notes "$VERDICT_NOTES"
```

The `QC_EVIDENCE_JSON=` line must be in the completed task output exactly once.
It must contain exactly the bridge-required fields shown above and match the
verdict command. `bound_sha` and `observed_sha` must be the same full SHA.
Use a new `IDEM_KEY` when the evidence changes.

For PASS, set `FAILURE_CLASS=none`, `QUALIFYING=true`, then run
`sk multica advance "$NUMBER" --to "CI/CD & Deploy" --current-work-product-md5 "$WORK_PRODUCT_MD5" --board "$BOARD"`.
For FAIL, include a concise rework list in the work-product comment, post the
verdict, then run `sk multica advance "$NUMBER" --to "In Progress" --current-work-product-md5 "$WORK_PRODUCT_MD5" --board "$BOARD"`.

## QC-BLOCKED

QC-BLOCKED means QC cannot verify the change. Put `BLOCKED: <reason>` in the
task output, post `FAIL` with `FAILURE_CLASS=evidence|tool|access` and
`QUALIFYING=false`, then run
`sk multica advance "$NUMBER" --to "In Progress" --current-work-product-md5 "$WORK_PRODUCT_MD5" --board "$BOARD"`.
This uses the normal FAIL route instead of stalling in review.
