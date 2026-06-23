// @vitest-environment jsdom
//
// AdvNowRunning render coverage — the AdvShell header harness status bar +
// THE hive Start/Pause control (start-hive-wake-orchestration P-005/P-006).
// Mounts the bar against mocked sync queries (hive.controlState +
// agentRunsConsolidated.recent + plans.list — all push-driven after
// data-sync-push-completion P-004/P-005) and a stubbed run-tool dispatch
// (useSyncQuery + nuqs mocked, the pinned sibling pattern). Asserts:
//   - the null-slug blank state and the is-checking loading state,
//   - stopped → Start hive, started → Active — idle + Stop hive,
//   - live agent runs become pills (role · featureId · m:ss),
//   - Start fires hive:start through the loopback palette bridge and flips to
//     the optimistic "waiting for agent…" state (errors → toast.error),
//   - Stop confirms, then fires hive:pause { drainBees: true },
//   - the "N plans waiting" nudge (push-driven plans.list) + its click-through
//     to the Plans tab's Running bucket (the countWaitingPlans/waitingLabel
//     pure layer is pinned in __tests__/adv-now-running-logic.test.ts).

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

// The hover popover is its own surface — stub it out.
vi.mock('@/app/harness/AgentThinkingPopover', () => ({
  default: ({ runId }: { runId: string }) => <div data-testid="thinking-popover" data-run={runId} />,
}));

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
    expect(screen.queryByText(/Start hive/)).toBeNull();
    expect(screen.queryByText(/Stop hive/)).toBeNull();
  });

  it('stopped hive → Start button, no Active label', async () => {
    const { container } = render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Start hive')).toBeTruthy();
    expect(container.querySelector('.pc-advshell__harness-bar')?.className).toContain('is-stopped');
    expect(screen.queryByText(/Active —/)).toBeNull();
  });

  it('started hive with no runs → "Active — idle" + Stop button', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Active — idle')).toBeTruthy();
    expect(screen.getByText('Stop hive')).toBeTruthy();
    expect(screen.queryByText('Start hive')).toBeNull();
  });

  it('renders one pill per RUNNING agent with the resolved featureId + duration', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    const nowSec = Math.floor(Date.now() / 1000);
    // agentRunsConsolidated.recent rows: featureId is a resolved column; ts is epoch-ms.
    runRows = [
      { runId: 'r1-worker-F-042', role: 'worker', featureId: 'F-042', ts: (nowSec - 65) * 1000, running: true },
      { runId: 'r2-queen', role: 'queen', featureId: null, ts: (nowSec - 5) * 1000, running: true },
      { runId: 'r3-oracle-F-001', role: 'oracle', featureId: 'F-001', ts: (nowSec - 9) * 1000, running: false },
    ];
    render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Active — 2 agents running')).toBeTruthy();
    // worker run · featureId F-042 · ~65s; oldest first
    expect(screen.getByText(/worker · F-042 · 1:0[4-7]/)).toBeTruthy();
    // queen run · no featureId remainder
    expect(screen.getByText(/^queen · 0:0[4-7]$/)).toBeTruthy();
    // non-running runs are filtered out
    expect(screen.queryByText(/oracle/)).toBeNull();
  });

  it('Start fires hive:start via the palette bridge and flips to waiting-for-agent', async () => {
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Start hive'));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'hive:start', args: { harness: 'hive-1' }, confirmed: true },
      ]),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Hive started', expect.anything()));
    expect(await screen.findByText('Active — waiting for agent…')).toBeTruthy();
    expect(screen.queryByText('Start hive')).toBeNull();
  });

  it('a refused hive:start surfaces toast.error and stays stopped', async () => {
    runToolResponse = { ok: false, error: 'governor gate closed' };
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Start hive'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Start failed', expect.anything()));
    expect(screen.getByText('Start hive')).toBeTruthy();
    expect(screen.queryByText(/Active —/)).toBeNull();
  });

  it('Stop confirms, then fires hive:pause with drainBees', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop hive'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause hive' }));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'hive:pause', args: { harness: 'hive-1', drainBees: true }, confirmed: true },
      ]),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Hive paused', expect.anything()));
  });

  it('a declined confirm aborts the pause entirely', async () => {
    hiveRows = [{ slug: 'hive-1', started: true }];
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop hive'));
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
    await screen.findByText('Active — idle');
    // started hive → stopped=false → plans.list disabled (no fetch) → no nudge
    expect(syncEnabled['plans.list']).toBe(false);
    expect(screen.queryByText(/plans? waiting/)).toBeNull();
  });
});
