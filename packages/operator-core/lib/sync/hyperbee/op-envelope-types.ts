/**
 * op-envelope-types — the projection-layer op envelope (Model B).
 *
 * `OpEnvelope` was originally declared in `autobase-setup.ts` (the multi-writer
 * Autobase). Stage 4 retired the Autobase data layer (the boot path now runs on
 * per-peer logs + a read-merge) and Stage 5 deleted `autobase-setup.ts`
 * entirely, but the PROJECTION layer's op shape is still the contract every
 * projection writer + the read-merge speak. It lives here so the surviving
 * consumers — `projection.ts`, `read-merge.ts`, `peer-log.ts` — own it directly
 * with no Autobase dependency.
 *
 * The `addWriter` variant is a vestige of the retired Autobase admission op; no
 * Model B code path emits or consumes it. Kept on the union only so historical
 * shapes parse without a narrowing error; safe to drop once nothing references
 * it.
 */

export interface OpEnvelope {
  type: 'put' | 'del' | 'addWriter';
  // For addWriter (retired Autobase admission op — no live Model B emitter):
  key?: string;
  // For put/del:
  table?: string;
  hbKey?: string;
  value?: unknown;
  schema_version?: number;
  ts?: number;
  /**
   * Hybrid Logical Clock stamp (D-003), `encodeHlc`-encoded (sortable string).
   * When BOTH ops in a conflict carry one, `lwwPick` orders by HLC instead of
   * the bare wall-clock `ts` — monotone across NTP corrections and causally
   * correct across machines. Optional + additive: ops without it fall back to
   * `ts`, so the field can be rolled out per surface without a flag day.
   */
  hlc?: string;
  /**
   * Hex-encoded writer pubkey. Optional on local writes (callers may
   * not have it threaded yet); when present, projections fire the
   * clobber-events `observeMergedOp` on apply so a stale remote
   * override of a recent local write surfaces as a toast. v5 D-012.
   */
  writerPubkey?: string;
  /**
   * G1 Provenance (P-002): hex-encoded keyHex of the admitted log this op
   * came from. Set by the read-merge `toEnvelope` to the source log's
   * `keyHex`. The apply path compares this against the own log's `keyHex`
   * to determine `origin` ('local' | 'remote') without relying on the
   * self-declared `writerPubkey` alone. Absent on synthetic / test ops
   * that are built outside the merge path.
   */
  sourceLogKeyHex?: string;
}
