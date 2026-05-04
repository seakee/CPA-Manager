package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager/usage-service/internal/collector"
	"github.com/seakee/cpa-manager/usage-service/internal/config"
	"github.com/seakee/cpa-manager/usage-service/internal/store"
)

type observedRequest struct {
	path  string
	query string
	auth  string
}

func newTestHandler(t *testing.T, upstreamURL string, saveSetup bool) http.Handler {
	t.Helper()

	cfg := config.Config{
		DBPath:      filepath.Join(t.TempDir(), "usage.sqlite"),
		Queue:       "usage",
		PopSide:     "right",
		CORSOrigins: []string{"*"},
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	if saveSetup {
		err := db.SaveSetup(context.Background(), store.Setup{
			CPAUpstreamURL: upstreamURL,
			ManagementKey:  "management-key",
			Queue:          "usage",
			PopSide:        "right",
		})
		if err != nil {
			t.Fatalf("save setup: %v", err)
		}
	}

	manager := collector.NewManager(cfg, db)
	return New(cfg, db, manager).Handler()
}

func TestModelListProxyPreservesAuthorization(t *testing.T) {
	for _, path := range []string{"/v1/models", "/models"} {
		t.Run(path, func(t *testing.T) {
			observed := make(chan observedRequest, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				observed <- observedRequest{
					path:  r.URL.Path,
					query: r.URL.RawQuery,
					auth:  r.Header.Get("Authorization"),
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4o"}]}`))
			}))
			t.Cleanup(upstream.Close)

			handler := newTestHandler(t, upstream.URL, true)
			req := httptest.NewRequest(http.MethodGet, path+"?limit=20", nil)
			req.Header.Set("Authorization", "Bearer upstream-key")
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
			}
			if !strings.Contains(rr.Body.String(), "gpt-4o") {
				t.Fatalf("response body = %s", rr.Body.String())
			}

			var got observedRequest
			select {
			case got = <-observed:
			default:
				t.Fatal("upstream was not called")
			}
			if got.path != path {
				t.Fatalf("proxied path = %q, want %q", got.path, path)
			}
			if got.query != "limit=20" {
				t.Fatalf("proxied query = %q, want limit=20", got.query)
			}
			if got.auth != "Bearer upstream-key" {
				t.Fatalf("proxied authorization = %q", got.auth)
			}
		})
	}
}

func TestModelListProxyRequiresSetup(t *testing.T) {
	handler := newTestHandler(t, "", false)
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "usage service is not configured") {
		t.Fatalf("response body = %s", rr.Body.String())
	}
}

func TestModelPricesSaveAndLoad(t *testing.T) {
	handler := newTestHandler(t, "http://example.test", true)
	body := bytes.NewBufferString(`{"prices":{"gpt-test":{"prompt":1.25,"completion":2.5,"cache":0.1}}}`)
	req := httptest.NewRequest(http.MethodPut, "/v0/management/model-prices", body)
	req.Header.Set("Authorization", "Bearer management-key")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v0/management/model-prices", nil)
	req.Header.Set("Authorization", "Bearer management-key")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("load status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var response struct {
		Prices map[string]struct {
			Prompt     float64 `json:"prompt"`
			Completion float64 `json:"completion"`
			Cache      float64 `json:"cache"`
		} `json:"prices"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	price, ok := response.Prices["gpt-test"]
	if !ok {
		t.Fatalf("missing saved price: %#v", response.Prices)
	}
	if price.Prompt != 1.25 || price.Completion != 2.5 || price.Cache != 0.1 {
		t.Fatalf("price = %#v", price)
	}
}

func TestModelPricesSyncFromLiteLLMFormat(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"sample_spec": {},
			"gpt-test": {
				"input_cost_per_token": 0.00000125,
				"output_cost_per_token": 0.0000025,
				"cache_read_input_token_cost": 0.0000001,
				"mode": "chat"
			},
			"image-only": {
				"output_cost_per_image": 0.04,
				"mode": "image_generation"
			}
		}`))
	}))
	t.Cleanup(source.Close)
	oldURL := modelPriceSyncURL
	modelPriceSyncURL = source.URL
	t.Cleanup(func() {
		modelPriceSyncURL = oldURL
	})

	handler := newTestHandler(t, "http://example.test", true)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v0/management/model-prices/sync",
		bytes.NewBufferString(`{"models":["gpt-test"]}`),
	)
	req.Header.Set("Authorization", "Bearer management-key")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("sync status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var response struct {
		Source   string `json:"source"`
		Imported int    `json:"imported"`
		Skipped  int    `json:"skipped"`
		Prices   map[string]struct {
			Prompt        float64 `json:"prompt"`
			Completion    float64 `json:"completion"`
			Cache         float64 `json:"cache"`
			Source        string  `json:"source"`
			SourceModelID string  `json:"sourceModelId"`
		} `json:"prices"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Source != "litellm" || response.Imported != 1 || response.Skipped != 2 {
		t.Fatalf("sync summary = %#v", response)
	}
	price, ok := response.Prices["gpt-test"]
	if !ok {
		t.Fatalf("missing synced price: %#v", response.Prices)
	}
	if !closeFloat(price.Prompt, 1.25) || !closeFloat(price.Completion, 2.5) || !closeFloat(price.Cache, 0.1) {
		t.Fatalf("price = %#v", price)
	}
	if price.Source != "litellm" || price.SourceModelID != "gpt-test" {
		t.Fatalf("source metadata = %#v", price)
	}
}

func closeFloat(left float64, right float64) bool {
	return math.Abs(left-right) < 0.0000001
}
