// @vitest-environment jsdom
/**
 * Tests for useWizardStatuses — the SetupWizard's status/persisted-state hook.
 *
 * Covers:
 *  - the merge of the two fetches (GET /api/desktop/setup-status +
 *    GET /api/desktop/setup-wizard-state) into `statuses` / `persisted`;
 *  - a fetch failure (network reject, or a non-ok response) LEAVES prior
 *    state unchanged and does not crash;
 *  - the setLastVisitedStep PATCH (URL + method + JSON body);
 *  - the 10s poll: nothing fires on mount until refreshAll runs, then one
 *    tick re-reads (driven with fake timers).
 *
 * fetch is stubbed via vi.stubGlobal. No sonner usage in this hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useWizardStatuses } from './useWizardStatuses';

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function notOk(status = 500): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

const STATUSES = { 'github-auth': 'ok', 'embedded-pg': 'needs-attention' } as const;
const PERSISTED = { last_visited_step: 'embedded-pg', finished_at: '2026-06-04T00:00:00Z' };

/** Route the two read URLs to supplied responses. */
function routeReads(opts: {
  status?: () => Response | Promise<Response>;
  persisted?: () => Response | Promise<Response>;
}) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/desktop/setup-status')) {
      return opts.status ? opts.status() : okJson({ statuses: STATUSES });
    }
    if (url.includes('/api/desktop/setup-wizard-state')) {
      // The PATCH (setLastVisitedStep) and the GET share this URL; distinguish
      // by method.
      if (init?.method === 'PATCH') return okJson({});
      return opts.persisted ? opts.persisted() : okJson(PERSISTED);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Run an initial refreshAll() and flush its awaited fetches. */
async function loadOnce(refreshAll: () => Promise<void>) {
  await act(async () => {
    await refreshAll();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('useWizardStatuses — initial state', () => {
  it('starts with empty statuses + persisted and fires nothing on mount', () => {
    routeReads({});
    const { result } = renderHook(() => useWizardStatuses());
    expect(result.current.statuses).toEqual({});
    expect(result.current.persisted).toEqual({});
    // The effect only installs an interval; no fetch until the first tick.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('useWizardStatuses — merge of the two reads', () => {
  it('merges setup-status + persisted-state into derived state', async () => {
    routeReads({});
    const { result } = renderHook(() => useWizardStatuses());

    await loadOnce(result.current.refreshAll);

    expect(result.current.statuses).toEqual(STATUSES);
    expect(result.current.persisted).toEqual(PERSISTED);
    // Both reads use cache:'no-store'.
    const statusCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes('/api/desktop/setup-status'),
    );
    expect((statusCall?.[1] as RequestInit)?.cache).toBe('no-store');
  });

  it('defaults statuses to {} when the body omits the statuses key', async () => {
    routeReads({ status: () => okJson({}) });
    const { result } = renderHook(() => useWizardStatuses());
    await loadOnce(result.current.refreshAll);
    expect(result.current.statuses).toEqual({});
  });
});

describe('useWizardStatuses — failure leaves prior state unchanged', () => {
  it('keeps prior state on a rejected fetch (no crash)', async () => {
    // First load succeeds.
    routeReads({});
    const { result } = renderHook(() => useWizardStatuses());
    await loadOnce(result.current.refreshAll);
    expect(result.current.statuses).toEqual(STATUSES);

    // Next refresh rejects entirely.
    mockFetch.mockRejectedValue(new Error('offline'));
    await loadOnce(result.current.refreshAll);

    // Prior state is untouched.
    expect(result.current.statuses).toEqual(STATUSES);
    expect(result.current.persisted).toEqual(PERSISTED);
  });

  it('keeps prior state when a read returns a non-ok response', async () => {
    routeReads({});
    const { result } = renderHook(() => useWizardStatuses());
    await loadOnce(result.current.refreshAll);
    expect(result.current.statuses).toEqual(STATUSES);

    // setup-status now 500s; the ok-guard skips setStatuses.
    routeReads({ status: () => notOk(500) });
    await loadOnce(result.current.refreshAll);

    // statuses unchanged; persisted re-read (still PERSISTED).
    expect(result.current.statuses).toEqual(STATUSES);
    expect(result.current.persisted).toEqual(PERSISTED);
  });
});

describe('useWizardStatuses — setLastVisitedStep PATCH', () => {
  it('PATCHes the wizard-state URL with the step id as JSON', async () => {
    routeReads({});
    const { result } = renderHook(() => useWizardStatuses());

    await act(async () => {
      await result.current.setLastVisitedStep('embedded-pg');
    });

    const patch = mockFetch.mock.calls.find(
      (c) =>
        String(c[0]).includes('/api/desktop/setup-wizard-state') &&
        (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patch).toBeDefined();
    const init = patch![1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ last_visited_step: 'embedded-pg' });
  });

  it('swallows a PATCH failure without throwing', async () => {
    mockFetch.mockRejectedValue(new Error('patch-offline'));
    const { result } = renderHook(() => useWizardStatuses());
    // Must resolve, not reject.
    await act(async () => {
      await expect(result.current.setLastVisitedStep('x')).resolves.toBeUndefined();
    });
  });
});

describe('useWizardStatuses — 10s poll', () => {
  it('re-reads on the interval tick', async () => {
    routeReads({});
    renderHook(() => useWizardStatuses());

    expect(mockFetch).not.toHaveBeenCalled();

    // Advance past the 10s interval → refreshAll fires (2 reads).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    const reads = mockFetch.mock.calls.filter(
      (c) => (c[1] as RequestInit)?.method !== 'PATCH',
    );
    expect(reads.length).toBe(2);
    expect(reads.some((c) => String(c[0]).includes('/api/desktop/setup-status'))).toBe(true);
    expect(reads.some((c) => String(c[0]).includes('/api/desktop/setup-wizard-state'))).toBe(true);
  });

  it('stops polling after unmount', async () => {
    routeReads({});
    const { unmount } = renderHook(() => useWizardStatuses());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
