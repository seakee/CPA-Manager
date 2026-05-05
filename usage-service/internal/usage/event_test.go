package usage

import "testing"

func TestBuildPayloadIncludesAPIKey(t *testing.T) {
	payload := BuildPayload([]Event{
		{
			Timestamp:   "2026-05-05T00:00:00Z",
			Model:       "gpt-test",
			Endpoint:    "POST /v1/chat/completions",
			Source:      "sk-***",
			AuthIndex:   "auth-1",
			APIKey:      "sk-test",
			APIKeyHash:  "abc123",
			TotalTokens: 42,
		},
	})

	apiEntry := payload.APIs["POST /v1/chat/completions"]
	if apiEntry == nil {
		t.Fatal("missing endpoint aggregate")
	}
	modelEntry := apiEntry.Models["gpt-test"]
	if modelEntry == nil || len(modelEntry.Details) != 1 {
		t.Fatalf("missing model details: %#v", modelEntry)
	}
	if got := modelEntry.Details[0].APIKeyHash; got != "abc123" {
		t.Fatalf("api key hash = %q, want abc123", got)
	}
	if got := modelEntry.Details[0].APIKey; got != "sk-test" {
		t.Fatalf("api key = %q, want sk-test", got)
	}
}
