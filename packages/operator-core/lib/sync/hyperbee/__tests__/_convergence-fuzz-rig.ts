/**
 * _convergence-fuzz-rig.ts — Brief D (shared-hive-release-testing): a REUSABLE,
 * deterministic, seed-controlled fuzz harness for the substrate's eventual-
 * consistency contract. Given a random universe of federated writes across many
 * content types + many peers receiving them in arbitrary (seeded) orders with
 * dups, it asserts that EVERY honest peer converges to the BYTE-IDENTICAL
 * materialised state — no loss, no divergence, deterministic LWW winner.
 *
 * It drives the REAL merge core (`mergeAdmittedLogsIncremental` →
 * `beatsStored`/`lwwPick`) and the REAL `stampOpHlc`/`HlcClock` seams, with a
 * faithful in-memory transcription of every mutable projection's PG `fed_ts`
 * LWW guard (`WHERE stored.fed_ts IS NULL OR EXCLUDED.fed_ts >= stored.fed_ts`,
 * `fed_ts = provenance.ts = op.ts`). It is NOT a model of the merge — it RUNS
 * the merge; only the PG guard + the network (partition/reorder/dup) are
 * modelled, and the PG-guard model is a line-for-line transcription.
 *
 * Two clock regimes:
 *   - 'monotone' — every op's HLC physical == its own `ts` (no recv-advance), so
 *     HLC order == fed_ts order. Property MUST hold (convergence). Green sweep.
 *   - 'skew' — some authors' clocks are recv-advanced ABOVE a later write's `ts`
 *     (the production reality the 2026-06-14 fix left open), creating HLC/fed_ts
 *     inversions. The fuzzer FINDS the D-001 divergence here.
 *
 * No `Math.random` — a mulberry32 PRNG seeded per run (vary by seed/index).
 */
import { stampOpHlc } from '../hlc-stamp';
import { HlcClock } from '@papercusp/locks-core';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/** Deterministic PRNG (mulberry32). Seed-controlled — never `Math.random`. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ['features-by-id', 'issues', 'harness_plans', 'plan-item-assignments', 'coord-messages'] as const;

export type ClockRegime = 'monotone' | 'skew';

export interface FuzzOptions {
  seed: number;
  peers: number; // honest peers, all eventually receive every op
  ops: number; // total federated writes generated
  keys: number; // distinct (table,hbKey) contended slots
  regime: ClockRegime;
  /** Probability (0..1) an author is recv-advanced before a write (skew only). */
  skewProb?: number;
  /** Probability a delivered op is duplicated in a peer's fold order. */
  dupProb?: number;
}

interface GenOp {
  /** Distinct provenance/source-log key — the merge's deterministic tiebreak. */
  sourceLogKeyHex: string;
  op: PeerLogOp;
}

/** A faithful transcription of every mutable projection's PG LWW guard. Keyed
 *  on `table::hbKey` exactly like the merge's `cursor.winners` group key. */
export class FedTsGuardedStore {
  readonly rows = new Map<string, { fedTs: number | null; value: unknown }>();
  private key(op: OpEnvelope): string {
    return `${op.table}::${op.hbKey}`;
  }
  apply = async (op: OpEnvelope): Promise<boolean> => {
    if (op.type === 'del') {
      // ts-guarded delete (fed_ts <= del.ts erases; a stale del matches nothing).
      const k = this.key(op);
      const cur = this.rows.get(k);
      const delTs = op.ts ?? null;
      if (cur && (delTs === null || (cur.fedTs !== null && cur.fedTs <= delTs))) this.rows.delete(k);
      return true;
    }
    if (op.type !== 'put' || !op.hbKey) return false;
    const k = this.key(op);
    const incoming = op.ts ?? null; // fed_ts = provenance.ts = op.ts
    const cur = this.rows.get(k);
    if (cur && cur.fedTs !== null && (incoming === null || incoming < cur.fedTs)) return false;
    this.rows.set(k, { fedTs: incoming, value: op.value });
    return true;
  };
  /** A stable, comparable digest of the materialised state (sorted by key). */
  digest(): string {
    return [...this.rows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${JSON.stringify(v.value)}`)
      .join('|');
  }
}

/** One single-op in-memory AdmittedLog (merge needs only keyHex/length/get). */
function singleOpLog(keyHex: string, op: PeerLogOp): AdmittedLog {
  return { keyHex, length: 1, get: async (i) => (i === 0 ? op : null) };
}

/** Fisher-Yates shuffle driven by the seeded RNG (no Math.random). */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Generate the universe of federated writes. Each op gets a UNIQUE
 *  sourceLogKeyHex (its own peer-log), a content slot (table,hbKey), a wall ts,
 *  and an HLC stamped through the real seam on a per-author clock. */
export function generateOps(opts: FuzzOptions): GenOp[] {
  const rng = makeRng(opts.seed);
  const skewProb = opts.skewProb ?? 0.5;
  // One HLC clock per author (a handful of authors write the ops); each author's
  // wall clock is `authorPhys[author]`, set to the current op's ts before each
  // stamp so `stampOpHlc(op, clock)` seeds the HLC physical from op.ts exactly as
  // the 2026-06-14 fix does in production.
  const authorCount = Math.max(2, Math.min(opts.peers, 5));
  const authorPhys = new Array<number>(authorCount).fill(1000);
  const clocks = authorPhys.map((_, i) => new HlcClock({ physical: () => authorPhys[i] }));

  const gen: GenOp[] = [];
  for (let i = 0; i < opts.ops; i++) {
    const table = TABLES[Math.floor(rng() * TABLES.length)];
    const hbKey = `K-${Math.floor(rng() * opts.keys)}`;
    const author = Math.floor(rng() * authorCount);
    const clock = clocks[author];
    // Per-author MONOTONE wall ts — production captures a peer's writes in time
    // order (FIFO outbox), so a peer's own op.ts never goes backward. (Random
    // per-op ts would inject UNREALISTIC intra-author HLC/ts inversions; the
    // only realistic decoupling source is the cross-peer recv-advance below.)
    authorPhys[author] += 1 + Math.floor(rng() * 50);
    const ts = authorPhys[author];
    if (opts.regime === 'skew' && rng() < skewProb) {
      // RECV-advance this author's clock ABOVE its own write ts — the production
      // reality the 2026-06-14 fix left open (`observeRemoteHlc` is preserved).
      // A high HLC physical observed from a peer sticks (HLC is monotone) and
      // decouples HLC order from fed_ts order for this + subsequent writes.
      clock.recv({ ms: ts + 100 + Math.floor(rng() * 8000), count: 0 });
    }
    const type = rng() < 0.12 ? 'del' : 'put';
    const base: PeerLogOp = {
      type,
      table,
      hbKey,
      value: { marker: `op${i}`, author, ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${author}`,
    };
    gen.push({ sourceLogKeyHex: `log-${i}`, op: stampOpHlc(base, clock) });
  }
  return gen;
}

export interface FuzzResult {
  converged: boolean;
  digests: string[];
  /** When divergent: the distinct materialised states observed across peers. */
  distinct: string[];
}

/**
 * Run the scenario: every peer eventually receives EVERY op (full delivery — the
 * post-heal fixed point), but in its own seeded random fold order (modelling
 * arbitrary partition/reorder), with occasional dups (modelling re-delivery —
 * the merge must be idempotent). Returns whether all peers converged.
 */
export async function runConvergenceFuzz(opts: FuzzOptions): Promise<FuzzResult> {
  const ops = generateOps(opts);
  const rng = makeRng((opts.seed ^ 0x9e3779b9) >>> 0); // distinct stream for the network model

  const digests: string[] = [];
  for (let p = 0; p < opts.peers; p++) {
    const store = new FedTsGuardedStore();
    const cursor = createMergeCursor();
    // This peer eventually receives EVERY op (the post-heal fixed point) but in
    // its OWN seeded fold order — one stable AdmittedLog per origin op (keyHex =
    // its peer-stable sourceLogKeyHex, the merge's deterministic same-clock
    // tiebreak). Shuffling the log array models arbitrary partition/reorder
    // delivery: the winners-fold is order-independent, but the apply-to-PG (the
    // fed_ts guard) is NOT — that interaction is exactly what D-001 exposes.
    const logs = shuffle(ops, rng).map((g) => singleOpLog(g.sourceLogKeyHex, g.op));
    // Fold in chunks so the cursor advances across multiple passes (exercises
    // the cross-pass winners-fold persistence, not just one monolithic pass).
    const CHUNK = 7;
    for (let i = 0; i < logs.length; i += CHUNK) {
      await mergeAdmittedLogsIncremental(logs.slice(0, i + CHUNK), cursor, {
        applyImpl: store.apply,
        getTimeoutMs: 0,
      });
    }
    // Idempotence: one more full pass must apply nothing new (re-delivery is safe).
    await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
    digests.push(store.digest());
  }
  const distinct = [...new Set(digests)];
  return { converged: distinct.length === 1, digests, distinct };
}
