/**
 * @vitest-environment jsdom
 *
 * BootHistoryTableClient tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { BootHistoryTableClient } from '../BootHistoryTableClient';
import type { BootHistoryEntry } from '../BootHistoryTable';

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

function entry(
  overrides: Partial<BootHistoryEntry> = {},
): BootHistoryEntry {
  return {
    ts: Date.now() - 1000,
    workspaceId: 'ws-1',
    harnessSlug: 'papercup',
    kind: 'boot_ok',
    ...overrides,
  };
}

describe('BootHistoryTableClient', () => {
  it('renders nothing while loading', () => {
    const fetchImpl = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    render(
      <BootHistoryTableClient
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    expect(screen.queryByTestId('boot-history-table')).toBeNull();
    expect(screen.queryByTestId('boot-history-empty')).toBeNull();
  });

  it('renders the table once fetch resolves', async () => {
    render(
      <BootHistoryTableClient
        fetchImpl={fetchReturning({ entries: [entry()] })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('boot-history-table')).toBeTruthy();
    });
  });

  it('renders empty state when entries is an empty array', async () => {
    render(
      <BootHistoryTableClient
        fetchImpl={fetchReturning({ entries: [] })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('boot-history-empty')).toBeTruthy();
    });
  });

  it('stays empty on fetch failure', async () => {
    render(
      <BootHistoryTableClient
        fetchImpl={fetchFail()}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('boot-history-table')).toBeNull();
    expect(screen.queryByTestId('boot-history-empty')).toBeNull();
  });

  it('builds correct URL with filters', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <BootHistoryTableClient
        workspaceId="ws-7"
        harnessSlug="papercup"
        kinds={['boot_fail', 'close']}
        limit={25}
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(capturedUrl).toContain('workspace_id=ws-7');
    });
    expect(capturedUrl).toContain('harness_slug=papercup');
    expect(capturedUrl).toContain('kinds=boot_fail%2Cclose');
    expect(capturedUrl).toContain('limit=25');
  });

  it('omits query string when no filters provided', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <BootHistoryTableClient
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(capturedUrl).toBe('/api/admin/dogfood-substrate-boot-history');
    });
  });

  it('re-fetches when filter props change', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : (input as URL).toString());
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { rerender } = render(
      <BootHistoryTableClient
        workspaceId="ws-1"
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(urls.some((u) => u.includes('workspace_id=ws-1'))).toBe(true);
    });
    rerender(
      <BootHistoryTableClient
        workspaceId="ws-2"
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(urls.some((u) => u.includes('workspace_id=ws-2'))).toBe(true);
    });
  });
});
