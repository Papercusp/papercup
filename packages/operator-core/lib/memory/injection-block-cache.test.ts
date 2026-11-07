import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache } from '@papercusp/cache';

const { notifySyncInvalidateMock, control } = vi.hoisted(() => ({
  notifySyncInvalidateMock: vi.fn(),
  control: { generation: 1, applied: 'identity-1', scope: 'task-1', unavailable: false },
}));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: async () => control.unavailable ? [] : [{ ...control }] }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: notifySyncInvalidateMock }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-memory' }));

import { tagsForTableChange } from '../events/cache-eca-rule';
import { invalidateUserMemoryViews, USER_MEMORY_SYNC_KEYS } from './invalidate-user-memory-views';
import { setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import {
  getMemoryBlockBounded as rawBlock,
  getMemoryBlockBoundedResult as rawResult,
  MEMORY_CANONICAL_CACHE_TAG,
  type MemoryBlockBuildContext,
} from './injection-block-cache';

// Existing deadline/SWR cases hold query and authorization constant. Query
// changes are exercised explicitly below, through the same production cache.
const retrieval = { principalId: 'user-1', queryText: 'same query', authorizationScope: 'owner' };
const getMemoryBlockBounded: typeof rawBlock = (ws, key, build, opts) =>
  rawBlock(ws, key, build, { retrieval, ...opts });
const getMemoryBlockBoundedResult: typeof rawResult = (ws, key, build, opts) =>
  rawResult(ws, key, build, { retrieval, ...opts });

it('context reliability: unrelated query and authority generations cannot reuse a block', async () => {
  const cache = createCache();
  let version = 0;
  const build = vi.fn(async () => `block-${++version}`);
  setSessionConfinementResolver(() => null);
  control.generation = 1;
  control.unavailable = false;
  const opts = { cache, sessionId: 'session-1', softTtlMs: Infinity, retrieval };
  try {
    expect(await rawBlock('ws', 'conversation-1', build, opts)).toBe('block-1');
    expect(await rawBlock('ws', 'conversation-1', build, { ...opts,
      retrieval: { ...retrieval, queryText: ' same\n query ' } })).toBe('block-1');
    for (const changed of [
      { ...retrieval, queryText: 'unrelated query' },
      { ...retrieval, taskContext: 'different task' },
      { ...retrieval, principalId: 'user-2' },
      { ...retrieval, authorizationScope: 'public' },
    ]) expect(await rawBlock('ws', 'conversation-1', build, { ...opts, retrieval: changed })).toBe(`block-${version}`);
    expect(build).toHaveBeenCalledTimes(5);
    control.generation++;
    expect(await rawBlock('ws', 'conversation-1', build, opts)).toBe('block-6');
    control.applied = 'identity-2';
    expect(await rawBlock('ws', 'conversation-1', build, opts)).toBe('block-7');
    control.scope = 'task-2';
    expect(await rawBlock('ws', 'conversation-1', build, opts)).toBe('block-8');
    expect(await rawBlock('other-ws', 'conversation-1', build, opts)).toBe('block-9');
    expect(await rawBlock('ws', 'conversation-2', build, opts)).toBe('block-10');
    control.unavailable = true;
    expect(await rawResult('ws', 'conversation-1', build, opts)).toEqual({ status: 'error', block: null });
    expect(build).toHaveBeenCalledTimes(10);
  } finally {
    control.unavailable = false;
    setSessionConfinementResolver(undefined);
  }
});

it('does not reuse a rendered block when a caller omits retrieval identity', async () => {
  const cache = createCache();
  const build = vi.fn().mockResolvedValueOnce('old query').mockResolvedValueOnce('new query');
  expect(await rawBlock('ws', 'conversation-1', build, { cache })).toBe('old query');
  expect(await rawBlock('ws', 'conversation-1', build, { cache })).toBe('new query');
});

it('bounds the initial host-policy read before starting a build', async () => {
  vi.useFakeTimers();
  setSessionConfinementResolver(() => new Promise(() => {}));
  const build = vi.fn(async () => 'must not build');
  try {
    const pending = rawResult('ws', 'conversation-1', build, {
      cache: createCache(), retrieval, sessionId: 'policy-stalled', deadlineMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toEqual({ status: 'deadline', block: null });
    expect(build).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); setSessionConfinementResolver(undefined); }
});

it('fences a source change during a build and never joins the obsolete flight', async () => {
  const cache = createCache();
  let finish!: (text: string) => void;
  const pending = rawResult('ws', 'conversation-1', () => new Promise<string>(resolve => { finish = resolve; }),
    { cache, retrieval, softTtlMs: Infinity });
  cache.invalidateByTag('ws', MEMORY_CANONICAL_CACHE_TAG);
  expect(await rawBlock('ws', 'conversation-1', async () => 'current source',
    { cache, retrieval, softTtlMs: Infinity })).toBe('current source');
  finish('obsolete source');
  expect(await pending).toEqual({ status: 'error', block: null });
  expect(await rawBlock('ws', 'conversation-1', async () => 'unexpected rebuild',
    { cache, retrieval, softTtlMs: Infinity })).toBe('current source');
});

/** A controllable build: counts calls, resolves/rejects on demand. */
function controlledBuild(block: string | null = '## Operator memory') {
  let calls = 0;
  const releases: Array<{ resolve: (v: string | null) => void; reject: (e: Error) => void }> = [];
  const build = (): Promise<string | null> => {
    calls += 1;
    return new Promise<string | null>((resolve, reject) => {
      releases.push({ resolve, reject });
    });
  };
  return {
    build,
    calls: () => calls,
    resolveAll: () => {
      for (const r of releases.splice(0)) r.resolve(block);
    },
    rejectAll: (e: Error) => {
      for (const r of releases.splice(0)) r.reject(e);
    },
  };
}

it('does not serve a previously cached live block after the host imposes frozen context', async () => {
  const cache = createCache(), build = vi.fn(async () => 'LIVE SECRET');
  const opts = { cache, sessionId: 'su-frozen' };
  setSessionConfinementResolver(() => null);
  try {
    expect(await getMemoryBlockBounded('private', 'turn-start:su-frozen', build, opts)).toBe('LIVE SECRET');
    build.mockClear();
    setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['coord:whoami'],
      denyAmbientContext: true, reason: 'frozen benchmark', imposedBy: 'host' }));
    expect(await getMemoryBlockBounded('private', 'turn-start:su-frozen', build, opts)).toBeNull();
    expect(build).not.toHaveBeenCalled();
  } finally { setSessionConfinementResolver(undefined); }
});

describe('getMemoryBlockBounded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cold miss under the deadline returns the built block and caches it', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild('BLOCK');
    const p = getMemoryBlockBounded('ws', 'papercup:u1:c1', under.build, { cache, deadlineMs: 2000 });
    under.resolveAll();
    await expect(p).resolves.toBe('BLOCK');
    expect(under.calls()).toBe(1);
  });

  it('cold miss past the deadline resolves null this turn, and the in-flight build serves the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild('LATE-BLOCK');
    const p = getMemoryBlockBounded('ws', 'papercup:u1:c1', under.build, { cache, deadlineMs: 2000 });
    await vi.advanceTimersByTimeAsync(2001);
    await expect(p).resolves.toBeNull();
    expect(under.calls()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded the 2000ms prompt-build deadline'));

    // The abandoned single-flight build completes and lands in cache…
    under.resolveAll();
    await vi.advanceTimersByTimeAsync(0);
    // …so the next turn serves it instantly (stale — soft TTL 0), while a
    // background revalidate runs with THIS turn's query.
    const next = controlledBuild('NEXT-BLOCK');
    await expect(
      getMemoryBlockBounded('ws', 'papercup:u1:c1', next.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBe('LATE-BLOCK');
    expect(next.calls()).toBe(1); // background revalidate with the new query
  });

  it('EI-22676212457824880: a deadline-abandoned build is served as `ready` on the next turn of the same scope', async () => {
    // Discriminator for the production warning "omitting the section this turn; the
    // in-flight build will serve the next one": H1 (designed SWR path — turn 2 gets the
    // block) vs H2 (turn 2 starved — null again). Same scopeKey both turns, as
    // converse-prompt.ts builds it per conversation.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    const turn1 = controlledBuild('LATE-BLOCK');
    const p1 = getMemoryBlockBoundedResult('ws', 'papercup:u1:c1', turn1.build, { cache, deadlineMs: 2000 });
    await vi.advanceTimersByTimeAsync(2001);
    await expect(p1).resolves.toEqual({ status: 'deadline', block: null });

    turn1.resolveAll();
    await vi.advanceTimersByTimeAsync(0);

    const turn2 = controlledBuild('TURN2-BLOCK');
    await expect(
      getMemoryBlockBoundedResult('ws', 'papercup:u1:c1', turn2.build, { cache, deadlineMs: 2000 }),
    ).resolves.toEqual({ status: 'ready', block: 'LATE-BLOCK' });
    expect(turn1.calls()).toBe(1);
    expect(turn2.calls()).toBe(1); // background revalidate, not a blocking rebuild
  });

  it('keeps a deadline distinct from a completed empty build for delivery metrics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild('LATE-BLOCK');
    const p = getMemoryBlockBoundedResult('ws', 'turn-start:s1', under.build, {
      cache,
      deadlineMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(2001);
    await expect(p).resolves.toEqual({ status: 'deadline', block: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded the 2000ms prompt-build deadline'));

    const empty = controlledBuild(null);
    const p2 = getMemoryBlockBoundedResult('ws', 'turn-start:s2', empty.build, {
      cache,
      deadlineMs: 2000,
    });
    empty.resolveAll();
    await expect(p2).resolves.toEqual({ status: 'ready', block: null });
  });

  it('serves the previous turn instantly and pipelines the current query (soft TTL 0)', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const turn1 = controlledBuild('V1');
    const p1 = getMemoryBlockBounded('ws', 'papercup:u1:c1', turn1.build, { cache, deadlineMs: 2000 });
    turn1.resolveAll();
    await expect(p1).resolves.toBe('V1');

    // Turn 2: instant stale serve of V1; V2 builds in the background.
    const turn2 = controlledBuild('V2');
    await expect(
      getMemoryBlockBounded('ws', 'papercup:u1:c1', turn2.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBe('V1');
    expect(turn2.calls()).toBe(1);
    turn2.resolveAll();
    await vi.advanceTimersByTimeAsync(0);

    // Turn 3 sees V2.
    const turn3 = controlledBuild('V3');
    await expect(
      getMemoryBlockBounded('ws', 'papercup:u1:c1', turn3.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBe('V2');
  });

  // WI-10004485 step D: a client wall must bound a build step only while someone
  // still waits on the build. The build learns that from callerWaiting().
  it('tells the build whether its caller still waits: yes on a cold miss, no once a stale serve answered it', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const seen: Array<() => boolean> = [];
    let release: ((v: string | null) => void) | undefined;
    const build = (_deadline: unknown, ctx: MemoryBlockBuildContext): Promise<string | null> => {
      seen.push(ctx.callerWaiting);
      return new Promise<string | null>((resolve) => { release = resolve; });
    };
    // Turn 1, cold: the caller waits while the build runs, and stops once answered.
    const p1 = getMemoryBlockBoundedResult('ws', 'turn-start:o1', build, { cache, deadlineMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!()).toBe(true);
    release!('V1');
    await expect(p1).resolves.toEqual({ status: 'ready', block: 'V1' });
    expect(seen[0]!()).toBe(false);
    // Turn 2: the stale V1 answers at once, so the revalidate waits on nobody.
    await expect(getMemoryBlockBoundedResult('ws', 'turn-start:o1', build, { cache, deadlineMs: 2000 }))
      .resolves.toEqual({ status: 'ready', block: 'V1' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!()).toBe(false);
    release!('V2');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a cold build past the caller wait cap no longer has a caller waiting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    let waiting: (() => boolean) | undefined;
    let release: ((v: string | null) => void) | undefined;
    const p = getMemoryBlockBoundedResult('ws', 'turn-start:o2', (_d: unknown, ctx: MemoryBlockBuildContext) => {
      waiting = ctx.callerWaiting;
      return new Promise<string | null>((resolve) => { release = resolve; });
    }, { cache, deadlineMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting!()).toBe(true);
    await vi.advanceTimersByTimeAsync(2001);
    await expect(p).resolves.toEqual({ status: 'deadline', block: null });
    expect(waiting!()).toBe(false);
    release!(null);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a build failure resolves null (section omitted) and never rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild();
    const p = getMemoryBlockBounded('ws', 'papercup:u1:c1', under.build, { cache, deadlineMs: 2000 });
    under.rejectAll(new Error('store down'));
    await expect(p).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('block build failed (omitting the section):'),
      'store down',
    );
  });

  it('caches a null (no-hits / degraded) block so the store is not re-probed on the blocking path', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild(null);
    const p = getMemoryBlockBounded('ws', 'papercup:u1:c1', under.build, { cache, deadlineMs: 2000 });
    under.resolveAll();
    await expect(p).resolves.toBeNull();
    // Next turn: instant null (stale serve), background revalidate — never a blocking probe.
    const next = controlledBuild(null);
    await expect(
      getMemoryBlockBounded('ws', 'papercup:u1:c1', next.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBeNull();
    expect(next.calls()).toBe(1);
  });

  it('keys by scope — different conversations never share stale recall', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const a = controlledBuild('A');
    const b = controlledBuild('B');
    const pa = getMemoryBlockBounded('ws', 'papercup:u1:conv-a', a.build, { cache, deadlineMs: 2000 });
    const pb = getMemoryBlockBounded('ws', 'papercup:u1:conv-b', b.build, { cache, deadlineMs: 2000 });
    a.resolveAll();
    b.resolveAll();
    await expect(pa).resolves.toBe('A');
    await expect(pb).resolves.toBe('B');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it('rebuilds the cached prompt block after the cache-ECA reports a canonical memory change', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const old = controlledBuild('SUPERSEDED MEMORY');
    const initial = getMemoryBlockBounded('ws', 'papercup:u1:c1', old.build, { cache, deadlineMs: 2000 });
    old.resolveAll();
    await expect(initial).resolves.toBe('SUPERSEDED MEMORY');

    // This is the same table tag the generic `*.changed` cache-ECA derives from
    // harness_shared.memory_canonical.changed when memory writes publish it.
    cache.invalidateByTags('ws', tagsForTableChange(MEMORY_CANONICAL_CACHE_TAG, undefined));

    const current = controlledBuild('CURRENT MEMORY');
    const afterWrite = getMemoryBlockBounded('ws', 'papercup:u1:c1', current.build, { cache, deadlineMs: 2000 });
    current.resolveAll();
    await expect(afterWrite).resolves.toBe('CURRENT MEMORY');
    expect(old.calls()).toBe(1);
    expect(current.calls()).toBe(1);
  });

  it('publishes memory writes as cross-process cache-ECA changes while keeping the sync views live', async () => {
    notifySyncInvalidateMock.mockReset().mockResolvedValue(undefined);

    await invalidateUserMemoryViews();

    expect(notifySyncInvalidateMock).toHaveBeenCalledWith(
      'harness_shared.memory_canonical.changed',
      { workspace_id: 'ws-memory' },
      undefined,
      { dedupeWindowMs: 0 },
    );
    for (const key of USER_MEMORY_SYNC_KEYS) {
      expect(notifySyncInvalidateMock).toHaveBeenCalledWith(key);
    }
  });
});
