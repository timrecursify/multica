package handler

import (
	"context"
	"testing"
)

// Reconstruction rows must have a creator attribution. db.Issue represents the
// fields as non-nullable Go values, so accepting NULL here makes issue and
// comment lookups fail while scanning before the handler can return a response.
func TestIssueCreatorAttributionIsNonNullable(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	var nullable int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM information_schema.columns
		WHERE table_name = 'issue'
		  AND column_name IN ('creator_type', 'creator_id')
		  AND is_nullable = 'YES'
	`).Scan(&nullable); err != nil {
		t.Fatalf("inspect issue creator nullability: %v", err)
	}
	if nullable != 0 {
		t.Fatalf("issue creator fields must be NOT NULL, found %d nullable columns", nullable)
	}
}
