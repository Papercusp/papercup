/**
 * join-state-reconcile.test.ts — boot-time join self-heal (P-013). All IO
 * seam-injected (join-state lister, registry, path-exists) — no filesystem/PG.
 * Asserts the split: registered joins are left to boot-all (cosmetic record);
 * only an unregistered clone-on-disk is re-registered; no-clone is abandoned.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  reconcileJoinStates,
  ensureJoinStatesReconciledOnce,
  __resetJoinStateReconcileForTests,
} from './join-state-reconcile';
import type { HarnessRegistry } from '../harness-registry';
import type { JoinState } from './join-shared-harness';

const js = (slug: string, cloneDir?: string): JoinState =>
  ({
    slug,
    linkTopic: 't',
    steps: {} as JoinState['steps'],
    startedAt: 0,
    ...(cloneDir ? { cloneDir } : {}),
  }) as JoinState;

function fakes(states: JoinState[], registered: string[], onDisk: string[]) {
  const calls = { registry: registered.map((slug) => ({ slug, path: `/r/${slug}` })) as HarnessRegistry['projects'] };
  return {
    calls,
    opts: {
      workspaceId: 'ws',
      listJoinStates: async () => states,
      loadRegistry: async () => ({ projects: calls.registry }),
      mutateRegistry: (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
        calls.registry = fn({ projects: calls.registry }).projects;
        return undefined as never;
      }) as never,
      pathExists: (p: string) => onDisk.some((d) => p === d),
    },
  };
}

describe('reconcileJoinStates (P-013)', () => {
  it('registered join → healedByBoot, NOT re-registered (boot-all federates it; record is cosmetic)', async () => {
    const { opts, calls } = fakes([js('shop', '/clones/shop')], ['shop'], ['/clones/shop']);
    const r = await reconcileJoinStates(opts);
    expect(r.healedByBoot).toEqual(['shop']);
    expect(r.reregistered).toEqual([]);
    expect(calls.registry.map((p) => p.slug)).toEqual(['shop']); // unchanged
  });

  it('unregistered clone STILL ON DISK → re-registered (the residual boot-all cannot heal)', async () => {
    const { opts, calls } = fakes([js('ghost', '/clones/ghost')], [], ['/clones/ghost']);
    const r = await reconcileJoinStates(opts);
    expect(r.reregistered).toEqual(['ghost']);
    // Re-registered in the full link-joined shape (WI-10003277), not a bare row.
    expect(calls.registry).toContainEqual({
      slug: 'ghost',
      path: '/clones/ghost',
      joined_via_link: true,
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    });
  });

  it('WI-10003277: completes a registered link-joined row an older build left short', async () => {
    const { opts, calls } = fakes([], [], []);
    const shortRow = {
      slug: 'papercusp',
      path: '/clones/papercup',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
    };
    const owned = { slug: 'mine', path: '/r/mine' };
    calls.registry = [shortRow, owned];
    const r = await reconcileJoinStates(opts);
    expect(r.enriched).toEqual(['papercusp']);
    expect(calls.registry).toEqual([
      { ...shortRow, harness_kind: 'hive', remote_hive: true, self_repo: true },
      owned, // not link-joined: never stamped
    ]);
  });

  it('WI-10003277: no registry write when every link-joined row is already complete', async () => {
    const full = {
      slug: 'papercusp',
      path: '/clones/papercup',
      joined_via_link: true,
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    };
    let writes = 0;
    const r = await reconcileJoinStates({
      workspaceId: 'ws',
      listJoinStates: async () => [],
      loadRegistry: async () => ({ projects: [full] }),
      mutateRegistry: (async () => {
        writes += 1;
        return undefined as never;
      }) as never,
    });
    expect(r.enriched).toEqual([]);
    expect(writes).toBe(0);
  });

  it('unregistered + no clone dir on disk → abandoned, reported (nothing to re-drive)', async () => {
    const { opts, calls } = fakes([js('vanished', '/clones/vanished')], [], []);
    const r = await reconcileJoinStates(opts);
    expect(r.abandoned).toEqual(['vanished']);
    expect(r.reregistered).toEqual([]);
    expect(calls.registry).toEqual([]);
  });

  it('a join-state with no cloneDir at all → abandoned (no tree to federate)', async () => {
    const { opts } = fakes([js('nocdir')], [], []);
    const r = await reconcileJoinStates(opts);
    expect(r.abandoned).toEqual(['nocdir']);
  });

  it('mixed batch is split correctly', async () => {
    const { opts } = fakes(
      [js('reg', '/clones/reg'), js('ghost', '/clones/ghost'), js('gone', '/clones/gone')],
      ['reg'],
      ['/clones/reg', '/clones/ghost'],
    );
    const r = await reconcileJoinStates(opts);
    expect(r.healedByBoot).toEqual(['reg']);
    expect(r.reregistered).toEqual(['ghost']);
    expect(r.abandoned).toEqual(['gone']);
  });

  it('idempotent: a second pass over a now-registered ghost reports healedByBoot', async () => {
    const { opts } = fakes([js('ghost', '/clones/ghost')], [], ['/clones/ghost']);
    const r1 = await reconcileJoinStates(opts);
    expect(r1.reregistered).toEqual(['ghost']);
    const r2 = await reconcileJoinStates(opts); // registry now carries ghost
    expect(r2.reregistered).toEqual([]);
    expect(r2.healedByBoot).toEqual(['ghost']);
  });

  it('a lister failure folds into result.error, never throws', async () => {
    const r = await reconcileJoinStates({
      workspaceId: 'ws',
      listJoinStates: async () => {
        throw new Error('readdir boom');
      },
      loadRegistry: async () => ({ projects: [] }),
    });
    expect(r.error).toMatch(/readdir boom/);
    expect(r.reregistered).toEqual([]);
  });
});

describe('ensureJoinStatesReconciledOnce (boot trigger)', () => {
  it('runs once per process when seams are injected (repeat calls no-op)', async () => {
    __resetJoinStateReconcileForTests();
    const lists: number[] = [];
    const seams = {
      listJoinStates: async () => {
        lists.push(1);
        return [];
      },
      loadRegistry: async () => ({ projects: [] }),
    };
    ensureJoinStatesReconciledOnce('ws', seams);
    ensureJoinStatesReconciledOnce('ws', seams);
    await vi.waitFor(() => expect(lists).toHaveLength(1)); // ran exactly once
  });

  it('no-ops under vitest WITHOUT seams (the boot-wiring guard — never touches real FS)', async () => {
    __resetJoinStateReconcileForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // No seams → the default lister would read ~/.papercusp/join-state; the
      // guard must skip entirely (no log, no warn, no real-FS read).
      ensureJoinStatesReconciledOnce('ws');
      await new Promise((r) => setTimeout(r, 5));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
