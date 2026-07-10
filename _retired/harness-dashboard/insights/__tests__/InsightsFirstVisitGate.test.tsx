/**
 * @vitest-environment jsdom
 *
 * InsightsFirstVisitGate — Phase 8 P-074 tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  waitFor,
} from '@testing-library/react';
import {
  InsightsFirstVisitGate,
  markInsightsSeenOverHttp,
} from '../InsightsFirstVisitGate';

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

function fetchFail(status = 500): typeof fetch {
  return vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
}

describe('InsightsFirstVisitGate — P-074', () => {
  it('redirects when server says force_route=true', async () => {
    const redirect = vi.fn();
    render(
      <InsightsFirstVisitGate
        slug="papercup"
        redirect={redirect}
        fetchImpl={fetchReturning({ force_route: true, seen_at_ts: null })}
      />,
    );
    await waitFor(() => {
      expect(redirect).toHaveBeenCalledWith('/harness/papercup/insights');
    });
  });

  it('does NOT redirect when server says force_route=false', async () => {
    const redirect = vi.fn();
    render(
      <InsightsFirstVisitGate
        slug="papercup"
        redirect={redirect}
        fetchImpl={fetchReturning({ force_route: false, seen_at_ts: 12345 })}
      />,
    );
    // give it a tick to settle
    await new Promise((r) => setTimeout(r, 30));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does NOT redirect on fetch failure', async () => {
    const redirect = vi.fn();
    render(
      <InsightsFirstVisitGate
        slug="papercup"
        redirect={redirect}
        fetchImpl={fetchFail(500)}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when disabled', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const redirect = vi.fn();
    render(
      <InsightsFirstVisitGate
        slug="papercup"
        redirect={redirect}
        fetchImpl={fetchImpl}
        disabled
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('URL-encodes the slug', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ force_route: false }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    render(
      <InsightsFirstVisitGate
        slug="a/b"
        fetchImpl={fetchImpl}
        redirect={() => {}}
      />,
    );
    await waitFor(() => {
      expect(capturedUrl).toContain('/harness/a%2Fb/insights-first-visit');
    });
  });
});

describe('markInsightsSeenOverHttp', () => {
  it('POSTs to the first-visit endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('', { status: 200 }),
    ) as unknown as typeof fetch;
    await markInsightsSeenOverHttp('papercup', fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(url).toBe('/api/harness/papercup/insights-first-visit');
    expect(init?.method).toBe('POST');
  });

  it('swallows fetch errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      markInsightsSeenOverHttp('papercup', fetchImpl),
    ).resolves.toBeUndefined();
  });
});
