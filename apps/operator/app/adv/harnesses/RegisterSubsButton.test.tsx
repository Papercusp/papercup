// @vitest-environment jsdom
//
// RegisterSubsButton — the one-click "register sub-pots" action: POST to
// /api/harness/projects/register-subs plus its toast branching (new /
// reconciled / errors / up-to-date / HTTP failure / network throw). Each branch
// is exercised through a REAL click so a destructure/await bug in the handler
// surfaces here rather than in the UI.
//
// WHY THIS FILE EXISTS (EI-18814950644299297): this suite used to live in
// HarnessTopBar.test.tsx and drive the button THROUGH <HarnessTopBar />. On
// 2026-07-27 the pot-level actions moved off the dock top bar to the pot bar
// (AdvPotBar) and the button was extracted to RegisterSubsButton.tsx — the
// component move was correct, but the tests were left rendering a top bar that
// no longer contains the button, so all six went red without the behavior they
// pin having changed at all. They are re-homed next to the component they test,
// which is what stops the same move from re-redding them: a test that renders
// its subject directly does not care which bar the subject is mounted on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

import RegisterSubsButton from './RegisterSubsButton';
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
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('RegisterSubsButton', () => {
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
    render(<RegisterSubsButton slug="root-h" />);
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
    expect(toastSuccess.mock.calls[0][0]).toMatch(/Members of pot 'my-hive'\./);
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
