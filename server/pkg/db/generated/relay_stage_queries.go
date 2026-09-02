package db

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type GetRelayStageEdgeParams struct {
	StageName   string
	WorkspaceID pgtype.UUID
}
type GetRelayStageEdgeRow struct {
	NextStage     pgtype.Text
	AltNextStages []string
}

func (q *Queries) GetRelayStageEdge(ctx context.Context, a GetRelayStageEdgeParams) (GetRelayStageEdgeRow, error) {
	var r GetRelayStageEdgeRow
	err := q.db.QueryRow(ctx, `SELECT next_stage, alt_next_stages FROM relay_stage_config WHERE stage_name=$1 AND (workspace_id=$2 OR workspace_id IS NULL) ORDER BY (workspace_id IS NOT NULL) DESC,id LIMIT 1`, a.StageName, a.WorkspaceID).Scan(&r.NextStage, &r.AltNextStages)
	return r, err
}

type GetRelayStageOwnerParams struct {
	StageName   string
	WorkspaceID pgtype.UUID
}
type GetRelayStageOwnerRow struct {
	AgentID           pgtype.UUID
	AgentName         pgtype.Text
	RuntimeID         pgtype.UUID
	ArchivedAt        pgtype.Timestamptz
	SelectedRuntimeID pgtype.UUID
}

func (q *Queries) GetRelayStageOwner(ctx context.Context, a GetRelayStageOwnerParams) (GetRelayStageOwnerRow, error) {
	var r GetRelayStageOwnerRow
	err := q.db.QueryRow(ctx, `SELECT r.agent_id,r.agent_name,a.runtime_id,a.archived_at,COALESCE(a.runtime_id,(SELECT ar.id FROM agent_runtime ar WHERE ar.workspace_id=$2 AND ar.provider='codex' AND ar.status='online' ORDER BY ar.updated_at DESC LIMIT 1)) FROM relay_stage_config r LEFT JOIN agent a ON a.id=r.agent_id WHERE r.stage_name=$1 AND (r.workspace_id=$2 OR r.workspace_id IS NULL) ORDER BY (r.workspace_id IS NOT NULL) DESC,r.id LIMIT 1`, a.StageName, a.WorkspaceID).Scan(&r.AgentID, &r.AgentName, &r.RuntimeID, &r.ArchivedAt, &r.SelectedRuntimeID)
	return r, err
}

type CreateRelayStageTaskParams struct {
	AgentID, RuntimeID, IssueID pgtype.UUID
	Priority                    int32
	TriggerSummary              pgtype.Text
	Context                     []byte
}

func (q *Queries) CreateRelayStageTask(ctx context.Context, a CreateRelayStageTaskParams) (AgentTaskQueue, error) {
	var t AgentTaskQueue
	err := q.db.QueryRow(ctx, `INSERT INTO agent_task_queue (agent_id,runtime_id,issue_id,status,priority,trigger_summary,force_fresh_session,context,originator_source,trigger_evidence_kind,trigger_evidence_ref_id) VALUES ($1,$2,$3,'queued',$4,$5,TRUE,$6,'unattributed','relay_stage_transition',$3) ON CONFLICT DO NOTHING RETURNING id,runtime_id`, a.AgentID, a.RuntimeID, a.IssueID, a.Priority, a.TriggerSummary, a.Context).Scan(&t.ID, &t.RuntimeID)
	return t, err
}

var _ = pgx.ErrNoRows
