package handler

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// IssueStatusProfile selects which issue-status vocabulary a deployment
// validates against, persists, and emits.
//
// Multica has historically shipped two mutually exclusive vocabularies: a
// lowercase legacy set and the canonical board set the production boards
// display. The two boards diverged because the legacy starded acceptance
// validation in the API while the storage layer (and the relay) normalized
// onto the canonical set; a value accepted by one board was a hard HTTP 400
// on the other. This ticket converges them by parameterizing the whole status
// layer behind one immutable contract, chosen once at startup, that every
// read and write path shares.
type IssueStatusProfile string

const (
	// IssueStatusProfileLinear is the default (and self-hosted / GSP) profile:
	// it backs the historic lowercase lifecycle statuses. New deployments get
	// this profile unless they opt in to the canonical board vocabulary.
	IssueStatusProfileLinear IssueStatusProfile = "linear"
	// IssueStatusProfilePPP is the production profile that stores and emits
	// the canonical board statuses (Spec, Queue, in_progress, in_review,
	// Human Review, Done, Cancelled, Archived).
	IssueStatusProfilePPP IssueStatusProfile = "ppp"
)

// ParseIssueStatusProfile parses the MULTICA_ISSUE_STATUS_PROFILE environment
// value ("linear" or "ppp", defaulting to "linear"). Unknown values fail
// startup instead of silently falling back, so a deployment cannot drift to a
// different vocabulary than the one its operators believe they configured.
func ParseIssueStatusProfile(raw string) (IssueStatusProfile, error) {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "", "linear":
		return IssueStatusProfileLinear, nil
	case "ppp":
		return IssueStatusProfilePPP, nil
	default:
		return "", fmt.Errorf("unknown MULTICA_ISSUE_STATUS_PROFILE %q: must be linear or ppp", raw)
	}
}

// IssueStatusContract is an immutable, per-profile description of the status
// layer: the ordered canonical spellings that are stored and emitted, the
// accepted aliases that normalize onto them, and the terminal predicates.
// Every validation, canonicalization, grouping, filtering, and sorting path
// in the handler shares the one contract that was selected at startup; nothing
// reads the environment or a hard-coded global list.
type IssueStatusContract struct {
	profile   IssueStatusProfile
	canonical []string          // ordered: display + persistence order
	order     map[string]int    // canonical spelling -> display order
	aliases   map[string]string // accepted non-canonical input -> canonical
	accepted  map[string]string // every accepted input (canonical + alias) -> canonical
	terminal  map[string]bool   // canonical spellings that are terminal
}

// NewIssueStatusContract builds the immutable contract for a profile. The
// profile is fixed for the process lifetime; callers must never switch it per
// request.
func NewIssueStatusContract(profile IssueStatusProfile) (*IssueStatusContract, error) {
	var canonical []string
	var aliases map[string]string
	var terminal []string
	switch profile {
	case IssueStatusProfileLinear:
		canonical = []string{"backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"}
		// Cross-vocabulary aliases normalize the canonical board spellings onto
		// the lowercase legacy set. This is what lets a mixed-version fleet
		// (one backend still canonical, one already past the rollout) accept
		// every writer without changing which spelling this deployment stores.
		aliases = map[string]string{
			"Spec":         "todo",
			"Queue":        "backlog",
			"In Progress":  "in_progress",
			"In Review":    "in_review",
			"Human Review": "blocked",
			"Done":         "done",
			"Cancelled":    "cancelled",
		}
		terminal = []string{"done", "cancelled"}
	case IssueStatusProfilePPP:
		canonical = []string{"Spec", "Queue", "in_progress", "in_review", "Human Review", "Done", "Cancelled", "Archived"}
		// Every other spelling the fork conveyor and sk have been known to
		// write (previously accepted verbatim by commit #33) normalizes onto
		// one of these canonical values, so post-convergence PPP responses are
		// consistent and no writer that worked before starts getting 400s.
		aliases = map[string]string{
			"todo":        "Spec",
			"backlog":     "Spec",
			"Registered":  "Spec",
			"In Progress": "in_progress",
			"Building":    "in_progress",
			"In Review":   "in_review",
			"QC":          "in_review",
			"blocked":     "Human Review",
			"Blocked":     "Human Review",
			"done":        "Done",
			"cancelled":   "Cancelled",
			"dead_letter": "Cancelled",
		}
		terminal = []string{"Done", "Cancelled", "Archived"}
	default:
		return nil, fmt.Errorf("invalid issue status profile %q", profile)
	}

	contract := &IssueStatusContract{
		profile:   profile,
		canonical: append([]string(nil), canonical...),
		order:     make(map[string]int, len(canonical)),
		aliases:   make(map[string]string, len(aliases)),
		accepted:  make(map[string]string, len(canonical)+len(aliases)),
		terminal:  make(map[string]bool, len(terminal)),
	}
	for i, status := range canonical {
		contract.order[status] = i
		contract.accepted[status] = status
	}
	for input, target := range aliases {
		contract.aliases[input] = target
		contract.accepted[input] = target
	}
	for _, status := range terminal {
		contract.terminal[status] = true
	}
	return contract, nil
}

// Profile returns the profile the contract was built for.
func (c *IssueStatusContract) Profile() IssueStatusProfile {
	return c.profile
}

// DefaultStatus returns the canonical status a new issue without an explicit
// status should be created with. Kept distinct per profile so the canonical
// vocabulary's intake row ("Spec") is what new PPP-prod issues land in rather
// than a legacy spelling the workers would not poll.
func (c *IssueStatusContract) DefaultStatus() string {
	if c.profile == IssueStatusProfilePPP {
		return "Spec"
	}
	return "todo"
}

// CanonicalStatuses returns the ordered canonical spellings (display and
// persistence order) for the profile. The returned slice is a copy; callers
// may not mutate the contract.
func (c *IssueStatusContract) CanonicalStatuses() []string {
	out := make([]string, len(c.canonical))
	copy(out, c.canonical)
	return out
}

// ContainsCanonical reports whether status is an exact canonical spelling for
// the contract. Used for read paths (filters, table groups, group keys) where
// the incoming values are expected to already be canonical storage values.
func (c *IssueStatusContract) ContainsCanonical(status string) bool {
	_, ok := c.order[status]
	return ok
}

// Canonicalize resolves any accepted input (a canonical spelling or an alias)
// onto the profile's canonical spelling. Recognized-with-alias inputs are
// therefore normalized before persistence while unknown, whitespace-padded,
// wrong-case, and empty-string values return "", false and are rejected by the
// caller. The input is compared exactly — no trimming — so a padded value is
// treated as unknown rather than silently coerced.
func (c *IssueStatusContract) Canonicalize(input string) (string, bool) {
	canonical, ok := c.accepted[input]
	return canonical, ok
}

// AllAcceptedInputs returns every accepted spelling for the profile (the
// canonical spellings plus their aliases), suitable for CLI-side validation
// and for the allowed-values list in a validation error. The server remains
// authoritative: a CLI-accepted alias is still normalized by the server.
func (c *IssueStatusContract) AllAcceptedInputs() []string {
	out := make([]string, 0, len(c.accepted))
	for input := range c.accepted {
		out = append(out, input)
	}
	sort.Strings(out)
	return out
}

// IsTerminal reports whether a canonical spelling is terminal for the
// profile. It expects a canonical value (a value that passed
// ContainsCanonical); aliases are normalized before terminal checks.
func (c *IssueStatusContract) IsTerminal(canonicalStatus string) bool {
	return c.terminal[canonicalStatus]
}

// Order returns the canonical display order of a canonical status. It is used
// to build SQL CASE ordering expressions that keep the same order across
// create, update, batch, filters, groups, and sort paths.
func (c *IssueStatusContract) Order(canonicalStatus string) (int, bool) {
	order, ok := c.order[canonicalStatus]
	return order, ok
}

// WriteStatusResponse emits the 400 error for an invalid status input, listing
// every accepted spelling for the selected profile in the message. It never
// mutates anything.
func (c *IssueStatusContract) writeInvalidStatusError(w http.ResponseWriter, value string) {
	writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid status %q; valid values: %s", value, strings.Join(c.AllAcceptedInputs(), ", ")))
}

// orderCASE builds a SQL CASE expression that maps a status expression onto the
// contract's canonical display order. Unknown stored values collapse onto the
// fallback rank so no row is ever dropped by the sort.
func (c *IssueStatusContract) orderCASE(statusExpr string) string {
	var b strings.Builder
	b.WriteString("CASE ")
	b.WriteString(statusExpr)
	for _, status := range c.canonical {
		fmt.Fprintf(&b, " WHEN '%s' THEN %d", status, c.order[status])
	}
	b.WriteString(fmt.Sprintf(" ELSE %d END", len(c.canonical)))
	return b.String()
}

// activityRankCASE builds a SQL CASE expression ordering statuses by how
// "active" they are — active in-progress work first, terminal states last —
// for the search relevance tie-breaker. This is deliberately distinct from
// the display order (orderCASE): display order reflects the board's stage
// progression, while activity rank reflects how urgently a status should
// float to the top of a search. It maps every canonical status to a rank so a
// canonical spelling never collapses into the fallback.
func (c *IssueStatusContract) activityRankCASE(statusExpr string) string {
	var rank []string
	switch c.profile {
	case IssueStatusProfileLinear:
		rank = []string{"in_progress", "in_review", "todo", "blocked", "backlog", "done", "cancelled"}
	case IssueStatusProfilePPP:
		rank = []string{"in_progress", "in_review", "Spec", "Queue", "Human Review", "Done", "Cancelled", "Archived"}
	default:
		rank = c.canonical
	}
	var b strings.Builder
	b.WriteString("CASE ")
	b.WriteString(statusExpr)
	for i, status := range rank {
		fmt.Fprintf(&b, " WHEN '%s' THEN %d", status, i)
	}
	fmt.Fprintf(&b, " ELSE %d END", len(rank))
	return b.String()
}

// statusOrderSQL returns a SQL CASE expression for the canonical value printed
// through addArg (used by the table-group ordering that receives values via
// the argument list). Kept argument-based so it is safe against injection.
func (c *IssueStatusContract) statusOrderThroughArg(addArg func(any) string) string {
	var b strings.Builder
	b.WriteString("CASE group_value")
	for _, status := range c.canonical {
		fmt.Fprintf(&b, " WHEN %s::text THEN %d", addArg(status), c.order[status])
	}
	b.WriteString(fmt.Sprintf(" ELSE %d END", len(c.canonical)))
	return b.String()
}
