# Runbook — native QC agent

This document uses the air-traffic-control terminology defined in `BELT.md`:
Tower, Flight, Aircrew, Approach Control, Ground, Flow Control, Fuel, Field.


Read `WORKER_COMMON.md` first. Use this runbook when the issue is in
`In Review`. The required lane is `gpt-5.6-sol` with `low` effort.

## Procedure

1. Read every acceptance criterion and the builder's work-product comment.
2. Open every cited line and rerun the smallest decisive check where possible.
3. Post the verdict table below.
4. On PASS, record the workspace's required PASS evidence with the procedure
   below, then advance to `Done` through the relay.
5. On FAIL, give an actionable rework list and return to `in_progress` through
   the relay. Do not rewrite the builder's work.

A provider, tool, checkout, or evidence failure is `QC-BLOCKED`, not FAIL.

## Record a PASS

Set `BOARD` and `NUMBER` from `WORKER_COMMON.md` and the supplied issue. Then
derive the exact work-product digest and record the verdict without changing
issue status:

```bash
READBACK="$(sk multica readback "$NUMBER" --board "$BOARD")"
ISSUE_ID="$(jq -r '.issue_id' <<<"$READBACK")"
WORK_PRODUCT="$(jq -r '[.comments[] | select(.content | startswith("## What changed"))] | last.content' <<<"$READBACK")"
WORK_PRODUCT_MD5="$(printf '%s' "$WORK_PRODUCT" | md5sum | cut -d' ' -f1)"
docker exec -i gsp-multica-v2-postgres-1 \
  psql -U gsp_multica -d gsp_multica \
  -v issue_id="$ISSUE_ID" \
  -v checker_id="$MULTICA_AGENT_ID" \
  -v checker_name="$MULTICA_AGENT_NAME" \
  -v work_product_md5="$WORK_PRODUCT_MD5" <<'SQL'
INSERT INTO qc_verdict (
  issue_id, checker_id, checker_name, verdict, work_product_md5, notes
) VALUES (
  :'issue_id'::uuid, :'checker_id'::uuid, :'checker_name', 'PASS',
  :'work_product_md5', 'Native Sol-low QC PASS'
);
SQL
sk multica advance "$NUMBER" --to Done --board "$BOARD" \
  --current-work-product-md5 "$WORK_PRODUCT_MD5"
```

The SQL records only the verdict. The relay remains the only issue-status
writer and validates the exact digest supplied to `advance`.

## Verdict comment

```markdown
## QC verdict
| Criterion | Verdict | Evidence |
| --- | --- | --- |
| criterion | met / not met | path:line or command output |

QC VERDICT: PASS
One-sentence reason.
```

Use `QC VERDICT: FAIL` for an implementation defect. Put nothing after the
one-sentence reason.
