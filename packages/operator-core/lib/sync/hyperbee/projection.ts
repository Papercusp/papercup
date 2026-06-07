/**
 * Bidirectional PG ↔ Hyperbee projection registry.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Per-table read/write hooks are registered here; the substrate
 * applies them on Hyperbee ops it receives + invokes them on PG
 * writes that need to fan out to Hyperbee.
 *
 * NOT WIRED YET to the actual operator boot path or PG triggers —
 * this commit ships the interface + registry + LWW helper. Per-table
 * hooks land in follow-up commits (one per HYPERBEE-bucket table)
 * because each table has its own row contract.
 *
 * v5 D-012 — same-key Hyperbee conflicts resolve LWW by `ts` (op
 * timestamp). LWW helper here is pure + testable.
 */

import type { OpEnvelope } from './op-envelope-types';
import { observeMergedOp } from './clobber-events';

/**
 * G1 Provenance context (P-002). Passed to `writeToPg` so each per-table writer
 * can stamp `author_pubkey` + `origin` on the upserted row.
 *
 * `origin` is determined by the apply path (not the writer) because it requires
 * comparing `sourceLogKeyHex` against the own log's `keyHex` — information
 * the writer doesn't hold. The writer just stamps the values it receives.
 */
export interface ProvenanceContext {
  /**
   * The UNFORGEABLE writer identity for this op (maps to `author_pubkey`
   * column). P-002/D-004: for a `local` op it's the own device pubkey (the
   * trustworthy self-declared `writerPubkey`); for a `remote` op it's the
   * receiver-stamped, immutable `sourceLogKeyHex` (the source log core key) —
   * NOT the self-declared field, which a remote peer controls. `''` when a
   * remote op carries no source key. Resolve a remote value to its
   * device/GitHub identity at read time via the admission map.
   */
  authorPubkey: string;
  /** 'local' | 'remote' — derived from log-source (own vs admitted-remote). */
  origin: 'local' | 'remote';
  /**
   * EI-79 residual step 2: the op's WIRE ts (epoch ms) — the LWW ordering field
   * `lwwPick` orders on. Writers persist it as the table's `fed_ts` column and
   * guard their `ON CONFLICT ... DO UPDATE` with `WHERE EXCLUDED.fed_ts >=
   * <table>.fed_ts`, so a strictly-older (out-of-order / backfilled) op can
   * never clobber a newer projected row — making each writer PG-level
   * last-write-wins INDEPENDENT of the incremental merge cursor's in-process
   * fold. `undefined` for a synthetic/local op built without a ts (the writers
   * treat a NULL stored fed_ts as "older than anything", so such a write lands).
   */
  ts?: number;
}

export interface TableProjection<Row> {
  /** Table tag, matching `hyperbee-key-types.HYPERBEE_TABLE_TAGS`. */
  tableTag: string;
  /**
   * Build the Hyperbee key for a given row. Single source of truth
   * for the per-table key shape — composer + parser stay aligned.
   */
  composeKey: (row: Row) => string;
  /** Parse the row out of a Hyperbee value. */
  decodeValue: (raw: unknown) => Row | null;
  /**
   * Write the row into PG (idempotent — must handle re-application).
   *
   * G1 Provenance (P-002): the second arg carries `{ authorPubkey, origin }`
   * so the writer can stamp `author_pubkey` + `origin` on the upserted row.
   * Optional to preserve backward-compat with writers not yet upgraded (they
   * silently ignore the context).
   */
  writeToPg: (row: Row, provenance?: ProvenanceContext) => Promise<void>;
  /** Delete the row from PG (idempotent). */
  deleteFromPg: (key: string) => Promise<void>;
}

const registry = new Map<string, TableProjection<unknown>>();

export function registerProjection<Row>(p: TableProjection<Row>): void {
  registry.set(p.tableTag, p as TableProjection<unknown>);
}

export function getProjection(tableTag: string): TableProjection<unknown> | null {
  return registry.get(tableTag) ?? null;
}

export function _clearRegistryForTests(): void {
  registry.clear();
}

/**
 * A projection-set lookup: `tableTag → projection | null`. The single seam
 * `applyOpVia` dispatches through, so the GLOBAL registry and a PER-HARNESS
 * scoped projection set share one apply implementation (no duplicated
 * put/del/decode/clobber logic). The global path passes the module registry's
 * `getProjection`; a per-harness path passes a lookup bound to that harness's
 * own projection set (see `buildHarnessProjectionApply` in `projections/
 * register-all.ts`).
 */
export type ProjectionLookup = (tableTag: string) => TableProjection<unknown> | null;

/**
 * G1 Provenance (P-002): options for `applyOpVia`. The `ownLogKeyHex` is the
 * hex key of this harness's own writable log (from `ownLog.keyHex` in
 * `boot.ts`). When provided, `applyOpVia` determines `origin` by comparing
 * `op.sourceLogKeyHex === ownLogKeyHex` (log-source approach, D-006). When
 * absent (global registry path / callers that haven't threaded it yet), origin
 * falls back to `writerPubkey`-comparison against `ownWriterPubkey`; if neither
 * is available, origin defaults to `'local'` (safe default — the global-registry
 * path is single-harness legacy; no remote peers write through it).
 */
export interface ApplyOpOpts {
  /**
   * The own log's hex keyHex. When set, `op.sourceLogKeyHex === ownLogKeyHex`
   * → `origin='local'`; any other source → `origin='remote'`.
   */
  ownLogKeyHex?: string;
}

/**
 * Core op-dispatch: resolve `op.table` via `lookup`, then write/delete the row
 * to PG and fire the clobber-event hook. Returns true iff the op was applied
 * (false on unknown table / non-put-del / decode failure / missing key).
 *
 * This is the single source of truth for "apply one op through a projection
 * set" — both `applyHyperbeeOpToPg` (global registry) and a per-harness scoped
 * apply call it with different lookups, so the put/del/decode/clobber logic is
 * NOT duplicated (Model B per-harness projection-apply, D-021 collision fix).
 *
 * G1 Provenance (P-002): when `applyOpts.ownLogKeyHex` is provided, computes
 * `origin` via log-source comparison (`op.sourceLogKeyHex === ownLogKeyHex`
 * → 'local', else 'remote') and passes `ProvenanceContext` to `writeToPg`.
 * Writers that understand provenance stamp `author_pubkey` + `origin` on upsert;
 * legacy writers (no provenance param) continue to work unchanged.
 */
export async function applyOpVia(
  lookup: ProjectionLookup,
  op: OpEnvelope,
  applyOpts?: ApplyOpOpts,
): Promise<boolean> {
  if (op.type !== 'put' && op.type !== 'del') return false;
  if (!op.table) return false;
  const p = lookup(op.table);
  if (!p) return false;
  if (op.type === 'del') {
    if (!op.hbKey) return false;
    await p.deleteFromPg(op.hbKey);
    return true;
  }
  const row = p.decodeValue(op.value);
  if (!row) return false;

  // G1 Provenance (P-002): determine origin via log-source when possible.
  // Log-source is the authoritative signal (D-006): an op whose
  // sourceLogKeyHex matches the own log's keyHex was written locally and
  // cannot be forged by a remote peer. Without ownLogKeyHex (legacy /
  // global-registry path) we default to 'local' (safe for single-peer use).
  let provenance: ProvenanceContext | undefined;
  if (op.writerPubkey !== undefined || applyOpts?.ownLogKeyHex !== undefined) {
    let origin: 'local' | 'remote' = 'local';
    if (applyOpts?.ownLogKeyHex !== undefined) {
      // Log-source approach (preferred, D-006): compare source log to own log.
      origin =
        op.sourceLogKeyHex !== undefined && op.sourceLogKeyHex === applyOpts.ownLogKeyHex
          ? 'local'
          : 'remote';
    }
    // If ownLogKeyHex is absent but writerPubkey is present, default to 'local'
    // (the global-registry / legacy path never has remote peers; no wrong split).
    //
    // P-002/D-004 — attribution must be UNFORGEABLE. The op's `writerPubkey` is
    // self-declared (a field in the op value), so a remote peer can set it to
    // anything. For a REMOTE op, attribute by the receiver-stamped, immutable
    // `sourceLogKeyHex` (the source log core key — resolvable to its admitted
    // device/GitHub identity at read time via the admission map; immutable, so
    // it never goes stale on revocation/rotation the way a baked-in resolved
    // pubkey would). With no source key on a remote op, record `''` rather than
    // trust the forgeable field. For a LOCAL op the `writerPubkey` is the
    // operator's OWN write — trustworthy, and the meaningful device pubkey.
    const authorPubkey =
      origin === 'remote' ? (op.sourceLogKeyHex ?? '') : (op.writerPubkey ?? '');
    provenance = { authorPubkey, origin, ts: op.ts };
  } else if (typeof op.ts === 'number') {
    // EI-79 step 2: even a write with no provenance (synthetic / single-harness
    // legacy op without writerPubkey or ownLogKeyHex) must carry its `ts` so the
    // writer stamps `fed_ts` and the PG-level LWW guard works. Default the
    // attribution fields to a local self-write.
    provenance = { authorPubkey: op.writerPubkey ?? '', origin: 'local', ts: op.ts };
  }

  await p.writeToPg(row, provenance);
  // P-035: clobber-event hook. Fires only when the incoming op has
  // a writerPubkey + the tracker has a recent local write for the
  // same key from a *different* pubkey within the 60s window.
  // No-op when writerPubkey is absent (legacy / un-threaded write).
  if (op.writerPubkey && op.hbKey && typeof op.ts === 'number') {
    observeMergedOp({
      table: op.table,
      hbKey: op.hbKey,
      ts: op.ts,
      pubkey: op.writerPubkey,
    });
  }
  return true;
}

/**
 * Apply one Hyperbee op against the GLOBAL registry. Called by the
 * Hyperbee read loop. Returns true if the op was applied to PG,
 * false if it was dropped (unknown table / decode failed / LWW
 * stale).
 *
 * NOTE (Model B): with 2+ booted harnesses, the global registry is a
 * last-writer-wins collision point — `registerAllHarnessProjections` overwrites
 * by `tableTag`, so this global apply dispatches to whichever harness registered
 * last. Model B's boot path therefore uses a PER-HARNESS scoped apply
 * (`buildHarnessProjectionApply`) instead of this global function. This is kept
 * for any caller that still has a single-harness global view.
 */
export async function applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean> {
  return applyOpVia((tableTag) => registry.get(tableTag) ?? null, op);
}

/**
 * LWW conflict resolution helper (D-003 HLC; tiebreak hardened in D-004/P-001).
 * Given two ops on the same key, return the one to keep:
 *
 *   1. the causally-later clock wins — by HLC (`encodeHlc` string compare) when
 *      BOTH ops carry one, else by the bare wall-clock `ts` (back-compat);
 *   2. on an exact tie, `del` beats `put` (safety — a delete that raced a write
 *      at the same instant takes precedence);
 *   3. on a clock tie with the SAME type (del/put doesn't decide), the op with
 *      the lexicographically-GREATER `sourceLogKeyHex` wins.
 *
 * The HLC (D-003) makes step 1 monotone across NTP corrections and causally
 * correct across machines — a backward clock step can no longer resurrect a
 * stale write, and a value that causally followed another never loses to it on
 * a wall-clock coincidence. It is additive: an op without `hlc` falls back to
 * `ts`, so the field rolls out per surface with no flag day. The encoded HLC is
 * a fixed-width sortable string, so `>` on it equals compareHlc.
 *
 * Step 3 is what makes the fold fully order-independent: the previous
 * "return the first arg" rule was arrival-order-dependent, so two peers folding
 * the same two ops in opposite orders could pick different winners and diverge.
 * The tiebreak keys off `sourceLogKeyHex` — the receiver-stamped source-log key
 * (`read-merge.toEnvelope`), which is BOTH peer-stable (every peer sees the same
 * source log keys) AND unforgeable (a writer controls the self-declared
 * `writerPubkey`, but NOT which admitted log a received op was replicated from).
 * A missing `sourceLogKeyHex` (synthetic / local legacy ops built outside the
 * merge path) is treated as `''` so the comparison stays total and stable.
 */
export function lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope {
  // Step 1 — causal clock. Prefer HLC when both ops carry one (sortable
  // encoding → string compare == compareHlc); else fall back to wall-clock ts.
  if (a.hlc && b.hlc) {
    if (a.hlc > b.hlc) return a;
    if (b.hlc > a.hlc) return b;
  } else {
    const ta = a.ts ?? 0;
    const tb = b.ts ?? 0;
    if (ta > tb) return a;
    if (tb > ta) return b;
  }
  // ── clock tie ──
  // del beats put.
  if (a.type === 'del' && b.type !== 'del') return a;
  if (b.type === 'del' && a.type !== 'del') return b;
  // Same type on a clock tie → deterministic, unforgeable tiebreak: the higher
  // (lexicographically-greater) sourceLogKeyHex wins, identical on every peer
  // regardless of fold order. Undefined source ⇒ '' so the order is total.
  const sa = a.sourceLogKeyHex ?? '';
  const sb = b.sourceLogKeyHex ?? '';
  if (sa >= sb) return a;
  return b;
}
