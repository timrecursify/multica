package handler

import (
	"reflect"
	"strings"
	"testing"
)

func TestEscalationAuditBucketReportReconcilesAndSeparatesAllBuckets(t *testing.T) {
	rows := []escalationAuditRow{
		{Workspace: "GSP", Issue: 1, Defect: 2, Genuine: 0},
		{Workspace: "GSP", Issue: 2, Defect: 2, Genuine: 1},
		{Workspace: "PPP", Issue: 3, Defect: 1, Genuine: 1},
		{Workspace: "PPP", Issue: 4, Exceptions: []string{"task-4"}},
	}
	buckets, complete := escalationAuditBucketReport(rows)
	if complete {
		t.Fatal("complete = true, want false when an exception exists")
	}
	if got, want := buckets.ZeroGenuine, []string{"GSP-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("zero genuine = %v, want %v", got, want)
	}
	if got, want := buckets.DefectMajorityMixed, []string{"GSP-2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("defect mixed = %v, want %v", got, want)
	}
	if got, want := buckets.GenuineMajorityMixed, []string{"PPP-3"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("genuine mixed = %v, want %v", got, want)
	}
	if got, want := buckets.Exceptions, []string{"PPP-4"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("exceptions = %v, want %v", got, want)
	}
}

func TestEscalationAuditSQLIsFixedAndReadOnly(t *testing.T) {
	for _, forbidden := range []string{"INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER "} {
		if strings.Contains(escalationAuditSQL, forbidden) {
			t.Fatalf("audit SQL contains %q", forbidden)
		}
	}
	if !strings.Contains(escalationAuditSQL, "relay_run_log WHERE task_id=t.id") {
		t.Fatal("audit must join the corresponding relay run")
	}
	if !strings.Contains(escalationAuditSQL, "notes ~") {
		t.Fatal("audit must join historical qc attempts by relay task id")
	}
}
