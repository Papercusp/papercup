/** Tests for the StallWaker decision logic (gateway-rate-limit-stall-autowake P-003/P-004). Deps-injected
 *  + an injectable clock, so the confirm-wait-wake state machine is exercised with no gateway/DB/clock. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StallWaker, type StallEvent, type StallWakerDeps, type StallWakerOptions } from './stall-waker';

function harness(opts: StallWakerOptions = {}) {
  const state = { t: 1_000_000, beeIdle: true, capBack: true, woken: 1, unwedgeOk: true, unwedgeExpected: false };
  const queue: StallEvent[] = [];
  const logs: Array<{ level: 'info' | 'warn'; msg: string }> = [];
  const calls = { wake: [] as string[], cap: 0, unwedge: [] as string[] };
  const deps: StallWakerDeps = {
    fetchStalls: async (since) => ({ now: state.t, stalls: queue.filter((s) => s.at > since) }),
    ownerIsIdle: async () => state.beeIdle,
    capacityBack: async () => {
      calls.cap++;
      return state.capBack;
    },
    wake: async (ownerId) => {
      calls.wake.push(ownerId);
      return { woken: state.woken };
    },
    unwedge: async (ownerId) => {
      calls.unwedge.push(ownerId);
      return { ok: state.unwedgeOk, expected: state.unwedgeExpected };
    },
    now: () => state.t,
    log: (level, msg) => logs.push({ level, msg }),
  };
  const w = new StallWaker(deps, opts);
  return {
    w,
    calls,
    state,
    logs,
    advance: (ms: number) => {
      state.t += ms;
    },
    pushStall: (e: Partial<StallEvent> = {}) =>
      queue.push({ ownerId: 'bee-1', accountId: 'acct-A', soonestResetAt: state.t + 60_000, at: state.t, ...e }),
  };
}

test('happy path — confirmed-idle bee, after reset + capacity back → woken once', async () => {
  const h = harness();
  h.pushStall({ soonestResetAt: h.state.t + 60_000 });
  let r = await h.w.tick(); // pulled, idle, but reset not reached → wait
  assert.equal(r.pulled, 1);
  assert.deepEqual(r.woken, []);
  assert.equal(h.w.pendingCount, 1);
  h.advance(61_000); // past the reset
  r = await h.w.tick();
  assert.deepEqual(r.woken, ['bee-1'], 'woken once capacity is back');
  assert.equal(h.w.pendingCount, 0, 'cleared after a successful wake');
  assert.equal(h.calls.wake.length, 1);
});

test('FALSE-POSITIVE guard — a bee that never goes idle (recovered on its own) is dropped, never woken', async () => {
  const h = harness({ confirmWindowMs: 30_000 });
  h.state.beeIdle = false; // bee is still running — it recovered on its own CLI retry
  h.pushStall();
  let r = await h.w.tick();
  assert.equal(h.w.pendingCount, 1, 'kept within the confirm window');
  assert.deepEqual(r.woken, []);
  h.advance(31_000);
  r = await h.w.tick();
  assert.deepEqual(r.dropped, ['bee-1'], 'dropped past the confirm window');
  assert.equal(h.w.pendingCount, 0);
  assert.deepEqual(h.calls.wake, [], 'a self-recovered bee is NEVER woken');
});

test('waits for capacity — past the reset but pool still throttled → no wake until capacity returns', async () => {
  const h = harness();
  h.state.capBack = false;
  h.pushStall({ soonestResetAt: h.state.t + 1000 });
  h.advance(2000); // past the reset, but capacity not back
  let r = await h.w.tick();
  assert.deepEqual(r.woken, [], 'capacity not back → wait, do not wake into a throttled pool');
  assert.equal(h.w.pendingCount, 1);
  h.state.capBack = true;
  r = await h.w.tick();
  assert.deepEqual(r.woken, ['bee-1']);
});

test('bee gone — wake fires but nobody is watching (woken:0) → dropped, not retried', async () => {
  const h = harness();
  h.state.woken = 0; // no watching session — the bee process exited
  h.pushStall({ soonestResetAt: h.state.t + 1000 });
  h.advance(2000);
  const r = await h.w.tick();
  assert.deepEqual(r.woken, [], 'woken:0 is not a successful wake');
  assert.deepEqual(h.calls.wake, ['bee-1'], 'it DID attempt the wake');
  assert.equal(h.w.pendingCount, 0, 'dropped — a gone bee is not retried');
});

test('de-dup — many stalls for one bee → a single pending + a single wake (latest reset wins)', async () => {
  const h = harness();
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 1000 });
  h.advance(10);
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 5000 }); // later stall pushes the wait out
  const r1 = await h.w.tick();
  assert.equal(r1.pulled, 2);
  assert.equal(h.w.pendingCount, 1, 'collapsed to one bee');
  h.advance(3000); // past the FIRST reset but not the SECOND (de-dup took the max)
  const r2 = await h.w.tick();
  assert.deepEqual(r2.woken, [], 'still waiting on the later reset');
  h.advance(3000);
  const r3 = await h.w.tick();
  assert.deepEqual(r3.woken, ['bee-1']);
  assert.equal(h.calls.wake.length, 1, 'woken exactly once');
});

test('ROLE-AGNOSTIC — an su/psu session (not a bee spawn) is woken identically to a bee (2026-06-22)', async () => {
  const h = harness();
  // An autonomous su/psu engineer session — NOT a harness bee. The waker must treat it the same: confirm idle
  // (the role-agnostic ownerIsIdle dep), wait the reset, then wake. (The role-specific gap su-b813f hit was in
  // the DEPS impl, now fixed to read coord_presence for any role; the class here was always caller-agnostic.)
  h.pushStall({ ownerId: 'su-b813f856-99a1-494d-b92e-ae4b81343394' });
  let r = await h.w.tick();
  assert.equal(r.pulled, 1);
  h.advance(61_000);
  r = await h.w.tick();
  assert.deepEqual(r.woken, ['su-b813f856-99a1-494d-b92e-ae4b81343394'], 'an su/psu session is auto-woken just like a bee');
});

test('FAST UN-WEDGE — a confirmed-idle errored owner is ESC-unwedged immediately, BEFORE the capacity gate', async () => {
  const h = harness();
  h.state.capBack = false; // capacity NOT back — the capacity-gated wake must NOT fire yet
  h.pushStall({ soonestResetAt: h.state.t + 60_000 }); // reset far in the future
  const r = await h.w.tick();
  assert.deepEqual(r.unwedged, ['bee-1'], 'ESC-unwedged on the first idle-confirmed tick, regardless of capacity');
  assert.deepEqual(r.woken, [], 'but NOT woken — capacity not back, so it is not pushed back into a throttled pool');
  assert.deepEqual(h.calls.unwedge, ['bee-1']);
  assert.equal(h.w.pendingCount, 1, 'still pending for the capacity-gated resume');
});

test('FAST UN-WEDGE — not ESC-stormed within the cooldown, retried after it (session still wedged)', async () => {
  const h = harness({ unwedgeCooldownMs: 30_000 });
  h.state.capBack = false;
  h.pushStall({ soonestResetAt: h.state.t + 60_000 });
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 1);
  h.advance(10_000); // within cooldown
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 1, 'no re-ESC within the cooldown');
  h.advance(31_000); // past cooldown
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 2, 're-ESC allowed after the cooldown');
});

test('FAST UN-WEDGE — a REFUSED/failed ESC (e.g. storm-guard rate_limited) is NOT reported as success (root-cause fix, gateway-mass-outage-storm-guard-2026-07-01)', async () => {
  // Regression for the exact bug the user hit: `unwedge` used to be `Promise<void>` and
  // `performInterrupt` never throws on a refusal (rate_limited comes back as a normal `{ok:false}`
  // value) — so tick() logged "un-wedged … reachable again" and reported success even when NOTHING
  // was delivered. `unwedge` now returns `{ok, expected}`; tick() must honor `ok`.
  const h = harness();
  h.state.capBack = false;
  h.state.unwedgeOk = false; // a GENUINE refusal (e.g. storm-guard rate_limit) — NOT the expected no-live-session case
  h.pushStall({ soonestResetAt: h.state.t + 60_000 });
  const r = await h.w.tick();
  assert.deepEqual(h.calls.unwedge, ['bee-1'], 'the attempt still happens every cooldown window');
  assert.deepEqual(r.unwedged, [], 'a refused/failed ESC must NOT be reported as unwedged');
  assert.ok(
    h.logs.some((l) => l.level === 'warn' && /did NOT land/.test(l.msg)),
    'a failed ESC is logged as a warning, not silently swallowed',
  );
  assert.equal(h.w.pendingCount, 1, 'still pending — not dropped just because the ESC failed');
});

test('FAST UN-WEDGE — an EXPECTED no-live-session ESC is a silent non-event (log-spam fix, 2026-07-01)', async () => {
  // The dominant real-world outcome: the "stalled" owner has no live turn to ESC (idle / already ended) — it
  // isn't wedged. unwedge returns { ok:false, expected:true }. tick() must NOT warn (this recurs every cooldown
  // for the same gone owners and was ~27×/15min of `[stall-waker] … no live interruptible session` host-log
  // spam) — but it also must NOT count it as a success.
  const h = harness();
  h.state.capBack = false;
  h.state.unwedgeOk = false;
  h.state.unwedgeExpected = true; // no live interruptible session — expected, non-actionable
  h.pushStall({ soonestResetAt: h.state.t + 60_000 });
  const r = await h.w.tick();
  assert.deepEqual(h.calls.unwedge, ['bee-1'], 'the ESC attempt still happens');
  assert.deepEqual(r.unwedged, [], 'an expected no-op ESC is NOT reported as unwedged');
  assert.ok(
    !h.logs.some((l) => /did NOT land|refused|no live interruptible session/.test(l.msg)),
    'an EXPECTED no-live-session ESC must produce NO warn/log line',
  );
  assert.equal(h.w.pendingCount, 1, 'still pending — the capacity-gated wake path still owns the resume');
});

test('FAST UN-WEDGE — a self-recovered (never-idle) owner is NEVER force-ESC\'d', async () => {
  const h = harness();
  h.state.beeIdle = false; // recovered on its own CLI retry — still running
  h.pushStall();
  await h.w.tick();
  assert.deepEqual(h.calls.unwedge, [], 'a still-running owner is never force-ESC\'d (false-positive guard)');
});

test('wake cap — a bee that keeps stalling is given up after maxWakesPerBee', async () => {
  const h = harness({ maxWakesPerBee: 2, wakeCooldownMs: 0 });
  h.state.woken = 1;
  // Each round: a fresh stall, advance past reset, tick → wake. The 3rd should be capped.
  for (let i = 0; i < 2; i++) {
    h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 100 });
    h.advance(200);
    await h.w.tick();
  }
  assert.equal(h.calls.wake.length, 2, 'woke up to the cap');
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 100 });
  h.advance(200);
  const r = await h.w.tick();
  assert.equal(h.calls.wake.length, 2, 'no further wakes past the cap');
  assert.deepEqual(r.dropped, ['bee-1']);
});

test('WI-1582: breadcrumbs (lastWokeAt/lastUnwedgeAt/wakeCount) are bounded — swept once long-idle and not pending', async () => {
  const h = harness({ breadcrumbTtlMs: 1000 });
  h.pushStall({ soonestResetAt: h.state.t + 100 });
  h.advance(200);
  await h.w.tick(); // wakes bee-1 → pending cleared, but breadcrumbs (lastWokeAt, wakeCount) persist
  assert.equal(h.w.pendingCount, 0);
  assert.equal(h.w.breadcrumbCount, 1, 'the wake breadcrumb is tracked once woken');

  // Well within the TTL: a routine tick with nothing new must NOT sweep it yet.
  h.advance(500);
  await h.w.tick();
  assert.equal(h.w.breadcrumbCount, 1, 'not yet stale — kept');

  // Past the TTL with no further activity for this owner → swept.
  h.advance(600); // total 1100ms since last wake, past breadcrumbTtlMs=1000
  await h.w.tick();
  assert.equal(h.w.breadcrumbCount, 0, 'long-silent owner is reclaimed');
});

test('WI-1582: a CURRENTLY-PENDING owner is never swept, even past breadcrumbTtlMs (would reset its wake cap mid-episode)', async () => {
  const h = harness({ breadcrumbTtlMs: 1000, maxWakesPerBee: 1, wakeCooldownMs: 0 });
  h.state.capBack = false; // stays pending — never reaches the reset/capacity gate again
  h.pushStall({ soonestResetAt: h.state.t + 100 });
  h.advance(200);
  await h.w.tick(); // reset passed, capacity NOT back → stays pending, no wake yet
  assert.equal(h.w.pendingCount, 1);
  // The default harness has `unwedge` wired and beeIdle:true, so the confirmed-idle
  // owner is fast-ESC'd (2a-FAST) before the capacity gate — lastUnwedgeAt IS set here.
  assert.equal(h.w.breadcrumbCount, 1, 'the unwedge breadcrumb is tracked, but the owner stays pending');

  h.advance(2000); // well past breadcrumbTtlMs, but the owner is still pending throughout
  const r = await h.w.tick();
  assert.equal(h.w.pendingCount, 1, 'still pending — capacity never came back');
  assert.deepEqual(r.dropped, [], 'sweepBreadcrumbs must not touch a pending owner');
});

test("WI-1582: sweeping resets the wake cap for a bee that stalls again long after its session ended (doesn't permanently ban a NEW session's owner id)", async () => {
  const h = harness({ maxWakesPerBee: 1, wakeCooldownMs: 0, breadcrumbTtlMs: 1000 });
  h.pushStall({ soonestResetAt: h.state.t + 100 });
  h.advance(200);
  await h.w.tick();
  assert.equal(h.calls.wake.length, 1, 'first wake attempt used the cap');

  h.advance(1100); // past breadcrumbTtlMs with no activity → wakeCount reclaimed
  await h.w.tick(); // a no-op tick (no pending stall) still runs the sweep
  assert.equal(h.w.breadcrumbCount, 0);

  // A fresh stall for the SAME ownerId, long after the fact, gets a clean cap again —
  // sweeping did not permanently ban a bee that merely went quiet for a day.
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 100 });
  h.advance(200);
  const r = await h.w.tick();
  assert.deepEqual(r.woken, ['bee-1'], 'the cap reset after the long-idle sweep');
  assert.equal(h.calls.wake.length, 2);
});
