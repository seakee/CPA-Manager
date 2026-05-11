import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconSettings,
} from '@/components/ui/icons';
import {
  clearCodexInspectionConfigurableSettings,
  DEFAULT_CODEX_INSPECTION_SETTINGS,
  loadCodexInspectionConfigurableSettings,
  saveCodexInspectionConfigurableSettings,
  type CodexInspectionAction,
  type CodexInspectionConfigurableSettings,
} from '@/features/monitoring/codexInspection';
import { authFilesApi, codexInspectionApi, type CodexInspectionLogRow, type CodexInspectionResultRow, type CodexInspectionRunDetailResponse, type CodexInspectionRunRecord } from '@/services/api';
import type { AuthFileItem } from '@/types/authFile';
import { useAuthStore, useConfigStore, useNotificationStore, useUsageServiceStore } from '@/stores';
import { normalizeAuthIndex } from '@/utils/usage';
import styles from './CodexInspectionPage.module.scss';

type ActionFilter = 'all' | 'delete' | 'disable' | 'enable';
type StatusTone = 'idle' | 'info' | 'good' | 'warn' | 'bad';

type SummaryCard = {
  key: string;
  label: string;
  value: string;
  meta: string;
  tone?: StatusTone;
};

type InspectionSettingsDraft = {
  targetType: string;
  workers: string;
  deleteWorkers: string;
  timeout: string;
  retries: string;
  userAgent: string;
  usedPercentThreshold: string;
  sampleSize: string;
  autoExecuteActions: boolean;
};

type InspectionSettingsDraftField = Exclude<keyof InspectionSettingsDraft, 'autoExecuteActions'>;

type PanelProps = {
  title: string;
  subtitle?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
};

type TargetAccountItem = {
  key: string;
  fileName: string;
  displayAccount: string;
  authIndex: string;
  provider: string;
  disabled: boolean;
};

const ACTION_FILTERS: ActionFilter[] = ['all', 'delete', 'disable', 'enable'];

const actionToneClass: Record<string, string> = {
  keep: styles.actionKeep,
  delete: styles.actionDelete,
  disable: styles.actionDisable,
  enable: styles.actionEnable,
};

const formatTimestamp = (value: number, locale: string) => new Date(value).toLocaleString(locale);
const formatPercent = (value: number | null | undefined) => (value == null ? '--' : `${value.toFixed(1)}%`);
const toSettingsDraft = (settings: CodexInspectionConfigurableSettings): InspectionSettingsDraft => ({
  targetType: settings.targetType,
  workers: String(settings.workers),
  deleteWorkers: String(settings.deleteWorkers),
  timeout: String(settings.timeout),
  retries: String(settings.retries),
  userAgent: settings.userAgent,
  usedPercentThreshold: String(settings.usedPercentThreshold),
  sampleSize: String(settings.sampleSize),
  autoExecuteActions: settings.autoExecuteActions,
});

const parseSummaryJson = (run: CodexInspectionRunRecord | null | undefined) => {
  if (!run?.summaryJson) return null;
  try { return JSON.parse(run.summaryJson) as Record<string, unknown>; } catch { return null; }
};

const parseProgressJson = (run: CodexInspectionRunRecord | null | undefined) => {
  if (!run?.progressJson) return null;
  try { return JSON.parse(run.progressJson) as Record<string, unknown>; } catch { return null; }
};

const countActions = (items: CodexInspectionResultRow[]) => ({
  delete: items.filter((item) => item.action === 'delete').length,
  disable: items.filter((item) => item.action === 'disable').length,
  enable: items.filter((item) => item.action === 'enable').length,
});

const buildTargetAccounts = (files: AuthFileItem[], targetType: string): TargetAccountItem[] =>
  files
    .filter((file) => String(file.provider || file.type || '').toLowerCase() === targetType.toLowerCase())
    .map((file) => ({
      key: `${String(file.name || '')}::${normalizeAuthIndex(file['auth_index'] ?? file.authIndex) || '-'}`,
      fileName: String(file.name || ''),
      displayAccount:
        String(file.account || file.email || file.label || file.name || file.id || '-'),
      authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex) || '',
      provider: String(file.provider || file.type || ''),
      disabled: file.disabled === true,
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));

const createSettings = (draft: InspectionSettingsDraft): CodexInspectionConfigurableSettings => ({
  targetType: draft.targetType.trim() || DEFAULT_CODEX_INSPECTION_SETTINGS.targetType,
  workers: Math.max(1, Number.parseInt(draft.workers, 10) || DEFAULT_CODEX_INSPECTION_SETTINGS.workers),
  deleteWorkers: Math.max(1, Number.parseInt(draft.deleteWorkers, 10) || DEFAULT_CODEX_INSPECTION_SETTINGS.deleteWorkers),
  timeout: Math.max(1000, Number.parseInt(draft.timeout, 10) || DEFAULT_CODEX_INSPECTION_SETTINGS.timeout),
  retries: Math.max(0, Number.parseInt(draft.retries, 10) || DEFAULT_CODEX_INSPECTION_SETTINGS.retries),
  userAgent: draft.userAgent.trim() || DEFAULT_CODEX_INSPECTION_SETTINGS.userAgent,
  usedPercentThreshold: Math.max(0, Number.parseFloat(draft.usedPercentThreshold) || DEFAULT_CODEX_INSPECTION_SETTINGS.usedPercentThreshold),
  sampleSize: Math.max(0, Number.parseInt(draft.sampleSize, 10) || 0),
  autoExecuteActions: draft.autoExecuteActions,
});

const filterByAction = (items: CodexInspectionResultRow[], filter: ActionFilter) => {
  if (filter === 'all') return items;
  return items.filter((item) => item.action === filter);
};

const formatActionLabel = (action: string, t: TFunction) => {
  switch (action as CodexInspectionAction) {
    case 'delete': return t('monitoring.codex_inspection_action_delete');
    case 'disable': return t('monitoring.codex_inspection_action_disable');
    case 'enable': return t('monitoring.codex_inspection_action_enable');
    default: return t('monitoring.codex_inspection_action_keep');
  }
};

function Panel({ title, subtitle, extra, children, className }: PanelProps) {
  return (
    <Card className={[styles.panel, className].filter(Boolean).join(' ')}>
      <div className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>{title}</h2>
          {subtitle ? <p className={styles.panelSubtitle}>{subtitle}</p> : null}
        </div>
        {extra ? <div className={styles.panelExtra}>{extra}</div> : null}
      </div>
      {children}
    </Card>
  );
}

export function CodexInspectionPage() {
  const { t, i18n } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const managementKey = useAuthStore((state) => state.managementKey);
  const usageServiceEnabled = useUsageServiceStore((state) => state.enabled);
  const usageServiceBase = useUsageServiceStore((state) => state.serviceBase);
  const showNotification = useNotificationStore((state) => state.showNotification);

  const [inspectionSettings, setInspectionSettings] = useState<CodexInspectionConfigurableSettings>(() => loadCodexInspectionConfigurableSettings(config));
  const [settingsDraft, setSettingsDraft] = useState<InspectionSettingsDraft>(() => toSettingsDraft(loadCodexInspectionConfigurableSettings(config)));
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [logsCollapsed, setLogsCollapsed] = useState(true);
  const [logs, setLogs] = useState<CodexInspectionLogRow[]>([]);
  const [resultRows, setResultRows] = useState<CodexInspectionResultRow[]>([]);
  const [selectedRun, setSelectedRun] = useState<CodexInspectionRunRecord | null>(null);
  const [historyRuns, setHistoryRuns] = useState<CodexInspectionRunRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all');
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [selectedTargetKeys, setSelectedTargetKeys] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [responseModalText, setResponseModalText] = useState('');
  const [responseModalTitle, setResponseModalTitle] = useState('');
  const pollingRef = useRef<number | null>(null);

  const resolvedServiceBase = useMemo(() => {
    if (usageServiceEnabled && usageServiceBase) return usageServiceBase;
    try {
      const { protocol, hostname } = window.location;
      return `${protocol}//${hostname}:18317`;
    } catch {
      return 'http://127.0.0.1:18317';
    }
  }, [usageServiceBase, usageServiceEnabled]);

  useEffect(() => {
    const nextSettings = loadCodexInspectionConfigurableSettings(config);
    setInspectionSettings(nextSettings);
    if (!isSettingsModalOpen) setSettingsDraft(toSettingsDraft(nextSettings));
  }, [config, isSettingsModalOpen]);

  const refreshRuns = useCallback(async () => {
    const [latest, runs, files] = await Promise.all([
      codexInspectionApi.getLatest(resolvedServiceBase, managementKey),
      codexInspectionApi.listRuns(resolvedServiceBase, managementKey),
      authFilesApi.list(),
    ]);
    setHistoryRuns(runs.runs || []);
    setAuthFiles(files.files || []);
    setSelectedRun(latest.run || null);
    setResultRows(latest.results || []);
    setLogs(latest.logs || []);
  }, [managementKey, resolvedServiceBase]);

  useEffect(() => {
    if (!resolvedServiceBase || !managementKey) return;
    void refreshRuns().catch(() => {});
  }, [managementKey, refreshRuns, resolvedServiceBase]);

  const targetAccounts = useMemo(() => buildTargetAccounts(authFiles, inspectionSettings.targetType), [authFiles, inspectionSettings.targetType]);
  const selectedTargets = useMemo(() => new Set(selectedTargetKeys), [selectedTargetKeys]);
  const filteredResults = useMemo(() => filterByAction(resultRows.filter((item) => item.action !== 'keep'), actionFilter), [resultRows, actionFilter]);
  const pendingActionCount = useMemo(() => resultRows.filter((item) => item.action !== 'keep').length, [resultRows]);
  const filterCounts = useMemo(() => ({ all: resultRows.filter((item) => item.action !== 'keep').length, ...countActions(resultRows) }), [resultRows]);
  const summary = useMemo(() => parseSummaryJson(selectedRun), [selectedRun]);
  const progress = useMemo(() => parseProgressJson(selectedRun), [selectedRun]);

  useEffect(() => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (!selectedRun || (selectedRun.status !== 'running' && selectedRun.status !== 'paused')) return;
    pollingRef.current = window.setInterval(() => {
      void codexInspectionApi.getRun(resolvedServiceBase, managementKey, selectedRun.runId).then((data: CodexInspectionRunDetailResponse) => {
        setSelectedRun(data.run || null);
        setResultRows(data.results || []);
        setLogs(data.logs || []);
        void codexInspectionApi.listRuns(resolvedServiceBase, managementKey).then((runs) => setHistoryRuns(runs.runs || [])).catch(() => {});
      }).catch(() => {});
    }, 2000);
    return () => {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [managementKey, resolvedServiceBase, selectedRun]);

  const handleSettingsDraftChange = useCallback((field: InspectionSettingsDraftField, value: string) => {
    setSettingsDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleAutoExecuteChange = useCallback((checked: boolean) => {
    setSettingsDraft((prev) => ({ ...prev, autoExecuteActions: checked }));
  }, []);

  const handleSaveSettings = useCallback(() => {
    const next = saveCodexInspectionConfigurableSettings(createSettings(settingsDraft));
    setInspectionSettings(next);
    setSettingsDraft(toSettingsDraft(next));
    setIsSettingsModalOpen(false);
    showNotification(t('common.save_success'), 'success');
  }, [settingsDraft, showNotification, t]);

  const handleResetSettings = useCallback(() => {
    clearCodexInspectionConfigurableSettings();
    const next = loadCodexInspectionConfigurableSettings(config);
    setInspectionSettings(next);
    setSettingsDraft(toSettingsDraft(next));
  }, [config]);

  const handleRunInspection = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }
    setIsLoading(true);
    try {
      const payload = {
        ...createSettings(settingsDraft),
        selectedAccounts: selectedTargetKeys,
      };
      await codexInspectionApi.start(resolvedServiceBase, managementKey, payload);
      await refreshRuns();
      setLogsCollapsed(false);
      showNotification(t('monitoring.codex_inspection_run_success'), 'success');
    } catch (error: unknown) {
      showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
    } finally {
      setIsLoading(false);
    }
  }, [connectionStatus, managementKey, refreshRuns, resolvedServiceBase, selectedTargetKeys, settingsDraft, showNotification, t]);

  const handleStopInspection = useCallback(async () => {
    if (!selectedRun?.runId) return;
    await codexInspectionApi.stop(resolvedServiceBase, managementKey, selectedRun.runId);
    await refreshRuns();
  }, [managementKey, refreshRuns, resolvedServiceBase, selectedRun]);

  const handlePauseInspection = useCallback(async () => {
    if (!selectedRun?.runId) return;
    await codexInspectionApi.pause(resolvedServiceBase, managementKey, selectedRun.runId);
    await refreshRuns();
  }, [managementKey, refreshRuns, resolvedServiceBase, selectedRun]);

  const handleSelectRun = useCallback(async (runId: string) => {
    const data = await codexInspectionApi.getRun(resolvedServiceBase, managementKey, runId);
    setSelectedRun(data.run || null);
    setResultRows(data.results || []);
    setLogs(data.logs || []);
    setHistoryOpen(false);
  }, []);

  const toggleTargetKey = useCallback((key: string) => {
    setSelectedTargetKeys((prev) => prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]);
  }, []);

  const statusTone: StatusTone = selectedRun?.status === 'running' ? 'info' : selectedRun?.status === 'paused' ? 'warn' : selectedRun?.status === 'completed' ? 'good' : selectedRun?.status === 'failed' ? 'bad' : 'idle';
  const statusLabel = selectedRun?.status || 'idle';
  const progressPercent = Number(progress?.percent ?? 0);
  const progressLabel = progress ? `\u5df2\u5b8c\u6210 ${progress.completed} / ${progress.total} \u00b7 \u8fdb\u884c\u4e2d ${progress.inFlight} \u00b7 \u5f85\u5904\u7406 ${progress.pending}` : (selectedRun ? `\u5f53\u524d\u5feb\u7167\u672a\u8bb0\u5f55\u8fdb\u5ea6\uff08\u72b6\u6001\uff1a${selectedRun.status}\uff09` : t('monitoring.codex_inspection_progress_idle'));
  const isInspectionInFlight = selectedRun?.status === 'running' || selectedRun?.status === 'paused';
  const runButtonLabel = isInspectionInFlight ? t('monitoring.codex_inspection_running') : t('monitoring.codex_inspection_run');

  const summaryCards = useMemo<SummaryCard[]>(() => {
    const blank = '--';
    return [
      { key: 'pending', label: t('monitoring.codex_inspection_action_total'), value: String(pendingActionCount), meta: pendingActionCount > 0 ? t('monitoring.codex_inspection_pending_total') : '\u6682\u65e0', tone: pendingActionCount > 0 ? 'warn' : 'good' },
      { key: 'probe', label: t('monitoring.codex_inspection_probe_total'), value: String(summary?.probeSetCount ?? blank), meta: `${t('monitoring.codex_inspection_target_type')} ${inspectionSettings.targetType}` },
      { key: 'sampled', label: t('monitoring.codex_inspection_sampled_total'), value: String(summary?.sampledCount ?? blank), meta: selectedRun ? `${progressPercent}%` : '\u6682\u65e0' },
      { key: 'delete', label: t('monitoring.codex_inspection_delete_count'), value: String(Number(summary?.deleteCount ?? 0) || blank), meta: '\u6682\u65e0', tone: Number(summary?.deleteCount ?? 0) > 0 ? 'bad' : 'idle' },
      { key: 'disable', label: t('monitoring.codex_inspection_disable_count'), value: String(Number(summary?.disableCount ?? 0) || blank), meta: '\u6682\u65e0', tone: Number(summary?.disableCount ?? 0) > 0 ? 'warn' : 'idle' },
      { key: 'enable', label: t('monitoring.codex_inspection_enable_count'), value: String(Number(summary?.enableCount ?? 0) || blank), meta: '\u6682\u65e0', tone: Number(summary?.enableCount ?? 0) > 0 ? 'good' : 'idle' },
    ];
  }, [inspectionSettings.targetType, pendingActionCount, progressPercent, selectedRun, summary, t]);

  const formatFilterLabel = (filter: ActionFilter) => {
    switch (filter) {
      case 'delete': return t('monitoring.codex_inspection_filter_delete');
      case 'disable': return t('monitoring.codex_inspection_filter_disable');
      case 'enable': return t('monitoring.codex_inspection_filter_enable');
      default: return t('monitoring.codex_inspection_filter_all');
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('monitoring.codex_inspection_title')}</h1>
        <p className={styles.description}>{t('monitoring.codex_inspection_desc')}</p>
      </div>

      <Card className={`${styles.panel} ${styles.statusPanel}`}>
        <div className={styles.statusBar}>
          <div className={styles.statusInfo}>
            <span className={`${styles.statusBadge} ${styles[`tone-${statusTone}`]}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              {statusLabel}
            </span>
            <div className={styles.statusMeta}>
              <span>{`${t('monitoring.codex_inspection_target_type')}: ${inspectionSettings.targetType}`}</span>
              <span>{`${t('monitoring.codex_inspection_threshold')}: ${inspectionSettings.usedPercentThreshold}%`}</span>
              <span>{`${t('monitoring.codex_inspection_workers')}: ${inspectionSettings.workers}`}</span>
              <span>{`${t('monitoring.codex_inspection_sample_size')}: ${inspectionSettings.sampleSize || t('common.no')}`}</span>
              {selectedRun?.runName ? <span>{selectedRun.runName}</span> : null}
              {pendingActionCount > 0 ? <span className={styles.statusMetaWarn}>{`${t('monitoring.codex_inspection_pending_total')} ${pendingActionCount}`}</span> : null}
            </div>
          </div>
          <div className={styles.statusActions}>
            <Link to="/monitoring" className={styles.quickLink}>
              <IconExternalLink size={14} />
              <span>{t('monitoring.codex_inspection_back')}</span>
            </Link>
            <button type="button" className={styles.iconButton} onClick={() => setHistoryOpen(true)} title="History">
              <IconChevronDown size={16} />
            </button>
            <button type="button" className={styles.iconButton} onClick={() => setIsSettingsModalOpen(true)} title={t('monitoring.codex_inspection_settings_button')}>
              <IconSettings size={16} />
            </button>
            <Button variant="primary" onClick={handleRunInspection} loading={isLoading} disabled={isLoading || connectionStatus !== 'connected' || isInspectionInFlight}>{runButtonLabel}</Button>
            {isInspectionInFlight ? (
              <>
                <Button variant="secondary" onClick={handlePauseInspection}>{t('monitoring.codex_inspection_pause')}</Button>
                <Button variant="danger" onClick={handleStopInspection}>{t('monitoring.codex_inspection_stop')}</Button>
              </>
            ) : null}
          </div>
        </div>
        {selectedRun ? (
          <div className={styles.progressSection}>
            <div className={styles.progressHeader}><strong>{t('monitoring.codex_inspection_progress_title')}</strong><span>{`${progressPercent}%`}</span></div>
            <div className={styles.progressTrack}><span className={styles.progressBar} style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} /></div>
            <div className={styles.progressMeta}><span>{progressLabel}</span></div>
          </div>
        ) : null}
      </Card>

      <section className={styles.summaryGrid}>
        {summaryCards.map((card) => (
          <Card key={card.key} className={[styles.summaryCard, card.tone ? styles[`tone-${card.tone}`] : ''].filter(Boolean).join(' ')}>
            <span className={styles.summaryLabel}>{card.label}</span>
            <strong className={styles.summaryValue}>{card.value}</strong>
            <span className={styles.summaryMeta}>{card.meta}</span>
          </Card>
        ))}
      </section>

      <Panel title={t('monitoring.codex_inspection_results_title')} subtitle={t('monitoring.codex_inspection_results_desc')}>
        <div className={styles.filterRow}>
          <div className={styles.segmentedControl}>
            {ACTION_FILTERS.map((filter) => (
              <button key={filter} type="button" className={`${styles.segmentButton} ${actionFilter === filter ? styles.segmentButtonActive : ''}`} onClick={() => setActionFilter(filter)}>
                <span>{formatFilterLabel(filter)}</span>
                <span className={styles.segmentCount}>{filterCounts[filter]}</span>
              </button>
            ))}
          </div>
        </div>
        {selectedRun ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <colgroup>
                <col className={styles.accountColumn} />
                <col className={styles.stateColumn} />
                <col className={styles.httpColumn} />
                <col className={styles.usageColumn} />
                <col className={styles.actionColumn} />
                <col className={styles.operationColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('monitoring.account_label')}</th>
                  <th>{t('monitoring.codex_inspection_current_state')}</th>
                  <th>{t('monitoring.codex_inspection_http_status')}</th>
                  <th>{t('monitoring.codex_inspection_used_percent')}</th>
                  <th>{t('monitoring.codex_inspection_next_action')}</th>
                  <th>{t('common.action')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.length > 0 ? filteredResults.map((item) => (
                  <tr key={item.accountKey}>
                    <td>
                      <div className={styles.primaryCell}>
                        <span className={styles.primaryAccount}>{item.displayAccount}</span>
                        <small className={styles.primaryFile}>{item.fileName}{item.authIndex ? <span className={styles.primaryIndex}>{` ? #${item.authIndex}`}</span> : null}</small>
                        {item.actionReason ? <small className={styles.primaryReason}>{item.actionReason}</small> : null}
                        {item.error ? <small className={styles.primaryError}>{item.error}</small> : null}
                      </div>
                    </td>
                    <td><span className={`${styles.stateChip} ${item.disabled ? styles.stateDisabled : styles.stateEnabled}`}>{item.disabled ? t('monitoring.codex_inspection_state_disabled') : t('monitoring.codex_inspection_state_enabled')}</span></td>
                    <td className={styles.monoCell}>{item.statusCode == null ? '--' : item.statusCode}</td>
                    <td className={styles.monoCell}>{formatPercent(item.usedPercent ?? null)}</td>
                    <td><span className={`${styles.actionBadge} ${actionToneClass[item.action] || styles.actionKeep}`}>{formatActionLabel(item.action, t)}</span></td>
                    <td>
                      <Button size="sm" variant="secondary" onClick={() => { setResponseModalTitle(item.displayAccount); setResponseModalText(item.responseBodyJson || item.responseBodyText || item.error || '--'); }}>
                        {t('common.detail')}
                      </Button>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={6}><div className={styles.emptyBlockSmall}>{t('monitoring.codex_inspection_no_pending_actions')}</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.emptyBlock}>{t('monitoring.codex_inspection_empty')}</div>}
      </Panel>

      <Panel title={t('monitoring.codex_inspection_logs_title')} subtitle={t('monitoring.codex_inspection_logs_desc')} extra={<div className={styles.logActions}><button type="button" className={styles.foldButton} onClick={() => setLogsCollapsed((prev) => !prev)}>{logsCollapsed ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}<span>{logsCollapsed ? t('monitoring.codex_inspection_expand_logs') : t('monitoring.codex_inspection_fold_logs')}</span></button></div>}>
        {!logsCollapsed ? (
          <div className={styles.logList}>
            {logs.length > 0 ? logs.map((entry) => (
              <div key={entry.id} className={`${styles.logRow} ${styles[`log${entry.level[0].toUpperCase()}${entry.level.slice(1)}`] || ''}`}>
                <span className={styles.logTime}>{formatTimestamp(entry.createdAtMs, i18n.language)}</span>
                <span className={styles.logMessage}>{entry.message}</span>
              </div>
            )) : <div className={styles.emptyBlockSmall}>{t('monitoring.codex_inspection_logs_empty')}</div>}
          </div>
        ) : <div className={styles.logCollapsedBar}><span>{t('monitoring.codex_inspection_logs_collapsed', { count: logs.length })}</span></div>}
      </Panel>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="巡检历史" width={820} className={styles.settingsModal}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>快照</th><th>状态</th><th>目标</th><th>开始时间</th><th>操作</th></tr></thead>
            <tbody>
              {historyRuns.map((run) => (
                <tr key={run.runId} className={styles.clickableRow} onClick={() => void handleSelectRun(run.runId)}>
                  <td>{run.runName}</td>
                  <td>{run.status}</td>
                  <td>{run.targetType}</td>
                  <td>{formatTimestamp(run.startedAtMs, i18n.language)}</td>
                  <td><Button size="sm" variant="secondary" onClick={(event) => { event.stopPropagation(); void handleSelectRun(run.runId); }}>查看</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>

      <Modal open={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} title={t('monitoring.codex_inspection_settings_title')} width={920} className={styles.settingsModal}>
        <div className={styles.settingsBody}>
          <section className={styles.settingsSection}>
            <header className={styles.settingsSectionHeader}><span>{t('monitoring.codex_inspection_settings_group_strategy')}</span></header>
            <div className={styles.settingsGrid}>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_target_type_label')} value={settingsDraft.targetType} onChange={(event) => handleSettingsDraftChange('targetType', event.target.value)} placeholder={DEFAULT_CODEX_INSPECTION_SETTINGS.targetType} /></div>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_used_percent_threshold_label')} type="number" value={settingsDraft.usedPercentThreshold} onChange={(event) => handleSettingsDraftChange('usedPercentThreshold', event.target.value)} min={0} max={100} step={0.1} /></div>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_sample_size_label')} type="number" value={settingsDraft.sampleSize} onChange={(event) => handleSettingsDraftChange('sampleSize', event.target.value)} min={0} step={1} /></div>
            </div>
          </section>
          <section className={styles.settingsSection}>
            <header className={styles.settingsSectionHeader}><span>{t('monitoring.codex_inspection_settings_group_concurrency')}</span></header>
            <div className={styles.settingsGrid}>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_workers_label')} type="number" value={settingsDraft.workers} onChange={(event) => handleSettingsDraftChange('workers', event.target.value)} min={1} step={1} /></div>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_delete_workers_label')} type="number" value={settingsDraft.deleteWorkers} onChange={(event) => handleSettingsDraftChange('deleteWorkers', event.target.value)} min={1} step={1} /></div>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_timeout_label')} type="number" value={settingsDraft.timeout} onChange={(event) => handleSettingsDraftChange('timeout', event.target.value)} min={1} step={100} /></div>
              <div className={styles.settingsField}><Input label={t('monitoring.codex_inspection_settings_retries_label')} type="number" value={settingsDraft.retries} onChange={(event) => handleSettingsDraftChange('retries', event.target.value)} min={0} step={1} /></div>
              <div className={`${styles.settingsField} ${styles.settingsFieldWide}`}><Input label={t('monitoring.codex_inspection_settings_user_agent_label')} value={settingsDraft.userAgent} onChange={(event) => handleSettingsDraftChange('userAgent', event.target.value)} placeholder={DEFAULT_CODEX_INSPECTION_SETTINGS.userAgent} /></div>
            </div>
          </section>
          <section className={styles.settingsSection}>
            <header className={styles.settingsSectionHeader}><span>自定义巡检账号</span></header>
            <div className={styles.tableWrap} style={{ maxHeight: 320, overflow: 'auto' }}>
              <table className={styles.table}>
                <thead><tr><th>选择</th><th>账号</th><th>文件</th><th>auth_index</th></tr></thead>
                <tbody>
                  {targetAccounts.map((item) => (
                    <tr key={item.key}>
                      <td><input type="checkbox" checked={selectedTargets.has(item.fileName) || selectedTargets.has(item.authIndex) || selectedTargets.has(item.displayAccount)} onChange={() => toggleTargetKey(item.fileName)} /></td>
                      <td>{item.displayAccount}</td>
                      <td>{item.fileName}</td>
                      <td className={styles.monoCell}>{item.authIndex || '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className={styles.settingsSection}>
            <header className={styles.settingsSectionHeader}><span>{t('monitoring.codex_inspection_settings_group_auto')}</span></header>
            <div className={styles.settingsAutoCard}>
              <div className={styles.settingsAutoToggle}><ToggleSwitch checked={settingsDraft.autoExecuteActions} onChange={handleAutoExecuteChange} label={t('monitoring.codex_inspection_settings_auto_execute_actions_label')} ariaLabel={t('monitoring.codex_inspection_settings_auto_execute_actions_label')} labelPosition="left" /></div>
              <p className={styles.settingsAutoHint}>
                {t('monitoring.codex_inspection_settings_auto_execute_actions_hint')}
              </p>
              {settingsDraft.autoExecuteActions ? (
                <p className={styles.settingsAutoWarning}>
                  {t('monitoring.codex_inspection_settings_auto_execute_warning')}
                </p>
              ) : null}
            </div>
          </section>
        </div>
        <div className={styles.settingsActionsBar}>
          <Button variant="secondary" onClick={handleResetSettings}>{t('monitoring.codex_inspection_settings_reset_button')}</Button>
          <Button variant="secondary" onClick={() => setIsSettingsModalOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSaveSettings}>{t('common.save')}</Button>
        </div>
      </Modal>

      <Modal open={Boolean(responseModalText)} onClose={() => setResponseModalText('')} title={responseModalTitle || '\u54cd\u5e94\u8be6\u60c5'} width={900} className={styles.settingsModal}>
        <div className={styles.logList}><pre className={styles.logMessage} style={{ whiteSpace: 'pre-wrap' }}>{responseModalText}</pre></div>
      </Modal>
    </div>
  );
}
