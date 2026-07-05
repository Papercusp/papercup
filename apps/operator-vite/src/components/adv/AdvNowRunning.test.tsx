// @vitest-environment jsdom
//
// AdvNowRunning render coverage — the AdvShell header harness status bar,
// now purely THE hive Start/Pause control + the "N plans waiting" nudge. The
// per-agent run pills + "Active — N running" label were removed once the
// unified header roster (AgentsRunningPill) shipped. Mounts the bar against
// mocked sync queries (hive.controlState + plans.list) and a stubbed run-tool
// dispatch. Asserts:
//   - the null-slug blank state and the is-checking loading state,
//   - stopped → Start hive, started → Stop hive (no per-agent label),
//   - Start fires pot:start through the loopback palette bridge and flips to
//     the optimistic active state (errors → toast.error),
//   - Stop confirms, then fires pot:pause { drainBees: true },
//   - the "N plans waiting" nudge (push-driven plans.list) + its click-through
//     to the Plans tab's Running bucket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { tab: null, view: null, pBuckets: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
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
let planRows: unknown[] = [];
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
      case 'plans.list':
        return { data: planRows };
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
  planRows = [];
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

  it('Stop confirms, then fires pot:pause with drainBees', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop pot'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause pot' }));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:pause', args: { harness: 'hive-1', drainBees: true }, confirmed: true },
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
    planRows = [{ startStatus: 'started' }, { startStatus: 'started' }, { startStatus: null }];
    render(<AdvNowRunning slug="pot-a" />);
    const nudge = await screen.findByText('2 plans waiting');
    // the plans.list query is enabled + scoped to this harness while stopped
    expect(syncEnabled['plans.list']).toBe(true);
    expect(syncArgs['plans.list']).toEqual({ harness_slugs: ['pot-a'] });
    fireEvent.click(nudge);
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('plans'));
    expect(nuqsSetters.view).toHaveBeenCalledWith('plans');
    expect(nuqsSetters.pBuckets).toHaveBeenCalledWith(['running']);
  });

  it('disables the waiting-plans query entirely while the hive is started', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    planRows = [{ startStatus: 'started' }, { startStatus: 'started' }];
    render(<AdvNowRunning slug="pot-a" />);
    await screen.findByText('Stop pot');
    // started hive → stopped=false → plans.list disabled (no fetch) → no nudge
    expect(syncEnabled['plans.list']).toBe(false);
    expect(screen.queryByText(/plans? waiting/)).toBeNull();
  });
});
