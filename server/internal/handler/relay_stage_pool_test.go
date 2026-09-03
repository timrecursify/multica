package handler

import "testing"

func TestStagePoolDiagnosisOwnershipReadback(t *testing.T) {
	parked := stagePoolDiagnosisOwnership("Parked")
	if parked == nil || parked.Mode != "dedicated_workspace_diagnosis_seats" {
		t.Fatalf("Parked ownership = %#v", parked)
	}
	if parked.Explanation == "" {
		t.Fatal("Parked ownership explanation is empty")
	}
	if got := stagePoolDiagnosisOwnership("Queue"); got != nil {
		t.Fatalf("Queue ownership = %#v, want nil", got)
	}
}
