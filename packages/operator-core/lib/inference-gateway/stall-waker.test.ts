/** Tests for the StallWaker decision logic (gateway-rate-limit-stall-autowake P-003/P-004). Deps-injected
 *  + an injectable clock, so the confirm-wait-wake state machine is exercised with no gateway/DB/clock. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StallWaker, type StallEvent, type StallWakerDeps, type StallWakerOptions } from './stall-waker';

function harness(opts: StallWakerOptions = {}) {
  const state = { t: 1_000_000, beeIdle: true, capBack: true, woken: 1 };
  const queue: StallEvent[] = [];
  const calls = { wake: [] as string[], cap: 0 };
  const deps: StallWakerDeps = {
    fetchStalls: async (since) => ({ now: state.t, stalls: queue.filter((s) => s.at > since) }),
    beeIsIdle: async () => state.beeIdle,
    capacityBack: async () => {
      calls.cap++;
      return state.capBack;
    },
    wake: async (ownerId) => {
      calls.wake.push(ownerId);
      return { woken: state.woken };
    },
    now: () => state.t,
    log: () => {},
  };
  const w = new StallWaker(deps, opts);
  return {
    w,
    calls,
    state,
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
