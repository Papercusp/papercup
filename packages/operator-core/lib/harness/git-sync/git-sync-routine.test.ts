/**
 * git-sync-routine — the routine-input `branch` extension + the member seeding
 * composition `seedGitSyncRoutineForMember` (git-sync-any-hive-2026-06-12
 * P-001/P-008 seed side).
 *
 * db-org is mocked (upsertRoutine captured; getOrgPg never reached — every
 * seeding test injects `deps.sql`), so no PG. The push decision runs B-02's
 * REAL decider against an injected permissions probe; eligibility runs the
 * REAL verdict with entries whose disk checks are bypassed via injection where
 * needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { ProjectEntry } from '../../harness-registry';

const upsertRoutineMock = vi.fn(async (_sql: unknown, input: Record<string, unknown>) => ({
  id: `rt_${input.installSlug}_${input.name}`,
  ...input,
}));
vi.mock('@papercusp/db-org', () => ({
  upsertRoutine: (...a: unknown[]) => upsertRoutineMock(a[0], a[1] as Record<string, unknown>),
  setRoutineActive: vi.fn(async () => true),
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject deps.sql in tests');
  },
}));

import {
  upsertGitSyncRoutine,
  seedGitSyncRoutineForMember,
  DEFAULT_GIT_SYNC_CRON,
  GIT_SYNC_TARGET,
  type SeedGitSyncRoutineDeps,
} from './git-sync-routine';
import { gitSyncCronForKey, GIT_SYNC_SEED_ACTIVE_CREATOR, GIT_SYNC_SEED_ACTIVE_JOINER } from './git-sync-eligibility';

const fakeSql = {} as Sql;

const memberEntry = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  slug: 'shop',
  path: '/clones/shop',
  hive_slug: 'shop-hive',
  github_remote: 'https://github.com/acme/shop.git',
  github_default_branch: 'develop',
  ...over,
});

/** Seams: eligible entry, no existing row, probe answers `permission`. */
function seedDeps(over: Partial<SeedGitSyncRoutineDeps> = {}) {
  const probeCalls: Array<{ owner: string; repo: string }> = [];
  const deps: SeedGitSyncRoutineDeps = {
    sql: fakeSql,
    eligibility: () => ({ eligible: true }),
    getRoutine: vi.fn(async () => null),
    fetchPushPermission: async (owner: string, repo: string) => {
      probeCalls.push({ owner, repo });
      return true;
    },
    ...over,
  };
  return { deps, probeCalls };
}

beforeEach(() => {
  upsertRoutineMock.mockClear();
});

describe('upsertGitSyncRoutine — the `branch` extension', () => {
  it('writes branch into trigger_config.branch (read by configFromTrigger)', async () => {
    await upsertGitSyncRoutine(fakeSql, {
      workspaceId: 'ws',
      installSlug: 'shop',
      branch: 'develop',
    });
    expect(upsertRoutineMock).toHaveBeenCalledTimes(1);
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws',
      installSlug: 'shop',
      targetRole: GIT_SYNC_TARGET,
      triggerConfig: {
        cron: DEFAULT_GIT_SYNC_CRON,
        push: true,
        push_submodules: true,
        branch: 'develop',
      },
      active: false,
    });
  });

  it('omits the branch key entirely when not given (existing defaults intact)', async () => {
    await upsertGitSyncRoutine(fakeSql, { workspaceId: 'ws', installSlug: 'shop' });
    const cfg = (upsertRoutineMock.mock.calls[0][1] as { triggerConfig: Record<string, unknown> }).triggerConfig;
    expect('branch' in cfg).toBe(false);
  });
});

describe('seedGitSyncRoutineForMember (P-001/P-008 seed side)', () => {
  it('seeds an eligible creator-side member: jittered cron, ACTIVE, push from probe→decider, branch from the entry', async () => {
    const { deps, probeCalls } = seedDeps();
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws-1', installSlug: 'shop', entry: memberEntry(), joinerSide: false },
      deps,
    );
    expect(out).toEqual({
      seeded: true,
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
      push: true,
      pushReason: expect.stringContaining('github_permissions_push_true'),
      cron: gitSyncCronForKey('shop'),
      branch: 'develop',
    });
    // the probe got the parsed owner/repo from the registry github_remote
    expect(probeCalls).toEqual([{ owner: 'acme', repo: 'shop' }]);
    expect(upsertRoutineMock).toHaveBeenCalledTimes(1);
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-1',
      installSlug: 'shop',
      active: true,
      triggerConfig: { cron: gitSyncCronForKey('shop'), push: true, branch: 'develop' },
    });
  });

  it('probe says NO push → routine seeds push:false (B-02 rule 3)', async () => {
    const { deps } = seedDeps({ fetchPushPermission: async () => false });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry() },
      deps,
    );
    expect(out).toMatchObject({ seeded: true, push: false, pushReason: expect.stringContaining('github_permissions_push_false') });
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({ triggerConfig: { push: false } });
  });

  it('unknown permission (probe null) → optimistic push:true (B-02 rule 5)', async () => {
    const { deps } = seedDeps({ fetchPushPermission: async () => null });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry() },
      deps,
    );
    expect(out).toMatchObject({ seeded: true, push: true, pushReason: expect.stringContaining('permissions_unknown_optimistic') });
  });

  it('no registry github_remote → push:false (no_upstream_remote) and the probe is NEVER called', async () => {
    const { deps, probeCalls } = seedDeps();
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'local-only', entry: memberEntry({ slug: 'local-only', github_remote: undefined, github_default_branch: undefined }) },
      deps,
    );
    expect(out).toEqual({
      seeded: true,
      active: true,
      push: false,
      pushReason: expect.stringContaining('no_upstream_remote'),
      cron: gitSyncCronForKey('local-only'),
    });
    expect(probeCalls).toEqual([]);
    expect('branch' in (upsertRoutineMock.mock.calls[0][1] as { triggerConfig: Record<string, unknown> }).triggerConfig).toBe(false);
  });

  it('joinerSide seeds INACTIVE + push:false (joiner_side) without probing', async () => {
    const { deps, probeCalls } = seedDeps();
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry(), joinerSide: true },
      deps,
    );
    expect(out).toMatchObject({
      seeded: true,
      active: GIT_SYNC_SEED_ACTIVE_JOINER,
      push: false,
      pushReason: expect.stringContaining('joiner_side'),
    });
    expect(probeCalls).toEqual([]);
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({ active: false });
  });

  it('cronKey salts the jitter key (B-03 joiner-side per-install salt); default stays installSlug', async () => {
    const { deps } = seedDeps();
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws-1', installSlug: 'shop', entry: memberEntry(), joinerSide: true, cronKey: 'shop:ws-1' },
      deps,
    );
    // 'shop' hashes to offset 7, 'shop:ws-1' to offset 3 — the salt really moves the schedule
    expect(out).toMatchObject({ seeded: true, cron: gitSyncCronForKey('shop:ws-1') });
    expect(gitSyncCronForKey('shop:ws-1')).not.toBe(gitSyncCronForKey('shop'));
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({
      triggerConfig: { cron: gitSyncCronForKey('shop:ws-1') },
    });
  });

  it('an INELIGIBLE entry reports the reason and touches neither PG nor the probe', async () => {
    const getRoutine = vi.fn(async () => null);
    const { deps, probeCalls } = seedDeps({ eligibility: undefined, getRoutine });
    // real eligibility: a hive home — and the verdict comes BEFORE deps.sql/getRoutine
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'home', entry: memberEntry({ harness_kind: 'hive' }) },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'ineligible', ineligibleReason: 'hive_home' });
    expect(getRoutine).not.toHaveBeenCalled();
    expect(probeCalls).toEqual([]);
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });

  it('an EXISTING routine row is never clobbered: routine_exists, no upsert (idempotent re-add)', async () => {
    const { deps } = seedDeps({
      getRoutine: vi.fn(async () => ({ id: 'rt_x', active: true } as never)),
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry() },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'routine_exists' });
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });

  it('NEVER throws — an exploding upsert folds into { reason: error }', async () => {
    const { deps } = seedDeps({
      upsert: vi.fn(async () => {
        throw new Error('routines table on fire');
      }),
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry() },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'error', message: 'routines table on fire' });
  });

  it('a throwing PROBE also folds into { reason: error } (the seam is best-effort by contract, but the seeder still guards)', async () => {
    const { deps } = seedDeps({
      fetchPushPermission: async () => {
        throw new Error('octokit melted');
      },
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry() },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'error', message: 'octokit melted' });
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });
});

describe('coords-aware upgrade carve-out (the from-repo double-seed ordering)', () => {
  /** Exactly what a coords-less creator-side seed writes (create.ts step 5a):
   *  active per the creator split, push:false (no_upstream_remote), submodules
   *  on, no branch, the slug-jittered cron — the only row shape the carve-out
   *  may upgrade. `over`/`cfgOver` deviate one field to simulate a human edit. */
  const machineDefaultRow = (
    slug: string,
    over: Record<string, unknown> = {},
    cfgOver: Record<string, unknown> = {},
  ) =>
    ({
      id: `rt_${slug}_git-sync`,
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
      triggerConfig: {
        cron: gitSyncCronForKey(slug),
        push: false,
        push_submodules: true,
        ...cfgOver,
      },
      ...over,
    }) as never;

  it('UPGRADES an untouched machine-default coords-less row when the creator re-seed brings coords: probed push + branch land, outcome surfaces upgraded', async () => {
    const { deps, probeCalls } = seedDeps({
      getRoutine: vi.fn(async () => machineDefaultRow('shop')),
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws-1', installSlug: 'shop', entry: memberEntry(), joinerSide: false },
      deps,
    );
    expect(out).toEqual({
      seeded: true,
      upgraded: true,
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
      push: true,
      pushReason: expect.stringContaining('github_permissions_push_true'),
      cron: gitSyncCronForKey('shop'),
      branch: 'develop',
    });
    // The upgrade really probed (the routine_exists path never reaches the probe)…
    expect(probeCalls).toEqual([{ owner: 'acme', repo: 'shop' }]);
    // …and the rewrite carries the probed push + the clone's default branch.
    expect(upsertRoutineMock).toHaveBeenCalledTimes(1);
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-1',
      installSlug: 'shop',
      active: true,
      triggerConfig: { cron: gitSyncCronForKey('shop'), push: true, branch: 'develop' },
    });
  });

  it('a human edit — active flipped OFF — kills the upgrade: routine_exists, zero writes, no probe', async () => {
    const { deps, probeCalls } = seedDeps({
      getRoutine: vi.fn(async () => machineDefaultRow('shop', { active: false })),
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry(), joinerSide: false },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'routine_exists' });
    expect(probeCalls).toEqual([]);
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });

  it('a human edit — custom cron — kills the upgrade: routine_exists, zero writes', async () => {
    const { deps } = seedDeps({
      getRoutine: vi.fn(async () => machineDefaultRow('shop', {}, { cron: '0 5 * * * *' })),
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry(), joinerSide: false },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'routine_exists' });
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });

  it('a coords-LESS re-seed over the same machine-default row carries no more information: routine_exists', async () => {
    const { deps, probeCalls } = seedDeps({
      getRoutine: vi.fn(async () => machineDefaultRow('local-only')),
    });
    const out = await seedGitSyncRoutineForMember(
      {
        workspaceId: 'ws',
        installSlug: 'local-only',
        entry: memberEntry({ slug: 'local-only', github_remote: undefined, github_default_branch: undefined }),
        joinerSide: false,
      },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'routine_exists' });
    expect(probeCalls).toEqual([]);
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });

  it('a JOINER-side re-seed never upgrades — even a row that would otherwise qualify stays routine_exists', async () => {
    const { deps, probeCalls } = seedDeps({
      getRoutine: vi.fn(async () => machineDefaultRow('shop')),
    });
    const out = await seedGitSyncRoutineForMember(
      { workspaceId: 'ws', installSlug: 'shop', entry: memberEntry(), joinerSide: true },
      deps,
    );
    expect(out).toEqual({ seeded: false, reason: 'routine_exists' });
    expect(probeCalls).toEqual([]);
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });
});
