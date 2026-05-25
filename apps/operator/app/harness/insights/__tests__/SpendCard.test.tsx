/**
 * @vitest-environment jsdom
 *
 * SpendCard — P-073f tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SpendCard } from '../SpendCard';

afterEach(() => {
  cleanup();
});

describe('SpendCard — P-073f', () => {
  it('renders title and tier-D pill', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        viewerUsdThisWeek={25}
      />,
    );
    const card = screen.getByTestId('insights-spend-card');
    expect(card.textContent).toContain('Spend');
    expect(screen.getByTestId('spend-card-tier-pill').textContent).toContain(
      'Tier D',
    );
  });

  it('shows harness total and viewer share', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        viewerUsdThisWeek={25}
      />,
    );
    expect(
      screen.getByTestId('spend-card-harness-total').textContent,
    ).toContain('$100');
    const viewer = screen.getByTestId('spend-card-viewer-share');
    expect(viewer.textContent).toContain('$25');
    expect(viewer.textContent).toContain('(25%)');
  });

  it('share bar fill width reflects percent', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={200}
        viewerUsdThisWeek={50}
      />,
    );
    const fill = screen.getByTestId(
      'spend-card-share-bar-fill',
    ) as HTMLElement;
    expect(fill.style.width).toBe('25%');
  });

  it('share is 0 when harness total is 0', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={0}
        viewerUsdThisWeek={0}
      />,
    );
    const viewer = screen.getByTestId('spend-card-viewer-share');
    expect(viewer.textContent).toContain('(0%)');
    const fill = screen.getByTestId(
      'spend-card-share-bar-fill',
    ) as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it('clamps share to 100% if viewer > harness total', () => {
    // shouldn't happen but be defensive
    render(
      <SpendCard
        harnessTotalUsdThisWeek={10}
        viewerUsdThisWeek={20}
      />,
    );
    const fill = screen.getByTestId(
      'spend-card-share-bar-fill',
    ) as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('formats sub-$1 spend with two decimals', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={0.5}
        viewerUsdThisWeek={0.25}
      />,
    );
    expect(
      screen.getByTestId('spend-card-harness-total').textContent,
    ).toContain('$0.50');
  });

  it('formats $100+ spend as whole dollars', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={234.5}
        viewerUsdThisWeek={117}
      />,
    );
    expect(
      screen.getByTestId('spend-card-harness-total').textContent,
    ).toContain('$235');
  });

  it('banner mentions proxy-witness deferral', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        viewerUsdThisWeek={25}
      />,
    );
    expect(screen.getByTestId('spend-card-banner').textContent).toContain(
      'Proxy-witness',
    );
    expect(screen.getByTestId('spend-card-banner').textContent).toContain(
      'computed locally',
    );
  });

  it('banner has plan link when href provided', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        viewerUsdThisWeek={25}
        proxyWitnessExplainerHref="/internal/docs/proxy-witness-pattern"
      />,
    );
    const link = screen.getByTestId(
      'spend-card-banner-link',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      '/internal/docs/proxy-witness-pattern',
    );
  });

  it('banner skips link when href not provided', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        viewerUsdThisWeek={25}
      />,
    );
    expect(screen.queryByTestId('spend-card-banner-link')).toBeNull();
  });
});
