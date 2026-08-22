/**
 * agent-state-stamp.test.ts — P-009's per-owner declaration cache
 * (unified-agent-state-plane-2026-07-27).
 *
 * The contract under test is narrow but load-bearing: this cache is read on
 * EVERY tool call (~238,866/day), so it must never throw, never block, and never
 * hand back a pointer that names something other than what it named when it was
 * written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  noteIntentDeclared,
  noteAssumptionAsserted,
  noteGoalClaimed,
  clearGoalClaimedIfMatches,
  readAgentStateStamp,
  resetAgentStateStamps,
  agentStateStampSize,
  setAgentGoalRehydrator,
  setAgentIntentRehydrator,
} from './agent-state-stamp';

const OWNER = 'su-8d9a671c';
const OTHER = 'su-2846407f';

beforeEach(() => resetAgentStateStamps());

describe('readAgentStateStamp — the hot-path read', () => {
  it('returns all-nulls for an owner that never declared anything', () => {
    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
  });

  it('returns all-nulls (never throws) for an unattributable caller', () => {
    // buildTelemetryRow passes `coordOwnerId`, which is null whenever
    // resolveAgentIdentity throws. Telemetry is best-effort: a missing identity
    // must degrade to three NULL columns, never to an exception on the dispatch
    // path.
    expect(readAgentStateStamp(null)).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
    expect(readAgentStateStamp(undefined)).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
    expect(readAgentStateStamp('')).toEqual({
      intentEventId: null,
      assumptionSetId: null,
      goalRef: null,
    });
  });

  it('exposes EXACTLY the three stamp keys — no internal bookkeeping leaks out', () => {
    // Regression: the cache first carried an LRU `seq` counter on the stored
    // object, so every reader got a fourth field it never asked for. Harmless
    // for buildTelemetryRow (it reads three named fields) but a real leak for
    // anything that serialises or compares the stamp — and the recency order the
    // counter duplicated is already carried by the Map's insertion order.
    noteIntentDeclared(OWNER, 101);
    noteAssumptionAsserted(OWNER, 3368);
    noteGoalClaimed(OWNER, 'WI-6393');
    expect(Object.keys(readAgentStateStamp(OWNER)).sort()).toEqual([
      'assumptionSetId',
      'goalRef',
      'intentEventId',
    ]);
  });

  it('keeps owners isolated — one agent cannot read another agent state', () => {
    noteIntentDeclared(OWNER, 101);
    noteGoalClaimed(OTHER, 'WI-6393');
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(101);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
    expect(readAgentStateStamp(OTHER).goalRef).toBe('WI-6393');
    expect(readAgentStateStamp(OTHER).intentEventId).toBeNull();
  });
});

describe('the three declarations have INDEPENDENT lifetimes (D-011)', () => {
  it('re-declaring intent does not clear the goal or the assumptions', () => {
    // This is the case that actually happens every wake: coord:orient
    // re-declares intent while the agent holds the same claim throughout. A
    // whole-state reset here would blank the goal on every wake — the same bug
    // class as EI-18776963284535761 (declare-intent wiping current_files).
    noteGoalClaimed(OWNER, 'WI-6393');
    noteAssumptionAsserted(OWNER, 3368);
    noteIntentDeclared(OWNER, 101);
    noteIntentDeclared(OWNER, 202);

    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: 202,
      assumptionSetId: 3368,
      goalRef: 'WI-6393',
    });
  });
});

describe('noteAssumptionAsserted — the watermark', () => {
  it('advances to the newest fact version id', () => {
    noteAssumptionAsserted(OWNER, 3368);
    noteAssumptionAsserted(OWNER, 3400);
    expect(readAgentStateStamp(OWNER).assumptionSetId).toBe(3400);
  });

  it('NEVER moves backwards, even if a lower id arrives later', () => {
    // Ids come from a sequence, so two racing asserts can settle out of order.
    // A watermark that regressed would silently NARROW the set every subsequent
    // call claims to have been made under — it would drop assumptions the agent
    // demonstrably already held.
    noteAssumptionAsserted(OWNER, 3400);
    noteAssumptionAsserted(OWNER, 3368);
    expect(readAgentStateStamp(OWNER).assumptionSetId).toBe(3400);
  });

  it('ignores a null/non-finite id rather than poisoning the pointer', () => {
    noteAssumptionAsserted(OWNER, 3400);
    noteAssumptionAsserted(OWNER, null);
    noteAssumptionAsserted(OWNER, Number.NaN);
    expect(readAgentStateStamp(OWNER).assumptionSetId).toBe(3400);
  });
});

describe('noteIntentDeclared', () => {
  it('ignores a null id — an append with no sequence number is not a pointer', () => {
    // fs/memory-backed logs return null from appendLine by contract. Stamping
    // that as an id would produce a pointer at nothing.
    noteIntentDeclared(OWNER, null);
    expect(readAgentStateStamp(OWNER).intentEventId).toBeNull();
  });

  it('takes the LATEST intent, including a lower id (unlike the watermark)', () => {
    // Intent is "the most recent declaration", not a high-water mark: an agent
    // genuinely moves from one intent to another and the newest one wins.
    noteIntentDeclared(OWNER, 202);
    noteIntentDeclared(OWNER, 101);
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(101);
  });
});

describe('noteGoalClaimed', () => {
  it('records a claimed goal and clears it on release', () => {
    noteGoalClaimed(OWNER, 'WI-6393');
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6393');
    noteGoalClaimed(OWNER, null);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });

  it('normalises blank/whitespace refs to null rather than storing them', () => {
    noteGoalClaimed(OWNER, '   ');
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
    noteGoalClaimed(OWNER, '  WI-6393  ');
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6393');
  });

  it('clearing the goal leaves intent and assumptions intact', () => {
    noteIntentDeclared(OWNER, 101);
    noteAssumptionAsserted(OWNER, 3368);
    noteGoalClaimed(OWNER, 'WI-6393');
    noteGoalClaimed(OWNER, null);
    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: 101,
      assumptionSetId: 3368,
      goalRef: null,
    });
  });
});

describe('clearGoalClaimedIfMatches', () => {
  it('clears a matching normalized ref and reports that it did so', () => {
    noteGoalClaimed(OWNER, '  WI-6393  ');

    expect(clearGoalClaimedIfMatches(OWNER, 'WI-6393')).toBe(true);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });

  it('does not clear a mismatched ref or an unrelated newer goal', () => {
    noteGoalClaimed(OWNER, 'WI-6393');
    expect(clearGoalClaimedIfMatches(OWNER, 'WI-other')).toBe(false);
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6393');

    noteGoalClaimed(OWNER, 'plan-1#P-004');
    expect(clearGoalClaimedIfMatches(OWNER, 'WI-6393')).toBe(false);
    expect(readAgentStateStamp(OWNER).goalRef).toBe('plan-1#P-004');
  });

  it('does not create or rehydrate a cache entry when the owner/ref is absent', () => {
    expect(clearGoalClaimedIfMatches(OWNER, null)).toBe(false);
    expect(clearGoalClaimedIfMatches('', 'WI-6393')).toBe(false);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });
});

describe('memory bound', () => {
  it('evicts least-recently-written owners past the cap instead of growing forever', () => {
    // A long-lived operator process sees thousands of distinct owners over
    // weeks (2,363 distinct intent writers in 8 weeks, measured 2026-07-27).
    // Unbounded growth would be a slow leak in the hottest shared process.
    for (let i = 0; i < 600; i++) noteIntentDeclared(`owner-${i}`, i + 1);
    expect(agentStateStampSize()).toBeLessThanOrEqual(512);
    // The most recent writers survive; the oldest are gone.
    expect(readAgentStateStamp('owner-599').intentEventId).toBe(600);
    expect(readAgentStateStamp('owner-0').intentEventId).toBeNull();
  });

  it('a re-written owner is kept fresh and is not evicted as stale', () => {
    noteIntentDeclared(OWNER, 1);
    for (let i = 0; i < 400; i++) noteIntentDeclared(`filler-${i}`, i + 1);
    // Touch the original again — it must now be among the most recent.
    noteIntentDeclared(OWNER, 2);
    for (let i = 400; i < 900; i++) noteIntentDeclared(`filler-${i}`, i + 1);
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(2);
  });
});

/**
 * WI-6595 — a restart wipes this map, and `goalRef` alone never came back.
 *
 * `intentEventId` self-heals because every wake re-declares intent, but
 * `noteGoalClaimed` only fires on claim/release, so an agent still working a
 * claim it took before the deploy stamped a null for the rest of that claim.
 * Measured live: co-stamped rows went 587/hr -> 0/hr across the 02:00Z deploy,
 * which red `lint:plane-ratchet` for the whole fleet.
 */
describe('durable goal re-hydration (WI-6595)', () => {
  /** Let the fire-and-forget fill run without coupling to a real timer. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentStateStamps();
  });

  it('refills a missing goal from durable state — WITHOUT blocking the call that missed', async () => {
    setAgentGoalRehydrator(async () => 'WI-6595');

    // The read that MISSES still returns synchronously, and still stamps the null
    // it honestly had: this call really was made with no goal known. D-014 forbids
    // it blocking on I/O, so the refill can only help the next call.
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();

    await settle();
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6595');
  });

  it('does not query at all when the goal is already known', async () => {
    const durable = vi.fn(async () => 'WI-STALE');
    setAgentGoalRehydrator(durable);
    noteGoalClaimed(OWNER, 'WI-LIVE');

    readAgentStateStamp(OWNER);
    readAgentStateStamp(OWNER);
    await settle();

    expect(durable).not.toHaveBeenCalled();
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-LIVE');
  });

  it('collapses a burst of misses into ONE durable read', async () => {
    // This runs on a path that takes ~238,866 calls a day. A refill per miss
    // would turn a cold cache into a stampede against the goal legs.
    const durable = vi.fn(async () => null);
    setAgentGoalRehydrator(durable);

    for (let i = 0; i < 50; i++) readAgentStateStamp(OWNER);
    await settle();

    expect(durable).toHaveBeenCalledTimes(1);
  });

  it('retries a later miss once the backoff lapses — a boot-time null must not stick', async () => {
    // The first calls after a restart are exactly when the PG fast path may not
    // be up, so `resolveOwnerGoal` returns a null that means "could not read",
    // not "holds nothing". A permanent already-asked mark would freeze that for
    // the life of the process.
    const nowSpy = vi.spyOn(Date, 'now');
    const durable = vi.fn(async () => null);
    setAgentGoalRehydrator(durable);

    nowSpy.mockReturnValue(1_000);
    readAgentStateStamp(OWNER);
    await settle();
    expect(durable).toHaveBeenCalledTimes(1);

    // Still inside the backoff — no second query.
    nowSpy.mockReturnValue(30_000);
    readAgentStateStamp(OWNER);
    await settle();
    expect(durable).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(120_000);
    readAgentStateStamp(OWNER);
    await settle();
    expect(durable).toHaveBeenCalledTimes(2);
  });

  it('NEVER resurrects a goal the agent released while the read was in flight', async () => {
    // The race that makes a cache refill dangerous: the durable read starts,
    // the agent puts the work down, then the read answers with what it saw
    // BEFORE the release. Stamping the fill with the read's START time lets
    // upsert's existing drop-if-older rule discard it.
    const nowSpy = vi.spyOn(Date, 'now');
    let answer!: (ref: string | null) => void;
    setAgentGoalRehydrator(() => new Promise<string | null>((r) => (answer = r)));

    nowSpy.mockReturnValue(1_000);
    noteGoalClaimed(OWNER, 'WI-6595');
    // Clear it the way a release does, so the next read misses and refills.
    nowSpy.mockReturnValue(2_000);
    noteGoalClaimed(OWNER, null);

    nowSpy.mockReturnValue(3_000);
    readAgentStateStamp(OWNER); // schedules the refill at t=3000

    // The agent releases AGAIN at a later instant while the read is outstanding.
    nowSpy.mockReturnValue(4_000);
    noteGoalClaimed(OWNER, null);

    answer('WI-6595'); // the stale in-flight read finally lands
    await settle();

    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });

  it('a durable read that throws costs the goal, never the tool call', async () => {
    setAgentGoalRehydrator(async () => {
      throw new Error('pg is down');
    });

    expect(() => readAgentStateStamp(OWNER)).not.toThrow();
    await settle();
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });

  it('the DEFAULT hydrator\'s import specifier resolves — the one failure the catch would hide', async () => {
    // The production path reaches the durable read through a dynamic import, and
    // the fill is wrapped in a catch so telemetry can never fail a tool call.
    // Those two together mean a BROKEN SPECIFIER (a move, a rename, a bundler that
    // drops the chunk) degrades to "the goal is silently never refilled" — green
    // tests, green types, and the exact bug this fix exists to remove, back again.
    // Nothing else in this file would notice, because every other test injects a
    // fake hydrator. So resolve the real specifier explicitly.
    const mod = await import('./agent-tools/coordination/agent-goal-sources');
    expect(typeof mod.resolveOwnerGoal).toBe('function');
  });

  it('a refilled goal is still guarded by asGoalRef, exactly like a declared one', async () => {
    // The stamp and the cell share ONE ref vocabulary; a refill must not be the
    // hole through which a shape a live reader would reject gets in.
    setAgentGoalRehydrator(async () => '   not a ref at all   ');
    readAgentStateStamp(OWNER);
    await settle();
    expect(readAgentStateStamp(OWNER).goalRef).not.toBe('   not a ref at all   ');
  });
});

describe('durable intent re-hydration (WI-6637)', () => {
  /** Let the fire-and-forget fill run without coupling to a real timer. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentStateStamps();
  });

  it('refills a missing intent from durable state — WITHOUT blocking the call that missed', async () => {
    setAgentIntentRehydrator(async () => 8355293);

    // Same D-014 contract as the goal half: the read that MISSES still returns
    // synchronously and still stamps the null it honestly had.
    expect(readAgentStateStamp(OWNER).intentEventId).toBeNull();

    await settle();
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(8355293);
  });

  it('does not query at all when the intent is already known', async () => {
    const durable = vi.fn(async () => 111);
    setAgentIntentRehydrator(durable);
    noteIntentDeclared(OWNER, 999);

    readAgentStateStamp(OWNER);
    readAgentStateStamp(OWNER);
    await settle();

    expect(durable).not.toHaveBeenCalled();
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(999);
  });

  it('collapses a burst of misses into ONE durable read', async () => {
    const durable = vi.fn(async () => null);
    setAgentIntentRehydrator(durable);

    for (let i = 0; i < 50; i++) readAgentStateStamp(OWNER);
    await settle();

    expect(durable).toHaveBeenCalledTimes(1);
  });

  it('retries a later miss once the backoff lapses — a boot-time null must not stick', async () => {
    // A restart is exactly when the PG fast path may not be up yet, so the
    // resolver returns a null meaning "could not read", not "never declared".
    const nowSpy = vi.spyOn(Date, 'now');
    const durable = vi.fn(async () => null);
    setAgentIntentRehydrator(durable);

    nowSpy.mockReturnValue(1_000);
    readAgentStateStamp(OWNER);
    await settle();
    expect(durable).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(30_000);
    readAgentStateStamp(OWNER);
    await settle();
    expect(durable).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(120_000);
    readAgentStateStamp(OWNER);
    await settle();
    expect(durable).toHaveBeenCalledTimes(2);
  });

  it('NEVER rewinds to a stale id when a real declaration landed while the read was in flight', async () => {
    // THE regression guard for this item. WI-6637 was filed claiming a late fill
    // is "safe by construction because intentEventId is already MONOTONIC in
    // applyPatch" — it is not: `upsert` has no monotonic rule, and the LOCAL path
    // is deliberately last-write-wins. So the fill has to carry the guard itself,
    // or a slow durable read silently rewinds the pointer every later call claims
    // to have been made under.
    let answer: ((v: number | null) => void) | undefined;
    setAgentIntentRehydrator(() => new Promise<number | null>((r) => (answer = r)));

    readAgentStateStamp(OWNER); // miss -> starts the durable read
    // The agent declares a NEW intent while that read is still in flight.
    noteIntentDeclared(OWNER, 8355293);
    // ...and the read now answers with the OLDER pointer it saw before that.
    answer?.(8355000);
    await settle();

    expect(readAgentStateStamp(OWNER).intentEventId).toBe(8355293);
  });

  it('a null answer is an honest "never declared" and is not written', async () => {
    const durable = vi.fn(async () => null);
    setAgentIntentRehydrator(durable);

    readAgentStateStamp(OWNER);
    await settle();

    expect(durable).toHaveBeenCalledTimes(1);
    expect(readAgentStateStamp(OWNER).intentEventId).toBeNull();
  });

  it('re-hydrating intent does not disturb the goal or the assumption watermark', async () => {
    // D-011: the three declarations have independent lifetimes, and a refill of
    // one must not read as a write to the others.
    setAgentIntentRehydrator(async () => 8355293);
    setAgentGoalRehydrator(async () => null);
    noteGoalClaimed(OWNER, 'WI-6637');
    noteAssumptionAsserted(OWNER, 3368);

    readAgentStateStamp(OWNER);
    await settle();

    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: 8355293,
      assumptionSetId: 3368,
      goalRef: 'WI-6637',
    });
  });

  it('the default rehydrator resolves against the real durable source', async () => {
    // The seam above is a TEST seam, not an installation point — the production
    // default must exist with no wiring at all (WI-6594's dead-seam lesson).
    const mod = await import('./agent-tools/coordination/agent-intent-sources');
    expect(typeof mod.resolveOwnerIntentEventId).toBe('function');
  });
});
