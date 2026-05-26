// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useWorkingSet } from '../useWorkingSet';

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

function member(id: number) {
  return { github_user_id: id, github_username: `u${id}`, display_name: null, avatar_url: null, started_at: 1 };
}

describe('useWorkingSet', () => {
  it('GETs /api/harness/:slug/working-set on mount', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ working: {} }));
    renderHook(() => useWorkingSet({ slug: 'sheets', pollMs: 999999, fetchImpl: fetchImpl as unknown as typeof fetch }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe('/api/harness/sheets/working-set');
  });

  it('appends feature_ids when provided', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ working: {} }));
    renderHook(() => useWorkingSet({ slug: 's', featureIds: ['F-1', 'F-2'], pollMs: 999999, fetchImpl: fetchImpl as unknown as typeof fetch }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe('/api/harness/s/working-set?feature_ids=F-1,F-2');
  });

  it('exposes workersFor + isActive + hasAnyWorker', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ working: { 'F-1': [member(7), member(8)] } }));
    const { result } = renderHook(() => useWorkingSet({ slug: 's', pollMs: 999999, fetchImpl: fetchImpl as unknown as typeof fetch }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.workersFor('F-1')).toHaveLength(2);
    expect(result.current.isActive('F-1', 7)).toBe(true);
    expect(result.current.isActive('F-1', 9)).toBe(false);
    expect(result.current.isActive('F-1', 0)).toBe(false);
    expect(result.current.hasAnyWorker('F-1')).toBe(true);
    expect(result.current.hasAnyWorker('F-2')).toBe(false);
  });

  it('sets loaded=true on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 500 }));
    const { result } = renderHook(() => useWorkingSet({ slug: 's', pollMs: 999999, fetchImpl: fetchImpl as unknown as typeof fetch }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.working).toEqual({});
  });

  it('refresh triggers another fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ working: {} }));
    const { result } = renderHook(() => useWorkingSet({ slug: 's', pollMs: 999999, fetchImpl: fetchImpl as unknown as typeof fetch }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does nothing when slug empty', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ working: {} }));
    renderHook(() => useWorkingSet({ slug: '', pollMs: 999999, fetchImpl: fetchImpl as unknown as typeof fetch }));
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
