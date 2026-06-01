/**
 * op-envelope-types — the projection-layer op envelope (Model B).
 *
 * `OpEnvelope` was originally declared in `autobase-setup.ts` (the multi-writer
 * Autobase). Stage 4 retired the Autobase data layer (the boot path now runs on
 * per-peer logs + a read-merge), but the PROJECTION layer's op shape is still
 * the contract every projection writer + the read-merge speak. It was relocated
 * here (Stage 4d) so the surviving consumers — `projection.ts`, `read-merge.ts`,
 * `peer-log.ts`, the orchestrator claim adapter — no longer depend on
 * `autobase-setup.ts` being kept.
 *
 * `autobase-setup.ts` re-exports `OpEnvelope` from here for any Stage-5 claim
 * code that still imports it from the old path; Stage 5 retires that module.
 */

export interface OpEnvelope {
  type: 'put' | 'del' | 'addWriter';
  // For addWriter (legacy Autobase admission op — Stage 5 claim path only):
  key?: string;
  // For put/del:
  table?: string;
  hbKey?: string;
  value?: unknown;
  schema_version?: number;
  ts?: number;
  /**
   * Hex-encoded writer pubkey. Optional on local writes (callers may
   * not have it threaded yet); when present, projections fire the
   * clobber-events `observeMergedOp` on apply so a stale remote
   * override of a recent local write surfaces as a toast. v5 D-012.
   */
  writerPubkey?: string;
}
