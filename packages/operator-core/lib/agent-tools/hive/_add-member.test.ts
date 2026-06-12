/**
 * addHarnessToHive / removeHarnessFromHive — the Hive membership producer
 * (shared-hive-federation P-004 follow-up / D-010 gap). Hermetic via injected
 * registry seams; the git-sync-any-hive B-01 routine seeding rides an injected
 * `seedGitSyncRoutine` seam (the default lazy-imports the real seeder, whose
 * eligibility check front-runs any PG access).
 */

import { describe, it, expect } from 'vitest';
import { addHarnessToHive, removeHarnessFromHive, type AddHiveMemberSeams } from './_add-member';
import type { HarnessRegistry, ProjectEntry } from '../../harness-registry';

const WS = 'ws';

function base(): ProjectEntry[] {
  return [
    { slug: 'my-hive', path: '/h', harness_kind: 'hive' },
    { slug: 'repo-a', path: '/a' },
    { slug: 'repo-b', path: '/b' },
    { slug: 'other-hive', path: '/oh', harness_kind: 'hive' },
  ];
}

function harness(projects: ProjectEntry[]): {
  seams: AddHiveMemberSeams;
  current: () => HarnessRegistry;
  seeds: Array<Record<string, unknown>>;
} {
  let reg: HarnessRegistry = { projects };
  const seeds: Array<Record<string, unknown>> = [];
  return {
    seams: {
      loadRegistry: async () => reg,
      saveRegistry: async (r) => {
        reg = r;
      },
      seedGitSyncRoutine: async (o) => {
        seeds.push(o as unknown as Record<string, unknown>);
        return { seeded: true, active: true, push: false, pushReason: 'no_upstream_remote — faked', cron: '0 1,11,21,31,41,51 * * * *' };
      },
    },
    current: () => reg,
    seeds,
  };
}

const slug = (reg: HarnessRegistry, s: string) => reg.projects.find((p) => p.slug === s);

describe('addHarnessToHive', () => {
  it('sets hive_slug on a member harness', async () => {
    const { seams, current } = harness(base());
    const r = await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' }, seams);
    expect(r).toMatchObject({ ok: true, changed: true, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' });
    expect(slug(current(), 'repo-a')?.hive_slug).toBe('my-hive');
  });

  it('is idempotent — re-adding to the same hive is a no-op success', async () => {
    const projects = base();
    slug({ projects }, 'repo-a')!.hive_slug = 'my-hive';
    const { seams } = harness(projects);
    expect(await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' }, seams)).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it('rejects an unknown hive / harness', async () => {
    const { seams } = harness(base());
    expect(await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'ghost', memberHarnessSlug: 'repo-a' }, seams)).toMatchObject({ ok: false, error: 'hive_not_found' });
    expect(await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'ghost' }, seams)).toMatchObject({ ok: false, error: 'harness_not_found' });
  });

  it('refuses to nest a Hive home as a member, and refuses self', async () => {
    const { seams } = harness(base());
    expect(await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'other-hive' }, seams)).toMatchObject({ ok: false, error: 'is_hive_home' });
    expect(await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'my-hive' }, seams)).toMatchObject({ ok: false, error: 'self' });
  });

  it('refuses a harness already a member of a different hive', async () => {
    const projects = base();
    slug({ projects }, 'repo-a')!.hive_slug = 'other-hive';
    const { seams } = harness(projects);
    expect(await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' }, seams)).toMatchObject({
      ok: false,
      error: 'already_member_elsewhere',
    });
  });

  // ── git-sync-any-hive B-01: member routine seeding rides the add ─────────────

  it('a successful add seeds the member git-sync routine (creator side) and reports the outcome', async () => {
    const { seams, seeds } = harness(base());
    const r = await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' }, seams);
    expect(r.ok).toBe(true);
    expect(seeds).toEqual([
      {
        workspaceId: WS,
        installSlug: 'repo-a',
        joinerSide: false,
        entry: expect.objectContaining({ slug: 'repo-a', path: '/a', hive_slug: 'my-hive' }),
      },
    ]);
    expect(r.gitSync).toMatchObject({ seeded: true, push: false });
  });

  it('the idempotent re-add ALSO consults the seeder (heals a missing routine; the seeder itself skips an existing row)', async () => {
    const projects = base();
    slug({ projects }, 'repo-a')!.hive_slug = 'my-hive';
    const { seams, seeds } = harness(projects);
    const r = await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' }, seams);
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(seeds).toHaveLength(1);
    expect(r.gitSync).toBeDefined();
  });

  it('failed adds never reach the seeder', async () => {
    const { seams, seeds } = harness(base());
    await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'ghost', memberHarnessSlug: 'repo-a' }, seams);
    await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'ghost' }, seams);
    await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'other-hive' }, seams);
    await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'my-hive' }, seams);
    expect(seeds).toEqual([]);
  });

  it('a THROWING seed seam never fails the add — folded into { reason: error }', async () => {
    const { seams, current } = harness(base());
    seams.seedGitSyncRoutine = async () => {
      throw new Error('pg exploded');
    };
    const r = await addHarnessToHive({ workspaceId: WS, hiveHomeSlug: 'my-hive', memberHarnessSlug: 'repo-a' }, seams);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.gitSync).toEqual({ seeded: false, reason: 'error', message: 'pg exploded' });
    expect(slug(current(), 'repo-a')?.hive_slug).toBe('my-hive'); // the membership write held
  });
});

describe('removeHarnessFromHive', () => {
  it('clears hive_slug (idempotent)', async () => {
    const projects = base();
    slug({ projects }, 'repo-a')!.hive_slug = 'my-hive';
    const { seams, current } = harness(projects);
    expect(await removeHarnessFromHive({ workspaceId: WS, memberHarnessSlug: 'repo-a' }, seams)).toMatchObject({ ok: true, changed: true });
    expect(slug(current(), 'repo-a')?.hive_slug).toBeUndefined();
    expect(await removeHarnessFromHive({ workspaceId: WS, memberHarnessSlug: 'repo-a' }, seams)).toMatchObject({ ok: true, changed: false });
  });

  it('rejects an unknown harness', async () => {
    const { seams } = harness(base());
    expect(await removeHarnessFromHive({ workspaceId: WS, memberHarnessSlug: 'ghost' }, seams)).toMatchObject({ ok: false, error: 'harness_not_found' });
  });
});
