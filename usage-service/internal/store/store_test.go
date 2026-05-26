package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager/usage-service/internal/usage"
)

func ptrInt64(value int64) *int64 {
	return &value
}

func TestStorePersistsAccountSnapshot(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:            "event-1",
			TimestampMS:          1_778_000_000_000,
			Timestamp:            "2026-05-06T00:00:00Z",
			Model:                "gpt-test",
			Endpoint:             "POST /v1/chat/completions",
			AuthIndex:            "auth-1",
			APIKeyHash:           "api-key-hash-1",
			AccountSnapshot:      "alice@example.com",
			AuthLabelSnapshot:    "Alice",
			AuthFileSnapshot:     "alice.json",
			AuthProviderSnapshot: "codex",
			AuthSnapshotAtMS:     1_778_000_000_100,
			CreatedAtMS:          1_778_000_000_200,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	events, err := db.RecentEvents(context.Background(), 10)
	if err != nil {
		t.Fatalf("recent events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	event := events[0]
	if event.AccountSnapshot != "alice@example.com" {
		t.Fatalf("AccountSnapshot = %q", event.AccountSnapshot)
	}
	if event.AuthLabelSnapshot != "Alice" {
		t.Fatalf("AuthLabelSnapshot = %q", event.AuthLabelSnapshot)
	}
	if event.AuthFileSnapshot != "alice.json" {
		t.Fatalf("AuthFileSnapshot = %q", event.AuthFileSnapshot)
	}
	if event.AuthProviderSnapshot != "codex" {
		t.Fatalf("AuthProviderSnapshot = %q", event.AuthProviderSnapshot)
	}
	if event.AuthSnapshotAtMS != 1_778_000_000_100 {
		t.Fatalf("AuthSnapshotAtMS = %d", event.AuthSnapshotAtMS)
	}
	if event.APIKeyHash != "api-key-hash-1" {
		t.Fatalf("APIKeyHash = %q", event.APIKeyHash)
	}

	payload := usage.BuildPayload(events)
	detail := payload.APIs["POST /v1/chat/completions"].Models["gpt-test"].Details[0]
	if detail.APIKeyHash != "api-key-hash-1" {
		t.Fatalf("payload APIKeyHash = %q", detail.APIKeyHash)
	}
	if detail.AccountSnapshot != "alice@example.com" {
		t.Fatalf("payload AccountSnapshot = %q", detail.AccountSnapshot)
	}
	if detail.AuthProviderSnapshot != "codex" {
		t.Fatalf("payload AuthProviderSnapshot = %q", detail.AuthProviderSnapshot)
	}
}

func TestStorePersistsRequestedAndResolvedModels(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:      "event-dual",
			TimestampMS:    1_778_000_001_000,
			Timestamp:      "2026-05-06T00:00:01Z",
			Model:          "gpt-5.4",
			RequestedModel: "gpt-5.4",
			ResolvedModel:  "gpt-5.5",
			Endpoint:       "POST /v1/chat/completions",
			CreatedAtMS:    1_778_000_001_100,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	events, err := db.RecentEvents(context.Background(), 10)
	if err != nil {
		t.Fatalf("recent events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].RequestedModel != "gpt-5.4" {
		t.Fatalf("RequestedModel roundtrip = %q", events[0].RequestedModel)
	}
	if events[0].ResolvedModel != "gpt-5.5" {
		t.Fatalf("ResolvedModel roundtrip = %q", events[0].ResolvedModel)
	}

	payload := usage.BuildPayload(events)
	detail := payload.APIs["POST /v1/chat/completions"].Models["gpt-5.4"].Details[0]
	if detail.ResolvedModel != "gpt-5.5" {
		t.Fatalf("payload Detail.ResolvedModel = %q", detail.ResolvedModel)
	}
}

func TestStoreUsageSummaryAggregatesEventsWithoutDetails(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:            "summary-success",
			TimestampMS:          1_778_000_003_000,
			Timestamp:            "2026-05-06T00:00:03Z",
			Model:                "gpt-test",
			Endpoint:             "POST /v1/chat/completions",
			AuthIndex:            "auth-1",
			APIKeyHash:           "key-hash-1",
			AccountSnapshot:      "alice@example.com",
			AuthProviderSnapshot: "codex",
			InputTokens:          10,
			OutputTokens:         20,
			TotalTokens:          30,
			LatencyMS:            ptrInt64(123),
			RawJSON:              `{"large":"detail"}`,
			CreatedAtMS:          1_778_000_003_100,
		},
		{
			EventHash:            "summary-failure",
			TimestampMS:          1_778_000_004_000,
			Timestamp:            "2026-05-06T00:00:04Z",
			Model:                "gpt-test",
			Endpoint:             "POST /v1/chat/completions",
			AuthIndex:            "auth-2",
			APIKeyHash:           "key-hash-2",
			AccountSnapshot:      "bob@example.com",
			AuthProviderSnapshot: "gemini",
			InputTokens:          5,
			ReasoningTokens:      7,
			TotalTokens:          12,
			Failed:               true,
			CreatedAtMS:          1_778_000_004_100,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	summary, err := db.UsageSummary(context.Background(), UsageSummaryFilter{})
	if err != nil {
		t.Fatalf("usage summary: %v", err)
	}
	if summary.TotalRequests != 2 || summary.SuccessCount != 1 || summary.FailureCount != 1 || summary.TotalTokens != 42 {
		t.Fatalf("summary totals = %#v", summary)
	}
	if summary.Tokens.InputTokens != 15 || summary.Tokens.OutputTokens != 20 || summary.Tokens.ReasoningTokens != 7 || summary.Tokens.TotalTokens != 42 {
		t.Fatalf("summary token totals = %#v", summary.Tokens)
	}
	if summary.LatencySumMS != 123 || summary.LatencyCount != 1 || summary.LatencyMS == nil || *summary.LatencyMS != 123 {
		t.Fatalf("summary latency = sum:%d count:%d avg:%v", summary.LatencySumMS, summary.LatencyCount, summary.LatencyMS)
	}
	if len(summary.APIs) != 0 {
		t.Fatalf("summary APIs len = %d, want no detail aggregates", len(summary.APIs))
	}

	startMS := int64(1_778_000_004_000)
	filtered, err := db.UsageSummary(context.Background(), UsageSummaryFilter{StartMS: &startMS})
	if err != nil {
		t.Fatalf("filtered usage summary: %v", err)
	}
	if filtered.TotalRequests != 1 || filtered.SuccessCount != 0 || filtered.FailureCount != 1 || filtered.TotalTokens != 12 {
		t.Fatalf("filtered summary = %#v", filtered)
	}

	apiKeyFiltered, err := db.UsageSummary(context.Background(), UsageSummaryFilter{APIKeyHash: "key-hash-1", Status: "success", Search: "alice"})
	if err != nil {
		t.Fatalf("api key filtered usage summary: %v", err)
	}
	if apiKeyFiltered.TotalRequests != 1 || apiKeyFiltered.SuccessCount != 1 || apiKeyFiltered.FailureCount != 0 || apiKeyFiltered.TotalTokens != 30 {
		t.Fatalf("api key filtered summary = %#v", apiKeyFiltered)
	}
}

func TestStoreUsageSearchUsesFTSAndAPIKeyAlias(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	hashA := strings.Repeat("a", 64)
	hashB := strings.Repeat("b", 64)
	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:       "search-alias-a",
			TimestampMS:     1_778_000_001_000,
			Timestamp:       "2026-05-06T00:00:01Z",
			Model:           "gpt-test",
			Endpoint:        "POST /v1/chat/completions",
			APIKeyHash:      hashA,
			AccountSnapshot: "alice@example.com",
			TotalTokens:     10,
		},
		{
			EventHash:       "search-alias-b",
			TimestampMS:     1_778_000_002_000,
			Timestamp:       "2026-05-06T00:00:02Z",
			Model:           "gemini-test",
			Endpoint:        "POST /v1/chat/completions",
			APIKeyHash:      hashB,
			AccountSnapshot: "bob@example.com",
			TotalTokens:     20,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: hashA, Alias: "KongWenpeng"},
	}, nil); err != nil {
		t.Fatalf("upsert alias: %v", err)
	}

	summary, err := db.UsageSummary(context.Background(), UsageSummaryFilter{
		Search:           "KongWenpeng",
		SearchAPIKeyHash: strings.Repeat("f", 64),
	})
	if err != nil {
		t.Fatalf("alias search summary: %v", err)
	}
	if summary.TotalRequests != 1 || summary.TotalTokens != 10 {
		t.Fatalf("alias search summary = %#v", summary)
	}

	summary, err = db.UsageSummary(context.Background(), UsageSummaryFilter{
		Search: "gemini-test",
	})
	if err != nil {
		t.Fatalf("model search summary: %v", err)
	}
	if summary.TotalRequests != 1 || summary.TotalTokens != 20 {
		t.Fatalf("model search summary = %#v", summary)
	}
}

func TestStoreUsageBreakdownPagePaginatesAccountGroups(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:       "account-page-alice",
			TimestampMS:     1_778_000_001_000,
			Timestamp:       "2026-05-06T00:00:01Z",
			Model:           "gpt-test",
			Endpoint:        "POST /v1/chat/completions",
			AuthIndex:       "auth-alice",
			AccountSnapshot: "alice@example.com",
			TotalTokens:     10,
		},
		{
			EventHash:       "account-page-bob",
			TimestampMS:     1_778_000_003_000,
			Timestamp:       "2026-05-06T00:00:03Z",
			Model:           "gpt-test",
			Endpoint:        "POST /v1/chat/completions",
			AuthIndex:       "auth-bob",
			AccountSnapshot: "bob@example.com",
			TotalTokens:     30,
		},
		{
			EventHash:       "account-page-carol",
			TimestampMS:     1_778_000_002_000,
			Timestamp:       "2026-05-06T00:00:02Z",
			Model:           "gpt-test",
			Endpoint:        "POST /v1/chat/completions",
			AuthIndex:       "auth-carol",
			AccountSnapshot: "carol@example.com",
			TotalTokens:     20,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	page, err := db.UsageBreakdownPage(context.Background(), UsageBreakdownAccounts, UsageSummaryFilter{}, UsagePageFilter{
		Page:     2,
		PageSize: 1,
	})
	if err != nil {
		t.Fatalf("usage account page: %v", err)
	}
	if page.TotalItems != 3 || page.Page != 2 || page.PageSize != 1 {
		t.Fatalf("pagination = %#v", page)
	}
	details := collectTestDetails(page.Usage)
	if len(details) != 1 {
		t.Fatalf("details len = %d, want 1", len(details))
	}
	if details[0].AccountSnapshot != "carol@example.com" {
		t.Fatalf("account page detail account = %q, want carol", details[0].AccountSnapshot)
	}
}

func TestNormalizeUsagePageFilterCapsPageSize(t *testing.T) {
	page, pageSize := normalizeUsagePageFilter(UsagePageFilter{
		Page:     0,
		PageSize: MaxUsagePageSize + 1,
	})
	if page != 1 || pageSize != MaxUsagePageSize {
		t.Fatalf("normalize page = %d, pageSize = %d", page, pageSize)
	}
}

func TestNormalizeUsageSortKeyUsesWhitelist(t *testing.T) {
	if got := normalizeUsageSortKey("totalTokens"); got != "totalTokens" {
		t.Fatalf("valid sort key = %q", got)
	}
	if got := normalizeUsageSortKey("timestamp_ms desc"); got != defaultUsageSortKey {
		t.Fatalf("invalid sort key = %q, want %q", got, defaultUsageSortKey)
	}
}

func TestStoreUsageBreakdownPagePaginatesApiKeyGroups(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:   "api-key-page-a",
			TimestampMS: 1_778_000_001_000,
			Timestamp:   "2026-05-06T00:00:01Z",
			Model:       "gpt-test",
			Endpoint:    "POST /v1/chat/completions",
			APIKeyHash:  "key-a",
			TotalTokens: 10,
		},
		{
			EventHash:   "api-key-page-b",
			TimestampMS: 1_778_000_002_000,
			Timestamp:   "2026-05-06T00:00:02Z",
			Model:       "gpt-test",
			Endpoint:    "POST /v1/chat/completions",
			APIKeyHash:  "key-b",
			TotalTokens: 20,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	page, err := db.UsageBreakdownPage(context.Background(), UsageBreakdownAPIKeys, UsageSummaryFilter{}, UsagePageFilter{
		Page:     1,
		PageSize: 1,
	})
	if err != nil {
		t.Fatalf("usage api-key page: %v", err)
	}
	if page.TotalItems != 2 {
		t.Fatalf("total items = %d, want 2", page.TotalItems)
	}
	details := collectTestDetails(page.Usage)
	if len(details) != 1 || details[0].APIKeyHash != "key-b" {
		t.Fatalf("api-key page details = %#v, want key-b", details)
	}
}

func TestStoreUsageBreakdownPagePaginatesRealtimeRows(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:   "realtime-page-old",
			TimestampMS: 1_778_000_001_000,
			Timestamp:   "2026-05-06T00:00:01Z",
			Model:       "gpt-test",
			Endpoint:    "POST /v1/chat/completions",
			TotalTokens: 10,
		},
		{
			EventHash:   "realtime-page-new",
			TimestampMS: 1_778_000_002_000,
			Timestamp:   "2026-05-06T00:00:02Z",
			Model:       "gpt-test",
			Endpoint:    "POST /v1/chat/completions",
			TotalTokens: 20,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	page, err := db.UsageBreakdownPage(context.Background(), UsageBreakdownRealtime, UsageSummaryFilter{}, UsagePageFilter{
		Page:     2,
		PageSize: 1,
	})
	if err != nil {
		t.Fatalf("usage realtime page: %v", err)
	}
	if page.TotalItems != 2 || page.Page != 2 {
		t.Fatalf("pagination = %#v", page)
	}
	details := collectTestDetails(page.Usage)
	if len(details) != 1 || details[0].Tokens.TotalTokens != 10 {
		t.Fatalf("realtime page details = %#v, want oldest row", details)
	}
}

func TestStoreUsageBreakdownPagePaginatesModelGroupsWithFilters(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:            "model-page-codex",
			TimestampMS:          1_778_000_001_000,
			Timestamp:            "2026-05-06T00:00:01Z",
			Provider:             "codex",
			Model:                "gpt-test",
			Endpoint:             "POST /v1/chat/completions",
			ResolvedModel:        "gpt-test-resolved",
			InputTokens:          10,
			OutputTokens:         20,
			TotalTokens:          30,
			AuthProviderSnapshot: "codex",
		},
		{
			EventHash:            "model-page-other",
			TimestampMS:          1_778_000_002_000,
			Timestamp:            "2026-05-06T00:00:02Z",
			Provider:             "gemini",
			Model:                "gemini-test",
			Endpoint:             "POST /v1/chat/completions",
			TotalTokens:          40,
			AuthProviderSnapshot: "gemini",
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	page, err := db.UsageBreakdownPage(context.Background(), UsageBreakdownModels, UsageSummaryFilter{Provider: "codex"}, UsagePageFilter{
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("usage model page: %v", err)
	}
	if page.TotalItems != 1 || page.Usage.TotalRequests != 1 || page.Usage.TotalTokens != 30 {
		t.Fatalf("model page = %#v", page)
	}
	details := collectTestDetails(page.Usage)
	if len(details) != 1 || details[0].ResolvedModel != "gpt-test-resolved" || details[0].Tokens.TotalTokens != 30 {
		t.Fatalf("model page details = %#v", details)
	}
}

func collectTestDetails(payload usage.Payload) []usage.Detail {
	details := make([]usage.Detail, 0)
	for _, api := range payload.APIs {
		for _, model := range api.Models {
			details = append(details, model.Details...)
		}
	}
	return details
}

func TestStoreAPIKeyAliases(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: hash, Alias: " Alice "},
	}, nil); err != nil {
		t.Fatalf("upsert alias: %v", err)
	}

	aliases, err := db.LoadAPIKeyAliases(context.Background())
	if err != nil {
		t.Fatalf("load aliases: %v", err)
	}
	if len(aliases) != 1 {
		t.Fatalf("len(aliases) = %d, want 1", len(aliases))
	}
	if aliases[0].APIKeyHash != hash || aliases[0].Alias != "Alice" || aliases[0].UpdatedAtMS <= 0 {
		t.Fatalf("alias = %#v", aliases[0])
	}

	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: hash, Alias: "Team A"},
	}, nil); err != nil {
		t.Fatalf("update alias: %v", err)
	}
	aliases, err = db.LoadAPIKeyAliases(context.Background())
	if err != nil {
		t.Fatalf("reload aliases: %v", err)
	}
	if len(aliases) != 1 || aliases[0].Alias != "Team A" {
		t.Fatalf("updated aliases = %#v", aliases)
	}

	const otherHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: otherHash, Alias: " team a "},
	}, nil); err == nil || err.Error() != "api key alias already exists" {
		t.Fatalf("duplicate alias error = %v", err)
	}
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: hash, Alias: "Alpha"},
		{APIKeyHash: otherHash, Alias: " alpha "},
	}, nil); err == nil || err.Error() != "api key alias already exists" {
		t.Fatalf("batch duplicate alias error = %v", err)
	}

	if err := db.DeleteAPIKeyAlias(context.Background(), hash); err != nil {
		t.Fatalf("delete alias: %v", err)
	}
	aliases, err = db.LoadAPIKeyAliases(context.Background())
	if err != nil {
		t.Fatalf("load after delete: %v", err)
	}
	if len(aliases) != 0 {
		t.Fatalf("aliases after delete = %#v", aliases)
	}
}

func TestStoreAPIKeyAliasesActiveHashesMigration(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	const orphanHash = "1111111111111111111111111111111111111111111111111111111111111111"
	const newHash = "2222222222222222222222222222222222222222222222222222222222222222"
	const activeHash = "3333333333333333333333333333333333333333333333333333333333333333"

	// 历史残留：orphanHash 关联别名 "team-a"（模拟编辑/删除密钥后留下的孤儿映射）。
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: orphanHash, Alias: "team-a"},
		{APIKeyHash: activeHash, Alias: "team-b"},
	}, nil); err != nil {
		t.Fatalf("seed aliases: %v", err)
	}

	// 编辑/重建场景：新 hash 想要复用 "team-a"，且 orphanHash 不在活跃集合。
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: newHash, Alias: "team-a"},
	}, []string{newHash, activeHash}); err != nil {
		t.Fatalf("migrate alias from orphan: %v", err)
	}

	aliases, err := db.LoadAPIKeyAliases(context.Background())
	if err != nil {
		t.Fatalf("load aliases: %v", err)
	}
	hashByAlias := map[string]string{}
	for _, alias := range aliases {
		hashByAlias[alias.Alias] = alias.APIKeyHash
	}
	if hashByAlias["team-a"] != newHash {
		t.Fatalf("team-a should belong to newHash, got %#v", aliases)
	}
	if hashByAlias["team-b"] != activeHash {
		t.Fatalf("team-b should remain on activeHash, got %#v", aliases)
	}
	if _, exists := hashByAlias["team-a"]; !exists || len(aliases) != 2 {
		t.Fatalf("orphan record should be cleaned up, got %#v", aliases)
	}

	// 真冲突场景：被占用方仍在活跃集合中，应拒绝。
	if err := db.UpsertAPIKeyAliases(context.Background(), []APIKeyAlias{
		{APIKeyHash: newHash, Alias: "team-b"},
	}, []string{newHash, activeHash}); err == nil || err.Error() != "api key alias already exists" {
		t.Fatalf("active conflict should be rejected, got err = %v", err)
	}
}
