import type {
  CodexAnalyticsClientSummary,
  CodexAnalyticsRange,
  CodexAnalyticsState,
  CodexDailyUsageDay,
  CodexDailyUsageMetrics,
  CodexDailyUsagePayload,
  CodexUsageWindow,
  CodexWeeklyEstimate,
} from '@/types';
import { CODEX_ANALYTICS_ROLLING_DAYS, CODEX_USD_PER_CREDIT } from './constants';
import { normalizeNumberValue, normalizeStringValue } from './parsers';

const CODEX_DAY_MS = 24 * 60 * 60 * 1000;
const CODEX_TOP_CLIENT_LIMIT = 3;

export type CodexAnalyticsQueryRanges = {
  apiNowMs: number;
  resetAtMs: number;
  windowStartMs: number;
  endDateExclusive: string;
  sinceResetStartDate: string;
  monthStartDate: string;
  rollingStartDate: string;
};

export type BuildCodexAnalyticsStateParams = {
  weeklyWindow: CodexUsageWindow;
  sinceResetPayload: CodexDailyUsagePayload;
  monthPayload: CodexDailyUsagePayload;
  rollingPayload: CodexDailyUsagePayload;
};

const roundCodexNumber = (value: number, digits = 2): number => {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const metricNumber = (value: unknown): number => normalizeNumberValue(value) ?? 0;

const codexTokenTotal = (metrics?: CodexDailyUsageMetrics | null): number => {
  if (!metrics) return 0;
  const explicit = metricNumber(metrics.text_total_tokens ?? metrics.textTotalTokens);
  if (explicit > 0) return explicit;
  return (
    metricNumber(metrics.cached_text_input_tokens ?? metrics.cachedTextInputTokens) +
    metricNumber(metrics.uncached_text_input_tokens ?? metrics.uncachedTextInputTokens) +
    metricNumber(metrics.text_output_tokens ?? metrics.textOutputTokens)
  );
};

export const codexYmdUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const codexFirstDayOfMonthUtc = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

export const formatCodexUtcDateTime = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

const normalizeCodexEpochMs = (value: number): number => (value > 1e12 ? value : value * 1000);

const getCodexWindowSeconds = (window?: CodexUsageWindow | null): number | null => {
  if (!window) return null;
  return normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
};

export const buildCodexAnalyticsQueryRanges = (
  weeklyWindow?: CodexUsageWindow | null
): CodexAnalyticsQueryRanges | null => {
  const resetAt = normalizeNumberValue(weeklyWindow?.reset_at ?? weeklyWindow?.resetAt);
  const windowSeconds = getCodexWindowSeconds(weeklyWindow);
  if (resetAt === null || windowSeconds === null) return null;

  const resetAfterSeconds = normalizeNumberValue(
    weeklyWindow?.reset_after_seconds ?? weeklyWindow?.resetAfterSeconds
  );
  const resetAtMs = normalizeCodexEpochMs(resetAt);
  const windowStartMs = resetAtMs - windowSeconds * 1000;
  const apiNowMs = resetAfterSeconds === null ? Date.now() : resetAtMs - resetAfterSeconds * 1000;

  return {
    apiNowMs,
    resetAtMs,
    windowStartMs,
    endDateExclusive: codexYmdUtc(apiNowMs + CODEX_DAY_MS),
    sinceResetStartDate: codexYmdUtc(windowStartMs),
    monthStartDate: codexFirstDayOfMonthUtc(apiNowMs),
    rollingStartDate: codexYmdUtc(apiNowMs - (CODEX_ANALYTICS_ROLLING_DAYS - 1) * CODEX_DAY_MS),
  };
};

const buildCodexClientSummary = (days: CodexDailyUsageDay[]): CodexAnalyticsClientSummary[] => {
  const clients = new Map<string, CodexAnalyticsClientSummary>();

  for (const day of days) {
    for (const client of day.clients ?? []) {
      const clientId = normalizeStringValue(client.client_id ?? client.clientId) ?? 'UNKNOWN';
      const current =
        clients.get(clientId) ??
        ({
          clientId,
          credits: 0,
          usd: 0,
          tokens: 0,
          threads: 0,
          turns: 0,
        } satisfies CodexAnalyticsClientSummary);

      const credits = metricNumber(client.credits);
      current.credits += credits;
      current.usd += credits * CODEX_USD_PER_CREDIT;
      current.tokens += codexTokenTotal(client);
      current.threads += metricNumber(client.threads);
      current.turns += metricNumber(client.turns);
      clients.set(clientId, current);
    }
  }

  return Array.from(clients.values())
    .map((client) => ({
      ...client,
      credits: roundCodexNumber(client.credits, 6),
      usd: roundCodexNumber(client.usd, 2),
      tokens: Math.round(client.tokens),
      threads: Math.round(client.threads),
      turns: Math.round(client.turns),
    }))
    .sort((left, right) => right.credits - left.credits)
    .slice(0, CODEX_TOP_CLIENT_LIMIT);
};

export const buildCodexAnalyticsRange = (
  payload: CodexDailyUsagePayload,
  id: CodexAnalyticsRange['id'],
  labelKey: string,
  startDate: string,
  endDateExclusive: string
): CodexAnalyticsRange => {
  const days = (payload.data ?? [])
    .slice()
    .sort((left, right) => String(left.date ?? '').localeCompare(String(right.date ?? '')));

  let credits = 0;
  let cachedInputTokens = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let tokens = 0;
  let threads = 0;
  let turns = 0;
  let users = 0;

  for (const day of days) {
    const totals = day.totals ?? {};
    credits += metricNumber(totals.credits);
    cachedInputTokens += metricNumber(
      totals.cached_text_input_tokens ?? totals.cachedTextInputTokens
    );
    uncachedInputTokens += metricNumber(
      totals.uncached_text_input_tokens ?? totals.uncachedTextInputTokens
    );
    outputTokens += metricNumber(totals.text_output_tokens ?? totals.textOutputTokens);
    tokens += codexTokenTotal(totals);
    threads += metricNumber(totals.threads);
    turns += metricNumber(totals.turns);
    users += metricNumber(totals.users);
  }

  return {
    id,
    labelKey,
    startDate,
    endDateExclusive,
    returnedDays: days.length,
    firstDate: days[0]?.date ?? '',
    lastDate: days[days.length - 1]?.date ?? '',
    credits: roundCodexNumber(credits, 6),
    usd: roundCodexNumber(credits * CODEX_USD_PER_CREDIT, 2),
    tokens: Math.round(tokens),
    cachedInputTokens: Math.round(cachedInputTokens),
    uncachedInputTokens: Math.round(uncachedInputTokens),
    outputTokens: Math.round(outputTokens),
    threads: Math.round(threads),
    turns: Math.round(turns),
    users: Math.round(users),
    topClients: buildCodexClientSummary(days),
  };
};

export const buildCodexWeeklyEstimate = (
  weeklyWindow: CodexUsageWindow,
  sinceResetRange: CodexAnalyticsRange,
  sinceResetPayload: CodexDailyUsagePayload,
  sinceResetStartDate: string
): CodexWeeklyEstimate | null => {
  const usedPercent = normalizeNumberValue(weeklyWindow.used_percent ?? weeklyWindow.usedPercent);
  if (usedPercent === null || usedPercent <= 0) return null;

  const usedRatio = usedPercent / 100;
  const includedCredits = sinceResetRange.credits;
  const resetDay = (sinceResetPayload.data ?? []).find((day) => day.date === sinceResetStartDate);
  const resetDayCredits = metricNumber(resetDay?.totals?.credits);
  const excludedCredits = Math.max(0, includedCredits - resetDayCredits);
  const totalCreditsWithResetDay = includedCredits / usedRatio;
  const totalCreditsWithoutResetDay = excludedCredits / usedRatio;
  const remainingCreditsWithResetDay = Math.max(0, totalCreditsWithResetDay - includedCredits);
  const remainingCreditsWithoutResetDay = Math.max(
    0,
    totalCreditsWithoutResetDay - excludedCredits
  );

  return {
    usedPercent: roundCodexNumber(usedPercent, 2),
    usedRatio: roundCodexNumber(usedRatio, 4),
    remainingRatio: roundCodexNumber(1 - usedRatio, 4),
    includedCredits: roundCodexNumber(includedCredits, 6),
    resetDayCredits: roundCodexNumber(resetDayCredits, 6),
    excludedCredits: roundCodexNumber(excludedCredits, 6),
    totalCreditsWithResetDay: roundCodexNumber(totalCreditsWithResetDay, 2),
    totalUsdWithResetDay: roundCodexNumber(totalCreditsWithResetDay * CODEX_USD_PER_CREDIT, 2),
    totalCreditsWithoutResetDay: roundCodexNumber(totalCreditsWithoutResetDay, 2),
    totalUsdWithoutResetDay: roundCodexNumber(
      totalCreditsWithoutResetDay * CODEX_USD_PER_CREDIT,
      2
    ),
    remainingCreditsWithResetDay: roundCodexNumber(remainingCreditsWithResetDay, 2),
    remainingUsdWithResetDay: roundCodexNumber(
      remainingCreditsWithResetDay * CODEX_USD_PER_CREDIT,
      2
    ),
    remainingCreditsWithoutResetDay: roundCodexNumber(remainingCreditsWithoutResetDay, 2),
    remainingUsdWithoutResetDay: roundCodexNumber(
      remainingCreditsWithoutResetDay * CODEX_USD_PER_CREDIT,
      2
    ),
  };
};

export const buildCodexAnalyticsState = ({
  weeklyWindow,
  sinceResetPayload,
  monthPayload,
  rollingPayload,
}: BuildCodexAnalyticsStateParams): CodexAnalyticsState => {
  const ranges = buildCodexAnalyticsQueryRanges(weeklyWindow);
  if (!ranges) {
    throw new Error('Missing Codex weekly quota window timing');
  }

  const sinceResetRange = buildCodexAnalyticsRange(
    sinceResetPayload,
    'since-reset',
    'codex_quota.analytics_since_reset',
    ranges.sinceResetStartDate,
    ranges.endDateExclusive
  );
  const monthRange = buildCodexAnalyticsRange(
    monthPayload,
    'month-to-date',
    'codex_quota.analytics_month_to_date',
    ranges.monthStartDate,
    ranges.endDateExclusive
  );
  const rollingRange = buildCodexAnalyticsRange(
    rollingPayload,
    'rolling',
    'codex_quota.analytics_rolling_days',
    ranges.rollingStartDate,
    ranges.endDateExclusive
  );

  return {
    dateBucket: 'UTC',
    backendNowLabel: formatCodexUtcDateTime(ranges.apiNowMs),
    windowStartLabel: formatCodexUtcDateTime(ranges.windowStartMs),
    resetAtLabel: formatCodexUtcDateTime(ranges.resetAtMs),
    weeklyEstimate: buildCodexWeeklyEstimate(
      weeklyWindow,
      sinceResetRange,
      sinceResetPayload,
      ranges.sinceResetStartDate
    ),
    ranges: [sinceResetRange, monthRange, rollingRange],
  };
};
