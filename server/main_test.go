package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
	if code := readErrorCode(t, missRec); code != "token_missing" {
		t.Fatalf("expected error code token_missing, got %q", code)
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
	if code := readErrorCode(t, badOriginRec); code != "origin_not_allowed" {
		t.Fatalf("expected error code origin_not_allowed, got %q", code)
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

func TestRequireJobAccess(t *testing.T) {
	s := &server{
		token: "server-token",
		jobs: map[string]*Job{
			"job1": {JobToken: "job-token-1"},
		},
	}

	okReq := httptest.NewRequest(http.MethodGet, "http://localhost/progress/job1?job_token=job-token-1", nil)
	okRec := httptest.NewRecorder()
	if !s.requireJobAccess(okRec, okReq, "job1") {
		t.Fatalf("expected job token auth to pass")
	}

	badReq := httptest.NewRequest(http.MethodGet, "http://localhost/progress/job1?job_token=nope", nil)
	badRec := httptest.NewRecorder()
	if s.requireJobAccess(badRec, badReq, "job1") {
		t.Fatalf("expected invalid job token to fail")
	}
	if badRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for invalid job token, got %d", badRec.Code)
	}
	if code := readErrorCode(t, badRec); code != "job_token_invalid" {
		t.Fatalf("expected error code job_token_invalid, got %q", code)
	}

	fallbackReq := httptest.NewRequest(http.MethodGet, "http://localhost/progress/job1", nil)
	fallbackReq.Header.Set("X-YTG-Token", "server-token")
	fallbackRec := httptest.NewRecorder()
	if !s.requireJobAccess(fallbackRec, fallbackReq, "job1") {
		t.Fatalf("expected fallback server token auth to pass")
	}
}

func TestHandleProgressEmitsSSEForReadyJob(t *testing.T) {
	s := &server{
		jobs: map[string]*Job{
			"job1": {
				Status:   "ready",
				Progress: 100,
				Title:    "Demo",
				Filename: "demo.mp4",
				JobToken: "job-token-1",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "http://localhost/progress/job1?job_token=job-token-1", nil)
	req.URL.Path = "/progress/job1"
	rec := httptest.NewRecorder()

	start := time.Now()
	s.handleProgress(rec, req)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("handleProgress took too long for ready job: %v", elapsed)
	}

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
		t.Fatalf("expected text/event-stream content type, got %q", got)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "data: ") {
		t.Fatalf("expected SSE body with data frame, got %q", body)
	}
	if !strings.Contains(body, "\"status\":\"ready\"") {
		t.Fatalf("expected ready status in SSE payload, got %q", body)
	}
}

func TestHandleFileServesAndCleansUp(t *testing.T) {
	tmpDir := t.TempDir()
	downloadDir := filepath.Join(tmpDir, "job-data")
	if err := os.MkdirAll(downloadDir, 0o755); err != nil {
		t.Fatalf("os.MkdirAll(downloadDir) error: %v", err)
	}
	filePath := filepath.Join(downloadDir, "demo.mp4")
	wantBody := "test-file-content\n"
	writeTestFile(t, filePath, wantBody)

	s := &server{
		jobs: map[string]*Job{
			"job1": {
				Status:   "ready",
				Filepath: filePath,
				Filename: "demo.mp4",
				JobToken: "job-token-1",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "http://localhost/file/job1?job_token=job-token-1", nil)
	req.URL.Path = "/file/job1"
	rec := httptest.NewRecorder()
	s.handleFile(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "attachment; filename*=UTF-8''demo.mp4") {
		t.Fatalf("unexpected Content-Disposition header: %q", got)
	}
	if gotBody := rec.Body.String(); gotBody != wantBody {
		t.Fatalf("unexpected response body: got %q want %q", gotBody, wantBody)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, fileErr := os.Stat(filePath)
		_, dirErr := os.Stat(downloadDir)

		s.mu.RLock()
		_, jobExists := s.jobs["job1"]
		s.mu.RUnlock()

		if os.IsNotExist(fileErr) && os.IsNotExist(dirErr) && !jobExists {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	_, fileErr := os.Stat(filePath)
	_, dirErr := os.Stat(downloadDir)
	s.mu.RLock()
	_, jobExists := s.jobs["job1"]
	s.mu.RUnlock()
	t.Fatalf("cleanup did not complete in time (fileErr=%v dirErr=%v jobExists=%v)", fileErr, dirErr, jobExists)
}

func writeExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("os.WriteFile(%q) error: %v", path, err)
	}
}

func readErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to decode error body: %v; body=%q", err, rec.Body.String())
	}
	code, _ := payload["code"].(string)
	return code
}

func TestHandleFileNotReady(t *testing.T) {
	s := &server{
		jobs: map[string]*Job{
			"job1": {
				Status:   "processing",
				Filepath: "/tmp/not-ready.mp4",
				Filename: "not-ready.mp4",
				JobToken: "job-token-1",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "http://localhost/file/job1?job_token=job-token-1", nil)
	req.URL.Path = "/file/job1"
	rec := httptest.NewRecorder()
	s.handleFile(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if code := readErrorCode(t, rec); code != "file_not_ready" {
		t.Fatalf("expected error code file_not_ready, got %q", code)
	}
}

func TestSendSSEReturnsTrueWhenWriteFails(t *testing.T) {
	s := &server{
		jobs: map[string]*Job{
			"job1": {Status: "downloading"},
		},
	}

	ok := s.sendSSE(errorWriter{}, noopFlusher{}, "job1")
	if !ok {
		t.Fatalf("expected sendSSE to return true on write failure")
	}
}

type errorWriter struct {
	header http.Header
}

func (w errorWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (errorWriter) Write([]byte) (int, error) {
	return 0, io.ErrClosedPipe
}

func (errorWriter) WriteHeader(int) {}

type noopFlusher struct{}

func (noopFlusher) Flush() {}
