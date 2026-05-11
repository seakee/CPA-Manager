import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  IconChevronDown,
  IconChevronUp,
  IconChartLine,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconRefreshCw,
  IconSearch,
  IconSettings,
  IconSlidersHorizontal,
  IconTimer,
} from '@/components/ui/icons';
import {
  buildAccountRows,
  buildApiKeyRows,
  buildMonitoringSummary,
  buildRealtimeMonitorRows,
  useMonitoringData,
  type MonitoringAccountRow,
  type MonitoringCustomTimeRange,
  type MonitoringEventRow,
  type MonitoringStatusTone,
  type MonitoringTimeRange,
} from '@/features/monitoring/hooks/useMonitoringData';
import { useUsageData } from '@/features/monitoring/hooks/useUsageData';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import type {
  AuthFileItem,
  CodexRateLimitInfo,
  CodexUsagePayload,
  CodexUsageWindow,
} from '@/types';
import { formatFileSize, maskSensitiveText } from '@/utils/format';
import {
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  formatCodexResetLabel,
  isCodexFile,
  normalizeNumberValue,
  normalizePlanType,
  parseCodexUsagePayload,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
} from '@/utils/quota';
import {
  formatCompactNumber,
  formatDurationMs,
  formatUsd,
  normalizeAuthIndex,
  type ModelPrice,
} from '@/utils/usage';
import { downloadBlob } from '@/utils/download';
import styles from './MonitoringCenterPage.module.scss';

const TIME_RANGE_OPTIONS: Array<{ value: MonitoringTimeRange; labelKey: string }> = [
  { value: 'today', labelKey: 'monitoring.range_today' },
  { value: '7d', labelKey: 'monitoring.range_7d' },
  { value: '14d', labelKey: 'monitoring.range_14d' },
  { value: '30d', labelKey: 'monitoring.range_30d' },
  { value: 'all', labelKey: 'monitoring.range_all' },
  { value: 'custom', labelKey: 'monitoring.range_custom' },
];

const AUTO_REFRESH_OPTIONS = [
  { value: '0', labelKey: 'monitoring.auto_refresh_off' },
  { value: '5000', labelKey: 'monitoring.auto_refresh_5s' },
  { value: '10000', labelKey: 'monitoring.auto_refresh_10s' },
  { value: '30000', labelKey: 'monitoring.auto_refresh_30s' },
  { value: '60000', labelKey: 'monitoring.auto_refresh_60s' },
  { value: '300000', labelKey: 'monitoring.auto_refresh_5m' },
];

const ACCOUNT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const REALTIME_PAGE_SIZE_OPTIONS = [10, 50, 100, 150, 300] as const;
const DEFAULT_ACCOUNT_PAGE_SIZE = 10;
const DEFAULT_REALTIME_PAGE_SIZE = 10;
const MAX_USAGE_IMPORT_FILE_SIZE = 64 * 1024 * 1024;

const padDateUnit = (value: number) => String(value).padStart(2, '0');

const formatDateTimeLocalValue = (date: Date) =>
  `${date.getFullYear()}-${padDateUnit(date.getMonth() + 1)}-${padDateUnit(date.getDate())}T${padDateUnit(date.getHours())}:${padDateUnit(date.getMinutes())}`;

const getTodayStartInputValue = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return formatDateTimeLocalValue(date);
};

const getCurrentInputValue = () => formatDateTimeLocalValue(new Date());

const parseDateTimeLocalValue = (value: string) => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const DEFAULT_ACCOUNT_SORT = {
  key: 'lastSeenAt',
  direction: 'desc',
} as const;

const DEFAULT_API_KEY_SORT = {
  key: 'lastSeenAt',
  direction: 'desc',
} as const;

type StatusFilter = 'all' | 'success' | 'failed';

type PanelProps = {
  title?: string;
  subtitle?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
};

type SummaryCardProps = {
  label: string;
  value: string;
  meta: string;
  tone?: MonitoringStatusTone;
  variant?: 'primary' | 'secondary';
};

type FocusSnapshot = {
  searchInput: string;
  selectedAccount: string;
  selectedProvider: string;
  selectedModel: string;
  selectedChannel: string;
  selectedStatus: StatusFilter;
};

type PriceDraft = {
  prompt: string;
  completion: string;
  cache: string;
};

type RealtimeLogRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
};

type AccountQuotaTarget = {
  key: string;
  authIndex: string;
  authLabel: string;
  fileName: string;
  accountId: string | null;
  planType: string | null;
};

type AccountQuotaWindow = {
  id: string;
  label: string;
  remainingPercent: number | null;
  resetLabel: string;
};

type AccountQuotaEntry = {
  key: string;
  authLabel: string;
  fileName: string;
  planType: string | null;
  windows: AccountQuotaWindow[];
  error?: string;
};

type AccountQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  targetKey: string;
  entries: AccountQuotaEntry[];
  error?: string;
  lastRefreshedAt?: number;
};

type AccountSortKey =
  | 'totalCalls'
  | 'successCalls'
  | 'failureCalls'
  | 'totalTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedTokens'
  | 'totalCost'
  | 'lastSeenAt';

type AccountSortDirection = 'asc' | 'desc';

type AccountSortState = {
  key: AccountSortKey;
  direction: AccountSortDirection;
};

type ApiKeySortKey = AccountSortKey;
type ApiKeySortDirection = AccountSortDirection;
type ApiKeySortState = {
  key: ApiKeySortKey;
  direction: ApiKeySortDirection;
};

type AccountOverviewColumn = {
  key: string;
  label: string;
  sortKey?: AccountSortKey;
};

type AccountSummaryMetric = {
  key: string;
  label: string;
  value: string;
  valueClassName?: string;
};

type PaginationState<T> = {
  currentPage: number;
  totalPages: number;
  pageItems: T[];
  startItem: number;
  endItem: number;
};

type PaginationControlsProps = {
  count: number;
  currentPage: number;
  totalPages: number;
  startItem: number;
  endItem: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  t: TFunction;
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const isUsageImportFile = (file: File) => {
  const normalizedName = file.name.toLowerCase();
  const normalizedType = file.type.toLowerCase();
  return (
    /\.(json|jsonl|ndjson|txt)$/.test(normalizedName) ||
    normalizedType === 'application/json' ||
    normalizedType === 'application/x-ndjson' ||
    normalizedType === 'text/plain'
  );
};

const buildPaginationState = <T,>(
  items: readonly T[],
  page: number,
  pageSize: number
): PaginationState<T> => {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, items.length);

  return {
    currentPage,
    totalPages,
    pageItems: items.slice(startIndex, endIndex),
    startItem: items.length > 0 ? startIndex + 1 : 0,
    endItem: endIndex,
  };
};

const parsePageSize = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const joinShort = (values: string[], limit = 2) => {
  if (values.length <= limit) {
    return values.join(', ');
  }
  return `${values.slice(0, limit).join(', ')} +${values.length - limit}`;
};

const createPriceDraft = (price?: ModelPrice): PriceDraft => ({
  prompt: price ? String(price.prompt) : '',
  completion: price ? String(price.completion) : '',
  cache: price ? String(price.cache) : '',
});

const parsePriceValue = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const formatPriceUnit = (value: number) => `$${value.toFixed(4)}/1M`;

const buildRealtimeMetaText = (row: MonitoringEventRow) => {
  const text = `${row.endpointMethod} ${row.endpointPath}`.trim();
  return maskSensitiveText(text || '-');
};

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;
const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);

const getCodexPlanLabel = (planType: string | null | undefined, t: TFunction): string | null => {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || normalized;
};

const buildAccountSecondaryText = (row: MonitoringAccountRow) => {
  const primaryText = row.displayAccount || row.account;
  if (row.account && row.account !== primaryText) {
    return row.account;
  }

  const extraAuthLabels = row.authLabels.filter((label) => label && label !== primaryText);
  if (extraAuthLabels.length > 0) {
    return joinShort(extraAuthLabels, 2);
  }
  const extraChannels = row.channels.filter((label) => label && label !== '-' && label !== primaryText);
  if (extraChannels.length > 0) {
    return joinShort(extraChannels, 2);
  }
  return '';
};

const buildAccountOptionLabel = (row: MonitoringAccountRow) => {
  if (!row.displayAccount || row.displayAccount === row.account) {
    return row.account;
  }
  return `${row.displayAccount} / ${row.account}`;
};

const buildAccountSummaryMetrics = (
  row: MonitoringAccountRow,
  hasPrices: boolean,
  locale: string,
  t: TFunction
): AccountSummaryMetric[] => [
  {
    key: 'total-calls',
    label: t('monitoring.total_calls'),
    value: formatCompactNumber(row.totalCalls),
  },
  {
    key: 'success-calls',
    label: t('monitoring.success_calls'),
    value: formatCompactNumber(row.successCalls),
    valueClassName: styles.goodText,
  },
  {
    key: 'failure-calls',
    label: t('monitoring.failure_calls'),
    value: formatCompactNumber(row.failureCalls),
    valueClassName: row.failureCalls > 0 ? styles.badText : undefined,
  },
  {
    key: 'total-tokens',
    label: t('monitoring.total_tokens'),
    value: formatCompactNumber(row.totalTokens),
  },
  {
    key: 'input-tokens',
    label: t('monitoring.input_tokens'),
    value: formatCompactNumber(row.inputTokens),
  },
  {
    key: 'output-tokens',
    label: t('monitoring.output_tokens'),
    value: formatCompactNumber(row.outputTokens),
  },
  {
    key: 'cached-tokens',
    label: t('monitoring.cached_tokens'),
    value: formatCompactNumber(row.cachedTokens),
  },
  {
    key: 'estimated-cost',
    label: t('monitoring.estimated_cost'),
    value: hasPrices ? formatUsd(row.totalCost) : '--',
  },
  {
    key: 'latest-request-time',
    label: t('monitoring.latest_request_time'),
    value: new Date(row.lastSeenAt).toLocaleString(locale),
  },
];

const getAccountSortValue = (row: MonitoringAccountRow, key: AccountSortKey) => {
  switch (key) {
    case 'totalCalls':
      return row.totalCalls;
    case 'successCalls':
      return row.successCalls;
    case 'failureCalls':
      return row.failureCalls;
    case 'totalTokens':
      return row.totalTokens;
    case 'inputTokens':
      return row.inputTokens;
    case 'outputTokens':
      return row.outputTokens;
    case 'cachedTokens':
      return row.cachedTokens;
    case 'totalCost':
      return row.totalCost;
    case 'lastSeenAt':
    default:
      return row.lastSeenAt;
  }
};

const getApiKeySortValue = (
  row: {
    totalCalls: number;
    successCalls: number;
    failureCalls: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalCost: number;
    lastSeenAt: number;
  },
  key: ApiKeySortKey
) => {
  switch (key) {
    case 'totalCalls':
      return row.totalCalls;
    case 'successCalls':
      return row.successCalls;
    case 'failureCalls':
      return row.failureCalls;
    case 'totalTokens':
      return row.totalTokens;
    case 'inputTokens':
      return row.inputTokens;
    case 'outputTokens':
      return row.outputTokens;
    case 'cachedTokens':
      return row.cachedTokens;
    case 'totalCost':
      return row.totalCost;
    case 'lastSeenAt':
    default:
      return row.lastSeenAt;
  }
};

const compareAccountRowsByDefault = (left: MonitoringAccountRow, right: MonitoringAccountRow) =>
  right.lastSeenAt - left.lastSeenAt ||
  right.totalCalls - left.totalCalls ||
  right.totalCost - left.totalCost ||
  left.account.localeCompare(right.account);

const buildAccountQuotaWindows = (
  payload: CodexUsagePayload,
  t: TFunction
): AccountQuotaWindow[] => {
  const windows: AccountQuotaWindow[] = [];
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined;
  const codeReviewLimit =
    payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? undefined;
  const additionalRateLimits = payload.additional_rate_limits ?? payload.additionalRateLimits ?? [];

  const addWindow = (
    id: string,
    label: string,
    window?: CodexUsageWindow | null,
    limitReached?: boolean,
    allowed?: boolean
  ) => {
    if (!window) return;

    const resetLabel = formatCodexResetLabel(window);
    const usedPercentRaw = normalizeNumberValue(window.used_percent ?? window.usedPercent);
    const isLimitReached = Boolean(limitReached) || allowed === false;
    const usedPercent = usedPercentRaw ?? (isLimitReached && resetLabel !== '-' ? 100 : null);
    const clampedUsed = usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent));
    const remainingPercent = clampedUsed === null ? null : Math.max(0, 100 - clampedUsed);

    windows.push({
      id,
      label,
      remainingPercent,
      resetLabel,
    });
  };

  const getWindowSeconds = (window?: CodexUsageWindow | null): number | null => {
    if (!window) return null;
    return normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
  };

  const pickClassifiedWindows = (
    limitInfo?: CodexRateLimitInfo | null
  ): { fiveHourWindow: CodexUsageWindow | null; weeklyWindow: CodexUsageWindow | null } => {
    const primaryWindow = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
    const secondaryWindow = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;
    const rawWindows = [primaryWindow, secondaryWindow];

    let fiveHourWindow: CodexUsageWindow | null = null;
    let weeklyWindow: CodexUsageWindow | null = null;

    rawWindows.forEach((window) => {
      if (!window) return;
      const seconds = getWindowSeconds(window);
      if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
        fiveHourWindow = window;
      } else if (seconds === WEEK_SECONDS && !weeklyWindow) {
        weeklyWindow = window;
      }
    });

    if (!fiveHourWindow) {
      fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null;
    }
    if (!weeklyWindow) {
      weeklyWindow = secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null;
    }

    return { fiveHourWindow, weeklyWindow };
  };

  const rateLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  const rateAllowed = rateLimit?.allowed;
  const rateWindows = pickClassifiedWindows(rateLimit);
  addWindow(
    'five-hour',
    t('codex_quota.primary_window'),
    rateWindows.fiveHourWindow,
    rateLimitReached,
    rateAllowed
  );
  addWindow(
    'weekly',
    t('codex_quota.secondary_window'),
    rateWindows.weeklyWindow,
    rateLimitReached,
    rateAllowed
  );

  const codeReviewLimitReached = codeReviewLimit?.limit_reached ?? codeReviewLimit?.limitReached;
  const codeReviewAllowed = codeReviewLimit?.allowed;
  const codeReviewWindows = pickClassifiedWindows(codeReviewLimit);
  addWindow(
    'code-review-five-hour',
    t('codex_quota.code_review_primary_window'),
    codeReviewWindows.fiveHourWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );
  addWindow(
    'code-review-weekly',
    t('codex_quota.code_review_secondary_window'),
    codeReviewWindows.weeklyWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );

  if (Array.isArray(additionalRateLimits)) {
    additionalRateLimits.forEach((limitItem, index) => {
      const rateInfo = limitItem?.rate_limit ?? limitItem?.rateLimit ?? null;
      if (!rateInfo) return;

      const limitName =
        limitItem?.limit_name ??
        limitItem?.limitName ??
        limitItem?.metered_feature ??
        limitItem?.meteredFeature ??
        `additional-${index + 1}`;
      const limitLabel = String(limitName).trim() || `additional-${index + 1}`;

      addWindow(
        `${limitLabel}-primary-${index}`,
        t('codex_quota.additional_primary_window', { name: limitLabel }),
        rateInfo.primary_window ?? rateInfo.primaryWindow ?? null,
        rateInfo.limit_reached ?? rateInfo.limitReached,
        rateInfo.allowed
      );
      addWindow(
        `${limitLabel}-secondary-${index}`,
        t('codex_quota.additional_secondary_window', { name: limitLabel }),
        rateInfo.secondary_window ?? rateInfo.secondaryWindow ?? null,
        rateInfo.limit_reached ?? rateInfo.limitReached,
        rateInfo.allowed
      );
    });
  }

  return windows;
};

const requestAccountQuota = async (
  target: AccountQuotaTarget,
  t: TFunction
): Promise<AccountQuotaEntry> => {
  if (!target.accountId) {
    throw new Error(t('codex_quota.missing_account_id'));
  }

  const result = await apiCallApi.request({
    authIndex: target.authIndex,
    method: 'GET',
    url: CODEX_USAGE_URL,
    header: {
      ...CODEX_REQUEST_HEADERS,
      'Chatgpt-Account-Id': target.accountId,
    },
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result));
  }

  const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('codex_quota.empty_windows'));
  }

  return {
    key: target.key,
    authLabel: target.authLabel,
    fileName: target.fileName,
    planType: normalizePlanType(payload.plan_type ?? payload.planType) ?? target.planType,
    windows: buildAccountQuotaWindows(payload, t),
  };
};

const buildRealtimeLogRows = (rows: MonitoringEventRow[]): RealtimeLogRow[] => {
  const sortedAsc = [...rows].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id)
  );
  const metricsByStream = new Map<string, { total: number; success: number; pattern: boolean[] }>();

  const enriched = sortedAsc.map((row) => {
    const streamKey = [row.account, row.provider, row.model, row.channel].join('::');
    const previous = metricsByStream.get(streamKey) ?? { total: 0, success: 0, pattern: [] };
    const nextPattern = [...previous.pattern, !row.failed].slice(-10);
    const next = {
      total: previous.total + (row.statsIncluded ? 1 : 0),
      success: previous.success + (row.statsIncluded && !row.failed ? 1 : 0),
      pattern: nextPattern,
    };
    metricsByStream.set(streamKey, next);

    return {
      ...row,
      streamKey,
      requestCount: next.total,
      successRate: next.total > 0 ? next.success / next.total : 1,
      recentPattern: nextPattern,
    } satisfies RealtimeLogRow;
  });

  return enriched.sort(
    (left, right) =>
      right.timestampMs - left.timestampMs ||
      right.requestCount - left.requestCount ||
      right.id.localeCompare(left.id)
  );
};

function Panel({ title, subtitle, extra, children, className }: PanelProps) {
  const hasHeader = Boolean(title || subtitle || extra);

  return (
    <Card className={[styles.panel, className].filter(Boolean).join(' ')}>
      {hasHeader ? (
        <div className={styles.panelHeader}>
          <div>
            {title ? <h2 className={styles.panelTitle}>{title}</h2> : null}
            {subtitle ? <p className={styles.panelSubtitle}>{subtitle}</p> : null}
          </div>
          {extra ? <div className={styles.panelExtra}>{extra}</div> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

function SummaryCard({ label, value, meta, tone, variant = 'primary' }: SummaryCardProps) {
  const cardClassName = [
    styles.summaryCard,
    variant === 'secondary' ? styles.summaryCardSecondary : styles.summaryCardPrimary,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Card className={cardClassName}>
      <span className={styles.summaryLabel}>{label}</span>
      <strong className={`${styles.summaryValue} ${tone ? styles[`tone${tone}`] : ''}`}>
        {value}
      </strong>
      <span className={styles.summaryMeta}>{meta}</span>
    </Card>
  );
}

function PaginationControls({
  count,
  currentPage,
  totalPages,
  startItem,
  endItem,
  pageSize,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  t,
}: PaginationControlsProps) {
  if (count === 0) return null;

  return (
    <div className={styles.paginationBar}>
      <div className={styles.paginationInfo}>
        {t('monitoring.pagination_info', {
          current: currentPage,
          total: totalPages,
          start: startItem,
          end: endItem,
          count,
        })}
      </div>
      <div className={styles.paginationControls}>
        <div className={styles.pageSizeField}>
          <span>{t('monitoring.page_size_label')}</span>
          <Select
            className={styles.pageSizeSelect}
            triggerClassName={styles.pageSizeSelectTrigger}
            value={String(pageSize)}
            options={pageSizeOptions.map((size) => ({
              value: String(size),
              label: t('monitoring.page_size_option', { count: size }),
            }))}
            onChange={(value) => onPageSizeChange(parsePageSize(value, pageSize))}
            ariaLabel={t('monitoring.page_size_label')}
            fullWidth={false}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
        >
          {t('monitoring.pagination_prev')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
        >
          {t('monitoring.pagination_next')}
        </Button>
      </div>
    </div>
  );
}

function StatusBadge({ tone, children }: { tone: MonitoringStatusTone; children: ReactNode }) {
  return <span className={`${styles.statusBadge} ${styles[`tone${tone}`]}`}>{children}</span>;
}

function RecentPattern({
  pattern,
  variant = 'default',
}: {
  pattern: boolean[];
  variant?: 'default' | 'plain';
}) {
  const normalized = pattern.length > 0 ? pattern : Array.from({ length: 10 }, () => true);
  const containerClassName = [
    styles.patternBars,
    variant === 'plain' ? styles.patternBarsPlain : '',
  ]
    .filter(Boolean)
    .join(' ');
  const barClassName = [styles.patternBar, variant === 'plain' ? styles.patternBarPlain : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClassName} aria-hidden="true">
      {normalized.map((item, index) => (
        <span
          key={`${index}-${item ? 'success' : 'failed'}`}
          className={`${barClassName} ${item ? styles.patternSuccess : styles.patternFailed}`}
        />
      ))}
    </div>
  );
}

function AccountSummaryPrimary({
  row,
  expanded,
  onToggle,
}: {
  row: MonitoringAccountRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const secondaryText = buildAccountSecondaryText(row);

  return (
    <button
      type="button"
      className={[styles.accountButton, expanded ? styles.expandedAccountButton : '']
        .filter(Boolean)
        .join(' ')}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
      <span className={styles.accountButtonLabel}>{row.displayAccount || row.account}</span>
      {secondaryText ? <small>{secondaryText}</small> : null}
    </button>
  );
}

function ModelSpendTable({
  row,
  hasPrices,
  locale,
  t,
  quotaState,
  onRefreshQuota,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  quotaState?: AccountQuotaState;
  onRefreshQuota: () => void;
}) {
  const quotaEntries = quotaState?.entries ?? [];
  const quotaLoading = quotaState?.status === 'loading';
  const lastQuotaSync =
    quotaState?.lastRefreshedAt && Number.isFinite(quotaState.lastRefreshedAt)
      ? new Date(quotaState.lastRefreshedAt).toLocaleString(locale)
      : '';
  const singleQuotaEntry = quotaEntries.length === 1 ? quotaEntries[0] : null;
  const singlePlanLabel = singleQuotaEntry ? getCodexPlanLabel(singleQuotaEntry.planType, t) : null;
  const quotaMetaText = [
    singlePlanLabel ? `${t('codex_quota.plan_label')}: ${singlePlanLabel}` : '',
    lastQuotaSync ? `${t('monitoring.last_sync')}: ${lastQuotaSync}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const renderQuotaWindows = (windows: AccountQuotaWindow[]) => (
    <div className={styles.quotaWindowList}>
      {windows.map((window) => {
        const percentLabel =
          window.remainingPercent === null ? '--' : `${Math.round(window.remainingPercent)}%`;
        const barStyle =
          window.remainingPercent === null
            ? undefined
            : { width: `${Math.max(0, Math.min(100, window.remainingPercent))}%` };

        return (
          <div key={window.id} className={styles.quotaWindowRow}>
            <div className={styles.quotaWindowHeader}>
              <span>{window.label}</span>
              <strong>{percentLabel}</strong>
            </div>
            <div className={styles.quotaProgressTrack}>
              <span className={styles.quotaProgressBar} style={barStyle} />
            </div>
            <small>{`${t('monitoring.account_quota_reset_at')}: ${window.resetLabel}`}</small>
          </div>
        );
      })}
    </div>
  );

  const renderRefreshButton = () => (
    <button
      type="button"
      className={styles.quotaRefreshButton}
      onClick={onRefreshQuota}
      disabled={quotaLoading}
    >
      <IconRefreshCw
        size={14}
        className={quotaLoading ? styles.refreshIconSpinning : styles.refreshIcon}
      />
      <span>{t('codex_quota.refresh_button')}</span>
    </button>
  );

  return (
    <div className={styles.expandPanel}>
      <section className={styles.quotaSection}>
        {quotaLoading && quotaEntries.length === 0 ? (
          <div className={styles.quotaStateMessage}>{t('codex_quota.loading')}</div>
        ) : null}

        {!quotaLoading && quotaState?.status === 'error' && quotaEntries.length === 0 ? (
          <div className={styles.quotaStateMessage}>
            {t('codex_quota.load_failed', {
              message: quotaState.error || t('common.unknown_error'),
            })}
          </div>
        ) : null}

        {!quotaLoading && quotaState?.status === 'success' && quotaEntries.length === 0 ? (
          <div className={styles.quotaStateMessage}>{t('monitoring.account_quota_empty')}</div>
        ) : null}

        {singleQuotaEntry ? (
          singleQuotaEntry.error ? (
            <div className={styles.quotaStateMessage}>
              {t('codex_quota.load_failed', { message: singleQuotaEntry.error })}
            </div>
          ) : singleQuotaEntry.windows.length > 0 ? (
            <div className={styles.quotaCompactCard}>
              <div className={styles.quotaCompactHeader}>
                <div className={styles.quotaSectionTitleGroup}>
                  <strong>{t('codex_quota.title')}</strong>
                  {quotaMetaText ? <span>{quotaMetaText}</span> : null}
                </div>
                {renderRefreshButton()}
              </div>
              {renderQuotaWindows(singleQuotaEntry.windows)}
            </div>
          ) : (
            <div className={styles.quotaStateMessage}>{t('codex_quota.empty_windows')}</div>
          )
        ) : quotaEntries.length > 0 ? (
          <>
            <div className={styles.quotaSectionHeader}>
              <div className={styles.quotaSectionTitleGroup}>
                <strong>{t('codex_quota.title')}</strong>
                {lastQuotaSync ? (
                  <span>{`${t('monitoring.last_sync')}: ${lastQuotaSync}`}</span>
                ) : null}
              </div>
              {renderRefreshButton()}
            </div>
            <div className={styles.quotaEntryGrid}>
              {quotaEntries.map((entry) => {
                const planLabel = getCodexPlanLabel(entry.planType, t);
                return (
                  <div key={entry.key} className={styles.quotaEntryCard}>
                    <div className={styles.quotaEntryHeader}>
                      <div className={styles.quotaEntryMain}>
                        <strong>{entry.authLabel}</strong>
                        <small>
                          {planLabel
                            ? `${t('codex_quota.plan_label')}: ${planLabel}`
                            : entry.fileName}
                        </small>
                      </div>
                    </div>

                    {entry.error ? (
                      <div className={styles.quotaStateMessage}>
                        {t('codex_quota.load_failed', { message: entry.error })}
                      </div>
                    ) : entry.windows.length > 0 ? (
                      renderQuotaWindows(entry.windows)
                    ) : (
                      <div className={styles.quotaStateMessage}>
                        {t('codex_quota.empty_windows')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <div className={styles.tableWrapper}>
        <table className={`${styles.table} ${styles.innerTable}`}>
          <thead>
            <tr>
              <th>{t('usage_stats.model_price_model')}</th>
              <th>{t('monitoring.calls')}</th>
              <th>{t('monitoring.column_success_rate')}</th>
              <th>{t('monitoring.input_tokens')}</th>
              <th>{t('monitoring.output_tokens')}</th>
              <th>{t('monitoring.cached_tokens')}</th>
              <th>{t('monitoring.total_tokens')}</th>
              <th>{t('monitoring.estimated_cost')}</th>
              <th>{t('monitoring.latest_request_time')}</th>
            </tr>
          </thead>
          <tbody>
            {row.models.map((model) => (
              <tr key={`${row.id}-${model.model}`}>
                <td className={styles.monoCell}>{model.model}</td>
                <td>{formatCompactNumber(model.totalCalls)}</td>
                <td
                  className={
                    model.successRate >= 0.95
                      ? styles.goodText
                      : model.successRate >= 0.85
                        ? styles.warnText
                        : styles.badText
                  }
                >
                  {formatPercent(model.successRate)}
                </td>
                <td>{formatCompactNumber(model.inputTokens)}</td>
                <td>{formatCompactNumber(model.outputTokens)}</td>
                <td>{formatCompactNumber(model.cachedTokens)}</td>
                <td>{formatCompactNumber(model.totalTokens)}</td>
                <td>{hasPrices ? formatUsd(model.totalCost) : '--'}</td>
                <td>{new Date(model.lastSeenAt).toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpandedAccountCard({
  row,
  hasPrices,
  locale,
  t,
  summaryMetrics,
  isFocused,
  quotaState,
  onToggle,
  onFocus,
  onRefreshQuota,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  summaryMetrics: AccountSummaryMetric[];
  isFocused: boolean;
  quotaState?: AccountQuotaState;
  onToggle: () => void;
  onFocus: () => void;
  onRefreshQuota: () => void;
}) {
  return (
    <div className={styles.expandedAccountDetails}>
      <div className={styles.expandedAccountSummary}>
        <div className={styles.expandedAccountPrimary}>
          <AccountSummaryPrimary row={row} expanded onToggle={onToggle} />
        </div>
        {summaryMetrics.map((metric) => (
          <div key={metric.key} className={styles.expandedAccountMetricValue}>
            <span>{metric.label}</span>
            <strong className={metric.valueClassName}>{metric.value}</strong>
          </div>
        ))}
        <div className={styles.expandedAccountAction}>
          <button type="button" className={styles.inlineActionButton} onClick={onFocus}>
            {isFocused ? t('monitoring.restore_account_scope') : t('monitoring.focus_account')}
          </button>
        </div>
      </div>

      <div className={styles.expandedAccountBody}>
        <ModelSpendTable
          row={row}
          hasPrices={hasPrices}
          locale={locale}
          t={t}
          quotaState={quotaState}
          onRefreshQuota={onRefreshQuota}
        />
      </div>
    </div>
  );
}

export function MonitoringCenterPage() {
  const { t, i18n } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [timeRange, setTimeRange] = useState<MonitoringTimeRange>('today');
  const [customStartInput, setCustomStartInput] = useState(getTodayStartInputValue);
  const [customEndInput, setCustomEndInput] = useState(getCurrentInputValue);
  const [customDraftStartInput, setCustomDraftStartInput] = useState(getTodayStartInputValue);
  const [customDraftEndInput, setCustomDraftEndInput] = useState(getCurrentInputValue);
  const [searchInput, setSearchInput] = useState('');
  const [autoRefreshMs, setAutoRefreshMs] = useState('5000');
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [selectedModel, setSelectedModel] = useState('all');
  const [selectedChannel, setSelectedChannel] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [focusedAccount, setFocusedAccount] = useState<string | null>(null);
  const [isPriceModalOpen, setIsPriceModalOpen] = useState(false);
  const [isCustomRangeModalOpen, setIsCustomRangeModalOpen] = useState(false);
  const [syncingPrices, setSyncingPrices] = useState(false);
  const [usageExporting, setUsageExporting] = useState(false);
  const [usageImporting, setUsageImporting] = useState(false);
  const [priceModel, setPriceModel] = useState('');
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(() => createPriceDraft());
  const [accountQuotaStates, setAccountQuotaStates] = useState<Record<string, AccountQuotaState>>(
    {}
  );
  const [accountSort, setAccountSort] = useState<AccountSortState>(DEFAULT_ACCOUNT_SORT);
  const [apiKeySort, setApiKeySort] = useState<ApiKeySortState>(DEFAULT_API_KEY_SORT);
  const [accountPage, setAccountPage] = useState(1);
  const [accountPageSize, setAccountPageSize] = useState(DEFAULT_ACCOUNT_PAGE_SIZE);
  const [realtimePage, setRealtimePage] = useState(1);
  const [realtimePageSize, setRealtimePageSize] = useState(DEFAULT_REALTIME_PAGE_SIZE);
  const focusSnapshotRef = useRef<FocusSnapshot | null>(null);
  const accountQuotaStatesRef = useRef<Record<string, AccountQuotaState>>({});
  const accountQuotaRequestIdsRef = useRef<Record<string, number>>({});
  const usageImportInputRef = useRef<HTMLInputElement | null>(null);
  const deferredSearch = useDeferredValue(searchInput);
  const customStartMs = useMemo(
    () => parseDateTimeLocalValue(customStartInput),
    [customStartInput]
  );
  const customEndMs = useMemo(() => parseDateTimeLocalValue(customEndInput), [customEndInput]);
  const customDraftStartMs = useMemo(
    () => parseDateTimeLocalValue(customDraftStartInput),
    [customDraftStartInput]
  );
  const customDraftEndMs = useMemo(
    () => parseDateTimeLocalValue(customDraftEndInput),
    [customDraftEndInput]
  );
  const customTimeRangeError = useMemo(() => {
    if (timeRange !== 'custom') return '';
    if (customStartMs === null || customEndMs === null) {
      return t('monitoring.custom_range_required');
    }
    if (customStartMs > customEndMs) {
      return t('monitoring.custom_range_invalid');
    }
    return '';
  }, [customEndMs, customStartMs, t, timeRange]);
  const customTimeRange = useMemo<MonitoringCustomTimeRange | null>(() => {
    if (
      timeRange !== 'custom' ||
      customTimeRangeError ||
      customStartMs === null ||
      customEndMs === null
    ) {
      return null;
    }
    return {
      startMs: customStartMs,
      endMs: customEndMs,
    };
  }, [customEndMs, customStartMs, customTimeRangeError, timeRange]);
  const customDraftTimeRangeError = useMemo(() => {
    if (customDraftStartMs === null || customDraftEndMs === null) {
      return t('monitoring.custom_range_required');
    }
    if (customDraftStartMs > customDraftEndMs) {
      return t('monitoring.custom_range_invalid');
    }
    return '';
  }, [customDraftEndMs, customDraftStartMs, t]);

  const {
    usage,
    apiKeyMap,
    loading: usageLoading,
    error: usageError,
    lastRefreshedAt,
    modelPrices,
    usageServiceAvailable,
    setModelPrices,
    syncModelPrices,
    exportUsage,
    importUsage,
    loadUsage,
  } = useUsageData();

  const {
    loading: monitoringLoading,
    error: monitoringError,
    authFiles,
    filteredRows,
    refreshMeta,
  } = useMonitoringData({
    usage,
    apiKeyMap,
    config,
    modelPrices,
    timeRange,
    customTimeRange,
    searchQuery: deferredSearch,
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([loadUsage(), refreshMeta(false)]);
  }, [loadUsage, refreshMeta]);

  useHeaderRefresh(refreshAll);
  useInterval(
    () => {
      void refreshAll().catch(() => {});
    },
    connectionStatus === 'connected' && Number(autoRefreshMs) > 0 ? Number(autoRefreshMs) : null
  );

  const overallLoading = usageLoading || monitoringLoading;
  const combinedError = [usageError, monitoringError].filter(Boolean).join('；');
  const hasPrices = Object.keys(modelPrices).length > 0;

  useEffect(() => {
    accountQuotaStatesRef.current = accountQuotaStates;
  }, [accountQuotaStates]);

  const providerOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_providers') },
      ...Array.from(new Set(filteredRows.map((row) => row.provider)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, t]
  );

  const accountOptionRows = useMemo(() => buildAccountRows(filteredRows), [filteredRows]);

  const accountOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_accounts') },
      ...Array.from(new Map(accountOptionRows.map((row) => [row.account, buildAccountOptionLabel(row)])).entries())
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([value, label]) => ({ value, label })),
    ],
    [accountOptionRows, t]
  );

  const modelOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_models') },
      ...Array.from(new Set(filteredRows.map((row) => row.model)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, t]
  );

  const channelOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_channels') },
      ...Array.from(new Set(filteredRows.map((row) => row.channel)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, t]
  );

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_statuses') },
      { value: 'success', label: t('monitoring.filter_status_success') },
      { value: 'failed', label: t('monitoring.filter_status_failed') },
    ],
    [t]
  );

  const syncPriceModels = useMemo(
    () =>
      Array.from(new Set([...filteredRows.map((row) => row.model), ...Object.keys(modelPrices)]))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    [filteredRows, modelPrices]
  );

  const priceModelOptions = useMemo(
    () => [
      { value: '', label: t('usage_stats.model_price_select_placeholder') },
      ...syncPriceModels.map((value) => ({ value, label: value })),
    ],
    [syncPriceModels, t]
  );

  const authFilesByAuthIndex = useMemo(() => {
    const map = new Map<string, AuthFileItem>();
    authFiles.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!authIndex || map.has(authIndex)) return;
      map.set(authIndex, file);
    });
    return map;
  }, [authFiles]);

  const scopedRows = useMemo(
    () =>
      filteredRows.filter((row) => {
        if (selectedAccount !== 'all' && row.account !== selectedAccount) {
          return false;
        }
        if (selectedProvider !== 'all' && row.provider !== selectedProvider) {
          return false;
        }
        if (selectedModel !== 'all' && row.model !== selectedModel) {
          return false;
        }
        if (selectedChannel !== 'all' && row.channel !== selectedChannel) {
          return false;
        }
        if (selectedStatus === 'success' && row.failed) {
          return false;
        }
        if (selectedStatus === 'failed' && !row.failed) {
          return false;
        }
        return true;
      }),
    [
      filteredRows,
      selectedAccount,
      selectedChannel,
      selectedModel,
      selectedProvider,
      selectedStatus,
    ]
  );
  const scopedStatsRows = useMemo(
    () => scopedRows.filter((row) => row.statsIncluded),
    [scopedRows]
  );

  const scopedSummary = useMemo(() => buildMonitoringSummary(scopedStatsRows), [scopedStatsRows]);
  const accountRows = useMemo(() => buildAccountRows(scopedRows), [scopedRows]);
  const apiKeyRows = useMemo(() => buildApiKeyRows(scopedRows), [scopedRows]);
  const sortedAccountRows = useMemo(() => {
    const directionFactor = accountSort.direction === 'desc' ? -1 : 1;

    return [...accountRows].sort((left, right) => {
      const valueDiff =
        getAccountSortValue(left, accountSort.key) - getAccountSortValue(right, accountSort.key);
      if (valueDiff !== 0) {
        return valueDiff * directionFactor;
      }

      return compareAccountRowsByDefault(left, right);
    });
  }, [accountRows, accountSort]);
  const sortedApiKeyRows = useMemo(() => {
    const directionFactor = apiKeySort.direction === 'desc' ? -1 : 1;

    return [...apiKeyRows].sort((left, right) => {
      const valueDiff =
        getApiKeySortValue(left, apiKeySort.key) - getApiKeySortValue(right, apiKeySort.key);
      if (valueDiff !== 0) {
        return valueDiff * directionFactor;
      }
      return (
        right.lastSeenAt - left.lastSeenAt ||
        right.totalCalls - left.totalCalls ||
        right.totalCost - left.totalCost
      );
    });
  }, [apiKeyRows, apiKeySort]);

  const groupedRealtimeRows = useMemo(
    () => buildRealtimeMonitorRows(scopedStatsRows),
    [scopedStatsRows]
  );
  const realtimeLogRows = useMemo(() => buildRealtimeLogRows(scopedRows), [scopedRows]);
  const accountPagination = useMemo(
    () => buildPaginationState(sortedAccountRows, accountPage, accountPageSize),
    [accountPage, accountPageSize, sortedAccountRows]
  );
  const realtimePagination = useMemo(
    () => buildPaginationState(realtimeLogRows, realtimePage, realtimePageSize),
    [realtimeLogRows, realtimePage, realtimePageSize]
  );

  useEffect(() => {
    setAccountPage(1);
    setRealtimePage(1);
  }, [
    customEndInput,
    customStartInput,
    deferredSearch,
    selectedAccount,
    selectedChannel,
    selectedModel,
    selectedProvider,
    selectedStatus,
    timeRange,
  ]);

  const accountQuotaTargetsByAccount = useMemo(() => {
    const grouped = new Map<string, Map<string, AccountQuotaTarget>>();

    scopedRows.forEach((row) => {
      const authIndex = normalizeAuthIndex(row.authIndex);
      if (!authIndex || !row.account) return;

      const file = authFilesByAuthIndex.get(authIndex);
      if (!file || !isCodexFile(file)) return;

      const dedupeKey = `${authIndex}::${file.name}`;
      const bucket = grouped.get(row.account) ?? new Map<string, AccountQuotaTarget>();
      if (!bucket.has(dedupeKey)) {
        bucket.set(dedupeKey, {
          key: dedupeKey,
          authIndex,
          authLabel: row.authLabel || file.name || authIndex,
          fileName: file.name,
          accountId: resolveCodexChatgptAccountId(file),
          planType: resolveCodexPlanType(file),
        });
      }
      grouped.set(row.account, bucket);
    });

    return new Map(
      Array.from(grouped.entries()).map(([account, bucket]) => [
        account,
        Array.from(bucket.values()).sort((left, right) =>
          left.authLabel.localeCompare(right.authLabel)
        ),
      ])
    );
  }, [authFilesByAuthIndex, scopedRows]);
  const scopedFailureCount = scopedRows.filter((row) => row.failed).length;
  const savedPriceEntries = useMemo(
    () => Object.entries(modelPrices).sort((left, right) => left[0].localeCompare(right[0])),
    [modelPrices]
  );

  const hasSearchFilter = Boolean(deferredSearch.trim());
  const failedGroupCount = groupedRealtimeRows.filter((row) => row.failureCalls > 0).length;
  const failedOnlyActive = selectedStatus === 'failed';
  const connectionTone: MonitoringStatusTone =
    connectionStatus === 'connected' ? 'good' : connectionStatus === 'connecting' ? 'warn' : 'bad';
  const connectionLabel =
    connectionStatus === 'connected'
      ? t('common.connected_status')
      : connectionStatus === 'connecting'
        ? t('common.connecting_status')
        : connectionStatus === 'error'
          ? t('common.error')
          : t('common.disconnected_status');

  const accountOverviewColumns = useMemo<AccountOverviewColumn[]>(
    () => [
      { key: 'account', label: t('monitoring.account_label') },
      { key: 'total-calls', label: t('monitoring.total_calls'), sortKey: 'totalCalls' },
      { key: 'success-calls', label: t('monitoring.success_calls'), sortKey: 'successCalls' },
      { key: 'failure-calls', label: t('monitoring.failure_calls'), sortKey: 'failureCalls' },
      { key: 'total-tokens', label: t('monitoring.total_tokens'), sortKey: 'totalTokens' },
      { key: 'input-tokens', label: t('monitoring.input_tokens'), sortKey: 'inputTokens' },
      { key: 'output-tokens', label: t('monitoring.output_tokens'), sortKey: 'outputTokens' },
      { key: 'cached-tokens', label: t('monitoring.cached_tokens'), sortKey: 'cachedTokens' },
      { key: 'estimated-cost', label: t('monitoring.estimated_cost'), sortKey: 'totalCost' },
      {
        key: 'latest-request-time',
        label: t('monitoring.latest_request_time'),
        sortKey: 'lastSeenAt',
      },
      { key: 'action', label: t('common.action') },
    ],
    [t]
  );

  const apiKeyOverviewColumns = useMemo<AccountOverviewColumn[]>(
    () => [
      { key: 'api-key', label: t('common.api_key') },
      { key: 'total-calls', label: t('monitoring.total_calls'), sortKey: 'totalCalls' },
      { key: 'success-calls', label: t('monitoring.success_calls'), sortKey: 'successCalls' },
      { key: 'failure-calls', label: t('monitoring.failure_calls'), sortKey: 'failureCalls' },
      { key: 'total-tokens', label: t('monitoring.total_tokens'), sortKey: 'totalTokens' },
      { key: 'input-tokens', label: t('monitoring.input_tokens'), sortKey: 'inputTokens' },
      { key: 'output-tokens', label: t('monitoring.output_tokens'), sortKey: 'outputTokens' },
      { key: 'cached-tokens', label: t('monitoring.cached_tokens'), sortKey: 'cachedTokens' },
      { key: 'estimated-cost', label: t('monitoring.estimated_cost'), sortKey: 'totalCost' },
      {
        key: 'latest-request-time',
        label: t('monitoring.latest_request_time'),
        sortKey: 'lastSeenAt',
      },
    ],
    [t]
  );


  const primarySummaryCards: SummaryCardProps[] = [
    {
      label: t('monitoring.total_calls'),
      value: formatCompactNumber(scopedSummary.totalCalls),
      meta: `${accountRows.length} ${t('monitoring.accounts_suffix')}`,
    },
    {
      label: t('monitoring.call_success_rate'),
      value: formatPercent(scopedSummary.successRate),
      meta: formatDurationMs(scopedSummary.averageLatencyMs, { locale: i18n.language }),
      tone:
        scopedSummary.successRate >= 0.95
          ? 'good'
          : scopedSummary.successRate >= 0.85
            ? 'warn'
            : 'bad',
    },
    {
      label: t('monitoring.failure_calls'),
      value: formatCompactNumber(scopedSummary.failureCalls),
      meta: `${failedGroupCount} ${t('monitoring.groups_suffix')}`,
      tone: scopedSummary.failureCalls > 0 ? 'bad' : 'good',
    },
    {
      label: t('monitoring.estimated_cost'),
      value: hasPrices ? formatUsd(scopedSummary.totalCost) : '--',
      meta: hasPrices
        ? t('monitoring.estimated_cost_hint')
        : t('monitoring.estimated_cost_missing'),
      tone: hasPrices ? undefined : 'warn',
    },
  ];

  const secondarySummaryCards: SummaryCardProps[] = [
    {
      label: t('monitoring.total_tokens'),
      value: formatCompactNumber(scopedSummary.totalTokens),
      meta: `${t('monitoring.reasoning_tokens')} ${formatCompactNumber(scopedSummary.reasoningTokens)}`,
      variant: 'secondary',
    },
    {
      label: t('monitoring.input_tokens'),
      value: formatCompactNumber(scopedSummary.inputTokens),
      meta: `${t('monitoring.of_token_mix')} ${formatPercent(scopedSummary.totalTokens > 0 ? scopedSummary.inputTokens / scopedSummary.totalTokens : 0)}`,
      variant: 'secondary',
    },
    {
      label: t('monitoring.output_tokens'),
      value: formatCompactNumber(scopedSummary.outputTokens),
      meta: `${t('monitoring.of_token_mix')} ${formatPercent(scopedSummary.totalTokens > 0 ? scopedSummary.outputTokens / scopedSummary.totalTokens : 0)}`,
      variant: 'secondary',
    },
    {
      label: t('monitoring.cached_tokens'),
      value: formatCompactNumber(scopedSummary.cachedTokens),
      meta: `${t('monitoring.of_input_tokens')} ${formatPercent(scopedSummary.inputTokens > 0 ? scopedSummary.cachedTokens / scopedSummary.inputTokens : 0)}`,
      variant: 'secondary',
    },
  ];

  const restoreFocusSnapshot = useCallback(() => {
    const snapshot = focusSnapshotRef.current;
    focusSnapshotRef.current = null;
    setFocusedAccount(null);

    if (!snapshot) {
      setSelectedAccount('all');
      return;
    }

    setSearchInput(snapshot.searchInput);
    setSelectedAccount(snapshot.selectedAccount);
    setSelectedProvider(snapshot.selectedProvider);
    setSelectedModel(snapshot.selectedModel);
    setSelectedChannel(snapshot.selectedChannel);
    setSelectedStatus(snapshot.selectedStatus);
  }, []);

  const clearFilters = useCallback(() => {
    focusSnapshotRef.current = null;
    setFocusedAccount(null);
    setSearchInput('');
    setSelectedAccount('all');
    setSelectedProvider('all');
    setSelectedModel('all');
    setSelectedChannel('all');
    setSelectedStatus('all');
  }, []);

  const openCustomRangeModal = useCallback(() => {
    setCustomDraftStartInput(customStartInput || getTodayStartInputValue());
    setCustomDraftEndInput(customEndInput || getCurrentInputValue());
    setIsCustomRangeModalOpen(true);
  }, [customEndInput, customStartInput]);

  const handleTimeRangeChange = useCallback(
    (range: MonitoringTimeRange) => {
      if (range === 'custom') {
        openCustomRangeModal();
        return;
      }
      setIsCustomRangeModalOpen(false);
      setTimeRange(range);
    },
    [openCustomRangeModal]
  );

  const handleCustomDraftStartChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setCustomDraftStartInput(event.target.value);
  }, []);

  const handleCustomDraftEndChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setCustomDraftEndInput(event.target.value);
  }, []);

  const applyCustomTimeRange = useCallback(() => {
    if (customDraftTimeRangeError) return;
    setCustomStartInput(customDraftStartInput);
    setCustomEndInput(customDraftEndInput);
    setTimeRange('custom');
    setIsCustomRangeModalOpen(false);
  }, [customDraftEndInput, customDraftStartInput, customDraftTimeRangeError]);

  const toggleFailedOnly = useCallback(() => {
    setSelectedStatus((previous) => (previous === 'failed' ? 'all' : 'failed'));
  }, []);

  const loadAccountQuota = useCallback(
    async (account: string, force: boolean = false) => {
      const currentState = accountQuotaStatesRef.current[account];
      const targets = accountQuotaTargetsByAccount.get(account) ?? [];
      const targetKey = targets.map((target) => target.key).join('|');
      if (
        !force &&
        currentState &&
        currentState.status !== 'idle' &&
        currentState.targetKey === targetKey
      ) {
        return;
      }

      const requestId = (accountQuotaRequestIdsRef.current[account] ?? 0) + 1;
      accountQuotaRequestIdsRef.current[account] = requestId;

      setAccountQuotaStates((previous) => ({
        ...previous,
        [account]: {
          status: 'loading',
          targetKey,
          entries:
            previous[account]?.targetKey === targetKey ? (previous[account]?.entries ?? []) : [],
          lastRefreshedAt: previous[account]?.lastRefreshedAt,
        },
      }));

      if (targets.length === 0) {
        if (accountQuotaRequestIdsRef.current[account] !== requestId) return;
        setAccountQuotaStates((previous) => ({
          ...previous,
          [account]: {
            status: 'success',
            targetKey,
            entries: [],
            lastRefreshedAt: Date.now(),
          },
        }));
        return;
      }

      const settled = await Promise.allSettled(
        targets.map((target) => requestAccountQuota(target, t))
      );
      if (accountQuotaRequestIdsRef.current[account] !== requestId) return;

      const entries = settled.map((result, index) => {
        const fallback = targets[index];
        if (result.status === 'fulfilled') {
          return result.value;
        }

        const error =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason || t('common.unknown_error'));
        return {
          key: fallback.key,
          authLabel: fallback.authLabel,
          fileName: fallback.fileName,
          planType: fallback.planType,
          windows: [],
          error,
        } satisfies AccountQuotaEntry;
      });

      const hasSuccess = entries.some((entry) => !entry.error);
      setAccountQuotaStates((previous) => ({
        ...previous,
        [account]: {
          status: hasSuccess ? 'success' : 'error',
          targetKey,
          entries,
          error: hasSuccess ? '' : entries[0]?.error || t('common.unknown_error'),
          lastRefreshedAt: Date.now(),
        },
      }));
    },
    [accountQuotaTargetsByAccount, t]
  );

  const toggleAccountExpanded = useCallback(
    (accountId: string, account: string) => {
      if (!expandedAccounts[accountId]) {
        void loadAccountQuota(account);
      }
      setExpandedAccounts((previous) => ({
        ...previous,
        [accountId]: !previous[accountId],
      }));
    },
    [expandedAccounts, loadAccountQuota]
  );

  const focusAccount = useCallback(
    (account: string) => {
      if (focusedAccount === account) {
        restoreFocusSnapshot();
        return;
      }

      if (!focusSnapshotRef.current) {
        focusSnapshotRef.current = {
          searchInput,
          selectedAccount,
          selectedProvider,
          selectedModel,
          selectedChannel,
          selectedStatus,
        };
      }

      setFocusedAccount(account);
      setSelectedAccount(account);
    },
    [
      focusedAccount,
      restoreFocusSnapshot,
      searchInput,
      selectedAccount,
      selectedChannel,
      selectedModel,
      selectedProvider,
      selectedStatus,
    ]
  );

  const handleAccountFilterChange = useCallback(
    (value: string) => {
      setSelectedAccount(value);

      if (focusedAccount && value !== focusedAccount) {
        focusSnapshotRef.current = null;
        setFocusedAccount(null);
      }
    },
    [focusedAccount]
  );

  const handleAccountPageSizeChange = useCallback((pageSize: number) => {
    setAccountPageSize(pageSize);
    setAccountPage(1);
  }, []);

  const handleRealtimePageSizeChange = useCallback((pageSize: number) => {
    setRealtimePageSize(pageSize);
    setRealtimePage(1);
  }, []);

  const handleAccountSort = useCallback((key: AccountSortKey) => {
    setAccountPage(1);
    setAccountSort((previous) =>
      previous.key === key
        ? {
            key,
            direction: previous.direction === 'desc' ? 'asc' : 'desc',
          }
        : {
            key,
            direction: 'desc',
          }
    );
  }, []);

  const handleApiKeySort = useCallback((key: ApiKeySortKey) => {
    setApiKeySort((previous) =>
      previous.key === key
        ? {
            key,
            direction: previous.direction === 'desc' ? 'asc' : 'desc',
          }
        : {
            key,
            direction: 'desc',
          }
    );
  }, []);

  const handlePriceModelChange = useCallback(
    (value: string) => {
      setPriceModel(value);
      setPriceDraft(createPriceDraft(modelPrices[value]));
    },
    [modelPrices]
  );

  const handlePriceDraftChange = useCallback((field: keyof PriceDraft, value: string) => {
    setPriceDraft((previous) => ({ ...previous, [field]: value }));
  }, []);

  const resetPriceEditor = useCallback(() => {
    setPriceModel('');
    setPriceDraft(createPriceDraft());
  }, []);

  const handleSavePrice = useCallback(async () => {
    if (!priceModel) {
      return;
    }

    const prompt = parsePriceValue(priceDraft.prompt);
    const completion = parsePriceValue(priceDraft.completion);
    const cache = priceDraft.cache.trim() === '' ? prompt : parsePriceValue(priceDraft.cache);

    await setModelPrices({
      ...modelPrices,
      [priceModel]: {
        prompt,
        completion,
        cache,
      },
    });
    showNotification(t('usage_stats.model_price_saved'), 'success');
  }, [
    modelPrices,
    priceDraft.cache,
    priceDraft.completion,
    priceDraft.prompt,
    priceModel,
    setModelPrices,
    showNotification,
    t,
  ]);

  const handleDeletePrice = useCallback(
    async (model: string) => {
      const nextPrices = { ...modelPrices };
      delete nextPrices[model];
      await setModelPrices(nextPrices);

      if (priceModel === model) {
        resetPriceEditor();
      }
    },
    [modelPrices, priceModel, resetPriceEditor, setModelPrices]
  );

  const handleSyncModelPrices = useCallback(async () => {
    if (syncPriceModels.length === 0) {
      showNotification(t('usage_stats.model_price_sync_no_models'), 'warning');
      return;
    }
    setSyncingPrices(true);
    try {
      const result = await syncModelPrices(syncPriceModels);
      showNotification(
        t('usage_stats.model_price_sync_success', {
          count: result.imported,
          source: result.source || 'LiteLLM',
        }),
        'success'
      );
    } catch (error: unknown) {
      const rawMessage =
        error instanceof Error ? error.message : String(error || t('common.unknown_error'));
      const message =
        rawMessage === 'model_price_sync_requires_usage_service'
          ? t('usage_stats.model_price_sync_requires_usage_service')
          : rawMessage;
      showNotification(`${t('usage_stats.model_price_sync_failed')}: ${message}`, 'error');
    } finally {
      setSyncingPrices(false);
    }
  }, [showNotification, syncModelPrices, syncPriceModels, t]);

  const resolveUsageTransferError = useCallback(
    (error: unknown) => {
      const rawMessage =
        error instanceof Error ? error.message : String(error || t('common.unknown_error'));
      return rawMessage === 'usage_import_export_requires_usage_service'
        ? t('usage_stats.import_export_requires_usage_service')
        : rawMessage;
    },
    [t]
  );

  const handleUsageExport = useCallback(async () => {
    setUsageExporting(true);
    try {
      const response = await exportUsage();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadBlob({
        filename: response.filename || `usage-events-${timestamp}.jsonl`,
        blob: response.blob,
      });
      showNotification(t('usage_stats.export_success'), 'success');
    } catch (error: unknown) {
      const message = resolveUsageTransferError(error);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setUsageExporting(false);
    }
  }, [exportUsage, resolveUsageTransferError, showNotification, t]);

  const importUsageFile = useCallback(
    async (file: File) => {
      setUsageImporting(true);
      try {
        const result = await importUsage(file);
        const unsupported = result.unsupported ?? 0;
        showNotification(
          `${t('usage_stats.import_success', {
            added: result.added ?? 0,
            skipped: result.skipped ?? 0,
            total: result.total ?? 0,
            failed: result.failed ?? 0,
          })}${unsupported > 0 ? `, ${t('usage_stats.import_unsupported', { count: unsupported })}` : ''}`,
          (result.failed ?? 0) > 0 || unsupported > 0 ? 'warning' : 'success'
        );
        if (result.format?.startsWith('legacy') || (result.warnings ?? []).length > 0) {
          showNotification(t('usage_stats.import_legacy_warning'), 'warning');
        }
        await refreshAll();
      } catch (error: unknown) {
        const message = resolveUsageTransferError(error);
        showNotification(
          `${t('notification.upload_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      } finally {
        setUsageImporting(false);
      }
    },
    [importUsage, refreshAll, resolveUsageTransferError, showNotification, t]
  );

  const handleUsageImportClick = useCallback(() => {
    if (!usageServiceAvailable) {
      showNotification(t('usage_stats.import_export_requires_usage_service'), 'warning');
      return;
    }
    usageImportInputRef.current?.click();
  }, [showNotification, t, usageServiceAvailable]);

  const handleUsageImportChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      if (!isUsageImportFile(file)) {
        showNotification(t('usage_stats.import_invalid'), 'error');
        return;
      }
      if (file.size > MAX_USAGE_IMPORT_FILE_SIZE) {
        showNotification(
          t('usage_stats.import_file_too_large', {
            maxSize: formatFileSize(MAX_USAGE_IMPORT_FILE_SIZE),
          }),
          'error'
        );
        return;
      }

      showConfirmation({
        title: t('usage_stats.import_confirm_title'),
        message: t('usage_stats.import_confirm_body', { name: file.name }),
        confirmText: t('usage_stats.import'),
        variant: 'primary',
        onConfirm: () => importUsageFile(file),
      });
    },
    [importUsageFile, showConfirmation, showNotification, t]
  );

  return (
    <div className={styles.page}>
      {overallLoading && !usage ? (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} />
            <span>{t('common.loading')}</span>
          </div>
        </div>
      ) : null}

      <div className={styles.headerShell}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>{t('monitoring.title')}</h1>
          <p className={styles.description}>{t('monitoring.console_subtitle')}</p>
        </div>

        <div className={styles.statusBar}>
          <span className={`${styles.statusBadge} ${styles[`tone${connectionTone}`]}`}>
            <span className={styles.statusDot} aria-hidden="true" />
            {connectionLabel}
          </span>
          <div className={styles.statusMeta}>
            <span>
              {t('monitoring.last_sync')}:{' '}
              {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString(i18n.language) : '--'}
            </span>
            <span className={scopedFailureCount > 0 ? styles.statusMetaWarn : undefined}>
              {`${t('monitoring.recent_failures')}: ${scopedFailureCount}`}
            </span>
            <span>{`${t('monitoring.total_calls')}: ${formatCompactNumber(scopedSummary.totalCalls)}`}</span>
          </div>
        </div>
      </div>

      <section className={styles.actionBar} aria-label={t('common.action')}>
        <div className={styles.actionGroup}>
          <button
            type="button"
            className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
            onClick={() => void handleUsageExport()}
            disabled={!usageServiceAvailable || usageExporting || usageImporting}
            title={
              usageServiceAvailable
                ? t('usage_stats.export')
                : t('usage_stats.import_export_requires_usage_service')
            }
          >
            <IconDownload size={16} />
            <span>{usageExporting ? t('common.loading') : t('usage_stats.export')}</span>
          </button>
          <button
            type="button"
            className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
            onClick={handleUsageImportClick}
            disabled={!usageServiceAvailable || usageExporting || usageImporting}
            title={
              usageServiceAvailable
                ? t('usage_stats.import')
                : t('usage_stats.import_export_requires_usage_service')
            }
          >
            <IconFileText size={16} />
            <span>{usageImporting ? t('common.loading') : t('usage_stats.import')}</span>
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => setIsPriceModalOpen(true)}
          >
            <IconSettings size={16} />
            <span>{t('usage_stats.model_price_settings')}</span>
          </button>
          <input
            ref={usageImportInputRef}
            type="file"
            accept=".json,.jsonl,.ndjson,.txt,application/json,application/x-ndjson,text/plain"
            style={{ display: 'none' }}
            onChange={handleUsageImportChange}
          />
        </div>

        <div className={`${styles.actionGroup} ${styles.actionGroupNav}`}>
          <Link
            to="/monitoring/codex-inspection"
            className={`${styles.actionButton} ${styles.quickNavLink}`}
          >
            <IconChartLine size={16} />
            <span>{t('monitoring.codex_inspection_entry')}</span>
            <IconExternalLink size={14} />
          </Link>
          {config?.loggingToFile ? (
            <Link to="/logs" className={`${styles.actionButton} ${styles.quickNavLink}`}>
              <IconFileText size={16} />
              <span>{t('monitoring.open_logs')}</span>
              <IconExternalLink size={14} />
            </Link>
          ) : null}
        </div>
      </section>

      <Panel className={styles.toolbarPanel}>
        <div className={styles.controlBar}>
          <div className={styles.segmentedControl}>
            {TIME_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.segmentButton} ${timeRange === option.value ? styles.segmentButtonActive : ''}`}
                onClick={() => handleTimeRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>

          <div className={styles.refreshControls}>
            <div className={styles.autoRefreshField}>
              <span className={styles.autoRefreshLabel}>
                <IconTimer size={16} />
                {t('monitoring.auto_refresh')}
              </span>
              <Select
                className={styles.autoRefreshSelect}
                triggerClassName={styles.autoRefreshSelectTrigger}
                value={autoRefreshMs}
                options={AUTO_REFRESH_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                onChange={setAutoRefreshMs}
                ariaLabel={t('monitoring.auto_refresh')}
                fullWidth={false}
              />
            </div>

            <button
              type="button"
              className={styles.refreshButton}
              onClick={() => void refreshAll()}
              disabled={overallLoading}
            >
              <IconRefreshCw
                size={16}
                className={overallLoading ? styles.refreshIconSpinning : styles.refreshIcon}
              />
              <span className={styles.refreshButtonLabel}>{t('usage_stats.refresh')}</span>
            </button>
          </div>
        </div>

        <div className={styles.filterBar}>
          <div className={styles.filterGrid}>
            <div className={styles.filterAccountStack}>
              <Select
                value={selectedAccount}
                options={accountOptions}
                onChange={handleAccountFilterChange}
                ariaLabel={t('monitoring.filter_account')}
              />
            </div>
            <Select
              value={selectedProvider}
              options={providerOptions}
              onChange={setSelectedProvider}
              ariaLabel={t('monitoring.filter_provider')}
            />
            <Select
              value={selectedModel}
              options={modelOptions}
              onChange={setSelectedModel}
              ariaLabel={t('monitoring.filter_model')}
            />
            <Select
              value={selectedChannel}
              options={channelOptions}
              onChange={setSelectedChannel}
              ariaLabel={t('monitoring.filter_channel')}
            />
            <Select
              value={selectedStatus}
              options={statusOptions}
              onChange={(value) => setSelectedStatus(value as StatusFilter)}
              ariaLabel={t('monitoring.filter_status')}
            />
          </div>

          <div className={styles.filterSearchRow}>
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('monitoring.search_placeholder')}
              className={styles.filterSearchInput}
              rightElement={<IconSearch size={16} />}
              aria-label={t('monitoring.search_placeholder')}
            />
            <button type="button" className={styles.clearButton} onClick={clearFilters}>
              <IconSlidersHorizontal size={16} />
              <span>{t('monitoring.clear_filters')}</span>
            </button>
          </div>
        </div>

        {combinedError ? <div className={styles.errorBox}>{combinedError}</div> : null}
        {!config?.usageStatisticsEnabled ? (
          <div className={styles.callout}>
            <strong>{t('monitoring.usage_disabled_title')}</strong>
            <span>{t('monitoring.usage_disabled_body')}</span>
          </div>
        ) : null}
      </Panel>

      <section className={styles.summarySection}>
        <div className={styles.summaryHero}>
          {primarySummaryCards.map((card) => (
            <SummaryCard key={card.label} {...card} />
          ))}
        </div>
        <div className={styles.summarySub}>
          {secondarySummaryCards.map((card) => (
            <SummaryCard key={card.label} {...card} />
          ))}
        </div>
      </section>

      <Panel
        title={t('monitoring.account_overview_title')}
        subtitle={t('monitoring.account_overview_desc')}
        className={styles.accountPanel}
      >
        <div className={styles.tableWrapper}>
          <table className={`${styles.table} ${styles.accountOverviewTable}`}>
            <colgroup>
              {accountOverviewColumns.map((column) => (
                <col key={column.key} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {accountOverviewColumns.map((column) => {
                  if (!column.sortKey) {
                    return <th key={column.key}>{column.label}</th>;
                  }

                  const isActive = accountSort.key === column.sortKey;
                  const SortIcon = isActive
                    ? accountSort.direction === 'desc'
                      ? IconChevronDown
                      : IconChevronUp
                    : null;

                  return (
                    <th
                      key={column.key}
                      aria-sort={
                        isActive
                          ? accountSort.direction === 'desc'
                            ? 'descending'
                            : 'ascending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        className={[
                          styles.sortableHeaderButton,
                          isActive ? styles.sortableHeaderButtonActive : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => handleAccountSort(column.sortKey!)}
                      >
                        <span>{column.label}</span>
                        <span className={styles.sortIndicator} aria-hidden="true">
                          {SortIcon ? <SortIcon size={14} /> : null}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {accountPagination.pageItems.map((row) => {
                const isExpanded = Boolean(expandedAccounts[row.id]);
                const isFocused = focusedAccount === row.account;
                const summaryMetrics = buildAccountSummaryMetrics(row, hasPrices, i18n.language, t);

                if (isExpanded) {
                  return (
                    <tr key={row.id} className={styles.expandedAccountCardRow}>
                      <td colSpan={accountOverviewColumns.length}>
                        <ExpandedAccountCard
                          row={row}
                          hasPrices={hasPrices}
                          locale={i18n.language}
                          t={t}
                          summaryMetrics={summaryMetrics}
                          isFocused={isFocused}
                          quotaState={accountQuotaStates[row.account]}
                          onToggle={() => toggleAccountExpanded(row.id, row.account)}
                          onFocus={() => focusAccount(row.account)}
                          onRefreshQuota={() => void loadAccountQuota(row.account, true)}
                        />
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={row.id} className={isFocused ? styles.focusedRow : undefined}>
                    <td>
                      <AccountSummaryPrimary
                        row={row}
                        expanded={false}
                        onToggle={() => toggleAccountExpanded(row.id, row.account)}
                      />
                    </td>
                    {summaryMetrics.map((metric) => (
                      <td key={metric.key} className={metric.valueClassName}>
                        {metric.value}
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className={styles.inlineActionButton}
                        onClick={() => focusAccount(row.account)}
                      >
                        {isFocused
                          ? t('monitoring.restore_account_scope')
                          : t('monitoring.focus_account')}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {sortedAccountRows.length === 0 ? (
                <tr>
                  <td colSpan={accountOverviewColumns.length}>
                    <div className={styles.emptyTable}>
                      {hasSearchFilter ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <PaginationControls
          count={sortedAccountRows.length}
          currentPage={accountPagination.currentPage}
          totalPages={accountPagination.totalPages}
          startItem={accountPagination.startItem}
          endItem={accountPagination.endItem}
          pageSize={accountPageSize}
          pageSizeOptions={ACCOUNT_PAGE_SIZE_OPTIONS}
          onPageChange={setAccountPage}
          onPageSizeChange={handleAccountPageSizeChange}
          t={t}
        />
      </Panel>

      <Panel
        title={t('monitoring.api_key_overview_title')}
        subtitle={t('monitoring.api_key_overview_desc')}
        className={styles.accountPanel}
      >
        <div className={styles.tableWrapper}>
          <table className={`${styles.table} ${styles.accountOverviewTable}`}>
            <colgroup>
              {apiKeyOverviewColumns.map((column) => (
                <col key={column.key} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {apiKeyOverviewColumns.map((column) => {
                  if (!column.sortKey) {
                    return <th key={column.key}>{column.label}</th>;
                  }

                  const isActive = apiKeySort.key === column.sortKey;
                  const SortIcon = isActive
                    ? apiKeySort.direction === 'desc'
                      ? IconChevronDown
                      : IconChevronUp
                    : null;

                  return (
                    <th
                      key={column.key}
                      aria-sort={
                        isActive
                          ? apiKeySort.direction === 'desc'
                            ? 'descending'
                            : 'ascending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        className={[
                          styles.sortableHeaderButton,
                          isActive ? styles.sortableHeaderButtonActive : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => handleApiKeySort(column.sortKey!)}
                      >
                        <span>{column.label}</span>
                        <span className={styles.sortIndicator} aria-hidden="true">
                          {SortIcon ? <SortIcon size={14} /> : null}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedApiKeyRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className={styles.primaryCell}>
                      <span className={styles.monoCell}>{row.apiKeyMasked}</span>
                      <small>
                        {row.accounts.slice(0, 2).join(', ')}
                        {row.accounts.length > 2 ? ` +${row.accounts.length - 2}` : ''}
                      </small>
                    </div>
                  </td>
                  <td>{formatCompactNumber(row.totalCalls)}</td>
                  <td>{formatCompactNumber(row.successCalls)}</td>
                  <td className={row.failureCalls > 0 ? styles.badText : undefined}>
                    {formatCompactNumber(row.failureCalls)}
                  </td>
                  <td>{formatCompactNumber(row.totalTokens)}</td>
                  <td>{formatCompactNumber(row.inputTokens)}</td>
                  <td>{formatCompactNumber(row.outputTokens)}</td>
                  <td>{formatCompactNumber(row.cachedTokens)}</td>
                  <td>{hasPrices ? formatUsd(row.totalCost) : '--'}</td>
                  <td>{new Date(row.lastSeenAt).toLocaleString(i18n.language)}</td>
                </tr>
              ))}
              {sortedApiKeyRows.length === 0 ? (
                <tr>
                  <td colSpan={apiKeyOverviewColumns.length}>
                    <div className={styles.emptyTable}>
                      {hasSearchFilter ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={t('monitoring.realtime_table_title')}
        subtitle={t('monitoring.realtime_table_desc')}
        className={styles.realtimePanel}
        extra={
          <div className={styles.inlineMetrics}>
            <span>{`${t('monitoring.log_rows')}: ${realtimeLogRows.length}`}</span>
            <span>{`${t('monitoring.recent_failures')}: ${scopedFailureCount}`}</span>
            <button
              type="button"
              className={[
                styles.filterToggleChip,
                failedOnlyActive ? styles.filterToggleChipActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={toggleFailedOnly}
            >
              {t('monitoring.filter_status_failed')}
            </button>
          </div>
        }
      >
        <div className={styles.tableWrapper}>
          <table className={`${styles.table} ${styles.realtimeTable}`}>
            <thead>
              <tr>
                <th>{t('monitoring.column_type')}</th>
                <th>{t('monitoring.column_model')}</th>
                <th>{t('monitoring.recent_status')}</th>
                <th>{t('monitoring.request_status')}</th>
                <th>{t('monitoring.column_success_rate')}</th>
                <th>{t('monitoring.total_calls')}</th>
                <th>{t('monitoring.column_latency')}</th>
                <th>{t('monitoring.column_time')}</th>
                <th>{t('monitoring.this_call_usage')}</th>
                <th>{t('monitoring.this_call_cost')}</th>
              </tr>
            </thead>
            <tbody>
              {realtimePagination.pageItems.map((row) => (
                <tr key={row.id} className={row.failed ? styles.logRowFailed : undefined}>
                  <td>
                    <div className={styles.logTypeCell}>
                      <span
                        className={[
                          styles.logTypeIcon,
                          row.failed ? styles.logTypeIconFailed : styles.logTypeIconSuccess,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-hidden="true"
                      />
                      <div className={styles.primaryCell}>
                        <span>{row.provider}</span>
                        <small>{row.account || row.authLabel || row.accountMasked || '-'}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className={styles.primaryCell}>
                      <span className={styles.monoCell}>{row.model}</span>
                      <small className={styles.monoCell}>{buildRealtimeMetaText(row)}</small>
                    </div>
                  </td>
                  <td>
                    <div className={styles.recentStatusCell}>
                      <RecentPattern pattern={row.recentPattern} variant="plain" />
                    </div>
                  </td>
                  <td>
                    <StatusBadge tone={row.failed ? 'bad' : 'good'}>
                      {row.failed ? t('monitoring.result_failed') : t('monitoring.result_success')}
                    </StatusBadge>
                  </td>
                  <td
                    className={
                      row.successRate >= 0.95
                        ? styles.goodText
                        : row.successRate >= 0.85
                          ? styles.warnText
                          : styles.badText
                    }
                  >
                    {formatPercent(row.successRate)}
                  </td>
                  <td>{formatCompactNumber(row.requestCount)}</td>
                  <td>
                    <span
                      className={
                        row.latencyMs !== null && row.latencyMs >= 30000
                          ? styles.badText
                          : row.latencyMs !== null && row.latencyMs >= 15000
                            ? styles.warnText
                            : undefined
                      }
                    >
                      {formatDurationMs(row.latencyMs, { locale: i18n.language })}
                    </span>
                  </td>
                  <td>{new Date(row.timestampMs).toLocaleString(i18n.language)}</td>
                  <td>
                    <div className={styles.primaryCell}>
                      <span>{formatCompactNumber(row.totalTokens)}</span>
                      <small>{`I ${formatCompactNumber(row.inputTokens)} · O ${formatCompactNumber(row.outputTokens)} · C ${formatCompactNumber(row.cachedTokens)}`}</small>
                    </div>
                  </td>
                  <td>{hasPrices ? formatUsd(row.totalCost) : '--'}</td>
                </tr>
              ))}
              {realtimeLogRows.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className={styles.emptyTable}>
                      {hasSearchFilter ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <PaginationControls
          count={realtimeLogRows.length}
          currentPage={realtimePagination.currentPage}
          totalPages={realtimePagination.totalPages}
          startItem={realtimePagination.startItem}
          endItem={realtimePagination.endItem}
          pageSize={realtimePageSize}
          pageSizeOptions={REALTIME_PAGE_SIZE_OPTIONS}
          onPageChange={setRealtimePage}
          onPageSizeChange={handleRealtimePageSizeChange}
          t={t}
        />
      </Panel>

      <Modal
        open={isCustomRangeModalOpen}
        onClose={() => setIsCustomRangeModalOpen(false)}
        title={t('monitoring.range_custom')}
        width={560}
        className={styles.monitorModal}
        footer={
          <div className={styles.customRangeModalFooter}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsCustomRangeModalOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={applyCustomTimeRange}
              disabled={Boolean(customDraftTimeRangeError)}
            >
              {t('common.confirm')}
            </Button>
          </div>
        }
      >
        <div className={styles.customRangeModalBody}>
          <div className={styles.customRangeModalGrid}>
            <Input
              type="datetime-local"
              label={t('monitoring.custom_range_start')}
              value={customDraftStartInput}
              onChange={handleCustomDraftStartChange}
              className={styles.customRangeInput}
              aria-invalid={Boolean(customDraftTimeRangeError)}
            />
            <Input
              type="datetime-local"
              label={t('monitoring.custom_range_end')}
              value={customDraftEndInput}
              onChange={handleCustomDraftEndChange}
              className={styles.customRangeInput}
              aria-invalid={Boolean(customDraftTimeRangeError)}
            />
          </div>
          {customDraftTimeRangeError ? (
            <div className={styles.customRangeError} role="alert">
              {customDraftTimeRangeError}
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={isPriceModalOpen}
        onClose={() => setIsPriceModalOpen(false)}
        title={t('usage_stats.model_price_settings')}
        width={860}
        className={styles.monitorModal}
      >
        <div className={styles.priceEditor}>
          <div className={styles.priceGrid}>
            <div className={`${styles.priceField} ${styles.priceFieldModel}`}>
              <label>{t('usage_stats.model_name')}</label>
              <Select
                value={priceModel}
                options={priceModelOptions}
                onChange={handlePriceModelChange}
                ariaLabel={t('usage_stats.model_name')}
              />
            </div>
            <div className={`${styles.priceField} ${styles.priceFieldPrompt}`}>
              <label>{`${t('usage_stats.model_price_prompt')} ($/1M)`}</label>
              <Input
                type="number"
                value={priceDraft.prompt}
                onChange={(event) => handlePriceDraftChange('prompt', event.target.value)}
                placeholder="0.0000"
                step="0.0001"
              />
            </div>
            <div className={`${styles.priceField} ${styles.priceFieldCompletion}`}>
              <label>{`${t('usage_stats.model_price_completion')} ($/1M)`}</label>
              <Input
                type="number"
                value={priceDraft.completion}
                onChange={(event) => handlePriceDraftChange('completion', event.target.value)}
                placeholder="0.0000"
                step="0.0001"
              />
            </div>
            <div className={`${styles.priceField} ${styles.priceFieldCache}`}>
              <label>{`${t('usage_stats.model_price_cache')} ($/1M)`}</label>
              <Input
                type="number"
                value={priceDraft.cache}
                onChange={(event) => handlePriceDraftChange('cache', event.target.value)}
                placeholder="0.0000"
                step="0.0001"
              />
            </div>
          </div>

          <div className={styles.priceActionsBar}>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSyncModelPrices}
              loading={syncingPrices}
            >
              {t('usage_stats.model_price_sync')}
            </Button>
            <Button variant="secondary" size="sm" onClick={resetPriceEditor}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSavePrice} disabled={!priceModel}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        <div className={styles.savedPricesList}>
          <div className={styles.savedPricesHeader}>{t('usage_stats.saved_prices')}</div>
          {savedPriceEntries.length > 0 ? (
            <div className={styles.savedPricesTableWrap}>
              <table className={styles.savedPricesTable}>
                <thead>
                  <tr>
                    <th>{t('usage_stats.model_name')}</th>
                    <th>{t('usage_stats.model_price_prompt')}</th>
                    <th>{t('usage_stats.model_price_completion')}</th>
                    <th>{t('usage_stats.model_price_cache')}</th>
                    <th>{t('common.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {savedPriceEntries.map(([model, price]) => (
                    <tr key={model}>
                      <td className={`${styles.monoCell} ${styles.savedPricesModelCell}`}>
                        {model}
                      </td>
                      <td>{formatPriceUnit(price.prompt)}</td>
                      <td>{formatPriceUnit(price.completion)}</td>
                      <td>{formatPriceUnit(price.cache)}</td>
                      <td className={styles.savedPricesActionsCell}>
                        <div className={styles.savedPricesActions}>
                          <button
                            type="button"
                            className={styles.inlineActionButton}
                            onClick={() => handlePriceModelChange(model)}
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            type="button"
                            className={styles.inlineActionButton}
                            onClick={() => handleDeletePrice(model)}
                          >
                            {t('common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyBlockSmall}>{t('usage_stats.model_price_empty')}</div>
          )}
        </div>
      </Modal>
    </div>
  );
}
