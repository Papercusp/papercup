/**
 * read-merge-winners-bound.test.ts — WI-4020: MergeCursor.winners must stay
 * bounded under a configured cap (approximate LRU, evicting keys whose
 * winner hasn't CHANGED recently), and — the load-bearing correctness claim —
 * bounding it must NEVER change the final merged state relative to an
 * unbounded merge over the identical op stream, because `winners` is a
 * fast-path cache layered on an independently-authoritative PG-level LWW
 * guard, not the sole correctness mechanism (see the doc comments on
 * `DEFAULT_MAX_WINNERS_ENTRIES` / `recordWinner` /
 * `mergeAdmittedLogsIncremental`'s "POST-CURSOR-RESET DOUBLE-APPLY SAFETY").
 *
 * `guardedApply` below stands in for that independent PG floor: it only
 * accepts a write that actually LWW-wins over whatever is currently stored
 * (mirroring the real `ON CONFLICT ... WHERE EXCLUDED.fed_hlc/fed_ts >=
 * stored.*` guard), so a redundant/out-of-order re-apply caused by an
 * evicted winners entry is a harmless no-op here too — exactly as it would
 * be against the real projection tables. A naive apply mock that
 * unconditionally overwrites would NOT catch a real regression (it would
 * silently accept a stale re-apply and hide corruption), so this file
 * deliberately does not reuse the simpler `captureApply` helper from
 * read-merge-incremental.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import { createMergeCursor, mergeAdmittedLogs, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import { lwwPick } from './projection';
import { generateCorpus, mulberry32 } from './perf/corpus';

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

/** Guarded apply: mirrors the REAL projection layer's independent PG-level
 *  `ON CONFLICT ... WHERE EXCLUDED.fed_hlc/fed_ts >= stored.*` LWW guard —
 *  a write is only accepted if it actually wins over whatever is currently
 *  stored, so a stale/out-of-order re-apply (e.g. from an evicted `winners`
 *  entry no longer gating it in-memory) is correctly rejected here too. */
function guardedApply() {
  const state = new Map<string, OpEnvelope>();
  const apply = async (env: OpEnvelope): Promise<boolean> => {
    const key = `${env.table}::${env.hbKey}`;
    const prev = state.get(key);
    if (!prev || lwwPick(prev, env) === env) {
      state.set(key, env);
      return true;
    }
    return false; // stale relative to stored — PG's guard would no-op this write
  };
  return { state, apply };
}

function corpusOps(seed: number, count: number, author: string, baseTs: number): PeerLogOp[] {
  return [...generateCorpus({ seed, count, authorPubkey: author, baseTs })];
}

describe('WI-4020: MergeCursor.winners bounding', () => {
  it('stays at or under maxWinnersEntries across many distinct keys, and fires onWinnersEvicted', async () => {
    // 3 authors, enough ops to span well over 100 distinct (table, hbKey) group keys
    // (corpus.ts draws feature ids from a ~400-wide pool and user ids from a
    // ~20-wide pool across 7+ table kinds).
    const logs = [
      memLog('a'.repeat(64), corpusOps(101, 1500, 'a'.repeat(64), 1_700_000_000_000)),
      memLog('b'.repeat(64), corpusOps(102, 1500, 'b'.repeat(64), 1_700_000_000_400)),
      memLog('c'.repeat(64), corpusOps(103, 1500, 'c'.repeat(64), 1_700_000_000_800)),
    ];

    const cursor = createMergeCursor();
    const cap = 50;
    let evictedTotal = 0;
    let evictedCalls = 0;

    for (let guard = 0; guard < 50; guard++) {
      const res = await mergeAdmittedLogsIncremental(logs, cursor, {
        applyImpl: guardedApply().apply,
        getTimeoutMs: 0,
        maxOpsPerPass: 200,
        maxWinnersEntries: cap,
        onWinnersEvicted: (n) => {
          evictedCalls++;
          evictedTotal += n;
        },
      });
      // The bound must hold after EVERY pass, not just at the end.
      expect(cursor.winners.size).toBeLessThanOrEqual(cap);
      if (res.caughtUp) break;
    }

    expect(cursor.winners.size).toBeLessThanOrEqual(cap);
    expect(evictedCalls).toBeGreaterThan(0);
    expect(evictedTotal).toBeGreaterThan(0);
  });

  it('a capped incremental merge converges to the IDENTICAL final state as an uncapped merge (bounding never corrupts reads)', async () => {
    const author = 'd'.repeat(64);
    const all = corpusOps(201, 2000, author, 1_700_000_000_000);

    // Reference: unbounded full fold via the guarded (PG-mirroring) apply.
    const ref = guardedApply();
    await mergeAdmittedLogs([memLog(author, all)], {
      applyImpl: ref.apply,
      maxOpsPerAuthor: 0,
      getTimeoutMs: 0,
    });

    // Capped incremental merge, deliberately tiny cap (well below the corpus's
    // distinct-key count) so eviction — including of keys that later see
    // renewed activity — is exercised heavily, streamed across many small
    // randomized passes (live-append shape, same as the existing equivalence
    // test in read-merge-incremental.test.ts).
    const live: PeerLogOp[] = [];
    const log = memLog(author, live);
    const inc = guardedApply();
    const cursor = createMergeCursor();
    const rnd = mulberry32(9);
    let fed = 0;
    while (fed < all.length) {
      const chunk = 20 + Math.floor(rnd() * 60);
      live.push(...all.slice(fed, fed + chunk));
      fed = live.length;
      await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: inc.apply,
        getTimeoutMs: 0,
        maxWinnersEntries: 25, // far below the corpus's distinct-key count
      });
    }
    // Drain any remaining backlog.
    for (let guard = 0; guard < 50; guard++) {
      const res = await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: inc.apply,
        getTimeoutMs: 0,
        maxWinnersEntries: 25,
      });
      if (res.caughtUp) break;
    }

    expect(cursor.winners.size).toBeLessThanOrEqual(25);
    // The load-bearing assertion: same key set, same winning (ts, type, source)
    // per key — a tiny cap must not change WHAT the merge converges to, only
    // how much redundant apply work it does along the way.
    expect(new Set(inc.state.keys())).toEqual(new Set(ref.state.keys()));
    for (const [key, refEnv] of ref.state) {
      const incEnv = inc.state.get(key)!;
      expect(
        { ts: incEnv.ts, type: incEnv.type, src: incEnv.sourceLogKeyHex },
        `winner mismatch for ${key}`,
      ).toEqual({ ts: refEnv.ts, type: refEnv.type, src: refEnv.sourceLogKeyHex });
    }
  });

  it('maxWinnersEntries <= 0 disables the bound (back-compat: unbounded growth, no eviction)', async () => {
    const author = 'e'.repeat(64);
    const ops = corpusOps(301, 1000, author, 1_700_000_000_000);
    const log = memLog(author, ops);
    const cursor = createMergeCursor();
    let evictedCalls = 0;

    await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: guardedApply().apply,
      getTimeoutMs: 0,
      maxWinnersEntries: 0,
      onWinnersEvicted: () => {
        evictedCalls++;
      },
    });

    expect(evictedCalls).toBe(0);
    // Sanity: the corpus does generate more than a handful of distinct keys,
    // so an unbounded winners map genuinely holds all of them (nothing evicted).
    expect(cursor.winners.size).toBeGreaterThan(10);
  });

  it('defaults to DEFAULT_MAX_WINNERS_ENTRIES when maxWinnersEntries is omitted (no behavior change for existing callers at normal scale)', async () => {
    const author = 'f'.repeat(64);
    const ops = corpusOps(401, 500, author, 1_700_000_000_000);
    const log = memLog(author, ops);
    const cursor = createMergeCursor();

    // No maxWinnersEntries passed — existing callers (boot.ts) are unaffected
    // at today's scale (well under the 500k default).
    await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: guardedApply().apply,
      getTimeoutMs: 0,
    });

    expect(cursor.winners.size).toBeGreaterThan(0);
    expect(cursor.winners.size).toBeLessThan(500_000);
  });
});
