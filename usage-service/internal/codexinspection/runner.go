package codexinspection

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type RunnerDeps struct {
	CPAUpstreamURL string
	ManagementKey  string
}

type HTTPRunner struct {
	deps RunnerDeps
}

type authFileItem struct {
	Name       string         `json:"name"`
	Type       string         `json:"type"`
	Provider   string         `json:"provider"`
	AuthIndex  string         `json:"auth_index"`
	Disabled   bool           `json:"disabled"`
	Status     string         `json:"status"`
	State      string         `json:"state"`
	Account    string         `json:"account"`
	Email      string         `json:"email"`
	Label      string         `json:"label"`
	IDToken    map[string]any `json:"id_token"`
}

type authFilesResponse struct {
	Files []authFileItem `json:"files"`
}

type apiCallResponse struct {
	StatusCode int                 `json:"status_code"`
	Header     map[string][]string `json:"header"`
	Body       any                 `json:"body"`
}

type codexUsageWindow struct {
	UsedPercent        *float64 `json:"used_percent"`
	UsedPercentCamel   *float64 `json:"usedPercent"`
	LimitWindowSeconds *float64 `json:"limit_window_seconds"`
	LimitWindowCamel   *float64 `json:"limitWindowSeconds"`
}

type codexRateLimitInfo struct {
	Allowed             *bool             `json:"allowed"`
	LimitReached        *bool             `json:"limit_reached"`
	LimitReachedCamel   *bool             `json:"limitReached"`
	PrimaryWindow       *codexUsageWindow `json:"primary_window"`
	PrimaryWindowCamel  *codexUsageWindow `json:"primaryWindow"`
	SecondaryWindow     *codexUsageWindow `json:"secondary_window"`
	SecondaryWindowCamel *codexUsageWindow `json:"secondaryWindow"`
}

type codexUsagePayload struct {
	RateLimit       *codexRateLimitInfo `json:"rate_limit"`
	RateLimitCamel  *codexRateLimitInfo `json:"rateLimit"`
}

const (
	codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"
	fiveHourSeconds = 18000
	weekSeconds = 604800
)

var quotaBodyPatterns = []string{"quota exhausted", "limit reached", "usage_limit_reached", "payment_required"}

func NewHTTPRunner(deps RunnerDeps) *HTTPRunner { return &HTTPRunner{deps: deps} }

func (r *HTTPRunner) Execute(ctx context.Context, runID string, settings Settings, logf func(LogLevel, string), persist func([]Result, ProgressSnapshot, Summary) error) error {
	files, err := r.fetchAuthFiles(ctx)
	if err != nil { return err }
	accounts := make([]Account, 0, len(files))
	for _, file := range files {
		accounts = append(accounts, toAccount(file))
	}
	probeSet := filterAccounts(accounts, settings.TargetType, NormalizeSelectedAccounts(settings.SelectedAccounts))
	sampled := pickSample(probeSet, settings.SampleSize)
	results := make([]Result, 0, len(sampled))
	resultsMu := sync.Mutex{}
	completed := 0
	inflight := 0
	status := StatusRunning
	startedAt := time.Now().UnixMilli()
	persistSnapshot := func() error {
		resultsMu.Lock()
		cloned := append([]Result(nil), results...)
		completedLocal := completed
		inflightLocal := inflight
		resultsMu.Unlock()
		prog, summary := buildProgress(len(sampled), completedLocal, inflightLocal, status, startedAt, cloned, len(files), len(probeSet), len(sampled))
		summary = buildSummary(len(files), len(probeSet), len(sampled), settings, cloned)
		return persist(cloned, prog, summary)
	}
	logf(LogInfo, fmt.Sprintf("\u52a0\u8f7d\u8ba4\u8bc1\u6587\u4ef6\u5217\u8868\uff0c\u76ee\u6807\u7c7b\u578b\uff1a%s", settings.TargetType))
	logf(LogInfo, fmt.Sprintf("\u5de1\u68c0\u96c6\u5408 %d \u4e2a\u8d26\u53f7\uff0c\u672c\u6b21\u63a2\u6d4b %d \u4e2a\u8d26\u53f7", len(probeSet), len(sampled)))
	if err := persistSnapshot(); err != nil { return err }
	if len(sampled) == 0 {
		status = StatusCompleted
		return persistSnapshot()
	}
	sem := make(chan struct{}, max(1, settings.Workers))
	wg := sync.WaitGroup{}
	errCh := make(chan error, len(sampled))
	for _, account := range sampled {
		select {
		case <-ctx.Done():
			status = StatusStopped
			_ = persistSnapshot()
			return ctx.Err()
		default:
		}
		sem <- struct{}{}
		wg.Add(1)
		resultsMu.Lock(); inflight++; resultsMu.Unlock()
		_ = persistSnapshot()
		go func(account Account) {
			defer func(){ <-sem; wg.Done() }()
			res := r.inspectSingleAccount(ctx, account, settings, logf)
			resultsMu.Lock()
			results = append(results, res)
			completed++
			inflight--
			resultsMu.Unlock()
			if err := persistSnapshot(); err != nil { errCh <- err }
		}(account)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			status = StatusFailed
			_ = persistSnapshot()
			return err
		}
	}
	if ctx.Err() != nil {
		status = StatusStopped
		_ = persistSnapshot()
		return ctx.Err()
	}
	status = StatusCompleted
	return persistSnapshot()
}

func max(a, b int) int { if a > b { return a }; return b }

func pickSample(items []Account, sampleSize int) []Account {
	if sampleSize <= 0 || sampleSize >= len(items) { return append([]Account(nil), items...) }
	return append([]Account(nil), items[:sampleSize]...)
}

func filterAccounts(items []Account, targetType string, selected []string) []Account {
	selectedSet := map[string]struct{}{}
	for _, value := range selected { selectedSet[strings.TrimSpace(value)] = struct{}{} }
	out := make([]Account, 0)
	for _, item := range items {
		if strings.ToLower(strings.TrimSpace(item.Provider)) != strings.ToLower(strings.TrimSpace(targetType)) { continue }
		if len(selectedSet) > 0 {
			if _, ok := selectedSet[item.FileName]; ok { out = append(out, item); continue }
			if item.AuthIndex != "" { if _, ok := selectedSet[item.AuthIndex]; ok { out = append(out, item); continue } }
			if item.DisplayAccount != "" { if _, ok := selectedSet[item.DisplayAccount]; ok { out = append(out, item); continue } }
			continue
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i,j int) bool { return out[i].FileName < out[j].FileName })
	return out
}

func toAccount(file authFileItem) Account {
	display := firstNonEmpty(file.Account, file.Email, file.Label, file.Name, "-")
	accountID := ""
	if file.IDToken != nil {
		accountID = firstNonEmpty(asString(file.IDToken["chatgpt_account_id"]), asString(file.IDToken["chatgptAccountId"]))
	}
	provider := firstNonEmpty(file.Provider, file.Type, "unknown")
	return Account{
		Key: firstNonEmpty(file.Name, display), FileName: file.Name, DisplayAccount: display, AuthIndex: file.AuthIndex,
		AccountID: accountID, Provider: provider, Disabled: file.Disabled, Status: file.Status, State: file.State,
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values { if strings.TrimSpace(v) != "" { return strings.TrimSpace(v) } }
	return ""
}

func asString(v any) string {
	if v == nil { return "" }
	return strings.TrimSpace(fmt.Sprint(v))
}

func (r *HTTPRunner) fetchAuthFiles(ctx context.Context) ([]authFileItem, error) {
	url := strings.TrimRight(r.deps.CPAUpstreamURL, "/") + "/v0/management/auth-files"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil { return nil, err }
	req.Header.Set("Authorization", "Bearer "+r.deps.ManagementKey)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil { return nil, err }
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 { return nil, fmt.Errorf("auth-files request failed: %s", res.Status) }
	var payload authFilesResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil { return nil, err }
	return payload.Files, nil
}

func (r *HTTPRunner) inspectSingleAccount(ctx context.Context, account Account, settings Settings, logf func(LogLevel, string)) Result {
	now := time.Now().UnixMilli()
	if account.AuthIndex == "" {
		logf(LogWarning, fmt.Sprintf("%s \u7f3a\u5c11 auth_index\uff0c\u8df3\u8fc7\u63a2\u6d4b", account.DisplayAccount))
		return Result{Account: account, Action: ActionKeep, ActionReason: "\u7f3a\u5c11 auth_index\uff0c\u4fdd\u7559\u8d26\u53f7", Error: "\u7f3a\u5c11 auth_index", UpdatedAtMS: now}
	}
	headers := map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"Content-Type": "application/json",
		"User-Agent": settings.UserAgent,
	}
	if account.AccountID != "" { headers["Chatgpt-Account-Id"] = account.AccountID }
	payload := map[string]any{"authIndex": account.AuthIndex, "method": "GET", "url": codexUsageURL, "header": headers}
	body, _ := json.Marshal(payload)
	url := strings.TrimRight(r.deps.CPAUpstreamURL, "/") + "/v0/management/api-call"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil { return Result{Account: account, Action: ActionKeep, ActionReason: "\u63a2\u6d4b\u5f02\u5e38\uff0c\u4fdd\u7559\u8d26\u53f7", Error: err.Error(), UpdatedAtMS: now} }
	req.Header.Set("Authorization", "Bearer "+r.deps.ManagementKey)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: time.Duration(max(1, settings.Timeout)) * time.Millisecond}
	res, err := client.Do(req)
	if err != nil {
		logf(LogWarning, fmt.Sprintf("%s \u63a2\u6d4b\u5f02\u5e38\uff0c\u4fdd\u7559\u8d26\u53f7\uff1a%s", account.DisplayAccount, err.Error()))
		return Result{Account: account, Action: ActionKeep, ActionReason: "\u63a2\u6d4b\u5f02\u5e38\uff0c\u4fdd\u7559\u8d26\u53f7", Error: err.Error(), UpdatedAtMS: now}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var call apiCallResponse
	if err := json.Unmarshal(raw, &call); err != nil {
		logf(LogWarning, fmt.Sprintf("%s \u63a2\u6d4b\u5f02\u5e38\uff0c\u4fdd\u7559\u8d26\u53f7\uff1a%s", account.DisplayAccount, err.Error()))
		return Result{Account: account, Action: ActionKeep, ActionReason: "\u63a2\u6d4b\u5f02\u5e38\uff0c\u4fdd\u7559\u8d26\u53f7", Error: err.Error(), UpdatedAtMS: now}
	}
	bodyText, bodyJSON := normalizeBody(call.Body)
	headerJSON, _ := json.Marshal(call.Header)
	payloadParsed := parseCodexUsagePayload(bodyText, call.Body)
	rateLimit := payloadParsed
	usedPercent := deriveUsedPercent(rateLimit)
	quotaReached := isQuota(call.StatusCode, bodyText, rateLimit, settings.UsedPercentThreshold)
	action, reason, isQuotaFlag := resolveDecision(account, call.StatusCode, rateLimit, usedPercent, quotaReached, settings.UsedPercentThreshold)
	level := LogInfo
	if action == ActionDelete { level = LogError } else if action == ActionDisable { level = LogWarning } else if action == ActionEnable { level = LogSuccess }
	percentText := "--"
	if usedPercent != nil { percentText = fmt.Sprintf("%.1f%%", *usedPercent) }
\tlogf(level, fmt.Sprintf("%s -> %s (HTTP %d \u00b7 \u5df2\u7528 %s)", account.DisplayAccount, action, call.StatusCode, percentText))
	return Result{Account: account, Action: action, ActionReason: reason, StatusCode: intPtr(call.StatusCode), UsedPercent: usedPercent, IsQuota: isQuotaFlag, Error: "", ResponseBodyText: bodyText, ResponseBodyJSON: bodyJSON, ResponseHeadersJSON: string(headerJSON), UpdatedAtMS: now}
}

func intPtr(v int) *int { return &v }
func floatPtr(v float64) *float64 { return &v }

func normalizeBody(body any) (string, string) {
	if body == nil { return "", "" }
	if s, ok := body.(string); ok {
		trim := strings.TrimSpace(s)
		if trim == "" { return s, "" }
		if json.Valid([]byte(trim)) { return s, trim }
		return s, ""
	}
	buf, err := json.Marshal(body)
	if err != nil { return fmt.Sprint(body), "" }
	return string(buf), string(buf)
}

func parseCodexUsagePayload(bodyText string, body any) *codexRateLimitInfo {
	var payload codexUsagePayload
	if body != nil {
		if m, ok := body.(map[string]any); ok {
			buf, _ := json.Marshal(m)
			if json.Unmarshal(buf, &payload) == nil {
				if payload.RateLimit != nil { return payload.RateLimit }
				if payload.RateLimitCamel != nil { return payload.RateLimitCamel }
			}
		}
	}
	trim := strings.TrimSpace(bodyText)
	if trim != "" && json.Valid([]byte(trim)) {
		if json.Unmarshal([]byte(trim), &payload) == nil {
			if payload.RateLimit != nil { return payload.RateLimit }
			if payload.RateLimitCamel != nil { return payload.RateLimitCamel }
		}
	}
	return nil
}

func getWindowUsedPercent(window *codexUsageWindow) *float64 {
	if window == nil { return nil }
	if window.UsedPercent != nil { return window.UsedPercent }
	return window.UsedPercentCamel
}

func getWindowSeconds(window *codexUsageWindow) *float64 {
	if window == nil { return nil }
	if window.LimitWindowSeconds != nil { return window.LimitWindowSeconds }
	return window.LimitWindowCamel
}

func getLimitWindows(rateLimit *codexRateLimitInfo) []*codexUsageWindow {
	if rateLimit == nil { return nil }
	out := make([]*codexUsageWindow,0,2)
	if rateLimit.PrimaryWindow != nil { out = append(out, rateLimit.PrimaryWindow) } else if rateLimit.PrimaryWindowCamel != nil { out = append(out, rateLimit.PrimaryWindowCamel) }
	if rateLimit.SecondaryWindow != nil { out = append(out, rateLimit.SecondaryWindow) } else if rateLimit.SecondaryWindowCamel != nil { out = append(out, rateLimit.SecondaryWindowCamel) }
	return out
}

func deriveUsedPercent(rateLimit *codexRateLimitInfo) *float64 {
	maxValue := math.Inf(-1)
	found := false
	for _, window := range getLimitWindows(rateLimit) {
		if v := getWindowUsedPercent(window); v != nil { if *v > maxValue { maxValue = *v }; found = true }
	}
	if !found { return nil }
	return floatPtr(maxValue)
}

func isRateLimitReached(rateLimit *codexRateLimitInfo) bool {
	if rateLimit == nil { return false }
	if rateLimit.Allowed != nil && !*rateLimit.Allowed { return true }
	if rateLimit.LimitReached != nil && *rateLimit.LimitReached { return true }
	if rateLimit.LimitReachedCamel != nil && *rateLimit.LimitReachedCamel { return true }
	for _, window := range getLimitWindows(rateLimit) {
		if v := getWindowUsedPercent(window); v != nil && *v >= 100 { return true }
	}
	return false
}

func isQuota(statusCode int, bodyText string, rateLimit *codexRateLimitInfo, threshold float64) bool {
	lower := strings.ToLower(bodyText)
	if statusCode == 402 { return true }
	for _, pat := range quotaBodyPatterns { if strings.Contains(lower, pat) { return true } }
	if isRateLimitReached(rateLimit) { return true }
	if usedPercent := deriveUsedPercent(rateLimit); usedPercent != nil && *usedPercent >= threshold { return true }
	return false
}

func pickClassifiedWindows(rateLimit *codexRateLimitInfo) (*codexUsageWindow, *codexUsageWindow) {
	var five, weekly *codexUsageWindow
	for _, w := range getLimitWindows(rateLimit) {
		if sec := getWindowSeconds(w); sec != nil {
			if int(*sec) == fiveHourSeconds && five == nil { five = w; continue }
			if int(*sec) == weekSeconds && weekly == nil { weekly = w; continue }
		}
	}
	windows := getLimitWindows(rateLimit)
	if five == nil && len(windows) > 0 && windows[0] != weekly { five = windows[0] }
	if weekly == nil && len(windows) > 1 && windows[1] != five { weekly = windows[1] }
	return five, weekly
}

func resolveDecision(account Account, statusCode int, rateLimit *codexRateLimitInfo, usedPercent *float64, isQuota bool, threshold float64) (Action, string, bool) {
	five, weekly := pickClassifiedWindows(rateLimit)
	if weekly != nil {
		weeklyUsed := getWindowUsedPercent(weekly)
		fiveUsed := getWindowUsedPercent(five)
		if statusCode == 401 { return ActionDelete, "\u63a5\u53e3\u8fd4\u56de 401\uff0c\u5efa\u8bae\u5220\u9664\u5931\u6548\u8d26\u53f7", false }
		if weeklyUsed != nil && *weeklyUsed >= threshold {
			if account.Disabled { return ActionKeep, "\u5468\u989d\u5ea6\u8fbe\u5230\u9608\u503c\uff0c\u4f46\u8d26\u53f7\u5df2\u7981\u7528", true }
			return ActionDisable, "\u5468\u989d\u5ea6\u8fbe\u5230\u9608\u503c\uff0c\u5efa\u8bae\u7981\u7528\u8d26\u53f7", true
		}
		if account.Disabled {
			if fiveUsed != nil && *fiveUsed >= threshold { return ActionEnable, "5 \u5c0f\u65f6\u989d\u5ea6\u8fbe\u5230\u9608\u503c\uff0c\u4f46\u5468\u989d\u5ea6\u4ecd\u53ef\u7528\uff0c\u5efa\u8bae\u7acb\u5373\u542f\u7528\u8d26\u53f7", false }
			return ActionEnable, "\u5468\u989d\u5ea6\u4ecd\u53ef\u7528\uff0c\u5efa\u8bae\u7acb\u5373\u542f\u7528\u8d26\u53f7", false
		}
		if fiveUsed != nil && *fiveUsed >= threshold { return ActionKeep, "5 \u5c0f\u65f6\u989d\u5ea6\u8fbe\u5230\u9608\u503c\uff0c\u4f46\u5468\u989d\u5ea6\u4ecd\u53ef\u7528\uff0c\u6682\u4e0d\u7981\u7528\u8d26\u53f7", false }
		return ActionKeep, "\u5468\u989d\u5ea6\u4ecd\u53ef\u7528\uff0c\u65e0\u9700\u5904\u7406", false
	}
	overThreshold := usedPercent != nil && *usedPercent >= threshold
	if statusCode == 401 { return ActionDelete, "\u63a5\u53e3\u8fd4\u56de 401\uff0c\u5efa\u8bae\u5220\u9664\u5931\u6548\u8d26\u53f7", false }
	if isQuota || overThreshold {
		if account.Disabled {
			if overThreshold { return ActionKeep, "\u989d\u5ea6\u8d85\u9608\u503c\uff0c\u4f46\u8d26\u53f7\u5df2\u7981\u7528", isQuota }
			return ActionKeep, "\u989d\u5ea6\u5df2\u8017\u5c3d\uff0c\u4f46\u8d26\u53f7\u5df2\u7981\u7528", isQuota
		}
		if overThreshold { return ActionDisable, "\u989d\u5ea6\u8d85\u9608\u503c\uff0c\u5efa\u8bae\u7981\u7528\u8d26\u53f7", isQuota }
		return ActionDisable, "\u989d\u5ea6\u5df2\u8017\u5c3d\uff0c\u5efa\u8bae\u7981\u7528\u8d26\u53f7", isQuota
	}
	if statusCode == 200 && account.Disabled { return ActionEnable, "\u8d26\u53f7\u6062\u590d\u5065\u5eb7\uff0c\u5efa\u8bae\u91cd\u65b0\u542f\u7528", false }
	return ActionKeep, "\u65e0\u9700\u5904\u7406", false
}
