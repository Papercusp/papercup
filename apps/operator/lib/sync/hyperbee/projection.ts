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

import type { OpEnvelope } from './autobase-setup';
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
 * Apply one Hyperbee op against the registry. Called by the
 * Hyperbee read loop. Returns true if the op was applied to PG,
 * false if it was dropped (unknown table / decode failed / LWW
 * stale).
 */
export async function applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean> {
  if (op.type !== 'put' && op.type !== 'del') return false;
  if (!op.table) return false;
  const p = registry.get(op.table);
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
 * LWW conflict resolution helper. Given two ops on the same key,
 * return the one to keep (later ts wins; ties broken by op type
 * — `del` beats `put` on tie for safety).
 */
export function lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope {
  const ta = a.ts ?? 0;
  const tb = b.ts ?? 0;
  if (ta > tb) return a;
  if (tb > ta) return b;
  // Tie: del beats put.
  if (a.type === 'del' && b.type !== 'del') return a;
  if (b.type === 'del' && a.type !== 'del') return b;
  // True tie — caller-stable order. Return a (the first arg) as deterministic.
  return a;
}
