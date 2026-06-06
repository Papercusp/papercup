// @vitest-environment jsdom
//
// GitClient render coverage — mounts the /admin Git tab against a realistic
// dev.gitPipeline snapshot (useSyncQuery + nuqs mocked) and asserts the stats,
// the open-conflict banner, and the timeline render. Guards against render-time
// crashes the build/typecheck can't catch (null derefs in the JSX).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// nuqs: useQueryState needs the adapter context — stub it to a plain ['24h', noop].
vi.mock('nuqs', () => ({
  useQueryState: () => ['24h', vi.fn()],
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
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
    day: { sinceMs: 0, gitSync: { total: 100, synced: 60, nothing: 36, conflict: 3, error: 1 }, mergeResolver: { total: 3, ok: 2, failed: 1, error: 0 }, greenCheckpoint: { total: 24, advanced: 6, upToDate: 16, notGreen: 2, notFastForward: 0, createFailed: 0 } },
    week: { sinceMs: 0, gitSync: { total: 700, synced: 400, nothing: 280, conflict: 15, error: 5 }, mergeResolver: { total: 15, ok: 13, failed: 2, error: 0 }, greenCheckpoint: { total: 160, advanced: 40, upToDate: 110, notGreen: 10, notFastForward: 0, createFailed: 0 } },
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
};

let mockResult: Record<string, unknown> = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'POLL' };
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => mockResult }));

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

    // Timeline rendered the recent events.
    expect(screen.getByText('Recent events')).toBeTruthy();
  });

  it('renders the loading state without data', () => {
    mockResult = { data: [], loading: true, fetching: true, error: null, invalidate: vi.fn(), transport: 'POLL' };
    render(<GitClient />);
    expect(screen.getByText(/Loading pipeline/i)).toBeTruthy();
  });
});
