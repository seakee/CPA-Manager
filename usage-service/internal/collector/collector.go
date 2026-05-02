package collector

import (
	"context"
	"sync"
	"time"

	"github.com/seakee/cpa-manager/usage-service/internal/config"
	"github.com/seakee/cpa-manager/usage-service/internal/resp"
	"github.com/seakee/cpa-manager/usage-service/internal/store"
	"github.com/seakee/cpa-manager/usage-service/internal/usage"
)

type Status struct {
	Collector      string `json:"collector"`
	Upstream       string `json:"upstream"`
	Queue          string `json:"queue"`
	LastConsumedAt int64  `json:"lastConsumedAt"`
	LastInsertedAt int64  `json:"lastInsertedAt"`
	TotalInserted  int64  `json:"totalInserted"`
	TotalSkipped   int64  `json:"totalSkipped"`
	DeadLetters    int64  `json:"deadLetters"`
	LastError      string `json:"lastError,omitempty"`
}

type RuntimeConfig struct {
	CPAUpstreamURL string
	ManagementKey  string
	Queue          string
	PopSide        string
}

type Manager struct {
	base       config.Config
	store      *store.Store
	mu         sync.Mutex
	cancel     context.CancelFunc
	status     Status
	runtimeCfg RuntimeConfig
}

func NewManager(base config.Config, store *store.Store) *Manager {
	return &Manager{
		base:  base,
		store: store,
		status: Status{
			Collector: "stopped",
			Queue:     base.Queue,
		},
	}
}

func (m *Manager) Start(ctx context.Context, cfg RuntimeConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	m.runtimeCfg = cfg
	m.status.Collector = "starting"
	m.status.Upstream = cfg.CPAUpstreamURL
	m.status.Queue = valueOr(cfg.Queue, m.base.Queue)
	m.status.LastError = ""

	runCtx, cancel := context.WithCancel(ctx)
	m.cancel = cancel
	go m.run(runCtx, cfg)
}

func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	m.status.Collector = "stopped"
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *Manager) setStatus(update func(*Status)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	update(&m.status)
}

func (m *Manager) run(ctx context.Context, cfg RuntimeConfig) {
	queue := valueOr(cfg.Queue, m.base.Queue)
	popSide := valueOr(cfg.PopSide, m.base.PopSide)
	backoff := time.Second

	for {
		if ctx.Err() != nil {
			return
		}
		client, err := resp.Dial(cfg.CPAUpstreamURL, m.base.TLSSkipVerify)
		if err != nil {
			m.markError("connect", err)
			sleep(ctx, backoff)
			backoff = nextBackoff(backoff)
			continue
		}
		if err := client.Auth(cfg.ManagementKey); err != nil {
			_ = client.Close()
			m.markError("auth", err)
			sleep(ctx, backoff)
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = time.Second
		m.setStatus(func(status *Status) {
			status.Collector = "running"
			status.LastError = ""
		})

		err = m.consume(ctx, client, queue, popSide)
		_ = client.Close()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			m.markError("consume", err)
			sleep(ctx, backoff)
			backoff = nextBackoff(backoff)
		}
	}
}

func (m *Manager) consume(ctx context.Context, client *resp.Client, queue string, popSide string) error {
	ticker := time.NewTicker(m.base.PollInterval)
	defer ticker.Stop()

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		items, err := client.Pop(queue, popSide, m.base.BatchSize)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
				continue
			}
		}
		m.setStatus(func(status *Status) {
			status.LastConsumedAt = time.Now().UnixMilli()
		})
		events := make([]usage.Event, 0, len(items))
		for _, item := range items {
			event, err := usage.NormalizeRaw([]byte(item))
			if err != nil {
				_ = m.store.AddDeadLetter(ctx, item, err)
				m.setStatus(func(status *Status) {
					status.DeadLetters++
				})
				continue
			}
			events = append(events, event)
		}
		result, err := m.store.InsertEvents(ctx, events)
		if err != nil {
			return err
		}
		if result.Inserted > 0 || result.Skipped > 0 {
			m.setStatus(func(status *Status) {
				status.LastInsertedAt = time.Now().UnixMilli()
				status.TotalInserted += int64(result.Inserted)
				status.TotalSkipped += int64(result.Skipped)
			})
		}
	}
}

func (m *Manager) markError(stage string, err error) {
	m.setStatus(func(status *Status) {
		status.Collector = "error"
		status.LastError = stage + ": " + err.Error()
	})
}

func sleep(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 30*time.Second {
		return 30 * time.Second
	}
	return next
}

func valueOr(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
