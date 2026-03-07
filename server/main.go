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
	mu               sync.Mutex
	Status           string  `json:"status"`
	Progress         float64 `json:"progress"`
	Speed            string  `json:"speed"`
	Eta              string  `json:"eta"`
	Title            string  `json:"title"`
	JobToken         string  `json:"-"`
	Filepath         string  `json:"-"`
	Filename         string  `json:"filename"`
	Error            string  `json:"error"`
	RequestedFormat  string  `json:"requested_format"`
	RequestedQuality string  `json:"requested_quality"`
	ResolvedFormat   string  `json:"resolved_format"`
	ResolvedHeight   string  `json:"resolved_height"`
}

type JobSnapshot struct {
	Status           string  `json:"status"`
	Progress         float64 `json:"progress"`
	Speed            string  `json:"speed"`
	Eta              string  `json:"eta"`
	Title            string  `json:"title"`
	Filename         string  `json:"filename"`
	Error            string  `json:"error"`
	RequestedFormat  string  `json:"requested_format"`
	RequestedQuality string  `json:"requested_quality"`
	ResolvedFormat   string  `json:"resolved_format"`
	ResolvedHeight   string  `json:"resolved_height"`
}

type downloadRequest struct {
	URL     string `json:"url"`
	Title   string `json:"title"`
	Format  string `json:"format"`
	Quality string `json:"quality"`
}

type formatsRequest struct {
	URL string `json:"url"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type pairingResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

type formatsResponse struct {
	Status         string   `json:"status"`
	Title          string   `json:"title"`
	QualityOptions []string `json:"quality_options"`
}

type ytDLPMetadata struct {
	Title   string        `json:"title"`
	Formats []ytDLPFormat `json:"formats"`
}

type ytDLPFormat struct {
	Height int    `json:"height"`
	VCodec string `json:"vcodec"`
}

type ffprobePayload struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	CodecType string `json:"codec_type"`
	Height    int    `json:"height"`
}

type ffprobeFormat struct {
	FormatName string `json:"format_name"`
}

type FormatProbeResult struct {
	Title          string
	QualityOptions []string
}

type ResolvedOutput struct {
	Format string
	Height string
}

type server struct {
	exeDir string
	token  string
	jobs   map[string]*Job
	slots  chan struct{}
	mu     sync.RWMutex

	runDownloadOverride  func(string, downloadRequest)
	probeFormatsOverride func(context.Context, string, string) (FormatProbeResult, error)
	probeOutputOverride  func(context.Context, string, string) (ResolvedOutput, error)
	cleanupDelay         time.Duration
}

var progressRe = regexp.MustCompile(`\[download\]\s+([0-9.]+)%.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)`)
var urlRe = regexp.MustCompile(`https?://\S+`)
var version = "dev"
var commit = "unknown"

const (
	maxConcurrentDownloads = 3
	maxPendingJobs         = 60
	errorJobTTL            = 10 * time.Minute
	defaultCleanupDelay    = 3 * time.Second
	downloadTimeout        = 30 * time.Minute
	progressTimeout        = 15 * time.Minute
	formatProbeTimeout     = 20 * time.Second
	outputProbeTimeout     = 10 * time.Second
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

	s := newServer(exeDir, apiToken)
	addr := "127.0.0.1:9875"
	log.Printf("YT Grabber server listening on %s", addr)
	if err := http.ListenAndServe(addr, withCORS(s.routes())); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}

func newServer(exeDir, token string) *server {
	return &server{
		exeDir:       exeDir,
		token:        token,
		jobs:         make(map[string]*Job),
		slots:        make(chan struct{}, maxConcurrentDownloads),
		cleanupDelay: defaultCleanupDelay,
	}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ping", s.handlePing)
	mux.HandleFunc("/pairing", s.handlePairing)
	mux.HandleFunc("/formats", s.handleFormats)
	mux.HandleFunc("/download", s.handleDownload)
	mux.HandleFunc("/job/", s.handleJob)
	mux.HandleFunc("/progress/", s.handleProgress)
	mux.HandleFunc("/file/", s.handleFile)
	return mux
}

func setupLogging(exeDir string) {
	log.SetOutput(&lumberjack.Logger{
		Filename:   filepath.Join(exeDir, "ytgrabber.log"),
		MaxSize:    10,
		MaxBackups: 9,
		MaxAge:     7,
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
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-YTG-Token, X-YTG-Job-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			if origin != "" && !isAllowedOrigin(origin) {
				writeAPIError(w, http.StatusForbidden, "origin_not_allowed", "origin not allowed")
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
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": serverVersion(),
		"commit":  serverCommit(),
	})
}

func (s *server) handlePairing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.requireAuth(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, pairingResponse{
		Status:  "paired",
		Version: serverVersion(),
		Commit:  serverCommit(),
	})
}

func (s *server) handleFormats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.requireAuth(w, r) {
		return
	}

	var req formatsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "invalid json body")
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		writeAPIError(w, http.StatusBadRequest, "url_required", "url is required")
		return
	}
	if !isAllowedVideoURL(req.URL) {
		writeAPIError(w, http.StatusBadRequest, "invalid_url", "url must target youtube.com/watch or m.youtube.com/watch")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), formatProbeTimeout)
	defer cancel()

	result, err := s.probeFormats(ctx, req.URL)
	if err != nil {
		log.Printf("format probe failed: %v", err)
		writeAPIError(w, http.StatusBadGateway, "format_probe_failed", "failed to inspect formats")
		return
	}

	writeJSON(w, http.StatusOK, formatsResponse{
		Status:         "ok",
		Title:          result.Title,
		QualityOptions: result.QualityOptions,
	})
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.requireAuth(w, r) {
		return
	}

	var req downloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "invalid json body")
		return
	}
	if status, code, message := normalizeDownloadRequest(&req); status != 0 {
		writeAPIError(w, status, code, message)
		return
	}

	jobID, err := newJobID()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "job_id_generation_failed", "failed to create job id")
		return
	}
	jobToken, err := newSecretToken(16)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "job_token_generation_failed", "failed to create job token")
		return
	}
	j := &Job{
		Status:           "queued",
		Title:            req.Title,
		JobToken:         jobToken,
		RequestedFormat:  req.Format,
		RequestedQuality: req.Quality,
	}

	s.mu.Lock()
	if len(s.jobs) >= maxPendingJobs {
		s.mu.Unlock()
		writeAPIError(w, http.StatusTooManyRequests, "too_many_jobs", "too many active jobs, try again later")
		return
	}
	s.jobs[jobID] = j
	s.mu.Unlock()

	s.startDownload(jobID, req)
	writeJSON(w, http.StatusAccepted, map[string]string{
		"job_id":    jobID,
		"job_token": jobToken,
	})
}

func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	jobID := strings.TrimPrefix(r.URL.Path, "/job/")
	if jobID == "" {
		writeAPIError(w, http.StatusNotFound, "job_id_missing", "job id is required")
		return
	}
	if !s.requireJobAccess(w, r, jobID) {
		return
	}

	j, ok := s.getJob(jobID)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "job_not_found", "job not found")
		return
	}
	writeJSON(w, http.StatusOK, copyJob(j))
}

func (s *server) handleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	jobID := strings.TrimPrefix(r.URL.Path, "/progress/")
	if jobID == "" {
		writeAPIError(w, http.StatusNotFound, "job_id_missing", "job id is required")
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
		writeAPIError(w, http.StatusInternalServerError, "streaming_unsupported", "streaming unsupported")
		return
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(progressTimeout)
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
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	jobID := strings.TrimPrefix(r.URL.Path, "/file/")
	if jobID == "" {
		writeAPIError(w, http.StatusNotFound, "job_id_missing", "job id is required")
		return
	}
	if !s.requireJobAccess(w, r, jobID) {
		return
	}

	j, ok := s.getJob(jobID)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "job_not_found", "job not found")
		return
	}

	j.mu.Lock()
	if j.Status != "ready" || j.Filepath == "" {
		j.mu.Unlock()
		writeAPIError(w, http.StatusConflict, "file_not_ready", "file not ready")
		return
	}
	path := j.Filepath
	filename := j.Filename
	j.mu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		writeAPIError(w, http.StatusGone, "file_unavailable", "file unavailable")
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "file_stat_failed", "file stat failed")
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
		time.Sleep(s.cleanupDelay)
		_ = os.Remove(path)
		_ = os.RemoveAll(tmpDir)
		s.mu.Lock()
		delete(s.jobs, jobID)
		s.mu.Unlock()
	}()
}

func (s *server) startDownload(jobID string, req downloadRequest) {
	if s.runDownloadOverride != nil {
		s.runDownloadOverride(jobID, req)
		return
	}
	go s.runDownload(jobID, req)
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

	args := []string{"--newline", "--progress", "--ffmpeg-location", filepath.Dir(ffmpegPath)}
	args = append(args, buildFormatArgs(req.Format, req.Quality)...)
	args = append(args, "-o", filepath.Join(tmpDir, "%(title)s.%(ext)s"), req.URL)
	log.Printf("job %s yt-dlp command: %s [URL redacted]", jobID, formatCommand(ytdlpPath, args[:len(args)-1]))

	ctx, cancel := context.WithTimeout(context.Background(), downloadTimeout)
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

	resolved := ResolvedOutput{
		Format: formatFromPathOrProbe(outPath, ""),
	}
	probeCtx, probeCancel := context.WithTimeout(context.Background(), outputProbeTimeout)
	defer probeCancel()
	if probed, err := s.probeOutput(probeCtx, outPath); err == nil {
		if probed.Format != "" {
			resolved.Format = probed.Format
		}
		if probed.Height != "" {
			resolved.Height = probed.Height
		}
	} else {
		log.Printf("job %s output probe failed: %v", jobID, err)
	}

	j.mu.Lock()
	j.Status = "ready"
	j.Progress = 100
	j.Speed = ""
	j.Eta = ""
	j.Filepath = outPath
	j.Filename = outName
	j.ResolvedFormat = resolved.Format
	j.ResolvedHeight = resolved.Height
	j.mu.Unlock()
}

func (s *server) probeFormats(ctx context.Context, videoURL string) (FormatProbeResult, error) {
	if s.probeFormatsOverride != nil {
		return s.probeFormatsOverride(ctx, s.exeDir, videoURL)
	}
	return defaultProbeFormats(ctx, s.exeDir, videoURL)
}

func defaultProbeFormats(ctx context.Context, exeDir, videoURL string) (FormatProbeResult, error) {
	ytdlpPath, err := resolveBinary("yt-dlp", exeDir)
	if err != nil {
		return FormatProbeResult{}, err
	}
	args := []string{"--dump-single-json", "--no-warnings", "--no-playlist", "--skip-download", videoURL}
	output, err := exec.CommandContext(ctx, ytdlpPath, args...).CombinedOutput()
	if err != nil {
		return FormatProbeResult{}, fmt.Errorf("yt-dlp probe failed: %w", err)
	}
	return parseFormatProbeResult(output)
}

func parseFormatProbeResult(data []byte) (FormatProbeResult, error) {
	var meta ytDLPMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return FormatProbeResult{}, err
	}
	return FormatProbeResult{
		Title:          strings.TrimSpace(meta.Title),
		QualityOptions: collectAvailableQualities(meta.Formats),
	}, nil
}

func collectAvailableQualities(formats []ytDLPFormat) []string {
	heights := make(map[int]struct{})
	for _, format := range formats {
		if format.Height <= 0 {
			continue
		}
		vcodec := strings.ToLower(strings.TrimSpace(format.VCodec))
		if vcodec == "" || vcodec == "none" {
			continue
		}
		heights[format.Height] = struct{}{}
	}

	values := make([]int, 0, len(heights))
	for height := range heights {
		values = append(values, height)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(values)))

	options := make([]string, 0, len(values)+1)
	options = append(options, "best")
	for _, height := range values {
		options = append(options, strconv.Itoa(height))
	}
	return options
}

func (s *server) probeOutput(ctx context.Context, filePath string) (ResolvedOutput, error) {
	if s.probeOutputOverride != nil {
		return s.probeOutputOverride(ctx, s.exeDir, filePath)
	}
	return defaultProbeOutput(ctx, s.exeDir, filePath)
}

func defaultProbeOutput(ctx context.Context, exeDir, filePath string) (ResolvedOutput, error) {
	fallback := ResolvedOutput{Format: formatFromPathOrProbe(filePath, "")}
	ffprobePath, err := resolveBinary("ffprobe", exeDir)
	if err != nil {
		return fallback, err
	}

	args := []string{
		"-v", "error",
		"-show_entries", "format=format_name:stream=codec_type,height",
		"-of", "json",
		filePath,
	}
	output, err := exec.CommandContext(ctx, ffprobePath, args...).CombinedOutput()
	if err != nil {
		return fallback, fmt.Errorf("ffprobe failed: %w", err)
	}

	probed, err := parseResolvedOutputProbe(output, filePath)
	if err != nil {
		return fallback, err
	}
	if probed.Format == "" {
		probed.Format = fallback.Format
	}
	return probed, nil
}

func parseResolvedOutputProbe(data []byte, filePath string) (ResolvedOutput, error) {
	var payload ffprobePayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return ResolvedOutput{}, err
	}

	maxHeight := 0
	for _, stream := range payload.Streams {
		if stream.CodecType != "video" {
			continue
		}
		if stream.Height > maxHeight {
			maxHeight = stream.Height
		}
	}

	result := ResolvedOutput{
		Format: formatFromPathOrProbe(filePath, payload.Format.FormatName),
	}
	if maxHeight > 0 {
		result.Height = strconv.Itoa(maxHeight)
	}
	return result, nil
}

func formatFromPathOrProbe(filePath, formatName string) string {
	if ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(filePath)), "."); ext != "" {
		return ext
	}

	lower := strings.ToLower(strings.TrimSpace(formatName))
	switch {
	case strings.Contains(lower, "mp3"):
		return "mp3"
	case strings.Contains(lower, "mp4"), strings.Contains(lower, "mov"):
		return "mp4"
	case strings.Contains(lower, "matroska"):
		return "mkv"
	default:
		return ""
	}
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

	normalized, err := normalizeRequestedQuality("mp4", quality)
	if err != nil || normalized == "best" {
		return []string{"-f", "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4"}
	}

	selector := fmt.Sprintf("bestvideo[vcodec^=avc1][height<=%[1]s][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=%[1]s][ext=mp4]+bestaudio[ext=m4a]/best[height<=%[1]s]", normalized)
	return []string{"-f", selector, "--merge-output-format", "mp4"}
}

func normalizeDownloadRequest(req *downloadRequest) (int, string, string) {
	req.URL = strings.TrimSpace(req.URL)
	req.Title = strings.TrimSpace(req.Title)
	req.Format = strings.ToLower(strings.TrimSpace(req.Format))
	req.Quality = strings.TrimSpace(req.Quality)

	if req.URL == "" {
		return http.StatusBadRequest, "url_required", "url is required"
	}
	if !isAllowedVideoURL(req.URL) {
		return http.StatusBadRequest, "invalid_url", "url must target youtube.com/watch or m.youtube.com/watch"
	}
	if req.Title == "" {
		req.Title = "YouTube Download"
	}
	if req.Format != "mp4" && req.Format != "mp3" {
		return http.StatusBadRequest, "invalid_format", "format must be mp4 or mp3"
	}

	normalizedQuality, err := normalizeRequestedQuality(req.Format, req.Quality)
	if err != nil {
		return http.StatusBadRequest, "invalid_quality", "quality must be best or a numeric height"
	}
	req.Quality = normalizedQuality
	return 0, "", ""
}

func normalizeRequestedQuality(format, raw string) (string, error) {
	quality := strings.ToLower(strings.TrimSpace(raw))
	if format != "mp4" {
		if quality == "" {
			return "best", nil
		}
		return quality, nil
	}

	if quality == "" || quality == "best" {
		return "best", nil
	}
	quality = strings.TrimPrefix(quality, "p")
	height, err := strconv.Atoi(quality)
	if err != nil || height <= 0 {
		return "", errors.New("invalid quality")
	}
	return strconv.Itoa(height), nil
}

func resolveBinary(name, exeDir string) (string, error) {
	return resolveBinaryForOS(name, exeDir, runtime.GOOS)
}

func resolveBinaryForOS(name, exeDir, goos string) (string, error) {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	local := filepath.Join(exeDir, name+ext)
	if st, err := os.Stat(local); err == nil && !st.IsDir() {
		return local, nil
	}
	if goos != "windows" {
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

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !isLikelyMediaOutput(name) {
			continue
		}
		info, err := entry.Info()
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

func copyJob(j *Job) JobSnapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	return JobSnapshot{
		Status:           j.Status,
		Progress:         j.Progress,
		Speed:            j.Speed,
		Eta:              j.Eta,
		Title:            j.Title,
		Filename:         j.Filename,
		Error:            j.Error,
		RequestedFormat:  j.RequestedFormat,
		RequestedQuality: j.RequestedQuality,
		ResolvedFormat:   j.ResolvedFormat,
		ResolvedHeight:   j.ResolvedHeight,
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

func (s *server) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.token == "" {
		writeAPIError(w, http.StatusServiceUnavailable, "token_not_configured", "server token not configured")
		return false
	}

	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin != "" && !isAllowedOrigin(origin) {
		writeAPIError(w, http.StatusForbidden, "origin_not_allowed", "origin not allowed")
		return false
	}

	provided := strings.TrimSpace(r.Header.Get("X-YTG-Token"))
	if provided == "" {
		provided = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if provided == "" {
		writeAPIError(w, http.StatusUnauthorized, "token_missing", "missing token")
		return false
	}
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
		writeAPIError(w, http.StatusUnauthorized, "token_invalid", "invalid token")
		return false
	}
	return true
}

func (s *server) requireJobAccess(w http.ResponseWriter, r *http.Request, jobID string) bool {
	j, ok := s.getJob(jobID)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "job_not_found", "job not found")
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
		writeAPIError(w, http.StatusUnauthorized, "job_token_invalid", "invalid job token")
		return false
	}

	return s.requireAuth(w, r)
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

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, apiError{
		Code:    code,
		Message: message,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
