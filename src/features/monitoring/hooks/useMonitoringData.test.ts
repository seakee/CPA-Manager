import { describe, expect, it } from 'vitest';
import {
  buildAccountRows,
  buildApiKeyDisplayMap,
  buildMonitoringAuthMetaMap,
  buildProviderInfoByUsageSource,
  buildProviderPrefixByApiKeyHash,
  buildProviderPrefixByUsageSource,
  type MonitoringEventRow,
} from './useMonitoringData';
import { sha256Hex } from '@/utils/apiKeyHash';
import type { AuthFileItem } from '@/types';
import type { Config } from '@/types/config';

const createMonitoringEventRow = (
  overrides: Partial<MonitoringEventRow> = {}
): MonitoringEventRow => ({
  id: overrides.id ?? 'row-1',
  timestamp: overrides.timestamp ?? '2026-05-09T01:12:43.000Z',
  timestampMs: overrides.timestampMs ?? Date.parse('2026-05-09T01:12:43.000Z'),
  dayKey: overrides.dayKey ?? '2026-05-09',
  hourLabel: overrides.hourLabel ?? '01:00',
  model: overrides.model ?? 'gpt-4.1',
  endpoint: overrides.endpoint ?? '/v1/chat/completions',
  endpointMethod: overrides.endpointMethod ?? 'POST',
  endpointPath: overrides.endpointPath ?? '/v1/chat/completions',
  sourceKey: overrides.sourceKey ?? 'source:alpha',
  source: overrides.source ?? 'alpha.json',
  sourceMasked: overrides.sourceMasked ?? 'a***',
  account: overrides.account ?? 'amount-myth-resend@duck.com',
  accountMasked: overrides.accountMasked ?? 'amo***@duck.com',
  authIndex: overrides.authIndex ?? 'auth-123456',
  authIndexMasked: overrides.authIndexMasked ?? 'auth...3456',
  authLabel: overrides.authLabel ?? 'alpha.json',
  apiKeyHash: overrides.apiKeyHash ?? 'api-key-hash',
  apiKeyLabel: overrides.apiKeyLabel ?? 'ak********sh',
  apiKeyMasked: overrides.apiKeyMasked ?? 'ak********sh',
  provider: overrides.provider ?? 'codex',
  providerDetail: overrides.providerDetail,
  planType: overrides.planType ?? 'pro',
  channel: overrides.channel ?? 'codex',
  channelHost: overrides.channelHost ?? 'example.com',
  channelDisabled: overrides.channelDisabled ?? false,
  failed: overrides.failed ?? false,
  statsIncluded: overrides.statsIncluded ?? true,
  latencyMs: overrides.latencyMs ?? 1200,
  inputTokens: overrides.inputTokens ?? 10,
  outputTokens: overrides.outputTokens ?? 5,
  reasoningTokens: overrides.reasoningTokens ?? 0,
  cachedTokens: overrides.cachedTokens ?? 3,
  totalTokens: overrides.totalTokens ?? 18,
  totalCost: overrides.totalCost ?? 0.12,
  taskKey: overrides.taskKey ?? 'task-1',
  searchText: overrides.searchText ?? 'amount myth resend',
});

describe('buildAccountRows', () => {
  it('keeps raw auth indices for account-level auth file linking', () => {
    const rows = buildAccountRows([
      createMonitoringEventRow(),
      createMonitoringEventRow({
        id: 'row-2',
        timestampMs: Date.parse('2026-05-09T02:12:43.000Z'),
        authIndex: 'auth-999999',
        authIndexMasked: 'auth...9999',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].authIndices).toEqual(['auth-123456', 'auth-999999']);
  });

  it('keeps provider prefixes visible for masked API key usage sources', () => {
    const rows = buildAccountRows([
      createMonitoringEventRow({
        account: 'test1/m:fe_o...8599',
        accountMasked: 'test1/m:fe_o...8599',
        authLabel: 'test1/m:fe_o...8599',
        channel: 'codex',
        source: 'test1/m:fe_o...8599',
        sourceMasked: 'test1/m:fe_o...8599',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe('test1/m:fe_o...8599');
    expect(rows[0].displayAccount).toBe('test1/m:fe_o...8599');
  });

  it('merges prefixed and unprefixed rows for the same provider source', () => {
    const rows = buildAccountRows([
      createMonitoringEventRow({
        id: 'row-unprefixed',
        sourceKey: 'codex:0',
        account: 'm:m:******ca',
        accountMasked: 'm:m:******ca',
        source: 'm:m:******ca',
        sourceMasked: 'm:m:******ca',
      }),
      createMonitoringEventRow({
        id: 'row-prefixed',
        sourceKey: 'codex:0',
        account: 'misaki-su/m:m:******ca',
        accountMasked: 'misaki-su/m:m:******ca',
        source: 'misaki-su/m:m:******ca',
        sourceMasked: 'misaki-su/m:m:******ca',
        timestampMs: Date.parse('2026-05-09T02:12:43.000Z'),
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].totalCalls).toBe(2);
    expect(rows[0].account).toBe('misaki-su/m:m:******ca');
    expect(rows[0].displayAccount).toBe('misaki-su/m:m:******ca');
  });

  it('stores provider detail text for provider key account subtitles', () => {
    const rows = buildAccountRows([
      createMonitoringEventRow({
        account: 'misaki-su/m:sk-9...1dca',
        accountMasked: 'misaki-su/m:sk-9...1dca',
        providerDetail: {
          prefix: 'misaki-su',
          provider: 'Codex',
          baseUrl: 'https://sub.swyel.codes',
        },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].providerDetails).toEqual([
      {
        prefix: 'misaki-su',
        provider: 'Codex',
        baseUrl: 'https://sub.swyel.codes',
      },
    ]);
  });
});

describe('buildMonitoringAuthMetaMap', () => {
  it('maps legacy auth indices to current auth metadata', () => {
    const authFiles: AuthFileItem[] = [
      {
        name: 'alice.json',
        provider: 'codex',
        authIndex: 'current-auth-index',
        path: '/tmp/auths/alice.json',
        account: 'alice@example.com',
      },
    ];

    const map = buildMonitoringAuthMetaMap(authFiles);

    expect(map.get('current-auth-index')?.account).toBe('alice@example.com');
    expect(map.get('6bf749cb7db0e15c')?.account).toBe('alice@example.com');
  });
});

describe('buildApiKeyDisplayMap', () => {
  it('prefers stored aliases while preserving masked configured keys', () => {
    const apiKey = 'sk-alias-test-key';
    const apiKeyHash = sha256Hex(apiKey);
    const map = buildApiKeyDisplayMap([apiKey], [{ apiKeyHash, alias: 'Team A', updatedAtMs: 1 }]);

    expect(map.get(apiKeyHash)?.label).toBe('Team A');
    expect(map.get(apiKeyHash)?.masked).toMatch(/^sk/);
  });
});

describe('buildProviderPrefixByApiKeyHash', () => {
  it('maps configured provider API keys to their routing prefixes', () => {
    const apiKey = 'fe_openai_1234567899';
    const config: Config = {
      codexApiKeys: [
        {
          apiKey,
          prefix: 'test1',
        },
      ],
    };

    const map = buildProviderPrefixByApiKeyHash(config);

    expect(map.get(sha256Hex(apiKey).toLowerCase())).toBe('test1');
  });
});

describe('buildProviderPrefixByUsageSource', () => {
  it('maps masked usage sources back to configured provider prefixes', () => {
    const apiKey = 'sk-9435efa6ebfface4e5be9846607be52b76d9b045c840d5468661a03be5051dca';
    const config: Config = {
      codexApiKeys: [
        {
          apiKey,
          prefix: 'misaki-su',
        },
      ],
    };

    const map = buildProviderPrefixByUsageSource(config);

    expect(map.get('m:sk-9...1dca')).toBe('misaki-su');
  });
});

describe('buildProviderInfoByUsageSource', () => {
  it('maps masked usage sources back to provider type and base url details', () => {
    const apiKey = 'sk-9435efa6ebfface4e5be9846607be52b76d9b045c840d5468661a03be5051dca';
    const config: Config = {
      codexApiKeys: [
        {
          apiKey,
          prefix: 'misaki-su',
          baseUrl: 'https://sub.swyel.codes',
        },
      ],
    };

    const map = buildProviderInfoByUsageSource(config);

    expect(map.get('m:sk-9...1dca')).toEqual({
      prefix: 'misaki-su',
      provider: 'Codex',
      baseUrl: 'https://sub.swyel.codes',
    });
    expect(map.get('m:m:******ca')?.baseUrl).toBe('https://sub.swyel.codes');
  });
});
