import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUsageData } from './useUsageData';

const { mocks } = vi.hoisted(() => {
  return {
    mocks: {
      getModelPrices: vi.fn(),
      saveModelPrices: vi.fn(),
      getApiKeyAliases: vi.fn(),
      getUsage: vi.fn(),
      loadStoredModelPrices: vi.fn(),
      clearModelPrices: vi.fn(),
      saveStoredModelPrices: vi.fn(),
    },
  };
});

vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: { apiBase: string; managementKey: string }) => unknown) =>
    selector({ apiBase: 'http://cpa.local', managementKey: 'management-key' }),
  useUsageServiceStore: (selector: (state: { enabled: boolean; serviceBase: string }) => unknown) =>
    selector({ enabled: true, serviceBase: 'http://usage.local' }),
}));

vi.mock('@/services/api/usageService', () => ({
  isUsageServiceId: (value: string) => value === 'usage-service',
  normalizeUsageServiceBase: (value: string) => value.replace(/\/+$/, ''),
  usageServiceApi: {
    getModelPrices: mocks.getModelPrices,
    saveModelPrices: mocks.saveModelPrices,
    getApiKeyAliases: mocks.getApiKeyAliases,
    getUsage: mocks.getUsage,
  },
}));

vi.mock('@/utils/connection', () => ({
  detectApiBaseFromLocation: () => '',
}));

vi.mock('@/utils/usage', () => ({
  clearModelPrices: mocks.clearModelPrices,
  loadModelPrices: mocks.loadStoredModelPrices,
  saveModelPrices: mocks.saveStoredModelPrices,
}));

type UseUsageDataHarness = {
  getCurrent: () => ReturnType<typeof useUsageData>;
  unmount: () => void;
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

const mountUseUsageData = async (): Promise<UseUsageDataHarness> => {
  let hook: ReturnType<typeof useUsageData> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function HookHarness() {
    const current = useUsageData();
    useEffect(() => {
      hook = current;
    });
    return null;
  }

  await act(async () => {
    renderer = create(createElement(HookHarness));
    await flushPromises();
  });

  return {
    getCurrent: () => {
      if (!hook) {
        throw new Error('Failed to mount useUsageData test harness');
      }
      return hook;
    },
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

beforeEach(() => {
  mocks.getModelPrices.mockReset();
  mocks.saveModelPrices.mockReset();
  mocks.getApiKeyAliases.mockReset();
  mocks.getUsage.mockReset();
  mocks.loadStoredModelPrices.mockReset();
  mocks.clearModelPrices.mockReset();
  mocks.saveStoredModelPrices.mockReset();

  mocks.getApiKeyAliases.mockResolvedValue({ items: [] });
  mocks.getUsage.mockResolvedValue({});
  mocks.loadStoredModelPrices.mockReturnValue({});
});

describe('useUsageData', () => {
  it('reloads model prices when loadModelPrices is called again', async () => {
    mocks.getModelPrices
      .mockResolvedValueOnce({ prices: { 'gpt-initial': { prompt: 1, completion: 2, cache: 0 } } })
      .mockResolvedValueOnce({ prices: { 'gpt-refreshed': { prompt: 3, completion: 4, cache: 0 } } });

    const harness = await mountUseUsageData();

    expect(harness.getCurrent().modelPrices).toEqual({
      'gpt-initial': { prompt: 1, completion: 2, cache: 0 },
    });

    await act(async () => {
      await harness.getCurrent().loadModelPrices();
    });

    expect(harness.getCurrent().modelPrices).toEqual({
      'gpt-refreshed': { prompt: 3, completion: 4, cache: 0 },
    });
    expect(mocks.getModelPrices).toHaveBeenCalledTimes(2);

    harness.unmount();
  });
});
