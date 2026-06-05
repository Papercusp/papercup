// @vitest-environment jsdom
/**
 * Tests for useHarnessClaimStatus — the `/adv` claim-status read + claim()
 * mutation hook.
 *
 * Covers:
 *  - the file-local `claimErrorMessage` structured-error map (all ~7 codes,
 *    driven through the real claim() failure path so the test exercises the
 *    map exactly as production does);
 *  - the claim() mutation lifecycle: success → toast.success + status refresh;
 *    structured failure → error message + toast.error; the no-binding short-
 *    circuit (no fetch, error toast);
 *  - cancel-on-unmount (a load that resolves after unmount makes no state
 *    update / produces no act() warning).
 *
 * fetch is stubbed via vi.stubGlobal; sonner.toast is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { useHarnessClaimStatus, type ClaimStatusData } from './useHarnessClaimStatus';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
import { toast } from 'sonner';

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
  (toast.error as ReturnType<typeof vi.fn>).mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errJson(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

const SLUG = 'my-harness';

const STATUS_CLAIMABLE: ClaimStatusData = {
  status: 'unclaimed',
  binding_id: 'bind-123',
  claimant_login: null,
  claimants: [],
  provisional_owner_login: null,
  viewer_is_provisional_owner: false,
  viewer_is_claimant: false,
  viewer_can_claim: true,
  superseded_by_href: null,
  summary: 'Unclaimed',
};

const STATUS_NO_BINDING: ClaimStatusData = {
  ...STATUS_CLAIMABLE,
  binding_id: null,
  viewer_can_claim: false,
  summary: 'No binding',
};

/** Route a fetch call to the claim-status read or the claim POST. */
function routeFetch(opts: {
  status?: ClaimStatusData;
  claim?: () => Response;
}) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/claim-status')) {
      return opts.status ? okJson(opts.status) : errJson(500, {});
    }
    if (url.includes('/api/harness/binding/claim')) {
      return opts.claim ? opts.claim() : okJson({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('useHarnessClaimStatus — initial load', () => {
  it('loads claim status on mount and clears loading', async () => {
    routeFetch({ status: STATUS_CLAIMABLE });
    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(STATUS_CLAIMABLE));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets error when the claim-status read fails', async () => {
    mockFetch.mockResolvedValue(errJson(403, {}));
    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
    await waitFor(() => expect(result.current.error).toBe('claim-status 403'));
    expect(result.current.data).toBeNull();
    // data === null but error is set → loading should be false.
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch when slug is empty', () => {
    renderHook(() => useHarnessClaimStatus(''));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('useHarnessClaimStatus — claim() success', () => {
  it('toasts success, clears error, and refreshes status', async () => {
    let claimStatusCalls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/claim-status')) {
        claimStatusCalls += 1;
        // Second read (after claim) reports the harness now claimed.
        return okJson(
          claimStatusCalls === 1
            ? STATUS_CLAIMABLE
            : { ...STATUS_CLAIMABLE, status: 'claimed', viewer_is_claimant: true },
        );
      }
      if (url.includes('/api/harness/binding/claim')) return okJson({ ok: true });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.claim();
    });

    expect(returned).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('You claimed this harness.');
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();

    // refresh() bumped the tick → a second claim-status read ran and the
    // status flipped to 'claimed'.
    await waitFor(() => expect(result.current.data?.status).toBe('claimed'));
    expect(claimStatusCalls).toBe(2);
  });

  it('POSTs the binding_id as JSON to the claim route', async () => {
    routeFetch({ status: STATUS_CLAIMABLE, claim: () => okJson({ ok: true }) });
    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    await act(async () => {
      await result.current.claim();
    });

    const post = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes('/api/harness/binding/claim'),
    );
    expect(post).toBeDefined();
    const [, init] = post!;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ binding_id: 'bind-123' });
  });
});

describe('useHarnessClaimStatus — claim() no-binding short-circuit', () => {
  it('toasts and returns false without POSTing when there is no binding', async () => {
    routeFetch({ status: STATUS_NO_BINDING });
    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.claim();
    });

    expect(returned).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      'No shared binding to claim — share this harness first.',
    );
    // No claim POST was made.
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes('/api/harness/binding/claim')),
    ).toBe(false);
  });
});

describe('useHarnessClaimStatus — claim() failure + claimErrorMessage map', () => {
  // [error code, response body, expected human message] for each branch.
  const cases: Array<[number, Record<string, unknown>, string]> = [
    [
      403,
      { error: 'CLAIM_PERMISSION_DENIED', actual: 'read', required: 'maintain' },
      'You don\'t have permission to claim this harness (your GitHub access is "read"; maintain required).',
    ],
    [
      403,
      { error: 'CLAIM_PERMISSION_DENIED' },
      'You don\'t have permission to claim this harness (your GitHub access is "none"; maintain or admin required).',
    ],
    [
      404,
      { error: 'BINDING_NOT_FOUND' },
      'No shared binding exists for this harness yet — share it first.',
    ],
    [
      409,
      { error: 'BINDING_NOT_CLAIMABLE', reason: 'already owned' },
      "This binding can't be claimed (already owned).",
    ],
    [
      409,
      { error: 'BINDING_NOT_CLAIMABLE' },
      "This binding can't be claimed (not claimable).",
    ],
    [
      403,
      { error: 'GITHUB_REPO_PRIVATE_NO_ACCESS' },
      "You don't have access to the bound GitHub repository.",
    ],
    [
      429,
      { error: 'GITHUB_API_RATE_LIMIT' },
      'GitHub rate limit hit — try again shortly.',
    ],
    [
      502,
      { error: 'GITHUB_API_DOWN' },
      'GitHub is unreachable right now — try again shortly.',
    ],
    [500, { error: 'SOMETHING_ELSE' }, 'Claim failed (HTTP 500).'],
    [500, null as unknown as Record<string, unknown>, 'Claim failed (HTTP 500).'],
  ];

  it.each(cases)(
    'maps HTTP %i %o → message',
    async (status, body, expectedMsg) => {
      routeFetch({
        status: STATUS_CLAIMABLE,
        claim: () => errJson(status, body),
      });
      const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
      await waitFor(() => expect(result.current.data).not.toBeNull());

      let returned: boolean | undefined;
      await act(async () => {
        returned = await result.current.claim();
      });

      expect(returned).toBe(false);
      expect(result.current.error).toBe(expectedMsg);
      expect(toast.error).toHaveBeenCalledWith(expectedMsg);
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it('handles a thrown fetch (network error) in claim()', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/claim-status')) return okJson(STATUS_CLAIMABLE);
      throw new Error('boom');
    });
    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.claim();
    });

    expect(returned).toBe(false);
    expect(result.current.error).toBe('Claim failed: boom');
    expect(toast.error).toHaveBeenCalledWith('Claim failed: boom');
  });
});

describe('useHarnessClaimStatus — refresh()', () => {
  it('re-pulls claim status when refresh() is called', async () => {
    routeFetch({ status: STATUS_CLAIMABLE });
    const { result } = renderHook(() => useHarnessClaimStatus(SLUG));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    const before = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes('/claim-status'),
    ).length;

    act(() => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(
        mockFetch.mock.calls.filter((c) => String(c[0]).includes('/claim-status')).length,
      ).toBe(before + 1),
    );
  });
});

describe('useHarnessClaimStatus — cancel on unmount', () => {
  it('makes no state update after unmount when the load resolves late', async () => {
    let resolveStatus: ((r: Response) => void) | null = null;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveStatus = res;
        }),
    );

    const { result, unmount } = renderHook(() => useHarnessClaimStatus(SLUG));
    expect(result.current.loading).toBe(true);

    unmount();

    // Resolve the in-flight read *after* unmount. The effect's `cancel` guard
    // must prevent any setState (which would otherwise warn / error).
    await act(async () => {
      resolveStatus?.(okJson(STATUS_CLAIMABLE));
      await Promise.resolve();
    });

    // No assertion on state (the hook is gone); the test passes iff no
    // post-unmount setState warning is raised by setup-fail-on-console.
    expect(resolveStatus).not.toBeNull();
  });
});
