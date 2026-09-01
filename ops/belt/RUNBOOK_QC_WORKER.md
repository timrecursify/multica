# Runbook — native QC agent

Read `WORKER_COMMON.md` first. Use this runbook for an issue in `In Review`.
The required lane is `gpt-5.6-sol` with `low` effort.

## Review

1. Read every acceptance criterion and the builder work-product comment.
2. Resolve the pull request head to its full 40-character SHA. Check out that
   SHA with `sk multica qc-checkout`, then open the cited files.
3. Run the smallest check that can prove or disprove each criterion.
4. Compute the exact MD5 of the current `## What changed` work-product comment.
5. Use the verdict procedure below. Do not write `qc_verdict` with SQL.

The managed workdir is not a repository. If no pull request, repository,
checkout, bound SHA, or review evidence is available, use `FAIL` with a
`BLOCKED:` reason. Do not leave the issue without a verdict.

## Submit one verdict

Set `BOARD` and `NUMBER` from `WORKER_COMMON.md`. `RELAY_URL` is the bridge
base URL and `RELAY_AGENT_SECRET` is the issued relay token. Do not print the
token. Run this procedure once with `VERDICT=PASS` or `VERDICT=FAIL`.

```bash
READBACK="$(sk multica readback "$NUMBER" --board "$BOARD")"
ISSUE_ID="$(jq -r '.issue_id' <<<"$READBACK")"
WORK_PRODUCT="$(jq -r '[.comments[] | select(.content | startswith("## What changed"))] | last.content' <<<"$READBACK")"
WORK_PRODUCT_MD5="$(printf '%s' "$WORK_PRODUCT" | md5sum | cut -d' ' -f1)"
BOUND_SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
OBSERVED_SHA="$BOUND_SHA"
FAILURE_CLASS=none; QUALIFYING=true; NOTES="Criteria verified."
# For a defect: FAILURE_CLASS=implementation; QUALIFYING=false.
# For an unavailable prerequisite: FAILURE_CLASS=evidence|tool|access;
# QUALIFYING=false; NOTES='BLOCKED: actionable reason.'
QC_EVIDENCE_JSON="$(jq -cn --arg issue_id "$ISSUE_ID" --arg checker "$MULTICA_AGENT_NAME" \
  --arg verdict "$VERDICT" --arg work_product_md5 "$WORK_PRODUCT_MD5" \
  --arg bound_sha "$BOUND_SHA" --arg observed_sha "$OBSERVED_SHA" \
  --arg failure_class "$FAILURE_CLASS" --arg model gpt-5.6-sol --arg effort low \
  --arg idem_key "qc-${ISSUE_ID}-${BOUND_SHA}-${VERDICT}" \
  --argjson qualifying "$QUALIFYING" \
  '{issue_id:$issue_id,checker:$checker,verdict:$verdict,work_product_md5:$work_product_md5,bound_sha:$bound_sha,observed_sha:$observed_sha,failure_class:$failure_class,qualifying:$qualifying,model:$model,effort:$effort,idem_key:$idem_key}')"
printf 'QC_EVIDENCE_JSON=%s\n' "$QC_EVIDENCE_JSON"
curl --fail-with-body --request POST "$RELAY_URL/relay/verdict" \
  --header 'Content-Type: application/json' \
  --data "$(jq -cn --arg token "$RELAY_AGENT_SECRET" --arg notes "$NOTES" \
    --argjson evidence "$QC_EVIDENCE_JSON" '$evidence + {agent_token:$token,notes:$notes}')"
```

The `QC_EVIDENCE_JSON=` line must be in the completed task output exactly once.
Its fields must exactly match the POST body. `bound_sha` and `observed_sha`
must be the same full SHA. Use a new `idem_key` when the evidence changes.

For PASS, set `FAILURE_CLASS=none`, `QUALIFYING=true`, and then advance to
`CI/CD & Deploy` with the same `WORK_PRODUCT_MD5`. For FAIL, include a concise
rework list in `NOTES`, post the verdict, then advance to `In Progress`.

## QC-BLOCKED

QC-BLOCKED means QC cannot verify the change. Post `FAIL` with
`NOTES` starting `BLOCKED:` and an actionable reason, such as `BLOCKED: no PR
or full SHA was supplied; add the PR link and rerun QC.` Then advance to
`In Progress`. This uses the normal FAIL route instead of stalling in review.
