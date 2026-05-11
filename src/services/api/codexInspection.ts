import axios from 'axios';
import { normalizeUsageServiceBase } from './usageService';

export interface CodexInspectionRunRecord {
  runId: string;
  runName: string;
  status: string;
  targetType: string;
  workers: number;
  deleteWorkers: number;
  timeout: number;
  retries: number;
  userAgent: string;
  usedPercentThreshold: number;
  sampleSize: number;
  autoExecuteActions: boolean;
  targetScopeType: string;
  selectedTargetsJson?: string;
  summaryJson?: string;
  progressJson?: string;
  startedAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number | null;
}

export interface CodexInspectionResultRow {
  runId: string;
  accountKey: string;
  fileName: string;
  displayAccount: string;
  authIndex?: string;
  accountId?: string;
  provider?: string;
  disabled: boolean;
  status?: string;
  state?: string;
  action: string;
  actionReason?: string;
  statusCode?: number | null;
  usedPercent?: number | null;
  isQuota: boolean;
  error?: string;
  responseBodyText?: string;
  responseBodyJson?: string;
  responseHeadersJson?: string;
  updatedAtMs: number;
}

export interface CodexInspectionLogRow {
  id: number;
  runId: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  createdAtMs: number;
}

export interface CodexInspectionRunDetailResponse {
  run: CodexInspectionRunRecord | null;
  results: CodexInspectionResultRow[];
  logs: CodexInspectionLogRow[];
}

export interface CodexInspectionStartRequest {
  targetType: string;
  workers: number;
  deleteWorkers: number;
  timeout: number;
  retries: number;
  userAgent: string;
  usedPercentThreshold: number;
  sampleSize: number;
  autoExecuteActions: boolean;
  selectedAccounts?: string[];
}

const buildUrl = (base: string, path: string): string => `${normalizeUsageServiceBase(base).replace(/\/+$/, '')}${path}`;
const authHeaders = (managementKey?: string) => managementKey ? { Authorization: `Bearer ${managementKey}` } : undefined;
const TIMEOUT = 30 * 1000;

export const codexInspectionApi = {
  start: (base: string, managementKey: string, payload: CodexInspectionStartRequest) =>
    axios.post<{ run: CodexInspectionRunRecord }>(buildUrl(base, '/v0/management/codex-inspection/runs'), payload, { timeout: TIMEOUT, headers: authHeaders(managementKey) }).then((r) => r.data),
  listRuns: (base: string, managementKey: string) =>
    axios.get<{ runs: CodexInspectionRunRecord[] }>(buildUrl(base, '/v0/management/codex-inspection/runs'), { timeout: TIMEOUT, headers: authHeaders(managementKey) }).then((r) => r.data),
  getLatest: (base: string, managementKey: string) =>
    axios.get<CodexInspectionRunDetailResponse>(buildUrl(base, '/v0/management/codex-inspection/runs/latest'), { timeout: TIMEOUT, headers: authHeaders(managementKey) }).then((r) => r.data),
  getRun: (base: string, managementKey: string, runId: string) =>
    axios.get<CodexInspectionRunDetailResponse>(buildUrl(base, `/v0/management/codex-inspection/runs/${encodeURIComponent(runId)}`), { timeout: TIMEOUT, headers: authHeaders(managementKey) }).then((r) => r.data),
  pause: (base: string, managementKey: string, runId: string) =>
    axios.post(buildUrl(base, `/v0/management/codex-inspection/runs/${encodeURIComponent(runId)}/pause`), {}, { timeout: TIMEOUT, headers: authHeaders(managementKey) }).then((r) => r.data),
  stop: (base: string, managementKey: string, runId: string) =>
    axios.post(buildUrl(base, `/v0/management/codex-inspection/runs/${encodeURIComponent(runId)}/stop`), {}, { timeout: TIMEOUT, headers: authHeaders(managementKey) }).then((r) => r.data),
};
