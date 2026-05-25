/**
 * @vitest-environment jsdom
 *
 * SubstrateStatusBadgeClient tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SubstrateStatusBadgeClient } from '../SubstrateStatusBadgeClient';

afterEach(() => {
  cleanup();
});

function fetchOk(body: unknown): typeof fetch {
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

describe('SubstrateStatusBadgeClient', () => {
  it('renders booting initially (before fetch settles)', () => {
    const fetchImpl = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    render(
      <SubstrateStatusBadgeClient
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    expect(
      screen.getByTestId('substrate-status-badge').getAttribute('data-status'),
    ).toBe('booting');
  });

  it('renders disabled when server says enabled=false', async () => {
    render(
      <SubstrateStatusBadgeClient
        fetchImpl={fetchOk({ enabled: false, booted: [], bootedCount: 0 })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByTestId('substrate-status-badge')
          .getAttribute('data-status'),
      ).toBe('disabled');
    });
  });

  it('renders booted when server says enabled=true + harness in list (slug filter)', async () => {
    render(
      <SubstrateStatusBadgeClient
        slug="papercup"
        fetchImpl={fetchOk({
          enabled: true,
          booted: [{ workspaceId: 'ws-1', harnessSlug: 'papercup' }],
          bootedCount: 1,
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByTestId('substrate-status-badge')
          .getAttribute('data-status'),
      ).toBe('booted');
    });
  });

  it('renders booting when slug not in booted list', async () => {
    render(
      <SubstrateStatusBadgeClient
        slug="other"
        fetchImpl={fetchOk({
          enabled: true,
          booted: [{ workspaceId: 'ws-1', harnessSlug: 'papercup' }],
          bootedCount: 1,
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByTestId('substrate-status-badge')
          .getAttribute('data-status'),
      ).toBe('booting');
    });
  });

  it('workspace-wide (no slug): uses bootedCount as hint', async () => {
    render(
      <SubstrateStatusBadgeClient
        fetchImpl={fetchOk({
          enabled: true,
          booted: [
            { workspaceId: 'ws-1', harnessSlug: 'a' },
            { workspaceId: 'ws-1', harnessSlug: 'b' },
            { workspaceId: 'ws-2', harnessSlug: 'a' },
          ],
          bootedCount: 3,
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByTestId('substrate-status-badge')
          .getAttribute('data-status'),
      ).toBe('booted');
    });
    expect(screen.getByTestId('substrate-status-hint').textContent).toBe(
      '3 harnesses',
    );
  });

  it('workspace-wide with 1 booted uses singular hint', async () => {
    render(
      <SubstrateStatusBadgeClient
        fetchImpl={fetchOk({ enabled: true, bootedCount: 1 })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('substrate-status-hint').textContent).toBe(
        '1 harness',
      );
    });
  });

  it('stays in booting on fetch failure', async () => {
    render(
      <SubstrateStatusBadgeClient
        fetchImpl={fetchFail(500)}
        refreshIntervalMs={0}
      />,
    );
    // wait briefly to let the failed fetch settle
    await new Promise((r) => setTimeout(r, 20));
    expect(
      screen.getByTestId('substrate-status-badge').getAttribute('data-status'),
    ).toBe('booting');
  });
});
