/**
 * pg-merge-cursor.test.ts — WI-2105 REV fix: durable per-log merge-cursor
 * persistence (PG-cursor). Unit layer: pure functions + in-memory fakes (a fake
 * `MergeCursorStore` + fake `AdmittedLog`s), NO PG/Docker.
 *
 * Proves the three properties the REV-leg fix rests on:
 *   1. seedCursorFromPg RESUMES a fold from persisted positions (a restart folds
 *      only the tail, not from 0 — the whole point vs the in-memory cursor that
 *      reset every bg-host restart and starved routinesTick → the REV loop).
 *   2. PERSIST-AFTER-APPLY (17c98's correctness invariant, mr5ymwgw): every
 *      persisted position is <= the count of ops whose apply has committed, so a
 *      crash between apply and persist RE-folds the last batch idempotently
 *      rather than SKIPPING it. With distinct keys (every op applies) the
 *      persisted position EQUALS the applied count at each persist point.
 *   3. INTRA-PASS persistence: a single pass over a > MERGE_PERSIST_EVERY_OPS
 *      backlog checkpoints progress MID-pass (not only after it returns), so a
 *      pass that outlasts the 240s bg-host watchdog still advances monotonically.
 *
 * RUN (unit — no PG/Docker):
 *   cd packages/operator-core && npx vitest run \
 *     lib/sync/hyperbee/__tests__/pg-merge-cursor.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  createPgMergeCursorSeedCache,
  seedCursorFromPg,
  persistCursor,
  MERGE_PERSIST_EVERY_OPS,
  type AdmittedLog,
  type MergeCursor,
  type MergeCursorStore,
} from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

function fakeLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return {
    keyHex,
    get length() {
      return ops.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      return ops[i] ?? null;
    },
  };
}

function put(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value: { id: hbKey, ts }, ts, schema_version: 1, author_pubkey: 'pk' } as PeerLogOp;
}

/** An in-memory MergeCursorStore (== the PG store's contract), so the seam is
 *  exercised without a live PG. Records every save for assertions.
 *
 *  EI-18773697830188393: mirrors the PG store's SCOPE STAMP — each row carries the
 *  `apply_binding` it was folded under, `load(binding)` returns only rows matching it
 *  (NULL-safe, like the real `IS NOT DISTINCT FROM`), and a save RE-STAMPS the row.
 *  `initialBinding` is the stamp pre-seeded rows carry (default null == a pre-migration
 *  row / a fold under no pot-home scope). */
function fakeStore(
  initial?: Map<string, number>,
  initialBinding: string | null = null,
): MergeCursorStore & {
  saves: Array<Map<string, number>>;
  saveBindings: Array<string | null>;
  loadBindings: Array<string | null>;
  data: Map<string, number>;
  bindings: Map<string, string | null>;
} {
  const data = new Map<string, number>(initial ?? []);
  const bindings = new Map<string, string | null>();
  for (const k of data.keys()) bindings.set(k, initialBinding);
  const saves: Array<Map<string, number>> = [];
  const saveBindings: Array<string | null> = [];
  const loadBindings: Array<string | null> = [];
  return {
    data,
    bindings,
    saves,
    saveBindings,
    loadBindings,
    async load(applyBinding: string | null) {
      loadBindings.push(applyBinding ?? null);
      const out = new Map<string, number>();
      for (const [k, v] of data) {
        if ((bindings.get(k) ?? null) === (applyBinding ?? null)) out.set(k, v);
      }
      return out;
    },
    async save(positions, applyBinding: string | null) {
      // Snapshot the map at save time (the live cursor map mutates after).
      saves.push(new Map(positions));
      saveBindings.push(applyBinding ?? null);
      for (const [k, v] of positions) {
        data.set(k, v);
        bindings.set(k, applyBinding ?? null);
      }
    },
  };
}

/** N distinct-key puts on one log — every op applies (no LWW losers), so
 *  applied == decoded == cursor position throughout. */
function distinctLog(keyHex: string, n: number): AdmittedLog {
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < n; i++) ops.push(put('features_consolidated', `${keyHex}-K${i}`, 1000 + i));
  return fakeLog(keyHex, ops);
}

describe('seedCursorFromPg (WI-2105)', () => {
  it('seeds each log at its persisted position (fresh cursor)', async () => {
    const store = fakeStore(new Map([['logA', 40], ['logB', 12]]));
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store, null);
    expect(cursor.positions.get('logA')).toBe(40);
    expect(cursor.positions.get('logB')).toBe(12);
  });

  it('never rewinds a log that already has an in-memory position (idempotent)', async () => {
    const store = fakeStore(new Map([['logA', 40]]));
    const cursor = createMergeCursor();
    cursor.positions.set('logA', 55); // a live fold already ahead of PG
    await seedCursorFromPg(cursor, store, null);
    expect(cursor.positions.get('logA')).toBe(55); // NOT rewound to 40
  });

  it('ignores a persisted position of 0 (fold-from-0, nothing to skip)', async () => {
    const store = fakeStore(new Map([['logA', 0]]));
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store, null);
    expect(cursor.positions.has('logA')).toBe(false);
  });
});

describe('PgMergeCursorSeedCache (EI-20317490590418053 late admission)', () => {
  it('loads once, seeds only admitted keys, and reuses the cache for a later admission', async () => {
    const store = fakeStore(new Map([['own', 8], ['remote-late', 62_256]]));
    const seedCache = createPgMergeCursorSeedCache();
    const cursor = createMergeCursor();

    await seedCache.seed(cursor, store, null, ['own']);
    expect(cursor.positions.get('own')).toBe(8);
    expect(cursor.positions.has('remote-late')).toBe(false);
    expect(store.loadBindings).toEqual([null]);

    await seedCache.seed(cursor, store, null, ['own', 'remote-late']);
    expect(cursor.positions.get('remote-late')).toBe(62_256);
    expect(store.loadBindings).toEqual([null]); // cache reuse — no second PG read
  });

  it('never reuses or reloads cached progress after a real fold invalidation', async () => {
    const store = fakeStore(new Map([['remote', 62_256]]));
    const seedCache = createPgMergeCursorSeedCache();
    const beforeReset = createMergeCursor();
    await seedCache.seed(beforeReset, store, null, ['remote']);
    expect(beforeReset.positions.get('remote')).toBe(62_256);

    seedCache.invalidate();
    const afterReset = createMergeCursor();
    await seedCache.seed(afterReset, store, null, ['remote']);
    expect(afterReset.positions.has('remote')).toBe(false);
    expect(store.loadBindings).toEqual([null]);
  });
});

describe('persistCursor (WI-2105)', () => {
  it('writes the positions through to the injected store', async () => {
    const store = fakeStore();
    await persistCursor(new Map([['logA', 7]]), store, null);
    expect(store.data.get('logA')).toBe(7);
  });
});

/** Fold `log` from a cursor, persisting via onCursorAdvance, tracking the
 *  committed-apply count so we can assert persist-after-apply at each persist. */
async function foldWithPersist(
  log: AdmittedLog,
  cursor: MergeCursor,
  store: MergeCursorStore,
  /** EI-18773697830188393: the apply binding (pot-home projection scope) this fold runs
   *  under — stamped onto every persisted position. Default null == no pot-home scope. */
  applyBinding: string | null = null,
): Promise<{ decoded: number; applied: number; persistVsApplied: Array<{ persisted: number; applied: number }> }> {
  let appliedCount = 0;
  const persistVsApplied: Array<{ persisted: number; applied: number }> = [];
  const result = await mergeAdmittedLogsIncremental([log], cursor, {
    getTimeoutMs: 0,
    // apply commits synchronously BEFORE any subsequent persist fires.
    applyImpl: async (_op: OpEnvelope) => {
      appliedCount++;
      return true;
    },
    onCursorAdvance: async (positions) => {
      persistVsApplied.push({ persisted: positions.get(log.keyHex) ?? 0, applied: appliedCount });
      await store.save(positions, applyBinding);
    },
  });
  return { decoded: result.decoded, applied: result.applied, persistVsApplied };
}

describe('mergeAdmittedLogsIncremental onCursorAdvance — persist-after-apply (WI-2105)', () => {
  it('every persisted position <= committed-apply count (crash re-folds, never skips)', async () => {
    const log = distinctLog('logA', 120);
    const store = fakeStore();
    const { persistVsApplied } = await foldWithPersist(log, createMergeCursor(), store);
    expect(persistVsApplied.length).toBeGreaterThan(0);
    for (const { persisted, applied } of persistVsApplied) {
      // The invariant: a persisted position is never AHEAD of durably-applied
      // ops → a crash at that point re-folds [persisted, …) idempotently.
      expect(persisted).toBeLessThanOrEqual(applied);
      // Distinct keys ⇒ every op applied ⇒ position EQUALS applied at persist.
      expect(persisted).toBe(applied);
    }
    // Final persisted position == full length.
    expect(store.data.get('logA')).toBe(120);
  });

  it('persists INTRA-pass for a backlog > MERGE_PERSIST_EVERY_OPS (survives a watchdog kill mid-pass)', async () => {
    const n = MERGE_PERSIST_EVERY_OPS + 1; // one op past the persist cadence
    const log = distinctLog('logBig', n);
    const store = fakeStore();
    const { persistVsApplied } = await foldWithPersist(log, createMergeCursor(), store);
    // At least one persist fired STRICTLY before the log completed — that is the
    // intra-pass checkpoint (persist-after-pass alone would capture nothing here,
    // the WI-2105 REV restart loop). And the cadence checkpoint lands at exactly
    // MERGE_PERSIST_EVERY_OPS.
    const positions = persistVsApplied.map((p) => p.persisted);
    expect(positions.some((p) => p > 0 && p < n)).toBe(true);
    // The cadence checkpoint fires at the top of the (MERGE_PERSIST_EVERY_OPS)th
    // iteration — BEFORE reading that op — so it persists the committed-apply
    // count so far == MERGE_PERSIST_EVERY_OPS - 1 (persist-after-apply, never ahead).
    expect(positions).toContain(MERGE_PERSIST_EVERY_OPS - 1);
    expect(store.data.get('logBig')).toBe(n);
  });
});

describe('restart-resume via PG-cursor (WI-2105 — the REV-leg fix)', () => {
  it('a seeded cursor folds ONLY the tail, not from 0 (monotonic across a restart)', async () => {
    // Boot 1: fold 100 ops, persisting positions to the store.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 100; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));
    const store = fakeStore();
    const boot1 = await foldWithPersist(fakeLog('logA', [...ops]), createMergeCursor(), store);
    expect(boot1.decoded).toBe(100);
    expect(store.data.get('logA')).toBe(100);

    // 10 more ops land while "offline".
    for (let i = 100; i < 110; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));

    // Boot 2 (restart): a FRESH cursor SEEDED from PG resumes at 100 → the fold
    // decodes only the 10-op tail, NOT all 110 from 0. This is exactly what makes
    // a large orphaned log's fold complete across restarts instead of looping.
    const cursor2 = createMergeCursor();
    await seedCursorFromPg(cursor2, store, null);
    expect(cursor2.positions.get('logA')).toBe(100);
    const boot2 = await foldWithPersist(fakeLog('logA', [...ops]), cursor2, store);
    expect(boot2.decoded).toBe(10); // tail only — the resume win
    expect(store.data.get('logA')).toBe(110);
  });

  it('crash-consistency: re-folding from a mid-fold persisted position converges (idempotent)', async () => {
    // Simulate a crash after persisting position 60 of a 100-op log, then a
    // restart that re-folds [60,100). LWW-idempotent apply ⇒ same final applied
    // set as an uninterrupted fold; no op is skipped (persist was after apply).
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 100; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));
    const store = fakeStore(new Map([['logA', 60]])); // persisted mid-fold pre-crash
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store, null);
    const applied: string[] = [];
    const result = await mergeAdmittedLogsIncremental([fakeLog('logA', ops)], cursor, {
      getTimeoutMs: 0,
      applyImpl: async (op: OpEnvelope) => {
        applied.push(op.hbKey ?? '');
        return true;
      },
    });
    // Only the un-persisted tail [60,100) re-folds — the persisted prefix's applies
    // already committed pre-crash, so re-folding them would be redundant, not wrong.
    expect(result.decoded).toBe(40);
    expect(applied).toEqual(Array.from({ length: 40 }, (_, i) => `K${60 + i}`));
  });
});

/**
 * EI-18773697830188393 — a joiner whose hive-home binding is CORRECTED must re-apply the
 * rows it dropped while mis-bound.
 *
 * The trap WI-2105 left behind: a persisted position claims "every op below this index
 * was APPLIED", but whether an op applies is decided by the pot-home projection scope it
 * was folded through (the federation demux key). Fold under the WRONG scope and the op is
 * DROPPED while the cursor advances past it anyway — so the position is a lie the moment
 * the scope changes. Live (WI-559): fed-b bound the shared hive to its local slug and
 * discarded ~49,762 inbound rows this way; fixing the binding was not enough, because the
 * next COLD boot seeded from that stale progress and resumed past the very owner
 * `hive_members` rows it had dropped, so `pot_members` never repopulated. `forceReFold`
 * (boot.ts, the rekey rebind) covers only the mid-session path, never a cold boot.
 *
 * The fix makes the cursor's validity INTRINSIC to the scope it was computed under: each
 * persisted row is stamped with its apply binding and only same-stamp progress is
 * resumable.
 */
describe('scope-stamped cursor — cold-boot self-heal after a binding change (EI-18773697830188393)', () => {
  const OWNER_HOME = 'spoon-knife-pot'; // the owner-authored hive-home (correct)
  const LOCAL_SLUG = 'octocat-spoon-knife'; // the joiner's local slug (the WI-559 mis-binding)

  it('does NOT resume progress recorded under a DIFFERENT binding (re-folds from 0)', async () => {
    // Progress was folded under the joiner's WRONG local-slug binding.
    const store = fakeStore(new Map([['logOwner', 49762]]), LOCAL_SLUG);
    const cursor = createMergeCursor();
    // A later boot resolves the CORRECT hive-home → that progress is not resumable.
    await seedCursorFromPg(cursor, store, OWNER_HOME);
    expect(cursor.positions.has('logOwner')).toBe(false);
  });

  it('DOES resume progress recorded under the SAME binding (no re-fold storm)', async () => {
    const store = fakeStore(new Map([['logOwner', 49762]]), OWNER_HOME);
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store, OWNER_HOME);
    expect(cursor.positions.get('logOwner')).toBe(49762);
  });

  it('a NULL binding matches the NULL stamp — non-hive harnesses + hive OWNERS resume unchanged', async () => {
    // The blast-radius guarantee: pre-migration rows carry NULL, and a harness with no
    // pot-home scope folds with NULL, so the overwhelming majority of boots are
    // byte-identical to pre-fix behaviour. (A `=` comparison would three-valued-miss
    // here and silently re-fold every such harness on EVERY boot.)
    const store = fakeStore(new Map([['logA', 40]]), null);
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store, null);
    expect(cursor.positions.get('logA')).toBe(40);
  });

  it('heals EXACTLY ONCE: the re-fold re-stamps, so the NEXT boot resumes normally', async () => {
    // Boot 1 (post-migration, pre-existing rows carry NULL) — a hive joiner now folds
    // under its hive-home, so the stale NULL-stamped progress must be discarded...
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 100; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));
    const store = fakeStore(new Map([['logOwner', 100]]), null);

    const cursor1 = createMergeCursor();
    await seedCursorFromPg(cursor1, store, OWNER_HOME);
    expect(cursor1.positions.has('logOwner')).toBe(false); // discarded → full re-fold
    const boot1 = await foldWithPersist(fakeLog('logOwner', [...ops]), cursor1, store, OWNER_HOME);
    expect(boot1.decoded).toBe(100); // every dropped op re-folded through the right scope
    expect(store.bindings.get('logOwner')).toBe(OWNER_HOME); // re-stamped by the fold

    // ...but boot 2 under the SAME binding must NOT re-fold again (a re-fold on every
    // boot would re-introduce the WI-2105 REV starvation loop this table exists to stop).
    const cursor2 = createMergeCursor();
    await seedCursorFromPg(cursor2, store, OWNER_HOME);
    expect(cursor2.positions.get('logOwner')).toBe(100);
    const boot2 = await foldWithPersist(fakeLog('logOwner', [...ops]), cursor2, store, OWNER_HOME);
    expect(boot2.decoded).toBe(0);
  });

  it('heals PER LOG: a log already re-stamped resumes while a still-stale log re-folds', async () => {
    // A crash mid-heal leaves the set mixed. Per-row stamps mean each log is judged on
    // its own progress — no all-or-nothing reset, no stale log silently resumed.
    const store = fakeStore(new Map([['logDone', 100]]), OWNER_HOME);
    store.data.set('logStale', 5000);
    store.bindings.set('logStale', LOCAL_SLUG);

    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store, OWNER_HOME);
    expect(cursor.positions.get('logDone')).toBe(100);
    expect(cursor.positions.has('logStale')).toBe(false);
  });

  it('END-TO-END: ops DROPPED by a wrong scope (cursor advanced past them) re-apply after the binding is corrected', async () => {
    // The live failure, reproduced: a demux that drops every op whose row-scope !== the
    // bound scope, while the cursor advances regardless.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 30; i++) ops.push(put('hive_members', `M${i}`, 1000 + i));
    const store = fakeStore();

    const foldUnder = async (binding: string, cursor: MergeCursor) => {
      const applied: string[] = [];
      await mergeAdmittedLogsIncremental([fakeLog('logOwner', ops)], cursor, {
        getTimeoutMs: 0,
        // The demux: the owner authored these rows under OWNER_HOME, so a joiner bound to
        // its LOCAL slug drops every one of them — yet still reports the fold as done.
        applyImpl: async (op: OpEnvelope) => {
          if (binding !== OWNER_HOME) return false; // dropped (hive_home_slug mismatch)
          applied.push(op.hbKey ?? '');
          return true;
        },
        onCursorAdvance: async (positions) => store.save(positions, binding),
      });
      return applied;
    };

    // Boot 1 — mis-bound: nothing applies, but the cursor is persisted as complete.
    const misApplied = await foldUnder(LOCAL_SLUG, createMergeCursor());
    expect(misApplied).toEqual([]); // the whole-hive blackout
    expect(store.data.get('logOwner')).toBe(30); // ...recorded as fully folded

    // Boot 2 — binding corrected. WITHOUT the stamp this seeds at 30 and applies NOTHING
    // (the bug: pot_members stays empty forever). WITH it, the stale progress is
    // discarded and every dropped row re-applies.
    const cursor2 = createMergeCursor();
    await seedCursorFromPg(cursor2, store, OWNER_HOME);
    const healed = await foldUnder(OWNER_HOME, cursor2);
    expect(healed).toEqual(Array.from({ length: 30 }, (_, i) => `M${i}`));
  });

  it('fails SAFE: an unresolvable binding costs a redundant re-fold, never a skipped op', async () => {
    // `resolveHiveHomeProjectionSlug` fails OPEN (returns undefined) on a transient
    // resolve error, so a boot can legitimately fold under a null scope. The stamp is
    // DESCRIPTIVE — it records the scope progress was actually computed under — so every
    // mismatch resolves toward re-folding (idempotent LWW), never toward resuming across
    // a scope it was not folded under. Redundant work is the only failure mode.
    const store = fakeStore(new Map([['logOwner', 100]]), OWNER_HOME);
    const degraded = createMergeCursor();
    await seedCursorFromPg(degraded, store, null); // resolve failed → fail-open null
    expect(degraded.positions.has('logOwner')).toBe(false); // re-fold, not a silent skip

    // And once the resolve recovers, the null-stamped progress is likewise not trusted.
    await store.save(new Map([['logOwner', 100]]), null);
    const recovered = createMergeCursor();
    await seedCursorFromPg(recovered, store, OWNER_HOME);
    expect(recovered.positions.has('logOwner')).toBe(false);
  });
});
