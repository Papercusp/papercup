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
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => (key === 'hive' ? [selectedHive, vi.fn()] : ['24h', vi.fn()]),
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsString: { withDefault: () => ({}) },
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
    day: { sinceMs: 0, gitSync: { total: 100, synced: 60, nothing: 36, conflict: 3, error: 1 }, mergeResolver: { total: 3, ok: 2, failed: 1, error: 0 }, greenCheckpoint: { total: 24, advanced: 6, upToDate: 16, notGreen: 2, notFastForward: 0, createFailed: 0 }, deploy: { total: 6, ok: 5, rolledBack: 1, failed: 0, refused: 0 } },
    week: { sinceMs: 0, gitSync: { total: 700, synced: 400, nothing: 280, conflict: 15, error: 5 }, mergeResolver: { total: 15, ok: 13, failed: 2, error: 0 }, greenCheckpoint: { total: 160, advanced: 40, upToDate: 110, notGreen: 10, notFastForward: 0, createFailed: 0 }, deploy: { total: 38, ok: 36, rolledBack: 1, failed: 1, refused: 0 } },
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
}));

import GitClient from './GitClient';

afterEach(() => cleanup());

describe('GitClient', () => {
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

  // ── per-hive surface (P-014) ──
  it('per-hive section: empty state when no gated coding hives', () => {
    mockResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    hivesResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText(/Per-hive pipelines/)).toBeTruthy();
    expect(screen.getByText(/No per-hive coding pipelines yet/i)).toBeTruthy();
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
