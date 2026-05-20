import { describe, expect, it } from 'vitest';
import { buildCodexAnalyticsQueryRanges, buildCodexAnalyticsState } from './codexAnalytics';

describe('Codex analytics helpers', () => {
  it('derives daily analytics ranges from the weekly quota window', () => {
    const ranges = buildCodexAnalyticsQueryRanges({
      reset_at: 1_765_843_200,
      reset_after_seconds: 86_400,
      limit_window_seconds: 604_800,
    });

    expect(ranges).toEqual({
      apiNowMs: Date.parse('2025-12-15T00:00:00.000Z'),
      resetAtMs: Date.parse('2025-12-16T00:00:00.000Z'),
      windowStartMs: Date.parse('2025-12-09T00:00:00.000Z'),
      endDateExclusive: '2025-12-16',
      sinceResetStartDate: '2025-12-09',
      monthStartDate: '2025-12-01',
      rollingStartDate: '2025-11-16',
    });
  });

  it('builds a weekly limit estimate from since-reset usage and weekly percent', () => {
    const analytics = buildCodexAnalyticsState({
      weeklyWindow: {
        used_percent: 25,
        reset_at: 1_765_843_200,
        reset_after_seconds: 86_400,
        limit_window_seconds: 604_800,
      },
      sinceResetPayload: {
        data: [
          {
            date: '2025-12-09',
            totals: {
              credits: 10,
              users: 1,
              threads: 2,
              turns: 3,
              cached_text_input_tokens: 100,
              uncached_text_input_tokens: 200,
              text_output_tokens: 300,
            },
            clients: [{ client_id: 'codex', credits: 10, threads: 2, turns: 3 }],
          },
          {
            date: '2025-12-10',
            totals: {
              credits: 40,
              users: 2,
              text_total_tokens: 900,
            },
            clients: [{ client_id: 'codex', credits: 40 }],
          },
        ],
      },
      monthPayload: { data: [{ date: '2025-12-10', totals: { credits: 75 } }] },
      rollingPayload: { data: [{ date: '2025-12-10', totals: { credits: 125 } }] },
    });

    expect(analytics.weeklyEstimate).toMatchObject({
      usedPercent: 25,
      includedCredits: 50,
      resetDayCredits: 10,
      excludedCredits: 40,
      totalCreditsWithResetDay: 200,
      totalUsdWithResetDay: 8,
      totalCreditsWithoutResetDay: 160,
      totalUsdWithoutResetDay: 6.4,
    });
    expect(analytics.ranges[0]).toMatchObject({
      id: 'since-reset',
      credits: 50,
      usd: 2,
      tokens: 1500,
      cachedInputTokens: 100,
      uncachedInputTokens: 200,
      outputTokens: 300,
      threads: 2,
      turns: 3,
      users: 3,
      topClients: [
        {
          clientId: 'codex',
          credits: 50,
          usd: 2,
          threads: 2,
          turns: 3,
        },
      ],
    });
  });
});
