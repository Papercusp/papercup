// @vitest-environment jsdom
//
// GitClient render coverage — mounts the /admin Git tab against a realistic
// dev.gitPipeline snapshot (useSyncQuery + nuqs mocked) and asserts the stats,
// the open-conflict banner, and the timeline render. Guards against render-time
// crashes the build/typecheck can't catch (null derefs in the JSX).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// nuqs: useQueryState needs the adapter context — stub it. The 'window' state reads '24h';
// the per-hive 'hive' selection reads from `selectedHive` (default '' → nothing expanded).
let selectedHive = '';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => (key === 'hive' ? [selectedHive, vi.fn()] : ['24h', vi.fn()]),
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsString: { withDefault: () => ({}) },
}));

// Tooltip pulls deps that don't load in the vite test env — passthrough (codebase convention).
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const snapshot = {
  slug: 'papercup',
  generatedAtMs: Date.now(),
  routines: {
    gitSync: { name: 'git-sync', active: true, cron: '0 */10 * * * *', lastFiredAtMs: Date.now() - 120000, nextFireAtMs: Date.now() + 480000 },
    greenCheckpoint: { name: 'green-checkpoint', active: true, cron: '0 15 * * * *', lastFiredAtMs: Date.now() - 3600000, nextFireAtMs: Date.now() + 1000 },
    releaseTrigger: { name: 'release-trigger', active: false, cron: '0 */15 * * * *', lastFiredAtMs: null, nextFireAtMs: null },
  },
  gitSync: { lastStatus: 'synced', lastSyncedAtMs: Date.now() - 60000, consecutiveErrorTicks: 0, headSha: '66a8834172be', lastPushed: ['superproject'], lastMerged: [], lastConflicts: [], lastErrors: [] },
  resolver: { model: 'opus:xhigh', lastStatus: 'ok', lastAtMs: Date.now() - 7200000, lastExitCode: 0, lastHttpStatus: 200, lastTimedOut: false, lastScopes: ['libs/generic/sync'] },
  openConflict: { scopes: ['libs/generic/sync'], conflicts: [{ scope: 'libs/generic/sync', files: ['src/x.ts'] }], emittedAtMs: Date.now() - 60000 },
  windows: {
    day: { sinceMs: 0, gitSync: { total: 100, synced: 60, nothing: 36, conflict: 3, error: 1 }, mergeResolver: { total: 3, ok: 2, failed: 1, error: 0 }, greenCheckpoint: { total: 24, advanced: 6, upToDate: 16, notGreen: 2, notFastForward: 0, createFailed: 0, advancedPrefix: 0, error: 0, skipped: 0, other: 0 }, deploy: { total: 6, ok: 5, rolledBack: 1, failed: 0, refused: 0 } },
    week: { sinceMs: 0, gitSync: { total: 700, synced: 400, nothing: 280, conflict: 15, error: 5 }, mergeResolver: { total: 15, ok: 13, failed: 2, error: 0 }, greenCheckpoint: { total: 160, advanced: 40, upToDate: 110, notGreen: 10, notFastForward: 0, createFailed: 0, advancedPrefix: 0, error: 0, skipped: 0, other: 0 }, deploy: { total: 38, ok: 36, rolledBack: 1, failed: 1, refused: 0 } },
  },
  recent: [
    { id: '3', kind: 'git_sync', status: 'conflict', detail: { conflicts: [{ scope: 'libs/generic/sync' }] }, createdAtMs: Date.now() - 7200000 },
    { id: '2', kind: 'merge_resolver', status: 'ok', detail: { scopes: ['libs/generic/sync'] }, createdAtMs: Date.now() - 7100000 },
    { id: '1', kind: 'green_checkpoint', status: 'advanced', detail: { candidate: '66a88341', green: true }, createdAtMs: Date.now() - 10800000 },
  ],
  deploy: {
    integrationBranch: 'main', releaseRef: 'ready',
    mainHead: { shortSha: 'aaaaaaaa', committedAtMs: Date.now(), subject: 'x' },
    ready: { shortSha: 'bbbbbbbb', committedAtMs: Date.now(), subject: 'y' },
    deployed: { shortSha: 'cccccccc', committedAtMs: Date.now(), subject: 'z' },
    deployedAtMs: Date.now() - 86400000, deployedBehindMain: 139, readyBehindMain: 139, deployedBehindReady: 0, readyAtMainHead: false, errors: [],
  },
  gate: {
    consecutiveReds: 2, lastGreenAtMs: Date.now() - 10800000, firstRedAtMs: Date.now() - 7200000, stalled: false,
    lastFixerStatus: 'ok', lastFixerAtMs: Date.now() - 3600000, lastFixerCandidate: '66a88341abcd',
    flakyWorkspaces: ['@papercusp/orchestrator'],
  },
};

let mockResult: Record<string, unknown> = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
// The per-hive section reads dev.gitPipelineHives (rows array, default empty).
let hivesResult: Record<string, unknown> = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName?: string }) =>
    opts?.queryName === 'dev.gitPipelineHives' ? hivesResult : mockResult,
  onSyncBusEvent: () => () => {},
}));

import GitClient from './GitClient';

afterEach(() => cleanup());

describe('GitClient', () => {
  it('shows verdict starvation separately from a small historical red streak', () => {
    mockResult = { data: [{ ...snapshot, gate: {
      ...snapshot.gate, consecutiveNoVerdict: 7,
      fireHistory: { windowHours: 24, fires: 74, verdictRecords: 0, noVerdictAborts: 7, skippedStarts: 46 },
      inconclusive: { status: 'dependency-prewarm-missing', detail: 'Waiting for the candidate dependency generation' },
    } }], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText('2 checkpoint(s)')).toBeTruthy();
    expect(screen.getByText('no verdict')).toBeTruthy();
    expect(screen.getByTestId('gate-fire-history').textContent).toContain('74 activation requests · 0 verdict records');
    expect(screen.getByTestId('gate-no-verdict-streak').textContent).toBe('7 consecutive abort(s)');
    expect(screen.getByTestId('gate-hold-duration').textContent).toBe('2h');
    expect(screen.getByTestId('gate-current-blocker').textContent).toBe('Waiting for the candidate dependency generation');
  });

  it('keeps missing measurements explicit for an older snapshot', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByTestId('gate-fire-history').textContent).toBe('not measured');
    expect(screen.getByTestId('gate-no-verdict-streak').textContent).toBe('not measured');
  });

  it('does not label a recorded red verdict green when its historical streak was reset', () => {
    mockResult = { data: [{ ...snapshot, gate: {
      ...snapshot.gate, consecutiveReds: 0, consecutiveNoVerdict: 0, recordedVerdict: 'not-green',
    } }], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText('held')).toBeTruthy();
  });

  it('renders pipeline stats, routines, the conflict banner, and the timeline', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);

    // Header + routines (the label appears in several sections — just assert present)
    expect(screen.getByText('Pipeline')).toBeTruthy();
    expect(screen.getAllByText('git-sync').length).toBeGreaterThan(0);
    expect(screen.getByText('green-checkpoint')).toBeTruthy();

    // The user's headline ask: a "merge conflicts" stat + the main-green rate.
    expect(screen.getByText('merge conflicts')).toBeTruthy();
    expect(screen.getByText('main-green rate')).toBeTruthy();

    // Open-conflict banner names the scope + the resolver model.
    expect(screen.getByText(/Open merge conflict/i)).toBeTruthy();
    expect(screen.getAllByText(/opus:xhigh/).length).toBeGreaterThan(0);

    // P-011: the green-checkpoint gate card surfaces the held/flaky state.
    expect(screen.getByText('green-checkpoint gate')).toBeTruthy();
    expect(screen.getByText('2 checkpoint(s)')).toBeTruthy();
    expect(screen.getByText('@papercusp/orchestrator')).toBeTruthy();

    // Timeline rendered the recent events.
    expect(screen.getByText('Recent events')).toBeTruthy();
  });

  it('renders the loading state without data', () => {
    mockResult = { data: [], loading: true, fetching: true, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText(/Loading pipeline/i)).toBeTruthy();
  });

  // gate-file-level-test-reuse-2026-09-27 P-013: the gate card's per-file reuse row.
  it('gate card: test reuse reads "not measured" when the snapshot carries no reuse record', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText('test reuse')).toBeTruthy();
    expect(screen.getByTestId('gate-test-pass-reuse').textContent).toBe('not measured');
  });

  it('gate card: test reuse shows the round headline, its sha, and an alarm pill', () => {
    const withReuse = {
      ...snapshot,
      gate: {
        ...snapshot.gate,
        testPassReuse: {
          judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4',
          headline: 'per-file reuse: 797 of 810 candidate file(s) reused, at least 15m 01s test time saved, 1 ALARM(s)',
          alarms: [{ ws: '@papercusp/operator-core', file: 'lib/x.test.ts', proof: 'expired' }],
        },
      },
    };
    mockResult = { data: [withReuse], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    const cell = screen.getByTestId('gate-test-pass-reuse');
    expect(cell.textContent).toContain('797 of 810 candidate file(s) reused');
    expect(cell.textContent).toContain('c5865549');
    expect(screen.getByText('1 reuse alarm(s)')).toBeTruthy();
  });

  it('gate card: round time reads "not measured" without a breakdown, and shows it when present (P-013)', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByTestId('gate-round-phases').textContent).toBe('not measured');
    cleanup();
    const breakdown = 'total 50m 00s: setup-tree 2m 00s (4%), candidate-suite 40m 00s (80%), other 8m 00s (16%)';
    mockResult = {
      data: [{ ...snapshot, gate: { ...snapshot.gate, roundPhases: { breakdown } } }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
      transport: 'POLL',
    };
    render(<GitClient />);
    expect(screen.getByTestId('gate-round-phases').textContent).toBe(breakdown);
  });

  // ── per-hive surface (P-014) ──
  it('per-hive section: empty state when no gated coding hives', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    hivesResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText(/Per-pot pipelines/i)).toBeTruthy();
    expect(screen.getByText(/No per-pot coding pipelines yet/i)).toBeTruthy();
  });

  it('per-hive section: renders a gated hive row with its green command, override badge, and gap', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    hivesResult = {
      data: [
        {
          slug: 'oddsmith-hive',
          root: '/h/oddsmith-hive',
          greenCmd: 'npm run gate:custom',
          greenCmdOverridden: true,
          integrationBranch: 'staging',
          releaseRef: 'main',
          hasDeploy: false,
          greenCheckpointActive: true,
          gateStatus: 'green',
          consecutiveReds: 0,
          lastGreenAtMs: Date.now() - 3_600_000,
          lastGreenSha: 'deadbeef0123',
          stagingMainGap: 4,
          lastDeployAtMs: null,
          lastDeployStatus: null,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
      transport: 'POLL',
    };
    render(<GitClient />);
    expect(screen.getByText('oddsmith-hive')).toBeTruthy();
    expect(screen.getByText(/npm run gate:custom/)).toBeTruthy();
    expect(screen.getByText('override')).toBeTruthy(); // owner-override badge
    expect(screen.getByText(/4 staging→main/)).toBeTruthy(); // staging↔main gap
    expect(screen.getByText(/🟩 deadbeef0123/)).toBeTruthy(); // last green sha
  });
});

// ── P-009: the GitHub-bridge pill helpers (github-bridge-hive-egress-2026-07-02) ──
describe('bridge pill helpers (P-009)', () => {
  const base = {
    atMs: 1,
    ran: true,
    skipped: null,
    egressTarget: 'fork',
    lastAdmitted: null,
    divergence: 'clear' as const,
    needsOwner: false,
    errors: 0,
    memberSlug: 'm',
  };

  it('no tick yet → neutral pill naming the mode', async () => {
    const { bridgeTone, bridgeLabel } = await import('./GitClient');
    expect(bridgeTone({ hiveGitMode: 'bridged', bridge: null })).toBe('neutral');
    expect(bridgeLabel({ hiveGitMode: 'bridged', bridge: null })).toBe('bridged · no tick yet');
  });

  it('clear tick → good, with the egress target', async () => {
    const { bridgeTone, bridgeLabel } = await import('./GitClient');
    const r = { hiveGitMode: 'bridged' as const, bridge: base };
    expect(bridgeTone(r)).toBe('good');
    expect(bridgeLabel(r)).toBe('bridged · in sync → fork');
  });

  it('escalated divergence → warn; owner-lever → bad', async () => {
    const { bridgeTone, bridgeLabel } = await import('./GitClient');
    const diverged = { ...base, divergence: 'escalate' as const };
    expect(bridgeTone({ hiveGitMode: 'bridged', bridge: diverged })).toBe('warn');
    expect(bridgeLabel({ hiveGitMode: 'bridged', bridge: diverged })).toBe('bridged · diverged → fork');
    const owner = { ...diverged, needsOwner: true };
    expect(bridgeTone({ hiveGitMode: 'p2p-only', bridge: owner })).toBe('bad');
    expect(bridgeLabel({ hiveGitMode: 'p2p-only', bridge: owner })).toBe('p2p-only · diverged · owner → fork');
  });

  it('tick errors without divergence → warn with the count; skipped egress drops the target', async () => {
    const { bridgeTone, bridgeLabel } = await import('./GitClient');
    const errs = { ...base, errors: 3, egressTarget: 'skipped' };
    expect(bridgeTone({ hiveGitMode: 'bridged', bridge: errs })).toBe('warn');
    expect(bridgeLabel({ hiveGitMode: 'bridged', bridge: errs })).toBe('bridged · 3 err');
  });
});
