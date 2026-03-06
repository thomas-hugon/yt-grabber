package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestShouldPrintVersion(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "empty", args: nil, want: false},
		{name: "dash_version", args: []string{"--version"}, want: true},
		{name: "single_dash_v", args: []string{"-v"}, want: true},
		{name: "word_version", args: []string{"version"}, want: true},
		{name: "unknown", args: []string{"serve"}, want: false},
		{name: "second_arg_ignored", args: []string{"serve", "--version"}, want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldPrintVersion(tc.args); got != tc.want {
				t.Fatalf("shouldPrintVersion(%v) = %v, want %v", tc.args, got, tc.want)
			}
		})
	}
}

func TestServerVersion(t *testing.T) {
	original := version
	t.Cleanup(func() { version = original })

	version = "v2026.03.06-9"
	if got := serverVersion(); got != "v2026.03.06-9" {
		t.Fatalf("serverVersion() = %q, want %q", got, "v2026.03.06-9")
	}

	version = "   "
	if got := serverVersion(); got != "dev" {
		t.Fatalf("serverVersion() with blank version = %q, want %q", got, "dev")
	}
}

func TestServerCommit(t *testing.T) {
	original := commit
	t.Cleanup(func() { commit = original })

	commit = "abc123"
	if got := serverCommit(); got != "abc123" {
		t.Fatalf("serverCommit() = %q, want %q", got, "abc123")
	}

	commit = "   "
	if got := serverCommit(); got != "unknown" {
		t.Fatalf("serverCommit() with blank commit = %q, want %q", got, "unknown")
	}
}

func TestDisplayVersion(t *testing.T) {
	originalVersion := version
	originalCommit := commit
	t.Cleanup(func() {
		version = originalVersion
		commit = originalCommit
	})

	version = "v2026.03.06-10"
	commit = "5fbeec16eb788b0deb4441a498978113a7c13e8a"

	want := "v2026.03.06-10 (5fbeec16eb788b0deb4441a498978113a7c13e8a)"
	if got := displayVersion(); got != want {
		t.Fatalf("displayVersion() = %q, want %q", got, want)
	}
}

func TestIsAllowedOrigin(t *testing.T) {
	tests := []struct {
		origin string
		want   bool
	}{
		{origin: "https://www.youtube.com", want: true},
		{origin: "https://m.youtube.com", want: true},
		{origin: "chrome-extension://abcdef", want: true},
		{origin: "https://evil.example.com", want: false},
		{origin: "", want: false},
	}

	for _, tc := range tests {
		if got := isAllowedOrigin(tc.origin); got != tc.want {
			t.Fatalf("isAllowedOrigin(%q)=%v want %v", tc.origin, got, tc.want)
		}
	}
}

func TestRequireAuth(t *testing.T) {
	s := &server{token: "secret-token"}

	okReq := httptest.NewRequest(http.MethodPost, "http://localhost/download?token=secret-token", nil)
	okReq.Header.Set("Origin", "https://www.youtube.com")
	okRec := httptest.NewRecorder()
	if !s.requireAuth(okRec, okReq) {
		t.Fatalf("expected auth to pass")
	}

	missReq := httptest.NewRequest(http.MethodPost, "http://localhost/download", nil)
	missRec := httptest.NewRecorder()
	if s.requireAuth(missRec, missReq) {
		t.Fatalf("expected auth to fail without token")
	}
	if missRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", missRec.Code)
	}

	badOriginReq := httptest.NewRequest(http.MethodPost, "http://localhost/download?token=secret-token", nil)
	badOriginReq.Header.Set("Origin", "https://evil.example.com")
	badOriginRec := httptest.NewRecorder()
	if s.requireAuth(badOriginRec, badOriginReq) {
		t.Fatalf("expected auth to fail for bad origin")
	}
	if badOriginRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", badOriginRec.Code)
	}
}

func TestFindOutputFileIgnoresSidecarFiles(t *testing.T) {
	dir := t.TempDir()

	writeTestFile(t, filepath.Join(dir, "video.info.json"), "meta")
	writeTestFile(t, filepath.Join(dir, "video.jpg"), "thumb")
	writeTestFile(t, filepath.Join(dir, "video.part"), "partial")
	writeTestFile(t, filepath.Join(dir, "video.mp4"), "binary-media")

	path, name, err := findOutputFile(dir)
	if err != nil {
		t.Fatalf("findOutputFile returned error: %v", err)
	}
	if name != "video.mp4" {
		t.Fatalf("findOutputFile picked %q, want video.mp4", name)
	}
	if path != filepath.Join(dir, "video.mp4") {
		t.Fatalf("findOutputFile path = %q, want %q", path, filepath.Join(dir, "video.mp4"))
	}
}

func TestFindOutputFilePrefersMostRecentMedia(t *testing.T) {
	dir := t.TempDir()

	oldPath := filepath.Join(dir, "old.mp4")
	newPath := filepath.Join(dir, "new.mp3")
	writeTestFile(t, oldPath, "old-media")
	writeTestFile(t, newPath, "new-media")

	oldTime := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(oldPath, oldTime, oldTime); err != nil {
		t.Fatalf("os.Chtimes(old) error: %v", err)
	}

	path, name, err := findOutputFile(dir)
	if err != nil {
		t.Fatalf("findOutputFile returned error: %v", err)
	}
	if name != "new.mp3" {
		t.Fatalf("findOutputFile picked %q, want new.mp3", name)
	}
	if path != newPath {
		t.Fatalf("findOutputFile path = %q, want %q", path, newPath)
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("os.WriteFile(%q) error: %v", path, err)
	}
}
