/**
 * lock-authority — the per-harness LOCK AUTHORITY primitive (Track B of
 * distributed-coordination-shared-harness-2026-06-04).
 *
 * # What this is
 *
 * In a shared harness, control state that needs MUTUAL EXCLUSION (file-claim
 * locks, plan-item claim leases) cannot ride the eventually-consistent peer-log
 * the way append-mostly CONTENT does — forcing an exclusive through a
 * last-writer-wins merge split-brains (two machines both "win"). So contended
 * acquires are serialized at a single point per harness: the **lock authority**.
 *
 * The authority is NOT elected by a protocol. It is a **deterministic function
 * of live swarm membership** (D-005): the peer with the lowest live
 * `device_pubkey` among the harness's `shared_presence` peers whose heartbeat is
 * fresh. Every peer computes this independently from the already-federated
 * presence roster, so there is no election round-trip and no leader-lease CAS
 * race. When the current authority's heartbeat goes stale, the next-lowest peer
 * automatically *is* the authority by definition — failover with zero
 * coordination.
 *
 * # Why a no-op today, load-bearing tomorrow
 *
 * The shipping product is a desktop app backed by **embedded Postgres per
 * machine** (CLAUDE.md "Database topology"). Each machine then has its OWN
 * `papercusp_su` lock store, so a file-claim lock on a shared file genuinely
 * needs a cross-machine serialization point — the authority. On the current
 * single shared-PG dev box there is one `papercusp_su` for everyone and the PG
 * advisory lock already serializes, so the authority resolves to `{isSelf:true}`
 * (no remote peers in `shared_presence`) and routing is a direct local call.
 * Correct in both worlds; the cross-machine teeth grow in when machines run
 * separate embedded-pg.
 *
 * # Fail-open is correct, not a compromise (D-004)
 *
 * A shared harness is a git repo kept in sync by git-sync, with a
 * merge-resolver for conflicts. So cross-machine edit conflicts are ALREADY
 * resolved — git protects the data. Distributed locks are an optimization to
 * reduce merge churn, not a correctness requirement. When the authority is
 * unreachable (or during a failover gap), {@link routeToAuthority} proceeds
 * locally with a loud warning rather than blocking on an unreachable peer.
 *
 * # The RPC wire-leg is a seam
 *
 * There is no peer-to-peer RPC transport in the tree yet (the Hyperswarm
 * substrate replicates data, it is not request/response). So the remote leg of
 * {@link routeToAuthority} goes through a pluggable {@link PeerRpcTransport}
 * whose default implementation always reports the peer unreachable → fail-open.
 * When a real transport lands (HTTP-over-mesh to the authority's `:3070`, or an
 * RPC channel over the existing Hyperswarm connection), inject it via
 * {@link setPeerRpcTransport} and the remote path lights up with no change to
 * callers. See ./peer-rpc-transport.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveUsageActor } from '../harness/usage-actor';
import { systemDistinctId } from '../flag-distinct-id';
import { getPeerRpcTransport, PeerUnreachableError } from './peer-rpc-transport';
import { getAuthorityEvictionMonitor, type AuthorityEvictionMonitor } from './peer-eviction';
import { selectAuthorityRendezvous, type RendezvousPeerRow } from './rendezvous-authority';

/**
 * A peer in a harness swarm, identified by the same `(github_user_id,
 * machine_label, device_pubkey)` triple `shared_presence` carries. The
 * `device_pubkey` (raw 32-byte Ed25519, base64) is the authority-selection key.
 */
export interface PeerRef {
  devicePubkey: string;
  githubUserId: number;
  machineLabel: string;
}

/** The resolved authority for one harness, from this peer's point of view. */
export interface AuthorityResolution {
  /** True when THIS peer is the authority (or is alone / has no swarm). */
  isSelf: boolean;
  /** The remote authority peer, set only when `isSelf` is false. */
  peer?: PeerRef;
  /**
   * Total count of live peers considered (including self if present). 0 means
   * "no swarm / single box" — isSelf is true in that case.
   */
  liveCount: number;
}

/** This peer's own swarm identity, or null when it has none (gh unauthenticated). */
export interface SelfSwarmIdentity {
  githubUserId: number;
  devicePubkey: string;
}

/**
 * The default staleness window. A `shared_presence` peer counts as "live" only
 * if its `last_seen_at` is within this window of now. This window IS the
 * hysteresis that stops a flapping peer from thrashing the authority (the plan's
 * "Authority churn" risk): a peer must miss heartbeats for the whole window
 * before it drops out of the candidate set. Tune via {@link LockAuthorityDeps}.
 */
export const DEFAULT_AUTHORITY_STALE_MS = 90_000;

/** A live presence row, reshaped for selection. */
interface LivePeerRow {
  device_pubkey: string;
  github_user_id: number;
  machine_label: string;
  last_seen_ms: number;
}

/**
 * Injectable seams — all defaulted to the real runtime, overridden in tests so
 * the selection logic (argmin / isSelf / empty-set / failover) is pure and
 * deterministic without a booted operator.
 */
export interface LockAuthorityDeps {
  /** Fetch presence rows for a harness. `staleMs` is the (TS) staleness window so
   *  the impl can apply a LOOSE SQL pre-filter (P-006); the authoritative freshness
   *  cut still happens in TS. Impls may ignore it (e.g. test stubs). */
  fetchPresenceRows?: (harnessSlug: string, staleMs: number) => Promise<LivePeerRow[]>;
  /** Fetch presence rows for a HIVE (P-009 — `WHERE hive_slug = ?`). Used by
   *  {@link lockAuthorityForHive}; `staleMs` threads the same LOOSE SQL pre-filter
   *  as the harness path. Freshness filtered in TS. */
  fetchHivePresenceRows?: (potSlug: string, staleMs: number) => Promise<LivePeerRow[]>;
  /** Resolve THIS peer's swarm identity, or null if it has none. */
  resolveSelf?: () => Promise<SelfSwarmIdentity | null>;
  /** Current epoch ms (injectable clock). */
  now?: () => number;
  /** Staleness window in ms. Defaults to {@link DEFAULT_AUTHORITY_STALE_MS}. */
  staleMs?: number;
  /**
   * P-016 eviction monitor. When present (or installed globally at boot behind
   * the flag), a remote peer that relays confirm DEAD is excluded from candidacy
   * before the staleness window elapses. `undefined` → use the global monitor
   * (`getAuthorityEvictionMonitor`); `null` → force-disable (no eviction, the
   * pre-P-016 staleness-only behavior). Default (no global installed) → no-op.
   */
  evictionMonitor?: AuthorityEvictionMonitor | null;
  /**
   * WI-1491 (P-021 live cutover): the fine-grained scope key to shard authority
   * selection on when the `HRW_RENDEZVOUS_AUTHORITY` flag is on (a file path, a
   * plan-item id, a work-item id — whatever the caller is actually serializing).
   * Omit to fall back to the harness/hive slug itself as the scope key — every
   * EXISTING call site keeps working unchanged (same single scope per harness/hive
   * as today's argmin), it just gets HRW's winner instead of argmin's when the flag
   * is on. Threading a finer-grained key through a given call site is a caller-side
   * follow-up, not required for the cutover itself.
   */
  scopeKey?: string;
  /**
   * Test/caller override for the `HRW_RENDEZVOUS_AUTHORITY` flag read — skips the
   * PostHog round-trip. `undefined` (default) → read the live flag.
   */
  useHrwRendezvous?: boolean;
}

/**
 * Resolve whether this selection should use HRW rendezvous hashing (WI-1491) —
 * `deps.useHrwRendezvous` short-circuits the flag read (tests / callers that already
 * know), otherwise reads the live `HRW_RENDEZVOUS_AUTHORITY` flag. Exported for
 * direct unit testing of the gate itself, independent of the DB-backed selection.
 */
export async function resolveUseHrwRendezvous(deps: LockAuthorityDeps): Promise<boolean> {
  if (deps.useHrwRendezvous !== undefined) return deps.useHrwRendezvous;
  return getFlag(FLAGS.HRW_RENDEZVOUS_AUTHORITY, systemDistinctId());
}

/**
 * The canonical `shared_presence` query, parameterized on `sql` so it can run
 * against the live org PG OR a test schema. Across all workspaces sharing this
 * harness — they are all peers in the one harness swarm, so the authority is the
 * global min for the harness_slug.
 */
export async function queryPresenceRows(
  sql: { <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  harnessSlug: string,
  staleMs: number = DEFAULT_AUTHORITY_STALE_MS,
): Promise<LivePeerRow[]> {
  // P-006: prune long-dead peers in SQL so Postgres does not materialize EVERY
  // presence row ever seen for the harness (an unbounded scan at 256 peers). The
  // cutoff is deliberately LOOSE — 2× the staleness window — so the SQL pre-filter
  // is strictly wider than the authoritative TS freshness cut applied later in
  // {@link selectAuthorityFromRows} (`last_seen_ms > now - staleMs`). It can never
  // drop a row the TS filter would have kept, even under app↔DB clock skew, so the
  // argmin-over-fresh-rows result is byte-identical; only dead rows are excluded.
  const looseWindowSecs = (2 * staleMs) / 1000;
  const rows = (await sql`
    SELECT device_pubkey,
           github_user_id,
           machine_label,
           (extract(epoch FROM last_seen_at) * 1000)::bigint AS last_seen_ms
    FROM harness_shared.shared_presence
    WHERE harness_slug = ${harnessSlug}
      AND device_pubkey <> ''
      AND last_seen_at >= now() - make_interval(secs => ${looseWindowSecs})
  `) as Array<{
    device_pubkey: string;
    github_user_id: number;
    machine_label: string;
    last_seen_ms: string | number;
  }>;
  return rows.map((r) => ({
    device_pubkey: r.device_pubkey,
    github_user_id: Number(r.github_user_id),
    machine_label: r.machine_label,
    last_seen_ms: Number(r.last_seen_ms),
  }));
}

async function defaultFetchPresenceRows(harnessSlug: string, staleMs: number): Promise<LivePeerRow[]> {
  const { sql } = getOrgPg();
  return queryPresenceRows(sql as never, harnessSlug, staleMs);
}

/**
 * The Hive-scoped presence query (P-009): all presence rows whose `hive_slug`
 * matches — i.e. the Swarms of a shared Hive. Authority across a Hive is the
 * lowest live device_pubkey over these. Parameterized on `sql` for tests.
 */
export async function queryPresenceRowsForHive(
  sql: { <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  potSlug: string,
  staleMs: number = DEFAULT_AUTHORITY_STALE_MS,
): Promise<LivePeerRow[]> {
  // P-006: same LOOSE (2× staleness window) SQL pre-filter as the harness path —
  // Postgres prunes long-dead Swarms instead of scanning every hive row ever seen,
  // while staying strictly wider than the TS freshness cut so the Hive argmin is
  // unchanged. See {@link queryPresenceRows} for the full rationale.
  const looseWindowSecs = (2 * staleMs) / 1000;
  const rows = (await sql`
    SELECT device_pubkey,
           github_user_id,
           machine_label,
           (extract(epoch FROM last_seen_at) * 1000)::bigint AS last_seen_ms
    FROM harness_shared.shared_presence
    WHERE pot_slug = ${potSlug}
      AND device_pubkey <> ''
      AND last_seen_at >= now() - make_interval(secs => ${looseWindowSecs})
  `) as Array<{
    device_pubkey: string;
    github_user_id: number;
    machine_label: string;
    last_seen_ms: string | number;
  }>;
  return rows.map((r) => ({
    device_pubkey: r.device_pubkey,
    github_user_id: Number(r.github_user_id),
    machine_label: r.machine_label,
    last_seen_ms: Number(r.last_seen_ms),
  }));
}

async function defaultFetchHivePresenceRows(potSlug: string, staleMs: number): Promise<LivePeerRow[]> {
  const { sql } = getOrgPg();
  return queryPresenceRowsForHive(sql as never, potSlug, staleMs);
}

async function defaultResolveSelf(): Promise<SelfSwarmIdentity | null> {
  const actor = await resolveUsageActor();
  if (!actor) return null;
  return { githubUserId: actor.githubUserId, devicePubkey: actor.devicePubkey };
}

/**
 * The PURE authority-selection core (D-005): from a scope's presence rows + this
 * peer's identity, pick the lowest live `device_pubkey`. Shared by the
 * harness-scoped {@link lockAuthorityFor} and the Hive-scoped
 * {@link lockAuthorityForHive} — the only thing that differs between them is WHICH
 * presence rows are fetched (harness_slug vs hive_slug); the argmin/isSelf/empty
 * logic is identical, so it lives here once. Exported for direct unit testing.
 */
export function selectAuthorityFromRows(
  rows: LivePeerRow[],
  self: SelfSwarmIdentity | null,
  nowMs: number,
  staleMs: number,
  excluded?: ReadonlySet<string>,
): AuthorityResolution {
  const cutoff = nowMs - staleMs;
  // Dedup by device_pubkey, keeping the freshest row per pubkey. A pubkey in
  // `excluded` (P-016: relay-confirmed dead) is dropped from candidacy here, the
  // same as if it had gone stale — but earlier than the staleness window. Self is
  // never excluded (added unconditionally below); the monitor never evicts self.
  const byPubkey = new Map<string, LivePeerRow>();
  for (const r of rows) {
    if (!r.device_pubkey || r.last_seen_ms <= cutoff) continue;
    if (excluded?.has(r.device_pubkey)) continue;
    const prior = byPubkey.get(r.device_pubkey);
    if (!prior || r.last_seen_ms > prior.last_seen_ms) byPubkey.set(r.device_pubkey, r);
  }
  // Self is always a candidate when it has an identity, even if this machine
  // does not (yet) publish its own presence row.
  if (self && !byPubkey.has(self.devicePubkey)) {
    byPubkey.set(self.devicePubkey, {
      device_pubkey: self.devicePubkey,
      github_user_id: self.githubUserId,
      machine_label: '(self)',
      last_seen_ms: nowMs,
    });
  }

  const candidates = [...byPubkey.values()];
  if (candidates.length === 0) {
    // No swarm, no self identity — single box. We are the authority.
    return { isSelf: true, liveCount: 0 };
  }

  // argmin(device_pubkey), lexicographic — deterministic across all peers.
  let winner = candidates[0];
  for (const c of candidates) if (c.device_pubkey < winner.device_pubkey) winner = c;

  const isSelf = self != null && winner.device_pubkey === self.devicePubkey;
  if (isSelf) return { isSelf: true, liveCount: candidates.length };

  return {
    isSelf: false,
    liveCount: candidates.length,
    peer: {
      devicePubkey: winner.device_pubkey,
      githubUserId: winner.github_user_id,
      machineLabel: winner.machine_label,
    },
  };
}

/**
 * Resolve who serializes locks/claims for `harnessSlug`, and whether that is us.
 *
 * Algorithm (D-005):
 *  1. Gather live peers = `shared_presence` rows for the harness whose
 *     `last_seen_at` is within the staleness window.
 *  2. Add SELF to the candidate set (self may also already be present if this
 *     machine announces its own presence; dedup by `device_pubkey`).
 *  3. authority = argmin(device_pubkey) over the candidate set (lexicographic).
 *  4. isSelf = (authority's pubkey === self's pubkey).
 *
 * Edge cases:
 *  - No candidates at all (single box, no federation identity) → `{isSelf:true,
 *    liveCount:0}`. You are alone; you are the authority.
 *  - Self has no swarm identity but remote peers exist → `{isSelf:false,
 *    peer:<min remote>}`. The caller's {@link routeToAuthority} then fails open
 *    to a local-advisory operation (no transport to reach the remote, and git is
 *    the backstop).
 */
export async function lockAuthorityFor(
  harnessSlug: string,
  deps: LockAuthorityDeps = {},
): Promise<AuthorityResolution> {
  if (!harnessSlug || typeof harnessSlug !== 'string') {
    throw new TypeError('lockAuthorityFor: harnessSlug must be a non-empty string');
  }
  const fetchRows = deps.fetchPresenceRows ?? defaultFetchPresenceRows;
  const resolveSelf = deps.resolveSelf ?? defaultResolveSelf;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? DEFAULT_AUTHORITY_STALE_MS;

  const [rows, self, useHrw] = await Promise.all([
    fetchRows(harnessSlug, staleMs),
    resolveSelf(),
    resolveUseHrwRendezvous(deps),
  ]);
  const nowMs = now();
  const excluded = evictionExclusions(harnessSlug, rows, self, nowMs, deps);
  if (useHrw) {
    return selectAuthorityRendezvous(
      rows as RendezvousPeerRow[],
      self,
      nowMs,
      staleMs,
      deps.scopeKey ?? harnessSlug,
      excluded,
    );
  }
  return selectAuthorityFromRows(rows, self, nowMs, staleMs, excluded);
}

/**
 * P-016: consult the eviction monitor for a scope. Resolves the monitor
 * (`deps.evictionMonitor`, else the global), feeds it the presence rows + kicks a
 * throttled background relay probe, and returns the CURRENT cached evicted set
 * (sync, never awaits). `undefined` when no monitor is installed → selection is
 * staleness-only (pre-P-016 behavior).
 */
function evictionExclusions(
  scope: string,
  rows: LivePeerRow[],
  self: SelfSwarmIdentity | null,
  nowMs: number,
  deps: LockAuthorityDeps,
): ReadonlySet<string> | undefined {
  const monitor = deps.evictionMonitor !== undefined ? deps.evictionMonitor : getAuthorityEvictionMonitor();
  if (!monitor) return undefined;
  const observations = rows.map((r) => ({
    peer: { devicePubkey: r.device_pubkey, githubUserId: r.github_user_id, machineLabel: r.machine_label },
    lastSeenMs: r.last_seen_ms,
  }));
  return monitor.beforeSelect(scope, observations, self?.devicePubkey ?? null, nowMs);
}

/**
 * Resolve who serializes locks/claims for a shared HIVE (P-009, D-011), and
 * whether that is us. Same D-005 algorithm as {@link lockAuthorityFor} — the
 * lowest live device_pubkey — but the candidate set is the Hive's Swarms
 * (`shared_presence WHERE hive_slug = ?`) rather than one harness's peers.
 *
 * Post-Hive, presence is announced per-Swarm for the whole Hive, so a Hive has
 * ONE authority across all its harnesses' file-claim locks. Non-Hive harnesses
 * keep using {@link lockAuthorityFor} (their presence rows have a NULL hive_slug).
 *
 * Like the harness path it is a no-op-to-local on a single box (no remote Swarms
 * in presence → `{isSelf:true}`); the cross-machine teeth grow in once presence
 * federation (P-008) populates remote Swarms' hive_slug presence rows.
 */
export async function lockAuthorityForHive(
  potSlug: string,
  deps: LockAuthorityDeps = {},
): Promise<AuthorityResolution> {
  if (!potSlug || typeof potSlug !== 'string') {
    throw new TypeError('lockAuthorityForHive: potSlug must be a non-empty string');
  }
  const fetchRows = deps.fetchHivePresenceRows ?? defaultFetchHivePresenceRows;
  const resolveSelf = deps.resolveSelf ?? defaultResolveSelf;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? DEFAULT_AUTHORITY_STALE_MS;

  const [rows, self, useHrw] = await Promise.all([
    fetchRows(potSlug, staleMs),
    resolveSelf(),
    resolveUseHrwRendezvous(deps),
  ]);
  const nowMs = now();
  const excluded = evictionExclusions(potSlug, rows, self, nowMs, deps);
  if (useHrw) {
    return selectAuthorityRendezvous(
      rows as RendezvousPeerRow[],
      self,
      nowMs,
      staleMs,
      deps.scopeKey ?? potSlug,
      excluded,
    );
  }
  return selectAuthorityFromRows(rows, self, nowMs, staleMs, excluded);
}

/**
 * The RPC envelope sent to a remote authority when `isSelf` is false and a
 * transport is available. The caller supplies it so the authority can re-run the
 * operation on the holder's behalf. When no transport is available (today), the
 * envelope is never sent — {@link routeToAuthority} fails open and runs `local`.
 */
export interface AuthorityOp<T> {
  /** Run the operation HERE (used when we are the authority, or on fail-open). */
  local: () => Promise<T>;
  /**
   * Optional RPC request body identifying the operation for a remote authority.
   * Omit to make a remote authority always fail open to `local` — correct under
   * D-004 (git is the backstop) and the only behavior possible without a wire
   * transport.
   */
  remote?: { kind: string; payload: unknown; decode: (raw: unknown) => T };
}

/** Reported when a routed op fell back to local because the authority was remote. */
export interface RouteResult<T> {
  value: T;
  /** 'local-authority' | 'remote-authority' | 'fail-open' */
  via: 'local-authority' | 'remote-authority' | 'fail-open';
  /** Set on fail-open: a human-readable warning the caller should surface. */
  warning?: string;
}

/**
 * Route a lock/claim operation to the harness's authority.
 *
 * - We are the authority → run `op.local()` directly (`via:'local-authority'`).
 * - A remote authority + a transport + `op.remote` → RPC it
 *   (`via:'remote-authority'`).
 * - A remote authority but unreachable / no transport / no `op.remote` →
 *   **fail open** (D-004): run `op.local()` and return a warning
 *   (`via:'fail-open'`). The data is still protected by git-merge.
 *
 * This is the entry point peers (e.g. plan-item claim leasing,
 * plan-item-assignment-claim-liveness-2026-06-04) call so their control ops ride
 * the authority without re-implementing selection.
 */
export async function routeToAuthority<T>(
  harnessSlug: string,
  op: AuthorityOp<T>,
  deps: LockAuthorityDeps = {},
): Promise<RouteResult<T>> {
  const resolution = await lockAuthorityFor(harnessSlug, deps);
  if (resolution.isSelf || !resolution.peer) {
    return { value: await op.local(), via: 'local-authority' };
  }

  const peer = resolution.peer;
  const transport = getPeerRpcTransport();
  if (transport && op.remote) {
    try {
      const raw = await transport.rpc(peer, {
        harnessSlug,
        kind: op.remote.kind,
        payload: op.remote.payload,
      });
      return { value: op.remote.decode(raw), via: 'remote-authority' };
    } catch (err) {
      if (!(err instanceof PeerUnreachableError)) throw err;
      // fall through to fail-open
    }
  }

  // FAIL-OPEN (D-004): authority is remote and unreachable (or no transport / no
  // remote envelope). Proceed locally; git-merge is the data-safety backstop.
  const warning =
    `lock authority for harness "${harnessSlug}" is a remote peer ` +
    `(${peer.machineLabel}, ${peer.devicePubkey.slice(0, 12)}…) and is unreachable — ` +
    `proceeding with a local-advisory grant; concurrent edits will be git-merged.`;
  return { value: await op.local(), via: 'fail-open', warning };
}

/**
 * Route a lock/claim operation to a shared HIVE's authority (P-009) — the Hive
 * analog of {@link routeToAuthority}. Resolves the authority across the Hive's
 * Swarms ({@link lockAuthorityForHive}) and applies the same local / RPC /
 * fail-open policy. The `op.remote` envelope (when a transport exists) carries the
 * hive slug as its scope key. Used by the file-claim cutover for a harness that
 * federates within a Hive (its locks serialize at the Hive authority, not the
 * harness's).
 */
export async function routeToAuthorityForHive<T>(
  potSlug: string,
  op: AuthorityOp<T>,
  deps: LockAuthorityDeps = {},
): Promise<RouteResult<T>> {
  const resolution = await lockAuthorityForHive(potSlug, deps);
  if (resolution.isSelf || !resolution.peer) {
    return { value: await op.local(), via: 'local-authority' };
  }

  const peer = resolution.peer;
  const transport = getPeerRpcTransport();
  if (transport && op.remote) {
    try {
      const raw = await transport.rpc(peer, {
        harnessSlug: potSlug, // scope key (the transport field is named harnessSlug)
        kind: op.remote.kind,
        payload: op.remote.payload,
      });
      return { value: op.remote.decode(raw), via: 'remote-authority' };
    } catch (err) {
      if (!(err instanceof PeerUnreachableError)) throw err;
      // fall through to fail-open
    }
  }

  const warning =
    `lock authority for hive "${potSlug}" is a remote Swarm ` +
    `(${peer.machineLabel}, ${peer.devicePubkey.slice(0, 12)}…) and is unreachable — ` +
    `proceeding with a local-advisory grant; concurrent edits will be git-merged.`;
  return { value: await op.local(), via: 'fail-open', warning };
}

/**
 * Convenience: the bare boolean "am I the authority for this harness?" — for
 * callers (e.g. su-119ce's claim store) that want the {@link AuthorityResolution}
 * shape `{ isSelf, peer? }` directly.
 */
export async function isLockAuthority(
  harnessSlug: string,
  deps: LockAuthorityDeps = {},
): Promise<AuthorityResolution> {
  return lockAuthorityFor(harnessSlug, deps);
}

export const _testing = { defaultResolveSelf, defaultFetchPresenceRows };
