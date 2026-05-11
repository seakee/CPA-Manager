package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager/usage-service/internal/collector"
	"github.com/seakee/cpa-manager/usage-service/internal/codexinspection"
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
	codex     *codexinspection.Manager
	startedAt int64
}

const serviceID = "cpa-manager"

const maxUsageImportBytes int64 = 64 * 1024 * 1024

const modelPriceSyncSource = "litellm"

var modelPriceSyncURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

type setupRequest struct {
	CPAUpstreamURL string `json:"cpaBaseUrl"`
	ManagementKey  string `json:"managementKey"`
	Queue          string `json:"queue"`
	PopSide        string `json:"popSide"`
}

type modelPricesRequest struct {
	Prices map[string]store.ModelPrice `json:"prices"`
}

type modelPricesSyncRequest struct {
	Models []string `json:"models"`
}

func New(cfg config.Config, store *store.Store, collector *collector.Manager, codex *codexinspection.Manager) *Server {
	return &Server{
		cfg:       cfg,
		store:     store,
		collector: collector,
		codex:     codex,
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
	if strings.HasPrefix(r.URL.Path, "/v0/management/model-prices") {
		s.withCORS(s.handleModelPrices)(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v0/management/api-key-map") {
		s.withCORS(s.handleAPIKeyMap)(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v0/management/codex-inspection") {
		s.withCORS(s.handleCodexInspection)(w, r)
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
	if isModelListProxyPath(r.URL.Path) {
		s.withCORS(s.handleModelListProxy)(w, r)
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": serviceID})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service":   serviceID,
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
		"service":     serviceID,
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

func (s *Server) handleModelPrices(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeIfConfigured(w, r) {
		return
	}

	path := strings.TrimRight(r.URL.Path, "/")
	switch {
	case path == "/v0/management/model-prices" && r.Method == http.MethodGet:
		prices, err := s.store.LoadModelPrices(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"prices": prices})
	case path == "/v0/management/model-prices" && r.Method == http.MethodPut:
		var req modelPricesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if req.Prices == nil {
			writeError(w, http.StatusBadRequest, errors.New("prices are required"))
			return
		}
		if err := s.store.SaveModelPrices(r.Context(), req.Prices); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		prices, err := s.store.LoadModelPrices(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"prices": prices})
	case path == "/v0/management/model-prices/sync" && r.Method == http.MethodPost:
		var req modelPricesSyncRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		remotePrices, skipped, err := fetchLiteLLMModelPrices(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		selectedPrices := selectModelPrices(remotePrices, req.Models)
		result, err := s.store.UpsertSyncedModelPrices(r.Context(), selectedPrices)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		prices, err := s.store.LoadModelPrices(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"source":   modelPriceSyncSource,
			"imported": result.Imported,
			"skipped":  result.Skipped + skipped,
			"prices":   prices,
		})
	default:
		methodNotAllowed(w)
	}
}

func fetchLiteLLMModelPrices(ctx context.Context) (map[string]store.ModelPrice, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelPriceSyncURL, nil)
	if err != nil {
		return nil, 0, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, 0, errors.New("model price sync failed: " + res.Status)
	}

	var payload map[string]json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, 0, err
	}

	prices := map[string]store.ModelPrice{}
	skipped := 0
	for model, raw := range payload {
		if model == "" || model == "sample_spec" {
			skipped++
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal(raw, &entry); err != nil {
			skipped++
			continue
		}

		prompt, hasPrompt := readFloat(entry, "input_cost_per_token")
		completion, hasCompletion := readFloat(entry, "output_cost_per_token")
		cache, hasCache := readFloat(entry, "cache_read_input_token_cost")
		if !hasCache {
			cache, hasCache = readFloat(entry, "cache_read_cost_per_token")
		}
		if !hasPrompt && !hasCompletion {
			skipped++
			continue
		}
		if !hasPrompt {
			prompt = 0
		}
		if !hasCompletion {
			completion = 0
		}
		if !hasCache {
			cache = prompt
		}

		prices[model] = store.ModelPrice{
			Prompt:        prompt * 1_000_000,
			Completion:    completion * 1_000_000,
			Cache:         cache * 1_000_000,
			Source:        modelPriceSyncSource,
			SourceModelID: model,
			RawJSON:       string(raw),
		}
	}
	return prices, skipped, nil
}

func selectModelPrices(prices map[string]store.ModelPrice, models []string) map[string]store.ModelPrice {
	wanted := make([]string, 0, len(models))
	seen := map[string]struct{}{}
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		wanted = append(wanted, model)
	}
	if len(wanted) == 0 {
		return prices
	}

	selected := map[string]store.ModelPrice{}
	for _, model := range wanted {
		if price, ok := prices[model]; ok {
			selected[model] = price
			continue
		}
		if price, ok := findSuffixModelPrice(prices, model); ok {
			selected[model] = price
		}
	}
	return selected
}

func (s *Server) handleAPIKeyMap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
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
	items, err := fetchAPIKeyMap(r.Context(), setup.CPAUpstreamURL, setup.ManagementKey)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type apiKeyMapItem struct {
	APIKeyHash string `json:"apiKeyHash"`
	APIKeyLabel string `json:"apiKeyLabel"`
	APIKeyMasked string `json:"apiKeyMasked"`
}

func fetchAPIKeyMap(ctx context.Context, baseURL string, key string) ([]apiKeyMapItem, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v0/management/config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errors.New("api key map fetch failed: " + res.Status)
	}
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, err
	}
	raw := payload["api-keys"]
	if raw == nil {
		raw = payload["apiKeys"]
	}
	arr, ok := raw.([]any)
	if !ok {
		return []apiKeyMapItem{}, nil
	}
	items := make([]apiKeyMapItem, 0, len(arr))
	for _, item := range arr {
		value := strings.TrimSpace(toString(item))
		if value == "" {
			continue
		}
		masked := maskAPIKey(value)
		items = append(items, apiKeyMapItem{
			APIKeyHash:   sha256Hex(value),
			APIKeyLabel:  masked,
			APIKeyMasked: masked,
		})
	}
	return items, nil
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(value)))
	return hex.EncodeToString(sum[:])
}

func maskAPIKey(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "-"
	}
	if len(trimmed) <= 4 {
		return strings.Repeat("*", len(trimmed))
	}
	if len(trimmed) <= 10 {
		return trimmed[:2] + "***" + trimmed[len(trimmed)-1:]
	}
	return trimmed[:4] + "..." + trimmed[len(trimmed)-4:]
}

func toString(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func findSuffixModelPrice(prices map[string]store.ModelPrice, model string) (store.ModelPrice, bool) {
	suffix := "/" + model
	var match store.ModelPrice
	matchedKey := ""
	for key, price := range prices {
		if !strings.HasSuffix(key, suffix) {
			continue
		}
		if matchedKey == "" || len(key) < len(matchedKey) {
			matchedKey = key
			match = price
		}
	}
	return match, matchedKey != ""
}

func readFloat(entry map[string]any, key string) (float64, bool) {
	value, ok := entry[key]
	if !ok || value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return typed, true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
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
	body := http.MaxBytesReader(w, r.Body, maxUsageImportBytes)
	data, err := io.ReadAll(body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeError(w, http.StatusRequestEntityTooLarge, err)
			return
		}
		writeError(w, http.StatusBadRequest, err)
		return
	}

	parsed, err := usage.ParseImportPayload(data)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":       err.Error(),
			"format":      parsed.Format,
			"failed":      parsed.Failed,
			"unsupported": parsed.Unsupported,
			"warnings":    parsed.Warnings,
		})
		return
	}

	result, err := s.store.InsertEvents(r.Context(), parsed.Events)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"format":      parsed.Format,
		"added":       result.Inserted,
		"skipped":     result.Skipped,
		"total":       len(parsed.Events),
		"failed":      parsed.Failed,
		"unsupported": parsed.Unsupported,
		"warnings":    parsed.Warnings,
	})
}

func isModelListProxyPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	return cleaned == "/v1/models" || cleaned == "/models"
}

func (s *Server) handleModelListProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		writeError(w, http.StatusPreconditionRequired, errors.New("usage service is not configured"))
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
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
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
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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


type codexInspectionStartRequest struct {
	TargetType           string   `json:"targetType"`
	Workers              int      `json:"workers"`
	DeleteWorkers        int      `json:"deleteWorkers"`
	Timeout              int      `json:"timeout"`
	Retries              int      `json:"retries"`
	UserAgent            string   `json:"userAgent"`
	UsedPercentThreshold float64  `json:"usedPercentThreshold"`
	SampleSize           int      `json:"sampleSize"`
	AutoExecuteActions   bool     `json:"autoExecuteActions"`
	SelectedAccounts     []string `json:"selectedAccounts"`
}

type codexInspectionExecuteRequest struct {
	RunID    string   `json:"runId"`
	Keys     []string `json:"keys"`
	Action   string   `json:"action"`
}

func (s *Server) handleCodexInspection(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeIfConfigured(w, r) {
		return
	}
	if s.codex == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("codex inspection service unavailable"))
		return
	}
	path := strings.TrimRight(r.URL.Path, "/")
	switch {
	case path == "/v0/management/codex-inspection/runs" && r.Method == http.MethodPost:
		var req codexInspectionStartRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		run, err := s.codex.Start(r.Context(), codexinspection.Settings{
			TargetType: req.TargetType,
			Workers: req.Workers,
			DeleteWorkers: req.DeleteWorkers,
			Timeout: req.Timeout,
			Retries: req.Retries,
			UserAgent: req.UserAgent,
			UsedPercentThreshold: req.UsedPercentThreshold,
			SampleSize: req.SampleSize,
			AutoExecuteActions: req.AutoExecuteActions,
			SelectedAccounts: codexinspection.NormalizeSelectedAccounts(req.SelectedAccounts),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"run": run})
	case path == "/v0/management/codex-inspection/runs" && r.Method == http.MethodGet:
		runs, err := s.store.ListCodexInspectionRuns(r.Context(), 100)
		if err != nil { writeError(w, http.StatusInternalServerError, err); return }
		writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
	case path == "/v0/management/codex-inspection/runs/latest" && r.Method == http.MethodGet:
		run, ok, err := s.store.GetLatestCodexInspectionRun(r.Context())
		if err != nil { writeError(w, http.StatusInternalServerError, err); return }
		if !ok { writeJSON(w, http.StatusOK, map[string]any{"run": nil}); return }
		results, _ := s.store.LoadCodexInspectionResults(r.Context(), run.RunID)
		logs, _ := s.store.LoadCodexInspectionLogs(r.Context(), run.RunID, 5000)
		writeJSON(w, http.StatusOK, map[string]any{"run": run, "results": results, "logs": logs})
	case strings.HasPrefix(path, "/v0/management/codex-inspection/runs/") && strings.HasSuffix(path, "/pause") && r.Method == http.MethodPost:
		runID := strings.TrimSuffix(strings.TrimPrefix(path, "/v0/management/codex-inspection/runs/"), "/pause")
		s.codex.Stop(runID)
		now := time.Now().UnixMilli()
		run, ok, err := s.store.GetCodexInspectionRun(r.Context(), runID)
		if err == nil && ok { run.Status = string(codexinspection.StatusPaused); run.UpdatedAtMS = now; _ = s.store.SaveCodexInspectionRun(r.Context(), run) }
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case strings.HasPrefix(path, "/v0/management/codex-inspection/runs/") && strings.HasSuffix(path, "/stop") && r.Method == http.MethodPost:
		runID := strings.TrimSuffix(strings.TrimPrefix(path, "/v0/management/codex-inspection/runs/"), "/stop")
		s.codex.Stop(runID)
		now := time.Now().UnixMilli()
		run, ok, err := s.store.GetCodexInspectionRun(r.Context(), runID)
		if err == nil && ok { run.Status = string(codexinspection.StatusStopped); run.UpdatedAtMS = now; run.FinishedAtMS = &now; _ = s.store.SaveCodexInspectionRun(r.Context(), run) }
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case strings.HasPrefix(path, "/v0/management/codex-inspection/runs/") && r.Method == http.MethodGet:
		runID := strings.TrimPrefix(path, "/v0/management/codex-inspection/runs/")
		run, ok, err := s.store.GetCodexInspectionRun(r.Context(), runID)
		if err != nil { writeError(w, http.StatusInternalServerError, err); return }
		if !ok { writeError(w, http.StatusNotFound, errors.New("run not found")); return }
		results, _ := s.store.LoadCodexInspectionResults(r.Context(), run.RunID)
		logs, _ := s.store.LoadCodexInspectionLogs(r.Context(), run.RunID, 5000)
		writeJSON(w, http.StatusOK, map[string]any{"run": run, "results": results, "logs": logs})
	default:
		methodNotAllowed(w)
	}
}
