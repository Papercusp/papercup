/**
 * @vitest-environment jsdom
 *
 * SubstrateSummaryCardClient tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SubstrateSummaryCardClient } from '../SubstrateSummaryCardClient';

afterEach(() => {
  cleanup();
});

function fetchReturning(body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function fetchFail(): typeof fetch {
  return vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
}

const baseSummary = {
  enabled: true,
  totalHarnesses: 3,
  healthy: 2,
  booting: 1,
  degraded: 0,
  unhealthy: 0,
  disabled: 0,
  worstVerdict: 'booting' as const,
};

describe('SubstrateSummaryCardClient', () => {
  it('renders nothing while loading', () => {
    const fetchImpl = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    render(
      <SubstrateSummaryCardClient
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    expect(screen.queryByTestId('substrate-summary-card')).toBeNull();
  });

  it('renders card after fetch resolves', async () => {
    render(
      <SubstrateSummaryCardClient
        fetchImpl={fetchReturning({
          flagEnabled: true,
          summary: baseSummary,
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('substrate-summary-card')).toBeTruthy();
    });
    expect(
      screen.getByTestId('substrate-summary-card').getAttribute('data-verdict'),
    ).toBe('booting');
  });

  it('renders nothing if summary field missing from response', async () => {
    render(
      <SubstrateSummaryCardClient
        fetchImpl={fetchReturning({ flagEnabled: true })}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('substrate-summary-card')).toBeNull();
  });

  it('stays empty on fetch failure', async () => {
    render(
      <SubstrateSummaryCardClient
        fetchImpl={fetchFail()}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('substrate-summary-card')).toBeNull();
  });

  it('threads diagnosticHref into the card', async () => {
    render(
      <SubstrateSummaryCardClient
        fetchImpl={fetchReturning({
          flagEnabled: true,
          summary: baseSummary,
        })}
        diagnosticHref="/admin/dogfood-substrate"
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('substrate-summary-cta')).toBeTruthy();
    });
    expect(
      screen
        .getByTestId('substrate-summary-cta')
        .getAttribute('href'),
    ).toBe('/admin/dogfood-substrate');
  });
});
