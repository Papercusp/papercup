/**
 * Unit tests for presence-announce (Phase 0.3 write-side cadence + op shape,
 * distributed-coordination-shared-harness-2026-06-04). Pure — the append is injected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  shouldAnnounce,
  buildPresenceAnnounceRow,
  buildPresenceAnnounceOp,
  buildPresenceTombstoneOp,
  announceLocalPresence,
  startPresenceAnnounceLoop,
  type PresenceState,
  type LastAnnounce,
  type PresenceIdentity,
} from '../presence-announce';

const ID: PresenceIdentity = { githubUserId: 4242, machineLabel: 'thinkpad', devicePubkey: 'pubAAA' };
const STATE: PresenceState = { intent: 'building federation', currentView: 'harness/papercup', harnessSlug: 'papercup' };
const NOW = 1_700_000_000_000;

describe('shouldAnnounce — D-007 state-change-with-TTL cadence', () => {
  it('announces on first call (never announced)', () => {
    expect(shouldAnnounce(null, STATE, NOW)).toBe(true);
  });
  it('announces when the declared state changes', () => {
    const prev: LastAnnounce = { state: STATE, atMs: NOW };
    expect(shouldAnnounce(prev, { ...STATE, intent: 'reviewing' }, NOW + 1000)).toBe(true);
    expect(shouldAnnounce(prev, { ...STATE, currentView: 'other' }, NOW + 1000)).toBe(true);
    expect(shouldAnnounce(prev, { ...STATE, harnessSlug: 'restart' }, NOW + 1000)).toBe(true);
  });
  it('does NOT announce on an unchanged state within the refresh window (no firehose)', () => {
    const prev: LastAnnounce = { state: STATE, atMs: NOW };
    expect(shouldAnnounce(prev, STATE, NOW + 5_000, { refreshMs: 30_000 })).toBe(false);
  });
  it('re-announces (keep-alive) when the last announce ages past the refresh window', () => {
    const prev: LastAnnounce = { state: STATE, atMs: NOW };
    expect(shouldAnnounce(prev, STATE, NOW + 30_000, { refreshMs: 30_000 })).toBe(true);
  });
});

describe('buildPresenceAnnounceRow / Op', () => {
  it('builds the SharedPresenceRow the presence projection materializes', () => {
    const row = buildPresenceAnnounceRow(ID, STATE, NOW);
    expect(row).toEqual({
      harness_slug: 'papercup',
      github_user_id: 4242,
      machine_label: 'thinkpad',
      device_pubkey: 'pubAAA',
      intent: 'building federation',
      current_view: 'harness/papercup',
      last_seen_at: NOW,
      schema_version: 1,
      // hive_slug defaults null (shared-hive-federation P-008/P-009 carry; the
      // publisher stamps a real Hive slug when wired).
      hive_slug: null,
      // runs_routines defaults null = "not a runner candidate"
      // (EI-18761517980514694); the publisher stamps TRUE only on a node that
      // actually fires this pot's cadence loops.
      runs_routines: null,
    });
  });

  it('stamps runs_routines ONLY when true — false collapses to null for wire compat', () => {
    // A non-runner must produce a row byte-identical to the pre-mig-682 wire form,
    // or its signed gossip frame stops verifying on peers that have not upgraded
    // (presenceFrameSigningBytes includes the field only when present). `false` and
    // "unknown" are the same verdict to every consumer, so they collapse to null.
    expect(buildPresenceAnnounceRow(ID, STATE, NOW, null, true).runs_routines).toBe(true);
    expect(buildPresenceAnnounceRow(ID, STATE, NOW, null, false).runs_routines).toBeNull();
    expect(buildPresenceAnnounceRow(ID, STATE, NOW, null, null).runs_routines).toBeNull();
  });
  it('builds a put op keyed <github_user_id>/<machine> (mirrors the projection composeKey)', () => {
    const op = buildPresenceAnnounceOp(ID, STATE, NOW);
    expect(op.type).toBe('put');
    expect(op.table).toBe('presence');
    expect(op.hbKey).toBe('4242/thinkpad');
    expect((op as { value: { harness_slug: string } }).value.harness_slug).toBe('papercup');
  });
  it('buildPresenceTombstoneOp builds a del op on the same key, carrying no row (EI-469)', () => {
    const op = buildPresenceTombstoneOp(ID, NOW);
    expect(op.type).toBe('del');
    expect(op.table).toBe('presence');
    expect(op.hbKey).toBe('4242/thinkpad'); // same key the put uses → the del retracts it
    expect(op.ts).toBe(NOW);
    expect(op.value).toBeUndefined();
  });
});

describe('announceLocalPresence — decides + appends', () => {
  it('appends + returns the new LastAnnounce when the cadence fires', async () => {
    const append = vi.fn(async () => {});
    const res = await announceLocalPresence(ID, STATE, { append, prev: null, now: () => NOW });
    expect(res.announced).toBe(true);
    expect(append).toHaveBeenCalledOnce();
    expect(res.last).toEqual({ state: STATE, atMs: NOW });
  });

  it('skips (no append) when the cadence does not fire', async () => {
    const append = vi.fn(async () => {});
    const prev: LastAnnounce = { state: STATE, atMs: NOW };
    const res = await announceLocalPresence(ID, STATE, { append, prev, now: () => NOW + 5_000, cadence: { refreshMs: 30_000 } });
    expect(res.announced).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('threads LastAnnounce across ticks — a change after a quiet period re-announces', async () => {
    const append = vi.fn(async () => {});
    // tick 1: first announce
    let r = await announceLocalPresence(ID, STATE, { append, prev: null, now: () => NOW });
    // tick 2: unchanged, within window → skip
    r = await announceLocalPresence(ID, STATE, { append, prev: r.last!, now: () => NOW + 1_000, cadence: { refreshMs: 30_000 } });
    expect(r.announced).toBe(false);
    // tick 3: intent changed → announce
    r = await announceLocalPresence(ID, { ...STATE, intent: 'done' }, { append, prev: r.last!, now: () => NOW + 2_000 });
    expect(r.announced).toBe(true);
    expect(append).toHaveBeenCalledTimes(2);
  });
});

describe('startPresenceAnnounceLoop — the write-side driver', () => {
  function noopTimer() {
    // A no-op interval: we drive ticks manually via handle.tickOnce.
    return { setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>, clearIntervalFn: () => {} };
  }

  it('announces on the first tick (identity resolved + cadence fires)', async () => {
    const append = vi.fn(async () => {});
    let t = NOW;
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => ID,
      getState: () => STATE,
      append,
      intervalMs: 5_000,
      now: () => t,
      ...noopTimer(),
    });
    await h.tickOnce();
    expect(append).toHaveBeenCalledOnce();
    // tick 2 unchanged within refresh → no announce
    t = NOW + 1_000;
    await h.tickOnce();
    expect(append).toHaveBeenCalledOnce();
    h.stop();
  });

  it('identity-null (gh unauthenticated) → ticks are no-ops, never announces', async () => {
    const append = vi.fn(async () => {});
    let calls = 0;
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => { calls++; return null; },
      getState: () => STATE,
      append,
      intervalMs: 5_000,
      now: () => NOW,
      ...noopTimer(),
    });
    await h.tickOnce();
    await h.tickOnce();
    expect(append).not.toHaveBeenCalled();
    // EI-18768167802573425: an unresolved identity is re-attempted, but THROTTLED to
    // identityRetryMs — the clock is frozen here, so both ticks fall inside the first
    // window and only ONE resolution is attempted (a truly gh-unauthenticated box must
    // not re-probe its keychain every 5s tick). The retry itself is covered below.
    expect(calls).toBe(1);
    h.stop();
  });

  // ── EI-18768167802573425 ──────────────────────────────────────────────────
  // A null identity used to be cached as permanently as a success (the
  // `identity === undefined` memo guard), so ONE transient failure on the first
  // tick — gh token not yet readable, keychain not yet decryptable, a registry
  // blip racing substrate boot — left the node announcing NOTHING, silently, for
  // the whole process lifetime. Only a restart cleared it.
  it('RE-ATTEMPTS a null identity after the retry window (a transient failure must not latch forever)', async () => {
    const append = vi.fn(async () => {});
    let calls = 0;
    let t = NOW;
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => {
        calls++;
        return null;
      },
      getState: () => STATE,
      append,
      intervalMs: 5_000,
      identityRetryMs: 60_000,
      now: () => t,
      ...noopTimer(),
    });
    await h.tickOnce();
    expect(calls).toBe(1);
    // Many ticks inside the window → still exactly one attempt (throttled).
    t = NOW + 59_999;
    await h.tickOnce();
    await h.tickOnce();
    expect(calls).toBe(1);
    // Window elapsed → re-attempt.
    t = NOW + 60_000;
    await h.tickOnce();
    expect(calls).toBe(2);
    h.stop();
  });

  it('RECOVERS: a transient identity failure resolves on a later attempt and announcing begins', async () => {
    const append = vi.fn(async () => {});
    const recovered: number[] = [];
    const unresolved: number[] = [];
    let t = NOW;
    let failuresLeft = 1; // the first attempt throws-equivalent (null), then succeeds
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => {
        if (failuresLeft > 0) {
          failuresLeft--;
          return null;
        }
        return ID;
      },
      getState: () => STATE,
      append,
      intervalMs: 5_000,
      identityRetryMs: 60_000,
      now: () => t,
      onIdentityUnresolved: (attempt) => unresolved.push(attempt),
      onIdentityRecovered: (afterAttempts) => recovered.push(afterAttempts),
      ...noopTimer(),
    });
    await h.tickOnce();
    // Pre-fix this was terminal: never announces again for the process lifetime.
    expect(append).not.toHaveBeenCalled();
    expect(unresolved).toEqual([1]);
    t = NOW + 60_000;
    await h.tickOnce();
    expect(append).toHaveBeenCalledOnce(); // presence is live again
    expect(recovered).toEqual([2]);
    h.stop();
  });

  it('caches a SUCCESSFUL identity — never re-resolves once resolved', async () => {
    const append = vi.fn(async () => {});
    const recovered: number[] = [];
    let calls = 0;
    let t = NOW;
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => {
        calls++;
        return ID;
      },
      getState: () => STATE,
      append,
      intervalMs: 5_000,
      identityRetryMs: 60_000,
      now: () => t,
      onIdentityRecovered: (n) => recovered.push(n),
      ...noopTimer(),
    });
    await h.tickOnce();
    t = NOW + 600_000; // far past the retry window
    await h.tickOnce();
    await h.tickOnce();
    expect(calls).toBe(1);
    // A first-attempt success is not a "recovery" — never announce a non-event.
    expect(recovered).toEqual([]);
    h.stop();
  });

  it('a tick error is surfaced via onError and does NOT kill the loop', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const append = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('append failed');
    });
    let t = NOW;
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => ID,
      getState: () => ({ ...STATE, intent: `i-${t}` }), // change each tick so cadence always fires
      append,
      intervalMs: 5_000,
      now: () => t,
      onError: (e) => errors.push(e),
      ...noopTimer(),
    });
    await h.tickOnce();           // throws → onError, loop survives
    t = NOW + 10_000;
    await h.tickOnce();           // works
    expect(errors).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it('the injected interval drives tickOnce + stop clears it', () => {
    let cb: (() => void) | null = null;
    let cleared = false;
    const append = vi.fn(async () => {});
    const h = startPresenceAnnounceLoop({
      resolveIdentity: async () => ID,
      getState: () => STATE,
      append,
      intervalMs: 5_000,
      now: () => NOW,
      setIntervalFn: (fn) => { cb = fn; return 123 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => { cleared = true; },
    });
    expect(typeof cb).toBe('function');
    h.stop();
    expect(cleared).toBe(true);
  });
});
