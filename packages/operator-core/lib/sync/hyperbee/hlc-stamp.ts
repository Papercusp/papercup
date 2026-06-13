/**
 * hlc-stamp — the substrate's two HLC seams (shared-hive-hardening-2026-06-13 P-010).
 *
 * D-003 specified that LWW-federated writes carry a Hybrid Logical Clock so
 * `lwwPick` orders cross-peer conflicts by CAUSALITY rather than bare wall-clock
 * `ts` (a fast/stepped clock can otherwise resurrect a stale write or let a
 * skewed peer always win). The HLC primitives shipped in `@papercusp/locks-core`
 * (`processHlc`/`encodeHlc`/`decodeHlc`) but were NEVER wired into the
 * `sync/hyperbee` capture path — so until P-010 NO federated write carried an
 * `hlc` and `lwwPick` ALWAYS fell back to `ts`. This module is the one place that
 * couples the substrate to the process HLC clock:
 *
 *   - `stampOpHlc(op)` — the SEND seam. `handle.append` (`boot.ts`) calls it on
 *     every write funneled to the own log, so every LWW-federated op carries a
 *     causal order key. (Claims use the raw `ownLog.append` and are append-only
 *     distinct-key — they never LWW — so they correctly skip this.)
 *   - `observeRemoteHlc(hlc)` — the RECV seam. The apply path (`projection.ts`
 *     `applyOpVia`) calls it for every applied REMOTE op, advancing this
 *     process's clock past the remote causal frontier so a subsequent local
 *     write is stamped strictly-greater — the cross-machine happens-before that
 *     makes the order causal rather than skew-dependent.
 *
 * Both are additive + back-compat: an op without an `hlc` (pre-P-010 history,
 * the claim path) falls back to `ts` in `lwwPick`, so the field rolls out with
 * no flag day.
 */

import { encodeHlc, decodeHlc, processHlc } from '@papercusp/locks-core';

/**
 * SEND seam: stamp a federated write with a causal HLC order key. A pre-set
 * `hlc` is PRESERVED (not overwritten) — a caller replaying a captured HLC keeps
 * it; everything else gets a fresh, process-monotone stamp. Returns the same op
 * shape with `hlc` guaranteed set.
 */
export function stampOpHlc<T extends { hlc?: string }>(op: T): T & { hlc: string } {
  if (op.hlc) return op as T & { hlc: string };
  return { ...op, hlc: encodeHlc(processHlc().now()) };
}

/**
 * RECV seam: advance the process HLC past an observed remote op's HLC, so a
 * later local write causally follows it. No-op when the op carries no `hlc`
 * (pre-P-010 / claim-path ops) — back-compat. Never throws: `decodeHlc` returns
 * `HLC_ZERO` on a malformed string, and `recv` of zero is a no-op advance.
 */
export function observeRemoteHlc(hlc: string | undefined | null): void {
  if (!hlc) return;
  processHlc().recv(decodeHlc(hlc));
}
