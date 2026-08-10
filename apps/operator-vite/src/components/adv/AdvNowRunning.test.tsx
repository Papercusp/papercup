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
//   - the "N plans waiting" nudge (push-driven plans.waitingCount, the
//     server-side aggregate — EI-19409535742567802) + its click-through to
//     the Plans tab's Running bucket.

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
let waitingCountRows: unknown[] = [];
const syncEnabled: Record<string, boolean | undefined> = {};
const syncArgs: Record<string, unknown> = {};
vi.mock('@papercusp/sync', () => ({
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
      case 'plans.waitingCount':
        return { data: waitingCountRows };
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
  waitingCountRows = [];
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

  it('nudges with "N plans waiting" while stopped and deep-links the Running bucket', async () => {
    waitingCountRows = [{ count: 2 }];
    render(<AdvNowRunning slug="pot-a" />);
    const nudge = await screen.findByText('2 plans waiting');
    // the plans.waitingCount query is enabled + scoped to this harness while stopped
    expect(syncEnabled['plans.waitingCount']).toBe(true);
    expect(syncArgs['plans.waitingCount']).toEqual({ harness_slugs: ['pot-a'] });
    fireEvent.click(nudge);
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('plans'));
    expect(nuqsSetters.view).toHaveBeenCalledWith('plans');
    expect(nuqsSetters.pBuckets).toHaveBeenCalledWith(['running']);
  });

  it('disables the waiting-plans query entirely while the hive is started', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    waitingCountRows = [{ count: 2 }];
    render(<AdvNowRunning slug="pot-a" />);
    await screen.findByText('Stop pot');
    // started hive → stopped=false → plans.waitingCount disabled (no fetch) → no nudge
    expect(syncEnabled['plans.waitingCount']).toBe(false);
    expect(screen.queryByText(/plans? waiting/)).toBeNull();
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
