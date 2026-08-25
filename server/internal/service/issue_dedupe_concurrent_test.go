package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// dedupeSeedFixture seeds a fresh workspace + owner user (no agent assignment,
// so Create's task-enqueue branch is skipped) and returns their ids. Like the
// other service fixtures, it is cleaned up via t.Cleanup.
func dedupeSeedFixture(t *testing.T, pool *pgxpool.Pool) (workspaceID, userID string) {
	t.Helper()
	ctx := context.Background()
	suffix := time.Now().UnixNano()

	if err := pool.QueryRow(ctx, `INSERT INTO "user" (name, email) VALUES ('Dedupe User', $1) RETURNING id`,
		fmt.Sprintf("dedupe-%d@multica.test", suffix)).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, userID)
	})

	if err := pool.QueryRow(ctx, `INSERT INTO workspace (name, slug) VALUES ('dedupe ws', $1) RETURNING id`,
		fmt.Sprintf("dedupe-%d", suffix)).Scan(&workspaceID); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, workspaceID)
	})

	if _, err := pool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
		workspaceID, userID); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	return workspaceID, userID
}

// createIssueSleepTrigger installs a BEFORE INSERT ON issue trigger that sleeps
// before the row is written. It forces two concurrent creates of the same
// dedupe_key to overlap at the unique index: each attempt holds its INSERT
// open, so the losing transaction reliably reaches the INSERT while the
// winner's row is still uncommitted and its dedupe_key is invisible to the
// loser's earlier fast-path lookup. This deterministically reproduces the
// index 23505 race (picked up after the winner commits) that the QC finding
// flagged, instead of relying on goroutine scheduling luck.
func createIssueSleepTrigger(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	const fn = "ppp20833_dedupe_race_sleep"
	const trg = "ppp20833_dedupe_race_sleep_trg"
	if _, err := pool.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION %s()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $$
		BEGIN
			PERFORM pg_sleep(0.3);
			RETURN NEW;
		END;
		$$;
	`, quoteIdent(fn))); err != nil {
		t.Fatalf("create issue sleep trigger function: %v", err)
	}
	if _, err := pool.Exec(ctx, fmt.Sprintf(`
		CREATE TRIGGER %s
		BEFORE INSERT ON issue
		FOR EACH ROW
		EXECUTE FUNCTION %s();
	`, quoteIdent(trg), quoteIdent(fn))); err != nil {
		t.Fatalf("create issue sleep trigger: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		pool.Exec(cleanupCtx, fmt.Sprintf("DROP TRIGGER IF EXISTS %s ON issue", quoteIdent(trg)))
		pool.Exec(cleanupCtx, fmt.Sprintf("DROP FUNCTION IF EXISTS %s()", quoteIdent(fn)))
	})
}
// acceptance check for the unique-index race QC failed on: two concurrent
// creates firing the SAME dedupe_key must mint exactly one ticket and the
// losing request must resolve to the existing OPEN ticket (HTTP 200
// existing:true in the handler) — never surface the index 23505 as a 500.
// Distinct titles are used so only the strict dedupe_key path is exercised
// (the fuzzy gate / active-duplicate guard would otherwise fire first).
func TestCreateConcurrentSameDedupeKeyResolvesToExisting(t *testing.T) {
	ctx := context.Background()
	pool := newResolveOriginatorPool(t)
	q := db.New(pool)
	service := NewIssueService(q, pool, events.New(), nil, nil)
	workspaceID, userID := dedupeSeedFixture(t, pool)
	workspaceUUID := util.MustParseUUID(workspaceID)
	userUUID := util.MustParseUUID(userID)
	// Force both attempts to overlap at the unique index deterministically
	// rather than relying on goroutine scheduling to reproduce the 23505 race.
	createIssueSleepTrigger(t, ctx, pool)

	const dedupeKey = "sentinel:check-disk:2026-08-24"

	type result struct {
		existing *db.Issue
		created  *db.Issue
	}

	const workers = 2
	start := make(chan struct{})
	results := make([]result, workers)
	errs := make(chan error, workers)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			title := fmt.Sprintf("disk full on box %d", idx+1)
			res, err := service.Create(ctx, IssueCreateParams{
				WorkspaceID: workspaceUUID,
				Title:       title,
				Status:      "todo",
				Priority:    "medium",
				CreatorType: "agent",
				CreatorID:   userUUID,
				DedupeKey:   dedupeKey,
			}, IssueCreateOpts{})
			if err != nil {
				// With the QC fix the service resolves the concurrent same-key
				// race internally and never returns the index 23505 (or any
				// error) for this scenario. Any surfaced error is a failure.
				errs <- fmt.Errorf("worker %d: unexpected create error: %v", idx, err)
				return
			}
			if res.DedupeExisting != nil {
				results[idx] = result{existing: res.DedupeExisting}
				return
			}
			if res.Issue.ID.Valid {
				results[idx] = result{created: &res.Issue}
				return
			}
			errs <- fmt.Errorf("worker %d: create returned no issue and no dedupe resolution", idx)
		}(i)
	}

	close(start)
	wg.Wait()
	close(errs)

	for e := range errs {
		t.Error(e)
	}

	created := make([]*db.Issue, 0, workers)
	existing := make([]*db.Issue, 0, workers)
	for _, r := range results {
		if r.created != nil {
			created = append(created, r.created)
		}
		if r.existing != nil {
			existing = append(existing, r.existing)
		}
	}

	// Exactly one request must have created the ticket; the other must have
	// resolved to it. Two creates (duplicates) or a lost loser both fail.
	if len(created) != 1 {
		t.Fatalf("created tickets = %d, want exactly 1 (created=%d existing=%d)", len(created), len(created), len(existing))
	}
	if len(existing) != 1 {
		t.Fatalf("resolved-to-existing requests = %d, want exactly 1 (created=%d existing=%d)", len(existing), len(created), len(existing))
	}

	winner := created[0]
	resolved := existing[0]
	if winner.ID != resolved.ID {
		t.Errorf("created and resolved ids differ: created=%s resolved=%s, want same ticket",
			util.UUIDToString(winner.ID), util.UUIDToString(resolved.ID))
	}

	// The database must hold exactly one open row for this dedupe_key.
	var count int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM issue
		WHERE workspace_id = $1 AND dedupe_key = $2
		  AND status NOT IN ('Done','done','Cancelled','cancelled','Archived')`,
		workspaceUUID, dedupeKey).Scan(&count); err != nil {
		t.Fatalf("count dedupe rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("open rows for dedupe_key = %d, want 1", count)
	}
}

// TestDedupeKeyFastPathReturnsExisting covers the non-racing fast path: a
// second create with an already-present open dedupe_key must resolve to the
// existing ticket immediately (no insert, no new ticket).
func TestDedupeKeyFastPathReturnsExisting(t *testing.T) {
	ctx := context.Background()
	pool := newResolveOriginatorPool(t)
	q := db.New(pool)
	service := NewIssueService(q, pool, events.New(), nil, nil)
	workspaceID, userID := dedupeSeedFixture(t, pool)
	workspaceUUID := util.MustParseUUID(workspaceID)
	userUUID := util.MustParseUUID(userID)
	const dedupeKey = "sentinel:check-backup:2026-08-24"

	params := IssueCreateParams{
		WorkspaceID: workspaceUUID,
		Title:       "backup job failed on host X",
		Status:      "todo",
		Priority:    "medium",
		CreatorType: "agent",
		CreatorID:   userUUID,
		DedupeKey:   dedupeKey,
	}

	first, err := service.Create(ctx, params, IssueCreateOpts{})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if !first.Issue.ID.Valid || first.DedupeExisting != nil {
		t.Fatalf("first create should insert (created=%v dedupe=%v)", first.Issue.ID.Valid, first.DedupeExisting != nil)
	}

	second, err := service.Create(ctx, params, IssueCreateOpts{})
	if err != nil {
		t.Fatalf("second create: %v", err)
	}
	if second.DedupeExisting == nil || !second.DedupeExisting.ID.Valid {
		t.Fatalf("second create should resolve to existing, got DedupeExisting=%+v", second.DedupeExisting)
	}
	if second.DedupeExisting.ID != first.Issue.ID {
		t.Errorf("resolved ticket %s != first created ticket %s",
			util.UUIDToString(second.DedupeExisting.ID), util.UUIDToString(first.Issue.ID))
	}
}

// TestFuzzyDuplicateRejectsWithMatches is acceptance scenario (b): a create
// whose title is a near-duplicate (pg_trgm similarity >= 0.6) of an OPEN issue
// in the same workspace is rejected with ErrFuzzyDuplicate and the match list,
// which the handler renders as HTTP 409 with numbers + titles.
func TestFuzzyDuplicateRejectsWithMatches(t *testing.T) {
	ctx := context.Background()
	pool := newResolveOriginatorPool(t)
	q := db.New(pool)
	service := NewIssueService(q, pool, events.New(), nil, nil)
	workspaceID, userID := dedupeSeedFixture(t, pool)
	workspaceUUID := util.MustParseUUID(workspaceID)
	userUUID := util.MustParseUUID(userID)

	base := IssueCreateParams{
		WorkspaceID: workspaceUUID,
		Title:       "payment provider is down for the whole region",
		Status:      "todo",
		Priority:    "medium",
		CreatorType: "agent",
		CreatorID:   userUUID,
	}
	first, err := service.Create(ctx, base, IssueCreateOpts{})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if !first.Issue.ID.Valid {
		t.Fatalf("first create did not insert a ticket")
	}

	// Slightly different title (classic re-file) should fuzzy-match.
	near := base
	near.Title = "Payment provider down across the whole region"
	near.DedupeKey = ""
	_, err = service.Create(ctx, near, IssueCreateOpts{})
	if !errors.Is(err, ErrFuzzyDuplicate) {
		t.Fatalf("near-duplicate create error = %v, want ErrFuzzyDuplicate", err)
	}

	// An unrelated title must not be matched (acceptance scenario (d)).
	distinct := base
	distinct.Title = "totally unrelated topic about new feature launch"
	distinct.DedupeKey = "sentinel:distinct:2026-08-24"
	distinctRes, err := service.Create(ctx, distinct, IssueCreateOpts{})
	if err != nil {
		t.Fatalf("distinct create should be unaffected, got: %v", err)
	}
	if !distinctRes.Issue.ID.Valid || distinctRes.FuzzyMatches != nil {
		t.Fatalf("distinct create unexpectedly fuzzy-matched: matches=%+v", distinctRes.FuzzyMatches)
	}

	// Confirmation: only the unrelated + original tickets exist; the near-dup
	// was rejected without inserting.
	var openCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue WHERE workspace_id = $1
		AND status NOT IN ('Done','done','Cancelled','cancelled','Archived')`,
		workspaceUUID).Scan(&openCount); err != nil {
		t.Fatalf("count open issues: %v", err)
	}
	if openCount != 2 {
		t.Fatalf("open issue count = %d, want 2 (original + distinct, near-dup rejected)", openCount)
	}
}

// TestFuzzyDuplicateAllowOverrideRecordsActivity is acceptance scenario (c): a
// near-duplicate create with allow_duplicate=true is permitted, records a
// duplicate_fuzzy_override row in activity_log, and still inserts the ticket.
func TestFuzzyDuplicateAllowOverrideRecordsActivity(t *testing.T) {
	ctx := context.Background()
	pool := newResolveOriginatorPool(t)
	q := db.New(pool)
	service := NewIssueService(q, pool, events.New(), nil, nil)
	workspaceID, userID := dedupeSeedFixture(t, pool)
	workspaceUUID := util.MustParseUUID(workspaceID)
	userUUID := util.MustParseUUID(userID)

	base := IssueCreateParams{
		WorkspaceID: workspaceUUID,
		Title:       "Database replica failed over unexpectedly",
		Status:      "todo",
		Priority:    "medium",
		CreatorType: "agent",
		CreatorID:   userUUID,
	}
	if _, err := service.Create(ctx, base, IssueCreateOpts{}); err != nil {
		t.Fatalf("first create: %v", err)
	}

	override := base
	override.Title = "Database replica failed over unexpectedly again"
	override.DedupeKey = "sentinel:failover:2026-08-24"
	override.AllowDuplicate = true

	res, err := service.Create(ctx, override, IssueCreateOpts{})
	if err != nil {
		t.Fatalf("allow_duplicate create: %v", err)
	}
	if !res.Issue.ID.Valid {
		t.Fatalf("allow_duplicate create did not insert a ticket")
	}

	var auditCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM activity_log
		WHERE workspace_id = $1 AND action = 'duplicate_fuzzy_override'`,
		workspaceUUID).Scan(&auditCount); err != nil {
		t.Fatalf("count override audit rows: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("duplicate_fuzzy_override audit rows = %d, want 1", auditCount)
	}
}
