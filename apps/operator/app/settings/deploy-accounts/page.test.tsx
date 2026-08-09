// @vitest-environment jsdom
/**
 * Deploy accounts settings — the default-account banner + clear control
 * (default-deploy-account-2026-08-08 P-006).
 *
 * Scoped to the default axis on purpose. The banner is this page's answer to the question the
 * plan exists to make answerable — "which account is everything actually running on right
 * now?" — and it has THREE states, not two: an account, no account (the box's own ~/.claude
 * login), and not-yet-known. Collapsing the third into the second would have the page state
 * a routing fact it has not established, which is the failure mode worth a test.
 *
 * The grid is stubbed out: per-row controls are exercised through the shared AccountsTab suite,
 * and rendering RichGrid here would couple this to the whole account-row projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// vi.mock is hoisted above every top-level const, so the spies have to be hoisted with it.
const H = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
const toastError = H.toastError;
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: H.toastSuccess, error: H.toastError, message: vi.fn() }),
}));
vi.mock('nuqs', () => ({
  useQueryState: (_k: string, parser?: { defaultValue?: unknown }) => [parser?.defaultValue ?? null, vi.fn()],
  parseAsBoolean: { withDefault: (d: unknown) => ({ defaultValue: d }) },
  parseAsString: { withDefault: (d: unknown) => ({ defaultValue: d }) },
}));
vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => <div data-testid="grid" /> }));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }),
}));

import DeployAccountsPage from './page';

// `rate` is not optional in practice — isActiveAccount reads rate.pausedUntil during render,
// so a row without it takes the whole page down rather than degrading.
const ACCOUNTS = [
  {
    id: 'aviynw6',
    provider: 'claude',
    credentialRef: 'token:/a',
    rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
  },
];

/** Serve the page's three GETs; `defaultOverride` drives the axis under test. */
function stubFetch(opts: { defaultOverride?: unknown; overrideFails?: boolean; post?: unknown } = {}) {
  const post = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('session-override')) {
        if (init?.method === 'POST') {
          post(JSON.parse(String(init.body)));
          return { ok: true, json: async () => opts.post ?? { ok: true, override: {} } } as Response;
        }
        if (opts.overrideFails) throw new Error('gateway unreachable');
        return { ok: true, json: async () => ({ ok: true, override: opts.defaultOverride ?? {} }) } as Response;
      }
      if (url.includes('inference-gateway/stats')) return { ok: true, json: async () => ({ ok: false }) } as Response;
      return { ok: true, json: async () => ({ ok: true, accounts: ACCOUNTS }) } as Response;
    }),
  );
  return { post };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Deploy accounts — default-account banner (P-006)', () => {
  it('names the account in force, and says traffic still fails over past it', async () => {
    stubFetch({ defaultOverride: { defaultAccountId: 'aviynw6' } });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    expect(screen.getByText('aviynw6')).toBeTruthy();
    expect(screen.getByText(/fail over to the rest of the pool/)).toBeTruthy();
  });

  it('with NO default, names what is being used instead rather than going blank', async () => {
    // "No default" is a real routing state, not an empty one — before this feature the honest
    // answer ("this box's own login") appeared nowhere on the page at all.
    stubFetch({ defaultOverride: {} });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/No default account/)).toBeTruthy());
    expect(screen.getByText('~/.claude')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull(); // nothing to clear
  });

  it('a FAILED override read shows NOTHING rather than claiming "no default"', async () => {
    // The distinction that matters: unknown ≠ none. Coercing a failed read to null would make
    // the page assert the machine is on its own ~/.claude login when it may well be on a pool
    // account — a confident, wrong answer to the one question this banner exists to answer.
    stubFetch({ overrideFails: true });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy()); // page finished loading
    expect(screen.queryByText(/No default account/)).toBeNull();
    expect(screen.queryByText(/Default account:/)).toBeNull();
  });

  it('Clear posts an explicit null (the D-002 way back to ~/.claude)', async () => {
    // null, not '' or a missing key: the store treats null (clear) and omission (keep) as
    // different things, so an omitted field here would silently leave the default in place.
    const { post } = stubFetch({ defaultOverride: { defaultAccountId: 'aviynw6' }, post: { ok: true, override: {} } });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    screen.getByRole('button', { name: 'Clear' }).click();
    await waitFor(() => expect(post).toHaveBeenCalledWith({ defaultAccountId: null }));
    await waitFor(() => expect(screen.getByText(/No default account/)).toBeTruthy());
  });

  it('re-reads the server’s answer instead of trusting the click', async () => {
    // The write can change more than this one field, and the server validates the pick — so the
    // banner must reflect what came BACK, not what was sent. Here the server reports a different
    // account than the clear that was requested; the banner must follow the server.
    const { post } = stubFetch({
      defaultOverride: { defaultAccountId: 'aviynw6' },
      post: { ok: true, override: { defaultAccountId: 'aviynw2' } },
    });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    screen.getByRole('button', { name: 'Clear' }).click();
    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('aviynw2')).toBeTruthy());
  });

  it('surfaces the server’s own rejection reason, and leaves the banner alone', async () => {
    stubFetch({
      defaultOverride: { defaultAccountId: 'aviynw6' },
      post: { ok: false, error: "account 'codex-main' is a Codex account." },
    });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    screen.getByRole('button', { name: 'Clear' }).click();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("account 'codex-main' is a Codex account."));
    expect(screen.getByText('aviynw6')).toBeTruthy(); // unchanged by the failed write
  });
});
