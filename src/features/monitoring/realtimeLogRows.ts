import type { MonitoringEventRow } from './hooks/useMonitoringData';

export type RealtimeLogRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
};

const isPrefixedUsageAccount = (value: string) => value.includes('/m:') || value.includes('/k:');

const chooseRealtimeDisplayAccount = (current: string, next: string) => {
  const currentText = current.trim();
  const nextText = next.trim();
  if (!nextText) return currentText;
  if (!currentText) return nextText;
  if (isPrefixedUsageAccount(nextText) && !isPrefixedUsageAccount(currentText)) return nextText;
  return currentText;
};

export const buildRealtimeLogRows = (rows: MonitoringEventRow[]): RealtimeLogRow[] => {
  const sortedAsc = [...rows].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id)
  );
  const metricsByStream = new Map<string, { total: number; success: number; pattern: boolean[] }>();
  const preferredAccountBySourceKey = new Map<
    string,
    {
      account: string;
      accountMasked: string;
      authLabel: string;
      providerDetail: MonitoringEventRow['providerDetail'] | null;
    }
  >();

  rows.forEach((row) => {
    if (!row.sourceKey) return;
    const existing = preferredAccountBySourceKey.get(row.sourceKey) ?? {
      account: '',
      accountMasked: '',
      authLabel: '',
      providerDetail: null,
    };
    preferredAccountBySourceKey.set(row.sourceKey, {
      account: chooseRealtimeDisplayAccount(existing.account, row.account),
      accountMasked: chooseRealtimeDisplayAccount(existing.accountMasked, row.accountMasked),
      authLabel: chooseRealtimeDisplayAccount(existing.authLabel, row.authLabel),
      providerDetail: existing.providerDetail || row.providerDetail || null,
    });
  });

  const enriched = sortedAsc.map((row) => {
    const preferredAccount = row.sourceKey ? preferredAccountBySourceKey.get(row.sourceKey) : null;
    const displayRow = preferredAccount
      ? {
          ...row,
          account: preferredAccount.account || row.account,
          accountMasked: preferredAccount.accountMasked || row.accountMasked,
          authLabel: preferredAccount.authLabel || row.authLabel,
          providerDetail: preferredAccount.providerDetail || row.providerDetail,
        }
      : row;
    const streamKey = [
      displayRow.sourceKey || displayRow.account,
      displayRow.provider,
      displayRow.model,
      displayRow.channel,
    ].join('::');
    const previous = metricsByStream.get(streamKey) ?? { total: 0, success: 0, pattern: [] };
    const nextPattern = [...previous.pattern, !row.failed].slice(-10);
    const next = {
      total: previous.total + (row.statsIncluded ? 1 : 0),
      success: previous.success + (row.statsIncluded && !row.failed ? 1 : 0),
      pattern: nextPattern,
    };
    metricsByStream.set(streamKey, next);

    return {
      ...displayRow,
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
