// @vitest-environment jsdom
//
// LocalPotsControl render + control coverage (hive-control-surface). Mounts the
// central local-hive start/stop list against a mocked hive.controlState query +
// a stubbed run-tool dispatch (the pinned AdvNowRunning sibling pattern). Asserts:
// a row per hive with state shown via the Start/Stop toggle label, the running
// tally, Start → pot:start (no drain), Stop → shared confirm dialog →
// pot:pause{drainCups}, and a declined confirm aborts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const H = vi.hoisted(() => ({
  confirmResult: true,
  confirm: vi.fn(),
}));

vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: H.confirm,
    element: <div data-testid="confirm-dialog" />,
  }),
}));

let hiveResult: Record<string, unknown> = {
  data: [
    { slug: 'papercup-hive', started: true },
    { slug: 'sb-devboard-hive', started: false },
  ],
  loading: false,
  error: null,
};
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => hiveResult }));
// Lexicon resolver mocked to ECHO its key (t('pot')→'pot', t('brain')→'brain',
// t('contributor')→'contributor') — isolates from the THE_HIVE flag hook; classic
// pack renders 'Pot(s)'/'Brain'/'Cup(s)' at runtime (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
// Mug/Kettle/Cup retirement flag (retire-mug-kettle-su-only-2026-08-09 P-043).
// POLARITY IS INVERTED: false = tier RETIRED (the shipped default), true = the
// reversible testing escape hatch. Defaults to true here so the pre-existing
// Start/Stop coverage below keeps exercising the live-tier path; the
// retirement assertions flip it per-test.
let tierLive = true;
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive }));

import { toast } from 'sonner';
import LocalPotsControl from './LocalPotsControl';

const toastMock = vi.mocked(toast);

let runToolCalls: Array<Record<string, unknown>> = [];
let runToolResponse: Record<string, unknown> = {
  ok: true,
  result: { content: [{ text: JSON.stringify({ ok: true }) }] },
};

beforeEach(() => {
  hiveResult = {
    data: [
      { slug: 'papercup-hive', started: true },
      { slug: 'sb-devboard-hive', started: false },
    ],
    loading: false,
    error: null,
  };
  runToolCalls = [];
  runToolResponse = { ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } };
  tierLive = true;
  H.confirmResult = true;
  H.confirm = vi.fn(async () => H.confirmResult);
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/agent-mcp/run-tool')) {
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

describe('LocalPotsControl', () => {
  it('renders a row per hive with its state + the running tally', () => {
    render(<LocalPotsControl />);
    expect(screen.getByTestId('confirm-dialog')).toBeTruthy();
    expect(screen.getByText('local pot · 1/2 running')).toBeTruthy();
    expect(screen.getByTestId('local-hive-papercup-hive')).toBeTruthy();
    // State is conveyed by the Start/Stop toggle label (no separate STARTED/
    // STOPPED text): a started hive offers Stop, a stopped hive offers Start.
    expect(screen.getByTestId('local-hive-toggle-papercup-hive').textContent).toContain('Stop');
    expect(screen.getByTestId('local-hive-toggle-sb-devboard-hive').textContent).toContain('Start');
  });

  it('honest empty state when no local hives are registered', () => {
    hiveResult = { data: [], loading: false, error: null };
    render(<LocalPotsControl />);
    expect(screen.getByText(/no local pot registered/)).toBeTruthy();
  });

  it('Start on a stopped hive fires pot:start (no drainCups)', async () => {
    render(<LocalPotsControl />);
    fireEvent.click(screen.getByTestId('local-hive-toggle-sb-devboard-hive'));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:start', args: { harness: 'sb-devboard-hive' }, confirmed: true },
      ]),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('pot started', expect.anything()),
    );
  });

  it('Stop on a started hive confirms with the shared dialog, then fires pot:pause{drainCups}', async () => {
    render(<LocalPotsControl />);
    fireEvent.click(screen.getByTestId('local-hive-toggle-papercup-hive'));
    await waitFor(() =>
      expect(H.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Pause papercup-hive?',
        confirmLabel: 'Pause pot',
        destructive: true,
      })),
    );
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:pause', args: { harness: 'papercup-hive', drainCups: true }, confirmed: true },
      ]),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('pot paused', expect.anything()),
    );
  });

  // ---- Mug/Kettle/Cup retirement (P-043; D-010 retires the buttons, D-017
  // keeps the stoppers). The ASYMMETRY is the invariant worth guarding: Start
  // disappears, Stop survives. A guard that only checked "the control is gone"
  // would pass just as happily on the unsafe version that strands a running
  // tier with no way to stop it.
  it('tier retired: a stopped pot offers no Start button', () => {
    tierLive = false;
    render(<LocalPotsControl />);
    // The ROW still renders — state stays visible; only the affordance goes.
    expect(screen.getByTestId('local-hive-sb-devboard-hive')).toBeTruthy();
    expect(screen.queryByTestId('local-hive-toggle-sb-devboard-hive')).toBeNull();
  });

  it('tier retired: a STILL-STARTED pot keeps a working Stop (D-017 — never strand a running tier)', async () => {
    tierLive = false;
    render(<LocalPotsControl />);
    const stop = screen.getByTestId('local-hive-toggle-papercup-hive');
    expect(stop.textContent).toContain('Stop');
    // Present is not enough — it must still actually stop the tier.
    fireEvent.click(stop);
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'pot:pause', args: { harness: 'papercup-hive', drainCups: true }, confirmed: true },
      ]),
    );
  });

  it('tier retired: the hint stops advertising a Start/Stop control that is no longer rendered', () => {
    tierLive = false;
    render(<LocalPotsControl />);
    const hint = screen.getByTestId('queen-tab-pointer').textContent ?? '';
    expect(hint).toContain('retired');
    expect(hint).toContain('su + GOAL mode');
    expect(hint).not.toContain('chooses');
  });

  it('a declined confirm aborts the pause', () => {
    H.confirmResult = false;
    render(<LocalPotsControl />);
    fireEvent.click(screen.getByTestId('local-hive-toggle-papercup-hive'));
    expect(H.confirm).toHaveBeenCalled();
    expect(runToolCalls).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
