package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/natefinch/lumberjack.v2"
)

type Job struct {
	mu       sync.Mutex
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Speed    string  `json:"speed"`
	Eta      string  `json:"eta"`
	Title    string  `json:"title"`
	JobToken string  `json:"-"`
	Filepath string  `json:"-"`
	Filename string  `json:"filename"`
	Error    string  `json:"error"`
}

type downloadRequest struct {
	URL     string `json:"url"`
	Title   string `json:"title"`
	Format  string `json:"format"`
	Quality string `json:"quality"`
}

type server struct {
	exeDir string
	token  string
	jobs   map[string]*Job
	slots  chan struct{}
	mu     sync.RWMutex
}

var progressRe = regexp.MustCompile(`\[download\]\s+([0-9.]+)%.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)`)
var urlRe = regexp.MustCompile(`https?://\S+`)
var version = "dev"
var commit = "unknown"

const (
	maxConcurrentDownloads = 3
	maxPendingJobs         = 60
	errorJobTTL            = 10 * time.Minute
)

func main() {
	if shouldPrintVersion(os.Args[1:]) {
		fmt.Println(displayVersion())
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		log.Fatalf("resolve executable: %v", err)
	}
	exeDir := filepath.Dir(exePath)
	setupLogging(exeDir)
	apiToken, err := loadAPIToken(exeDir)
	if err != nil {
		log.Printf("api token not loaded: %v", err)
	}

	s := &server{
		exeDir: exeDir,
		token:  apiToken,
		jobs:   make(map[string]*Job),
		slots:  make(chan struct{}, maxConcurrentDownloads),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ping", s.handlePing)
	mux.HandleFunc("/download", s.handleDownload)
	mux.HandleFunc("/progress/", s.handleProgress)
	mux.HandleFunc("/file/", s.handleFile)

	h := withCORS(mux)
	addr := "127.0.0.1:9875"
	log.Printf("YT Grabber server listening on %s", addr)
	if err := http.ListenAndServe(addr, h); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}

func setupLogging(exeDir string) {
	log.SetOutput(&lumberjack.Logger{
		Filename:   filepath.Join(exeDir, "ytgrabber.log"),
		MaxSize:    10, // MB per file
		MaxBackups: 9,  // current(10) + 9 backups ~= 100MB total cap
		MaxAge:     7,  // days
		Compress:   true,
	})
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" && isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-YTG-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			if origin != "" && !isAllowedOrigin(origin) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isAllowedOrigin(origin string) bool {
	if origin == "null" {
		return true
	}
	if origin == "https://www.youtube.com" || origin == "https://m.youtube.com" {
		return true
	}
	return strings.HasPrefix(origin, "chrome-extension://")
}

func (s *server) handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": serverVersion(),
		"commit":  serverCommit(),
	})
}

func (s *server) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.token == "" {
		http.Error(w, "server token not configured", http.StatusServiceUnavailable)
		return false
	}

	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin != "" && !isAllowedOrigin(origin) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return false
	}

	provided := strings.TrimSpace(r.Header.Get("X-YTG-Token"))
	if provided == "" {
		provided = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if provided == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return false
	}
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return false
	}
	return true
}

func shouldPrintVersion(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "--version", "-version", "version", "-v":
		return true
	default:
		return false
	}
}

func serverVersion() string {
	v := strings.TrimSpace(version)
	if v == "" {
		return "dev"
	}
	return v
}

func serverCommit() string {
	c := strings.TrimSpace(commit)
	if c == "" {
		return "unknown"
	}
	return c
}

func displayVersion() string {
	return fmt.Sprintf("%s (%s)", serverVersion(), serverCommit())
}

func loadAPIToken(exeDir string) (string, error) {
	if envToken := strings.TrimSpace(os.Getenv("YTG_API_TOKEN")); envToken != "" {
		return envToken, nil
	}

	path := strings.TrimSpace(os.Getenv("YTG_API_TOKEN_FILE"))
	if path == "" {
		if runtime.GOOS == "windows" {
			path = filepath.Join(exeDir, "ytgrabber.token")
		} else if cfg, err := os.UserConfigDir(); err == nil {
			path = filepath.Join(cfg, "ytgrabber", "token")
		} else {
			path = filepath.Join(exeDir, "ytgrabber.token")
		}
	}

	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if token == "" {
		return "", errors.New("token file is empty")
	}
	return token, nil
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireAuth(w, r) {
		return
	}

	var req downloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json body", http.StatusBadRequest)
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	req.Title = strings.TrimSpace(req.Title)
	req.Format = strings.ToLower(strings.TrimSpace(req.Format))
	req.Quality = strings.ToLower(strings.TrimSpace(req.Quality))
	if req.URL == "" {
		http.Error(w, "url is required", http.StatusBadRequest)
		return
	}
	if req.Title == "" {
		req.Title = "YouTube Download"
	}
	if req.Format != "mp4" && req.Format != "mp3" {
		http.Error(w, "format must be mp4 or mp3", http.StatusBadRequest)
		return
	}
	if !isAllowedVideoURL(req.URL) {
		http.Error(w, "url must target youtube.com/watch or m.youtube.com/watch", http.StatusBadRequest)
		return
	}

	jobID, err := newJobID()
	if err != nil {
		http.Error(w, "failed to create job id", http.StatusInternalServerError)
		return
	}
	jobToken, err := newSecretToken(16)
	if err != nil {
		http.Error(w, "failed to create job token", http.StatusInternalServerError)
		return
	}
	j := &Job{Status: "queued", Title: req.Title, JobToken: jobToken}

	s.mu.Lock()
	if len(s.jobs) >= maxPendingJobs {
		s.mu.Unlock()
		http.Error(w, "too many active jobs, try again later", http.StatusTooManyRequests)
		return
	}
	s.jobs[jobID] = j
	s.mu.Unlock()

	go s.runDownload(jobID, req)
	writeJSON(w, http.StatusAccepted, map[string]string{
		"job_id":    jobID,
		"job_token": jobToken,
	})
}

func (s *server) handleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jobID := strings.TrimPrefix(r.URL.Path, "/progress/")
	if jobID == "" {
		http.NotFound(w, r)
		return
	}
	if !s.requireJobAccess(w, r, jobID) {
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(15 * time.Minute)
	defer timeout.Stop()

	s.sendSSE(w, flusher, jobID)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-timeout.C:
			return
		case <-ticker.C:
			if done := s.sendSSE(w, flusher, jobID); done {
				return
			}
		}
	}
}

func (s *server) handleFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jobID := strings.TrimPrefix(r.URL.Path, "/file/")
	if jobID == "" {
		http.NotFound(w, r)
		return
	}
	if !s.requireJobAccess(w, r, jobID) {
		return
	}

	j, ok := s.getJob(jobID)
	if !ok {
		http.NotFound(w, r)
		return
	}

	j.mu.Lock()
	if j.Status != "ready" || j.Filepath == "" {
		j.mu.Unlock()
		http.Error(w, "file not ready", http.StatusConflict)
		return
	}
	path := j.Filepath
	filename := j.Filename
	j.mu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "file unavailable", http.StatusGone)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		http.Error(w, "file stat failed", http.StatusInternalServerError)
		return
	}

	disp := "attachment; filename*=UTF-8''" + url.PathEscape(filename)
	w.Header().Set("Content-Disposition", disp)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", st.Size()))
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("stream failed for job %s: %v", jobID, err)
	}

	tmpDir := filepath.Dir(path)
	go func() {
		time.Sleep(3 * time.Second)
		_ = os.Remove(path)
		_ = os.RemoveAll(tmpDir)
		s.mu.Lock()
		delete(s.jobs, jobID)
		s.mu.Unlock()
	}()
}

func (s *server) sendSSE(w http.ResponseWriter, flusher http.Flusher, jobID string) bool {
	j, ok := s.getJob(jobID)
	if !ok {
		return true
	}
	snap := copyJob(j)
	b, err := json.Marshal(snap)
	if err != nil {
		return true
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
		return true
	}
	flusher.Flush()
	return snap.Status == "ready" || snap.Status == "error"
}

func (s *server) runDownload(jobID string, req downloadRequest) {
	j, ok := s.getJob(jobID)
	if !ok {
		return
	}

	s.slots <- struct{}{}
	defer func() { <-s.slots }()

	ytdlpPath, err := resolveBinary("yt-dlp", s.exeDir)
	if err != nil {
		s.failJob(jobID, j, "yt-dlp not found")
		return
	}
	ffmpegPath, err := resolveBinary("ffmpeg", s.exeDir)
	if err != nil {
		s.failJob(jobID, j, "ffmpeg not found")
		return
	}

	tmpDir, err := os.MkdirTemp("", "ytgrabber-*")
	if err != nil {
		s.failJob(jobID, j, "unable to create temp directory")
		return
	}

	j.mu.Lock()
	j.Status = "downloading"
	j.Progress = 0
	j.Error = ""
	j.mu.Unlock()

	args := []string{"--newline", "--progress", "--ffmpeg-location", ffmpegPath}
	args = append(args, buildFormatArgs(req.Format, req.Quality)...)
	args = append(args, "-o", filepath.Join(tmpDir, "%(title)s.%(ext)s"), req.URL)
	log.Printf("job %s yt-dlp command: %s [URL redacted]", jobID, formatCommand(ytdlpPath, args[:len(args)-1]))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, ytdlpPath, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.failJob(jobID, j, "failed to open yt-dlp output")
		_ = os.RemoveAll(tmpDir)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.failJob(jobID, j, "failed to open yt-dlp error stream")
		_ = os.RemoveAll(tmpDir)
		return
	}

	if err := cmd.Start(); err != nil {
		s.failJob(jobID, j, "failed to start yt-dlp")
		_ = os.RemoveAll(tmpDir)
		return
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		s.consumeOutput(j, stdout)
	}()
	go func() {
		defer wg.Done()
		s.consumeOutput(j, stderr)
	}()

	waitErr := cmd.Wait()
	wg.Wait()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		s.failJob(jobID, j, "download timeout")
		_ = os.RemoveAll(tmpDir)
		return
	}
	if waitErr != nil {
		s.failJob(jobID, j, "download failed")
		_ = os.RemoveAll(tmpDir)
		return
	}

	outPath, outName, err := findOutputFile(tmpDir)
	if err != nil {
		s.failJob(jobID, j, "download completed but no output file found")
		_ = os.RemoveAll(tmpDir)
		return
	}

	j.mu.Lock()
	j.Status = "ready"
	j.Progress = 100
	j.Speed = ""
	j.Eta = ""
	j.Filepath = outPath
	j.Filename = outName
	j.mu.Unlock()
}

func (s *server) consumeOutput(j *Job, r io.Reader) {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		log.Println(redactURLs(line))
		if m := progressRe.FindStringSubmatch(line); len(m) == 4 {
			progress := parseProgress(m[1])
			j.mu.Lock()
			j.Status = "downloading"
			j.Progress = progress
			j.Speed = m[2]
			j.Eta = m[3]
			j.mu.Unlock()
			continue
		}
		if strings.Contains(line, "[ffmpeg]") || strings.Contains(strings.ToLower(line), "post-process") {
			j.mu.Lock()
			j.Status = "processing"
			j.mu.Unlock()
		}
	}
}

func redactURLs(line string) string {
	return urlRe.ReplaceAllString(line, "[redacted-url]")
}

func parseProgress(v string) float64 {
	var p float64
	_, _ = fmt.Sscanf(v, "%f", &p)
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

func buildFormatArgs(format, quality string) []string {
	if format == "mp3" {
		return []string{"-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K"}
	}

	quality = strings.TrimPrefix(quality, "p")
	switch quality {
	case "1080":
		return []string{"-f", "bestvideo[vcodec^=avc1][height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]", "--merge-output-format", "mp4"}
	case "720":
		return []string{"-f", "bestvideo[vcodec^=avc1][height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]", "--merge-output-format", "mp4"}
	case "480":
		return []string{"-f", "bestvideo[vcodec^=avc1][height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]", "--merge-output-format", "mp4"}
	case "360":
		return []string{"-f", "bestvideo[vcodec^=avc1][height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]", "--merge-output-format", "mp4"}
	default:
		return []string{"-f", "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4"}
	}
}

func resolveBinary(name, exeDir string) (string, error) {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	local := filepath.Join(exeDir, name+ext)
	if st, err := os.Stat(local); err == nil && !st.IsDir() {
		return local, nil
	}
	if runtime.GOOS != "windows" {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s not found", name)
}

func formatCommand(bin string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, bin)
	parts = append(parts, args...)

	quoted := make([]string, len(parts))
	for i, p := range parts {
		quoted[i] = strconv.Quote(p)
	}
	return strings.Join(quoted, " ")
}

func findOutputFile(dir string) (string, string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", "", err
	}

	type candidate struct {
		path    string
		name    string
		modTime time.Time
		size    int64
	}
	candidates := make([]candidate, 0, len(entries))

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !isLikelyMediaOutput(name) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		candidates = append(candidates, candidate{
			path:    filepath.Join(dir, name),
			name:    name,
			modTime: info.ModTime(),
			size:    info.Size(),
		})
	}

	if len(candidates) == 0 {
		return "", "", errors.New("no output file")
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].modTime.Equal(candidates[j].modTime) {
			if candidates[i].size == candidates[j].size {
				return candidates[i].name < candidates[j].name
			}
			return candidates[i].size > candidates[j].size
		}
		return candidates[i].modTime.After(candidates[j].modTime)
	})

	return candidates[0].path, candidates[0].name, nil
}

func isLikelyMediaOutput(name string) bool {
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".part") {
		return false
	}

	ext := filepath.Ext(lower)
	switch ext {
	case ".json", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".vtt", ".srt", ".sbv", ".ass", ".lrc", ".txt", ".description":
		return false
	}
	return true
}

func (s *server) failJob(jobID string, j *Job, msg string) {
	j.mu.Lock()
	j.Status = "error"
	j.Error = msg
	j.Speed = ""
	j.Eta = ""
	j.mu.Unlock()
	log.Println(msg)
	go func() {
		time.Sleep(errorJobTTL)
		s.mu.Lock()
		delete(s.jobs, jobID)
		s.mu.Unlock()
	}()
}

func (s *server) getJob(jobID string) (*Job, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	j, ok := s.jobs[jobID]
	return j, ok
}

func copyJob(j *Job) Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	return Job{
		Status:   j.Status,
		Progress: j.Progress,
		Speed:    j.Speed,
		Eta:      j.Eta,
		Title:    j.Title,
		Filename: j.Filename,
		Error:    j.Error,
	}
}

func newJobID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func newSecretToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func isAllowedVideoURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host != "www.youtube.com" && host != "youtube.com" && host != "m.youtube.com" {
		return false
	}
	return u.Path == "/watch" && u.Query().Get("v") != ""
}

func (s *server) requireJobAccess(w http.ResponseWriter, r *http.Request, jobID string) bool {
	j, ok := s.getJob(jobID)
	if !ok {
		http.NotFound(w, r)
		return false
	}
	provided := strings.TrimSpace(r.URL.Query().Get("job_token"))
	if provided == "" {
		provided = strings.TrimSpace(r.Header.Get("X-YTG-Job-Token"))
	}
	if provided != "" {
		j.mu.Lock()
		valid := subtle.ConstantTimeCompare([]byte(provided), []byte(j.JobToken)) == 1
		j.mu.Unlock()
		if valid {
			return true
		}
		http.Error(w, "invalid job token", http.StatusUnauthorized)
		return false
	}
	return s.requireAuth(w, r)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
