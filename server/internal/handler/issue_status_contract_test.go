package handler

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseIssueStatusProfile(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want IssueStatusProfile
	}{
		{"", IssueStatusProfilePPP},
		{"linear", IssueStatusProfileLinear},
		{"ppp", IssueStatusProfilePPP},
		{" PPP ", IssueStatusProfilePPP},
	} {
		got, err := ParseIssueStatusProfile(tc.raw)
		if err != nil {
			t.Errorf("ParseIssueStatusProfile(%q) unexpected error: %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseIssueStatusProfile(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
	for _, bad := range []string{"legacy", "canonical", " gsp "} {
		if _, err := ParseIssueStatusProfile(bad); err == nil {
			t.Errorf("ParseIssueStatusProfile(%q) expected error, got none", bad)
		}
	}
}

func TestIssueStatusContractProfilesShareCanonicalStorage(t *testing.T) {
	linear := mustTestStatusContract(IssueStatusProfileLinear)
	ppp := mustTestStatusContract(IssueStatusProfilePPP)

	for _, tc := range []struct{ input, want string }{
		{"todo", "Spec"}, {"backlog", "Spec"}, {"Registered", "Registered"}, {"Spec", "Spec"},
		{"Queue", "Queue"}, {"In Progress", "In Progress"}, {"in_progress", "In Progress"}, {"Building", "In Progress"},
		{"In Review", "In Review"}, {"in_review", "In Review"}, {"QC", "In Review"}, {"Human Review", "Human Review"},
		{"CI/CD & Deploy", "CI/CD & Deploy"}, {"Blocked (human)", "Blocked (human)"},
		{"blocked", "Human Review"}, {"Done", "Done"}, {"done", "Done"},
		{"Cancelled", "Cancelled"}, {"cancelled", "Cancelled"}, {"Archived", "Archived"},
	} {
		for _, contract := range []*IssueStatusContract{linear, ppp} {
			got, ok := contract.Canonicalize(tc.input)
			if !ok || got != tc.want {
				t.Errorf("%s: canonicalize %q = %q,%v; want %q,true", contract.Profile(), tc.input, got, ok, tc.want)
			}
		}
	}
	if got := linear.DisplayStatus("Spec"); got != "todo" {
		t.Errorf("linear display Spec = %q, want todo", got)
	}
	if got := ppp.DisplayStatus("Spec"); got != "Spec" {
		t.Errorf("ppp display Spec = %q, want Spec", got)
	}
}

func TestIssueStatusContractCanonicalStatusesMatchRelayVocabulary(t *testing.T) {
	want := []string{
		"Registered", "Spec", "Queue", "In Progress", "In Review",
		"Human Review", "Blocked (human)", "CI/CD & Deploy", "Done", "Archived", "Cancelled",
	}
	for _, profile := range []IssueStatusProfile{IssueStatusProfileLinear, IssueStatusProfilePPP} {
		if got := mustTestStatusContract(profile).CanonicalStatuses(); !reflect.DeepEqual(got, want) {
			t.Errorf("%s canonical statuses = %#v, want %#v", profile, got, want)
		}
	}
}

func TestIssueStatusContractCanonicalizeRejectsUnknownAndPadded(t *testing.T) {
	contract := mustTestStatusContract(IssueStatusProfilePPP)
	for _, bad := range []string{"active", "TODO", " todo", "todo ", "in_progress ", "spec", ""} {
		if got, ok := contract.Canonicalize(bad); ok {
			t.Errorf("Canonicalize(%q) = %q, true; want rejected", bad, got)
		}
	}
}

func TestIssueStatusContractCanonicalizeIsIdempotent(t *testing.T) {
	for _, profile := range []IssueStatusProfile{IssueStatusProfileLinear, IssueStatusProfilePPP} {
		contract := mustTestStatusContract(profile)
		for input := range contract.accepted {
			once, ok1 := contract.Canonicalize(input)
			if !ok1 {
				t.Fatalf("%s: rejected %q", profile, input)
			}
			twice, ok2 := contract.Canonicalize(once)
			if !ok2 || twice != once {
				t.Errorf("%s: normalize(normalize(%q)) = %q,%v; want %q", profile, input, twice, ok2, once)
			}
		}
	}
}

func TestIssueStatusContractDefaultAndTerminal(t *testing.T) {
	linear := mustTestStatusContract(IssueStatusProfileLinear)
	ppp := mustTestStatusContract(IssueStatusProfilePPP)
	if linear.DefaultStatus() != "Spec" {
		t.Errorf("linear default = %q, want Spec", linear.DefaultStatus())
	}
	if ppp.DefaultStatus() != "Spec" {
		t.Errorf("ppp default = %q, want Spec", ppp.DefaultStatus())
	}
	for _, contract := range []*IssueStatusContract{linear, ppp} {
		if !contract.IsTerminal("Done") || !contract.IsTerminal("Cancelled") || !contract.IsTerminal("Archived") || !contract.IsTerminal("Blocked (human)") {
			t.Errorf("%s terminals not recognized", contract.Profile())
		}
		if contract.IsTerminal("Spec") || contract.IsTerminal("In Progress") {
			t.Errorf("%s non-terminal statuses reported terminal", contract.Profile())
		}
	}
}

func TestIssueStatusContractOrderCASE(t *testing.T) {
	for _, profile := range []IssueStatusProfile{IssueStatusProfileLinear, IssueStatusProfilePPP} {
		contract := mustTestStatusContract(profile)
		expr := contract.orderCASE("i.status")
		if !strings.Contains(expr, "WHEN 'Registered' THEN 0") {
			t.Errorf("%s orderCASE missing canonical first status: %s", profile, expr)
		}
		if !strings.Contains(expr, "WHEN 'Cancelled' THEN 10") {
			t.Errorf("%s orderCASE missing canonical last status: %s", profile, expr)
		}
	}
}

func TestIssueStatusContractAllAcceptedInputsIncludesBothVocabularies(t *testing.T) {
	for _, profile := range []IssueStatusProfile{IssueStatusProfileLinear, IssueStatusProfilePPP} {
		contract := mustTestStatusContract(profile)
		inputs := contract.AllAcceptedInputs()
		if len(inputs) == 0 {
			t.Fatalf("%s: no accepted inputs", profile)
		}
		for _, input := range inputs {
			if _, ok := contract.Canonicalize(input); !ok {
				t.Errorf("%s: AllAcceptedInputs contains %q but Canonicalize rejects it", profile, input)
			}
		}
	}
}
