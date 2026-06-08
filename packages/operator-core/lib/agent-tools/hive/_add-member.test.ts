/**
 * addHarnessToHive / removeHarnessFromHive — the Hive membership producer
 * (shared-hive-federation P-004 follow-up / D-010 gap). Hermetic via injected
 * registry seams.
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

function harness(projects: ProjectEntry[]): { seams: AddHiveMemberSeams; current: () => HarnessRegistry } {
  let reg: HarnessRegistry = { projects };
  return {
    seams: {
      loadRegistry: async () => reg,
      saveRegistry: async (r) => {
        reg = r;
      },
    },
    current: () => reg,
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
