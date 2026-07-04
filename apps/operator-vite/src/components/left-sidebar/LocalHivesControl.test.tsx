// @vitest-environment jsdom
//
// LocalHivesControl render + control coverage (hive-control-surface). Mounts the
// central local-hive start/stop list against a mocked hive.controlState query +
// a stubbed run-tool dispatch (the pinned AdvNowRunning sibling pattern). Asserts:
// a row per hive with state shown via the Start/Stop toggle label, the running
// tally, Start → hive:start (no drain), Stop → shared confirm dialog →
// hive:pause{drainBees}, and a declined confirm aborts.

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

import { toast } from 'sonner';
import LocalHivesControl from './LocalHivesControl';

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

describe('LocalHivesControl', () => {
  it('renders a row per hive with its state + the running tally', () => {
    render(<LocalHivesControl />);
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
    render(<LocalHivesControl />);
    expect(screen.getByText(/no local pot registered/)).toBeTruthy();
  });

  it('Start on a stopped hive fires hive:start (no drainBees)', async () => {
    render(<LocalHivesControl />);
    fireEvent.click(screen.getByTestId('local-hive-toggle-sb-devboard-hive'));
    await waitFor(() =>
      expect(runToolCalls).toEqual([
        { name: 'hive:start', args: { harness: 'sb-devboard-hive' }, confirmed: true },
      ]),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('pot started', expect.anything()),
    );
  });

  it('Stop on a started hive confirms with the shared dialog, then fires hive:pause{drainBees}', async () => {
    render(<LocalHivesControl />);
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
        { name: 'hive:pause', args: { harness: 'papercup-hive', drainBees: true }, confirmed: true },
      ]),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('pot paused', expect.anything()),
    );
  });

  it('a declined confirm aborts the pause', () => {
    H.confirmResult = false;
    render(<LocalHivesControl />);
    fireEvent.click(screen.getByTestId('local-hive-toggle-papercup-hive'));
    expect(H.confirm).toHaveBeenCalled();
    expect(runToolCalls).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
