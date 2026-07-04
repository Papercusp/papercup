// @vitest-environment jsdom
//
// HarnessTopBar — the /adv/harnesses actions bar. The legacy stat cards
// (pulse / lanes / passed / $ spent / health) were removed; what remains is
// the action row (workspaces, register sub-hives, add panel, reset layout).
// The heavy children (AddPanelCatalog, the workspaces button) are stubbed —
// they aren't the thing under test. The logic worth pinning is the
// Register-sub-hives POST + toast branching, and that reset-layout fires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../harness/dock/AddPanelCatalog', () => ({ AddPanelCatalog: () => <span data-testid="add-panel" /> }));
vi.mock('./HarnessWorkspacesButton', () => ({ default: () => <span data-testid="ws-button" /> }));
const resetLayout = vi.fn();
vi.mock('../../harness/dock/dock-actions', () => ({ resetLayout: () => resetLayout() }));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

import HarnessTopBar from './HarnessTopBar';
import { lexiconFor } from '@papercusp/lexicon';

// The button label is lexicon-driven (`Register sub-${t('pot', {plural, lower})}`).
// Tests render under the DEFAULT ('classic' → Pot) brand pack (the-hive flag off),
// so resolve the brand term the SAME way the component does — a brand-lexicon flip
// then can never re-red this gate. (restore-pot-lexicon-2026-07-04 fallout, su-e9204.)
const REGISTER_SUBS_LABEL = new RegExp(
  `register sub-${lexiconFor('classic')('pot', { plural: true, lower: true })}`,
  'i',
);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string) => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetLayout.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('<HarnessTopBar />', () => {
  it('renders the action row (workspaces, register sub-hives, add panel) for a slug', () => {
    render(<HarnessTopBar slug="h" />);
    expect(screen.getByTestId('ws-button')).toBeTruthy();
    expect(screen.getByTestId('add-panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: REGISTER_SUBS_LABEL })).toBeTruthy();
  });

  it('reset-layout button invokes resetLayout()', () => {
    render(<HarnessTopBar slug="h" />);
    fireEvent.click(screen.getByRole('button', { name: /reset layout/i }));
    expect(resetLayout).toHaveBeenCalledTimes(1);
  });
});

// The Register-sub-harnesses action handler — the ~70-line POST + toast branching
// that the original suite never rendered. Each branch (new / reconciled / errors /
// up-to-date / HTTP failure / network throw) is exercised through a real click so
// a destructure/await bug in the handler would surface.
describe('<HarnessTopBar /> RegisterSubsButton', () => {
  function statusServer(extra: (url: string) => Response | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/register-subs') && init?.method === 'POST') {
          const r = extra(u);
          if (r) return r;
        }
        return new Response('{}', { status: 200 });
      }),
    );
  }
  function clickRegister() {
    render(<HarnessTopBar slug="root-h" />);
    fireEvent.click(screen.getByRole('button', { name: REGISTER_SUBS_LABEL }));
  }

  it('POSTs with the rootSlug and reports new + reconciled counts on success', async () => {
    statusServer(() =>
      new Response(
        JSON.stringify({ ok: true, discovered: 3, registered: ['a', 'b'], reconciled: ['c'], hiveReconciled: [], membership: null, errors: [] }),
        { status: 200 },
      ),
    );
    clickRegister();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // POST body carried the selected slug
    const post = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([u]) => String(u).includes('/register-subs'));
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ rootSlug: 'root-h' });
    // 2 new + (1 reconciled + 0 hive) reconciled
    expect(toastSuccess.mock.calls[0][0]).toMatch(/Discovered 3 submodules — 2 new, 1 reconciled/);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('appends the hive note when membership.kind is hive_slug', async () => {
    statusServer(() =>
      new Response(
        JSON.stringify({ ok: true, discovered: 1, registered: ['a'], reconciled: [], hiveReconciled: [], membership: { kind: 'hive_slug', value: 'my-hive' }, errors: [] }),
        { status: 200 },
      ),
    );
    clickRegister();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toMatch(/Members of hive 'my-hive'\./);
  });

  it('reports the up-to-date case (zero new + zero reconciled) as a quiet success', async () => {
    statusServer(() =>
      new Response(JSON.stringify({ ok: true, discovered: 2, registered: [], reconciled: [], hiveReconciled: [], membership: null, errors: [] }), { status: 200 }),
    );
    clickRegister();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toMatch(
      new RegExp(`No new sub-${lexiconFor('classic')('pot', { plural: true, lower: true })}`),
    );
  });

  it('routes a payload with per-slug errors to toast.error', async () => {
    statusServer(() =>
      new Response(
        JSON.stringify({ ok: true, discovered: 2, registered: ['a'], reconciled: [], hiveReconciled: [], membership: null, errors: [{ slug: 'bad', error: 'boom' }] }),
        { status: 200 },
      ),
    );
    clickRegister();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toMatch(/1 errors/);
  });

  it('surfaces an HTTP failure (non-ok / ok:false) via toast.error', async () => {
    statusServer(() => new Response(JSON.stringify({ ok: false, error: 'not authorized' }), { status: 403 }));
    clickRegister();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/register-subs failed: not authorized/)));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a thrown fetch (network error) via toast.error', async () => {
    statusServer((u) => {
      if (u.includes('/register-subs')) throw new Error('network down');
      return null;
    });
    clickRegister();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/register-subs failed: network down/)));
  });
});
