// @vitest-environment jsdom
//
// AdvNowRunning render coverage — the AdvShell header harness status bar,
// now purely THE hive Start/Pause control + the "N plans waiting" nudge. The
// per-agent run pills + "Active — N running" label were removed once the
// unified header roster (AgentsRunningPill) shipped. Mounts the bar against
// mocked sync queries (hive.controlState + plans.waitingCount) and a stubbed
// run-tool dispatch. Asserts:
//   - the null-slug blank state and the is-checking loading state,
//   - stopped → Start hive, started → Stop hive (no per-agent label),
//   - Start fires pot:start through the loopback palette bridge and flips to
//     the optimistic active state (errors → toast.error),
//   - Stop confirms, then fires pot:pause { drainCups: true },
//   - that the removed "N plans waiting" nudge neither renders NOR subscribes
//     to plans.waitingCount (P-075 — the aggregate was deleted with it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { tab: null, view: null, pBuckets: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
  parseAsString: {},
  parseAsArrayOf: () => ({}),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Per-query sync mock — the component subscribes to three distinct queries.
let hiveRows: unknown[] | undefined = [{ slug: 'hive-1', started: false }];
let runRows: unknown[] = [];
const syncEnabled: Record<string, boolean | undefined> = {};
const syncArgs: Record<string, unknown> = {};
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({
    queryName,
    args,
    enabled,
  }: {
    queryName: string;
    args?: unknown;
    enabled?: boolean;
  }) => {
    syncEnabled[queryName] = enabled;
    syncArgs[queryName] = args;
    // A disabled query never resolves data (no fetch) — mirror that here.
    if (enabled === false) return { data: undefined };
    switch (queryName) {
      case 'hive.controlState':
        return { data: hiveRows };
      case 'agentRunsConsolidated.recent':
        return { data: runRows };
      default:
        return { data: undefined };
    }
  },
}));

// Lexicon resolver mocked to ECHO its key (t('pot')→'pot', t('brain')→'brain',
// t('contributor')→'contributor') — isolates the routed Start/Stop/toast/confirm
// copy from the THE_HIVE flag hook; classic pack renders 'Pot'/'Brain'/'Cup(s)'
// at runtime (restore-pot-lexicon P-006).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
// Mug/Kettle/Cup retirement (retire-mug-kettle-su-only-2026-08-09 P-043 → P-068).
// This mock used to carry a mutable `tierLive` the retirement cases flipped. It
// no longer can: P-068 deleted the flag and the component's read of it, so the
// component calls no flag hook at all and a `tierLive` toggle drove NOTHING —
// which silently made the D-010 absence case below pass for the wrong reason.
// The stub is retained only for transitive importers, pinned to the shipped
// truth (retired); the retirement is now asserted structurally, not by a toggle.
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => false }));

import { toast } from 'sonner';
import AdvNowRunning from './AdvNowRunning';

const toastMock = vi.mocked(toast);

let runToolResponse: Record<string, unknown> = {
  ok: true,
  result: { content: [{ text: JSON.stringify({ ok: true }) }] },
};
let runToolCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  nuqsState.tab = null;
  nuqsState.view = null;
  nuqsState.pBuckets = null;
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  for (const k of Object.keys(syncEnabled)) delete syncEnabled[k];
  for (const k of Object.keys(syncArgs)) delete syncArgs[k];
  hiveRows = [{ slug: 'hive-1', started: false }];
  runRows = [];
  runToolCalls = [];
  runToolResponse = { ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } };
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/agent-mcp/run-tool')) {
        runToolCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { ok: true, status: 200, json: async () => runToolResponse };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AdvNowRunning', () => {
  it('renders nothing without a selected harness (All-Pots mode)', () => {
    const { container } = render(<AdvNowRunning slug={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the is-checking state while hive.controlState has not resolved', () => {
    hiveRows = undefined;
    const { container } = render(<AdvNowRunning slug="pot-a" />);
    const bar = container.querySelector('.pc-advshell__harness-bar');
    expect(bar?.className).toContain('is-checking');
    // no hive row yet → neither Start nor Stop
    expect(screen.queryByText(/Start pot/)).toBeNull();
    expect(screen.queryByText(/Stop pot/)).toBeNull();
  });

  it('stopped hive → is-stopped bar, no Start affordance, no Active label', async () => {
    const { container } = render(<AdvNowRunning slug="pot-a" />);
    // Wait for the bar itself so this cannot pass merely because nothing rendered yet.
    await waitFor(() => expect(container.querySelector('.pc-advshell__harness-bar')).toBeTruthy());
    expect(container.querySelector('.pc-advshell__harness-bar')?.className).toContain('is-stopped');
    expect(screen.queryByText('Start pot')).toBeNull();
    expect(screen.queryByText(/Active —/)).toBeNull();
  });

  it('started hive → Stop button, no per-agent status label (moved to the unified roster)', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Stop pot')).toBeTruthy();
    expect(screen.queryByText('Start pot')).toBeNull();
    expect(screen.queryByText(/Active —/)).toBeNull(); // the "Active — N running" label is gone
  });

  // P-068/D-098: the two `pot:start` click-path cases that lived here (the happy
  // path and the refused-start toast) are GONE, not retargeted. Their subject —
  // a Start button — is removed unconditionally, so there is no affordance left
  // to click and no way to force one back: unlike a flag-gated seam, there is no
  // predicate a test can stub. Their surviving assertion (that no Start renders)
  // is owned by the D-010 case below. The component's now-unreachable start
  // handler is dead code tracked by WI-38240, not by a test that cannot run it.

  it('Stop confirms, then fires pot:pause with drainCups', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop pot'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause pot' }));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:pause', args: { harness: 'hive-1', drainCups: true }, confirmed: true },
      ]),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('pot paused', expect.anything()));
  });

  it('a declined confirm aborts the pause entirely', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop pot'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(runToolCalls).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  // ---- "N plans waiting" nudge REMOVED (P-075, [owner 2026-08-10] "remove the
  // 'plans waiting' button"). This asserts the stronger property than "no button
  // renders": the bar must not SUBSCRIBE to plans.waitingCount at all. That is
  // what licensed deleting the server-side aggregate in the same change — a
  // surviving subscription would have made the resolver removal a runtime break
  // rather than dead-code cleanup. Asserted in the STOPPED state, the only one
  // that ever rendered the nudge.
  it('no longer renders the waiting-plans nudge, nor subscribes to its aggregate (P-075)', async () => {
    hiveRows = [{ slug: 'hive-1', started: false }];
    render(<AdvNowRunning slug="pot-a" />);
    // Wait for the bar itself so this cannot pass merely because nothing rendered yet.
    await waitFor(() => expect(document.querySelector('.pc-advshell__harness-bar')).toBeTruthy());
    expect(screen.queryByText(/plans? waiting/)).toBeNull();
    expect(Object.keys(syncEnabled)).not.toContain('plans.waitingCount');
  });

  // ---- Mug/Kettle/Cup retirement (P-043; D-010 retires the buttons, D-017
  // keeps the stoppers reachable). Both halves are asserted because the
  // ASYMMETRY is the invariant: a guard that only checked "Start is gone" would
  // pass equally on the unsafe variant that also removes Stop and strands a
  // running tier with no way to wind it down.
  it('tier retired: no Start button on a stopped pot (D-010)', async () => {
    hiveRows = [{ slug: 'hive-1', started: false }];
    render(<AdvNowRunning slug="pot-a" />);
    // Wait for the bar itself so this cannot pass merely because nothing rendered yet.
    await waitFor(() => expect(document.querySelector('.pc-advshell__harness-bar')).toBeTruthy());
    expect(screen.queryByText('Start pot')).toBeNull();
  });

  it('tier retired: a STILL-STARTED pot keeps a working Stop (D-017)', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop pot'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause pot' }));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:pause', args: { harness: 'hive-1', drainCups: true }, confirmed: true },
      ]),
    );
  });
});
