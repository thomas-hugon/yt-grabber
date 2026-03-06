package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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

func TestBuildFormatArgs(t *testing.T) {
	tests := []struct {
		name    string
		format  string
		quality string
		want    []string
	}{
		{
			name:    "mp3",
			format:  "mp3",
			quality: "best",
			want:    []string{"-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K"},
		},
		{
			name:    "mp4_1080",
			format:  "mp4",
			quality: "1080",
			want:    []string{"-f", "bestvideo[vcodec^=avc1][height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]", "--merge-output-format", "mp4"},
		},
		{
			name:    "mp4_prefixed_quality",
			format:  "mp4",
			quality: "p720",
			want:    []string{"-f", "bestvideo[vcodec^=avc1][height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]", "--merge-output-format", "mp4"},
		},
		{
			name:    "mp4_default",
			format:  "mp4",
			quality: "best",
			want:    []string{"-f", "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4"},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := buildFormatArgs(tc.format, tc.quality)
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Fatalf("buildFormatArgs(%q, %q) = %v, want %v", tc.format, tc.quality, got, tc.want)
			}
		})
	}
}

func TestParseProgress(t *testing.T) {
	tests := []struct {
		input string
		want  float64
	}{
		{input: "72.5", want: 72.5},
		{input: "-5", want: 0},
		{input: "145", want: 100},
		{input: "invalid", want: 0},
	}

	for _, tc := range tests {
		if got := parseProgress(tc.input); got != tc.want {
			t.Fatalf("parseProgress(%q) = %v, want %v", tc.input, got, tc.want)
		}
	}
}

func TestResolveBinaryForOS(t *testing.T) {
	exeDir := t.TempDir()
	pathDir := t.TempDir()

	if runtime.GOOS == "windows" {
		t.Skip("binary resolution tests rely on POSIX executable permissions")
	}

	localLinuxBinary := filepath.Join(exeDir, "yt-dlp")
	writeExecutable(t, localLinuxBinary, "#!/bin/sh\nexit 0\n")
	if got, err := resolveBinaryForOS("yt-dlp", exeDir, "linux"); err != nil || got != localLinuxBinary {
		t.Fatalf("resolveBinaryForOS local linux = (%q, %v), want (%q, nil)", got, err, localLinuxBinary)
	}

	if err := os.Remove(localLinuxBinary); err != nil {
		t.Fatalf("os.Remove(localLinuxBinary) error: %v", err)
	}

	pathBinary := filepath.Join(pathDir, "yt-dlp")
	writeExecutable(t, pathBinary, "#!/bin/sh\nexit 0\n")
	origPath := os.Getenv("PATH")
	if err := os.Setenv("PATH", pathDir); err != nil {
		t.Fatalf("os.Setenv(PATH) error: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Setenv("PATH", origPath)
	})

	if got, err := resolveBinaryForOS("yt-dlp", exeDir, "linux"); err != nil || got != pathBinary {
		t.Fatalf("resolveBinaryForOS path linux = (%q, %v), want (%q, nil)", got, err, pathBinary)
	}

	localWindowsBinary := filepath.Join(exeDir, "yt-dlp.exe")
	writeExecutable(t, localWindowsBinary, "#!/bin/sh\nexit 0\n")
	if got, err := resolveBinaryForOS("yt-dlp", exeDir, "windows"); err != nil || got != localWindowsBinary {
		t.Fatalf("resolveBinaryForOS local windows = (%q, %v), want (%q, nil)", got, err, localWindowsBinary)
	}

	if err := os.Remove(localWindowsBinary); err != nil {
		t.Fatalf("os.Remove(localWindowsBinary) error: %v", err)
	}
	if _, err := resolveBinaryForOS("yt-dlp", exeDir, "windows"); err == nil {
		t.Fatalf("resolveBinaryForOS windows should fail when binary is not local")
	}
}

func writeExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("os.WriteFile(%q) error: %v", path, err)
	}
}
