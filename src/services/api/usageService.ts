import axios from 'axios';
import type { UsagePayload } from '@/features/monitoring/hooks/useUsageData';
import { normalizeApiBase } from '@/utils/connection';
import type { ModelPrice } from '@/utils/usage';

export interface UsageServiceInfo {
  service?: string;
  mode?: string;
  startedAt?: number;
}

export interface UsageServiceCollectorStatus {
  collector?: string;
  upstream?: string;
  mode?: string;
  transport?: string;
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

export interface UsageServiceApiKeyMapItem {
  apiKeyHash: string;
  apiKeyLabel: string;
  apiKeyMasked: string;
}

export interface UsageServiceApiKeyMapResponse {
  items: UsageServiceApiKeyMapItem[];
}

export interface UsageServiceSetupRequest {
  cpaBaseUrl: string;
  managementKey: string;
  queue?: string;
  popSide?: string;
}

export interface ModelPricesResponse {
  prices: Record<string, ModelPrice>;
}

export interface ModelPriceSyncResponse extends ModelPricesResponse {
  source?: string;
  imported: number;
  skipped: number;
}

export interface UsageImportResponse {
  format?: string;
  added: number;
  skipped: number;
  total: number;
  failed: number;
  unsupported?: number;
  warnings?: string[];
}

export interface UsageExportResponse {
  blob: Blob;
  filename: string;
}

const USAGE_SERVICE_TIMEOUT_MS = 15 * 1000;
const USAGE_SERVICE_TRANSFER_TIMEOUT_MS = 60 * 1000;
export const USAGE_SERVICE_ID = 'cpa-manager';
export const LEGACY_USAGE_SERVICE_ID = 'cpa-usage-service';
export const USAGE_SERVICE_LAST_CPA_BASE_KEY = 'cpa-manager:last-cpa-base';
export const LEGACY_USAGE_SERVICE_LAST_CPA_BASE_KEY = 'cpa-usage-service:last-cpa-base';

export const isUsageServiceId = (service?: string): boolean =>
  service === USAGE_SERVICE_ID || service === LEGACY_USAGE_SERVICE_ID;

export const normalizeUsageServiceBase = (input: string): string => normalizeApiBase(input);

const buildUrl = (base: string, path: string): string => {
  const normalized = normalizeUsageServiceBase(base).replace(/\/+$/, '');
  return `${normalized}${path}`;
};

const authHeaders = (managementKey?: string) =>
  managementKey ? { Authorization: `Bearer ${managementKey}` } : undefined;

const readHeader = (headers: unknown, name: string): string => {
  if (!headers || typeof headers !== 'object') return '';
  const getter = (headers as { get?: (key: string) => unknown }).get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    return value === undefined || value === null ? '' : String(value);
  }
  const target = name.toLowerCase();
  const entries = Object.entries(headers as Record<string, unknown>);
  const match = entries.find(([key]) => key.toLowerCase() === target);
  return match?.[1] === undefined || match?.[1] === null ? '' : String(match[1]);
};

const parseContentDispositionFilename = (value: string): string => {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return utf8Match[1].trim();
    }
  }
  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1].trim();
  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() || '';
};

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

  getApiKeyMap: async (
    base: string,
    managementKey?: string
  ): Promise<UsageServiceApiKeyMapResponse> => {
    const response = await axios.get<UsageServiceApiKeyMapResponse>(
      buildUrl(base, '/v0/management/api-key-map'),
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  getModelPrices: async (
    base: string,
    managementKey?: string
  ): Promise<ModelPricesResponse> => {
    const response = await axios.get<ModelPricesResponse>(
      buildUrl(base, '/v0/management/model-prices'),
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  saveModelPrices: async (
    base: string,
    prices: Record<string, ModelPrice>,
    managementKey?: string
  ): Promise<ModelPricesResponse> => {
    const response = await axios.put<ModelPricesResponse>(
      buildUrl(base, '/v0/management/model-prices'),
      { prices },
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  syncModelPrices: async (
    base: string,
    managementKey?: string,
    models?: string[]
  ): Promise<ModelPriceSyncResponse> => {
    const response = await axios.post<ModelPriceSyncResponse>(
      buildUrl(base, '/v0/management/model-prices/sync'),
      models ? { models } : {},
      {
        timeout: 30 * 1000,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  exportUsage: async (
    base: string,
    managementKey?: string
  ): Promise<UsageExportResponse> => {
    const response = await axios.get<Blob>(buildUrl(base, '/v0/management/usage/export'), {
      timeout: USAGE_SERVICE_TRANSFER_TIMEOUT_MS,
      headers: authHeaders(managementKey),
      responseType: 'blob',
    });
    const contentDisposition = readHeader(response.headers, 'content-disposition');
    return {
      blob: response.data,
      filename: parseContentDispositionFilename(contentDisposition) || 'usage-events.jsonl',
    };
  },

  importUsage: async (
    base: string,
    payload: Blob | string,
    managementKey?: string
  ): Promise<UsageImportResponse> => {
    const response = await axios.post<UsageImportResponse>(
      buildUrl(base, '/v0/management/usage/import'),
      payload,
      {
        timeout: USAGE_SERVICE_TRANSFER_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },
};
