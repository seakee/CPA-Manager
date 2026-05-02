package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr       string
	DBPath         string
	CPAUpstreamURL string
	ManagementKey  string
	Queue          string
	PopSide        string
	BatchSize      int
	PollInterval   time.Duration
	QueryLimit     int
	PanelPath      string
	CORSOrigins    []string
	TLSSkipVerify  bool
}

func Load() Config {
	dataDir := env("USAGE_DATA_DIR", "/data")
	return Config{
		HTTPAddr:       env("HTTP_ADDR", "0.0.0.0:18317"),
		DBPath:         env("USAGE_DB_PATH", filepath.Join(dataDir, "usage.sqlite")),
		CPAUpstreamURL: env("CPA_UPSTREAM_URL", ""),
		ManagementKey:  readSecret("CPA_MANAGEMENT_KEY", "CPA_MANAGEMENT_KEY_FILE", "/run/secrets/cpa_management_key"),
		Queue:          env("USAGE_RESP_QUEUE", "usage"),
		PopSide:        env("USAGE_RESP_POP_SIDE", "right"),
		BatchSize:      envInt("USAGE_BATCH_SIZE", 100),
		PollInterval:   time.Duration(envInt("USAGE_POLL_INTERVAL_MS", 500)) * time.Millisecond,
		QueryLimit:     envInt("USAGE_QUERY_LIMIT", 50000),
		PanelPath:      env("PANEL_PATH", ""),
		CORSOrigins:    splitCSV(env("USAGE_CORS_ORIGINS", "*")),
		TLSSkipVerify:  envBool("USAGE_RESP_TLS_SKIP_VERIFY", false),
	}
}

func env(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func readSecret(envKey string, fileEnvKey string, defaultFile string) string {
	if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
		return value
	}

	path := strings.TrimSpace(os.Getenv(fileEnvKey))
	if path == "" {
		path = defaultFile
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
