import axios from 'axios';
import type { UsagePayload } from '@/features/monitoring/hooks/useUsageData';
import { normalizeApiBase } from '@/utils/connection';

export interface UsageServiceInfo {
  service?: string;
  mode?: string;
  startedAt?: number;
}

export interface UsageServiceCollectorStatus {
  collector?: string;
  upstream?: string;
  queue?: string;
  lastConsumedAt?: number;
  lastInsertedAt?: number;
  totalInserted?: number;
  totalSkipped?: number;
  deadLetters?: number;
  lastError?: string;
}

export interface UsageServiceStatus {
  service?: string;
  dbPath?: string;
  events?: number;
  deadLetters?: number;
  collector?: UsageServiceCollectorStatus;
}

export interface UsageServiceSetupRequest {
  cpaBaseUrl: string;
  managementKey: string;
  queue?: string;
  popSide?: string;
}

const USAGE_SERVICE_TIMEOUT_MS = 15 * 1000;

export const normalizeUsageServiceBase = (input: string): string => normalizeApiBase(input);

const buildUrl = (base: string, path: string): string => {
  const normalized = normalizeUsageServiceBase(base).replace(/\/+$/, '');
  return `${normalized}${path}`;
};

const authHeaders = (managementKey?: string) =>
  managementKey ? { Authorization: `Bearer ${managementKey}` } : undefined;

export const usageServiceApi = {
  getInfo: async (base: string): Promise<UsageServiceInfo> => {
    const response = await axios.get<UsageServiceInfo>(buildUrl(base, '/usage-service/info'), {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
    });
    return response.data;
  },

  setup: async (base: string, payload: UsageServiceSetupRequest): Promise<void> => {
    await axios.post(buildUrl(base, '/setup'), payload, {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
    });
  },

  getStatus: async (base: string, managementKey?: string): Promise<UsageServiceStatus> => {
    const response = await axios.get<UsageServiceStatus>(buildUrl(base, '/status'), {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
      headers: authHeaders(managementKey),
    });
    return response.data;
  },

  getUsage: async (base: string, managementKey?: string): Promise<UsagePayload> => {
    const response = await axios.get<UsagePayload>(buildUrl(base, '/v0/management/usage'), {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
      headers: authHeaders(managementKey),
    });
    return response.data;
  },
};
