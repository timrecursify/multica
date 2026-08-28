package handler

import (
	"strings"
	"testing"
)

func TestParseIssueStatusProfile(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want IssueStatusProfile
	}{
		{"", IssueStatusProfileLinear},
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

func TestIssueStatusContractProfilesAreMutuallyExclusive(t *testing.T) {
	linear := mustTestStatusContract(IssueStatusProfileLinear)
	ppp := mustTestStatusContract(IssueStatusProfilePPP)

	// Each profile canonicalizes its own vocabulary.
	for _, s := range []string{"backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"} {
		if _, ok := linear.Canonicalize(s); !ok {
			t.Errorf("linear: canonicalize %q failed", s)
		}
		if s == "backlog" || s == "todo" {
			if got, ok := ppp.Canonicalize(s); !ok || got != "Spec" {
				t.Errorf("ppp: canonicalize %q = %q, %v; want Spec,true", s, got, ok)
			}
		}
	}
	for _, s := range []string{"Spec", "Queue", "In Progress", "In Review", "Human Review", "Done", "Cancelled", "Archived"} {
		if _, ok := ppp.Canonicalize(s); !ok {
			t.Errorf("ppp: canonicalize %q failed", s)
		}
	}
	// The linear profile maps the overlapping board spellings onto its own
	// lowercase canonical set so a canonical-word writer keeps working when
	// pointed at a linear backend during the convergence rollout. "Archived"
	// has no legacy counterpart and is therefore rejected on linear.
	for _, tc := range []struct{ input, want string }{
		{"Spec", "todo"}, {"Queue", "backlog"}, {"In Progress", "in_progress"},
		{"In Review", "in_review"}, {"Human Review", "blocked"},
		{"Done", "done"}, {"Cancelled", "cancelled"},
	} {
		got, ok := linear.Canonicalize(tc.input)
		if !ok || got != tc.want {
			t.Errorf("linear: canonicalize %q = %q,%v; want %q,true", tc.input, got, ok, tc.want)
		}
	}
	if _, ok := linear.Canonicalize("Archived"); ok {
		t.Errorf("linear: canonicalize Archived unexpectedly succeeded")
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
	if linear.DefaultStatus() != "todo" {
		t.Errorf("linear default = %q, want todo", linear.DefaultStatus())
	}
	if ppp.DefaultStatus() != "Spec" {
		t.Errorf("ppp default = %q, want Spec", ppp.DefaultStatus())
	}
	if !ppp.IsTerminal("Done") || !ppp.IsTerminal("Cancelled") || !ppp.IsTerminal("Archived") {
		t.Errorf("ppp terminals not recognized")
	}
	if linear.IsTerminal("todo") || linear.IsTerminal("in_progress") {
		t.Errorf("linear non-terminal statuses reported terminal")
	}
	if !linear.IsTerminal("done") || !linear.IsTerminal("cancelled") {
		t.Errorf("linear terminal statuses not recognized")
	}
}

func TestIssueStatusContractOrderCASE(t *testing.T) {
	ppp := mustTestStatusContract(IssueStatusProfilePPP)
	expr := ppp.orderCASE("i.status")
	if !strings.Contains(expr, "WHEN 'Spec' THEN 0") {
		t.Errorf("orderCASE missing ppp first status: %s", expr)
	}
	if !strings.Contains(expr, "WHEN 'Archived' THEN 7") {
		t.Errorf("orderCASE missing ppp last status: %s", expr)
	}
	if specOrder, ok := ppp.Order("Spec"); !ok || specOrder != 0 {
		t.Fatalf("Order(Spec) = %d, %v; want 0,true", specOrder, ok)
	}
	if archivedOrder, ok := ppp.Order("Archived"); !ok || archivedOrder != 7 {
		t.Fatalf("Order(Archived) = %d, %v; want 7,true", archivedOrder, ok)
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
