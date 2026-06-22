/**
 * join-leave-roundtrip.test.ts — the inverse property (shared-hive-hardening
 * P-012): joinHiveAsView followed by leaveHive returns the registry + routine
 * store to baseline. Both orchestrations run for real over ONE shared in-memory
 * registry + routine store; only the leaf IO (per-link join, git-sync seed,
 * federation close, routine delete, presence drop) is seam-injected — no PG,
 * git, swarm, or filesystem.
 *
 * A true cross-machine join→leave is gated on real hardware (plan D-003); this
 * is the deterministic single-process equivalent that proves the composition.
 */
import { describe, it, expect } from 'vitest';
import { joinHiveAsView, type JoinHiveDeps } from './join-hive';
import { leaveHive, type LeaveHiveDeps } from './leave-hive';
import type { HarnessRegistry } from '../harness-registry';
import type { Sql } from 'postgres';

const TOPIC = 'a'.repeat(64);
const link = (repo: string, id: number) =>
  `papercusp://harness?topic=${TOPIC}&github=acme%2F${repo}&repo_id=${id}`;

/** A shared world: one registry + one routine store, mutated by BOTH orchestrations. */
function world(initial: HarnessRegistry['projects'] = []) {
  const state = {
    registry: [...initial] as HarnessRegistry['projects'],
    routines: new Set<string>(), // install slugs with a git-sync routine row
    closed: [] as string[],
    presenceDropped: [] as string[],
  };
  const loadRegistry = async () => ({ projects: state.registry });
  const mutateRegistry = (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
    state.registry = fn({ projects: state.registry }).projects;
    return undefined as never;
  }) as never;

  const joinDeps: JoinHiveDeps = {
    joinLink: async ({ slug }) => {
      state.registry.push({ slug, path: `/clones/${slug}` });
      return { ok: true, detail: 'joined' };
    },
    loadRegistry,
    mutateRegistry,
    ensureDir: async () => {},
    remoteHivesRoot: '/remote-hives',
    seedGitSync: async (opts) => {
      state.routines.add(opts.installSlug);
      return { seeded: true, active: true, push: false, pushReason: 'joiner', cron: '0 0 * * * *' };
    },
  };

  const leaveDeps: LeaveHiveDeps = {
    loadRegistry,
    mutateRegistry,
    sql: {} as Sql,
    tombstonePresence: async () => true, // hermetic — don't touch the real boot handle map
    sleep: async () => {}, // skip the EI-469 drain wait in the hermetic round-trip
    closeHandle: async (_ws, slug) => {
      state.closed.push(slug);
      return true;
    },
    removeRoutine: async (_sql, slug) => state.routines.delete(slug),
    dropPresence: async (_sql, _ws, slug) => {
      state.presenceDropped.push(slug);
      return 1;
    },
    // G27 leave PASS-1.5 (hive_members membership-drop) was added to leaveHive AFTER
    // this hermetic test was written. Stub its deps so the round-trip doesn't run the
    // real `pg(sql).unsafe(...)` DELETE against the empty `sql: {}` mock (which threw →
    // `[leaveHive] … teardown failed` console.warn → vitest-fail-on-console). Production
    // passes a real postgres-js Sql with `.unsafe`; this is a test-only dep gap.
    resolveLeaverGithubUserId: async () => 1,
    dropMembers: async () => 1,
    rmDir: async () => {},
  };

  return { state, joinDeps, leaveDeps };
}

describe('join → leave round-trip (P-012 inverse property)', () => {
  it('leaveHive undoes exactly what joinHiveAsView built — registry + routines back to baseline', async () => {
    const { state, joinDeps, leaveDeps } = world();

    // ── JOIN ──
    const joined = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      joinDeps,
    );
    expect(joined.ok).toBe(true);
    const viewSlug = joined.hiveSlug!;
    // After join: a remote_hive view + 2 members (with hive_slug) + 2 routines.
    expect(state.registry.find((p) => p.slug === viewSlug)).toMatchObject({ remote_hive: true });
    expect(state.registry.filter((p) => p.hive_slug === viewSlug).map((p) => p.slug).sort()).toEqual([
      'docs',
      'shop',
    ]);
    expect([...state.routines].sort()).toEqual(['docs', 'shop']);

    // ── LEAVE ──
    const left = await leaveHive({ workspaceId: 'ws', slug: viewSlug }, leaveDeps);
    expect(left.ok).toBe(true);
    expect(left.viewRemoved).toBe(true);
    expect(left.members.map((m) => m.slug).sort()).toEqual(['docs', 'shop']);

    // Everything join created is gone: view + members deregistered, routines
    // deleted, federation closed + presence dropped for each member.
    expect(state.registry).toEqual([]);
    expect(state.routines.size).toBe(0);
    expect(state.closed.sort()).toEqual(['docs', 'shop', viewSlug]);
    expect(state.presenceDropped.sort()).toEqual(['docs', 'shop']);
  });

  it('a pre-existing LOCAL harness survives a join+leave of an unrelated hive', async () => {
    const { state, joinDeps, leaveDeps } = world([{ slug: 'my-local', path: '/local' }]);

    const joined = await joinHiveAsView(
      { hiveId: 'far-hive', memberLinks: [link('far', 300)], workspaceId: 'ws' },
      joinDeps,
    );
    await leaveHive({ workspaceId: 'ws', slug: joined.hiveSlug! }, leaveDeps);

    // The local harness is untouched; the joined hive is fully gone.
    expect(state.registry).toEqual([{ slug: 'my-local', path: '/local' }]);
    expect(state.routines.size).toBe(0);
  });

  it('leave is idempotent: a second leave after a clean leave is a no-op ok', async () => {
    const { state, joinDeps, leaveDeps } = world();
    const joined = await joinHiveAsView(
      { hiveId: 'h', memberLinks: [link('a', 1)], workspaceId: 'ws' },
      joinDeps,
    );
    const first = await leaveHive({ workspaceId: 'ws', slug: joined.hiveSlug! }, leaveDeps);
    expect(first.ok).toBe(true);
    const second = await leaveHive({ workspaceId: 'ws', slug: joined.hiveSlug! }, leaveDeps);
    expect(second).toMatchObject({ ok: true, alreadyLeft: true });
    expect(state.registry).toEqual([]);
  });
});
