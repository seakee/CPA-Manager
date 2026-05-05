import { useCallback, useEffect, useMemo, useState } from 'react';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import type { AuthFileItem } from '@/types/authFile';
import type { Config } from '@/types/config';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import {
  calculateCost,
  collectUsageDetailsWithEndpoint,
  extractTotalTokens,
  normalizeAuthIndex,
  type ModelPrice,
  type UsageDetailWithEndpoint,
} from '@/utils/usage';

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const padNumber = (value: number) => String(value).padStart(2, '0');

const buildLocalDayKey = (timestampMs: number) => {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
};

const buildHourLabel = (timestampMs: number) => `${padNumber(new Date(timestampMs).getHours())}:00`;

const buildDayLabel = (dayKey: string) => dayKey.slice(5).replace('-', '/');

const startOfTodayMs = (nowMs: number) => {
  const now = new Date(nowMs);
  now.setHours(0, 0, 0, 0);
  return now.getTime();
};

const getRangeStartMs = (range: MonitoringTimeRange, nowMs: number) => {
  const todayStart = startOfTodayMs(nowMs);

  switch (range) {
    case 'today':
      return todayStart;
    case '7d':
      return todayStart - 6 * 24 * 60 * 60 * 1000;
    case '14d':
      return todayStart - 13 * 24 * 60 * 60 * 1000;
    case '30d':
      return todayStart - 29 * 24 * 60 * 60 * 1000;
    case 'all':
    default:
      return Number.NEGATIVE_INFINITY;
  }
};

const maskEmailLike = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^([^@\s]{1,3})[^@\s]*@(.+)$/);
  if (!match) return trimmed;
  return `${match[1]}***@${match[2]}`;
};

const maskAuthIndex = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return '-';
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
};

const parseBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  return false;
};

const readString = (value: unknown) => {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
};

const extractArrayPayload = (payload: unknown, key: string): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const candidate = payload[key] ?? payload.items ?? payload.data ?? payload;
  return Array.isArray(candidate) ? candidate : [];
};

const extractHost = (baseUrl: string) => {
  const trimmed = readString(baseUrl);
  if (!trimmed) return '-';

  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').split('/')[0] || trimmed;
  }
};

const joinUnique = (values: Iterable<string>, limit = 3) => {
  const unique = Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean)));
  if (unique.length <= limit) {
    return unique.join(', ');
  }
  return `${unique.slice(0, limit).join(', ')} +${unique.length - limit}`;
};

const buildSearchText = (...parts: Array<string | number | boolean | null | undefined>) =>
  parts
    .map((part) => (part === null || part === undefined ? '' : String(part).trim().toLowerCase()))
    .filter(Boolean)
    .join(' ');

const shouldIncludeInStats = (row: Pick<MonitoringEventRow, 'failed' | 'inputTokens' | 'outputTokens'>) =>
  row.failed || row.inputTokens > 0 || row.outputTokens > 0;

const UNKNOWN_API_KEY_ID = '__unknown_api_key__';
const UNKNOWN_API_KEY_LABEL = '-';

const formatApiKeyHashLabel = (hash: string) => {
  const trimmed = hash.trim();
  if (!trimmed) return UNKNOWN_API_KEY_LABEL;
  if (trimmed.length <= 20) return trimmed;
  return `${trimmed.slice(0, 12)}...${trimmed.slice(-6)}`;
};

type MonitoringChannelMeta = {
  key: string;
  name: string;
  baseUrl: string;
  host: string;
  disabled: boolean;
  authIndices: string[];
  modelNames: string[];
};

type MonitoringAuthMeta = {
  authIndex: string;
  label: string;
  account: string;
  provider: string;
  status: string;
  disabled: boolean;
  unavailable: boolean;
  runtimeOnly: boolean;
  planType: string;
  updatedAt: string;
};

export type MonitoringTimeRange = 'today' | '7d' | '14d' | '30d' | 'all';

export type MonitoringStatusTone = 'good' | 'warn' | 'bad';

export type MonitoringStatusChip = {
  key: string;
  label: string;
  value: string;
  tone: MonitoringStatusTone;
};

export type MonitoringKpi = {
  key: string;
  label: string;
  value: number;
  meta: number;
};

export type MonitoringTimelinePoint = {
  label: string;
  requests: number;
  tokens: number;
  cost: number;
};

export type MonitoringModelShareRow = {
  model: string;
  requests: number;
  totalTokens: number;
  totalCost: number;
  successRate: number;
};

export type MonitoringChannelRow = {
  id: string;
  label: string;
  host: string;
  provider: string;
  planTypes: string[];
  disabled: boolean;
  authCount: number;
  modelCount: number;
  requests: number;
  failures: number;
  successRate: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number | null;
  authLabels: string[];
};

export type MonitoringModelRow = {
  model: string;
  requests: number;
  failures: number;
  successRate: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number | null;
  sources: number;
  channels: number;
};

export type MonitoringFailureSourceRow = {
  id: string;
  label: string;
  channel: string;
  failures: number;
  totalRequests: number;
  failureRate: number;
  lastSeenAt: number;
  averageLatencyMs: number | null;
};

export type MonitoringTaskBucketRow = {
  id: string;
  timestampMs: number;
  timestamp: string;
  source: string;
  sourceMasked: string;
  channel: string;
  authLabel: string;
  planType: string;
  calls: number;
  failedCalls: number;
  failed: boolean;
  modelsText: string;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
  endpointsText: string;
};

export type MonitoringFailureRow = {
  id: string;
  timestampMs: number;
  timestamp: string;
  model: string;
  source: string;
  channel: string;
  authIndex: string;
  latencyMs: number | null;
};

export type MonitoringEventRow = {
  id: string;
  timestamp: string;
  timestampMs: number;
  dayKey: string;
  hourLabel: string;
  model: string;
  endpoint: string;
  endpointMethod: string;
  endpointPath: string;
  apiKey: string;
  apiKeyHash: string;
  apiKeyLabel: string;
  sourceKey: string;
  source: string;
  sourceMasked: string;
  account: string;
  accountMasked: string;
  authIndex: string;
  authIndexMasked: string;
  authLabel: string;
  provider: string;
  planType: string;
  channel: string;
  channelHost: string;
  channelDisabled: boolean;
  failed: boolean;
  statsIncluded: boolean;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  taskKey: string;
  searchText: string;
};

export type MonitoringSummary = {
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number | null;
  rpm30m: number;
  tpm30m: number;
  avgDailyRequests: number;
  avgDailyTokens: number;
  approxTasks: number;
  approxTaskFailures: number;
  approxTaskSuccessRate: number;
  zeroTokenCalls: number;
  zeroTokenModels: string[];
};

export type MonitoringAccountModelSpendRow = {
  model: string;
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  lastSeenAt: number;
};

export type MonitoringAccountRow = {
  id: string;
  account: string;
  accountMasked: string;
  authLabels: string[];
  authIndices: string[];
  channels: string[];
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number | null;
  lastSeenAt: number;
  recentPattern: boolean[];
  models: MonitoringAccountModelSpendRow[];
};

export type MonitoringApiKeyRow = {
  id: string;
  apiKey: string;
  apiKeyHash: string;
  apiKeyLabel: string;
  sources: string[];
  accounts: string[];
  providers: string[];
  channels: string[];
  models: string[];
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number | null;
  lastSeenAt: number;
};

export type MonitoringRealtimeRow = {
  id: string;
  account: string;
  accountMasked: string;
  authLabel: string;
  authIndexMasked: string;
  provider: string;
  requestType: string;
  model: string;
  channel: string;
  latestFailed: boolean;
  successRate: number;
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  averageLatencyMs: number | null;
  latestLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  lastSeenAt: number;
  recentPattern: boolean[];
};

export type MonitoringMetadata = {
  totalAuthFiles: number;
  activeAuthFiles: number;
  unavailableAuthFiles: number;
  runtimeOnlyAuthFiles: number;
  totalChannels: number;
  enabledChannels: number;
  configuredModels: number;
  planTypes: string[];
};

export interface UseMonitoringDataParams {
  usage: unknown;
  config: Config | null | undefined;
  modelPrices: Record<string, ModelPrice>;
  apiKeyHashMap?: Record<string, string>;
  timeRange: MonitoringTimeRange;
  searchQuery: string;
}

export interface UseMonitoringDataReturn {
  loading: boolean;
  error: string;
  authFiles: AuthFileItem[];
  channels: MonitoringChannelMeta[];
  summary: MonitoringSummary;
  metadata: MonitoringMetadata;
  statusChips: MonitoringStatusChip[];
  timeline: MonitoringTimelinePoint[];
  timelineGranularity: 'hour' | 'day';
  hourlyDistribution: MonitoringTimelinePoint[];
  modelShareRows: MonitoringModelShareRow[];
  channelRows: MonitoringChannelRow[];
  modelRows: MonitoringModelRow[];
  failureSourceRows: MonitoringFailureSourceRow[];
  taskBuckets: MonitoringTaskBucketRow[];
  recentFailures: MonitoringFailureRow[];
  filteredRows: MonitoringEventRow[];
  refreshMeta: (showLoading?: boolean) => Promise<void>;
}

type MonitoringMetaPayload = {
  authFiles: AuthFileItem[];
  channels: MonitoringChannelMeta[];
  error: string;
};

const normalizeOpenAIChannel = (value: unknown, index: number): MonitoringChannelMeta | null => {
  if (!isRecord(value)) return null;

  const name = readString(value.name || value.id) || `openai-${index + 1}`;
  const baseUrl = readString(value['base-url'] ?? value.baseUrl);
  if (!baseUrl) return null;

  const authIndices = new Set<string>();
  const providerAuthIndex = normalizeAuthIndex(
    value['auth-index'] ?? value.authIndex ?? value['auth_index']
  );
  if (providerAuthIndex) {
    authIndices.add(providerAuthIndex);
  }

  const apiKeyEntries = Array.isArray(value['api-key-entries']) ? value['api-key-entries'] : [];
  apiKeyEntries.forEach((entry) => {
    if (!isRecord(entry)) return;
    const authIndex = normalizeAuthIndex(
      entry['auth-index'] ?? entry.authIndex ?? entry['auth_index']
    );
    if (authIndex) {
      authIndices.add(authIndex);
    }
  });

  const modelNames = Array.isArray(value.models)
    ? value.models
        .map((item) => {
          if (typeof item === 'string') return readString(item);
          if (!isRecord(item)) return '';
          return readString(item.name ?? item.alias ?? item.id ?? item.model);
        })
        .filter(Boolean)
    : [];

  return {
    key: `${name}:${index}`,
    name,
    baseUrl,
    host: extractHost(baseUrl),
    disabled: parseBoolean(value.disabled),
    authIndices: Array.from(authIndices),
    modelNames: Array.from(new Set(modelNames)),
  };
};

const readAuthTimestamp = (entry: AuthFileItem) =>
  readString(entry['updated_at'] ?? entry.updatedAt ?? entry['modtime'] ?? entry.modified);

const normalizeAuthMeta = (entry: AuthFileItem): MonitoringAuthMeta | null => {
  const authIndex = normalizeAuthIndex(entry['auth_index'] ?? entry.authIndex);
  if (!authIndex) return null;

  const label =
    readString(entry.label) ||
    readString(entry.name) ||
    readString(entry.email) ||
    readString(entry.account) ||
    authIndex;

  const planType = readString(
    isRecord(entry.id_token) ? entry.id_token.plan_type : entry['plan_type']
  );

  return {
    authIndex,
    label,
    account: readString(entry.account) || readString(entry.email) || label,
    provider: readString(entry.provider) || readString(entry.type) || '-',
    status: readString(entry.status) || 'unknown',
    disabled: parseBoolean(entry.disabled),
    unavailable: parseBoolean(entry.unavailable),
    runtimeOnly: parseBoolean(entry.runtime_only ?? entry.runtimeOnly),
    planType: planType || '-',
    updatedAt: readAuthTimestamp(entry),
  };
};

const buildRangeFilteredRows = (
  rows: MonitoringEventRow[],
  timeRange: MonitoringTimeRange,
  searchQuery: string
) => {
  const nowMs = Date.now();
  const startMs = getRangeStartMs(timeRange, nowMs);
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return rows.filter((row) => {
    if (row.timestampMs > nowMs || row.timestampMs < startMs) {
      return false;
    }

    if (normalizedQuery && !row.searchText.includes(normalizedQuery)) {
      return false;
    }

    return true;
  });
};

const buildTimeline = (
  rows: MonitoringEventRow[],
  timeRange: MonitoringTimeRange
): { granularity: 'hour' | 'day'; points: MonitoringTimelinePoint[] } => {
  if (timeRange === 'today') {
    const map = new Map<string, MonitoringTimelinePoint>();

    for (let hour = 0; hour < 24; hour += 1) {
      const label = `${padNumber(hour)}:00`;
      map.set(label, { label, requests: 0, tokens: 0, cost: 0 });
    }

    rows.forEach((row) => {
      const bucket = map.get(row.hourLabel);
      if (!bucket) return;
      bucket.requests += 1;
      bucket.tokens += row.totalTokens;
      bucket.cost += row.totalCost;
    });

    return { granularity: 'hour', points: Array.from(map.values()) };
  }

  const grouped = new Map<string, MonitoringTimelinePoint>();

  rows.forEach((row) => {
    const existing = grouped.get(row.dayKey) ?? {
      label: buildDayLabel(row.dayKey),
      requests: 0,
      tokens: 0,
      cost: 0,
    };
    existing.requests += 1;
    existing.tokens += row.totalTokens;
    existing.cost += row.totalCost;
    grouped.set(row.dayKey, existing);
  });

  const sortedKeys = Array.from(grouped.keys()).sort((left, right) => left.localeCompare(right));
  const limitedKeys =
    sortedKeys.length > 30 ? sortedKeys.slice(sortedKeys.length - 30) : sortedKeys;

  return {
    granularity: 'day',
    points: limitedKeys.map((key) => grouped.get(key)!).filter(Boolean),
  };
};

const buildHourlyDistribution = (rows: MonitoringEventRow[]) => {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    label: `${padNumber(hour)}:00`,
    requests: 0,
    tokens: 0,
    cost: 0,
  }));

  rows.forEach((row) => {
    const hour = Number(row.hourLabel.slice(0, 2));
    const bucket = Number.isFinite(hour) ? buckets[hour] : null;
    if (!bucket) return;
    bucket.requests += 1;
    bucket.tokens += row.totalTokens;
    bucket.cost += row.totalCost;
  });

  return buckets;
};

const buildRecentPattern = (rows: MonitoringEventRow[], limit = 10) =>
  rows
    .slice()
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, limit)
    .reverse()
    .map((row) => !row.failed);

export const buildMonitoringSummary = (rows: MonitoringEventRow[]): MonitoringSummary => {
  const totalCalls = rows.length;
  const failureCalls = rows.filter((row) => row.failed).length;
  const successCalls = Math.max(totalCalls - failureCalls, 0);
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const reasoningTokens = rows.reduce((sum, row) => sum + row.reasoningTokens, 0);
  const cachedTokens = rows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);

  let latencySum = 0;
  let latencyCount = 0;
  rows.forEach((row) => {
    if (row.latencyMs === null) return;
    latencySum += row.latencyMs;
    latencyCount += 1;
  });

  const taskMap = new Map<string, boolean>();
  rows.forEach((row) => {
    const existing = taskMap.get(row.taskKey) ?? false;
    taskMap.set(row.taskKey, existing || row.failed);
  });

  const approxTasks = taskMap.size;
  const approxTaskFailures = Array.from(taskMap.values()).filter(Boolean).length;
  const zeroTokenRows = rows.filter((row) => row.totalTokens === 0);

  const activeDays = new Set(rows.map((row) => row.dayKey));
  const activeDayCount = Math.max(activeDays.size, 1);
  const nowMs = Date.now();
  const windowStart = nowMs - 30 * 60 * 1000;
  const recentRows = rows.filter((row) => row.timestampMs >= windowStart && row.timestampMs <= nowMs);
  const recentTokens = recentRows.reduce((sum, row) => sum + row.totalTokens, 0);

  return {
    totalCalls,
    successCalls,
    failureCalls,
    successRate: totalCalls > 0 ? successCalls / totalCalls : 1,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    totalCost,
    averageLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    rpm30m: recentRows.length / 30,
    tpm30m: recentTokens / 30,
    avgDailyRequests: totalCalls / activeDayCount,
    avgDailyTokens: totalTokens / activeDayCount,
    approxTasks,
    approxTaskFailures,
    approxTaskSuccessRate:
      approxTasks > 0 ? Math.max(approxTasks - approxTaskFailures, 0) / approxTasks : 1,
    zeroTokenCalls: zeroTokenRows.length,
    zeroTokenModels: Array.from(new Set(zeroTokenRows.map((row) => row.model))).sort(),
  };
};

export const buildAccountRows = (rows: MonitoringEventRow[]): MonitoringAccountRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      account: string;
      accountMasked: string;
      authLabels: Set<string>;
      authIndices: Set<string>;
      channels: Set<string>;
      modelMap: Map<
        string,
        {
          model: string;
          totalCalls: number;
          successCalls: number;
          failureCalls: number;
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          totalTokens: number;
          totalCost: number;
          lastSeenAt: number;
        }
      >;
      rows: MonitoringEventRow[];
      totalCalls: number;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const accountKey = row.account || row.authLabel || row.source;
    const existing = grouped.get(accountKey) ?? {
      id: accountKey,
      account: row.account,
      accountMasked: row.accountMasked,
      authLabels: new Set<string>(),
      authIndices: new Set<string>(),
      channels: new Set<string>(),
      modelMap: new Map(),
      rows: [] as MonitoringEventRow[],
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };

    existing.rows.push(row);
    existing.authLabels.add(row.authLabel);
    existing.authIndices.add(row.authIndexMasked);
    existing.channels.add(row.channel);
    existing.totalCalls += 1;
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    const modelEntry = existing.modelMap.get(row.model) ?? {
      model: row.model,
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      lastSeenAt: 0,
    };

    modelEntry.totalCalls += 1;
    modelEntry.successCalls += row.failed ? 0 : 1;
    modelEntry.failureCalls += row.failed ? 1 : 0;
    modelEntry.inputTokens += row.inputTokens;
    modelEntry.outputTokens += row.outputTokens;
    modelEntry.cachedTokens += row.cachedTokens;
    modelEntry.totalTokens += row.totalTokens;
    modelEntry.totalCost += row.totalCost;
    modelEntry.lastSeenAt = Math.max(modelEntry.lastSeenAt, row.timestampMs);
    existing.modelMap.set(row.model, modelEntry);

    grouped.set(accountKey, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      id: item.id,
      account: item.account,
      accountMasked: item.accountMasked,
      authLabels: Array.from(item.authLabels).sort(),
      authIndices: Array.from(item.authIndices).sort(),
      channels: Array.from(item.channels).sort(),
      totalCalls: item.totalCalls,
      successCalls: item.successCalls,
      failureCalls: item.failureCalls,
      successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cachedTokens: item.cachedTokens,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      lastSeenAt: item.lastSeenAt,
      recentPattern: buildRecentPattern(item.rows),
      models: Array.from(item.modelMap.values())
        .map((model) => ({
          ...model,
          successRate: model.totalCalls > 0 ? model.successCalls / model.totalCalls : 1,
        }))
        .sort((left, right) => right.totalCost - left.totalCost || right.totalCalls - left.totalCalls),
    }))
    .sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        right.totalCalls - left.totalCalls ||
        right.totalCost - left.totalCost
    );
};

export const buildApiKeyRows = (rows: MonitoringEventRow[]): MonitoringApiKeyRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      apiKey: string;
      apiKeyHash: string;
      apiKeyLabel: string;
      sources: Set<string>;
      accounts: Set<string>;
      providers: Set<string>;
      channels: Set<string>;
      models: Set<string>;
      totalCalls: number;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const apiKey = row.apiKey.trim();
    const apiKeyHash = row.apiKeyHash.trim();
    const id = apiKey || apiKeyHash || UNKNOWN_API_KEY_ID;
    const existing = grouped.get(id) ?? {
      id,
      apiKey,
      apiKeyHash,
      apiKeyLabel: apiKey || row.apiKeyLabel || formatApiKeyHashLabel(apiKeyHash),
      sources: new Set<string>(),
      accounts: new Set<string>(),
      providers: new Set<string>(),
      channels: new Set<string>(),
      models: new Set<string>(),
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };

    existing.sources.add(row.source);
    existing.accounts.add(row.account);
    existing.providers.add(row.provider);
    existing.channels.add(row.channel);
    existing.models.add(row.model);
    existing.totalCalls += 1;
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    grouped.set(id, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      id: item.id,
      apiKey: item.apiKey,
      apiKeyHash: item.apiKeyHash,
      apiKeyLabel: item.apiKeyLabel,
      sources: Array.from(item.sources).filter(Boolean).sort(),
      accounts: Array.from(item.accounts).filter(Boolean).sort(),
      providers: Array.from(item.providers).filter(Boolean).sort(),
      channels: Array.from(item.channels).filter(Boolean).sort(),
      models: Array.from(item.models).filter(Boolean).sort(),
      totalCalls: item.totalCalls,
      successCalls: item.successCalls,
      failureCalls: item.failureCalls,
      successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cachedTokens: item.cachedTokens,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      lastSeenAt: item.lastSeenAt,
    }))
    .sort(
      (left, right) =>
        right.totalCalls - left.totalCalls ||
        right.totalTokens - left.totalTokens ||
        right.lastSeenAt - left.lastSeenAt ||
        left.apiKeyLabel.localeCompare(right.apiKeyLabel)
    );
};

export const buildRealtimeMonitorRows = (rows: MonitoringEventRow[]): MonitoringRealtimeRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      account: string;
      accountMasked: string;
      authLabel: string;
      authIndexMasked: string;
      provider: string;
      requestType: string;
      model: string;
      channel: string;
      rows: MonitoringEventRow[];
      latestFailed: boolean;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      latestLatencyMs: number | null;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const requestType = `${row.endpointMethod} ${row.endpointPath}`.trim();
    const key = [
      row.account || row.authLabel || row.source,
      row.authIndexMasked,
      row.provider,
      row.model,
      row.channel,
      requestType,
    ].join('::');

    const existing = grouped.get(key) ?? {
      id: key,
      account: row.account,
      accountMasked: row.accountMasked,
      authLabel: row.authLabel,
      authIndexMasked: row.authIndexMasked,
      provider: row.provider,
      requestType,
      model: row.model,
      channel: row.channel,
      rows: [] as MonitoringEventRow[],
      latestFailed: row.failed,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      latestLatencyMs: null,
      lastSeenAt: 0,
    };

    existing.rows.push(row);
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;

    if (row.timestampMs >= existing.lastSeenAt) {
      existing.lastSeenAt = row.timestampMs;
      existing.latestFailed = row.failed;
      existing.latestLatencyMs = row.latencyMs;
    }

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map((item) => {
      const totalCalls = item.successCalls + item.failureCalls;
      return {
        id: item.id,
        account: item.account,
        accountMasked: item.accountMasked,
        authLabel: item.authLabel,
        authIndexMasked: item.authIndexMasked,
        provider: item.provider,
        requestType: item.requestType,
        model: item.model,
        channel: item.channel,
        latestFailed: item.latestFailed,
        successRate: totalCalls > 0 ? item.successCalls / totalCalls : 1,
        totalCalls,
        successCalls: item.successCalls,
        failureCalls: item.failureCalls,
        averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
        latestLatencyMs: item.latestLatencyMs,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedTokens: item.cachedTokens,
        totalTokens: item.totalTokens,
        totalCost: item.totalCost,
        lastSeenAt: item.lastSeenAt,
        recentPattern: buildRecentPattern(item.rows),
      };
    })
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.totalCalls - left.totalCalls);
};

const buildStatusChips = (metadata: MonitoringMetadata): MonitoringStatusChip[] => [
  {
    key: 'credentials',
    label: 'credentials',
    value: `${metadata.activeAuthFiles}/${metadata.totalAuthFiles}`,
    tone:
      metadata.totalAuthFiles === 0
        ? 'warn'
        : metadata.unavailableAuthFiles > 0
          ? 'warn'
          : 'good',
  },
  {
    key: 'channels',
    label: 'channels',
    value: `${metadata.enabledChannels}/${metadata.totalChannels}`,
    tone: metadata.enabledChannels === 0 ? 'bad' : metadata.enabledChannels < metadata.totalChannels ? 'warn' : 'good',
  },
  {
    key: 'runtime_only',
    label: 'runtime_only',
    value: String(metadata.runtimeOnlyAuthFiles),
    tone: metadata.runtimeOnlyAuthFiles > 0 ? 'warn' : 'good',
  },
  {
    key: 'models',
    label: 'models',
    value: String(metadata.configuredModels),
    tone: metadata.configuredModels > 0 ? 'good' : 'warn',
  },
];

const buildModelShareRows = (rows: MonitoringEventRow[]) => {
  const grouped = new Map<
    string,
    { model: string; requests: number; failures: number; totalTokens: number; totalCost: number }
  >();

  rows.forEach((row) => {
    const existing = grouped.get(row.model) ?? {
      model: row.model,
      requests: 0,
      failures: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    existing.requests += 1;
    existing.failures += row.failed ? 1 : 0;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    grouped.set(row.model, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      model: item.model,
      requests: item.requests,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      successRate: item.requests > 0 ? (item.requests - item.failures) / item.requests : 1,
    }))
    .sort((left, right) => right.requests - left.requests);
};

const buildChannelRows = (rows: MonitoringEventRow[]) => {
  const grouped = new Map<
    string,
    {
      id: string;
      label: string;
      host: string;
      provider: string;
      disabled: boolean;
      authLabels: Set<string>;
      planTypes: Set<string>;
      models: Set<string>;
      requests: number;
      failures: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
    }
  >();

  rows.forEach((row) => {
    const key = `${row.channel}::${row.channelHost}`;
    const existing = grouped.get(key) ?? {
      id: key,
      label: row.channel,
      host: row.channelHost,
      provider: row.provider,
      disabled: row.channelDisabled,
      authLabels: new Set<string>(),
      planTypes: new Set<string>(),
      models: new Set<string>(),
      requests: 0,
      failures: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
    };
    existing.disabled = existing.disabled || row.channelDisabled;
    existing.authLabels.add(row.authLabel);
    if (row.planType && row.planType !== '-') {
      existing.planTypes.add(row.planType);
    }
    existing.models.add(row.model);
    existing.requests += 1;
    existing.failures += row.failed ? 1 : 0;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }
    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      id: item.id,
      label: item.label,
      host: item.host,
      provider: item.provider,
      planTypes: Array.from(item.planTypes).sort(),
      disabled: item.disabled,
      authCount: item.authLabels.size,
      modelCount: item.models.size,
      requests: item.requests,
      failures: item.failures,
      successRate: item.requests > 0 ? (item.requests - item.failures) / item.requests : 1,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      authLabels: Array.from(item.authLabels).sort(),
    }))
    .sort((left, right) => right.requests - left.requests);
};

const buildModelRows = (rows: MonitoringEventRow[]) => {
  const grouped = new Map<
    string,
    {
      model: string;
      requests: number;
      failures: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      sources: Set<string>;
      channels: Set<string>;
    }
  >();

  rows.forEach((row) => {
    const existing = grouped.get(row.model) ?? {
      model: row.model,
      requests: 0,
      failures: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      sources: new Set<string>(),
      channels: new Set<string>(),
    };

    existing.requests += 1;
    existing.failures += row.failed ? 1 : 0;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.sources.add(row.source);
    existing.channels.add(row.channel);
    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    grouped.set(row.model, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      model: item.model,
      requests: item.requests,
      failures: item.failures,
      successRate: item.requests > 0 ? (item.requests - item.failures) / item.requests : 1,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      sources: item.sources.size,
      channels: item.channels.size,
    }))
    .sort((left, right) => right.requests - left.requests);
};

const buildFailureSourceRows = (rows: MonitoringEventRow[]) => {
  const grouped = new Map<
    string,
    {
      id: string;
      label: string;
      channel: string;
      failures: number;
      totalRequests: number;
      lastSeenAt: number;
      latencySum: number;
      latencyCount: number;
    }
  >();

  rows.forEach((row) => {
    const key = `${row.source}::${row.channel}`;
    const existing = grouped.get(key) ?? {
      id: key,
      label: row.sourceMasked,
      channel: row.channel,
      failures: 0,
      totalRequests: 0,
      lastSeenAt: 0,
      latencySum: 0,
      latencyCount: 0,
    };

    existing.totalRequests += 1;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);
    if (row.failed) {
      existing.failures += 1;
      if (row.latencyMs !== null) {
        existing.latencySum += row.latencyMs;
        existing.latencyCount += 1;
      }
    }

    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .filter((item) => item.failures > 0)
    .map((item) => ({
      id: item.id,
      label: item.label,
      channel: item.channel,
      failures: item.failures,
      totalRequests: item.totalRequests,
      failureRate: item.totalRequests > 0 ? item.failures / item.totalRequests : 0,
      lastSeenAt: item.lastSeenAt,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
    }))
    .sort((left, right) => right.failures - left.failures || right.lastSeenAt - left.lastSeenAt);
};

const buildTaskBuckets = (rows: MonitoringEventRow[]) => {
  const grouped = new Map<
    string,
    {
      id: string;
      timestampMs: number;
      timestamp: string;
      source: string;
      sourceMasked: string;
      channel: string;
      authLabel: string;
      planType: string;
      calls: number;
      failedCalls: number;
      models: Set<string>;
      endpoints: Set<string>;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      maxLatencyMs: number | null;
    }
  >();

  rows.forEach((row) => {
    const existing = grouped.get(row.taskKey) ?? {
      id: row.taskKey,
      timestampMs: row.timestampMs,
      timestamp: row.timestamp,
      source: row.source,
      sourceMasked: row.sourceMasked,
      channel: row.channel,
      authLabel: row.authLabel,
      planType: row.planType,
      calls: 0,
      failedCalls: 0,
      models: new Set<string>(),
      endpoints: new Set<string>(),
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      maxLatencyMs: null,
    };

    existing.calls += 1;
    existing.failedCalls += row.failed ? 1 : 0;
    existing.models.add(row.model);
    existing.endpoints.add(row.endpointPath || row.endpoint);
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
      existing.maxLatencyMs = Math.max(existing.maxLatencyMs ?? 0, row.latencyMs);
    }

    grouped.set(row.taskKey, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      id: item.id,
      timestampMs: item.timestampMs,
      timestamp: item.timestamp,
      source: item.source,
      sourceMasked: item.sourceMasked,
      channel: item.channel,
      authLabel: item.authLabel,
      planType: item.planType,
      calls: item.calls,
      failedCalls: item.failedCalls,
      failed: item.failedCalls > 0,
      modelsText: joinUnique(item.models, 3),
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      maxLatencyMs: item.maxLatencyMs,
      endpointsText: joinUnique(item.endpoints, 2),
    }))
    .sort((left, right) => right.timestampMs - left.timestampMs);
};

const buildFailureRows = (rows: MonitoringEventRow[]) =>
  rows
    .filter((row) => row.failed)
    .map((row) => ({
      id: row.id,
      timestampMs: row.timestampMs,
      timestamp: row.timestamp,
      model: row.model,
      source: row.sourceMasked,
      channel: row.channel,
      authIndex: row.authIndexMasked,
      latencyMs: row.latencyMs,
    }))
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, 8);

const buildEventRows = (
  details: UsageDetailWithEndpoint[],
  authMetaMap: Map<string, MonitoringAuthMeta>,
  authFileMap: Map<string, CredentialInfo>,
  sourceInfoMap: ReturnType<typeof buildSourceInfoMap>,
  channelByAuthIndex: Map<string, MonitoringChannelMeta>,
  modelPrices: Record<string, ModelPrice>,
  apiKeyHashMap: Record<string, string>
) =>
  details
    .map((detail, index) => {
      const timestampMs =
        typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
          ? detail.__timestampMs
          : Date.parse(detail.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
        return null;
      }

      const authIndex = normalizeAuthIndex(detail.auth_index) ?? '-';
      const authMeta = authMetaMap.get(authIndex);
      const sourceMeta = resolveSourceDisplay(detail.source, detail.auth_index, sourceInfoMap, authFileMap);
      const sourceLabel = authMeta?.label || sourceMeta.displayName || authIndex;
      const sourceMasked = maskEmailLike(sourceLabel);
      const account = authMeta?.account || sourceLabel;
      const accountMasked = maskEmailLike(account);
      const channelMeta = channelByAuthIndex.get(authIndex);
      const channelLabel = channelMeta?.name || authMeta?.provider || sourceMeta.type || '-';
      const endpoint = readString(detail.__endpoint) || '-';
      const endpointMethod = readString(detail.__endpointMethod) || '-';
      const endpointPath = readString(detail.__endpointPath) || endpoint;
      const inputTokens = Math.max(Number(detail.tokens?.input_tokens) || 0, 0);
      const outputTokens = Math.max(Number(detail.tokens?.output_tokens) || 0, 0);
      const reasoningTokens = Math.max(Number(detail.tokens?.reasoning_tokens) || 0, 0);
      const cachedTokens = Math.max(
        Math.max(Number(detail.tokens?.cached_tokens) || 0, 0),
        Math.max(Number(detail.tokens?.cache_tokens) || 0, 0)
      );
      const totalTokens = Math.max(Number(detail.tokens?.total_tokens) || 0, extractTotalTokens(detail));
      const totalCost = calculateCost(detail, modelPrices);
      const statsIncluded = detail.failed === true || inputTokens > 0 || outputTokens > 0;
      const dayKey = buildLocalDayKey(timestampMs);
      const hourLabel = buildHourLabel(timestampMs);
      const apiKeyHash = readString(detail.api_key_hash);
      const apiKey = readString(detail.api_key) || (apiKeyHash ? apiKeyHashMap[apiKeyHash] ?? '' : '');
      const apiKeyLabel = apiKey || formatApiKeyHashLabel(apiKeyHash);
      const sourceKey = sourceMeta.identityKey || `source:${sourceLabel}`;
      const taskKey = `${detail.timestamp}|${sourceKey}|${authIndex}`;

      return {
        id: `${detail.timestamp}-${detail.__modelName || '-'}-${sourceKey}-${authIndex}-${index}`,
        timestamp: detail.timestamp,
        timestampMs,
        dayKey,
        hourLabel,
        model: readString(detail.__modelName) || '-',
        endpoint,
        endpointMethod,
        endpointPath,
        apiKey,
        apiKeyHash,
        apiKeyLabel,
        sourceKey,
        source: sourceLabel,
        sourceMasked,
        account,
        accountMasked,
        authIndex,
        authIndexMasked: maskAuthIndex(authIndex),
        authLabel: authMeta?.label || sourceMasked,
        provider: authMeta?.provider || sourceMeta.type || '-',
        planType: authMeta?.planType || '-',
        channel: channelLabel,
        channelHost: channelMeta?.host || '-',
        channelDisabled: channelMeta?.disabled || false,
        failed: detail.failed === true,
        statsIncluded,
        latencyMs: typeof detail.latency_ms === 'number' ? detail.latency_ms : null,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
        totalCost,
        taskKey,
        searchText: buildSearchText(
          detail.__modelName,
          apiKey,
          apiKeyHash,
          apiKeyLabel,
          sourceLabel,
          authMeta?.account,
          authMeta?.label,
          authIndex,
          channelLabel,
          channelMeta?.host,
          endpointPath,
          endpointMethod,
          authMeta?.provider,
          authMeta?.planType
        ),
      } satisfies MonitoringEventRow;
    })
    .filter(Boolean) as MonitoringEventRow[];

const loadMonitoringMetaPayload = async (
  config: Config | null | undefined
): Promise<MonitoringMetaPayload> => {
  const [authResult, channelResult] = await Promise.allSettled([
    authFilesApi.list(),
    apiClient.get('/openai-compatibility'),
  ]);

  const authFiles =
    authResult.status === 'fulfilled' && Array.isArray(authResult.value.files)
      ? authResult.value.files
      : [];

  let channels: MonitoringChannelMeta[] = [];

  if (channelResult.status === 'fulfilled') {
    channels = extractArrayPayload(channelResult.value, 'openai-compatibility')
      .map((item, index) => normalizeOpenAIChannel(item, index))
      .filter(Boolean) as MonitoringChannelMeta[];
  } else if (config?.openaiCompatibility?.length) {
    channels = config.openaiCompatibility
      .map((item, index) =>
        normalizeOpenAIChannel(
          {
            ...item,
            'base-url': item.baseUrl,
            'api-key-entries': item.apiKeyEntries,
            models: item.models,
          },
          index
        )
      )
      .filter(Boolean) as MonitoringChannelMeta[];
  }

  const error = [authResult, channelResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => (result.status === 'rejected' ? result.reason : null))
    .filter(Boolean)
    .map((err) => (err instanceof Error ? err.message : String(err)))
    .join('；');

  return { authFiles, channels, error };
};

export function useMonitoringData({
  usage,
  config,
  modelPrices,
  apiKeyHashMap = {},
  timeRange,
  searchQuery,
}: UseMonitoringDataParams): UseMonitoringDataReturn {
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [channels, setChannels] = useState<MonitoringChannelMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refreshMeta = useCallback(async (showLoading: boolean = true) => {
    if (showLoading) {
      setLoading(true);
      setError('');
    }

    const payload = await loadMonitoringMetaPayload(config);
    setAuthFiles(payload.authFiles);
    setChannels(payload.channels);
    setError(payload.error);
    setLoading(false);
  }, [config]);

  useEffect(() => {
    let cancelled = false;

    loadMonitoringMetaPayload(config).then((payload) => {
      if (cancelled) return;
      setAuthFiles(payload.authFiles);
      setChannels(payload.channels);
      setError(payload.error);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [config]);

  const authMetaMap = useMemo(() => {
    const map = new Map<string, MonitoringAuthMeta>();
    authFiles.forEach((entry) => {
      const normalized = normalizeAuthMeta(entry);
      if (!normalized) return;
      map.set(normalized.authIndex, normalized);
    });
    return map;
  }, [authFiles]);

  const authFileMap = useMemo(() => {
    const map = new Map<string, CredentialInfo>();
    authFiles.forEach((entry) => {
      const authIndex = normalizeAuthIndex(entry['auth_index'] ?? entry.authIndex);
      if (!authIndex) return;
      map.set(authIndex, {
        name:
          readString(entry.label) ||
          readString(entry.name) ||
          readString(entry.email) ||
          readString(entry.account) ||
          authIndex,
        type: readString(entry.provider) || readString(entry.type),
      });
    });
    return map;
  }, [authFiles]);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: config?.geminiApiKeys || [],
        claudeApiKeys: config?.claudeApiKeys || [],
        codexApiKeys: config?.codexApiKeys || [],
        vertexApiKeys: config?.vertexApiKeys || [],
        openaiCompatibility: config?.openaiCompatibility || [],
      }),
    [config]
  );

  const channelByAuthIndex = useMemo(() => {
    const map = new Map<string, MonitoringChannelMeta>();
    channels.forEach((channel) => {
      channel.authIndices.forEach((authIndex) => {
        map.set(authIndex, channel);
      });
    });
    return map;
  }, [channels]);

  const allRows = useMemo(() => {
    const details = collectUsageDetailsWithEndpoint(usage);
    return buildEventRows(details, authMetaMap, authFileMap, sourceInfoMap, channelByAuthIndex, modelPrices, apiKeyHashMap).sort(
      (left, right) => right.timestampMs - left.timestampMs
    );
  }, [apiKeyHashMap, authFileMap, authMetaMap, channelByAuthIndex, modelPrices, sourceInfoMap, usage]);

  const filteredRows = useMemo(
    () => buildRangeFilteredRows(allRows, timeRange, searchQuery),
    [allRows, searchQuery, timeRange]
  );
  const statsRows = useMemo(() => filteredRows.filter(shouldIncludeInStats), [filteredRows]);

  const summary = useMemo(() => buildMonitoringSummary(statsRows), [statsRows]);
  const timelineData = useMemo(() => buildTimeline(statsRows, timeRange), [statsRows, timeRange]);
  const hourlyDistribution = useMemo(() => buildHourlyDistribution(statsRows), [statsRows]);
  const modelShareRows = useMemo(() => buildModelShareRows(statsRows), [statsRows]);
  const channelRows = useMemo(() => buildChannelRows(statsRows), [statsRows]);
  const modelRows = useMemo(() => buildModelRows(statsRows), [statsRows]);
  const failureSourceRows = useMemo(() => buildFailureSourceRows(statsRows), [statsRows]);
  const taskBuckets = useMemo(() => buildTaskBuckets(statsRows), [statsRows]);
  const recentFailures = useMemo(() => buildFailureRows(statsRows), [statsRows]);

  const metadata = useMemo<MonitoringMetadata>(() => {
    const planTypes = Array.from(
      new Set(Array.from(authMetaMap.values()).map((item) => item.planType).filter((item) => item && item !== '-'))
    ).sort();

    return {
      totalAuthFiles: authFiles.length,
      activeAuthFiles: Array.from(authMetaMap.values()).filter(
        (item) => !item.disabled && !item.unavailable && item.status === 'active'
      ).length,
      unavailableAuthFiles: Array.from(authMetaMap.values()).filter((item) => item.unavailable).length,
      runtimeOnlyAuthFiles: Array.from(authMetaMap.values()).filter((item) => item.runtimeOnly).length,
      totalChannels: channels.length,
      enabledChannels: channels.filter((item) => !item.disabled).length,
      configuredModels: Array.from(new Set(channels.flatMap((item) => item.modelNames))).length,
      planTypes,
    };
  }, [authFiles.length, authMetaMap, channels]);

  const statusChips = useMemo(() => buildStatusChips(metadata), [metadata]);

  return {
    loading,
    error,
    authFiles,
    channels,
    summary,
    metadata,
    statusChips,
    timeline: timelineData.points,
    timelineGranularity: timelineData.granularity,
    hourlyDistribution,
    modelShareRows,
    channelRows,
    modelRows,
    failureSourceRows,
    taskBuckets,
    recentFailures,
    filteredRows,
    refreshMeta,
  };
}
