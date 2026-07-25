import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * learning.gym resolver — the Learning tab's Gym view (operator-learning-tab P-006),
 * extended with the per-Hive lens (per-hive-learning-loops-2026-06-14 P-041): a
 * `hive` arg narrows the cross-harness rollup to ONE hive's gym harness. The gym
 * is scoped per (workspace_id, harness_slug) and the Hive home slug IS the gym
 * harness_slug, so the resolver threads `hive` straight through as `harnessSlug`
 * to the two control-plane readers. The readers themselves (the SQL `AND
 * harness_slug = …`) are covered at the control-plane/integration layer; here we
 * pin the resolver's arg threading + the workspace-wide default.
 *
 * WI-5802: there is NO cross-tenant fallback. A Hive-scoped read that comes back
 * empty returns EMPTY — it never silently substitutes the workspace-wide rollup.
 * The old WI-5420 behavior (fall back + flag `scopeFallback`) meant selecting the
 * Oddsmith pot rendered PAPERCUSP's gym experiments behind a muted note; showing
 * one tenant's data under another's lens is a correctness bug, so the fallback was
 * removed. See the scope-isolation describe block below.
 */

const listRecentProposalsForWorkspace = vi.fn();
const listAutoloopsForWorkspace = vi.fn();
const listScoutArchiveSeeds = vi.fn();
const listRecentCyclesForWorkspace = vi.fn();
const listRecentGymRunsForWorkspace = vi.fn();
vi.mock('../gym/control-plane', () => ({
  listRecentProposalsForWorkspace: (...a: unknown[]) => listRecentProposalsForWorkspace(...a),
  listAutoloopsForWorkspace: (...a: unknown[]) => listAutoloopsForWorkspace(...a),
  listScoutArchiveSeeds: (...a: unknown[]) => listScoutArchiveSeeds(...a),
  listRecentCyclesForWorkspace: (...a: unknown[]) => listRecentCyclesForWorkspace(...a),
  listRecentGymRunsForWorkspace: (...a: unknown[]) => listRecentGymRunsForWorkspace(...a),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

// routeWithWorkspace just hands the resolver a tx — run the callback with a stub.
vi.mock('../route-workspace', () => ({
  routeWithWorkspace: (fn: (tx: unknown) => Promise<unknown>) => fn({ tag: 'tx' }),
}));

import { resolveNamedQueryV2 } from './index';

beforeEach(() => {
  listRecentProposalsForWorkspace.mockReset().mockResolvedValue([]);
  listAutoloopsForWorkspace.mockReset().mockResolvedValue([]);
  listScoutArchiveSeeds.mockReset().mockResolvedValue([]);
  listRecentCyclesForWorkspace.mockReset().mockResolvedValue([]);
  listRecentGymRunsForWorkspace.mockReset().mockResolvedValue([]);
});

describe('learning.gym — per-Hive lens (P-041)', () => {
  it('threads the hive through as harnessSlug to BOTH control-plane readers', async () => {
    await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' });
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50, harnessSlug: 'my-hive' },
    );
    expect(listAutoloopsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', harnessSlug: 'my-hive' },
    );
    expect(listScoutArchiveSeeds).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', harnessSlug: 'my-hive' },
    );
  });

  it('omits harnessSlug entirely with no hive (cross-harness workspace rollup)', async () => {
    await resolveNamedQueryV2('learning.gym', {});
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50 },
    );
    expect(listAutoloopsForWorkspace).toHaveBeenCalledWith({ tag: 'tx' }, { workspaceId: 'ws-test' });
    expect(listScoutArchiveSeeds).toHaveBeenCalledWith({ tag: 'tx' }, { workspaceId: 'ws-test' });
  });

  it('returns the 1-element { proposals, autoloops, archiveSeeds, cycles } snapshot', async () => {
    listRecentProposalsForWorkspace.mockResolvedValue([{ id: 'p1' }]);
    listAutoloopsForWorkspace.mockResolvedValue([{ harnessSlug: 'my-hive' }]);
    listScoutArchiveSeeds.mockResolvedValue([{ candidateId: 'SP-002' }]);
    listRecentCyclesForWorkspace.mockResolvedValue([{ harnessSlug: 'my-hive', cycle: 1 }]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' })) as Array<{
      proposals: unknown[];
      autoloops: unknown[];
      archiveSeeds: unknown[];
      cycles: unknown[];
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].autoloops).toEqual([{ harnessSlug: 'my-hive' }]);
    expect(rows[0].archiveSeeds).toEqual([{ candidateId: 'SP-002' }]);
    expect(rows[0].cycles).toEqual([{ harnessSlug: 'my-hive', cycle: 1 }]);
  });

  it('threads the hive through to the recent-cycles reader too (WI-5685)', async () => {
    await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' });
    expect(listRecentCyclesForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 20, harnessSlug: 'my-hive' },
    );
  });

  it('recent-cycles read failure degrades to [] (WI-5685) — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listRecentCyclesForWorkspace.mockRejectedValue(new Error('no durable tables'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ cycles: unknown[] }>;
    expect(rows[0].cycles).toEqual([]);
    warn.mockRestore();
  });

  it('archive-seed read failure degrades to [] (WI-5412) — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listScoutArchiveSeeds.mockRejectedValue(new Error('no archive table'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ archiveSeeds: unknown[] }>;
    expect(rows[0].archiveSeeds).toEqual([]);
    warn.mockRestore();
  });
});

describe('learning.gym — scope isolation: NO cross-tenant fallback (WI-5802)', () => {
  it('an empty Hive-scoped read stays EMPTY — it never substitutes another pot\'s data', async () => {
    // The workspace HAS data, but none of it is scoped to this hive. Pre-WI-5802
    // the resolver returned that other data flagged `scopeFallback` — which is how
    // selecting Oddsmith rendered papercusp's gym experiments (owner report).
    listRecentProposalsForWorkspace
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p1', harnessSlug: 'gymloopharness' }]);

    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'oddsmith-hive' })) as Array<{
      proposals: unknown[];
      scopeFallback?: boolean;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].proposals).toEqual([]);
    expect(rows[0].scopeFallback).toBeUndefined();
    // THE INVARIANT: exactly ONE read, the scoped one. A second (unscoped) call is
    // the cross-tenant leak itself — it must not happen.
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledTimes(1);
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50, harnessSlug: 'oddsmith-hive' },
    );
  });

  it('a Hive-scoped read with its OWN data returns it, unflagged', async () => {
    listRecentProposalsForWorkspace.mockResolvedValueOnce([{ id: 'p1' }]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'papercusp' })) as Array<{
      proposals: unknown[];
      scopeFallback?: boolean;
    }>;
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].scopeFallback).toBeUndefined();
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledTimes(1);
  });

  it('no hive arg ⇒ the deliberate workspace-wide rollup (unchanged)', async () => {
    listRecentProposalsForWorkspace.mockResolvedValueOnce([{ id: 'p1' }]);
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{
      proposals: unknown[];
      scopeFallback?: boolean;
    }>;
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].scopeFallback).toBeUndefined();
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe('learning.gym — recent RUN activity (WI-5801)', () => {
  it('threads the hive through to the runs reader and returns it on the snapshot', async () => {
    listRecentGymRunsForWorkspace.mockResolvedValue([
      { harnessSlug: 'gymloopharness', variantId: 'baseline', cycle: 0, runCount: 3 },
    ]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' })) as Array<{
      runs: unknown[];
      generatedAt?: string;
    }>;
    expect(listRecentGymRunsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 20, harnessSlug: 'my-hive' },
    );
    expect(rows[0].runs).toEqual([
      { harnessSlug: 'gymloopharness', variantId: 'baseline', cycle: 0, runCount: 3 },
    ]);
    // WI-5803: every snapshot carries its generation time so the UI can stamp it.
    expect(typeof rows[0].generatedAt).toBe('string');
  });

  it('runs read failure degrades to [] — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listRecentGymRunsForWorkspace.mockRejectedValue(new Error('no durable tables'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ runs: unknown[] }>;
    expect(rows[0].runs).toEqual([]);
    warn.mockRestore();
  });
});
