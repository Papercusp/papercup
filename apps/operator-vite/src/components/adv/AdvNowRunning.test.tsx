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
// Mug/Kettle/Cup retirement flag (retire-mug-kettle-su-only-2026-08-09 P-043).
// POLARITY IS INVERTED: false = tier RETIRED (the shipped default), true = the
// reversible testing escape hatch. Defaults to true so the pre-existing
// Start/Stop coverage keeps exercising the live-tier path; the retirement
// assertions flip it per-test.
let tierLive = true;
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive }));

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
  tierLive = true;
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

  it('stopped hive → Start button, no Active label', async () => {
    const { container } = render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Start pot')).toBeTruthy();
    expect(container.querySelector('.pc-advshell__harness-bar')?.className).toContain('is-stopped');
    expect(screen.queryByText(/Active —/)).toBeNull();
  });

  it('started hive → Stop button, no per-agent status label (moved to the unified roster)', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Stop pot')).toBeTruthy();
    expect(screen.queryByText('Start pot')).toBeNull();
    expect(screen.queryByText(/Active —/)).toBeNull(); // the "Active — N running" label is gone
  });

  it('Start fires pot:start via the palette bridge and flips to waiting-for-agent', async () => {
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Start pot'));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:start', args: { harness: 'hive-1' }, confirmed: true },
      ]),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('pot started', expect.anything()));
    // Optimistic active → the Stop control replaces Start (no per-agent label anymore).
    expect(await screen.findByText('Stop pot')).toBeTruthy();
    expect(screen.queryByText('Start pot')).toBeNull();
  });

  it('a refused pot:start surfaces toast.error and stays stopped', async () => {
    runToolResponse = { ok: false, error: 'governor gate closed' };
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Start pot'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Start failed', expect.anything()));
    expect(screen.getByText('Start pot')).toBeTruthy();
    expect(screen.queryByText(/Active —/)).toBeNull();
  });

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
    tierLive = false;
    hiveRows = [{ slug: 'hive-1', started: false }];
    render(<AdvNowRunning slug="pot-a" />);
    // Wait for the bar itself so this cannot pass merely because nothing rendered yet.
    await waitFor(() => expect(document.querySelector('.pc-advshell__harness-bar')).toBeTruthy());
    expect(screen.queryByText('Start pot')).toBeNull();
  });

  it('tier retired: a STILL-STARTED pot keeps a working Stop (D-017)', async () => {
    tierLive = false;
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
