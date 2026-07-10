/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDockLayout } from './useDockLayout';

const SEED = {
  workspaceId: 'default',
  userId: '_local',
  layoutName: 'test',
  schemaVersion: 1,
  layoutJson: {
    schemaVersion: 1,
    root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'data:features' }] },
  },
  updatedTs: 1000,
  createdTs: 1000,
};

const originalFetch = globalThis.fetch;

function setupFetch(behaviors: {
  initialGet?: typeof SEED | { error: number };
  putResult?: 'ok' | 'conflict' | 'error';
} = {}) {
  let getCount = 0;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'PUT') {
      if (behaviors.putResult === 'conflict') {
        return new Response(JSON.stringify({ error: 'stale' }), { status: 409 });
      }
      if (behaviors.putResult === 'error') {
        return new Response('boom', { status: 500 });
      }
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ ...SEED, layoutJson: body.layout, updatedTs: SEED.updatedTs + 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (u.endsWith('/test')) {
      getCount++;
      const r = behaviors.initialGet ?? SEED;
      if ('error' in r) {
        return new Response('boom', { status: r.error });
      }
      // After PUT, increase the updatedTs to simulate fresh state.
      return new Response(
        JSON.stringify({ ...r, updatedTs: r.updatedTs + getCount - 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => setupFetch());

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('useDockLayout', () => {
  it('starts in loading, transitions to ready with row', async () => {
    const { result } = renderHook(() => useDockLayout('test'));
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.row?.layoutName).toBe('test');
  });

  it('save() sends PUT with If-Match header from current updatedTs', async () => {
    const { result } = renderHook(() => useDockLayout('test'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    await act(async () => {
      await result.current.save({
        schemaVersion: 1,
        root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'x' }] },
      });
    });
    const fetchMock = globalThis.fetch as unknown as {
      mock: { calls: Array<[string, RequestInit | undefined]> };
    };
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const headers = putCall![1]!.headers as Record<string, string>;
    expect(headers['if-match']).toBe(String(SEED.updatedTs));
  });

  it('save() returns the new row + updates state', async () => {
    const { result } = renderHook(() => useDockLayout('test'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    let saved: { updatedTs?: number } = {};
    await act(async () => {
      saved = await result.current.save({
        schemaVersion: 1,
        root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'x' }] },
      });
    });
    expect(saved.updatedTs).toBe(SEED.updatedTs + 1);
    expect(result.current.state.row?.updatedTs).toBe(SEED.updatedTs + 1);
  });

  it('save() 409 throws { conflict: true } and refreshes state', async () => {
    setupFetch({ putResult: 'conflict' });
    const { result } = renderHook(() => useDockLayout('test'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    let conflictError: (Error & { conflict?: boolean }) | null = null;
    await act(async () => {
      try {
        await result.current.save({
          schemaVersion: 1,
          root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'x' }] },
        });
      } catch (e) {
        conflictError = e as Error & { conflict?: boolean };
      }
    });
    expect(conflictError).not.toBeNull();
    expect((conflictError as unknown as Error & { conflict: boolean }).conflict).toBe(true);
  });

  it('reset() DELETE + refreshes', async () => {
    const { result } = renderHook(() => useDockLayout('test'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    await act(async () => {
      await result.current.reset();
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } })
      .mock.calls;
    const del = calls.find(([, init]) => init?.method === 'DELETE');
    expect(del).toBeDefined();
  });

  it('initial GET error → status=error', async () => {
    setupFetch({ initialGet: { error: 500 } });
    const { result } = renderHook(() => useDockLayout('test'));
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state.error?.message).toMatch(/→ 500/);
  });

  it('refresh() re-fetches and updates state', async () => {
    const { result } = renderHook(() => useDockLayout('test'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    const before = result.current.state.row!.updatedTs;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.state.row!.updatedTs).toBeGreaterThan(before);
  });
});
