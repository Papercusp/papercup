/**
 * leave-hive.test.ts — joiner-side hive LEAVE (shared-hive-hardening-2026-06-13
 * P-012), the inverse of joinHiveAsView. All four teardown legs (close
 * federation / delete routine / drop presence / deregister) + clone removal are
 * seam-injected — no PG, swarm, or filesystem.
 */
import { describe, it, expect } from 'vitest';
import { leaveHive, type LeaveHiveDeps } from './leave-hive';
import type { HarnessRegistry } from '../harness-registry';
import type { Sql } from 'postgres';

const HIVE = (slug: string) => ({
  slug,
  path: `/remote-hives/${slug}`,
  harness_kind: 'hive' as const,
  remote_hive: true,
});
const MEMBER = (slug: string, hive_slug: string) => ({
  slug,
  path: `/clones/${slug}`,
  hive_slug,
  github_repository_id: slug.length,
});

function fakes(initialProjects: HarnessRegistry['projects']) {
  const calls = {
    registry: [...initialProjects] as HarnessRegistry['projects'],
    tombstoned: [] as string[],
    closed: [] as string[],
    routinesRemoved: [] as string[],
    presenceDropped: [] as string[],
    rmDirs: [] as string[],
    /** interleaved op log to assert tombstone precedes close per member. */
    order: [] as string[],
  };
  const deps: LeaveHiveDeps = {
    loadRegistry: async () => ({ projects: calls.registry }),
    mutateRegistry: (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
      calls.registry = fn({ projects: calls.registry }).projects;
      return undefined as never;
    }) as never,
    sql: {} as Sql,
    tombstonePresence: async (_ws, slug) => {
      calls.tombstoned.push(slug);
      calls.order.push(`tombstone:${slug}`);
      return true;
    },
    closeHandle: async (_ws, slug) => {
      calls.closed.push(slug);
      calls.order.push(`close:${slug}`);
      return true;
    },
    removeRoutine: async (_sql, slug) => {
      calls.routinesRemoved.push(slug);
      return true;
    },
    dropPresence: async (_sql, _ws, slug) => {
      calls.presenceDropped.push(slug);
      return 1;
    },
    rmDir: async (p) => {
      calls.rmDirs.push(p);
    },
  };
  return { deps, calls };
}

describe('leaveHive (P-012)', () => {
  it('full hive leave: stops federation, deletes routines, drops presence, deregisters view + members', async () => {
    const { deps, calls } = fakes([
      HIVE('shop-hive'),
      MEMBER('shop', 'shop-hive'),
      MEMBER('docs', 'shop-hive'),
      { slug: 'papercup', path: '/papercup' }, // an unrelated local harness — untouched
    ]);
    const res = await leaveHive({ workspaceId: 'ws', slug: 'shop-hive' }, deps);

    expect(res.ok).toBe(true);
    expect(res.viewSlug).toBe('shop-hive');
    expect(res.viewRemoved).toBe(true);
    expect(res.members.map((m) => m.slug).sort()).toEqual(['docs', 'shop']);
    expect(
      res.members.every(
        (m) => m.presenceTombstoned && m.federationClosed && m.routineRemoved && m.presenceRowsDropped === 1,
      ),
    ).toBe(true);

    // members closed (+ the view, for symmetry); routines + presence dropped per member.
    expect(calls.tombstoned.sort()).toEqual(['docs', 'shop']);
    expect(calls.closed.sort()).toEqual(['docs', 'shop', 'shop-hive']);
    expect(calls.routinesRemoved.sort()).toEqual(['docs', 'shop']);
    expect(calls.presenceDropped.sort()).toEqual(['docs', 'shop']);
    // EI-469: each member's tombstone is published BEFORE its handle closes.
    expect(calls.order.indexOf('tombstone:shop')).toBeLessThan(calls.order.indexOf('close:shop'));
    expect(calls.order.indexOf('tombstone:docs')).toBeLessThan(calls.order.indexOf('close:docs'));
    // registry: view + members gone, the unrelated harness kept.
    expect(calls.registry.map((p) => p.slug)).toEqual(['papercup']);
  });

  it('leaving by a member slug resolves + leaves the whole hive', async () => {
    const { deps, calls } = fakes([HIVE('h'), MEMBER('a', 'h'), MEMBER('b', 'h')]);
    const res = await leaveHive({ workspaceId: 'ws', slug: 'a' }, deps);
    expect(res.ok).toBe(true);
    expect(res.viewSlug).toBe('h');
    expect(res.members.map((m) => m.slug).sort()).toEqual(['a', 'b']);
    expect(calls.registry).toEqual([]);
  });

  it('idempotent: leaving an already-left hive is a no-op ok', async () => {
    const { deps } = fakes([{ slug: 'papercup', path: '/papercup' }]);
    const res = await leaveHive({ workspaceId: 'ws', slug: 'gone-hive' }, deps);
    expect(res).toMatchObject({ ok: true, alreadyLeft: true });
    expect(res.members).toEqual([]);
  });

  it('re-runs a partial leave: orphaned members (view already removed) are still torn down', async () => {
    // A prior leave removed the view but died before the members — slug names
    // the view that no longer exists; orphaned members still carry hive_slug.
    const { deps, calls } = fakes([MEMBER('a', 'gone-hive'), MEMBER('b', 'gone-hive')]);
    const res = await leaveHive({ workspaceId: 'ws', slug: 'gone-hive' }, deps);
    expect(res.ok).toBe(true);
    expect(res.members.map((m) => m.slug).sort()).toEqual(['a', 'b']);
    expect(calls.routinesRemoved.sort()).toEqual(['a', 'b']);
    expect(calls.registry).toEqual([]);
  });

  it('deleteClones rm -rf the member clone dirs + the view dir', async () => {
    const { deps, calls } = fakes([HIVE('h'), MEMBER('a', 'h')]);
    await leaveHive({ workspaceId: 'ws', slug: 'h', deleteClones: true }, deps);
    expect(calls.rmDirs.sort()).toEqual(['/clones/a', '/remote-hives/h']);
  });

  it('keeps clone dirs by default (re-joinable)', async () => {
    const { deps, calls } = fakes([HIVE('h'), MEMBER('a', 'h')]);
    const res = await leaveHive({ workspaceId: 'ws', slug: 'h' }, deps);
    expect(calls.rmDirs).toEqual([]);
    expect(res.members[0].cloneDeleted).toBeUndefined();
  });

  it('refuses a local-owned harness (not a joined hive) and points to hive:dissolve', async () => {
    const { deps, calls } = fakes([{ slug: 'my-local', path: '/local' }]);
    const res = await leaveHive({ workspaceId: 'ws', slug: 'my-local' }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hive:dissolve/);
    // nothing torn down
    expect(calls.closed).toEqual([]);
    expect(calls.registry.map((p) => p.slug)).toEqual(['my-local']);
  });

  it('best-effort: a leg that throws does not abort the others', async () => {
    const { deps, calls } = fakes([HIVE('h'), MEMBER('a', 'h'), MEMBER('b', 'h')]);
    deps.closeHandle = async (_ws, slug) => {
      if (slug === 'a') throw new Error('swarm boom');
      calls.closed.push(slug);
      return true;
    };
    const res = await leaveHive({ workspaceId: 'ws', slug: 'h' }, deps);
    expect(res.ok).toBe(true);
    // 'a' close threw → federationClosed:false, but its routine + presence still ran.
    const a = res.members.find((m) => m.slug === 'a')!;
    expect(a.federationClosed).toBe(false);
    expect(a.routineRemoved).toBe(true);
    expect(calls.routinesRemoved.sort()).toEqual(['a', 'b']);
    expect(calls.registry).toEqual([]);
  });
});
