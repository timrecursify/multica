package handler

import "testing"

// TestNormalizeModelLabel pins the model-label canonicalization that keeps
// OpenRouter's "latest in family" alias (`~deepseek/deepseek-v4-flash-latest`)
// from persisting under a transport-only `~` marker (PROD-22899, PPP-23365).
// Before this, the alias slug and the bare slug were two distinct labels and
// model-grained joins/summaries split one physical model in two.
func TestNormalizeModelLabel(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"deepseek-v4-flash", "deepseek-v4-flash"},
		{"~deepseek/deepseek-v4-flash-latest", "deepseek/deepseek-v4-flash-latest"},
		{"  ~deepseek/deepseek-v4-flash-latest  ", "deepseek/deepseek-v4-flash-latest"},
		{"deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731"},
		{"gpt-5.6-sol", "gpt-5.6-sol"},
		{"", ""},
		{"   ", ""},
		{"~", ""},
	}
	for _, c := range cases {
		if got := normalizeModelLabel(c.in); got != c.want {
			t.Errorf("normalizeModelLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
