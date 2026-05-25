// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useQueueMembership } from '../useQueueMembership';
import type { QueueAvatarMember } from '../QueueAvatarCluster';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function member(id: number, username = `u${id}`): QueueAvatarMember {
  return {
    github_user_id: id,
    github_username: username,
    display_name: null,
    avatar_url: null,
  };
}

describe('useQueueMembership', () => {
  it('GETs /api/harness/:slug/feature-queue-membership on mount', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ membership: {} }));
    renderHook(() =>
      useQueueMembership({ slug: 'sheets', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      '/api/harness/sheets/feature-queue-membership',
    );
  });

  it('appends feature_ids to the URL when provided', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ membership: {} }));
    renderHook(() =>
      useQueueMembership({
        slug: 's',
        featureIds: ['F-1', 'F-2'],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      '/api/harness/s/feature-queue-membership?feature_ids=F-1,F-2',
    );
  });

  it('exposes the membership map after fetch resolves', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ membership: { 'F-1': [member(7)] } }),
    );
    const { result } = renderHook(() =>
      useQueueMembership({ slug: 's', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.membership['F-1']).toHaveLength(1);
    expect(result.current.membersFor('F-1')).toHaveLength(1);
    expect(result.current.membersFor('F-NONE')).toEqual([]);
  });

  it('isQueued reflects membership lookup by github_user_id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ membership: { 'F-1': [member(7), member(8)] } }),
    );
    const { result } = renderHook(() =>
      useQueueMembership({ slug: 's', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.isQueued('F-1', 7)).toBe(true);
    expect(result.current.isQueued('F-1', 9)).toBe(false);
    expect(result.current.isQueued('F-2', 7)).toBe(false);
    expect(result.current.isQueued('F-1', 0)).toBe(false);
  });

  it('sets loaded=true even on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const { result } = renderHook(() =>
      useQueueMembership({ slug: 's', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.membership).toEqual({});
  });

  it('sets loaded=true even on network throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() =>
      useQueueMembership({ slug: 's', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.membership).toEqual({});
  });

  it('refresh() triggers an additional fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ membership: {} }));
    const { result } = renderHook(() =>
      useQueueMembership({
        slug: 's',
        pollMs: 999_999, // ensure no auto-poll fires during the test
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does nothing when slug is empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ membership: {} }));
    renderHook(() =>
      useQueueMembership({ slug: '', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
