/**
 * @vitest-environment jsdom
 *
 * ClaimAttemptStatsPillClient tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ClaimAttemptStatsPillClient } from '../ClaimAttemptStatsPillClient';

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

describe('ClaimAttemptStatsPillClient', () => {
  it('renders nothing while loading', () => {
    const fetchImpl = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    render(
      <ClaimAttemptStatsPillClient
        slug="papercup"
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    expect(screen.queryByTestId('claim-attempt-stats-pill')).toBeNull();
  });

  it('renders nothing when stats has total = 0', async () => {
    render(
      <ClaimAttemptStatsPillClient
        slug="papercup"
        fetchImpl={fetchReturning({
          stats: { total: 0, won: 0, lost: 0, error: 0 },
        })}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('claim-attempt-stats-pill')).toBeNull();
  });

  it('renders pill when stats has rows', async () => {
    render(
      <ClaimAttemptStatsPillClient
        slug="papercup"
        fetchImpl={fetchReturning({
          stats: { total: 10, won: 6, lost: 3, error: 1 },
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('claim-attempt-stats-pill')).toBeTruthy();
    });
    expect(screen.getByTestId('claim-stats-won').textContent).toContain('6');
    expect(screen.getByTestId('claim-stats-lost').textContent).toContain('3');
    expect(screen.getByTestId('claim-stats-error').textContent).toContain('1');
  });

  it('threads compact prop through', async () => {
    render(
      <ClaimAttemptStatsPillClient
        slug="papercup"
        compact
        fetchImpl={fetchReturning({
          stats: { total: 6, won: 6, lost: 0, error: 0 },
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('claim-attempt-stats-pill')).toBeTruthy();
    });
    expect(screen.queryByTestId('claim-stats-lost')).toBeNull();
    expect(screen.queryByTestId('claim-stats-error')).toBeNull();
  });

  it('stays empty on fetch failure', async () => {
    render(
      <ClaimAttemptStatsPillClient
        slug="papercup"
        fetchImpl={fetchFail()}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('claim-attempt-stats-pill')).toBeNull();
  });

  it('URL-encodes the slug', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ stats: { total: 0 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    render(
      <ClaimAttemptStatsPillClient
        slug="a/b"
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(capturedUrl).toContain(
        '/api/harness/a%2Fb/claim-attempts?stats=1',
      );
    });
  });

  it('coerces string counts to numbers', async () => {
    render(
      <ClaimAttemptStatsPillClient
        slug="papercup"
        fetchImpl={fetchReturning({
          stats: { total: '5', won: '4', lost: '1', error: '0' },
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('claim-attempt-stats-pill')).toBeTruthy();
    });
    expect(screen.getByTestId('claim-stats-won').textContent).toContain('4');
    expect(screen.getByTestId('claim-stats-lost').textContent).toContain('1');
  });
});
