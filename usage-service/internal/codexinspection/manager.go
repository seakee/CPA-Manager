package codexinspection

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager/usage-service/internal/store"
)

type LogLevel string

type RunStatus string

type Action string

type ScopeType string

const (
	LogInfo    LogLevel = "info"
	LogSuccess LogLevel = "success"
	LogWarning LogLevel = "warning"
	LogError   LogLevel = "error"

	StatusIdle      RunStatus = "idle"
	StatusRunning   RunStatus = "running"
	StatusPaused    RunStatus = "paused"
	StatusStopped   RunStatus = "stopped"
	StatusCompleted RunStatus = "completed"
	StatusFailed    RunStatus = "failed"

	ActionKeep    Action = "keep"
	ActionDelete  Action = "delete"
	ActionDisable Action = "disable"
	ActionEnable  Action = "enable"

	ScopeAll      ScopeType = "all"
	ScopeSelected ScopeType = "selected"
)

type Settings struct {
	TargetType           string   `json:"targetType"`
	Workers              int      `json:"workers"`
	DeleteWorkers        int      `json:"deleteWorkers"`
	Timeout              int      `json:"timeout"`
	Retries              int      `json:"retries"`
	UserAgent            string   `json:"userAgent"`
	UsedPercentThreshold float64  `json:"usedPercentThreshold"`
	SampleSize           int      `json:"sampleSize"`
	AutoExecuteActions   bool     `json:"autoExecuteActions"`
	SelectedAccounts     []string `json:"selectedAccounts,omitempty"`
}

type ProgressSummary struct {
	TotalFiles    int `json:"totalFiles"`
	ProbeSetCount int `json:"probeSetCount"`
	SampledCount  int `json:"sampledCount"`
	DeleteCount   int `json:"deleteCount"`
	DisableCount  int `json:"disableCount"`
	EnableCount   int `json:"enableCount"`
	KeepCount     int `json:"keepCount"`
}

type ProgressSnapshot struct {
	Total     int             `json:"total"`
	Completed int             `json:"completed"`
	InFlight  int             `json:"inFlight"`
	Pending   int             `json:"pending"`
	Percent   int             `json:"percent"`
	Status    RunStatus       `json:"status"`
	Summary   ProgressSummary `json:"summary"`
	StartedAt int64           `json:"startedAt"`
	UpdatedAt int64           `json:"updatedAt"`
}

type Account struct {
	Key            string `json:"key"`
	FileName       string `json:"fileName"`
	DisplayAccount string `json:"displayAccount"`
	AuthIndex      string `json:"authIndex,omitempty"`
	AccountID      string `json:"accountId,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Disabled       bool   `json:"disabled"`
	Status         string `json:"status,omitempty"`
	State          string `json:"state,omitempty"`
}

type Result struct {
	Account
	Action              Action   `json:"action"`
	ActionReason        string   `json:"actionReason,omitempty"`
	StatusCode          *int     `json:"statusCode,omitempty"`
	UsedPercent         *float64 `json:"usedPercent,omitempty"`
	IsQuota             bool     `json:"isQuota"`
	Error               string   `json:"error,omitempty"`
	ResponseBodyText    string   `json:"responseBodyText,omitempty"`
	ResponseBodyJSON    string   `json:"responseBodyJson,omitempty"`
	ResponseHeadersJSON string   `json:"responseHeadersJson,omitempty"`
	UpdatedAtMS         int64    `json:"updatedAtMs"`
}

type Summary struct {
	TotalFiles           int      `json:"totalFiles"`
	ProbeSetCount        int      `json:"probeSetCount"`
	SampledCount         int      `json:"sampledCount"`
	DisabledCount        int      `json:"disabledCount"`
	EnabledCount         int      `json:"enabledCount"`
	DeleteCount          int      `json:"deleteCount"`
	DisableCount         int      `json:"disableCount"`
	EnableCount          int      `json:"enableCount"`
	KeepCount            int      `json:"keepCount"`
	UsedPercentThreshold float64  `json:"usedPercentThreshold"`
	Sampled              bool     `json:"sampled"`
	PlannedActionPreview []string `json:"plannedActionPreview"`
}

type RunView struct {
	Run      store.CodexInspectionRun       `json:"run"`
	Progress ProgressSnapshot               `json:"progress"`
	Summary  Summary                        `json:"summary"`
	Results  []store.CodexInspectionResultRow `json:"results,omitempty"`
	Logs     []store.CodexInspectionLogRow  `json:"logs,omitempty"`
}

type Runner interface {
	Execute(ctx context.Context, runID string, settings Settings, logf func(LogLevel, string), persist func([]Result, ProgressSnapshot, Summary) error) error
}

type job struct {
	cancel context.CancelFunc
	mu     sync.RWMutex
	status RunStatus
}

type Manager struct {
	store   *store.Store
	runner  Runner
	mu      sync.RWMutex
	writeMu sync.Mutex
	jobs    map[string]*job
}

func NewManager(db *store.Store, runner Runner) *Manager {
	return &Manager{store: db, runner: runner, jobs: map[string]*job{}}
}

func BuildRunName(ts time.Time) string {
	return ts.Format("200601021504")
}

func BuildRunID(ts time.Time) string {
	return ts.Format("20060102150405")
}

func buildSummary(totalFiles, probeSetCount, sampledCount int, settings Settings, results []Result) Summary {
	deleteCount := 0
	disableCount := 0
	enableCount := 0
	keepCount := 0
	disabledCount := 0
	enabledCount := 0
	preview := make([]string, 0)
	for _, item := range results {
		if item.Disabled { disabledCount++ } else { enabledCount++ }
		switch item.Action {
		case ActionDelete:
			deleteCount++
		case ActionDisable:
			disableCount++
		case ActionEnable:
			enableCount++
		default:
			keepCount++
		}
		if item.Action != ActionKeep && len(preview) < 10 {
			preview = append(preview, fmt.Sprintf("%s -> %s", item.DisplayAccount, item.Action))
		}
	}
	return Summary{
		TotalFiles: totalFiles, ProbeSetCount: probeSetCount, SampledCount: sampledCount,
		DisabledCount: disabledCount, EnabledCount: enabledCount,
		DeleteCount: deleteCount, DisableCount: disableCount, EnableCount: enableCount, KeepCount: keepCount,
		UsedPercentThreshold: settings.UsedPercentThreshold,
		Sampled: settings.SampleSize > 0 && settings.SampleSize < probeSetCount,
		PlannedActionPreview: preview,
	}
}

func buildProgress(total, completed, inflight int, status RunStatus, startedAt int64, results []Result, totalFiles, probeSetCount, sampledCount int) (ProgressSnapshot, Summary) {
	now := time.Now().UnixMilli()
	pending := total - completed - inflight
	if pending < 0 { pending = 0 }
	percent := 0
	if total > 0 { percent = int(float64(completed) / float64(total) * 100) }
	summary := buildSummary(totalFiles, probeSetCount, sampledCount, Settings{}, results)
	summary.TotalFiles = totalFiles
	summary.ProbeSetCount = probeSetCount
	summary.SampledCount = sampledCount
	return ProgressSnapshot{
		Total: total, Completed: completed, InFlight: inflight, Pending: pending,
		Percent: percent, Status: status,
		Summary: ProgressSummary{
			TotalFiles: summary.TotalFiles,
			ProbeSetCount: summary.ProbeSetCount,
			SampledCount: summary.SampledCount,
			DeleteCount: summary.DeleteCount,
			DisableCount: summary.DisableCount,
			EnableCount: summary.EnableCount,
			KeepCount: summary.KeepCount,
		},
		StartedAt: startedAt,
		UpdatedAt: now,
	}, summary
}

func (m *Manager) SaveLog(ctx context.Context, runID string, level LogLevel, message string) error {
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	return m.store.AddCodexInspectionLog(ctx, store.CodexInspectionLogRow{RunID: runID, Level: string(level), Message: message, CreatedAtMS: time.Now().UnixMilli()})
}

func toStoreRows(runID string, results []Result) []store.CodexInspectionResultRow {
	rows := make([]store.CodexInspectionResultRow, 0, len(results))
	for _, item := range results {
		rows = append(rows, store.CodexInspectionResultRow{
			RunID: runID, AccountKey: item.Key, FileName: item.FileName, DisplayAccount: item.DisplayAccount,
			AuthIndex: item.AuthIndex, AccountID: item.AccountID, Provider: item.Provider, Disabled: item.Disabled,
			Status: item.Status, State: item.State, Action: string(item.Action), ActionReason: item.ActionReason,
			StatusCode: item.StatusCode, UsedPercent: item.UsedPercent, IsQuota: item.IsQuota, Error: item.Error,
			ResponseBodyText: item.ResponseBodyText, ResponseBodyJSON: item.ResponseBodyJSON, ResponseHeadersJSON: item.ResponseHeadersJSON,
			UpdatedAtMS: item.UpdatedAtMS,
		})
		}
	return rows
}

func (m *Manager) Start(ctx context.Context, settings Settings) (store.CodexInspectionRun, error) {
	now := time.Now()
	runID := BuildRunID(now)
	runName := BuildRunName(now)
	selectedTargetsJSON := ""
	if len(settings.SelectedAccounts) > 0 {
		buf, _ := json.Marshal(settings.SelectedAccounts)
		selectedTargetsJSON = string(buf)
	}
	run := store.CodexInspectionRun{
		RunID: runID, RunName: runName, Status: string(StatusRunning), TargetType: settings.TargetType,
		Workers: settings.Workers, DeleteWorkers: settings.DeleteWorkers, Timeout: settings.Timeout, Retries: settings.Retries,
		UserAgent: settings.UserAgent, UsedPercentThreshold: settings.UsedPercentThreshold, SampleSize: settings.SampleSize,
		AutoExecuteActions: settings.AutoExecuteActions,
		TargetScopeType: func() string { if len(settings.SelectedAccounts) > 0 { return string(ScopeSelected) }; return string(ScopeAll) }(),
		SelectedTargetsJSON: selectedTargetsJSON, SummaryJSON: "", StartedAtMS: now.UnixMilli(), UpdatedAtMS: now.UnixMilli(),
	}
	if err := m.store.SaveCodexInspectionRun(ctx, run); err != nil { return store.CodexInspectionRun{}, err }
	jobCtx, cancel := context.WithCancel(context.Background())
	j := &job{cancel: cancel, status: StatusRunning}
	m.mu.Lock(); m.jobs[runID] = j; m.mu.Unlock()
	go m.run(jobCtx, run, settings)
	return run, nil
}

func (m *Manager) run(ctx context.Context, run store.CodexInspectionRun, settings Settings) {
	results := make([]Result, 0)
	lastPersistAt := int64(0)
	persist := func(items []Result, progress ProgressSnapshot, summary Summary) error {
		if progress.Status == StatusRunning && progress.Completed < progress.Total && lastPersistAt > 0 && progress.UpdatedAt-lastPersistAt < 500 {
			return nil
		}
		m.writeMu.Lock()
		defer m.writeMu.Unlock()
		rows := toStoreRows(run.RunID, items)
		if err := m.store.SaveCodexInspectionResults(context.Background(), rows); err != nil { return err }
		summaryJSON, _ := json.Marshal(summary)
		progressJSON, _ := json.Marshal(progress)
		run.SummaryJSON = string(summaryJSON)
		run.ProgressJSON = string(progressJSON)
		run.UpdatedAtMS = progress.UpdatedAt
		run.Status = string(progress.Status)
		if progress.Status == StatusCompleted || progress.Status == StatusStopped || progress.Status == StatusFailed {
			finished := progress.UpdatedAt
			run.FinishedAtMS = &finished
		}
		if err := m.store.SaveCodexInspectionRun(context.Background(), run); err != nil { return err }
		lastPersistAt = progress.UpdatedAt
		return nil
	}
	logf := func(level LogLevel, msg string) {
		_ = m.SaveLog(context.Background(), run.RunID, level, msg)
	}
	err := m.runner.Execute(ctx, run.RunID, settings, logf, func(next []Result, progress ProgressSnapshot, summary Summary) error {
		results = append(results[:0], next...)
		return persist(results, progress, summary)
	})
	m.mu.Lock()
	delete(m.jobs, run.RunID)
	m.mu.Unlock()
	if err != nil {
		_ = m.SaveLog(context.Background(), run.RunID, LogError, err.Error())
		run.Status = string(StatusFailed)
		now := time.Now().UnixMilli()
		run.UpdatedAtMS = now
		run.FinishedAtMS = &now
		m.writeMu.Lock()
		_ = m.store.SaveCodexInspectionRun(context.Background(), run)
		m.writeMu.Unlock()
	}
}

func (m *Manager) Stop(runID string) {
	m.mu.RLock(); j := m.jobs[runID]; m.mu.RUnlock()
	if j != nil { j.cancel() }
}

func (m *Manager) IsRunning(runID string) bool {
	m.mu.RLock(); defer m.mu.RUnlock()
	_, ok := m.jobs[runID]
	return ok
}

func NormalizeSelectedAccounts(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" { continue }
		if _, ok := seen[v]; ok { continue }
		seen[v] = struct{}{}
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
