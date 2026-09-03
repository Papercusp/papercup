// @vitest-environment jsdom
//
// useAccountOverride optimism (accounts-pool-tab P-004): the owner's session-now
// Force/Exclude toggle must flip INSTANTLY — the desktop ships on SSE where the sync
// lib can't apply optimistically, so the hook applies the predicted override locally,
// then reconciles with (or rolls back to) the server's authoritative response. These
// tests pin both the optimistic window and the rollback-on-failure.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { syncRows, invalidateSpy } = vi.hoisted(() => ({ syncRows: [] as unknown[], invalidateSpy: vi.fn() }));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: syncRows, loading: false, fetching: false, error: null, invalidate: invalidateSpy }),
}));

import { useAccountOverride } from './use-account-override';

function Harness() {
  const { forced, toggleForce } = useAccountOverride();
  return (
    <div>
      <span data-testid="forced">{[...forced].join(',')}</span>
      <button onClick={() => toggleForce('acct-a')}>force</button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const json = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

afterEach(() => {
  syncRows.splice(0);
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useAccountOverride', () => {
  it('applies Force optimistically before the POST resolves, then reconciles', async () => {
    // GET (the on-mount read) fail-soft → no seed override to clobber the optimistic apply.
    // POST is held open so we can observe the optimistic window.
    const post = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return post.promise;
      return Promise.reject(new Error('no session-override route'));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('forced').textContent).toBe(''));

    // Click Force — the optimistic apply is synchronous, so it lands BEFORE the POST resolves.
    fireEvent.click(screen.getByText('force'));
    expect(screen.getByTestId('forced').textContent).toBe('acct-a');

    // Server confirms — the hook reconciles to the authoritative override.
    post.resolve(json(true, { ok: true, override: { forcedAccounts: ['acct-a'], excludeAccounts: [] } }));
    await waitFor(() => expect(screen.getByTestId('forced').textContent).toBe('acct-a'));

    // The toggle drove a POST (the changed field).
    expect(fetchMock.mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')).toBe(true);
  });

  it('rolls back the optimistic apply to the prior override when the POST fails', async () => {
    // GET seeds an existing override (acct-seed forced); the failing toggle must roll back to it.
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve(json(false, { ok: false, error: 'nope' }));
      return Promise.resolve(json(true, { ok: true, override: { forcedAccounts: ['acct-seed'], excludeAccounts: [] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    syncRows.push({ forcedAccounts: ['acct-seed'], excludeAccounts: [] });

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('forced').textContent).toBe('acct-seed'));

    fireEvent.click(screen.getByText('force')); // optimistic → acct-seed,acct-a, then POST fails

    // The failed POST rolls back to the prior override — not the optimistic acct-a.
    await waitFor(() => expect(screen.getByTestId('forced').textContent).toBe('acct-seed'));
  });
});
