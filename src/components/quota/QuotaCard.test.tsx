import { act } from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { QuotaCard } from './QuotaCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('QuotaCard', () => {
  it('renders an icon refresh button for a single credential when refresh is available', () => {
    const onRefresh = vi.fn();
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <QuotaCard
          item={{ name: 'codex.json', type: 'codex' }}
          quota={{ status: 'success' }}
          resolvedTheme="light"
          i18nPrefix="codex_quota"
          cardClassName="codex-card"
          defaultType="codex"
          canRefresh
          onRefresh={onRefresh}
          renderQuotaItems={() => <span>quota</span>}
        />
      );
    });

    const refreshButton = renderer!.root
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'codex_quota.refresh_button');

    expect(refreshButton).toBeTruthy();

    act(() => {
      refreshButton!.props.onClick();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the single credential refresh button while that credential is loading', () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <QuotaCard
          item={{ name: 'codex.json', type: 'codex' }}
          quota={{ status: 'loading' }}
          resolvedTheme="light"
          i18nPrefix="codex_quota"
          cardClassName="codex-card"
          defaultType="codex"
          canRefresh
          onRefresh={() => {}}
          renderQuotaItems={() => <span>quota</span>}
        />
      );
    });

    const refreshButton = renderer!.root
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'codex_quota.refresh_button');

    expect(refreshButton?.props.disabled).toBe(true);
    expect(refreshButton?.props.loading).toBe(true);
  });
});
