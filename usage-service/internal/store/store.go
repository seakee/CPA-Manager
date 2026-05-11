package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/seakee/cpa-manager/usage-service/internal/usage"
)

type Setup struct {
	CPAUpstreamURL string `json:"cpaBaseUrl"`
	ManagementKey  string `json:"managementKey,omitempty"`
	Queue          string `json:"queue,omitempty"`
	PopSide        string `json:"popSide,omitempty"`
}

type InsertResult struct {
	Inserted int `json:"inserted"`
	Skipped  int `json:"skipped"`
}

type ModelPrice struct {
	Prompt        float64 `json:"prompt"`
	Completion    float64 `json:"completion"`
	Cache         float64 `json:"cache"`
	Source        string  `json:"source,omitempty"`
	SourceModelID string  `json:"sourceModelId,omitempty"`
	RawJSON       string  `json:"rawJson,omitempty"`
	UpdatedAtMS   int64   `json:"updatedAtMs,omitempty"`
	SyncedAtMS    *int64  `json:"syncedAtMs,omitempty"`
}

type ModelPriceSyncResult struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
}

type CodexInspectionRun struct {
	RunID                string `json:"runId"`
	RunName              string `json:"runName"`
	Status               string `json:"status"`
	TargetType           string `json:"targetType"`
	Workers              int    `json:"workers"`
	DeleteWorkers        int    `json:"deleteWorkers"`
	Timeout              int    `json:"timeout"`
	Retries              int    `json:"retries"`
	UserAgent            string `json:"userAgent"`
	UsedPercentThreshold float64 `json:"usedPercentThreshold"`
	SampleSize           int    `json:"sampleSize"`
	AutoExecuteActions   bool   `json:"autoExecuteActions"`
	TargetScopeType      string `json:"targetScopeType"`
	SelectedTargetsJSON  string `json:"selectedTargetsJson,omitempty"`
	SummaryJSON          string `json:"summaryJson,omitempty"`
	ProgressJSON         string `json:"progressJson,omitempty"`
	StartedAtMS          int64  `json:"startedAtMs"`
	UpdatedAtMS          int64  `json:"updatedAtMs"`
	FinishedAtMS         *int64 `json:"finishedAtMs,omitempty"`
}

type CodexInspectionResultRow struct {
	RunID              string `json:"runId"`
	AccountKey         string `json:"accountKey"`
	FileName           string `json:"fileName"`
	DisplayAccount     string `json:"displayAccount"`
	AuthIndex          string `json:"authIndex,omitempty"`
	AccountID          string `json:"accountId,omitempty"`
	Provider           string `json:"provider,omitempty"`
	Disabled           bool   `json:"disabled"`
	Status             string `json:"status,omitempty"`
	State              string `json:"state,omitempty"`
	Action             string `json:"action"`
	ActionReason       string `json:"actionReason,omitempty"`
	StatusCode         *int   `json:"statusCode,omitempty"`
	UsedPercent        *float64 `json:"usedPercent,omitempty"`
	IsQuota            bool   `json:"isQuota"`
	Error              string `json:"error,omitempty"`
	ResponseBodyText   string `json:"responseBodyText,omitempty"`
	ResponseBodyJSON   string `json:"responseBodyJson,omitempty"`
	ResponseHeadersJSON string `json:"responseHeadersJson,omitempty"`
	UpdatedAtMS        int64  `json:"updatedAtMs"`
}

type CodexInspectionLogRow struct {
	ID          int64  `json:"id"`
	RunID       string `json:"runId"`
	Level       string `json:"level"`
	Message     string `json:"message"`
	CreatedAtMS int64  `json:"createdAtMs"`
}

type CodexInspectionActionSelection struct {
	RunID         string `json:"runId"`
	AccountKey    string `json:"accountKey"`
	Selected      bool   `json:"selected"`
	PlannedAction string `json:"plannedAction"`
	Executed      bool   `json:"executed"`
	Success       bool   `json:"success"`
	Error         string `json:"error,omitempty"`
	UpdatedAtMS   int64  `json:"updatedAtMs"`
}

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	store := &Store{db: db}
	if err := store.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) init() error {
	statements := []string{
		`pragma journal_mode = WAL`,
		`pragma synchronous = FULL`,
		`pragma busy_timeout = 5000`,
		`pragma foreign_keys = ON`,
		`create table if not exists usage_events (
			id integer primary key autoincrement,
			request_id text,
			event_hash text not null unique,
			timestamp_ms integer not null,
			timestamp text not null,
			provider text,
			model text not null,
			endpoint text,
			method text,
			path text,
			auth_type text,
			auth_index text,
			source text,
			source_hash text,
			api_key_hash text,
			input_tokens integer not null default 0,
			output_tokens integer not null default 0,
			reasoning_tokens integer not null default 0,
			cached_tokens integer not null default 0,
			cache_tokens integer not null default 0,
			total_tokens integer not null default 0,
			latency_ms integer,
			failed integer not null default 0,
			raw_json text,
			created_at_ms integer not null
		)`,
		`create index if not exists idx_usage_events_timestamp on usage_events(timestamp_ms)`,
		`create index if not exists idx_usage_events_request_id on usage_events(request_id)`,
		`create index if not exists idx_usage_events_model on usage_events(model)`,
		`create index if not exists idx_usage_events_auth_index on usage_events(auth_index)`,
		`create index if not exists idx_usage_events_endpoint on usage_events(endpoint)`,
		`create table if not exists dead_letter_events (
			id integer primary key autoincrement,
			payload text not null,
			error text not null,
			created_at_ms integer not null
		)`,
		`create table if not exists settings (
			key text primary key,
			value text not null,
			updated_at_ms integer not null
		)`,
		`create table if not exists model_prices (
			model text primary key,
			prompt_per_1m real not null,
			completion_per_1m real not null,
			cache_per_1m real not null,
			source text,
			source_model_id text,
			raw_json text,
			updated_at_ms integer not null,
			synced_at_ms integer
		)`,
		`create table if not exists codex_inspection_runs (
			run_id text primary key,
			run_name text not null,
			status text not null,
			target_type text not null,
			workers integer not null,
			delete_workers integer not null,
			timeout integer not null,
			retries integer not null,
			user_agent text not null,
			used_percent_threshold real not null,
			sample_size integer not null,
			auto_execute_actions integer not null default 0,
			target_scope_type text not null,
			selected_targets_json text,
			summary_json text,
			progress_json text,
			started_at_ms integer not null,
			updated_at_ms integer not null,
			finished_at_ms integer
		)`,
		`create index if not exists idx_codex_inspection_runs_started on codex_inspection_runs(started_at_ms desc)`,
		`create table if not exists codex_inspection_results (
			run_id text not null,
			account_key text not null,
			file_name text not null,
			display_account text not null,
			auth_index text,
			account_id text,
			provider text,
			disabled integer not null default 0,
			status text,
			state text,
			action text not null,
			action_reason text,
			status_code integer,
			used_percent real,
			is_quota integer not null default 0,
			error text,
			response_body_text text,
			response_body_json text,
			response_headers_json text,
			updated_at_ms integer not null,
			primary key (run_id, account_key)
		)`,
		`create index if not exists idx_codex_inspection_results_run on codex_inspection_results(run_id)`,
		`create table if not exists codex_inspection_logs (
			id integer primary key autoincrement,
			run_id text not null,
			level text not null,
			message text not null,
			created_at_ms integer not null
		)`,
		`create index if not exists idx_codex_inspection_logs_run on codex_inspection_logs(run_id, id)`,
		`create table if not exists codex_inspection_action_selections (
			run_id text not null,
			account_key text not null,
			selected integer not null default 0,
			planned_action text not null,
			executed integer not null default 0,
			success integer not null default 0,
			error text,
			updated_at_ms integer not null,
			primary key (run_id, account_key)
		)`,
		`create index if not exists idx_codex_inspection_actions_run on codex_inspection_action_selections(run_id)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) SaveSetup(ctx context.Context, setup Setup) error {
	if setup.CPAUpstreamURL == "" || setup.ManagementKey == "" {
		return errors.New("cpaBaseUrl and managementKey are required")
	}
	data, err := json.Marshal(setup)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(
		ctx,
		`insert into settings(key, value, updated_at_ms)
		 values('setup', ?, ?)
		 on conflict(key) do update set value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
		string(data),
		time.Now().UnixMilli(),
	)
	return err
}

func (s *Store) LoadSetup(ctx context.Context) (Setup, bool, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `select value from settings where key = 'setup'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Setup{}, false, nil
	}
	if err != nil {
		return Setup{}, false, err
	}
	var setup Setup
	if err := json.Unmarshal([]byte(raw), &setup); err != nil {
		return Setup{}, false, err
	}
	return setup, true, nil
}

func (s *Store) LoadModelPrices(ctx context.Context) (map[string]ModelPrice, error) {
	rows, err := s.db.QueryContext(ctx, `select
		model, prompt_per_1m, completion_per_1m, cache_per_1m, source, source_model_id, raw_json,
		updated_at_ms, synced_at_ms
		from model_prices order by model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	prices := map[string]ModelPrice{}
	for rows.Next() {
		var model string
		var price ModelPrice
		var source, sourceModelID, rawJSON sql.NullString
		var syncedAt sql.NullInt64
		if err := rows.Scan(
			&model,
			&price.Prompt,
			&price.Completion,
			&price.Cache,
			&source,
			&sourceModelID,
			&rawJSON,
			&price.UpdatedAtMS,
			&syncedAt,
		); err != nil {
			return nil, err
		}
		price.Source = source.String
		price.SourceModelID = sourceModelID.String
		price.RawJSON = rawJSON.String
		if syncedAt.Valid {
			value := syncedAt.Int64
			price.SyncedAtMS = &value
		}
		prices[model] = price
	}
	return prices, rows.Err()
}

func (s *Store) SaveModelPrices(ctx context.Context, prices map[string]ModelPrice) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if _, err := tx.ExecContext(ctx, `delete from model_prices`); err != nil {
		return err
	}
	if len(prices) == 0 {
		return tx.Commit()
	}

	stmt, err := tx.PrepareContext(ctx, `insert into model_prices (
		model, prompt_per_1m, completion_per_1m, cache_per_1m, source, source_model_id,
		raw_json, updated_at_ms, synced_at_ms
	) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	now := time.Now().UnixMilli()
	for model, price := range prices {
		if err := validateModelPrice(model, price); err != nil {
			return err
		}
		if _, err := stmt.ExecContext(
			ctx,
			model,
			price.Prompt,
			price.Completion,
			price.Cache,
			nullString(price.Source),
			nullString(price.SourceModelID),
			nullString(price.RawJSON),
			now,
			nullInt(price.SyncedAtMS),
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) UpsertSyncedModelPrices(ctx context.Context, prices map[string]ModelPrice) (ModelPriceSyncResult, error) {
	if len(prices) == 0 {
		return ModelPriceSyncResult{}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ModelPriceSyncResult{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	stmt, err := tx.PrepareContext(ctx, `insert into model_prices (
		model, prompt_per_1m, completion_per_1m, cache_per_1m, source, source_model_id,
		raw_json, updated_at_ms, synced_at_ms
	) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
	on conflict(model) do update set
		prompt_per_1m = excluded.prompt_per_1m,
		completion_per_1m = excluded.completion_per_1m,
		cache_per_1m = excluded.cache_per_1m,
		source = excluded.source,
		source_model_id = excluded.source_model_id,
		raw_json = excluded.raw_json,
		updated_at_ms = excluded.updated_at_ms,
		synced_at_ms = excluded.synced_at_ms`)
	if err != nil {
		return ModelPriceSyncResult{}, err
	}
	defer stmt.Close()

	now := time.Now().UnixMilli()
	result := ModelPriceSyncResult{}
	for model, price := range prices {
		if err := validateModelPrice(model, price); err != nil {
			result.Skipped++
			continue
		}
		if price.Source == "" {
			price.Source = "sync"
		}
		if price.SourceModelID == "" {
			price.SourceModelID = model
		}
		price.UpdatedAtMS = now
		price.SyncedAtMS = &now
		if _, err := stmt.ExecContext(
			ctx,
			model,
			price.Prompt,
			price.Completion,
			price.Cache,
			nullString(price.Source),
			nullString(price.SourceModelID),
			nullString(price.RawJSON),
			now,
			now,
		); err != nil {
			return ModelPriceSyncResult{}, err
		}
		result.Imported++
	}
	if err := tx.Commit(); err != nil {
		return ModelPriceSyncResult{}, err
	}
	return result, nil
}

func validateModelPrice(model string, price ModelPrice) error {
	if model == "" {
		return errors.New("model is required")
	}
	if !validPriceValue(price.Prompt) || !validPriceValue(price.Completion) || !validPriceValue(price.Cache) {
		return fmt.Errorf("invalid model price for %s", model)
	}
	return nil
}

func validPriceValue(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func (s *Store) InsertEvents(ctx context.Context, events []usage.Event) (InsertResult, error) {
	if len(events) == 0 {
		return InsertResult{}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InsertResult{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	stmt, err := tx.PrepareContext(ctx, `insert or ignore into usage_events (
		request_id, event_hash, timestamp_ms, timestamp, provider, model, endpoint, method, path,
		auth_type, auth_index, source, source_hash, api_key_hash,
		input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_tokens, total_tokens,
		latency_ms, failed, raw_json, created_at_ms
	) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return InsertResult{}, err
	}
	defer stmt.Close()

	result := InsertResult{}
	for _, event := range events {
		failed := 0
		if event.Failed {
			failed = 1
		}
		res, err := stmt.ExecContext(
			ctx,
			nullString(event.RequestID),
			event.EventHash,
			event.TimestampMS,
			event.Timestamp,
			nullString(event.Provider),
			event.Model,
			nullString(event.Endpoint),
			nullString(event.Method),
			nullString(event.Path),
			nullString(event.AuthType),
			nullString(event.AuthIndex),
			nullString(event.Source),
			nullString(event.SourceHash),
			nullString(event.APIKeyHash),
			event.InputTokens,
			event.OutputTokens,
			event.ReasoningTokens,
			event.CachedTokens,
			event.CacheTokens,
			event.TotalTokens,
			nullInt(event.LatencyMS),
			failed,
			nullString(event.RawJSON),
			event.CreatedAtMS,
		)
		if err != nil {
			return InsertResult{}, err
		}
		affected, _ := res.RowsAffected()
		if affected > 0 {
			result.Inserted++
		} else {
			result.Skipped++
		}
	}
	if err := tx.Commit(); err != nil {
		return InsertResult{}, err
	}
	return result, nil
}

func (s *Store) AddDeadLetter(ctx context.Context, payload string, parseErr error) error {
	_, err := s.db.ExecContext(
		ctx,
		`insert into dead_letter_events(payload, error, created_at_ms) values(?, ?, ?)`,
		payload,
		parseErr.Error(),
		time.Now().UnixMilli(),
	)
	return err
}

func (s *Store) RecentEvents(ctx context.Context, limit int) ([]usage.Event, error) {
	if limit <= 0 {
		limit = 50000
	}
	rows, err := s.db.QueryContext(ctx, `select
		request_id, event_hash, timestamp_ms, timestamp, provider, model, endpoint, method, path,
		auth_type, auth_index, source, source_hash, api_key_hash,
		input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_tokens, total_tokens,
		latency_ms, failed, raw_json, created_at_ms
		from usage_events
		order by timestamp_ms desc, id desc
		limit ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := make([]usage.Event, 0)
	for rows.Next() {
		var event usage.Event
		var requestID, provider, endpoint, method, path, authType, authIndex, source, sourceHash, apiKeyHash, rawJSON sql.NullString
		var latency sql.NullInt64
		var failed int
		if err := rows.Scan(
			&requestID,
			&event.EventHash,
			&event.TimestampMS,
			&event.Timestamp,
			&provider,
			&event.Model,
			&endpoint,
			&method,
			&path,
			&authType,
			&authIndex,
			&source,
			&sourceHash,
			&apiKeyHash,
			&event.InputTokens,
			&event.OutputTokens,
			&event.ReasoningTokens,
			&event.CachedTokens,
			&event.CacheTokens,
			&event.TotalTokens,
			&latency,
			&failed,
			&rawJSON,
			&event.CreatedAtMS,
		); err != nil {
			return nil, err
		}
		event.RequestID = requestID.String
		event.Provider = provider.String
		event.Endpoint = endpoint.String
		event.Method = method.String
		event.Path = path.String
		event.AuthType = authType.String
		event.AuthIndex = authIndex.String
		event.Source = source.String
		event.SourceHash = sourceHash.String
		event.APIKeyHash = apiKeyHash.String
		event.RawJSON = rawJSON.String
		event.Failed = failed != 0
		if latency.Valid {
			value := latency.Int64
			event.LatencyMS = &value
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) Counts(ctx context.Context) (events int64, deadLetters int64, err error) {
	if err = s.db.QueryRowContext(ctx, `select count(*) from usage_events`).Scan(&events); err != nil {
		return 0, 0, err
	}
	if err = s.db.QueryRowContext(ctx, `select count(*) from dead_letter_events`).Scan(&deadLetters); err != nil {
		return 0, 0, err
	}
	return events, deadLetters, nil
}

func (s *Store) ExportJSONL(ctx context.Context) ([]byte, error) {
	events, err := s.RecentEvents(ctx, 0)
	if err != nil {
		return nil, err
	}
	output := make([]byte, 0)
	for i := len(events) - 1; i >= 0; i-- {
		line, err := json.Marshal(events[i])
		if err != nil {
			return nil, err
		}
		output = append(output, line...)
		output = append(output, '\n')
	}
	return output, nil
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullInt(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func (s Setup) String() string {
	return fmt.Sprintf("upstream=%s queue=%s popSide=%s", s.CPAUpstreamURL, s.Queue, s.PopSide)
}


func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullIntValue(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullFloat64Value(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func (s *Store) SaveCodexInspectionRun(ctx context.Context, run CodexInspectionRun) error {
	_, err := s.db.ExecContext(ctx, `insert into codex_inspection_runs(
		run_id, run_name, status, target_type, workers, delete_workers, timeout, retries, user_agent,
		used_percent_threshold, sample_size, auto_execute_actions, target_scope_type, selected_targets_json,
		summary_json, progress_json, started_at_ms, updated_at_ms, finished_at_ms
	) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	on conflict(run_id) do update set
		run_name=excluded.run_name,
		status=excluded.status,
		target_type=excluded.target_type,
		workers=excluded.workers,
		delete_workers=excluded.delete_workers,
		timeout=excluded.timeout,
		retries=excluded.retries,
		user_agent=excluded.user_agent,
		used_percent_threshold=excluded.used_percent_threshold,
		sample_size=excluded.sample_size,
		auto_execute_actions=excluded.auto_execute_actions,
		target_scope_type=excluded.target_scope_type,
		selected_targets_json=excluded.selected_targets_json,
		summary_json=excluded.summary_json,
		progress_json=excluded.progress_json,
		started_at_ms=excluded.started_at_ms,
		updated_at_ms=excluded.updated_at_ms,
		finished_at_ms=excluded.finished_at_ms`,
		run.RunID, run.RunName, run.Status, run.TargetType, run.Workers, run.DeleteWorkers, run.Timeout, run.Retries, run.UserAgent,
		run.UsedPercentThreshold, run.SampleSize, boolToInt(run.AutoExecuteActions), run.TargetScopeType, nullString(run.SelectedTargetsJSON),
		nullString(run.SummaryJSON), nullString(run.ProgressJSON), run.StartedAtMS, run.UpdatedAtMS, nullInt(run.FinishedAtMS))
	return err
}

func (s *Store) SaveCodexInspectionResults(ctx context.Context, items []CodexInspectionResultRow) error {
	if len(items) == 0 { return nil }
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil { return err }
	defer func(){ _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx, `insert into codex_inspection_results(
		run_id, account_key, file_name, display_account, auth_index, account_id, provider, disabled, status, state,
		action, action_reason, status_code, used_percent, is_quota, error, response_body_text, response_body_json,
		response_headers_json, updated_at_ms
	) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	on conflict(run_id, account_key) do update set
		file_name=excluded.file_name,
		display_account=excluded.display_account,
		auth_index=excluded.auth_index,
		account_id=excluded.account_id,
		provider=excluded.provider,
		disabled=excluded.disabled,
		status=excluded.status,
		state=excluded.state,
		action=excluded.action,
		action_reason=excluded.action_reason,
		status_code=excluded.status_code,
		used_percent=excluded.used_percent,
		is_quota=excluded.is_quota,
		error=excluded.error,
		response_body_text=excluded.response_body_text,
		response_body_json=excluded.response_body_json,
		response_headers_json=excluded.response_headers_json,
		updated_at_ms=excluded.updated_at_ms`)
	if err != nil { return err }
	defer stmt.Close()
	for _, item := range items {
		_, err = stmt.ExecContext(ctx,
			item.RunID, item.AccountKey, item.FileName, item.DisplayAccount, nullString(item.AuthIndex), nullString(item.AccountID), nullString(item.Provider),
			boolToInt(item.Disabled), nullString(item.Status), nullString(item.State), item.Action, nullString(item.ActionReason),
			nullIntValue(item.StatusCode), nullFloat64Value(item.UsedPercent), boolToInt(item.IsQuota), nullString(item.Error),
			nullString(item.ResponseBodyText), nullString(item.ResponseBodyJSON), nullString(item.ResponseHeadersJSON), item.UpdatedAtMS)
		if err != nil { return err }
	}
	return tx.Commit()
}

func (s *Store) AddCodexInspectionLog(ctx context.Context, row CodexInspectionLogRow) error {
	_, err := s.db.ExecContext(ctx, `insert into codex_inspection_logs(run_id, level, message, created_at_ms) values(?, ?, ?, ?)`, row.RunID, row.Level, row.Message, row.CreatedAtMS)
	return err
}

func (s *Store) ReplaceCodexInspectionActionSelections(ctx context.Context, runID string, items []CodexInspectionActionSelection) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil { return err }
	defer func(){ _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `delete from codex_inspection_action_selections where run_id = ?`, runID); err != nil { return err }
	stmt, err := tx.PrepareContext(ctx, `insert into codex_inspection_action_selections(run_id, account_key, selected, planned_action, executed, success, error, updated_at_ms) values(?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil { return err }
	defer stmt.Close()
	for _, item := range items {
		if _, err := stmt.ExecContext(ctx, item.RunID, item.AccountKey, boolToInt(item.Selected), item.PlannedAction, boolToInt(item.Executed), boolToInt(item.Success), nullString(item.Error), item.UpdatedAtMS); err != nil { return err }
	}
	return tx.Commit()
}


func (s *Store) ListCodexInspectionRuns(ctx context.Context, limit int) ([]CodexInspectionRun, error) {
	if limit <= 0 { limit = 50 }
	rows, err := s.db.QueryContext(ctx, `select run_id, run_name, status, target_type, workers, delete_workers, timeout, retries, user_agent,
		used_percent_threshold, sample_size, auto_execute_actions, target_scope_type, selected_targets_json, summary_json, progress_json,
		started_at_ms, updated_at_ms, finished_at_ms from codex_inspection_runs order by started_at_ms desc limit ?`, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	out := make([]CodexInspectionRun, 0)
	for rows.Next() {
		var item CodexInspectionRun
		var selected, summary, progress sql.NullString
		var auto int
		var finished sql.NullInt64
		if err := rows.Scan(&item.RunID, &item.RunName, &item.Status, &item.TargetType, &item.Workers, &item.DeleteWorkers, &item.Timeout, &item.Retries, &item.UserAgent,
			&item.UsedPercentThreshold, &item.SampleSize, &auto, &item.TargetScopeType, &selected, &summary, &progress, &item.StartedAtMS, &item.UpdatedAtMS, &finished); err != nil { return nil, err }
		item.AutoExecuteActions = auto != 0
		item.SelectedTargetsJSON = selected.String
		item.SummaryJSON = summary.String
		item.ProgressJSON = progress.String
		if finished.Valid { v:=finished.Int64; item.FinishedAtMS=&v }
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) GetCodexInspectionRun(ctx context.Context, runID string) (CodexInspectionRun, bool, error) {
	var item CodexInspectionRun
	var selected, summary, progress sql.NullString
	var auto int
	var finished sql.NullInt64
	err := s.db.QueryRowContext(ctx, `select run_id, run_name, status, target_type, workers, delete_workers, timeout, retries, user_agent,
		used_percent_threshold, sample_size, auto_execute_actions, target_scope_type, selected_targets_json, summary_json, progress_json,
		started_at_ms, updated_at_ms, finished_at_ms from codex_inspection_runs where run_id = ?`, runID).Scan(
		&item.RunID, &item.RunName, &item.Status, &item.TargetType, &item.Workers, &item.DeleteWorkers, &item.Timeout, &item.Retries, &item.UserAgent,
		&item.UsedPercentThreshold, &item.SampleSize, &auto, &item.TargetScopeType, &selected, &summary, &progress, &item.StartedAtMS, &item.UpdatedAtMS, &finished)
	if errors.Is(err, sql.ErrNoRows) { return CodexInspectionRun{}, false, nil }
	if err != nil { return CodexInspectionRun{}, false, err }
	item.AutoExecuteActions = auto != 0
	item.SelectedTargetsJSON = selected.String
	item.SummaryJSON = summary.String
	item.ProgressJSON = progress.String
	if finished.Valid { v:=finished.Int64; item.FinishedAtMS=&v }
	return item, true, nil
}

func (s *Store) GetLatestCodexInspectionRun(ctx context.Context) (CodexInspectionRun, bool, error) {
	rows, err := s.ListCodexInspectionRuns(ctx, 1)
	if err != nil || len(rows)==0 {
		if err != nil { return CodexInspectionRun{}, false, err }
		return CodexInspectionRun{}, false, nil
	}
	return rows[0], true, nil
}

func (s *Store) LoadCodexInspectionResults(ctx context.Context, runID string) ([]CodexInspectionResultRow, error) {
	rows, err := s.db.QueryContext(ctx, `select run_id, account_key, file_name, display_account, auth_index, account_id, provider, disabled, status, state,
		action, action_reason, status_code, used_percent, is_quota, error, response_body_text, response_body_json, response_headers_json, updated_at_ms
		from codex_inspection_results where run_id = ? order by file_name, display_account`, runID)
	if err != nil { return nil, err }
	defer rows.Close()
	out := make([]CodexInspectionResultRow,0)
	for rows.Next() {
		var item CodexInspectionResultRow
		var authIndex, accountID, provider, status, state, reason, errText, bodyText, bodyJSON, headersJSON sql.NullString
		var disabled, isQuota int
		var statusCode sql.NullInt64
		var usedPercent sql.NullFloat64
		if err := rows.Scan(&item.RunID, &item.AccountKey, &item.FileName, &item.DisplayAccount, &authIndex, &accountID, &provider, &disabled, &status, &state,
			&item.Action, &reason, &statusCode, &usedPercent, &isQuota, &errText, &bodyText, &bodyJSON, &headersJSON, &item.UpdatedAtMS); err != nil { return nil, err }
		item.AuthIndex = authIndex.String; item.AccountID = accountID.String; item.Provider = provider.String; item.Disabled = disabled != 0; item.Status = status.String; item.State = state.String; item.ActionReason = reason.String; item.IsQuota = isQuota != 0; item.Error = errText.String; item.ResponseBodyText = bodyText.String; item.ResponseBodyJSON = bodyJSON.String; item.ResponseHeadersJSON = headersJSON.String
		if statusCode.Valid { v:=int(statusCode.Int64); item.StatusCode=&v }
		if usedPercent.Valid { v:=usedPercent.Float64; item.UsedPercent=&v }
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) LoadCodexInspectionLogs(ctx context.Context, runID string, limit int) ([]CodexInspectionLogRow, error) {
	if limit <= 0 { limit = 2000 }
	rows, err := s.db.QueryContext(ctx, `select id, run_id, level, message, created_at_ms from codex_inspection_logs where run_id = ? order by id asc limit ?`, runID, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	out := make([]CodexInspectionLogRow,0)
	for rows.Next() {
		var item CodexInspectionLogRow
		if err := rows.Scan(&item.ID, &item.RunID, &item.Level, &item.Message, &item.CreatedAtMS); err != nil { return nil, err }
		out = append(out, item)
	}
	return out, rows.Err()
}
