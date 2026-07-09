/**
 * own-log-fork-ei.test.ts — P-003 (WI-3535).
 *
 * Durable EI escalation for own-log-fork episodes: the stable dedup title,
 * the VITEST-without-deps safety gate (never touches production PG from a
 * unit test), the dedup-against-an-open-EI behavior, and
 * `resolveOwnLogForkEi`'s multi-match auto-resolve. Mirrors
 * replication-liveness.test.ts's "durable EI escalation" describe block for
 * replication-stall-ei.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileOwnLogForkEi,
  resolveOwnLogForkEi,
  ownLogForkEiTitle,
  OWN_LOG_FORK_TOPIC,
  RECOVERY_OWNER,
  _resetOwnLogForkEiForTests,
  type OwnLogForkEiDeps,
} from '../own-log-fork-ei';
import type { OwnLogForkEpisode } from '../own-log-fork-guard';

const WS = 'ws-1';
const HS = 'harness-a';
const KEY = 'c'.repeat(64);

const episode: OwnLogForkEpisode = {
  workspaceId: WS,
  harnessSlug: HS,
  keyHex: KEY,
  detail: '[hypercore] conflict detected in own log — two conflicting signatures for length 5',
};

afterEach(() => {
  _resetOwnLogForkEiForTests();
});

function fakeDeps(open: Array<{ id?: string; title: string }>): {
  deps: OwnLogForkEiDeps;
  created: Array<{ title: string; body: string }>;
  resolved: Array<{ id: string; note: string }>;
} {
  const created: Array<{ title: string; body: string }> = [];
  const resolved: Array<{ id: string; note: string }> = [];
  return {
    created,
    resolved,
    deps: {
      listOpenByTopic: async () => open.map((o) => ({ id: o.id ?? 'EI-OPEN', title: o.title })),
      create: async (input) => {
        created.push({ title: input.title, body: input.body });
        return { id: 'EI-999' };
      },
      resolve: async (id, note) => {
        resolved.push({ id, note });
      },
    },
  };
}

describe('ownLogForkEiTitle', () => {
  it('is stable and dedup-able for the same (harness, key)', () => {
    expect(ownLogForkEiTitle(episode)).toBe(ownLogForkEiTitle({ ...episode }));
  });

  it('differs for a different harness or key', () => {
    expect(ownLogForkEiTitle(episode)).not.toBe(
      ownLogForkEiTitle({ ...episode, harnessSlug: 'harness-b' }),
    );
    expect(ownLogForkEiTitle(episode)).not.toBe(
      ownLogForkEiTitle({ ...episode, keyHex: 'd'.repeat(64) }),
    );
  });
});

describe('fileOwnLogForkEi', () => {
  it('files a critical bug EI on the own-log-fork topic with the stable dedup title', async () => {
    const { deps, created } = fakeDeps([]);
    const id = await fileOwnLogForkEi(episode, deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe(ownLogForkEiTitle(episode));
  });

  it('the EI body names the supported recovery and explicitly says rekeyHarness does NOT fix it', async () => {
    const { deps, created } = fakeDeps([]);
    await fileOwnLogForkEi(episode, deps);
    const body = created[0]!.body;
    expect(body).toContain('STORE RESET');
    expect(body).toContain('rekeyHarness');
    expect(body).toContain('does NOT fix this');
    expect(body).toContain('FLAGS.OWN_LOG_FORK_AUTO_RECOVERY');
  });

  it('dedupes against an already-open EI with the same title', async () => {
    const { deps, created } = fakeDeps([{ title: ownLogForkEiTitle(episode) }]);
    const id = await fileOwnLogForkEi(episode, deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a DIFFERENT key for the same harness is a separate escalation (not deduped)', async () => {
    const { deps, created } = fakeDeps([{ title: ownLogForkEiTitle(episode) }]);
    const other = { ...episode, keyHex: 'e'.repeat(64) };
    const id = await fileOwnLogForkEi(other, deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
  });

  it('the VITEST safety gate returns null WITHOUT calling real deps when deps is omitted', async () => {
    // process.env.VITEST is set by the vitest runner itself; no deps passed here.
    const id = await fileOwnLogForkEi(episode);
    expect(id).toBeNull();
  });

  it('per-process in-flight guard prevents a concurrent double-file racing the same title', async () => {
    const { deps, created } = fakeDeps([]);
    let resolveCreate!: (v: { id: string }) => void;
    let createCalls = 0;
    const createPromise = new Promise<{ id: string }>((resolve) => {
      resolveCreate = resolve;
    });
    deps.create = async (input) => {
      createCalls += 1;
      created.push({ title: input.title, body: input.body });
      return createPromise;
    };
    // Started synchronously back-to-back: fileOwnLogForkEi's `inFlight.add(title)`
    // runs BEFORE its first await, so p2 sees the guard already set the instant
    // it's called — no tick-flushing needed for the dedup itself.
    const p1 = fileOwnLogForkEi(episode, deps);
    const p2 = fileOwnLogForkEi(episode, deps); // races p1 before it resolves
    // p1 still needs a couple microtask ticks to get PAST its `await
    // listOpenByTopic(...)` and reach the pending `d.create(...)` call before
    // `resolveCreate` is assigned — flush those before resolving it.
    await Promise.resolve();
    await Promise.resolve();
    resolveCreate({ id: 'EI-999' });
    const [id1, id2] = await Promise.all([p1, p2]);
    expect(createCalls).toBe(1);
    expect([id1, id2].filter((v) => v === 'EI-999')).toHaveLength(1);
    expect([id1, id2].filter((v) => v === null)).toHaveLength(1);
  });

  it('a create() failure is swallowed (best-effort) and returns null', async () => {
    const { deps } = fakeDeps([]);
    deps.create = async () => {
      throw new Error('pg down');
    };
    const id = await fileOwnLogForkEi(episode, deps);
    expect(id).toBeNull();
  });
});

describe('resolveOwnLogForkEi', () => {
  it('resolves the matching open EI with a recovery note referencing the resolver identity', async () => {
    const title = ownLogForkEiTitle(episode);
    const { deps, resolved } = fakeDeps([{ id: 'EI-100', title }]);
    const ids = await resolveOwnLogForkEi(
      { harnessSlug: HS, keyHex: KEY, detail: 'store reset at /tmp/x' },
      deps,
    );
    expect(ids).toEqual(['EI-100']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.note).toContain('store reset');
    expect(RECOVERY_OWNER).toBe('system:own-log-fork-guard');
  });

  it('resolves ALL duplicate open EIs matching the title, not just the first (EI-6772 class)', async () => {
    const title = ownLogForkEiTitle(episode);
    const { deps, resolved } = fakeDeps([
      { id: 'EI-100', title },
      { id: 'EI-101', title },
    ]);
    const ids = await resolveOwnLogForkEi({ harnessSlug: HS, keyHex: KEY, detail: 'reset' }, deps);
    expect(ids.sort()).toEqual(['EI-100', 'EI-101']);
    expect(resolved).toHaveLength(2);
  });

  it('no-ops when no open EI matches the title', async () => {
    const { deps, resolved } = fakeDeps([]);
    const ids = await resolveOwnLogForkEi({ harnessSlug: HS, keyHex: KEY, detail: 'reset' }, deps);
    expect(ids).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('a DIFFERENT key for the same harness does not resolve an unrelated open EI', async () => {
    const otherTitle = ownLogForkEiTitle({ ...episode, keyHex: 'f'.repeat(64) });
    const { deps, resolved } = fakeDeps([{ id: 'EI-100', title: otherTitle }]);
    const ids = await resolveOwnLogForkEi({ harnessSlug: HS, keyHex: KEY, detail: 'reset' }, deps);
    expect(ids).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('the VITEST safety gate returns [] WITHOUT calling real deps when deps is omitted', async () => {
    const ids = await resolveOwnLogForkEi({ harnessSlug: HS, keyHex: KEY, detail: 'reset' });
    expect(ids).toEqual([]);
  });

  it('a per-EI resolve failure does not strand its siblings (best-effort)', async () => {
    const title = ownLogForkEiTitle(episode);
    const { deps, resolved } = fakeDeps([
      { id: 'EI-100', title },
      { id: 'EI-101', title },
    ]);
    deps.resolve = async (id, note) => {
      if (id === 'EI-100') throw new Error('resolve boom');
      resolved.push({ id, note });
    };
    const ids = await resolveOwnLogForkEi({ harnessSlug: HS, keyHex: KEY, detail: 'reset' }, deps);
    expect(ids).toEqual(['EI-101']);
  });

  it('OWN_LOG_FORK_TOPIC is the stable topic constant used for dedup listing', () => {
    expect(OWN_LOG_FORK_TOPIC).toBe('own-log-fork');
  });
});
