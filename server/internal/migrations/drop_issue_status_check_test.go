package migrations

import (
	"strings"
	"testing"
)

// TestDropIssueStatusCheck_MigrationContent pins the forward/rollback
// contract of migration 282 (PPP-22989): the forward file drops the
// legacy-only issue.status CHECK constraint so canonical board spellings
// (Spec, Queue, in_progress, Human Review, ...) can be persisted, and the
// rollback restores the legacy set. Both directions stay symmetric.
func TestDropIssueStatusCheck_MigrationContent(t *testing.T) {
	up := readMigrationFile(t, "282_drop_issue_status_check_constraint.up.sql")
	down := readMigrationFile(t, "282_drop_issue_status_check_constraint.down.sql")

	if !strings.Contains(up, "DROP CONSTRAINT IF EXISTS issue_status_check") {
		t.Errorf("up migration must drop issue_status_check")
	}
	if !strings.Contains(down, "ADD CONSTRAINT issue_status_check") {
		t.Errorf("down migration must restore issue_status_check")
	}
	if !strings.Contains(down, "'backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'") {
		t.Errorf("rollback must restore the legacy lowercase vocabulary")
	}
	if !strings.Contains(up, "Spec") {
		t.Errorf("up migration comment should name the canonical vocabulary it unblocks")
	}
}
