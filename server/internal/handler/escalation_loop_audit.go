package handler

// This endpoint deliberately has no request parameters: the two workspaces
// and the query are fixed so it cannot become a general database reader.
import (
	"fmt"
	"net/http"
	"sort"
)

const escalationAuditGSP = "f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f"
const escalationAuditPPP = "da3c5c5c-a123-4567-b999-c3ed1820da00"

// Kept here, beside the authenticated execution surface, rather than in a
// task-side script.  It is a fixed SELECT and is run inside READ ONLY tx.
const escalationAuditSQL = `
WITH parked AS (
 SELECT i.id,i.workspace_id,i.number FROM issue i WHERE i.workspace_id=ANY($1::uuid[])
 AND i.status='Parked' AND EXISTS (SELECT 1 FROM relay_run_log l WHERE l.issue_id=i.id
 AND l.to_stage='Parked' AND l.status='completed' AND l.parked_audit->>'reason'='escalation_loop')
), countable AS (
 SELECT p.workspace_id::text,p.number,t.id::text,COALESCE(t.result->>'output',''),relay.status,
 a.verdict,a.failure_class FROM parked p JOIN agent_task_queue t ON t.issue_id=p.id
 LEFT JOIN LATERAL (SELECT status FROM relay_run_log WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) relay ON true
 LEFT JOIN LATERAL (SELECT verdict,failure_class FROM qc_attempt WHERE issue_id=p.id
 AND notes ~ ('(^|\\n)relay_task_id='||t.id::text||'(\\n|$)') ORDER BY created_at DESC,id DESC LIMIT 1) a ON true
 WHERE (t.context->>'to_stage' IS DISTINCT FROM 'In Review' OR t.status IS DISTINCT FROM 'completed'
 OR EXISTS (SELECT 1 FROM qc_verdict v WHERE v.issue_id=t.issue_id AND v.checker_id=t.agent_id AND v.created_at>=t.started_at))
) SELECT * FROM countable ORDER BY workspace_id,number,task_id`

type escalationAuditRow struct {
	Workspace  string   `json:"workspace"`
	Issue      int      `json:"issue"`
	Countable  int      `json:"countable_attempts"`
	Defect     int      `json:"defect_shaped"`
	Genuine    int      `json:"genuine"`
	Ratio      float64  `json:"defect_shaped_ratio"`
	Exceptions []string `json:"exceptions,omitempty"`
}

func (h *Handler) EscalationLoopAudit(w http.ResponseWriter, r *http.Request) {
	// Membership in both fixed workspaces is required before any data is read.
	if _, ok := h.requireWorkspaceMember(w, r, escalationAuditGSP, "audit not found"); !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, escalationAuditPPP, "audit not found"); !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "start audit snapshot: "+err.Error())
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
		writeError(w, 500, "configure audit snapshot: "+err.Error())
		return
	}
	var snapshot string
	if err = tx.QueryRow(r.Context(), "SELECT now()::text").Scan(&snapshot); err != nil {
		writeError(w, 500, "read audit snapshot: "+err.Error())
		return
	}
	rows, err := tx.Query(r.Context(), escalationAuditSQL, []string{escalationAuditGSP, escalationAuditPPP})
	if err != nil {
		writeError(w, 500, "read audit: "+err.Error())
		return
	}
	defer rows.Close()
	byTicket := map[string]*escalationAuditRow{}
	total := 0
	for rows.Next() {
		var ws, task, output string
		var issue int
		var relay, verdict, failure *string
		if err := rows.Scan(&ws, &issue, &task, &output, &relay, &verdict, &failure); err != nil {
			writeError(w, 500, "decode audit: "+err.Error())
			return
		}
		label := "PPP"
		if ws == escalationAuditGSP {
			label = "GSP"
		}
		key := fmt.Sprintf("%s:%d", label, issue)
		x := byTicket[key]
		if x == nil {
			x = &escalationAuditRow{Workspace: label, Issue: issue}
			byTicket[key] = x
		}
		x.Countable++
		total++
		if relay != nil && *relay == "failed" || verdict == nil {
			x.Defect++
			continue
		}
		if *verdict == "FAIL" || (failure != nil && *failure == "implementation") {
			x.Genuine++
		} else {
			x.Exceptions = append(x.Exceptions, task)
		}
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "read audit: "+err.Error())
		return
	}
	out := make([]escalationAuditRow, 0, len(byTicket))
	gsp, ppp := 0, 0
	exceptions := []string{}
	for _, x := range byTicket {
		x.Ratio = float64(x.Defect) / float64(x.Countable)
		if x.Workspace == "GSP" {
			gsp++
		} else {
			ppp++
		}
		exceptions = append(exceptions, x.Exceptions...)
		out = append(out, *x)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Ratio != out[j].Ratio {
			return out[i].Ratio > out[j].Ratio
		}
		if out[i].Workspace != out[j].Workspace {
			return out[i].Workspace < out[j].Workspace
		}
		return out[i].Issue < out[j].Issue
	})
	writeJSON(w, 200, map[string]any{"snapshot": snapshot, "expected": map[string]int{"total": 94, "gsp": 65, "ppp": 29}, "actual": map[string]int{"total": len(out), "gsp": gsp, "ppp": ppp}, "population_drift": len(out) != 94 || gsp != 65 || ppp != 29, "aggregate_countable_attempts": total, "tickets": out, "exceptions": exceptions, "cap": "2/6 unchanged; human-only reset/unpark; cap does not gate dispatch; see GSP-1548"})
}
