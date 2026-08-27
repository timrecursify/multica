package handler

import (
	"context"
	"testing"
)

// Creator attribution and issue numbers are required by the initial schema and
// are scanned into non-nullable Go values by sqlc.
func TestIssueCreatorTypeAndNumberAreNonNullable(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	var nullable int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM information_schema.columns
		WHERE table_name = 'issue'
		  AND column_name IN ('creator_type', 'number')
		  AND is_nullable = 'YES'
	`).Scan(&nullable); err != nil {
		t.Fatalf("inspect issue nullability: %v", err)
	}
	if nullable != 0 {
		t.Fatalf("issue creator_type and number must be NOT NULL, found %d nullable columns", nullable)
	}
}
