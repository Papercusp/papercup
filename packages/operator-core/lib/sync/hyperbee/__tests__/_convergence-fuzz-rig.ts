/**
 * _convergence-fuzz-rig.ts — Brief D (shared-pot-release-testing): a REUSABLE,
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
import { lwwPick } from '../projection';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * The materialised-store guard ordering key:
 *   'fed_hlc' — the SHIPPED D-001 fix (production, migration 314): the PG guard
 *               orders by the op's HLC (`fed_hlc` column) when BOTH sides carry
 *               one, falling back to the wall-clock `fed_ts` guard when either is
 *               NULL (pre-P-010 / pre-314 / append-path ops). This is the rig's
 *               DEFAULT because it models the live projection guard.
 *   'fed_ts'  — LEGACY (the pre-314 bug surface): order by op.ts wall clock only.
 *               Kept for the characterisation/teeth test that the skew sweep DID
 *               diverge before the fix.
 *   'lww'     — order by the FULL merge comparator (`lwwPick`: HLC → del>put →
 *               sourceLogKeyHex). A strict superset of 'fed_hlc' (adds the exact-
 *               HLC-tie tiebreak, which the fold pre-resolves before apply). Kept
 *               as the upper-bound validation that the merge's own order converges.
 */
export type GuardOrder = 'fed_ts' | 'lww' | 'fed_hlc';

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
  /** Probability a generated op is a `del` (default 0.12). Pass 0 to generate a
   *  put-only universe — used by tests that pin put-vs-put ORDERING and must not
   *  trip the orthogonal local-del/no-tombstone resurrection gap (WI-1684). */
  delProb?: number;
  /** Materialised-store guard ordering: 'fed_ts' (today / bug) | 'lww' (the fix). */
  guardOrder?: GuardOrder;
  /** Author clocks carry a node identity (migration 459 / WI-1672 — the shipped
   *  reality). Default TRUE; pass false to model legacy node-LESS stamps. */
  nodeIds?: boolean;
  /** WI-1672 amplifier: recv-ratchet EVERY author's clock to one shared hive-wide
   *  frontier up front, so all stamps advance by counter only, in near-lockstep —
   *  exact (ms, count) collisions across authors become routine. */
  lockstep?: boolean;
  /** Production topology (skipOwnOps): each op's AUTHOR peer applies it via the
   *  LOCAL write path (trigger-stamped row write, NO LWW guard) and that op is
   *  SKIPPED in the author's own fold — the PG guard becomes the ONLY
   *  local-vs-remote arbiter, exactly as shipped. Author i writes on peer i
   *  (authors beyond the peer count would be unmapped, so authorCount == peers
   *  in this mode). 'fed_ts'/'fed_hlc' guards only (the 'lww' winners map does
   *  not see local writes). */
  localAuthorApply?: boolean;
  /** WI-1684 fix knob (localAuthorApply only). When an author's OWN DEL folds and
   *  WINS, does the merge APPLY it (a guarded delete) or SKIP it?
   *   - false (pre-fix / today): skipOwnOps skips own dels too, so a winning own
   *     del canNOT clean up a row a concurrent foreign put resurrected during the
   *     DRAIN WINDOW (the del reaches the own log only after the drain) → the
   *     resurrection is permanent on the author peer → split-brain on row presence.
   *   - true (the fix — narrow skipOwnOps to PUTS): apply the winning own del. The
   *     delete is echo-safe (0-row → the FOR EACH ROW capture trigger never fires;
   *     a resurrected row is origin='remote' → capture's echo-guard skips it), so
   *     it cannot restart the EI-117 storm the skip exists to break (that storm is
   *     a PUT-only shape: an UPSERT always re-fires capture as origin='local').
   *  Default TRUE (models the shipped fix); the teeth test sets it false. */
  applyOwnDels?: boolean;
}

/** The lockstep regime's shared frontier: far above every author's wall clock
 *  (authors start at 1000 and advance ≤ ~50ms/op) yet INSIDE the recv ε drift
 *  bound (600s), so the ratchet is accepted — as it was in the live incident. */
const LOCKSTEP_FRONTIER_MS = 300_000;

interface GenOp {
  /** Distinct provenance/source-log key — the merge's deterministic tiebreak. */
  sourceLogKeyHex: string;
  op: PeerLogOp;
}

/** The materialised store, with a SWAPPABLE guard ordering key. Keyed on
 *  `table::hbKey` exactly like the merge's `cursor.winners` group key.
 *   - 'fed_ts' faithfully transcribes every mutable projection's PG LWW guard
 *     TODAY (`EXCLUDED.fed_ts >= stored.fed_ts`, fed_ts = op.ts; del ts-guard).
 *   - 'lww' is the PROPOSED FIX: the guard orders by the merge's own comparator
 *     (`lwwPick`), so it never rejects a merge-winner (put AND del). */
export class FedTsGuardedStore {
  readonly rows = new Map<string, { fedTs: number | null; hlc?: string; value: unknown }>();
  /** 'lww' mode only: the winning envelope per key (incl. del tombstones) — the
   *  guard's order-of-record, mirroring the merge's cursor.winners. */
  private winners = new Map<string, OpEnvelope>();
  constructor(private readonly order: GuardOrder = 'fed_hlc') {}
  private key(op: OpEnvelope): string {
    return `${op.table}::${op.hbKey}`;
  }
  /** The LOCAL write path (production `stamp_local_federated_write` trigger +
   *  `skipOwnOps`): the author's own row write is NOT LWW-guarded — the row
   *  simply takes the write, stamped with the same hlc its outbox op carries
   *  (the D-001 invariant `op.hlc == author's fed_hlc`). */
  applyLocal(op: OpEnvelope): void {
    if ((op.type !== 'put' && op.type !== 'del') || !op.hbKey) return;
    const k = this.key(op);
    if (op.type === 'del') this.rows.delete(k);
    else this.rows.set(k, { fedTs: op.ts ?? null, hlc: op.hlc, value: op.value });
  }
  apply = async (op: OpEnvelope): Promise<boolean> => {
    if (op.type !== 'put' && op.type !== 'del') return false;
    if (!op.hbKey) return false;
    const k = this.key(op);
    if (this.order === 'lww') {
      // FIX MODEL: order by the SAME total order as the merge fold. Reject only
      // when the stored winner beats-or-ties the incoming op (lwwPick returns it).
      const prev = this.winners.get(k);
      if (prev && lwwPick(prev, op) !== op) return false;
      this.winners.set(k, op);
      if (op.type === 'del') this.rows.delete(k);
      else this.rows.set(k, { fedTs: op.ts ?? null, hlc: op.hlc, value: op.value });
      return true;
    }
    if (this.order === 'fed_hlc') {
      // SHIPPED PRODUCTION GUARD (migration 314 + the projection writeToPg): order
      // by `fed_hlc` (the op's HLC) when BOTH the stored row and the incoming op
      // carry one; else fall back to the wall-clock `fed_ts` guard. A line-for-line
      // transcription of the projections' new ON CONFLICT / DELETE WHERE.
      const incHlc = op.hlc ?? null;
      const incTs = op.ts ?? null;
      const cur = this.rows.get(k);
      if (op.type === 'del') {
        if (!cur) return true; // nothing stored → idempotent
        const curHlc = cur.hlc ?? null;
        const beats =
          incHlc !== null && curHlc !== null
            ? incHlc >= curHlc // both HLC → del wins iff its HLC ≥ stored (del>put on tie via ≥)
            : incTs === null || cur.fedTs === null || cur.fedTs <= incTs; // fed_ts fallback
        if (beats) this.rows.delete(k);
        return true;
      }
      if (!cur) {
        this.rows.set(k, { fedTs: incTs, hlc: incHlc ?? undefined, value: op.value });
        return true;
      }
      const curHlc = cur.hlc ?? null;
      const beats =
        incHlc !== null && curHlc !== null
          ? incHlc >= curHlc // both HLC → causal compare (the D-001 fix)
          : cur.fedTs === null || (incTs !== null && incTs >= cur.fedTs); // fed_ts fallback
      if (!beats) return false;
      this.rows.set(k, { fedTs: incTs, hlc: incHlc ?? undefined, value: op.value });
      return true;
    }
    // LEGACY 'fed_ts' (the pre-314 bug surface): order by fed_ts = op.ts (wall clock).
    if (op.type === 'del') {
      const cur = this.rows.get(k);
      const delTs = op.ts ?? null;
      if (cur && (delTs === null || (cur.fedTs !== null && cur.fedTs <= delTs))) this.rows.delete(k);
      return true;
    }
    const incoming = op.ts ?? null;
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
  const authorCount = opts.localAuthorApply ? opts.peers : Math.max(2, Math.min(opts.peers, 5));
  const authorPhys = new Array<number>(authorCount).fill(1000);
  const useNodes = opts.nodeIds !== false;
  const clocks = authorPhys.map(
    (_, i) => new HlcClock({ physical: () => authorPhys[i], node: useNodes ? i.toString(16).padStart(16, '0') : undefined }),
  );
  // WI-1672 amplifier: one recv pins every clock's wall component to the same
  // hive-wide frontier; every later stamp is a counter-only bump in lockstep.
  if (opts.lockstep) for (const c of clocks) c.recv({ ms: LOCKSTEP_FRONTIER_MS, count: 0 }, 1000);

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
    const type = rng() < (opts.delProb ?? 0.12) ? 'del' : 'put';
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
    const store = new FedTsGuardedStore(opts.guardOrder ?? 'fed_hlc');
    const cursor = createMergeCursor();
    // Production topology (skipOwnOps): this peer's OWN writes land via the
    // unguarded LOCAL path (trigger-stamped row write), in author order.
    let ownDelLogs: AdmittedLog[] = [];
    let foreignGen = ops;
    if (opts.localAuthorApply) {
      const own = ops.filter((g) => (g.op.value as { author: number }).author === p);
      for (const g of own) store.applyLocal(g.op);
      // WI-1684 — local-del resurrection under skipOwnOps, modelled faithfully as
      // the DRAIN WINDOW. The author deletes a row locally (applyLocal above → row
      // gone, NO tombstone), but its own del op reaches its own log only AFTER the
      // outbox→drain round-trip. During that window a concurrent foreign put can
      // fold FIRST: the projection sees no row → no-row INSERT path → the row is
      // RESURRECTED on the author peer only. To reproduce that worst case the own
      // DEL log folds LAST (after every foreign op — see `logs` below), so any
      // concurrent foreign put has already resurrected the row before it arrives.
      //
      // Production ALREADY folds the own del into `cursor.winners`
      // (`applyRecordingWinner` records the winner even when apply returns false),
      // so the del correctly WINS the fold on the author peer. The bug is that
      // skipOwnOps ALSO skips its APPLY, so the winning del never deletes the
      // resurrected row → permanent split-brain. The FIX (see `applyImpl` +
      // `applyOwnDels`) narrows skipOwnOps to PUTS: a winning own del is re-applied
      // (a fed_hlc-guarded delete) that cleans up the resurrection. It is DEL-ONLY:
      // own PUTS stay skipped (that put-vs-put tie surface is WI-1672's, left to the
      // node-id total-order guard — its teeth test runs delProb:0), and re-applying
      // an own del is echo-safe where re-applying an own put is not (a 0-row delete
      // never fires the FOR EACH ROW capture trigger; a resurrected row is
      // origin='remote' → capture's echo-guard skips it — no EI-117 storm).
      ownDelLogs = own
        .filter((g) => g.op.type === 'del')
        .map((g) => singleOpLog(g.sourceLogKeyHex, g.op));
      foreignGen = ops.filter((g) => (g.op.value as { author: number }).author !== p);
    }
    // The apply sink mirrors production's SINGLE `applyImpl` in projection.ts:
    // skipOwnOps SKIPS the PG re-apply of this peer's own ops (already materialised
    // via `applyLocal`). `applyRecordingWinner` still records the winner on the
    // no-throw path, so an own op establishes its fold winner regardless of apply.
    // WI-1684 FIX: skipOwnOps is narrowed to PUTS — a winning own DEL is re-applied
    // (a fed_hlc-guarded delete) so it can clean up a drain-window resurrection.
    // `applyOwnDels` (default true = the shipped fix) gates it; the teeth test sets
    // it false to reproduce the pre-fix split-brain.
    const applyImpl = async (op: OpEnvelope): Promise<boolean> => {
      if (opts.localAuthorApply && (op.value as { author?: number } | undefined)?.author === p) {
        if (opts.applyOwnDels !== false && op.type === 'del') return store.apply(op); // WI-1684: apply winning own del
        return false; // skipOwnOps: own put (or pre-fix own del) — record winner, skip re-apply
      }
      return store.apply(op);
    };
    // This peer eventually receives EVERY op (the post-heal fixed point) but in
    // its OWN seeded fold order — one stable AdmittedLog per origin op (keyHex =
    // its peer-stable sourceLogKeyHex, the merge's deterministic same-clock
    // tiebreak). Shuffling the FOREIGN ops models arbitrary partition/reorder
    // delivery; the own DEL log(s) fold LAST to model the WI-1684 DRAIN WINDOW (the
    // own del reaches the own log only after the outbox→drain round-trip, so every
    // concurrent foreign put has already folded — and possibly resurrected the row —
    // before it arrives). The winners-fold is order-independent, but the apply-to-PG
    // (the fed_hlc guard) is NOT — that interaction is exactly what WI-1684 exposes.
    const logs = [
      ...shuffle(foreignGen, rng).map((g) => singleOpLog(g.sourceLogKeyHex, g.op)),
      ...ownDelLogs,
    ];
    // Fold in chunks so the cursor advances across multiple passes (exercises
    // the cross-pass winners-fold persistence, not just one monolithic pass).
    const CHUNK = 7;
    for (let i = 0; i < logs.length; i += CHUNK) {
      await mergeAdmittedLogsIncremental(logs.slice(0, i + CHUNK), cursor, {
        applyImpl,
        getTimeoutMs: 0,
      });
    }
    // Idempotence: one more full pass must apply nothing new (re-delivery is safe).
    await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl, getTimeoutMs: 0 });
    digests.push(store.digest());
  }
  const distinct = [...new Set(digests)];
  return { converged: distinct.length === 1, digests, distinct };
}
