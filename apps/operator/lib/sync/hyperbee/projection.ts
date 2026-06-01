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
  /** Write the row into PG (idempotent — must handle re-application). */
  writeToPg: (row: Row) => Promise<void>;
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
 * Core op-dispatch: resolve `op.table` via `lookup`, then write/delete the row
 * to PG and fire the clobber-event hook. Returns true iff the op was applied
 * (false on unknown table / non-put-del / decode failure / missing key).
 *
 * This is the single source of truth for "apply one op through a projection
 * set" — both `applyHyperbeeOpToPg` (global registry) and a per-harness scoped
 * apply call it with different lookups, so the put/del/decode/clobber logic is
 * NOT duplicated (Model B per-harness projection-apply, D-021 collision fix).
 */
export async function applyOpVia(lookup: ProjectionLookup, op: OpEnvelope): Promise<boolean> {
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
  await p.writeToPg(row);
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
 * LWW conflict resolution helper (D-003). Given two ops on the same key,
 * return the one to keep:
 *
 *   1. later `ts` wins;
 *   2. on an exact `ts` tie, `del` beats `put` (safety — a delete that
 *      raced a write at the same instant takes precedence);
 *   3. on a `ts` tie with the SAME type (del/put doesn't decide), the op
 *      with the lexicographically-GREATER `writerPubkey` wins.
 *
 * Step 3 is what makes the fold fully order-independent: the previous
 * "return the first arg" rule was arrival-order-dependent, so two peers
 * folding the same two ops in opposite orders could pick different
 * winners and diverge. Tiebreaking on the (peer-stable) author pubkey
 * yields an identical winner on every peer regardless of fold order.
 * A missing `writerPubkey` is treated as `''` so the comparison is
 * total and stable.
 */
export function lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope {
  const ta = a.ts ?? 0;
  const tb = b.ts ?? 0;
  if (ta > tb) return a;
  if (tb > ta) return b;
  // ── ts tie ──
  // del beats put.
  if (a.type === 'del' && b.type !== 'del') return a;
  if (b.type === 'del' && a.type !== 'del') return b;
  // Same type on a ts tie → deterministic author tiebreak: the higher
  // (lexicographically-greater) writerPubkey wins, identical on every peer
  // regardless of fold order. Undefined pubkey ⇒ '' so the order is total.
  const pa = a.writerPubkey ?? '';
  const pb = b.writerPubkey ?? '';
  if (pa >= pb) return a;
  return b;
}
