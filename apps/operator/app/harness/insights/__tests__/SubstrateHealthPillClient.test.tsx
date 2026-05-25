/**
 * @vitest-environment jsdom
 *
 * SubstrateHealthPillClient tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SubstrateHealthPillClient } from '../SubstrateHealthPillClient';

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

describe('SubstrateHealthPillClient', () => {
  it('renders nothing while loading + nothing on empty response', async () => {
    render(
      <SubstrateHealthPillClient
        fetchImpl={fetchReturning({ flagEnabled: true, harnesses: [] })}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('substrate-health-pill')).toBeNull();
  });

  it('slug match: renders the matching row verdict', async () => {
    render(
      <SubstrateHealthPillClient
        slug="papercup"
        fetchImpl={fetchReturning({
          flagEnabled: true,
          harnesses: [
            { workspaceId: 'ws-1', harnessSlug: 'papercup', verdict: 'degraded', reasons: ['claim error rate 10%'] },
            { workspaceId: 'ws-1', harnessSlug: 'other', verdict: 'healthy', reasons: ['ok'] },
          ],
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('substrate-health-pill').getAttribute('data-verdict'),
      ).toBe('degraded');
    });
  });

  it('slug + flag off: renders disabled fallback row', async () => {
    render(
      <SubstrateHealthPillClient
        slug="papercup"
        fetchImpl={fetchReturning({
          flagEnabled: false,
          harnesses: [],
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('substrate-health-pill').getAttribute('data-verdict'),
      ).toBe('disabled');
    });
  });

  it('no slug: picks the worst verdict across harnesses', async () => {
    render(
      <SubstrateHealthPillClient
        fetchImpl={fetchReturning({
          flagEnabled: true,
          harnesses: [
            { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy', reasons: ['ok'] },
            { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'unhealthy', reasons: ['boom'] },
            { workspaceId: 'ws-1', harnessSlug: 'c', verdict: 'degraded', reasons: ['warn'] },
          ],
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('substrate-health-pill').getAttribute('data-verdict'),
      ).toBe('unhealthy');
    });
  });

  it('renders nothing when slug does not match (flag on)', async () => {
    render(
      <SubstrateHealthPillClient
        slug="missing"
        fetchImpl={fetchReturning({
          flagEnabled: true,
          harnesses: [
            { workspaceId: 'ws-1', harnessSlug: 'papercup', verdict: 'healthy', reasons: ['ok'] },
          ],
        })}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('substrate-health-pill')).toBeNull();
  });

  it('fetch failure leaves the pill unrendered', async () => {
    render(
      <SubstrateHealthPillClient
        slug="papercup"
        fetchImpl={fetchFail()}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('substrate-health-pill')).toBeNull();
  });
});
