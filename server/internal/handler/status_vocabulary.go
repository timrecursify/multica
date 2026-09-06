package handler

// BackendStatusVocabulary is the checked-in wire contract for the two live
// Multica deployments. Keys are canonical stored statuses and values are the
// tokens accepted/emitted by that backend. Keep this table in sync with the
// CLI table in sk-cli/docs/multica-status-vocabulary.md.
var BackendStatusVocabulary = map[IssueStatusProfile]map[string]string{
	IssueStatusProfilePPP: {
		"Registered": "Registered", "Spec": "Spec", "Queue": "Queue",
		"In Progress": "In Progress", "In Review": "In Review",
		"Human Review": "Human Review", "CI/CD & Deploy": "CI/CD & Deploy",
		"Done": "Done", "Archived": "Archived", "Cancelled": "Cancelled",
	},
	IssueStatusProfileLinear: {
		"Registered": "todo", "Spec": "todo", "Queue": "backlog",
		"In Progress": "in_progress", "In Review": "in_review",
		"Human Review": "blocked", "CI/CD & Deploy": "in_review",
		"Done": "done", "Archived": "cancelled", "Cancelled": "cancelled",
	},
}

// BackendWireStatus returns the declared token for a canonical status.
func BackendWireStatus(profile IssueStatusProfile, canonical string) (string, bool) {
	table, ok := BackendStatusVocabulary[profile]
	if !ok {
		return "", false
	}
	token, ok := table[canonical]
	return token, ok
}
