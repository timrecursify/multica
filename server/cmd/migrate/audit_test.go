package main

import (
	"reflect"
	"testing"
)

func TestValidateLedgerDetectsDrift(t *testing.T) {
	got := validateLedger([]string{"301", "302", "303"}, []string{"301", "303", "303", "999"})
	want := []string{"duplicate_ledger:303", "extra_ledger:999", "missing_ledger:302"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reasons = %#v, want %#v", got, want)
	}
}

func TestValidateLedgerDetectsOutOfOrder(t *testing.T) {
	got := validateLedger([]string{"301", "302", "303"}, []string{"302", "301", "303"})
	want := []string{"out_of_order_ledger:301"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reasons = %#v, want %#v", got, want)
	}
}
