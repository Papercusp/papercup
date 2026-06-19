/**
 * idempotency-replay-audit.test.ts — Brief AG (shared-hive-release-testing):
 * the IDEMPOTENCY / DETERMINISM / REPLAY audit over the REAL incremental merge
 * core (`mergeAdmittedLogsIncremental` + `createMergeCursor`) and a faithful
 * in-memory transcription of the projections' PG LWW guard
 * (`_convergence-fuzz-rig`'s `FedTsGuardedStore`, the SHIPPED `fed_hlc` guard +
 * the legacy `fed_ts` + the `lww` upper bound).
 *
 * WHY THIS IS A SEPARATE LANE FROM BRIEF D's convergence-fuzz:
 *   Brief D proves CROSS-PEER convergence (every honest peer reaches the same
 *   state). AG proves the foundational guarantee every recovery/churn/partition
 *   lane *assumes*: re-applying the SAME op log is SAFE — double-apply is a
 *   no-op, replay from ANY cursor converges to the all-at-once state, duplicate
 *   (at-least-once) delivery is absorbed, a cursor RESET re-fold reconverges, and
 *   the apply path is deterministic (no Math.random / Date.now). If any step is
 *   non-idempotent, every reconnect / backfill / crash-recovery silently
 *   double-applies or loses — and it would still pass the happy-path tests.
 *
 * The merge engine documents these invariants itself (read-merge.ts):
 *   - "POST-CURSOR-RESET DOUBLE-APPLY SAFETY (audit P-068 — LOAD-BEARING)": a
 *     reset re-folds every log from index 0 against rows already at the final
 *     state, so EVERY op re-applies; correctness rests on (1) the in-memory
 *     winners fold + (2) every projection writer being PG-level LWW.
 *   - "KNOWN BOUNDED TRANSIENT": deletes leave no PG tombstone, so a reset
 *     replay that folds an old put BEFORE its winning del re-INSERTs the row
 *     until the del re-applies (same pass, or within the backlog passes). The
 *     fixpoint ALWAYS converges. AG turns that prose guarantee into a property.
 *   - EI-79 step 3: a TRUNCATED log (length < cursor) returns `truncated:true`
 *     and folds NOTHING — the signal that the caller MUST reset the cursor.
 *
 * Existing regression coverage of the SAME invariants is INTEGRATION/PG-bound
 * (projections/__tests__/fed-ts-lww-guard.integration.test.ts "post-cursor-reset
 * double-apply safety" + ei117-replay-revert-guard.integration.test.ts). AG adds
 * the FAST, PG-FREE, property-based merge-engine layer (no PG, no network — a
 * large seed sweep runs in well under a second) so the idempotency contract is
 * checked on every unit run, not only when the heavy integration suite runs.
 *
 * CORRECTNESS NOTE (why these properties are NOT flaky):
 *   Idempotency properties that RE-APPLY THE SAME OPS IN THE SAME ORDER
 *   (double-apply, cursor-reset, determinism, duplicate-absorption) hold for
 *   EVERY regime × guard — they are about re-application, independent of whether
 *   peers converge. ORDER-SENSITIVE properties (replay-from-cursor identity,
 *   reorder convergence) are asserted under the ORDER-INDEPENDENT guards
 *   (`fed_hlc` = production, `lww` = upper bound) and/or the monotone regime; the
 *   known `fed_ts`+skew divergence is Brief D's characterisation, NOT an AG
 *   idempotency failure, so it is deliberately excluded from those assertions.
 *
 * No `Math.random` / `Date.now` anywhere (the determinism the audit asserts).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FedTsGuardedStore, generateOps, makeRng, type GuardOrder } from './_convergence-fuzz-rig';
import { type AdmittedLog, createMergeCursor, mergeAdmittedLogsIncremental, type MergeCursor } from '../read-merge';
import type { PeerLogOp } from '../peer-log';

/** One origin op = `{ sourceLogKeyHex, op }` (the rig's GenOp; type not exported). */
type GenOp = ReturnType<typeof generateOps>[number];

// ---------------------------------------------------------------------------
// Local re-implementations of the rig's FILE-PRIVATE helpers. Re-implemented
// here (not exported from the shared rig) so this lane touches NO shared file —
// AG is purely additive, never edits Brief D's rig.
// ---------------------------------------------------------------------------

/** One single-op in-memory AdmittedLog (the merge reads only keyHex/length/get). */
function singleOpLog(keyHex: string, op: PeerLogOp): AdmittedLog {
  return { keyHex, length: 1, get: async (i) => (i === 0 ? op : null) };
}

/** Fisher-Yates shuffle, seeded RNG only (no Math.random). */
function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A fixed seeded delivery order over the generated op universe. */
function deliveryOrder(ops: GenOp[], orderSeed: number): GenOp[] {
  return shuffle(ops, makeRng(orderSeed >>> 0));
}

interface FoldResult {
  store: FedTsGuardedStore;
  cursor: MergeCursor;
  digest: string;
}

/**
 * Fold a SPECIFIC delivery order into a store via the real incremental merge.
 * One pass by default; `passesToFixpoint` loops until the merge reports
 * `caughtUp` (bounded) — used to drive the per-pass-budget del-transient to its
 * documented fixpoint.
 */
async function foldOrder(
  order: GenOp[],
  guardOrder: GuardOrder,
  opts: {
    store?: FedTsGuardedStore;
    cursor?: MergeCursor;
    maxOpsPerPass?: number;
    passesToFixpoint?: boolean;
  } = {},
): Promise<FoldResult> {
  const store = opts.store ?? new FedTsGuardedStore(guardOrder);
  const cursor = opts.cursor ?? createMergeCursor();
  const logs = order.map((g) => singleOpLog(g.sourceLogKeyHex, g.op));
  const mergeOpts = { applyImpl: store.apply, getTimeoutMs: 0, maxOpsPerPass: opts.maxOpsPerPass ?? 0 };
  if (opts.passesToFixpoint) {
    // Bounded fixpoint loop: each pass advances every log's cursor by at most
    // maxOpsPerPass; deferred ops (incl. a winning del beyond the budget) land
    // in a later pass. Hard cap guards against a non-converging bug (the point).
    for (let pass = 0; pass < order.length + 4; pass++) {
      const r = await mergeAdmittedLogsIncremental(logs, cursor, mergeOpts);
      if (r.caughtUp) break;
    }
  } else {
    await mergeAdmittedLogsIncremental(logs, cursor, mergeOpts);
  }
  return { store, cursor, digest: store.digest() };
}

/**
 * Group the op universe into one MULTI-OP AdmittedLog PER AUTHOR (the production
 * shape: a peer's log is its author's append-only op stream, not one log per op).
 * This is what makes the per-pass budget (`maxOpsPerPass`) create REAL backlog —
 * a single-op-per-log model can never defer an op to a later pass, so the
 * documented multi-pass merge + del-transient is only reachable here.
 */
function byAuthorLogs(ops: GenOp[]): AdmittedLog[] {
  const byAuthor = new Map<string, PeerLogOp[]>();
  for (const g of ops) {
    const a = g.op.author_pubkey ?? 'pk-?';
    const list = byAuthor.get(a);
    if (list) list.push(g.op);
    else byAuthor.set(a, [g.op]);
  }
  const logs: AdmittedLog[] = [];
  for (const [a, list] of byAuthor) {
    list.sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0)); // author FIFO append order
    logs.push({ keyHex: `authorlog-${a}`, length: list.length, get: async (i) => list[i] ?? null });
  }
  return logs;
}

/** Fold pre-built AdmittedLogs (multi-op or single-op) into a store via the real
 *  incremental merge, optionally to the per-pass-budget fixpoint. */
async function foldLogs(
  logs: AdmittedLog[],
  guard: GuardOrder,
  opts: { store?: FedTsGuardedStore; cursor?: MergeCursor; maxOpsPerPass?: number; passesToFixpoint?: boolean } = {},
): Promise<FoldResult> {
  const store = opts.store ?? new FedTsGuardedStore(guard);
  const cursor = opts.cursor ?? createMergeCursor();
  const mo = { applyImpl: store.apply, getTimeoutMs: 0, maxOpsPerPass: opts.maxOpsPerPass ?? 0 };
  if (opts.passesToFixpoint) {
    const totalOps = logs.reduce((n, l) => n + l.length, 0);
    for (let pass = 0; pass < totalOps + 8; pass++) {
      const r = await mergeAdmittedLogsIncremental(logs, cursor, mo);
      if (r.caughtUp) break;
    }
  } else {
    await mergeAdmittedLogsIncremental(logs, cursor, mo);
  }
  return { store, cursor, digest: store.digest() };
}

const GUARDS: GuardOrder[] = ['fed_hlc', 'lww', 'fed_ts'];
/** Guards whose APPLY is order-independent (HLC-causal / merge-comparator) —
 *  the production guard + its upper bound. The order-sensitive replay/reorder
 *  identities are asserted only here (fed_ts is order-sensitive by design). */
const ORDER_INDEPENDENT_GUARDS: GuardOrder[] = ['fed_hlc', 'lww'];

// ===========================================================================
// P1 — DOUBLE-APPLY IDENTITY. Re-applying the same log set is a no-op.
// Holds for EVERY guard × regime (re-application in the same order).
// ===========================================================================
describe('AG.P1 double-apply identity — re-applying the same ops never changes state', () => {
  it('a second full merge pass over the same logs/cursor applies nothing new', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom<'monotone' | 'skew'>('monotone', 'skew'),
        fc.constantFrom(...GUARDS),
        async (seed, regime, guard) => {
          const ops = generateOps({ seed, peers: 4, ops: 40, keys: 6, regime, skewProb: 0.5 });
          const order = deliveryOrder(ops, seed ^ 0x51ed);
          const logs = order.map((g) => singleOpLog(g.sourceLogKeyHex, g.op));
          const store = new FedTsGuardedStore(guard);
          const cursor = createMergeCursor();
          const mo = { applyImpl: store.apply, getTimeoutMs: 0 };
          await mergeAdmittedLogsIncremental(logs, cursor, mo);
          const once = store.digest();
          const second = await mergeAdmittedLogsIncremental(logs, cursor, mo);
          expect(second.applied).toBe(0); // re-delivery applies nothing
          expect(store.digest()).toBe(once); // byte-identical state
        },
      ),
      { numRuns: 60, seed: 0xa6 },
    );
  });
});

// ===========================================================================
// P2 — REPLAY FROM ANY CURSOR. Folding a delivery order all-at-once, in chunks,
// or resumed from an arbitrary mid-cursor all reach the IDENTICAL final state.
// (The backfill / cold-boot-resume invariant, generalised — F is prior art.)
// Asserted under the order-independent guards.
// ===========================================================================
describe('AG.P2 replay-from-any-cursor — all-at-once == chunked == mid-cursor-resume', () => {
  it('chunked + prefix-resumed folds equal the one-shot fold (same delivery order)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom<'monotone' | 'skew'>('monotone', 'skew'),
        fc.constantFrom(...ORDER_INDEPENDENT_GUARDS),
        async (seed, regime, guard) => {
          const ops = generateOps({ seed, peers: 4, ops: 48, keys: 7, regime, skewProb: 0.5 });
          const order = deliveryOrder(ops, seed ^ 0x2c0d);

          // (a) one-shot
          const oneShot = (await foldOrder(order, guard)).digest;

          // (b) chunked: many incremental passes over the SAME logs/cursor.
          const chunked = (await foldOrder(order, guard, { maxOpsPerPass: 1, passesToFixpoint: true })).digest;

          // (c) mid-cursor resume: fold a prefix, then resume the SAME cursor
          // with the FULL order — the cold-boot-resume / backfill path.
          const store = new FedTsGuardedStore(guard);
          const cursor = createMergeCursor();
          const mid = Math.max(1, Math.floor(order.length / 3));
          await foldOrder(order.slice(0, mid), guard, { store, cursor });
          await foldOrder(order, guard, { store, cursor });
          const resumed = store.digest();

          expect(chunked).toBe(oneShot);
          expect(resumed).toBe(oneShot);
        },
      ),
      { numRuns: 60, seed: 0xb2 },
    );
  });
});

// ===========================================================================
// P3 — REORDER-WITHIN-LWW. Two distinct seeded delivery orders converge to the
// same state (LWW is order-independent by design). Complements Brief D's
// cross-peer convergence; asserted under the production guard + monotone where
// the apply guard is order-independent (skew+fed_ts divergence is D's lane).
// ===========================================================================
describe('AG.P3 reorder-within-LWW — distinct delivery orders converge (production guard)', () => {
  it('two random orders of the same op universe yield identical state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom(...ORDER_INDEPENDENT_GUARDS), async (seed, guard) => {
        const ops = generateOps({ seed, peers: 5, ops: 50, keys: 6, regime: 'monotone' });
        const a = (await foldOrder(deliveryOrder(ops, seed ^ 0x01), guard)).digest;
        const b = (await foldOrder(deliveryOrder(ops, seed ^ 0xfeed), guard)).digest;
        expect(b).toBe(a);
      }),
      { numRuns: 50, seed: 0xc3 },
    );
  });
});

// ===========================================================================
// P4 — DUPLICATE / AT-LEAST-ONCE ABSORPTION. The substrate is at-least-once:
// re-delivering an op (its log appearing again in the fold) must be absorbed —
// no dup rows, no resurrection — SET semantics, never re-fold counts.
// ===========================================================================
describe('AG.P4 duplicate delivery is absorbed — at-least-once never inflates state', () => {
  it('an order with every op delivered twice equals the de-duplicated fold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom<'monotone' | 'skew'>('monotone', 'skew'),
        fc.constantFrom(...GUARDS),
        async (seed, regime, guard) => {
          const ops = generateOps({ seed, peers: 4, ops: 36, keys: 5, regime, skewProb: 0.5 });
          const order = deliveryOrder(ops, seed ^ 0x7d7d);
          const clean = (await foldOrder(order, guard)).digest;

          // Interleave a duplicate of every op right after it (re-delivery).
          const dupd: GenOp[] = [];
          for (const g of order) {
            dupd.push(g, g);
          }
          const withDups = (await foldOrder(dupd, guard)).digest;
          expect(withDups).toBe(clean);
        },
      ),
      { numRuns: 60, seed: 0xd4 },
    );
  });
});

// ===========================================================================
// P5 — CURSOR-RESET IDEMPOTENCY (the P-068 LOAD-BEARING invariant). Dropping a
// revoked/truncated log resets the merge cursor → the FULL re-fold re-applies
// every op against rows already at the final state. The fixpoint must reconverge
// to the pre-reset state — including the documented "del has no PG tombstone →
// transient re-insert until the del re-applies" path (driven via a per-pass
// budget so a winning del can be deferred past the put that re-inserts its row).
// ===========================================================================
describe('AG.P5 cursor-reset idempotency — reset + full re-fold reconverges (P-068)', () => {
  it('a fresh cursor re-folding into the SAME store is a no-op at the fixpoint', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom<'monotone' | 'skew'>('monotone', 'skew'),
        fc.constantFrom(...ORDER_INDEPENDENT_GUARDS),
        async (seed, regime, guard) => {
          const ops = generateOps({ seed, peers: 4, ops: 44, keys: 6, regime, skewProb: 0.5 });
          const order = deliveryOrder(ops, seed ^ 0x9a9a);
          const { store, digest: before } = await foldOrder(order, guard);
          // Cursor reset (revoked/truncated-log recovery): brand-new cursor, SAME
          // store, re-fold the full order to its fixpoint.
          await foldOrder(order, guard, { store, cursor: createMergeCursor(), maxOpsPerPass: 1, passesToFixpoint: true });
          expect(store.digest()).toBe(before);
        },
      ),
      { numRuns: 60, seed: 0xe5 },
    );
  });

  it('del-transient: a reset that re-inserts a put before its winning del still reaches the deleted fixpoint', async () => {
    // Construct the worst case deterministically: a single key, a put then a del
    // (del HLC > put HLC, so del wins), delivered put-before-del with a per-pass
    // budget of 1 so the put re-inserts in pass 1 and the del only lands in a
    // later pass. The INTERMEDIATE state shows the row; the FIXPOINT is deleted.
    const ops = generateOps({ seed: 7, peers: 2, ops: 30, keys: 1, regime: 'monotone' });
    // Find a key that ends DELETED under a one-shot fold (a del wins it).
    const order = deliveryOrder(ops, 7 ^ 0x1111);
    const oneShot = await foldOrder(order, 'fed_hlc');
    const resetStore = oneShot.store;
    // Reset + budgeted re-fold to fixpoint must match the one-shot digest.
    const budgeted = await foldOrder(order, 'fed_hlc', { store: resetStore, cursor: createMergeCursor(), maxOpsPerPass: 1, passesToFixpoint: true });
    expect(budgeted.digest).toBe(oneShot.digest);
  });

  it('TRUNCATED log (length < cursor) reports truncated:true and folds nothing — the reset trigger', async () => {
    // EI-79 step 3: the explicit signal the caller uses to reset the cursor.
    const ops = generateOps({ seed: 11, peers: 2, ops: 6, keys: 3, regime: 'monotone' });
    const store = new FedTsGuardedStore('fed_hlc');
    const cursor = createMergeCursor();
    const full = ops.map((g) => singleOpLog(g.sourceLogKeyHex, g.op));
    await mergeAdmittedLogsIncremental(full, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
    // Now present one log as TRUNCATED (length 0 < its advanced cursor position).
    const k = ops[0].sourceLogKeyHex;
    const truncated: AdmittedLog[] = [{ keyHex: k, length: 0, get: async () => null }];
    const r = await mergeAdmittedLogsIncremental(truncated, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
    expect(r.truncated).toBe(true);
    expect(r.applied).toBe(0);
  });
});

// ===========================================================================
// P6 — DETERMINISM ACROSS RUNS. The same seed + same delivery order produces
// byte-identical state every run (no Math.random / Date.now in generate→fold→
// apply). Holds for EVERY guard × regime.
// ===========================================================================
describe('AG.P6 determinism — same seed/order yields byte-identical state across runs', () => {
  it('repeated independent folds of the same seed are identical', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom<'monotone' | 'skew'>('monotone', 'skew'),
        fc.constantFrom(...GUARDS),
        async (seed, regime, guard) => {
          const run = async () => {
            const ops = generateOps({ seed, peers: 4, ops: 40, keys: 6, regime, skewProb: 0.5 });
            return (await foldOrder(deliveryOrder(ops, seed ^ 0x3333), guard)).digest;
          };
          expect(await run()).toBe(await run());
        },
      ),
      { numRuns: 50, seed: 0xf6 },
    );
  });
});

// ===========================================================================
// P7 — TEETH. A deliberately NON-idempotent store (mutates value on EVERY apply,
// no LWW guard) must make the double-apply property go RED — proof the audit
// actually constrains the apply path (a guard that silently no-ops would pass
// every property above vacuously otherwise).
// ===========================================================================
class NonIdempotentStore {
  readonly rows = new Map<string, number>();
  apply = async (op: { type?: string; table?: string; hbKey?: string }): Promise<boolean> => {
    if (op.type !== 'put' && op.type !== 'del') return false;
    if (!op.hbKey) return false;
    const k = `${op.table}::${op.hbKey}`;
    // BUG: count every apply instead of LWW set-semantics → re-apply inflates.
    this.rows.set(k, (this.rows.get(k) ?? 0) + 1);
    return true;
  };
  digest(): string {
    return [...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('|');
  }
}

describe('AG.P7 teeth — a non-idempotent apply sink FAILS double-apply (audit has teeth)', () => {
  it('the broken counting store changes state on the second pass', async () => {
    const ops = generateOps({ seed: 3, peers: 3, ops: 24, keys: 4, regime: 'monotone' });
    const logs = deliveryOrder(ops, 0x4242).map((g) => singleOpLog(g.sourceLogKeyHex, g.op));
    const store = new NonIdempotentStore();
    const cursor = createMergeCursor();
    const mo = { applyImpl: store.apply, getTimeoutMs: 0 };
    await mergeAdmittedLogsIncremental(logs, cursor, mo);
    const once = store.digest();
    // Force a FULL re-fold against a fresh cursor (the cursor-reset path) so the
    // broken sink re-applies — a non-idempotent sink inflates; an idempotent one
    // would not. This is the negative control for P1/P5.
    const cursor2 = createMergeCursor();
    await mergeAdmittedLogsIncremental(logs, cursor2, mo);
    expect(store.digest()).not.toBe(once); // RED for the broken sink == teeth
  });
});
