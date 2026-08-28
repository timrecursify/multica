package migrations

import (
	"strings"
	"testing"
)

// TestDropIssueStatusCheck_MigrationContent pins the forward/rollback
// contract of migration 282 (PPP-22989): forward records and converts legacy
// spellings before constraining storage to canonical values; rollback restores
// the recorded source spellings before re-adding the legacy constraint.
func TestDropIssueStatusCheck_MigrationContent(t *testing.T) {
	up := readMigrationFile(t, "282_drop_issue_status_check_constraint.up.sql")
	down := readMigrationFile(t, "282_drop_issue_status_check_constraint.down.sql")

	for _, want := range []string{"issue_status_282_rollback", "WHEN 'todo' THEN 'Spec'", "WHEN 'Building' THEN 'in_progress'", "WHEN 'done' THEN 'Done'", "WHEN 'cancelled' THEN 'Cancelled'", "ADD CONSTRAINT issue_status_check"} {
		if !strings.Contains(up, want) {
			t.Errorf("up migration missing %q", want)
		}
	}
	for _, want := range []string{"UPDATE issue i", "SET status = r.previous_status", "DROP TABLE issue_status_282_rollback", "ADD CONSTRAINT issue_status_check"} {
		if !strings.Contains(down, want) {
			t.Errorf("down migration missing %q", want)
		}
	}
	if !strings.Contains(down, "'backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'") {
		t.Errorf("rollback must restore the legacy lowercase vocabulary")
	}
	if !strings.Contains(up, "'Spec', 'Queue', 'in_progress', 'in_review', 'Human Review', 'Done', 'Cancelled', 'Archived'") {
		t.Errorf("up migration must constrain canonical vocabulary")
	}
}
