package handler

import (
	"strings"
	"testing"
)

// linearTestContract is the immutable linear-profile status contract used by
// the search-query tests, where there is no *Handler to carry one.
var linearTestContract = mustTestStatusContract(IssueStatusProfileLinear)

func mustTestStatusContract(profile IssueStatusProfile) *IssueStatusContract {
	c, err := NewIssueStatusContract(profile)
	if err != nil {
		panic(err)
	}
	return c
}

func TestBuildSearchQuery_SingleTerm(t *testing.T) {
	query, args := buildSearchQuery(linearTestContract, "Hello", []string{"Hello"}, 0, false, false)

	// Pattern should be lowercased in Go.
	if args[0] != "hello" {
		t.Errorf("expected phrase arg to be lowercased, got %q", args[0])
	}

	// Must use LOWER(column) LIKE, not ILIKE.
	if strings.Contains(query, "ILIKE") {
		t.Error("query should not contain ILIKE")
	}
	if !strings.Contains(query, "LOWER(i.title) LIKE") {
		t.Error("query should contain LOWER(i.title) LIKE")
	}
	if !strings.Contains(query, "LOWER(COALESCE(i.description, '')) LIKE") {
		t.Error("query should contain LOWER(COALESCE(i.description, '')) LIKE")
	}
	if !strings.Contains(query, "LOWER(c.content) LIKE") {
		t.Error("query should contain LOWER(c.content) LIKE")
	}

	// Exact title rank should not double-LOWER the pattern.
	if strings.Contains(query, "LOWER(i.title) = LOWER(") {
		t.Error("exact title rank should not wrap pattern in LOWER (already lowercased in Go)")
	}
	if !strings.Contains(query, "LOWER(i.title) = $1") {
		t.Error("exact title rank should compare LOWER(i.title) = $1 directly")
	}

	// Should exclude closed issues by default.
	if !strings.Contains(query, "NOT IN ('Done', 'Cancelled', 'Archived')") {
		t.Error("query should exclude terminal statuses when includeClosed=false")
	}
}

func TestBuildSearchQuery_MultiTerm(t *testing.T) {
	query, args := buildSearchQuery(linearTestContract, "Foo Bar", []string{"Foo", "Bar"}, 0, false, false)

	// Both phrase and terms should be lowercased.
	if args[0] != "foo bar" {
		t.Errorf("expected phrase arg lowercased, got %q", args[0])
	}
	// args[0]=exact, args[1]=%phrase%, args[2]=phrase%, args[3]=workspace_id placeholder; term args start at args[4].
	if args[4] != "%foo%" {
		t.Errorf("expected first term arg as contains pattern, got %q", args[4])
	}
	if args[5] != "%bar%" {
		t.Errorf("expected second term arg as contains pattern, got %q", args[5])
	}

	// Multi-word query should have AND conditions.
	if !strings.Contains(query, " AND ") {
		t.Error("multi-word query should contain AND conditions for per-term matching")
	}
}

func TestBuildSearchQuery_MultiTermDoesNotRepeatPhrasePredicate(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "task.list operation failed", []string{"task.list", "operation", "failed"}, 0, false, false)
	// Select the outer WHERE: multi-word queries prepend a CTE containing its
	// own issue source and WHERE clause before the final SELECT.
	whereStart := strings.LastIndex(query, "\n\tWHERE i.workspace_id = ")
	orderStart := strings.LastIndex(query, "ORDER BY ")
	if whereStart == -1 || orderStart <= whereStart {
		t.Fatalf("query does not contain a bounded WHERE clause: %s", query)
	}
	whereClause := query[whereStart:orderStart]
	if strings.Contains(whereClause, "$2") {
		t.Errorf("multi-word WHERE repeats the redundant full-phrase predicate: %s", whereClause)
	}
	// Term parameters live in the candidate CTE, so assert their presence in
	// the complete query while keeping the redundant phrase check outer-scoped.
	for _, termParam := range []string{"$5", "$6", "$7"} {
		if !strings.Contains(query, termParam) {
			t.Errorf("multi-word WHERE lost term predicate %s: %s", termParam, whereClause)
		}
	}
}

func TestBuildSearchQuery_MultiTermUsesMaterializedCandidateIntersection(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "no active lease", []string{"no", "active", "lease"}, 0, false, false)

	if !strings.Contains(query, "WITH matching_issue_ids AS MATERIALIZED") {
		t.Fatalf("multi-word search must narrow candidate IDs before ranking: %s", query)
	}
	if got := strings.Count(query, "INTERSECT"); got != 2 {
		t.Errorf("candidate selection has %d intersections, want 2 for three terms: %s", got, query)
	}
	if !strings.Contains(query, "i.id IN (SELECT id FROM matching_issue_ids)") {
		t.Errorf("main query does not consume the narrowed candidate IDs: %s", query)
	}
	// The candidate comment lookup is workspace-scoped and set-based; it must
	// not be the old c.issue_id = i.id correlated predicate.
	if !strings.Contains(query, "SELECT c.issue_id FROM comment c") || !strings.Contains(query, "c.workspace_id = $4") {
		t.Errorf("candidate comment lookup lost workspace-scoped indexable path: %s", query)
	}
}

func TestBuildSearchQuery_SingleTermUsesWorkspaceScopedCandidates(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "vendor", []string{"vendor"}, 0, false, false)

	if !strings.Contains(query, "WITH matching_issue_ids AS MATERIALIZED") {
		t.Fatalf("single-term search must narrow candidates before ranking: %s", query)
	}
	if !strings.Contains(query, "SELECT c.issue_id FROM comment c") || !strings.Contains(query, "c.workspace_id = $4") {
		t.Fatalf("single-term candidate lookup is not workspace-scoped: %s", query)
	}
	whereStart := strings.LastIndex(query, "\n\tWHERE i.workspace_id = ")
	orderStart := strings.LastIndex(query, "ORDER BY ")
	if whereStart == -1 || orderStart <= whereStart {
		t.Fatalf("query does not contain a bounded outer WHERE clause: %s", query)
	}
	if strings.Contains(query[whereStart:orderStart], "EXISTS (SELECT 1 FROM comment") {
		t.Fatalf("outer WHERE still performs a correlated comment scan: %s", query[whereStart:orderStart])
	}
}

func TestBuildSearchQuery_WithNumber(t *testing.T) {
	query, args := buildSearchQuery(linearTestContract, "MUL-42", []string{"MUL-42"}, 42, true, false)

	_ = args
	// Number match should be in WHERE.
	if !strings.Contains(query, "i.number = ") {
		t.Error("query should contain number match in WHERE clause")
	}
	// Tier 0 rank for identifier match.
	if !strings.Contains(query, "THEN 0") {
		t.Error("query should contain tier 0 rank for identifier match")
	}
}

func TestParseQueryNumberPostgresIntegerBounds(t *testing.T) {
	tests := []struct {
		query string
		want  int
		ok    bool
	}{
		{"42", 42, true},
		{"MUL-42", 42, true},
		{"2147483647", 2147483647, true},
		{"MUL-2147483647", 2147483647, true},
		{"2147483648", 0, false},
		{"MUL-2147483648", 0, false},
		{"33589389651", 0, false},
		{"999999999999999999999999999999999999", 0, false},
		{"0", 0, false},
		{"-42", 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			got, ok := parseQueryNumber(tt.query)
			if got != tt.want || ok != tt.ok {
				t.Errorf("parseQueryNumber(%q) = (%d, %t), want (%d, %t)", tt.query, got, ok, tt.want, tt.ok)
			}
			query, args := buildSearchQuery(linearTestContract, tt.query, []string{tt.query}, got, ok, false)
			if !tt.ok && strings.Contains(query, "i.number =") {
				t.Errorf("out-of-range query added issue-number predicate: %s", query)
			}
			if !tt.ok {
				// A single-term text search has exactly phrase, workspace, limit,
				// and offset parameters. A number comparison would add a seventh.
				if len(args) != 6 {
					t.Errorf("out-of-range query has %d parameters, want 6 text-search parameters: %#v", len(args), args)
				}
			}
		})
	}
}

func TestBuildSearchQuery_IncludeClosed(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "test", []string{"test"}, 0, false, true)

	if strings.Contains(query, "NOT IN ('done', 'cancelled')") {
		t.Error("query should not exclude done/cancelled when includeClosed=true")
	}
}

func TestBuildSearchQuery_SpecialChars(t *testing.T) {
	query, args := buildSearchQuery(linearTestContract, "100%", []string{"100%"}, 0, false, false)

	_ = query
	// % should be escaped in the phrase arg.
	if escaped, ok := args[0].(string); !ok || !strings.Contains(escaped, `\%`) {
		t.Errorf("expected %% to be escaped in phrase arg, got %q", args[0])
	}
}

// --- Project search tests ---

func TestBuildProjectSearchQuery_SingleTerm(t *testing.T) {
	query, args := buildProjectSearchQuery("Hello", []string{"Hello"}, false)

	if args[0] != "hello" {
		t.Errorf("expected phrase arg to be lowercased, got %q", args[0])
	}

	if strings.Contains(query, "ILIKE") {
		t.Error("query should not contain ILIKE")
	}
	if !strings.Contains(query, "LOWER(p.title) LIKE") {
		t.Error("query should contain LOWER(p.title) LIKE")
	}
	if !strings.Contains(query, "LOWER(COALESCE(p.description, '')) LIKE") {
		t.Error("query should contain LOWER(COALESCE(p.description, '')) LIKE")
	}

	// Should exclude completed/cancelled by default.
	if !strings.Contains(query, "NOT IN ('completed', 'cancelled')") {
		t.Error("query should exclude completed/cancelled when includeClosed=false")
	}
}

func TestBuildProjectSearchQuery_MultiTerm(t *testing.T) {
	query, args := buildProjectSearchQuery("Foo Bar", []string{"Foo", "Bar"}, false)

	if args[0] != "foo bar" {
		t.Errorf("expected phrase arg lowercased, got %q", args[0])
	}
	if args[2] != "foo" {
		t.Errorf("expected first term arg lowercased, got %q", args[2])
	}
	if args[3] != "bar" {
		t.Errorf("expected second term arg lowercased, got %q", args[3])
	}

	if !strings.Contains(query, " AND ") {
		t.Error("multi-word query should contain AND conditions for per-term matching")
	}
}

func TestBuildProjectSearchQuery_IncludeClosed(t *testing.T) {
	query, _ := buildProjectSearchQuery("test", []string{"test"}, true)

	if strings.Contains(query, "NOT IN ('completed', 'cancelled')") {
		t.Error("query should not exclude completed/cancelled when includeClosed=true")
	}
}

// --- extractSnippet regression tests ---

func TestExtractSnippet_PhraseMatch(t *testing.T) {
	content := "The quick brown fox jumps over the lazy dog near the river bank"
	snippet := extractSnippet(content, "brown fox")
	if !strings.Contains(snippet, "brown fox") {
		t.Errorf("snippet should contain the phrase 'brown fox', got %q", snippet)
	}
}

func TestExtractSnippet_MultiWordNonContiguous(t *testing.T) {
	// "deploy" and "kubernetes" both appear but not as a contiguous phrase.
	content := "We need to deploy the new service. The kubernetes cluster is ready for production workloads."
	snippet := extractSnippet(content, "deploy kubernetes")
	// Should NOT fall back to first 120 chars blindly — should center on earliest term.
	if !strings.Contains(strings.ToLower(snippet), "deploy") && !strings.Contains(strings.ToLower(snippet), "kubernetes") {
		t.Errorf("snippet should contain at least one search term, got %q", snippet)
	}
	// Specifically, "deploy" appears first so snippet should be centered around it.
	if !strings.Contains(strings.ToLower(snippet), "deploy") {
		t.Errorf("snippet should center on earliest term 'deploy', got %q", snippet)
	}
}

func TestExtractSnippet_FallbackWhenNoMatch(t *testing.T) {
	content := strings.Repeat("a", 200)
	snippet := extractSnippet(content, "zzz")
	if len([]rune(snippet)) > 124 { // 120 + "..."
		t.Errorf("snippet should be truncated to ~120 runes when no match, got len=%d", len([]rune(snippet)))
	}
}

func TestExtractSnippet_ShortContent(t *testing.T) {
	content := "short text"
	snippet := extractSnippet(content, "missing")
	if snippet != content {
		t.Errorf("short content with no match should return as-is, got %q", snippet)
	}
}

func TestExtractSnippet_CaseInsensitive(t *testing.T) {
	content := "Error in HTML rendering pipeline"
	snippet := extractSnippet(content, "html")
	if !strings.Contains(snippet, "HTML") {
		t.Errorf("snippet should find case-insensitive match, got %q", snippet)
	}
}

func TestExtractSnippet_CJKContent(t *testing.T) {
	content := "这是一段很长的中文内容，包含了搜索关键词测试用例，用来验证多字节字符不会被截断的情况"
	snippet := extractSnippet(content, "搜索关键词")
	if !strings.Contains(snippet, "搜索关键词") {
		t.Errorf("snippet should contain CJK phrase, got %q", snippet)
	}
}

// --- Ranking regression tests ---

func TestBuildSearchQuery_CommentRankTiers(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "test phrase", []string{"test", "phrase"}, 0, false, false)

	// Comment phrase match should be tier 7
	if !strings.Contains(query, "THEN 7") {
		t.Error("query should contain tier 7 for comment phrase match")
	}
	// Comment all-term match should be tier 8
	if !strings.Contains(query, "THEN 8") {
		t.Error("query should contain tier 8 for comment all-term match")
	}
	// Fallback should be 9, not 7
	if !strings.Contains(query, "ELSE 9") {
		t.Error("query fallback should be ELSE 9")
	}
}

func TestBuildSearchQuery_DescriptionRankTiers(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "foo bar", []string{"foo", "bar"}, 0, false, false)

	// Description phrase match should be tier 5
	if !strings.Contains(query, "THEN 5") {
		t.Error("query should contain tier 5 for description phrase match")
	}
	// Description all-term match should be tier 6
	if !strings.Contains(query, "THEN 6") {
		t.Error("query should contain tier 6 for description all-term match")
	}
}

func TestBuildSearchQuery_SingleTermNoAllTermTiers(t *testing.T) {
	query, _ := buildSearchQuery(linearTestContract, "html", []string{"html"}, 0, false, false)

	// Extract the rank CASE expression (ends with "ELSE 9 END") to avoid
	// false matches against statusRank which also contains THEN 4/6.
	rankEnd := strings.Index(query, "ELSE 9 END")
	if rankEnd == -1 {
		t.Fatal("query should contain rank expression with ELSE 9 END")
	}
	rankExpr := query[:rankEnd]

	// Single-term queries should NOT have tier 4 (title all-terms), 6 (desc all-terms), or 8 (comment all-terms)
	if strings.Contains(rankExpr, "THEN 4") {
		t.Error("single-term query should not have tier 4 (title all-terms)")
	}
	if strings.Contains(rankExpr, "THEN 6") {
		t.Error("single-term query should not have tier 6 (description all-terms)")
	}
	if strings.Contains(rankExpr, "THEN 8") {
		t.Error("single-term query should not have tier 8 (comment all-terms)")
	}
}

// TestBuildSearchQuery_CommentSubqueryWorkspaceScope regressions the
// MUL-4059 fix: every EXISTS / correlated subquery over `comment` MUST
// filter by c.workspace_id = $wsParam. Without this, Postgres rewrites
// the correlated subquery into a hashed subplan that materializes every
// comment in the entire table matching the LIKE — on prd this was
// 536k rows / 32.3 s for '%search%'. With the filter the hashed set
// collapses to this workspace's comments and the plan uses the
// idx_comment_workspace supporting btree.
//
// $4 is buildSearchQuery's canonical workspace_id placeholder (the
// caller writes wsUUID into args[3] before executing).
func TestBuildSearchQuery_CommentSubqueryWorkspaceScope(t *testing.T) {
	singleQuery, _ := buildSearchQuery(linearTestContract, "html", []string{"html"}, 0, false, false)

	// Every occurrence of `FROM comment c` must be followed by the
	// c.workspace_id = $4 constraint. Counting is safer than a single
	// substring check because the WHERE, rank CASE, matched_comment_content
	// subqueries all touch `comment` and must each carry the filter.
	fromCount := strings.Count(singleQuery, "FROM comment c")
	scopedCount := strings.Count(singleQuery, "c.workspace_id = $4")
	if fromCount == 0 {
		t.Fatalf("single-term query has no comment subquery — did buildSearchQuery drop it?")
	}
	if scopedCount < fromCount {
		t.Errorf("single-term query has %d comment subqueries but only %d workspace_id filters — %d unscoped subquery(ies) will trigger the MUL-4059 global-hash plan",
			fromCount, scopedCount, fromCount-scopedCount)
	}

	// Multi-term uses one extra comment subquery in the WHERE and one in
	// the rank CASE for the all-terms match — same invariant applies.
	multiQuery, _ := buildSearchQuery(linearTestContract, "foo bar", []string{"foo", "bar"}, 0, false, false)
	fromCountMulti := strings.Count(multiQuery, "FROM comment c")
	scopedCountMulti := strings.Count(multiQuery, "c.workspace_id = $4")
	if scopedCountMulti < fromCountMulti {
		t.Errorf("multi-term query has %d comment subqueries but only %d workspace_id filters",
			fromCountMulti, scopedCountMulti)
	}
}

// --- MUL-5824: cancelled work must not outrank live work ---

// orderByClause returns everything after the final ORDER BY, so ranking-order
// assertions cannot be satisfied by an expression that merely appears in the
// SELECT list or the WHERE clause.
func orderByClause(t *testing.T, query string) string {
	t.Helper()
	i := strings.LastIndex(query, "ORDER BY ")
	if i == -1 {
		t.Fatalf("query has no ORDER BY clause:\n%s", query)
	}
	return query[i+len("ORDER BY "):]
}

// The cancelled demotion must sort BEFORE the relevance tiers, not after.
// As a tie-breaker it would be inert: statusRank only orders issues that
// already landed in the same tier, so an exactly-titled cancelled issue
// (tier 1) would still beat an in_progress title-contains match (tier 3).
func TestBuildSearchQuery_CancelledDemotedAheadOfRelevance(t *testing.T) {
	orderBy := orderByClause(t, buildSearchQueryForTest(t, "login bug", []string{"login", "bug"}, 0, false, true))

	cancelledAt := strings.Index(orderBy, "i.status = 'Cancelled' AND NOT")
	if cancelledAt == -1 {
		t.Fatalf("ORDER BY has no cancelled demotion:\n%s", orderBy)
	}

	// "ELSE 9 END" terminates the relevance CASE (rankExpr).
	relevanceEndsAt := strings.Index(orderBy, "ELSE 9 END")
	if relevanceEndsAt == -1 {
		t.Fatalf("ORDER BY has no relevance rank CASE:\n%s", orderBy)
	}
	if cancelledAt > relevanceEndsAt {
		t.Errorf("cancelled demotion sorts after the relevance tiers, so a well-matching cancelled issue still outranks live work:\n%s", orderBy)
	}

	// The demotion must not replace the existing status ordering.
	if !strings.Contains(orderBy, "WHEN 'In Progress' THEN 0") {
		t.Errorf("statusRank was dropped from ORDER BY:\n%s", orderBy)
	}
	if !strings.Contains(orderBy, "i.updated_at DESC") {
		t.Errorf("recency tie-breaker was dropped from ORDER BY:\n%s", orderBy)
	}
}

// Searching an exact title or an exact identifier is unambiguous targeting —
// the searcher already knows which issue they want, so demoting it would just
// hide the row they asked for.
func TestBuildSearchQuery_CancelledDirectHitExempt(t *testing.T) {
	// $1 is the exact (non-wildcard) phrase param.
	textOnly := orderByClause(t, buildSearchQueryForTest(t, "ship it", []string{"ship", "it"}, 0, false, true))
	if !strings.Contains(textOnly, "i.status = 'Cancelled' AND NOT (LOWER(i.title) = $1)") {
		t.Errorf("exact-title hit is not exempt from the cancelled demotion:\n%s", textOnly)
	}
	if strings.Contains(textOnly, "i.number = ") {
		t.Errorf("non-numeric query should not reference i.number in the demotion:\n%s", textOnly)
	}

	withNumber := orderByClause(t, buildSearchQueryForTest(t, "MUL-42", []string{"MUL-42"}, 42, true, true))
	if !strings.Contains(withNumber, "LOWER(i.title) = $1 OR i.number = ") {
		t.Errorf("identifier lookup is not exempt from the cancelled demotion, so MUL-42 sinks below every fuzzy match:\n%s", withNumber)
	}
}

// 'done' is finished work worth referencing; only 'cancelled' is thrown away.
func TestBuildSearchQuery_DoneNotDemotedAheadOfRelevance(t *testing.T) {
	orderBy := orderByClause(t, buildSearchQueryForTest(t, "login", []string{"login"}, 0, false, true))

	relevanceEndsAt := strings.Index(orderBy, "ELSE 9 END")
	if doneAt := strings.Index(orderBy, "i.status = 'done'"); doneAt != -1 && doneAt < relevanceEndsAt {
		t.Errorf("done issues were demoted ahead of relevance; only cancelled should be:\n%s", orderBy)
	}
}

// Project search has no statusRank at all, and the command palette renders
// projects above issues — an undemoted cancelled project can be the first row
// of the entire result list.
func TestBuildProjectSearchQuery_CancelledDemotedAheadOfRelevance(t *testing.T) {
	query, _ := buildProjectSearchQuery("platform", []string{"platform"}, true)
	orderBy := orderByClause(t, query)

	cancelledAt := strings.Index(orderBy, "p.status = 'cancelled'")
	if cancelledAt == -1 {
		t.Fatalf("project ORDER BY has no cancelled demotion:\n%s", orderBy)
	}
	relevanceEndsAt := strings.Index(orderBy, "ELSE 5 END")
	if relevanceEndsAt == -1 {
		t.Fatalf("project ORDER BY has no relevance rank CASE:\n%s", orderBy)
	}
	if cancelledAt > relevanceEndsAt {
		t.Errorf("cancelled projects sort after the relevance tiers:\n%s", orderBy)
	}
	if !strings.Contains(orderBy, "LOWER(p.title) <> $1") {
		t.Errorf("exact-title hit is not exempt from the cancelled demotion:\n%s", orderBy)
	}
	if !strings.Contains(orderBy, "p.updated_at DESC") {
		t.Errorf("recency tie-breaker was dropped from project ORDER BY:\n%s", orderBy)
	}
}

// buildSearchQuery mutates the terms slice in place (lowercasing); this wrapper
// keeps each test's literals independent.
func buildSearchQueryForTest(t *testing.T, phrase string, terms []string, num int, hasNum bool, includeClosed bool) string {
	t.Helper()
	query, _ := buildSearchQuery(linearTestContract, phrase, append([]string(nil), terms...), num, hasNum, includeClosed)
	return query
}
