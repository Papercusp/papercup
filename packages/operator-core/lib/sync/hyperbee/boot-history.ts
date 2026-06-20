/**
 * boot-history — in-process record of substrate boot events.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Tracks each `bootHarnessSubstrate` start / finish / close so flaky-
 * boot debugging has a per-harness timeline. Distinct from `boot-all`
 * (which holds the live handle map): this is the *history* of boot
 * events, including ones that fell out of the map.
 *
 * Pure logic — module-level append-only buffer with a configurable
 * cap (default 200 entries). Process-local; clears when the operator
 * restarts. Test seams for time + reset.
 *
 * Event kinds:
 *   - 'boot_start'        — bootHarnessSubstrate called; corestore opening.
 *   - 'boot_ok'           — bootHarnessSubstrate returned successfully.
 *   - 'boot_fail'         — bootHarnessSubstrate threw.
 *   - 'close'             — handle.close() called.
 *   - 'peer_connected'    — a Hyperswarm peer connected to a swarmed harness.
 *   - 'swarm_join_failed' — swarm join threw; harness stays local-only.
 *   - 'peer_rejected'     — a banned peer's connection was dropped (DoS guard;
 *                           most banned keys are firewall-rejected pre-handshake
 *                           and never recorded here — this is in-flight/IP-ban).
 *   - 'peer_rate_limited' — a peer tripped the per-peer connection-rate limit and
 *                           was banned + dropped (DoS guard).
 *   - 'peer_capped'       — an admitted peer's log exceeded the per-author op
 *                           cap; the merge ingested only the first N ops this
 *                           pass (DoS Phase-4 reshape — a noisy peer bloats only
 *                           its own tail, not the whole merge).
 *   - 'peer_revoked'      — an admitted peer was revoked (D-004): its log was
 *                           dropped from the admitted set + its pubkey blocklisted.
 *   - 'announce_admitted' — an inbound signed announce passed read-admission and
 *                           its per-peer log was added to the admitted set (Model B).
 *   - 'announce_pending'  — an inbound announce returned a 'pending' binding result
 *                           (channel-2 file not yet visible on GitHub); the peer
 *                           is stored for retry within the grace window (D-006).
 *   - 'announce_rejected' — an inbound announce failed the read-admission decision
 *                           (bad_sig / binding_invalid / revoked).
 *   - 'announce_error'    — an exception while handling an announce (defensive).
 *   - 'merge_error'       — the read-merge driver threw on a pass (defensive).
 *
 * Keep this union in sync with the second declaration in
 * `app/harness/insights/BootHistoryTable.tsx` (+ its KIND_COLOR / KIND_MARK
 * maps) — the table renders these kinds and its Record maps must stay
 * exhaustive.
 */

export type BootHistoryKind =
  | 'boot_start'
  | 'boot_ok'
  | 'boot_fail'
  | 'close'
  | 'peer_connected'
  | 'swarm_join_failed'
  | 'peer_rejected'
  | 'peer_rate_limited'
  | 'peer_capped'
  | 'peer_revoked'
  | 'announce_admitted'
  | 'announce_pending'
  | 'announce_rejected'
  | 'announce_error'
  | 'merge_error'
  // WI-280 (part B): the owner's re-key epoch-key grant to a freshly-admitted peer
  // failed. The grant is fire-and-forget (it must not block merge-gated admission),
  // so this is how the failure stays LOUD + queryable instead of a swallowed console.error.
  | 'rekey_grant_failed'
  // WI-280 (ee7e9 diagnostic): the grant SILENTLY early-returned {applied:false} WITHOUT
  // throwing — flag off / no fresh member pubkeys / no author pubkey (owner self-gate).
  // This is the non-throw 0-keys path part B's rekey_grant_failed cannot catch; the
  // message carries which condition + the input values so the witness re-run is conclusive.
  | 'rekey_grant_skipped';

export interface BootHistoryEntry {
  ts: number;
  workspaceId: string;
  harnessSlug: string;
  kind: BootHistoryKind;
  message?: string;
}

const DEFAULT_CAP = 200;

const buffer: BootHistoryEntry[] = [];
let cap = DEFAULT_CAP;

let _nowImpl: () => number = () => Date.now();

export function _setNowForTests(impl: () => number): void {
  _nowImpl = impl;
}

export function _setCapForTests(n: number): void {
  cap = n;
}

export function _resetBootHistoryForTests(): void {
  buffer.length = 0;
  cap = DEFAULT_CAP;
  _nowImpl = () => Date.now();
}

export function recordBootEvent(
  workspaceId: string,
  harnessSlug: string,
  kind: BootHistoryKind,
  message?: string,
): void {
  buffer.push({
    ts: _nowImpl(),
    workspaceId,
    harnessSlug,
    kind,
    message,
  });
  while (buffer.length > cap) buffer.shift();
}

export interface ListBootHistoryOpts {
  workspaceId?: string;
  harnessSlug?: string;
  limit?: number;
  /** Filter to events with one of these kinds. */
  kinds?: ReadonlyArray<BootHistoryKind>;
}

/**
 * Returns a fresh array each call (sorted newest first), capped at
 * `limit` (default 50).
 */
export function listBootHistory(
  opts: ListBootHistoryOpts = {},
): BootHistoryEntry[] {
  const limit = opts.limit ?? 50;
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const filtered: BootHistoryEntry[] = [];
  for (let i = buffer.length - 1; i >= 0 && filtered.length < limit; i -= 1) {
    const entry = buffer[i]!;
    if (opts.workspaceId && entry.workspaceId !== opts.workspaceId) continue;
    if (opts.harnessSlug && entry.harnessSlug !== opts.harnessSlug) continue;
    if (kinds && !kinds.has(entry.kind)) continue;
    filtered.push(entry);
  }
  return filtered;
}

export function bootHistoryDepth(): number {
  return buffer.length;
}
