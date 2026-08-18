/**
 * read-deadline.test.ts — the properties the WI-39813 bound has to have, each
 * paired with a PERMANENT deliberately-wrong implementation that must fail it.
 *
 * WHY THE CONTROLS ARE KEPT, NOT RUN ONCE
 *
 * A guard that has never failed is a guard nobody has tested, and the usual way
 * to test one here — mutate the real file, run the suite, restore it — is unsafe
 * on this shared checkout: git-sync sweeps the whole tree on a schedule and can
 * commit the mutant during the window the probe legitimately holds it broken.
 * The repo's own tier table sends an imported MODULE to this cheaper, safer
 * form instead (`CLAUDE.md`, "Proving a guard is falsifiable"): keep the wrong
 * implementation in the test file, permanently, and assert it FAILS the same
 * property the real one passes. It costs no lock, dirties nothing, and — unlike
 * a one-shot probe — it keeps proving the property discriminates on every run.
 *
 * Both controls below are plausible, not absurd. Each is a version somebody
 * writes on the way to the right one; CONTROL A is literally the first version
 * written during the WI-39813 fix, caught in review rather than by a test.
 */
import { describe, expect, it } from 'vitest';

import { createReadDeadline, RESOLVER_READ_TIMEOUT_MS, type WithinBudget } from './read-deadline';

/** Never settles — a wedged store, not a failing one. */
const hang = <T>(): Promise<T> => new Promise<T>(() => {});

/** Resolves after `ms` of REAL time — slow enough to lose a spent deadline. */
const slow = <T>(value: T, ms: number): Promise<T> =>
  new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });

const sleep = (ms: number) => slow(null, ms);

type Settled<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; message: string } | { kind: 'pending' };

/**
 * Observe a promise WITHOUT waiting on it forever: a promise still pending after
 * `ms` reports as `pending` instead of hanging the test. That distinction is the
 * whole instrument here — "never settled" is the failure mode under test, so it
 * has to be an assertable outcome rather than a timeout.
 */
const settleWithin = <T>(p: Promise<T>, ms: number): Promise<Settled<T>> =>
  Promise.race([
    p.then(
      (value): Settled<T> => ({ kind: 'resolved', value }),
      (error): Settled<T> => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
    ),
    new Promise<Settled<T>>((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

/**
 * CONTROL A — the bound applied DOWNSTREAM of the await.
 *
 * This typechecks, reads correctly, and is a perfect no-op for the one thing it
 * exists to bound: nothing constrains `await p`, so a hanging leg hangs exactly
 * as it did before. It is the shape to watch for if this wrapping is ever
 * refactored — a "timeout" placed after the await bounds nothing at all.
 */
const boundAfterTheAwait =
  (budgetMs: number): WithinBudget =>
  async <T>(p: Promise<T>, label: string): Promise<T> => {
    const value = await p; // ← nothing bounds this
    return createReadDeadline(budgetMs)(Promise.resolve(value), label);
  };

/**
 * CONTROL B — a per-CALL budget instead of one shared deadline.
 *
 * Indistinguishable from correct for a read with ONE fan-out. The moment a read
 * has two sequential fan-outs (rows, then counts) the second gets a fresh full
 * budget, so the total is 2x and overruns the very RESOLVER_READ_TIMEOUT_MS the
 * bound exists to stay under.
 */
const budgetPerCall =
  (budgetMs: number): WithinBudget =>
  <T>(p: Promise<T>, label: string): Promise<T> =>
    createReadDeadline(budgetMs)(p, label);

describe('createReadDeadline', () => {
  it('is documented against a ceiling the budgets must sit under', () => {
    // A budget at or above the resolver timeout cannot prevent the 500 it exists
    // to prevent; the consumers' budgets are chosen against this number.
    expect(RESOLVER_READ_TIMEOUT_MS).toBeGreaterThan(0);
  });

  describe('P1 — a hang is REJECTED inside the budget (never awaited forever)', () => {
    it('the real implementation rejects, labelled', async () => {
      const withinBudget = createReadDeadline(30);
      const outcome = await settleWithin(withinBudget(hang<number>(), 'memory'), 500);

      expect(outcome.kind).toBe('rejected');
      expect(outcome.kind === 'rejected' && outcome.message).toContain('memory');
      expect(outcome.kind === 'rejected' && outcome.message).toContain('exceeded the read budget');
    });

    it('CONTROL A fails it — a bound after the await never settles at all', async () => {
      const withinBudget = boundAfterTheAwait(30);
      const outcome = await settleWithin(withinBudget(hang<number>(), 'memory'), 300);

      // Exactly the defect WI-39813 fixed, reproduced on demand: the caller's
      // `catch` is never reached, so no `degraded` flag is ever computed.
      expect(outcome.kind).toBe('pending');
    });

    it('CONTROL A is wrong only in that ONE way — it serves a healthy leg fine', async () => {
      // Calibration for the control itself. A control that fails everything
      // proves nothing about the property; this one has to be a plausible
      // near-miss, not a broken function.
      const withinBudget = boundAfterTheAwait(30);
      const outcome = await settleWithin(withinBudget(Promise.resolve(7), 'memory'), 300);

      expect(outcome).toEqual({ kind: 'resolved', value: 7 });
    });
  });

  describe('P2 — ONE deadline is shared by every phase of the read', () => {
    it('the real implementation gives a later phase only what the earlier one left', async () => {
      const withinBudget = createReadDeadline(30);
      await sleep(60); // the legs phase spends the whole budget

      const outcome = await settleWithin(withinBudget(slow(9, 25), 'counts'), 500);

      expect(outcome.kind).toBe('rejected');
    });

    it('CONTROL B fails it — a per-call budget hands the later phase a fresh one', async () => {
      const withinBudget = budgetPerCall(30);
      await sleep(60);

      const outcome = await settleWithin(withinBudget(slow(9, 25), 'counts'), 500);

      // Resolving here is the bug: two phases at 30ms each is 60ms of budget
      // against a bound that promised 30 — the same arithmetic that puts two 6s
      // budgets over the 10s resolver timeout in production.
      expect(outcome).toEqual({ kind: 'resolved', value: 9 });
    });

    it('calibration: a FRESH deadline resolves that identical slow promise', async () => {
      // So the rejection in the real case above is the spent deadline, not a
      // promise that could never land inside the window.
      const withinBudget = createReadDeadline(2000);
      const outcome = await settleWithin(withinBudget(slow(9, 25), 'counts'), 500);

      expect(outcome).toEqual({ kind: 'resolved', value: 9 });
    });
  });

  describe('P3 — a spent deadline never steals a result that was already ready', () => {
    it('an already-settled promise still wins at zero remaining', async () => {
      // By design: its `.then` is a microtask and the expiry a macrotask. The
      // consumers lean on this — a dep resolved once and reused by a later phase
      // must not be nulled just because the budget is gone.
      const withinBudget = createReadDeadline(10);
      await sleep(40);

      const outcome = await settleWithin(withinBudget(Promise.resolve('ready'), 'dep'), 500);

      expect(outcome).toEqual({ kind: 'resolved', value: 'ready' });
    });
  });

  describe('P4 — a leg that REJECTS keeps its own error', () => {
    it('the original rejection is passed through, not replaced by a budget error', async () => {
      // The caller distinguishes "this store is down" from "this store is slow"
      // only by the message it catches.
      const withinBudget = createReadDeadline(2000);
      const outcome = await settleWithin(withinBudget(Promise.reject(new Error('pg down')), 'plan'), 500);

      expect(outcome).toEqual({ kind: 'rejected', message: 'pg down' });
    });
  });
});
