import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { normalizeUsageServiceBase } from '@/services/api/usageService';

export interface UsageServiceStoreState {
  enabled: boolean;
  serviceBase: string;
  setUsageServiceConfig: (config: { enabled: boolean; serviceBase: string }) => void;
  clearUsageServiceConfig: () => void;
}

export const useUsageServiceStore = create<UsageServiceStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      serviceBase: '',
      setUsageServiceConfig: ({ enabled, serviceBase }) => {
        set({
          enabled,
          serviceBase: enabled ? normalizeUsageServiceBase(serviceBase) : '',
        });
      },
      clearUsageServiceConfig: () => set({ enabled: false, serviceBase: '' }),
    }),
    {
      name: 'cli-proxy-usage-service',
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const data = obfuscatedStorage.getItem<UsageServiceStoreState>(name);
          return data ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({
        enabled: state.enabled,
        serviceBase: state.serviceBase,
      }),
    }
  )
);
