#!/bin/bash
set -euo pipefail
trap '' HUP

RELAY_ENV=/etc/gsp/multica/multica-relay-advance.env
OAUTH_ENV=/etc/gsp/multica/claude-oauth.env
CLAUDE_BIN=${MULTICA_CLAUDE_PATH:-/opt/gsp/multica-workers/claude}
POLL_SECONDS=${SCOPING_DRIVER_POLL_SECONDS:-5}

set -a
. "$RELAY_ENV"
. "$OAUTH_ENV"
set +a
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_API_KEY

claim_task() {
  psql -q "$DATABASE_URL" -At -F $'\t' <<SQL
WITH candidate AS (
  SELECT t.id, t.issue_id, t.agent_id, i.title,
         left(regexp_replace(COALESCE(i.description, ''), '[\n\r\t]+', ' ', 'g'), 4000) AS description
  FROM agent_task_queue t
  JOIN agent a ON a.id = t.agent_id
  JOIN issue i ON i.id = t.issue_id
  JOIN agent_runtime ar ON ar.id = t.runtime_id
  WHERE t.workspace_id = '$MULTICA_WORKSPACE_ID'::uuid
    AND t.status = 'queued'
    AND i.status = 'Spec'
    AND a.model LIKE 'claude%'
    AND ar.provider = 'claude'
    AND ar.status = 'online'
  ORDER BY t.created_at, t.id
  LIMIT 1
  FOR UPDATE OF t SKIP LOCKED
)
UPDATE agent_task_queue t
SET status = 'running', started_at = now(), daemon_id = 'gsp-claude-driver', updated_at = now()
FROM candidate c
WHERE t.id = c.id
RETURNING c.id, c.issue_id, c.agent_id, c.title, c.description;
SQL
}

finish_task() {
  local task_id=$1 issue_id=$2 agent_id=$3 body=$4
  psql -q "$DATABASE_URL" --set=task_id="$task_id" --set=issue_id="$issue_id" \
    --set=agent_id="$agent_id" --set=body="$body" --set=workspace_id="$MULTICA_WORKSPACE_ID" <<'SQL'
BEGIN;
INSERT INTO comment (issue_id, author_type, author_id, content, workspace_id, source_task_id)
VALUES (:'issue_id'::uuid, 'agent', :'agent_id'::uuid, :'body', :'workspace_id'::uuid, :'task_id'::uuid);
UPDATE agent_task_queue
SET status='completed', completed_at=now(), result=jsonb_build_object('driver','claude-cli','model','opus','output',:'body'), updated_at=now()
WHERE id=:'task_id'::uuid AND status='running';
COMMIT;
SQL
}

fail_task() {
  local task_id=$1 reason=$2
  psql -q "$DATABASE_URL" --set=task_id="$task_id" --set=reason="$reason" <<'SQL'
UPDATE agent_task_queue SET status='failed', completed_at=now(), error=:'reason', updated_at=now()
WHERE id=:'task_id'::uuid AND status='running';
SQL
}

while :; do
  row=$(claim_task || true)
  if [[ -z "$row" ]]; then
    sleep "$POLL_SECONDS"
    continue
  fi
  IFS=$'\t' read -r task_id issue_id agent_id title description <<<"$row"
  # multica-bridge.cjs latestSpecComment() accepts a comment only when it carries
  # both a "## Spec" and a "## Evidence" heading. A note without them leaves the
  # ticket in Spec, so the relay re-queues it and the scoper pays to run again.
  prompt="Write the binding specification for Multica ticket ${issue_id}.

Title: ${title}
Description: ${description}

Return Markdown only; do not use tools. Emit exactly these two top-level sections, in this order:

## Spec
The scope, the acceptance criteria, and the files or components to change. State every assumption explicitly.

## Evidence
What this specification rests on, and what a reviewer must check to confirm it. Write 'unverified' wherever you could not confirm something."
  body=$(HOME=/var/lib/gsp-multica CLAUDE_CONFIG_DIR=/var/lib/gsp-multica/.claude \
    timeout 300s "$CLAUDE_BIN" -p "$prompt" --model opus --no-session-persistence 2>&1) || {
    fail_task "$task_id" "claude CLI failed: $body"
    continue
  }
  finish_task "$task_id" "$issue_id" "$agent_id" "$body"
done
