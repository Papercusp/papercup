// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useViewerGithubId } from '../useViewerGithubId';

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

describe('useViewerGithubId', () => {
  it('GETs /api/auth/me on mount', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: {} }));
    renderHook(() => useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe('/api/auth/me');
  });

  it('returns 0 immediately on mount (before fetch resolves)', () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: { github_user_id: 42 } }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    // Synchronous render — id starts at 0 before fetch resolves.
    expect(result.current).toBe(0);
  });

  it('returns the resolved id once /api/auth/me returns a github_user_id', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: { github_user_id: 42 } }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current).toBe(42));
  });

  it('coerces a stringified user id', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: { github_user_id: '99' } }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current).toBe(99));
  });

  it('stays 0 when github_user_id is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: {} }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('stays 0 when github_user_id is 0', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: { github_user_id: 0 } }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('stays 0 when github_user_id is a non-numeric string', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ user: { github_user_id: 'alice' } }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('stays 0 on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('stays 0 on network throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() =>
      useViewerGithubId({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(result.current).toBe(0);
  });
});
