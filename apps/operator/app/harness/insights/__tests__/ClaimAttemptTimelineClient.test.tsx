// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ClaimAttemptTimelineClient } from '../ClaimAttemptTimelineClient';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ClaimAttemptTimelineClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('GETs /api/harness/:slug/claim-attempts on mount', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ attempts: [] }));
    render(
      <ClaimAttemptTimelineClient
        slug="sheets"
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      '/api/harness/sheets/claim-attempts?limit=50',
    );
  });

  it('honors a custom limit param', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ attempts: [] }));
    render(
      <ClaimAttemptTimelineClient
        slug="s"
        limit={10}
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe('/api/harness/s/claim-attempts?limit=10');
  });

  it('url-encodes the slug', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ attempts: [] }));
    render(
      <ClaimAttemptTimelineClient
        slug="a/b"
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      '/api/harness/a%2Fb/claim-attempts?limit=50',
    );
  });

  it('renders the attempts returned from the API', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({
        attempts: [
          {
            id: 1,
            feature_id: 'F-7',
            claimer_pubkey: 'p',
            claimer_github_user_id: 42,
            ts: 1700000000000,
            outcome: 'won',
            detail: null,
          },
        ],
      }),
    );
    render(
      <ClaimAttemptTimelineClient
        slug="s"
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('claim-attempt-row-1')).toBeTruthy());
    expect(screen.getByTestId('claim-attempt-row-1').textContent).toContain('F-7');
  });

  it('does not fetch when slug is empty', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ attempts: [] }));
    render(
      <ClaimAttemptTimelineClient
        slug=""
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still renders the empty state after a fetch failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    render(
      <ClaimAttemptTimelineClient
        slug="s"
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('claim-attempt-timeline-empty')).toBeTruthy());
  });

  it('renders empty state after a network throw too', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    render(
      <ClaimAttemptTimelineClient
        slug="s"
        pollMs={999_999}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('claim-attempt-timeline-empty')).toBeTruthy());
  });
});
