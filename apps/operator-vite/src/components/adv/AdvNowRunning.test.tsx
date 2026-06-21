// @vitest-environment jsdom
//
// AdvNowRunning render coverage — the AdvShell header harness status bar +
// THE hive Start/Pause control (start-hive-wake-orchestration P-005/P-006).
// Mounts the bar against a mocked hive.controlState sync row + a stubbed
// agents poll and run-tool dispatch (useSyncQuery + nuqs mocked, the pinned
// sibling pattern — see AdvConversationsTab.test.tsx). Asserts:
//   - the null-slug blank state and the is-checking loading state,
//   - stopped → Start hive, started → Active — idle + Stop hive,
//   - live agent runs become pills (role · featureId · m:ss, runId parsing),
//   - Start fires hive:start through the loopback palette bridge and flips to
//     the optimistic "waiting for agent…" state (errors → toast.error),
//   - Stop confirms, then fires hive:pause { drainBees: true },
//   - the "N plans waiting" nudge + its click-through to the Plans tab's
//     Running bucket (the countWaitingPlans/waitingLabel pure layer is pinned
//     in __tests__/adv-now-running-logic.test.ts).

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

let hiveResult: Record<string, unknown> = { data: [{ slug: 'hive-1', started: false }] };
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => hiveResult }));

// The hover popover is its own surface — stub it out.
vi.mock('@/app/harness/AgentThinkingPopover', () => ({
  default: ({ runId }: { runId: string }) => <div data-testid="thinking-popover" data-run={runId} />,
}));

vi.mock('@/app/admin/plans/plans-api', () => ({
  fetchPlanList: vi.fn(async () => ({ plans: [] })),
}));

import { toast } from 'sonner';
import { fetchPlanList } from '@/app/admin/plans/plans-api';
import AdvNowRunning from './AdvNowRunning';

const fetchPlanListMock = vi.mocked(fetchPlanList);
const toastMock = vi.mocked(toast);

type RunRow = { runId: string; role: string; ts: number; running?: boolean };
let agentsRuns: RunRow[] = [];
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
  hiveResult = { data: [{ slug: 'hive-1', started: false }] };
  agentsRuns = [];
  runToolCalls = [];
  runToolResponse = { ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } };
  fetchPlanListMock.mockReset();
  fetchPlanListMock.mockResolvedValue({ plans: [] } as never);
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
      if (u.includes('/agents?phase=staging')) {
        return { ok: true, status: 200, json: async () => ({ runs: agentsRuns }) };
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
    hiveResult = { data: undefined };
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
    hiveResult = { data: [{ slug: 'hive-1', started: true }] };
    render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Active — idle')).toBeTruthy();
    expect(screen.getByText('Stop hive')).toBeTruthy();
    expect(screen.queryByText('Start hive')).toBeNull();
  });

  it('renders one pill per RUNNING agent with the parsed featureId + duration', async () => {
    hiveResult = { data: [{ slug: 'hive-1', started: true }] };
    const nowSec = Math.floor(Date.now() / 1000);
    agentsRuns = [
      { runId: 'r1-worker-F-042', role: 'worker', ts: nowSec - 65, running: true },
      { runId: 'r2-queen', role: 'queen', ts: nowSec - 5, running: true },
      { runId: 'r3-oracle-F-001', role: 'oracle', ts: nowSec - 9, running: false },
    ];
    render(<AdvNowRunning slug="pot-a" />);
    expect(await screen.findByText('Active — 2 agents running')).toBeTruthy();
    // runId "r1-worker-F-042" → role worker, featureId F-042; oldest first
    expect(screen.getByText(/worker · F-042 · 1:0[5-7]/)).toBeTruthy();
    // runId "r2-queen" → no featureId remainder
    expect(screen.getByText(/^queen · 0:0[5-7]$/)).toBeTruthy();
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
    hiveResult = { data: [{ slug: 'hive-1', started: true }] };
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
    hiveResult = { data: [{ slug: 'hive-1', started: true }] };
    render(<AdvNowRunning slug="pot-a" />);
    fireEvent.click(await screen.findByText('Stop hive'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(runToolCalls).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('nudges with "N plans waiting" while stopped and deep-links the Running bucket', async () => {
    fetchPlanListMock.mockResolvedValue({
      plans: [{ startStatus: 'started' }, { startStatus: 'started' }, { startStatus: null }],
    } as never);
    render(<AdvNowRunning slug="pot-a" />);
    const nudge = await screen.findByText('2 plans waiting');
    expect(fetchPlanListMock).toHaveBeenCalledWith({ harness_slugs: ['pot-a'] });
    fireEvent.click(nudge);
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('plans'));
    expect(nuqsSetters.view).toHaveBeenCalledWith('plans');
    expect(nuqsSetters.pBuckets).toHaveBeenCalledWith(['running']);
  });

  it('skips the waiting-plans fetch entirely while the hive is started', async () => {
    hiveResult = { data: [{ slug: 'hive-1', started: true }] };
    render(<AdvNowRunning slug="pot-a" />);
    await screen.findByText('Active — idle');
    expect(fetchPlanListMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/plans? waiting/)).toBeNull();
  });
});
