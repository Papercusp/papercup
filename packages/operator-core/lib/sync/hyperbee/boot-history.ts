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
 *   - 'peer_unrevoked'    — WI-193 (G8): a REFRESH-SOURCED revocation (the pubkey
 *                           was never named in a live handle.revoke() call) is no
 *                           longer present in the published revoked-pubkeys list —
 *                           applyRevocationRefresh reconciled it out of `revoked`,
 *                           so the peer is admissible again on its next announce.
 *   - 'replication_stalled' — WI-183: an admitted REMOTE log has held zero live
 *                           replicator peers (`core.peers.length`) for the stall
 *                           grace window, having shown at least one before. This
 *                           is the previously-SILENT failure mode from WI-183's
 *                           repro: the swarm reports `peer_connected` (transport
 *                           live) but this specific log's replication stream never
 *                           resumed, so writes on the remote peer stop crossing —
 *                           with no error and a boot log that otherwise looks
 *                           healthy. See `checkReplicationStall` in boot.ts.
 *   - 'replication_frozen' — P-004 (WI-183 class, attached-but-dead variant): an
 *                           admitted REMOTE log HAS a live replicator session but
 *                           its merge position hasn't advanced past the grace
 *                           window while the writer is known ahead — replication
 *                           attached but ingesting nothing. Emitted by
 *                           replication-liveness.ts (which also files a durable EI).
 *   - 'announce_admitted' — an inbound signed announce passed read-admission and
 *                           its per-peer log was added to the admitted set (Model B).
 *   - 'announce_pending'  — an inbound announce returned a 'pending' binding result
 *                           (channel-2 file not yet visible on GitHub); the peer
 *                           is stored for retry within the grace window (D-006).
 *   - 'announce_rejected' — an inbound announce failed the read-admission decision
 *                           (bad_sig / binding_invalid / revoked).
 *   - 'announce_clock_skew' — WI-1662: an inbound announce failed ONLY the D-007
 *                           freshness check (`verifyAnnounceDetailed` reason
 *                           'stale_ts') — the sig itself is valid, but the sender's
 *                           `ts` is >5min from this machine's clock. Recorded
 *                           ALONGSIDE (not instead of) the 'announce_rejected' the
 *                           frame still gets, so a skewed-clock peer is distinguishable
 *                           from a genuinely bad/forged signature: previously both
 *                           collapsed into the same indistinguishable `sigValid=false`
 *                           and the peer's log just silently never admitted, with
 *                           nothing pointing at "check this machine's clock/NTP".
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
  // WI-1910 hardening (join-lifecycle witnesses): 'join_started' fires at
  // joinForBinding ENTRY (before its first await), 'join_succeeded' after the
  // swarm join returns. A 'join_started' with NEITHER 'join_succeeded' NOR
  // 'swarm_join_failed' is the silent-wedge signature (an await stuck on the
  // join critical path); no 'join_started' at all means the join was never
  // attempted. The WI-1910 rig hunt had no signal separating those two states
  // from a healthy-but-undialed swarm — each is a different bug class.
  | 'join_started'
  | 'join_succeeded'
  | 'swarm_join_failed'
  | 'peer_rejected'
  | 'peer_rate_limited'
  // P-008 (harden-shared-hive-to-256-peers): swarm peer-CONNECTION at/near the maxPeers
  // ceiling — Hyperswarm silently refuses peer N+1 at the cap, so onNearPeerCap records it
  // to make approaching/hitting 256 VISIBLE. Distinct from 'peer_capped' below (an admitted
  // peer's LOG exceeded the per-author op cap, not a connection-count signal).
  | 'peer_cap_near'
  | 'peer_capped'
  | 'peer_revoked'
  | 'peer_unrevoked'
  | 'replication_stalled'
  // P-004 (WI-1840, WI-183 class): an admitted REMOTE log has a live replicator
  // session attached (peers > 0) but the merge position has not advanced past
  // the grace window while the writer is known to be ahead — attached-but-dead
  // replication (blocks/ingest not flowing). Emitted edge-triggered by
  // replication-liveness.ts; the durable escalation is the EI it also files.
  | 'replication_frozen'
  | 'announce_admitted'
  | 'announce_pending'
  | 'announce_rejected'
  // WI-1662: recorded alongside 'announce_rejected' when the rejection reason is
  // SPECIFICALLY clock skew (stale_ts) rather than a bad/forged signature — see the
  // doc comment above.
  | 'announce_clock_skew'
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
  | 'rekey_grant_skipped'
  // WI-280 (boundary loud-signal): the revoke / go-private boundary path SKIPPED its epoch advance
  // without throwing — revokeHiveContributor early-returned (no_target / not_owner / no_owner_identity
  // / no_owner_row / revoke_failed) so advanceEpochOnHiveBoundary was never reached, OR the advance
  // itself no-op'd (flag off / no-author / no fresh members) → live:false. Mirrors rekey_grant_skipped
  // for the grant path: names the silent boundary 0→0 so a K2 revoke that doesn't advance NAMES why
  // (instead of a manual trace to the revoke early-return).
  | 'rekey_boundary_skipped'
  // WI-808 (content-federation drop diagnosis): the apply-side epoch decrypt-gate's
  // per-op verdict. Both failure verdicts were previously SILENT (`return false`), so a
  // federated content op that never landed on a joiner left NO signal — indistinguishable
  // from the gate never being installed. These name the cause:
  //   - 'epoch_gate_built'    — rekeyDeps non-null: the decrypt gate IS wrapping applyImpl
  //                             for this harness (carries the resolved potHomeSlug = AAD potId).
  //   - 'epoch_defer'         — an encrypted op deferred: its epoch key is not yet local.
  //   - 'epoch_decrypt_fail'  — have a key but decrypt failed (wrong key / AAD mismatch:
  //                             potId is the LOCAL home slug, not a federated field) → DROP.
  //   - 'epoch_applied'       — an encrypted op decrypted + applied (the success path).
  | 'epoch_gate_built'
  // WI-808 decisive entry trace: an encrypted-looking op (epoch stamped OR `{__rekey}`
  // value) REACHED the decrypt-gate. Distinguishes "content dropped UPSTREAM of the
  // gate" (this never fires) from "reached the gate but passed through" (fires with
  // epoch=NULL = the wire-stamp-lost case). The verdict kinds below follow it.
  | 'epoch_gate_seen'
  | 'epoch_defer'
  | 'epoch_decrypt_fail'
  | 'epoch_applied'
  // WI-3604 (recurrence guard for the split-DHT-universe outage class): recorded
  // once per harness join, right after this process's shared swarm resolves its
  // DHT bootstrap. 'dht_universe_ok' = either no expectation is configured
  // (PAPERCUSP_EXPECTED_DHT_BOOTSTRAP[_FILE] unset) or the resolved bootstrap
  // matches it. 'dht_universe_mismatch' = an expectation IS configured but this
  // process resolved to a DIFFERENT universe (public DHT, a different isolated
  // bootstrap, or a malformed env value) — the exact 2026-07-09 Mac VM incident
  // (a LaunchAgent's EnvironmentVariables not inherited by a manual app
  // relaunch, so PAPERCUSP_DHT_BOOTSTRAP silently read empty and the process
  // joined the PUBLIC DHT while every peer expected the isolated rig DHT). See
  // `resolveDhtUniverseState`/`assertDhtUniverse` in swarm.ts and the
  // `dhtUniverseMismatch` axis in replication-liveness.ts, which reads any
  // subsequent per-log stall as THIS cause instead of connected-but-dead.
  | 'dht_universe_ok'
  | 'dht_universe_mismatch';

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
