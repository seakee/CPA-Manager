package httpapi

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/seakee/cpa-manager/usage-service/internal/collector"
	"github.com/seakee/cpa-manager/usage-service/internal/config"
	"github.com/seakee/cpa-manager/usage-service/internal/store"
	"github.com/seakee/cpa-manager/usage-service/internal/usage"
)

//go:embed web/management.html
var embeddedPanel embed.FS

type Server struct {
	cfg       config.Config
	store     *store.Store
	collector *collector.Manager
	startedAt int64
}

type setupRequest struct {
	CPAUpstreamURL string `json:"cpaBaseUrl"`
	ManagementKey  string `json:"managementKey"`
	Queue          string `json:"queue"`
	PopSide        string `json:"popSide"`
}

func New(cfg config.Config, store *store.Store, collector *collector.Manager) *Server {
	return &Server{
		cfg:       cfg,
		store:     store,
		collector: collector,
		startedAt: time.Now().UnixMilli(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.withCORS(s.handleHealth))
	mux.HandleFunc("/status", s.withCORS(s.handleStatus))
	mux.HandleFunc("/usage-service/info", s.withCORS(s.handleInfo))
	mux.HandleFunc("/setup", s.withCORS(s.handleSetup))
	mux.HandleFunc("/management.html", s.handlePanel)
	mux.HandleFunc("/", s.handleRoot)
	return mux
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.writeCORS(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v0/management/usage") {
		s.withCORS(s.handleUsage)(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v0/management/") {
		s.withCORS(s.handleProxy)(w, r)
		return
	}
	if r.URL.Path == "/" {
		http.Redirect(w, r, "/management.html", http.StatusTemporaryRedirect)
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "cpa-usage-service"})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service":   "cpa-usage-service",
		"mode":      "embedded",
		"startedAt": s.startedAt,
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !s.authorizeIfConfigured(w, r) {
		return
	}
	events, deadLetters, err := s.store.Counts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	status := s.collector.Status()
	status.DeadLetters = deadLetters
	writeJSON(w, http.StatusOK, map[string]any{
		"service":     "cpa-usage-service",
		"dbPath":      s.cfg.DBPath,
		"events":      events,
		"deadLetters": deadLetters,
		"collector":   status,
	})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req setupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	req.CPAUpstreamURL = normalizeBaseURL(req.CPAUpstreamURL)
	req.ManagementKey = strings.TrimSpace(req.ManagementKey)
	if req.Queue == "" {
		req.Queue = s.cfg.Queue
	}
	if req.PopSide == "" {
		req.PopSide = s.cfg.PopSide
	}
	if req.CPAUpstreamURL == "" || req.ManagementKey == "" {
		writeError(w, http.StatusBadRequest, errors.New("cpaBaseUrl and managementKey are required"))
		return
	}
	if existing, ok, err := s.resolveSetup(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	} else if ok && existing.ManagementKey != "" &&
		!authMatches(r, existing.ManagementKey) &&
		req.ManagementKey != existing.ManagementKey {
		writeError(w, http.StatusUnauthorized, errors.New("invalid management key for existing setup"))
		return
	}
	if err := validateManagementAPI(r.Context(), req.CPAUpstreamURL, req.ManagementKey); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	setup := store.Setup{
		CPAUpstreamURL: req.CPAUpstreamURL,
		ManagementKey:  req.ManagementKey,
		Queue:          req.Queue,
		PopSide:        req.PopSide,
	}
	if err := s.store.SaveSetup(r.Context(), setup); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	s.collector.Start(context.Background(), collector.RuntimeConfig{
		CPAUpstreamURL: setup.CPAUpstreamURL,
		ManagementKey:  setup.ManagementKey,
		Queue:          setup.Queue,
		PopSide:        setup.PopSide,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upstream": setup.CPAUpstreamURL})
}

func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeIfConfigured(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		if strings.HasSuffix(r.URL.Path, "/export") {
			s.handleUsageExport(w, r)
			return
		}
		events, err := s.store.RecentEvents(r.Context(), s.cfg.QueryLimit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, usage.BuildPayload(events))
	case http.MethodPost:
		if strings.HasSuffix(r.URL.Path, "/import") {
			s.handleUsageImport(w, r)
			return
		}
		methodNotAllowed(w)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleUsageExport(w http.ResponseWriter, r *http.Request) {
	data, err := s.store.ExportJSONL(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="usage-events.jsonl"`)
	_, _ = w.Write(data)
}

func (s *Server) handleUsageImport(w http.ResponseWriter, r *http.Request) {
	reader := bufio.NewScanner(r.Body)
	reader.Buffer(make([]byte, 64*1024), 10*1024*1024)
	events := make([]usage.Event, 0)
	failed := 0
	for reader.Scan() {
		line := strings.TrimSpace(reader.Text())
		if line == "" {
			continue
		}
		event, err := usage.NormalizeRaw([]byte(line))
		if err != nil {
			failed++
			continue
		}
		events = append(events, event)
	}
	if err := reader.Err(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	result, err := s.store.InsertEvents(r.Context(), events)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"added":   result.Inserted,
		"skipped": result.Skipped,
		"total":   len(events),
		"failed":  failed,
	})
}

func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		writeError(w, http.StatusPreconditionRequired, errors.New("usage service is not configured"))
		return
	}
	if !authMatches(r, setup.ManagementKey) {
		writeError(w, http.StatusUnauthorized, errors.New("invalid management key"))
		return
	}
	target, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}

func (s *Server) handlePanel(w http.ResponseWriter, r *http.Request) {
	if s.cfg.PanelPath != "" {
		if file, err := os.Open(s.cfg.PanelPath); err == nil {
			defer file.Close()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.Copy(w, file)
			return
		}
	}
	data, err := embeddedPanel.ReadFile("web/management.html")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", mime.TypeByExtension(".html"))
	_, _ = w.Write(data)
}

func (s *Server) resolveSetup(ctx context.Context) (store.Setup, bool, error) {
	if s.cfg.CPAUpstreamURL != "" && s.cfg.ManagementKey != "" {
		return store.Setup{
			CPAUpstreamURL: normalizeBaseURL(s.cfg.CPAUpstreamURL),
			ManagementKey:  s.cfg.ManagementKey,
			Queue:          s.cfg.Queue,
			PopSide:        s.cfg.PopSide,
		}, true, nil
	}
	return s.store.LoadSetup(ctx)
}

func (s *Server) authorizeIfConfigured(w http.ResponseWriter, r *http.Request) bool {
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return false
	}
	if !ok || setup.ManagementKey == "" {
		return true
	}
	if authMatches(r, setup.ManagementKey) {
		return true
	}
	writeError(w, http.StatusUnauthorized, errors.New("invalid management key"))
	return false
}

func authMatches(r *http.Request, managementKey string) bool {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if header == "" || managementKey == "" {
		return false
	}
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return false
	}
	return strings.TrimSpace(header[len(prefix):]) == managementKey
}

func (s *Server) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.writeCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (s *Server) writeCORS(w http.ResponseWriter, r *http.Request) {
	if len(s.cfg.CORSOrigins) == 0 {
		return
	}
	origin := r.Header.Get("Origin")
	allowed := s.cfg.CORSOrigins[0]
	for _, candidate := range s.cfg.CORSOrigins {
		if candidate == "*" || candidate == origin {
			allowed = candidate
			break
		}
	}
	if allowed == "*" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	} else if origin != "" && allowed == origin {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
}

func validateManagementAPI(ctx context.Context, baseURL string, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v0/management/config", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	return errors.New("management API validation failed: " + res.Status)
}

func normalizeBaseURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	value = strings.TrimRight(value, "/")
	value = strings.TrimSuffix(value, "/v0/management")
	value = strings.TrimSuffix(value, "/v0")
	return value
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
}
