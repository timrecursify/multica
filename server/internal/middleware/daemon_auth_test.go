package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/auth"
)

func TestDaemonAuth_DaemonTokenCacheHit(t *testing.T) {
	rdb := newRedisTestClient(t)
	cache := auth.NewDaemonTokenCache(rdb)
	const rawToken = "mdt_cache_hit_test_token"
	cache.Set(context.Background(), auth.HashToken(rawToken), auth.DaemonTokenIdentity{
		WorkspaceID: "ws-cached",
		DaemonID:    "daemon-cached",
	}, auth.AuthCacheTTL)

	var gotWorkspaceID, gotDaemonID, gotPath string
	handler := DaemonAuth(nil, cache)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotWorkspaceID = DaemonWorkspaceIDFromContext(r.Context())
		gotDaemonID = DaemonIDFromContext(r.Context())
		gotPath = DaemonAuthPathFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/daemon/heartbeat", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on cache hit, got %d: %s", w.Code, w.Body.String())
	}
	if gotWorkspaceID != "ws-cached" || gotDaemonID != "daemon-cached" {
		t.Fatalf("expected cached daemon identity, got (%q, %q)", gotWorkspaceID, gotDaemonID)
	}
	if gotPath != DaemonAuthPathDaemonToken {
		t.Fatalf("expected auth path %q, got %q", DaemonAuthPathDaemonToken, gotPath)
	}
}

func TestDaemonAuth_RejectsNonDaemonCredentials(t *testing.T) {
	for _, token := range []string{
		"mul_user_pat",
		"mcn_machine_credential",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature",
		"not-a-daemon-token",
	} {
		t.Run(token, func(t *testing.T) {
			called := false
			handler := DaemonAuth(nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/daemon/heartbeat", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
			}
			if called {
				t.Fatal("next must not be called")
			}
		})
	}
}

func TestDaemonAuth_RejectsMissingMalformedAndUnknownDaemonTokens(t *testing.T) {
	for _, authorization := range []string{"", "mdt_unknown", "Bearer mdt_unknown"} {
		t.Run(authorization, func(t *testing.T) {
			handler := DaemonAuth(nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("next must not be called")
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/daemon/heartbeat", nil)
			if authorization != "" {
				req.Header.Set("Authorization", authorization)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestDaemonAuth_StripsClientSuppliedActorSource(t *testing.T) {
	rdb := newRedisTestClient(t)
	cache := auth.NewDaemonTokenCache(rdb)
	const rawToken = "mdt_strip_test"
	cache.Set(context.Background(), auth.HashToken(rawToken), auth.DaemonTokenIdentity{
		WorkspaceID: "ws-1",
		DaemonID:    "daemon-1",
	}, auth.AuthCacheTTL)

	var gotActorSource string
	handler := DaemonAuth(nil, cache)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotActorSource = r.Header.Get("X-Actor-Source")
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/daemon/heartbeat", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	req.Header.Set("X-Actor-Source", "cloud_pat")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if gotActorSource != "" {
		t.Fatalf("X-Actor-Source must be cleared, got %q", gotActorSource)
	}
}
