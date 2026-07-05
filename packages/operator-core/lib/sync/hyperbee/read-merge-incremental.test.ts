/**
 * read-merge-incremental.test.ts — the EI-79 residual's correctness contract
 * (p2p-performance-suite-2026-06-07 P-013; fixes EI-91).
 *
 * The incremental cursor merge must be SEMANTICALLY IDENTICAL to the
 * from-scratch full fold — same winners, regardless of how passes/chunks
 * slice the history — while reading each op exactly once (O(delta)) and
 * never losing history to the per-pass budget.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import {
  createMergeCursor,
  mergeAdmittedLogs,
  mergeAdmittedLogsIncremental,
  type AdmittedLog,
} from './read-merge';
import { generateCorpus } from './perf/corpus';
import { mulberry32 } from './perf/corpus';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog & { ops: PeerLogOp[] } {
  return {
    keyHex,
    ops,
    get length() {
      return ops.length;
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  };
}

/** Capture-apply: records the FINAL applied state per group key. */
function captureApply() {
  const state = new Map<string, OpEnvelope>();
  const apply = async (env: OpEnvelope): Promise<boolean> => {
    state.set(`${env.table}::${env.hbKey}`, env);
    return true;
  };
  return { state, apply };
}

function corpusOps(seed: number, count: number, author: string, baseTs: number): PeerLogOp[] {
  return [...generateCorpus({ seed, count, authorPubkey: author, baseTs })];
}

describe('mergeAdmittedLogsIncremental ≡ mergeAdmittedLogs (winner equivalence)', () => {
  it('arbitrary chunking across passes lands on the identical winner state', async () => {
    // 3 logs, interleaved ts ranges so cross-author LWW conflicts are real.
    const logsFull = [
      memLog('a'.repeat(64), corpusOps(1, 800, 'a'.repeat(64), 1_700_000_000_000)),
      memLog('b'.repeat(64), corpusOps(2, 800, 'b'.repeat(64), 1_700_000_000_400)),
      memLog('c'.repeat(64), corpusOps(3, 800, 'c'.repeat(64), 1_700_000_000_800)),
    ];

    // Reference: the from-scratch full fold.
    const ref = captureApply();
    await mergeAdmittedLogs(logsFull, { applyImpl: ref.apply, maxOpsPerAuthor: 0, getTimeoutMs: 0 });

    // Incremental: drive passes with a small, randomized per-pass budget until
    // caught up — the cursor must cross chunk boundaries mid-history.
    const inc = captureApply();
    const cursor = createMergeCursor();
    const rnd = mulberry32(7);
    for (let guard = 0; guard < 200; guard++) {
      const res = await mergeAdmittedLogsIncremental(logsFull, cursor, {
        applyImpl: inc.apply,
        maxOpsPerPass: 50 + Math.floor(rnd() * 200),
        getTimeoutMs: 0,
      });
      if (res.caughtUp) break;
    }

    // Same keys, and for every key the same winning (ts, type, source).
    expect(new Set(inc.state.keys())).toEqual(new Set(ref.state.keys()));
    for (const [key, refEnv] of ref.state) {
      const incEnv = inc.state.get(key)!;
      expect(
        { ts: incEnv.ts, type: incEnv.type, src: incEnv.sourceLogKeyHex },
        `winner mismatch for ${key}`,
      ).toEqual({ ts: refEnv.ts, type: refEnv.type, src: refEnv.sourceLogKeyHex });
    }
  });

  it('ops streamed across MANY passes (live appends) converge to the batch result', async () => {
    const author = 'd'.repeat(64);
    const all = corpusOps(11, 600, author, 1_700_000_000_000);

    const ref = captureApply();
    await mergeAdmittedLogs([memLog(author, all)], {
      applyImpl: ref.apply,
      maxOpsPerAuthor: 0,
      getTimeoutMs: 0,
    });

    // Live: the log grows between passes.
    const live: PeerLogOp[] = [];
    const log = memLog(author, live);
    const inc = captureApply();
    const cursor = createMergeCursor();
    let fed = 0;
    while (fed < all.length) {
      live.push(...all.slice(fed, fed + 37));
      fed = live.length;
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: inc.apply, getTimeoutMs: 0 });
    }
    expect(new Set(inc.state.keys())).toEqual(new Set(ref.state.keys()));
    for (const [key, refEnv] of ref.state) {
      expect(inc.state.get(key)!.ts).toBe(refEnv.ts);
      expect(inc.state.get(key)!.type).toBe(refEnv.type);
    }
  });
});

describe('O(delta) + ts-guarded apply (the EI-79 residual contract)', () => {
  it('decodes each op exactly once across passes; a 1-op delta costs 1 decode', async () => {
    const author = 'e'.repeat(64);
    const ops = corpusOps(21, 500, author, 1_700_000_000_000);
    const log = memLog(author, [...ops]);
    const cursor = createMergeCursor();
    const apply = vi.fn(async () => true);

    const first = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
    });
    expect(first.decoded).toBe(500);
    expect(first.caughtUp).toBe(true);

    // Idle pass: zero decodes.
    const idle = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
    });
    expect(idle.decoded).toBe(0);
    expect(idle.applied).toBe(0);

    // One appended op → exactly one decode, at most one apply.
    log.ops.push({
      type: 'put',
      table: 'features-by-id',
      hbKey: 'F-delta',
      value: { x: 1 },
      ts: 1_700_999_999_999,
      schema_version: 1,
      author_pubkey: author,
    });
    const delta = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
    });
    expect(delta.decoded).toBe(1);
    expect(delta.applied).toBe(1);
  });

  it('a stale op (older than the standing winner) is never handed to the apply sink', async () => {
    const a = 'f'.repeat(64);
    const b = '9'.repeat(64);
    const newer = memLog(a, [
      { type: 'put', table: 't', hbKey: 'k', value: { v: 'new' }, ts: 2000, schema_version: 1, author_pubkey: a },
    ]);
    const older = memLog(b, [
      { type: 'put', table: 't', hbKey: 'k', value: { v: 'old' }, ts: 1000, schema_version: 1, author_pubkey: b },
    ]);
    const applied: OpEnvelope[] = [];
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([newer, older], cursor, {
      applyImpl: async (env) => {
        applied.push(env);
        return true;
      },
      getTimeoutMs: 0,
    });
    expect(applied).toHaveLength(1);
    expect((applied[0].value as { v: string }).v).toBe('new');

    // The older op arriving LATER (different log order next time) also never applies.
    const applied2: OpEnvelope[] = [];
    const cursor2 = createMergeCursor();
    await mergeAdmittedLogsIncremental([newer], cursor2, {
      applyImpl: async (env) => {
        applied2.push(env);
        return true;
      },
      getTimeoutMs: 0,
    });
    await mergeAdmittedLogsIncremental([newer, older], cursor2, {
      applyImpl: async (env) => {
        applied2.push(env);
        return true;
      },
      getTimeoutMs: 0,
    });
    expect(applied2.map((e) => (e.value as { v: string }).v)).toEqual(['new']);
  });

  it('EI-91: history beyond the per-pass budget drains across passes — nothing is ever lost', async () => {
    const author = 'a1'.repeat(32);
    // 130 ops with UNIQUE keys so every op must eventually apply.
    const ops: PeerLogOp[] = Array.from({ length: 130 }, (_, i) => ({
      type: 'put' as const,
      table: 'features-by-id',
      hbKey: `F-${i}`,
      value: { i },
      ts: 1_700_000_000_000 + i,
      schema_version: 1,
      author_pubkey: author,
    }));
    const log = memLog(author, ops);
    const cursor = createMergeCursor();
    const seen = new Set<string>();
    const backlogged: Array<[number, number]> = [];

    let passes = 0;
    for (;;) {
      const res = await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: async (env) => {
          seen.add(env.hbKey!);
          return true;
        },
        maxOpsPerPass: 50,
        getTimeoutMs: 0,
        onBacklog: (_k, pos, len) => backlogged.push([pos, len]),
      });
      passes++;
      if (res.caughtUp) break;
      expect(passes).toBeLessThan(10);
    }

    expect(passes).toBe(3); // 50 + 50 + 30
    expect(seen.size).toBe(130); // the legacy cap would have stopped at 50 forever
    expect(backlogged.length).toBeGreaterThan(0); // observability hook fired while behind
  });

  it('EI-79 step 3: a TRUNCATED log (length < cursor) returns {truncated} and folds nothing', async () => {
    const author = 'c3'.repeat(32);
    const ops: PeerLogOp[] = Array.from({ length: 20 }, (_, i) => ({
      type: 'put' as const,
      table: 't',
      hbKey: `k-${i}`,
      value: { i },
      ts: 1000 + i,
      schema_version: 1,
      author_pubkey: author,
    }));
    const log = memLog(author, [...ops]);
    const cursor = createMergeCursor();
    const apply = vi.fn(async () => true);

    // First pass catches up: cursor.position = 20.
    const r1 = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(r1.caughtUp).toBe(true);
    expect(r1.truncated).toBe(false);
    expect(cursor.positions.get(author)).toBe(20);

    // The log is TRUNCATED below the cursor (a reset / forked peer log).
    log.ops.length = 5;
    const callsBefore = apply.mock.calls.length;
    const r2 = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(r2.truncated).toBe(true);
    expect(r2.applied).toBe(0);
    expect(r2.decoded).toBe(0);
    // NOTHING was folded/applied on the truncated pass (caller must reset).
    expect(apply.mock.calls.length).toBe(callsBefore);

    // The caller's response (mirrors boot.ts): reset + re-fold from scratch lands
    // exactly the surviving log's winners.
    const fresh = createMergeCursor();
    const r3 = await mergeAdmittedLogsIncremental([log], fresh, { applyImpl: apply, getTimeoutMs: 0 });
    expect(r3.truncated).toBe(false);
    expect(r3.caughtUp).toBe(true);
    expect(r3.decoded).toBe(5); // only the 5 surviving ops
    expect(fresh.positions.get(author)).toBe(5);
  });

  it('a newly-admitted peer is ADDITIVE: its cursor starts at 0, no reset, old ops it carries lose to standing newer winners', async () => {
    const existing = 'aa'.repeat(32);
    const newcomer = 'bb'.repeat(32);
    const existingLog = memLog(existing, [
      { type: 'put', table: 't', hbKey: 'shared', value: { v: 'newer' }, ts: 5000, schema_version: 1, author_pubkey: existing },
    ]);
    const cursor = createMergeCursor();
    const applied: OpEnvelope[] = [];
    const apply = async (env: OpEnvelope) => {
      applied.push(env);
      return true;
    };
    // Fold the existing peer first → 'shared' winner is ts=5000.
    await mergeAdmittedLogsIncremental([existingLog], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(applied.at(-1)!.value).toEqual({ v: 'newer' });

    // A new peer is admitted carrying an OLDER op for the SAME key (backfill).
    // No cursor reset (additive); the standing winners map still holds ts=5000,
    // so the newcomer's older op loses and never reaches the apply sink.
    const newcomerLog = memLog(newcomer, [
      { type: 'put', table: 't', hbKey: 'shared', value: { v: 'older' }, ts: 2000, schema_version: 1, author_pubkey: newcomer },
    ]);
    const before = applied.length;
    await mergeAdmittedLogsIncremental([existingLog, newcomerLog], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    // The newcomer's old op was decoded but did NOT apply (lost LWW to ts=5000).
    expect(applied.length).toBe(before);
  });

  it('an unavailable op halts the pass for that log WITHOUT advancing (no holes)', async () => {
    const author = 'b2'.repeat(32);
    const ops: PeerLogOp[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'put' as const,
      table: 't',
      hbKey: `k-${i}`,
      value: { i },
      ts: 1000 + i,
      schema_version: 1,
      author_pubkey: author,
    }));
    let blockIndex5 = true;
    const log: AdmittedLog = {
      keyHex: author,
      get length() {
        return ops.length;
      },
      async get(i: number) {
        if (i === 5 && blockIndex5) {
          // Simulate an undownloaded remote block: never resolves (raced by timeout).
          return new Promise<never>(() => {});
        }
        return ops[i] ?? null;
      },
    };
    const cursor = createMergeCursor();
    const seen: string[] = [];
    const apply = async (env: OpEnvelope) => {
      seen.push(env.hbKey!);
      return true;
    };

    const r1 = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 50,
    });
    expect(r1.caughtUp).toBe(false);
    expect(seen).toEqual(['k-0', 'k-1', 'k-2', 'k-3', 'k-4']); // stopped AT 5, not past it

    blockIndex5 = false; // the block "downloads"
    const r2 = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 50,
    });
    expect(r2.caughtUp).toBe(true);
    expect(seen).toEqual(ops.map((o) => o.hbKey)); // resumed exactly at 5 — no hole, no re-read
  });
});

describe('event-loop yield every ~1k ops (EI-81 / audit P-021)', () => {
  /** Run `fn` with a competing setImmediate chain; count how many macrotasks
   *  got to run WHILE fn was in flight. memLog.get resolves via MICROTASK, so
   *  without an explicit yield inside the merge loop this count is 0 no matter
   *  how many ops the pass processes — the exact starvation that burned ~1.5
   *  cores at the 1Hz merge poll (EI-81). */
  async function macrotasksDuring(fn: () => Promise<unknown>): Promise<number> {
    let ticks = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);
    await fn();
    running = false;
    return ticks;
  }

  it('mergeAdmittedLogsIncremental lets macrotasks run during a large pass', async () => {
    const author = 'd4'.repeat(32);
    const log = memLog(author, corpusOps(31, 3500, author, 1_700_000_000_000));
    const cursor = createMergeCursor();
    const ticks = await macrotasksDuring(() =>
      mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: captureApply().apply,
        getTimeoutMs: 0,
      }),
    );
    expect(ticks).toBeGreaterThanOrEqual(3); // 3500 ops → ≥3 yields; 0 without the fix
  });

  it('the yield counter carries ACROSS logs (N small logs cannot dodge it)', async () => {
    const logs = Array.from({ length: 7 }, (_, n) =>
      memLog(String(n).repeat(64), corpusOps(40 + n, 500, String(n).repeat(64), 1_700_000_000_000 + n)),
    );
    const cursor = createMergeCursor();
    const ticks = await macrotasksDuring(() =>
      mergeAdmittedLogsIncremental(logs, cursor, {
        applyImpl: captureApply().apply,
        getTimeoutMs: 0,
      }),
    );
    expect(ticks).toBeGreaterThanOrEqual(3); // 7×500 = 3500 iterations total
  });

  it('mergeAdmittedLogs (the full re-fold on cursor reset) yields too', async () => {
    const author = 'e5'.repeat(32);
    const log = memLog(author, corpusOps(32, 3500, author, 1_700_000_000_000));
    const ticks = await macrotasksDuring(() =>
      mergeAdmittedLogs([log], {
        applyImpl: captureApply().apply,
        maxOpsPerAuthor: 0,
        getTimeoutMs: 0,
      }),
    );
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  // WI-2344: the op-count trigger alone assumes ops are cheap. On a from-0
  // replay against a loaded/slow PG (or wide snapshot-op expansion), a SLOW
  // op can keep the pass under the 1000-op threshold for well over the
  // MERGE_YIELD_MAX_MS budget — these pin the wall-clock trigger that fires
  // regardless of op count.
  it('mergeAdmittedLogsIncremental also yields on wall-clock time, well under 1000 ops', async () => {
    const author = 'f6'.repeat(32);
    // 12 ops × ~30ms/apply ≈ 360ms — comfortably past MERGE_YIELD_MAX_MS
    // (250ms) while nowhere near the 1000-op counter threshold.
    const log = memLog(author, corpusOps(33, 12, author, 1_700_000_000_000));
    const cursor = createMergeCursor();
    const slowApply = async (): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 30));
      return true;
    };
    const ticks = await macrotasksDuring(() =>
      mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: slowApply,
        getTimeoutMs: 0,
      }),
    );
    expect(ticks).toBeGreaterThanOrEqual(1); // 0 without the time-based trigger (12 ops << 1000)
  });

  it('mergeAdmittedLogs also yields on wall-clock time, well under 1000 ops', async () => {
    const author = 'a7'.repeat(32);
    const log = memLog(author, corpusOps(34, 12, author, 1_700_000_000_000));
    const slowApply = async (): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 30));
      return true;
    };
    const ticks = await macrotasksDuring(() =>
      mergeAdmittedLogs([log], { applyImpl: slowApply, maxOpsPerAuthor: 0, getTimeoutMs: 0 }),
    );
    expect(ticks).toBeGreaterThanOrEqual(1);
  });
});
