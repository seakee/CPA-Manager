import { describe, expect, it } from 'vitest';

import { calculateCost, collectUsageDetails, collectUsageDetailsWithEndpoint } from './usage';

describe('usage detail collection', () => {
  it('copies project id snapshots into normalized usage details', () => {
    const usageData = {
      apis: {
        'POST /v1/chat/completions': {
          models: {
            'gemini-2.5-pro': {
              details: [
                {
                  timestamp: '2026-05-09T01:12:43.000Z',
                  source: 'alice@example.com',
                  auth_index: 'auth-1',
                  auth_project_id_snapshot: 'vertex-project-42',
                  tokens: {
                    input_tokens: 10,
                    output_tokens: 5,
                  },
                  failed: false,
                },
              ],
            },
          },
        },
      },
    };

    expect(collectUsageDetails(usageData)[0].auth_project_id_snapshot).toBe(
      'vertex-project-42'
    );
    expect(collectUsageDetailsWithEndpoint(usageData)[0].auth_project_id_snapshot).toBe(
      'vertex-project-42'
    );
  });

  it('accepts camelCase project id snapshots from usage details', () => {
    const usageData = {
      apis: {
        'POST /v1/chat/completions': {
          models: {
            'gemini-2.5-pro': {
              details: [
                {
                  timestamp: '2026-05-09T01:12:43.000Z',
                  source: 'alice@example.com',
                  authIndex: 'auth-1',
                  authProjectIdSnapshot: 'camel-project-42',
                  tokens: {},
                  failed: false,
                },
              ],
            },
          },
        },
      },
    };

    expect(collectUsageDetails(usageData)[0].auth_project_id_snapshot).toBe('camel-project-42');
    expect(collectUsageDetailsWithEndpoint(usageData)[0].auth_project_id_snapshot).toBe(
      'camel-project-42'
    );
  });

  it('extracts resolved_model alongside the requested model name', () => {
    const usageData = {
      apis: {
        'POST /v1/chat/completions': {
          models: {
            'gpt-5.4': {
              details: [
                {
                  timestamp: '2026-05-19T10:00:00Z',
                  source: 'alice@example.com',
                  auth_index: 'auth-1',
                  resolved_model: 'gpt-5.5',
                  tokens: { input_tokens: 1 },
                  failed: false,
                },
              ],
            },
          },
        },
      },
    };

    const detail = collectUsageDetails(usageData)[0];
    expect(detail.__modelName).toBe('gpt-5.4');
    expect(detail.__resolvedModel).toBe('gpt-5.5');
    expect(collectUsageDetailsWithEndpoint(usageData)[0].__resolvedModel).toBe('gpt-5.5');
  });
});

describe('calculateCost model price preference', () => {
  const prices = {
    'gpt-5.5': { prompt: 5, completion: 10, cache: 1 },
    'gpt-5.4': { prompt: 50, completion: 100, cache: 10 },
  };

  it('prefers resolved upstream model when present', () => {
    const cost = calculateCost(
      {
        tokens: { input_tokens: 1_000_000, output_tokens: 0 },
        __modelName: 'gpt-5.4',
        __resolvedModel: 'gpt-5.5',
      },
      prices
    );
    // gpt-5.5 prompt rate is 5 / 1M tokens => 5
    expect(cost).toBeCloseTo(5);
  });

  it('falls back to requested alias when resolved is absent', () => {
    const cost = calculateCost(
      {
        tokens: { input_tokens: 1_000_000, output_tokens: 0 },
        __modelName: 'gpt-5.4',
      },
      prices
    );
    expect(cost).toBeCloseTo(50);
  });

  it('falls back to requested alias when resolved has no price entry', () => {
    const cost = calculateCost(
      {
        tokens: { input_tokens: 1_000_000, output_tokens: 0 },
        __modelName: 'gpt-5.4',
        __resolvedModel: 'unknown-upstream',
      },
      prices
    );
    expect(cost).toBeCloseTo(50);
  });
});
