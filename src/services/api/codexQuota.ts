import type { AxiosRequestConfig } from 'axios';
import type { CodexDailyUsagePayload, CodexUsagePayload } from '@/types';
import {
  CODEX_DAILY_USAGE_URL,
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  parseCodexDailyUsagePayload,
  parseCodexUsagePayload,
} from '@/utils/quota';
import { apiCallApi, getApiCallErrorMessage, type ApiCallResult } from './apiCall';

export type CodexUsageRequestParams = {
  authIndex: string;
  accountId?: string | null;
  userAgent?: string;
  requestConfig?: AxiosRequestConfig;
};

export type CodexUsageRawResult = {
  result: ApiCallResult;
  payload: CodexUsagePayload | null;
};

export type CodexDailyUsageRequestParams = CodexUsageRequestParams & {
  startDate: string;
  endDateExclusive: string;
};

export type CodexDailyUsageRawResult = {
  result: ApiCallResult;
  payload: CodexDailyUsagePayload | null;
};

export const buildCodexUsageRequestHeaders = (
  accountId?: string | null,
  options: { userAgent?: string } = {}
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...CODEX_REQUEST_HEADERS,
  };

  const trimmedAccountId = String(accountId ?? '').trim();
  if (trimmedAccountId) {
    headers['Chatgpt-Account-Id'] = trimmedAccountId;
  }

  const userAgent = String(options.userAgent ?? '').trim();
  if (userAgent) {
    headers['User-Agent'] = userAgent;
  }

  return headers;
};

export const buildCodexDailyUsageUrl = (startDate: string, endDateExclusive: string): string => {
  const query = new URLSearchParams({
    start_date: startDate,
    end_date: endDateExclusive,
    group_by: 'day',
  });
  return `${CODEX_DAILY_USAGE_URL}?${query.toString()}`;
};

export const requestCodexUsageRaw = async ({
  authIndex,
  accountId,
  userAgent,
  requestConfig,
}: CodexUsageRequestParams): Promise<CodexUsageRawResult> => {
  const result = await apiCallApi.request(
    {
      authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: buildCodexUsageRequestHeaders(accountId, { userAgent }),
    },
    requestConfig
  );

  return {
    result,
    payload: parseCodexUsagePayload(result.body ?? result.bodyText),
  };
};

export const requestCodexDailyUsageRaw = async ({
  authIndex,
  accountId,
  userAgent,
  requestConfig,
  startDate,
  endDateExclusive,
}: CodexDailyUsageRequestParams): Promise<CodexDailyUsageRawResult> => {
  const result = await apiCallApi.request(
    {
      authIndex,
      method: 'GET',
      url: buildCodexDailyUsageUrl(startDate, endDateExclusive),
      header: buildCodexUsageRequestHeaders(accountId, { userAgent }),
    },
    requestConfig
  );

  return {
    result,
    payload: parseCodexDailyUsagePayload(result.body ?? result.bodyText),
  };
};

export const requestCodexUsagePayload = async (
  params: CodexUsageRequestParams,
  options: { emptyMessage?: string } = {}
): Promise<CodexUsagePayload> => {
  const { result, payload } = await requestCodexUsageRaw(params);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result));
  }
  if (!payload) {
    throw new Error(options.emptyMessage || 'No Codex quota data available');
  }
  return payload;
};
