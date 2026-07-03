/**
 * Single-function composer: bring a harness's Model B sync substrate
 * fully online.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 4).
 *
 * Model B replaces the multi-writer Autobase with ONE signed,
 * append-only log PER PEER (`openOwnLog`) plus a read-merge over the
 * admitted set of logs (`mergeAdmittedLogs`). This composer:
 *
 *   1. Opens / creates the per-harness corestore.
 *   2. Opens the peer's OWN writable log (`openOwnLog`).
 *   3. Registers all per-table PG projection writers.
 *   4. Drives a read-merge over the admitted set (own log + any remote
 *      logs admitted at runtime via the swarm announce channel) into PG.
 *
 * Production call site (instrumentation-node.ts / host-bootstrap.ts):
 *
 *   await awaitEnsurePaths();              // P-031a — both ensure paths complete
 *   const harnesses = await loadHarnessRegistry(workspaceId);
 *   for (const h of harnesses) {
 *     handles.set(h.slug, await bootHarnessSubstrate({
 *       workspaceRoot,
 *       workspaceId,
 *       harnessSlug: h.slug,
 *     }));
 *   }
 *
 * What this function does NOT do:
 *   - PG → substrate write hooks. Those land per-table as call sites
 *     opt into "fan out my PG write to my own log too." Until then the
 *     substrate only consumes admitted ops; local writes still flow
 *     through PG-direct.
 */

import {
  getHarnessStore,
  closeHarnessStore,
  getHarnessScopedStore,
  closeHarnessScopedStore,
  type HarnessStoreOpts,
} from './corestore';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { openOwnLog, openRemoteLog, type OwnLog, type PeerLogOp, type RemoteLog } from './peer-log';
// P-004 (WI-1840, WI-183 class): the replication-liveness registry — read-time
// per-log verdicts (live/no_replicator/frozen/…) for the status surfaces + the
// durable-EI escalation on a sustained stall. Fed once per admitted remote log
// per merge pass, right next to the legacy checkReplicationStall sampling.
import {
  sampleReplicationLiveness,
  dropReplicationLogState,
  dropReplicationLiveness,
} from './replication-liveness';
import { stampOpHlc } from './hlc-stamp';
import type { HlcClock } from '@papercusp/locks-core';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  seedCursorFromSnapshots,
  findLatestSnapshotIndex,
  DEFAULT_GET_TIMEOUT_MS,
  type AdmittedLog,
} from './read-merge';
import { produceLogSnapshot, shouldCompactOwnLog } from './log-snapshot';
import type { OpEnvelope } from './op-envelope-types';
import { buildHiveRekeyBootDeps } from './hive-epoch-boot-deps';
import { drainQueuedEpochContent, type DrainedEpoch } from './hive-epoch-op-gate';
import { PendingMembershipContent } from './pending-membership-content';
import { acceptOpVersion, CURRENT_SCHEMA_VERSION, type SchemaVersionAlert } from './schema-version';
import { schemaVersionEvents } from './schema-version';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { loadRevokedPubkeys } from './load-revoked-pubkeys';
import {
  registerAllHarnessProjections,
  buildHarnessProjectionApply,
} from './projections/register-all';
import { startBootstrapProgressPoller } from './bootstrap-progress-poller';
import { recordBootEvent } from './boot-history';
import type Corestore from 'corestore';
import {
  bindingResolvesHiveHomeProjection,
  deriveSwarmTopic,
  type SwarmBinding,
} from './derive-swarm-topic';
import {
  joinHarnessSwarm,
  getSharedSwarm,
  type AnnounceConnectionContext,
  type HyperswarmLike,
  type SwarmHandle,
} from './swarm';
// ── P-006 §5.1–§5.3 scoped-log federation (P-108) ── scoped cores live in a
// SEPARATE never-`replicate()`d corestore and are served per-connection through
// the fail-closed roster gate; the coordinator hangs off the announce exchange.
import { ScopeCoreRegistry, type ScopedStoreLike } from './scope-cores';
import { ScopeFederation } from './scope-federation';
import { getScopeRoster } from '../../p2p/scope-roster';
import { PgFleetDirectory } from '../../p2p/fleet-directory';
import { bumpRefusedOpCounter } from '../../p2p/receipts';
import { formatScopeId, type ScopeId } from '../hive-git/scope-repo';
import { offloadReplicationToSidecar } from './substrate-replication-offload';
import {
  buildAnnounce,
  verifyAnnounceDetailed,
  type SignedAnnounce,
} from './announce';
import {
  makeAdmissionDecider,
  announceSlugInScope,
  trustedHiveMemberDeviceAdmission,
  type AdmissionInput,
  type AdmissionResult,
} from './read-admission';
import {
  resolveLocalAnnounceIdentity,
  resolveLocalAnnounceIdentityFromHiveMembers,
  type ResolveLocalAnnounceIdentityOpts,
  type LocalAnnounceIdentity,
} from './local-announce-identity';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { recordTelemetryReport } from '../../record-telemetry';
import { TELEMETRY_KINDS, type TelemetryKind } from '../../telemetry-kinds';
// ── Owner-enforcement (plan shared-hive-owner-enforcement-2026-06-19) ── the single
// merge-seam where every inbound op is checked against the owner's signed Hive policy:
// EN-2 rate (inner) wrapped by EN-4 ban/allowlist/takedown/content (outer). Default-off
// (no policy ⇒ passthrough). Composition is proven by policy-admission.apply.test.ts.
import type { HivePolicy } from '../../hive-policy-schema';
import { getHivePolicy } from '../../hive-policy-store';
import { isContentTakenDown } from '../../hive-moderation';
import { MemberRateLimiter } from './rate-limiter';
import { EliteNicheRateLimiter } from './elite-niche-rate-limiter';
import { registerRateLimiter, unregisterRateLimiter } from './rate-limiter-registry';
import { makeRateLimitedApply } from './rate-limit-admission';
import { makePolicyEnforcedApply } from './policy-admission';

/** Short human label for a dropped peer, for the boot-history message field.
 *  Truncates the (long) Noise key to its first 8 hex chars. */
function peerLabel(keyHex?: string, ip?: string): string {
  const parts: string[] = [];
  if (keyHex) parts.push(`key=${keyHex.slice(0, 8)}`);
  if (ip) parts.push(`ip=${ip}`);
  return parts.join(' ') || 'unknown peer';
}

/** Polled-merge fallback interval (ms). The own log + admitted remotes are
 *  re-merged on this cadence in addition to the on-admit + initial passes. */
const MERGE_POLL_MS = 1000;
/**
 * WI-183: default grace window (ms) for the replication-stall detector — how
 * long an admitted remote log may show zero live replicator peers, after
 * having shown at least one before, before it's treated as a genuine stall
 * rather than the ordinary churn of the two-speed swarm re-peer cadence
 * (`DEFAULT_SUBSTRATE_FAST_WINDOW_MS`/`_SLOW_REFRESH_MS` in swarm.ts, which
 * can legitimately take a while to re-pair). 3 minutes comfortably exceeds
 * both.
 */
const DEFAULT_REPLICATION_STALL_GRACE_MS = 3 * 60 * 1000;
/** Default pending-retry interval (ms). A pending peer is re-checked on this
 *  cadence until it becomes verified, conclusively fails, or exceeds the grace
 *  window. D-006. */
const DEFAULT_PENDING_RETRY_MS = 5000;
/**
 * Boot-scoped grace window for pending peers (ms). Once a peer has been in the
 * pending set longer than this, it is removed with 'announce_rejected' rather
 * than retried forever. This is deliberately short (vs a ~24h binding-propagation
 * window): the boot session may not live that long, and the peer will
 * re-announce on the next boot. 30 minutes is
 * enough for normal GitHub propagation lag while bounding the retry budget.
 */
const BOOT_PENDING_GRACE_MS = 30 * 60 * 1000; // 30 minutes
/**
 * WI-752 / FED-2 — JOIN-retry self-heal. The boot-time swarm join is one-shot;
 * a TRANSIENT failure (DHT not ready, a gh-identity / keychain blip, a momentary
 * network fault) lands the harness LOCAL-ONLY with NO swarm join to refresh, and
 * pre-WI-752 it stayed local-only until an operator RESTART. So a failed join is
 * retried on a bounded exponential backoff (base → cap) until it succeeds —
 * federation then establishes with no restart, and a PERMANENT cause (genuinely
 * unauthenticated, etc.) simply backs off at the cap, self-healing the instant
 * the cause clears (e.g. a gh token is restored). `swarmJoinRetryMs: 0` disables.
 */
const DEFAULT_SWARM_JOIN_RETRY_MS = 15_000;
const SWARM_JOIN_RETRY_CAP_MS = 5 * 60 * 1000; // 5 minutes
// Stage 6 (DoS Phase-4 reshape): cap how many ops the merge ingests from any
// single author per pass. A noisy/Sybil peer bloats only its OWN log, so this
// bounds per-pass ingest rather than mitigating a shared-structure flood.
const MAX_OPS_PER_AUTHOR = 50_000;
// Fix 4: bound each per-remote `core.update({wait:true})` inside `mergeNow` so a
// connected-but-stalled peer can't hold the `merging` lock forever (which would
// stall own-log progress + every other remote). Reuse the same few-second bound
// the read-merge uses for its per-op `get` (DEFAULT_GET_TIMEOUT_MS).
const UPDATE_TIMEOUT_MS = DEFAULT_GET_TIMEOUT_MS;

/**
 * Race a promise against a timeout. Resolves with the promise's value, or
 * REJECTS with a timeout error once `ms` elapses (the caller's `try/catch`
 * treats a timed-out update as "merge at last-known length"). The timer is
 * `unref`'d so it never keeps the event loop alive on its own, and cleared as
 * soon as either side settles. A non-positive `ms` disables the bound (awaits
 * the promise directly — used by tests over instant fakes).
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('update timed out')), ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * A local write the per-table helpers append to the own log. Mirrors the
 * fields the old Autobase `OpEnvelope` carried for put/del ops; `writerPubkey`
 * is mapped onto the single-writer log's `author_pubkey`.
 */
export interface LocalWriteOp {
  type: 'put' | 'del';
  table: string;
  hbKey: string;
  value?: unknown;
  ts: number;
  schema_version: number;
  /** Local-writer pubkey (hex), threaded to clobber-event attribution. */
  writerPubkey?: string;
  /**
   * Hybrid Logical Clock stamp (`encodeHlc` string, P-010). Normally left unset
   * by the per-table helpers — `handle.append` stamps it from the process HLC
   * clock so EVERY federated write carries a causal order key. A caller may
   * pre-set it (the stamp is preserved, not overwritten) e.g. to replay a
   * captured HLC.
   */
  hlc?: string;
  /**
   * Hive epoch RE-KEY (C-001 read-plane revocation, shared-hive-rekey-2026-06-19,
   * gated on `papercusp-hive-rekey`): the epoch this op's `value` payload was
   * encrypted under. Stamped by the capture-wire (outbox-drain) from the injected
   * EpochEncryptCapability's returned `{ epoch }` for selected hive-content ops;
   * the apply-side decrypt-gate reads it to resolve the wrapped epoch key
   * (EpochKeyProvider) + `decryptOpPayload`. Absent ⇒ plaintext op (today's path +
   * the admission/key/policy ops that must stay readable). The read-side twin is
   * `OpEnvelope.epoch`.
   */
  epoch?: number;
}

export interface BootHarnessOpts {
  workspaceRoot: string;
  workspaceId: string;
  harnessSlug: string;
  /**
   * Optional swarm binding. When present, the harness joins a
   * Hyperswarm topic + exchanges signed announces with peers, admitting
   * remote per-peer logs that pass the D-004 read-admission decision.
   * Omit (or pass null) for `state: private` harnesses that stay
   * single-engineer.
   *
   * v5 §0.2.7 + addendum 1 — pass `{ kind: 'gh', github_repository_id }`
   * for the canonical post-binding topic. Pre-binding dev mode can
   * pass `{ kind: 'local', workspace_id, harness_slug }`.
   */
  swarmBinding?: SwarmBinding | null;
  /**
   * Test seam — supply a fake swarm. Runtime callers leave this
   * undefined; bootHarnessSubstrate lazy-imports the real swarm via
   * getSharedSwarm() (one Hyperswarm per process).
   */
  swarmOverride?: HyperswarmLike;
  /**
   * Merge-poll interval override (ms). Tests set this to 0 to disable the
   * timer and drive `mergeNow()` by hand. Default 1000.
   */
  mergePollMs?: number;
  /**
   * WI-183: how long (ms) an admitted remote log may show zero live
   * replicator peers, after having previously shown at least one, before
   * `checkReplicationStall` records a `replication_stalled` boot event.
   * Tests shrink this to exercise the detector without a real wait.
   * Default `DEFAULT_REPLICATION_STALL_GRACE_MS` (3 minutes).
   */
  replicationStallGraceMs?: number;
  /**
   * Test seam — override the read-admission binding check. Production leaves
   * this undefined and the real `buildVerifyBindingAdapter` (verifyAttestation
   * on the announce's attestation_gist_id — write-free join) is used. Tests
   * inject a pure predicate so `onAnnounce` admit/reject/pending can be exercised
   * without network.
   *
   * Returns `'verified' | 'pending' | 'fail'` (D-002 / D-006 3-state).
   */
  verifyBindingOverride?: (
    devicePubkeyBase64: string,
    githubLogin: string,
    githubUserId: number,
    attestationGistId: string,
  ) => Promise<'verified' | 'pending' | 'fail'>;
  /**
   * Pending-retry interval override (ms). Tests set this to a small value
   * (e.g. 10ms) to drive the retry tick without sleeping. Default 5000.
   * Set to 0 to disable the retry timer entirely (tests that don't need it).
   */
  pendingRetryMs?: number;
  /**
   * Test seam for the pending-retry timer. Production uses global setTimeout /
   * clearTimeout. Tests can capture the callback and invoke one retry tick
   * directly, avoiding wall-clock sleeps around real corestore I/O.
   */
  pendingRetrySetTimeout?: typeof setTimeout;
  pendingRetryClearTimeout?: typeof clearTimeout;
  /**
   * WI-752 / FED-2 substrate-swarm self-heal cadence (ms), forwarded to
   * `joinHarnessSwarm`. Production leaves these undefined → the proven defaults
   * (`DEFAULT_SUBSTRATE_REFRESH_MS` / `_FAST_WINDOW_MS` / `_SLOW_REFRESH_MS`) so
   * a dropped/aged-out peer re-pairs without an operator restart. Tests set a
   * small `swarmRefreshMs` to drive the re-peer loop quickly, or `0` to disable
   * it (and drive `discovery.refresh()` by hand). See swarm.ts.
   */
  swarmRefreshMs?: number;
  swarmFastWindowMs?: number;
  swarmSlowRefreshMs?: number;
  /**
   * WI-752 / FED-2 join-retry base interval (ms). When the boot-time swarm join
   * FAILS (→ local-only), retry it on a bounded exponential backoff starting at
   * this value (capped at `SWARM_JOIN_RETRY_CAP_MS`) until it succeeds — so a
   * transient join failure self-heals with no operator restart. Default
   * `DEFAULT_SWARM_JOIN_RETRY_MS`; `0` disables the retry (tests).
   */
  swarmJoinRetryMs?: number;
  /**
   * Test seam (A-003) — override how the joiner's hive-home projection slug is
   * resolved. Production leaves this undefined and `resolveHiveHomeProjectionSlug`
   * imports the real `joinerHiveHomeSlug` (reads the remote_hive registry). Tests
   * inject a resolver (e.g. one that returns `null` at boot then the hive-home slug
   * on the `rekey` call) to exercise the buffer→replay-on-rebind path WITHOUT the
   * registry or a live swarm. Called only when `swarmBinding.kind === 'hive'`.
   */
  joinerHiveHomeSlugOverride?: (
    workspaceId: string,
    harnessSlug: string,
  ) => Promise<string | null | undefined>;
  /**
   * Test seam — override the projection apply sink. Production leaves this
   * undefined and the per-harness scoped apply (`buildHarnessProjectionApply`,
   * which routes ops to THIS harness's own projection set) is used. Tests
   * inject a capturing apply to assert which ops merge, without the real PG
   * projections or the (collision-prone) global registry.
   */
  applyOverride?: (op: OpEnvelope) => Promise<boolean>;
  /**
   * Test seam — override how THIS peer's signed announce identity is resolved
   * and signed. Production leaves this undefined: the announce identity is
   * resolved via the real `resolveLocalAnnounceIdentity` (gh-token `GET /user`
   * + OS keychain device keypair) and signed via `signWithDeviceKey`
   * (keychain-held Ed25519 private key).
   *
   * BOTH sub-seams are needed for an offline transport test (e.g.
   * `two-peer-swarm.test.ts`) because:
   *   - `resolveOpts` lets the test inject a fake `resolveGithubUser` (distinct
   *     per peer) and a self-generated Ed25519 keypair (via `loadKeypair` +
   *     `keychainId`), so the resolver never calls the real `gh` token / OS
   *     keychain (which throw / pollute the user's identity in a test runner).
   *   - `sign` REPLACES `signWithDeviceKey`. Even with an injected keypair, the
   *     default signer reads the private key from the OS keychain by
   *     `keychainId` — which the test's generated key isn't stored under. The
   *     signer override lets the test sign the announce with the matching
   *     in-test private key, so `verifyAnnounce` (which checks the sig against
   *     the announced `device_pubkey`) passes over the real wire.
   *
   * No-op for production callers: when undefined, `resolveOpts` defaults to
   * `{}` (merged into the real resolver with only `logCoreKeyHex` set, i.e.
   * current behavior) and `sign` defaults to `signWithDeviceKey(keychainId, …)`.
   */
  announceIdentityOverride?: {
    /**
     * Partial `ResolveLocalAnnounceIdentityOpts` merged into the
     * `resolveLocalAnnounceIdentity({ logCoreKeyHex, ...resolveOpts })` call.
     * `logCoreKeyHex` is always supplied by boot from the own log; any
     * `logCoreKeyHex` here is ignored (overwritten by boot's value).
     */
    resolveOpts?: Partial<ResolveLocalAnnounceIdentityOpts>;
    /**
     * Replacement announce signer. Receives the resolved `keychainId` and the
     * canonical bytes to sign; returns the raw 64-byte Ed25519 signature
     * (`buildAnnounce` base64-encodes it). Defaults to
     * `signWithDeviceKey(keychainId, bytes)`.
     */
    sign?: (keychainId: string, bytes: Buffer) => Promise<Buffer>;
  };
  /**
   * Test seam — override the revoked-pubkeys loader. Production leaves this
   * undefined and the real `loadRevokedPubkeys({ workspaceId, harnessSlug })`
   * (reads `harness_shared.contributors.revoked_pubkeys` from PG) is used.
   * Tests inject a pure async factory returning a Set<string> so startup
   * enforcement + merge-refresh can be exercised without a real database.
   *
   * The loader is called TWICE:
   *   (1) At startup, before the swarm is joined, to seed `revoked` so
   *       already-revoked peers are refused on their very first announce.
   *   (2) After every successful merge pass, to pick up mid-session
   *       replicated revocations (new pubkeys → drop their admitted logs).
   *
   * D-002 decision seam.
   */
  loadRevokedOverride?: () => Promise<Set<string>>;
  /**
   * Test seam (WI-559 + D-002) — override the same-hive membership lookup. Production
   * leaves this undefined and the real `resolveHiveMemberDeviceSet(workspaceId, hiveHomeSlug)`
   * (reads all member device pubkeys from the federated `hive_members` PG table) is used. Tests
   * inject a pure async loader returning ALL member device pubkeys for the hive — no
   * github_user_id needed (D-002: admit by AUTHOR IDENTITY / device_pubkey ∈ hive_members).
   */
  loadHiveMembersOverride?: (hiveHomeSlug: string) => Promise<string[]>;
  /**
   * Test seam (WI-787 / WI-780) — resolve the OWNER device pubkey the SIGNED, gh-verified
   * hive-announce binds to a joined `hive_pubkey` (`owner_device_pubkey`, captured at join
   * from the verified directory descriptor and persisted on `harness_shared.hives`).
   * Production leaves this undefined and the real `loadHiveOwnerDevicePubkey(workspaceId,
   * hivePubkey)` (reads `hives.owner_device_pubkey` from PG, fail-closed to null) is used.
   * Used ONLY to BOOTSTRAP-admit the owner's OWN log on a fresh joiner whose `hive_members`
   * is still empty — the WI-780 bootstrap deadlock (the roster that would admit the owner
   * lives inside the owner's un-merged log). Admits ONLY the one bound device; never widens
   * admission to any other device, so the WI-259 membership guard stays intact. `workspaceId`
   * is closed over by boot; the loader receives `(hivePubkey)`.
   */
  ownerDeviceForHiveOverride?: (hivePubkey: string) => Promise<string | null>;
  /**
   * Test seam (D-053) — resolve the OWNER device pubkey to bootstrap-admit when this peer
   * boots on a `kind:'topic'` binding (a real invite/link joiner learns the Hive's TOPIC
   * HASH, not its pubkey, so it cannot key `ownerDeviceForHiveOverride`/`loadHiveOwnerDevicePubkey`
   * by pubkey). Production leaves this undefined and the real path recovers the pubkey from the
   * verified `hive_directory_cache` by deriving each cached hive's topic and matching `topic_hex`.
   * Receives `(topicHex)`; `workspaceId` is closed over by boot. Same one-bound-owner-device
   * guarantee as `ownerDeviceForHiveOverride`.
   */
  ownerDeviceForTopicOverride?: (topicHex: string) => Promise<string | null>;
  /**
   * Test seam (WI-1544 root cause #3) — replace `openRemoteLog` inside the
   * merge-gated admission drain so a unit test can make the open THROW (the
   * one-shot silent-loss class: a drain failure used to lose the announce
   * frame forever — no re-buffer, no re-announce). Production leaves this
   * undefined and uses the real `openRemoteLog`.
   */
  openRemoteLogOverride?: (store: Corestore, logKeyHex: string) => Promise<RemoteLog>;
  /**
   * Slow re-verify interval (ms). At this cadence, every admitted peer's
   * channel-2 binding is re-checked via `verifyBinding`. A conclusive `'fail'`
   * drops the peer from the admitted set (but does NOT add it to the published
   * `revoked` blocklist — a deleted GitHub branch may be re-published later;
   * normal admission re-admits it if the binding returns). `'pending'` / a thrown
   * error keeps the peer (fail-open per D-004).
   *
   * The GitHub `verifyBinding` I/O runs LOCKLESS — OFF the `merging` lock
   * (P-002). `mergeNow` only KICKS OFF the verify (throttled to at most once per
   * `reverifyIntervalMs`) fire-and-forget and APPLIES the resulting conclusive-
   * fail drops under the gate via a drop queue. This keeps zero network I/O under
   * the merge lock so a large admitted set can't freeze read-merge convergence.
   *
   * Channel-2 reads hit the GitHub API; keep this cadence slow (default
   * 15 min). With small dogfood peer counts this is negligible load; at scale
   * consider staggering per-peer calls (a comment by `reverifyAdmitted` notes
   * this).
   *
   * Set to `0` to disable the automatic throttle-in-mergeNow kick-off entirely
   * (tests drive `reverifyAdmitted()` + `mergeNow()` by hand via the handle).
   * Default 15 min.
   */
  reverifyIntervalMs?: number;
  /**
   * Telemetry sink for conclusive admission rejections (P-004). Defaults to
   * enqueuing a `substrate_admission_rejected` diagnostic report via
   * `recordTelemetryReport` (which `flushTelemetry` forwards to PostHog when the
   * user has opted in). Injected in tests to assert the emit without touching
   * PG/PostHog. MUST be best-effort — telemetry never gates admission, so the
   * default swallows errors and the call site does not await it.
   */
  recordTelemetryOverride?: (kind: TelemetryKind, payload: Record<string, unknown>) => void;
  /**
   * Test seam — a PER-HANDLE HLC clock for the SEND seam (`stampOpHlc`) instead
   * of the process-global `processHlc()`. Production leaves this undefined (one
   * clock per process is correct — every local write is monotone w.r.t. the
   * others). A test harness simulating MULTIPLE peers in ONE process MUST pass a
   * distinct clock per peer: real peers are separate processes with independent
   * clocks, so a shared global clock lets two peers' concurrent drains interleave
   * the same counter and decide cross-peer LWW by drain-race instead of causal
   * order. Pair it with the same clock on the apply seam's `ApplyOpOpts.hlcClock`
   * (the RECV seam) so receive-advances land on the right peer's clock.
   */
  hlcClock?: HlcClock;
  /**
   * SUBSTRATE_SIDECAR Option B test seam (WI-604). Production leaves this
   * undefined: the offload is gated by the real OFF-by-default SUBSTRATE_SIDECAR
   * flag and routes through `offloadReplicationToSidecar` (the real sidecar child
   * + IPC client). A test injects a `(socket, peerInfo) => boolean` to drive the
   * connection handler's offload branch deterministically WITHOUT spawning the
   * sidecar — e.g. to assert the in-process `store.replicate` is bypassed when the
   * offload claims the socket. When defined it is the SOURCE OF TRUTH (the flag
   * read is skipped) so a test never depends on global flag state.
   */
  sidecarOffloadOverride?: (socket: unknown, peerInfo?: unknown) => boolean;
}

export interface BootedHarnessHandle {
  workspaceId: string;
  harnessSlug: string;
  /** The Corestore — for swarm replication wiring + introspection. */
  store: Corestore;
  /** The peer's OWN writable single-writer log. Local appends go here
   *  (incl. the orchestrator's LWW advisory feature claim — Stage 5). Typed
   *  as the writable `OwnLog` (a superset of `AdmittedLog`) so the claim path
   *  can `append` directly. */
  ownLog: OwnLog;
  /**
   * Append a local put/del op to the peer's OWN log. Convenience over
   * `ownLog.append` for the per-table write helpers (write-contributor-row /
   * write-feature-queue / write-working-set) that previously appended to the
   * Autobase. Maps the op's `writerPubkey` onto the single-writer log's
   * required `author_pubkey`.
   *
   * STAGE-5 TODO: the orchestrator claim path (feature-claim.ts) and a real
   * device `author_pubkey` thread through here when the claim/write rewrite
   * lands; today `author_pubkey` falls back to `writerPubkey ?? ''`.
   */
  append(op: LocalWriteOp): Promise<void>;
  /**
   * The admitted-set: keyHex → log. Seeded with the own log; the swarm
   * announce channel adds remote logs that pass read-admission (4b).
   */
  admitted: Map<string, AdmittedLog>;
  /** Run a single read-merge pass over the admitted set into PG. Resolves
   *  with the number of ops applied. Idempotent + safe to call concurrently
   *  (it serializes internally). */
  mergeNow(): Promise<number>;
  /**
   * Handle an inbound signed announce from a peer (called by the swarm
   * connection handler in 4b). Verifies the sig, runs the admission
   * decision, and on admit opens + admits the peer's remote log and
   * triggers a merge. When the swarm supplies the per-connection `ctx`
   * (P-006 §5.2/§5.3), an ADMITTED frame additionally drives the scoped-log
   * flow: serve gate → disclosed-core admission → directed follow-up.
   */
  onAnnounce(frame: SignedAnnounce, ctx?: AnnounceConnectionContext): Promise<AdmissionResult>;
  /**
   * Subscribe to peer admissions (audit P-022): fires once per newly-admitted
   * remote log with the log key + the post-admission admitted-set size.
   * Replaces 100ms `admitted.size` polling in the perf rigs. Returns an
   * unsubscribe fn. Best-effort: a throwing listener is swallowed and never
   * breaks admission or the merge pass.
   */
  onAdmitted(listener: (info: { logKeyHex: string; admittedSize: number }) => void): () => void;
  /**
   * Revoke a device pubkey (D-004). Revocation = drop the pubkey from the
   * admitted set + stop reading its log:
   *   (a) add the pubkey to the `revoked` set so a re-announce is refused
   *       (`reason:'revoked'`);
   *   (b) look up the pubkey's `log_core_key` and remove that log from the
   *       admitted set (so the next merge no longer reads it);
   *   (c) re-merge so the merge set reflects the removal immediately.
   * Best-effort + idempotent: revoking an unknown / already-revoked pubkey is a
   * no-op (the pubkey is still added to `revoked` so a future announce is
   * refused). Takes the RAW base64 device pubkey (the announce's
   * `device_pubkey`), NOT the hypercore `log_core_key`.
   */
  revoke(devicePubkey: string): Promise<void>;
  /**
   * LOCKLESS channel-2 re-verify producer (rev-v2 Component A; P-002). Exposed
   * for testing so `reverifyIntervalMs: 0` tests can drive it by hand.
   *
   * For each admitted peer EXCEPT the own log, calls `verifyBinding` with the
   * peer's recorded `{devicePubkey, githubLogin, githubUserId, attestationGistId}`:
   *   - `'fail'` (conclusive) → ENQUEUES the peer's logKey for a drop. The drop
   *     (delete from `admitted` + `admittedIdentities` + `pubkeyToLogKey`, plus a
   *     `peer_revoked` boot-history event) is APPLIED on a SUBSEQUENT merge pass
   *     under the gate — NOT synchronously here. Does NOT add to the published
   *     `revoked` set (a GitHub-deleted binding may be re-published; normal
   *     admission re-admits if it returns).
   *   - `'pending'` / thrown error → keeps the peer (fail-open per D-004).
   *
   * Does ZERO mutation of the shared `admitted` maps, so it is SAFE to call
   * WITHOUT holding the `merging` flag (that is the whole point of P-002 — the
   * GitHub I/O is off the merge lock). To observe a drop in a test, call this,
   * then `mergeNow()` to drain the queue under the gate.
   */
  reverifyAdmitted(): Promise<void>;
  /** Swarm handle. Null when this boot didn't join a swarm
   *  (private harness OR swarmBinding omitted). A live getter — `rekey()`
   *  reassigns it, so always read the current value. */
  readonly swarm: SwarmHandle | null;
  /** Re-key onto a NEW swarm topic IN PLACE: leave the old topic, join the topic
   *  derived from `binding`, keeping the store + own log + admitted set + merge
   *  loop alive. The "go shared" primitive — used when a harness joins/publishes
   *  a hive after boot and must switch from its gh:<repo_id> topic to the
   *  hive-pubkey topic WITHOUT a reboot (EI-681: a reboot breaks the owner's
   *  corestore replication-serving of its own log). No-op once closed. */
  rekey(binding: SwarmBinding): Promise<void>;
  /**
   * P-006 §5.1 — declare fleet scopes this peer PARTICIPATES in: mints an own
   * writable scoped log core per scope (idempotent) in the harness's SEPARATE
   * never-replicated scoped store; the scopes are disclosed/served per
   * §5.2/§5.3 on the next announce exchange (or `rediscloseScopes()` for the
   * immediate edge). Boot-scoped: `rekey()` re-applies the set to the fresh
   * coordinator. P-101 (fleet directory) is the production driver; a tier-1
   * boot leaves the set empty (FS-D5 structural inertness — the machinery is
   * live, nothing is disclosed or served).
   */
  ensureScopeParticipation(scopes: readonly ScopeId[]): Promise<void>;
  /**
   * D-017 n1 — the IMMEDIATE roster/epoch-mutation edge: re-run scoped-log
   * disclosure on EVERY live connection NOW. A scope newly hidden from a peer
   * is detached at once (§5.3 revocation edge); newly visible scopes are
   * served + disclosed. Without this, changes still converge within one
   * ANNOUNCE_REFLUSH (≤5 min) — this makes revocation take effect now. No-op
   * before the first swarm join.
   */
  rediscloseScopes(): Promise<void>;
  /** The scoped-log coordinator — null before the first swarm join or when the
   *  scoped layer failed to initialize (diagnostics + tests). */
  readonly scopeFederation: ScopeFederation | null;
  /**
   * Register a teardown hook run (once) on `close()`, BEFORE the swarm + store
   * tear down. The Stage-5 outbox wiring (boot-all.ts `wireOutboxForHarness`)
   * registers the `startOutboxDrain` stopper here so the LISTEN connection +
   * poll timer are released exactly once on shutdown without boot-all having to
   * track a parallel Map. Returns an unregister function (clears the hook if the
   * wiring is torn down independently of `close()`). Hooks are best-effort: a
   * throwing hook is caught + logged, never blocking the rest of teardown.
   */
  registerCloseHook(hook: () => void | Promise<void>): () => void;
  /** Cleanup. Idempotent. Runs close-hooks, then tears down swarm + merge
   *  poller + Corestore. (A re-key does NOT close — use `rekey()`, which leaves
   *  the old topic + joins the new one with the store/cores/streams alive.) */
  close(): Promise<void>;
}

/**
 * WI-559 + D-002 P-001: the PURE same-hive cross-member SCOPE decision, extracted so it is
 * unit-testable in isolation. A frame that has ALREADY passed the identity decider (sig +
 * channel-2 binding valid, NOT revoked — checked upstream, every call) and is out of this
 * harness's OWN slug scope is classified:
 *   - 'admit'         → device_pubkey is registered in the hive_members set (D-002 AUTHOR IDENTITY).
 *   - 'miss'          → a same-hive candidate (cross-slug + hive home known) whose membership
 *                       has NOT federated to us yet → caller BUFFERS it for retry
 *                       (the asymmetric A→B stall fix) instead of conclusively rejecting.
 *   - 'not-candidate' → not a same-hive cross-member (own/empty slug, or no hive home)
 *                       → caller falls through to the A-003 / conclusive paths.
 * It NEVER decides revocation or the read-cut (that is the identity decider, run BEFORE it).
 * github_user_id is intentionally NOT used — admission is by device_pubkey ∈ hive_members.
 */
export type SameHiveDecision = 'admit' | 'miss' | 'not-candidate';
export function classifySameHiveMember(input: {
  originSlug: string | null;
  ownSlug: string;
  hiveHome: string | null;
  devicePubkey: string;
  memberDevices: readonly string[];
  /**
   * D-023 BUG C — true when THIS box OWNS the hive (holds its private key = the membership
   * AUTHORITY). On a membership MISS a NON-owner correctly BUFFERS (WI-559: the member's row
   * will federate IN from the owner momentarily). But the OWNER is the SOURCE of membership —
   * a brand-new joiner's hive_members row is created by the owner's OWN admit seam
   * (admitAnnouncedPeerAsOwner → ownerAdmitOrPend → upsertHiveMember), which runs ONLY AFTER
   * the joiner's LOG is admitted. So an owner that buffers a verified joiner DEADLOCKS: the
   * row that would admit it is the row the admit would create. A joiner's member-harness slug
   * differs from the owner's home slug (join-hive freeSlug suffixing — joinHiveAsView), so the
   * joiner's announce is ALWAYS out of the owner's home-slug scope and reaches here as a MISS.
   * ADMIT it instead, so the admit seam runs the owner-signed policy (open ⇒ upsert; approval ⇒
   * pending; banned/revoked already refused upstream by the identity decider's `revoked` set).
   * This only widens SCOPE — sig + channel-2 binding + revocation are enforced upstream — so it
   * never weakens security; it closes the open-mode auto-admission gap (the boot.ts admit seam
   * WI-280 wired was unreachable for a brand-new cross-slug joiner without this).
   */
  isOwner?: boolean;
}): SameHiveDecision {
  const { originSlug, ownSlug, hiveHome, devicePubkey, memberDevices, isOwner } = input;
  // Not a cross-member candidate: absent/own-slug (handled upstream) or no hive home.
  if (!(originSlug != null && originSlug !== ownSlug)) return 'not-candidate';
  if (hiveHome == null) return 'not-candidate';
  // D-002: admit by AUTHOR IDENTITY — device already in the federated member set → admit.
  if (memberDevices.includes(devicePubkey)) return 'admit';
  // D-023 BUG C: the OWNER must not buffer a verified brand-new joiner (deadlock) — admit so its
  // own admit seam runs the policy + upserts the row. A non-owner → miss (buffer for retry).
  return isOwner ? 'admit' : 'miss';
}

export async function bootHarnessSubstrate(opts: BootHarnessOpts): Promise<BootedHarnessHandle> {
  if (!opts.workspaceRoot) throw new Error('bootHarnessSubstrate: workspaceRoot required');
  if (!opts.workspaceId) throw new Error('bootHarnessSubstrate: workspaceId required');
  if (!opts.harnessSlug) throw new Error('bootHarnessSubstrate: harnessSlug required');

  recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_start');
  try {
    return await bootHarnessSubstrateInner(opts);
  } catch (e) {
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'boot_fail',
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  }
}

/**
 * Wrap an admitted log so the merge driver drops unknown-newer ops (the
 * D-024 schema-version gate that used to live in the Autobase apply). The
 * gate runs in the merge driver, NOT inside `mergeAdmittedLogs`, so the
 * merge stays a pure read→LWW→apply. `acceptOpVersion` emits the
 * "newer Papercusp available" alert once per (slug, version).
 */
function versionGatedLog(slug: string, log: AdmittedLog): AdmittedLog {
  const maybePrefetch = (log as AdmittedLog & { prefetch?(start: number, end: number): void })
    .prefetch;
  return {
    get keyHex() {
      return log.keyHex;
    },
    get length() {
      return log.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      const op = await log.get(i);
      if (!op) return null;
      // Drop unknown-newer ops (D-024). acceptOpVersion alerts once.
      if (!acceptOpVersion(slug, op.schema_version)) return null;
      return op;
    },
    // Forward the ranged-prefetch capability (EI-92) — the incremental merge
    // feature-detects it on the wrapped log.
    ...(typeof maybePrefetch === 'function'
      ? { prefetch: (start: number, end: number) => maybePrefetch.call(log, start, end) }
      : {}),
  };
}

async function bootHarnessSubstrateInner(opts: BootHarnessOpts): Promise<BootedHarnessHandle> {
  const storeOpts: HarnessStoreOpts = {
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  };
  const store = await getHarnessStore(storeOpts);

  const slug = opts.harnessSlug;

  // ── Model B: the peer's OWN writable single-writer log. ──
  // Replaces the retired Autobase. Local writes append here (incl. the
  // orchestrator's LWW advisory feature claim); the merge driver reads it
  // (+ admitted remote logs) into PG.
  const ownLog = await openOwnLog(store);

  // ── A-003 (shared-hive-release-testing Brief I): joiner hive-home projection
  // scope. ── When THIS harness is a member of a JOINED (remote_hive) Hive, its
  // `hive_members`/`hive_settings` projections must bind to the HIVE-HOME slug, not
  // the member slug — else the home-grained ops this member's merge reads off the
  // shared Hive topic are dropped (the member list/settings never reach the joiner,
  // and `loadRevokedHivePubkeys(<home>)` stays empty so a revoked member is never
  // refused). `joinerHiveHomeSlug` returns the home slug ONLY for a true joiner
  // (the home is a remote_hive view) — null for an OWNED hive's member (whose home
  // harness owns the write side) or a non-hive harness. Gated on a `hive` swarm
  // binding so non-hive boots (every rig + most tests) skip the registry/identity
  // read entirely; fail-open — any error leaves today's member-slug binding.
  //
  // Resolved at boot AND re-resolved on `rekey`: a FIRST join boots the member on
  // the gh topic (no hive_slug yet → null) then re-keys onto the Hive topic AFTER
  // join stamps hive_slug + the remote_hive home (join-hive.ts steps 2/2b before
  // the 2c re-key), so the re-key is where the rebind actually engages. A later
  // restart boots straight onto the Hive topic with hive_slug set, engaging it here.
  const resolveHiveHomeProjectionSlug = async (
    binding: SwarmBinding | null | undefined,
  ): Promise<string | undefined> => {
    // WI-498 GAP 2: resolve the joiner hive-home projection for BOTH 'hive' and
    // 'topic' bindings — a DIRECT invite/link join boots on a 'topic' binding (the
    // link carries the topic hash, not the hive pubkey), and without this its member
    // never resolves a hive-home slug, so the OWNER's hive-home announce is out-of-
    // scope → buffered → grace-expired → rejected → no federation, even though the
    // peer is connected on the right topic (live-witnessed on the 2-machine rig). See
    // bindingResolvesHiveHomeProjection for the full rationale. Slug resolution stays
    // SELF-GATED by joinerHiveHomeSlug (remote_hive view only → else null → fail-open),
    // so a non-hive 'topic' harness is unaffected, and the joiner rebind no longer
    // depends on prior DHT directory discovery.
    if (!bindingResolvesHiveHomeProjection(binding)) return undefined;
    try {
      // A-003 test seam: a test may inject `joinerHiveHomeSlugOverride` to control
      // home resolution (null at boot, then the hive-home slug on rekey) without the
      // registry. Production leaves it undefined → the real registry-backed resolver.
      let resolved: string | undefined;
      if (opts.joinerHiveHomeSlugOverride) {
        resolved = (await opts.joinerHiveHomeSlugOverride(opts.workspaceId, opts.harnessSlug)) ?? undefined;
      } else {
        const { joinerHiveHomeSlug } = await import('../../hive-federation');
        // WI-1378 (federation roster-empty, no-restart path): read the registry FRESH
        // (bypass the 2s operator-state cache). This resolve runs on the in-place rekey
        // inside the substrate SIDECAR process (SUBSTRATE_SIDECAR) — a DIFFERENT process
        // from the join-hive registry write, so the writer's same-process cache
        // invalidation never reached here. A warm-stale cache made joinerHiveHomeSlug
        // return null at rekey → next===prev(null) → the rebind block below skipped →
        // forceReFold never fired → the member-slug projection binding latched → the
        // owner's hive_members rows dropped forever (roster empty until a restart
        // cold-read). A fresh read sees the committed remote_hive/hive_slug (join-hive
        // awaits the mutateRegistry commit before the rekey RPC), so the rebind +
        // forceReFold re-fold engage on the no-restart path. Rare path — the hot
        // loadHarnessRegistry callers keep the cache; only this resolve reads fresh.
        resolved =
          (await joinerHiveHomeSlug(opts.workspaceId, opts.harnessSlug, { fresh: true })) ?? undefined;
      }
      if (process.env.PAPERCUSP_A003_TRACE === '1') {
        // eslint-disable-next-line no-console
        console.error(`[A-003] resolve ${opts.harnessSlug}: joinerHiveHomeSlug=${resolved ?? '<null>'}`);
      }
      return resolved;
    } catch (e) {
      if (process.env.PAPERCUSP_A003_TRACE === '1') {
        // eslint-disable-next-line no-console
        console.error(
          `[A-003] resolve ${opts.harnessSlug}: joinerHiveHomeSlug THREW: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return undefined; // fail-open: fall back to member-slug binding (today's behavior)
    }
  };
  // ── Per-admitted-peer identity store (rev-v2 Component A) ── populated at
  // admit time from the SignedAnnounce frame so `reverifyAdmitted()` can
  // re-call `verifyBinding(devicePubkey, githubLogin, githubUserId, gistId)`
  // without the original frame. Keyed by `log_core_key` (same key as `admitted`).
  // Cleaned up in every drop path: `revoke()`, `applyRevocationRefresh()`, and
  // the attestation re-verify drop inside `reverifyAdmitted()`. Declared HERE (above
  // `buildScopedApply`) so the WI-259 P-002 `resolveAuthorDevice` seam threads into the
  // content projections that `buildScopedApply` builds below; `resolveAuthorId` (the
  // rate limiter's, far below) reads this same map.
  const admittedIdentities = new Map<
    string,
    { devicePubkey: string; githubLogin: string; githubUserId: number; attestationGistId: string }
  >();

  // WI-259 P-002 (membership-aware cross-member content apply): map an op's source-log
  // core key → the admission-VERIFIED device pubkey that vouched for that log (its
  // announce sig was checked against it AND it was a hive member — STEP 1 / P-001). The
  // 6 content projections' guard (`shouldApplyMemberContentOp`) re-checks this device ∈
  // the CURRENT member set (`resolveHiveMemberDeviceSet`) so a removed member's writes
  // stop applying. Keyed off `op.sourceLogKeyHex` (immutable, receiver-stamped) NOT
  // `op.author_pubkey` — the latter is caller-supplied (peer-log.ts:19), so a removed
  // member could spoof a still-member's pubkey to evade the write-cut. `null` when the
  // source log isn't admitted (own log / legacy op without a source key).
  const resolveAuthorDevice = (sourceLogKeyHex: string): string | null =>
    admittedIdentities.get(sourceLogKeyHex)?.devicePubkey ?? null;

  // ── WI-259 P-004 content-before-membership buffer (plan shared-hive-member-content-federation-
  // 2026-06-20) ── ONE per booted apply loop (stateful across merge passes, like rekeyDeps.pending).
  // The 6 content projections DEFER into it when the P-002 membership guard would drop a cross-member
  // op only because the author's hive_members row hasn't federated to this peer yet; the hive_members
  // projection DRAINS + re-applies on a member apply (the onMemberApplied hook). Inert (stays empty)
  // for a non-hive harness — the guard returns 'drop' (never 'defer') without a hiveHomeSlug. Threaded
  // into BOTH scopedApply (the real merge path) AND the global registry below.
  const pendingMemberContent = new PendingMembershipContent();

  // WI-559 / FED-1 (fed-b→fed-a "discovers 0"): the OWNER's hive-home harness must resolve the
  // WI-259 content-guard hiveHomeSlug too. `resolveHiveHomeProjectionSlug` (above) resolves only the
  // JOINER rebind via `joinerHiveHomeSlug` (remote_hive view → null for an owner), so an owner's home
  // harness ran the 6 content projections with hiveHomeSlug=undefined → `decideMemberContentOp` hit
  // its no-hiveHome 'drop' branch for EVERY cross-member op → a member's content never materialized on
  // the owner. This closes the admit/apply ASYMMETRY: STEP-1 admission (`resolveSameHiveMember`)
  // already resolves the home as `hiveHomeProjectionSlug ?? hiveHomeSlugForHarness(ws, slug)`, but
  // STEP-2 apply only used `hiveHomeProjectionSlug`. We resolve the OWNER's own hive-home here and
  // thread it as the content-guard FALLBACK below (scoped to home === own slug, so a joiner keeps its
  // rebound `hiveHomeProjectionSlug` and the `??` is a no-op; a non-hive/non-owner harness → undefined).
  // GATED on `bindingResolvesHiveHomeProjection` — the SAME gate the joiner resolution above uses — so
  // a harness NOT on a hive/topic topic (the common boot path, e.g. a private 'local'/'gh' harness)
  // pays ZERO extra getOrgPg cost and is byte-identical to today; only a harness actually peered on a
  // hive topic (where it can receive cross-member content) does the one-shot owner-home lookup.
  const ownHiveHomeSlug = await (async (): Promise<string | undefined> => {
    if (!bindingResolvesHiveHomeProjection(opts.swarmBinding)) return undefined;
    try {
      const { hiveHomeSlugForHarness } = await import('../../hive-federation');
      const home = await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug);
      return home === opts.harnessSlug ? home : undefined;
    } catch {
      return undefined; // fail-open: today's behavior (no cross-member apply on the owner)
    }
  })();

  const buildScopedApply = (hiveHomeSlug: string | undefined) =>
    buildHarnessProjectionApply({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      ownLogKeyHex: ownLog.keyHex,
      // WI-559/FED-1: fall back to the OWNER's own hive-home when the joiner rebind
      // (hiveHomeProjectionSlug) is null, so an owner's home harness engages the WI-259
      // membership guard instead of dropping every cross-member op (no-hiveHome). For a joiner
      // `hiveHomeSlug` is its rebound home (≠ null) so `?? ownHiveHomeSlug` is a no-op.
      hiveHomeSlug: hiveHomeSlug ?? ownHiveHomeSlug,
      resolveAuthorDevice,
      pendingMemberContent,
    });

  // WI-1544 (defect D): `rekey()` swaps topics IN PLACE, but `opts.swarmBinding` is
  // frozen at boot — every post-boot reader (owner-device resolve, the join-bootstrap
  // window, the swarm-join retry loop) must observe the CURRENT binding or it acts on
  // the pre-rekey topic (the retry loop could even rejoin the OLD topic during the
  // swarmHandle=null window mid-rekey). Kept current by rekey(); read it, not opts.
  let currentBinding: SwarmBinding | null = opts.swarmBinding ?? null;
  let hiveHomeProjectionSlug = await resolveHiveHomeProjectionSlug(opts.swarmBinding);
  // A-003 diagnostic (env-gated, off by default → zero test impact): show the
  // boot-time hive-home binding decision in the harness log so a live witness can
  // grep `[A-003]` to see whether the joiner rebind engaged + which slug. Set
  // PAPERCUSP_A003_TRACE=1 on the instance to enable.
  if (process.env.PAPERCUSP_A003_TRACE === '1') {
    // eslint-disable-next-line no-console
    console.error(
      `[A-003] boot ${opts.harnessSlug}: swarmBinding.kind=${opts.swarmBinding?.kind ?? '<none>'} hiveHomeProjectionSlug=${hiveHomeProjectionSlug ?? '<none>'}`,
    );
  }

  // ── C-001 re-key apply deps (shared-hive-rekey-2026-06-19, su-ee7e9) ── Built ONCE here
  // (like the rateLimiter): the decrypt gate + its pending-content buffer are stateful across
  // passes. null when the re-key is OFF for this harness (flag off / non-hive / no device
  // identity) ⇒ the per-pass applyImpl stays `enforcedApply`, byte-for-byte today. The
  // boot-deps helper owns the LocalDevice/crypto build behind a cheap flag-FIRST off-path, so
  // a non-rekey harness pays one cached flag read. Built BEFORE registerAllHarnessProjections
  // so the drain hook (below) can wire into the projection registration. `let`, NOT const:
  // rekey() REBUILDS it when a mid-session join resolves the hive-home (the boot build returned
  // null because the home was not yet bound) — see the rekey() rebind. The per-pass applyImpl +
  // drain re-read `rekeyDeps` each pass (mergeOnePass re-evaluates), so a rebuild takes effect
  // on the next pass with no reboot.
  let rekeyDeps = await buildHiveRekeyBootDeps({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
  });
  // ── Re-key DRAIN HOOK queue (su-c2a63) ── The hive_epoch_keys projection's
  // `onEpochKeyApplied(hive, epoch)` PUSHES here when a key row applies — RECORDING, not
  // draining (so it never re-enters the apply that is firing it). `mergeOnePass` drains it
  // AFTER each pass via `drainQueuedEpochContent`, re-applying the now-decryptable deferred
  // content. Empty + unused when the re-key is off. Shared boot-scope buffer — BOTH the
  // boot-time registration and the rekey() re-registration feed it via `recordEpochDrain`.
  const epochDrainQueue: DrainedEpoch[] = [];
  const recordEpochDrain = (hiveHomeSlug: string, epoch: number): void => {
    epochDrainQueue.push({ hiveHomeSlug, epoch });
  };

  // Wire the per-table PG projection writers into the GLOBAL registry too —
  // some non-Model-B callers (CLI introspection, single-harness contexts) still
  // read the global registry via `applyHyperbeeOpToPg`. Idempotent (re-running
  // overwrites by tableTag).
  registerAllHarnessProjections({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    // WI-559/FED-1: owner-home fallback (see ownHiveHomeSlug) so the global-registry content
    // projections also engage the WI-259 membership guard on an owner's home harness.
    hiveHomeSlug: hiveHomeProjectionSlug ?? ownHiveHomeSlug,
    // Drain hook: feed the queue ONLY when the re-key is active (rekeyDeps non-null) — else
    // the hive_epoch_keys projection's onEpochKeyApplied stays undefined (today's behavior).
    ...(rekeyDeps ? { onEpochKeyApplied: recordEpochDrain } : {}),
    // WI-259 P-004: share the content-before-membership buffer with the global registry too
    // (same instance as scopedApply's), so a non-Model-B / CLI apply path defers + drains
    // consistently. Inert for a non-hive harness.
    pendingMemberContent,
  });

  // ── Per-harness scoped projection apply (D-021 collision fix). ──
  // The global registry is keyed by `tableTag`, so with 2+ booted harnesses the
  // LAST `registerAllHarnessProjections` wins and the global `applyHyperbeeOpToPg`
  // dispatches all ops to that one harness's projections — the others' ops are
  // silently dropped by the projections' `harness_slug` guard. This scoped apply
  // is bound to THIS harness's own projection set, so `mergeNow` applies each
  // harness's ops to its own projections with no cross-harness interference.
  //
  // G1 Provenance (P-002): pass ownLogKeyHex so the apply path can determine
  // origin from log-source (own log → 'local', admitted remote log → 'remote').
  // A-003: `let` (not `const`) so `rekey` can rebind the two hive projections when a
  // first-join re-keys this member onto the Hive topic (mergeOnePass reads the
  // CURRENT scopedApply each pass). An `applyOverride` (the rigs) is never rebuilt.
  let scopedApply = opts.applyOverride ?? buildScopedApply(hiveHomeProjectionSlug);

  // ── Owner-enforcement rate limiter (EN-2) ── STATEFUL across merge passes (its
  // per-(author,class) tumbling windows persist), so it is created ONCE here and
  // reused; the owner policy is re-snapshotted per pass below. Inert until an owner
  // sets a rate cap (no caps ⇒ the wrapper is a pure passthrough).
  const rateLimiter = new MemberRateLimiter();
  // F1-6/P-014: the sibling per-(source-author, niche) elite decider — STATEFUL like
  // rateLimiter (its per-(author,niche) tumbling windows persist across merge passes),
  // inert until an owner sets `hive_policy.rate.elitesPerNichePerHour`. Bounds a
  // source's elite concentration on ONE niche (the novelty-gift farm the per-source
  // rowsPerHour cap can't express); see elite-niche-rate-limiter.ts.
  const eliteNicheLimiter = new EliteNicheRateLimiter();
  // WI-253 (findings-EN-4.md "EN-1 GUI snapshot surface" fast-follow): register this
  // instance into the process-local registry so the owner-facing "member X at N/cap"
  // observability endpoint can read it. Additive only — the merge seam below still
  // closes over its OWN direct reference to `rateLimiter`; this is a second reference,
  // never a behavior change. Unregistered on close() below (see closeHooks).
  registerRateLimiter(opts.workspaceId, opts.harnessSlug, rateLimiter);

  // (rekeyDeps + epochDrainQueue are built above, before registerAllHarnessProjections, so
  // the re-key drain hook can wire into the projection registration — see there.)

  // ── Admitted-set ── keyHex → log. Seeded with the own log (which is
  // structurally an AdmittedLog). Remote logs are added on admit (4b).
  const admitted = new Map<string, AdmittedLog>();
  admitted.set(ownLog.keyHex, ownLog);

  // WI-183: replication-stall detector state, keyed by admitted remote
  // log_core_key. See `checkReplicationStall` (called from mergeOnePass, right
  // after each remote's `update()`) for the full rationale. Tracks, per remote
  // log that has EVER shown a live replicator peer, when it last did — and
  // whether we've already alarmed for the current stall episode (so a
  // sustained stall fires exactly once, not every merge tick).
  const replicationStallState = new Map<
    string,
    { lastNonZeroPeersAtMs: number; alarmed: boolean }
  >();
  const REPLICATION_STALL_GRACE_MS =
    opts.replicationStallGraceMs ?? DEFAULT_REPLICATION_STALL_GRACE_MS;

  // ── Revocation (D-004) ── the only blocklist. `revoked` holds device pubkeys
  // (base64) the read-admission decider refuses; `pubkeyToLogKey` records the
  // device_pubkey → log_core_key mapping at admit time so `revoke()` can find
  // and drop the corresponding admitted log. `admitted` is keyed by
  // `log_core_key`, but a revoke names a `device_pubkey`, so the mapping is the
  // bridge between the two.
  const revoked = new Set<string>();
  const pubkeyToLogKey = new Map<string, string>();
  // WI-193 (G8): provenance tracking for the UN-REVOKE reconciliation below.
  // Holds ONLY pubkeys that entered `revoked` via the startup seed or
  // applyRevocationRefresh — i.e. from the PUBLISHED revoked-pubkeys list, never
  // from a live `revoke()` call. This is what lets applyRevocationRefresh safely
  // remove a pubkey no longer in the published list (an owner un-banning someone)
  // WITHOUT ever undoing an explicit, in-process `revoke()` (owner-ban / go-private
  // boundary) — a live revoke is authoritative and is never a member of this set
  // (revoke() also evicts it below, in case it was ALREADY refresh-sourced).
  const revokedViaRefresh = new Set<string>();
  // `admittedIdentities` (+ the WI-259 P-002 `resolveAuthorDevice` seam) is declared
  // ABOVE `buildScopedApply` so the content projections can thread the seam — see there.

  // ── Startup revocation seed (D-002) ── load PUBLISHED revocations BEFORE the
  // swarm is joined so any already-revoked peer is refused on first contact.
  //
  // ALWAYS called unconditionally — both the test-seam path (loadRevokedOverride
  // is a pure in-memory factory) and the production path (real loadRevokedPubkeys
  // against PG) seed `revoked` here, before `joinHarnessSwarm`.  This closes the
  // ~1s window where the swarm is live but the revoked set is still empty.
  //
  // FAKE-TIMER SAFETY: postgres.js uses setTimeout() for connection-pool timeouts.
  // Calling the real PG loader under `vi.useFakeTimers()` hangs indefinitely (the
  // timeout callback never fires until fake time is advanced, which happens AFTER
  // bootHarnessSubstrate returns). Tests that activate fake timers MUST supply
  // `loadRevokedOverride: async () => new Set()` (or a populated factory) so they
  // never reach the real PG loader.  Production callers always have real timers
  // and a live PG, so this is safe.
  //
  // Fail-open: a load failure records a boot event and continues.
  const loadRevoked =
    opts.loadRevokedOverride ??
    (async () => {
      // Harness-scope revocations (the base set).
      const base = await loadRevokedPubkeys({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      });
      // Per-Hive admission (shared-hive-federation-2026-06-08 P-006 seam-1): when
      // this harness belongs to a Hive, UNION the Hive-scope revoked pubkeys so a
      // contributor revoked at the Hive grain is refused on EVERY member harness.
      // The read-admission decider is unchanged. Best-effort / fail-open: a hive
      // lookup failure leaves the harness-scope set intact.
      try {
        const { hiveHomeSlugForHarness } = await import('../../hive-federation');
        const hiveHome = await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug);
        if (hiveHome) {
          const { loadRevokedHivePubkeys } = await import('../../hive-membership-store');
          for (const pk of await loadRevokedHivePubkeys(opts.workspaceId, hiveHome)) {
            base.add(pk);
          }
        }
      } catch {
        // fail-open: harness-scope revocations still apply
      }
      return base;
    });
  try {
    const seeded = await loadRevoked();
    for (const pk of seeded) {
      revoked.add(pk);
      // WI-193 (G8): startup-seeded entries are refresh-sourced provenance —
      // eligible for un-revoke reconciliation if a later refresh drops them.
      revokedViaRefresh.add(pk);
    }
  } catch (e) {
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'merge_error',
      `revoked-seed failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Fail-open: continue boot without the seeded set.
  }

  // ── Pending-peer retry set (D-006) ── peers whose channel-2 file hasn't
  // propagated yet. Stored as log_core_key → {frame, since} — one device
  // announces MULTIPLE logs on the same topic (A-003: a member log + the
  // hive-home log share a device), so a device-keyed buffer silently dropped
  // every log after the first (WI-1544 root cause #2). The retry timer
  // re-runs admission for each pending frame; on 'verified' the peer is admitted
  // normally; on conclusive failure or grace-window expiry the frame is removed
  // without admit. Revocation drops ALL of a device's buffered logs.
  const pendingPeers = new Map<string, { frame: SignedAnnounce; since: number }>();
  function purgePendingForDevice(devicePubkey: string): void {
    for (const [key, entry] of pendingPeers) {
      if (entry.frame.device_pubkey === devicePubkey) pendingPeers.delete(key);
    }
  }

  // ── Revocation refresh helper (D-002) ── load the current published revoked set
  // from PG (via `loadRevoked`) and union any NEW pubkeys into `revoked`. For each
  // newly-added pubkey that is CURRENTLY admitted, apply the same drop steps
  // `revoke()` uses. Fail-open: a load failure is caught by the caller.
  // IMPORTANT: callers MUST hold the `merging` flag or otherwise guarantee
  // single-threaded access to `admitted` / `pendingPeers` while this runs.
  //
  // WI-193 (G8 fix): also RECONCILES un-revocations. `revoked` was previously
  // monotonic for the life of the handle (union-only) — dropping a pubkey from
  // the published list never re-admitted it; the only recovery was a full
  // reboot. Now, any pubkey whose provenance is REFRESH-SOURCED
  // (`revokedViaRefresh` — i.e. it was never named in a live `revoke()` call)
  // and that is no longer present in the freshly-loaded published set is
  // removed from `revoked`, re-admitting it on its next announce. A pubkey
  // revoked via a live `revoke()` call is NEVER a member of `revokedViaRefresh`
  // (revoke() evicts it there too), so this reconciliation can never silently
  // undo an explicit owner-initiated revoke — only ever a published-list entry
  // that the owner has since removed.
  async function applyRevocationRefresh(): Promise<void> {
    const refreshed = await loadRevoked();
    for (const pk of refreshed) {
      if (!revoked.has(pk)) {
        // New revocation discovered from PG.
        revoked.add(pk);
        revokedViaRefresh.add(pk);
        // Drop from the pending-retry set — a revoked peer must never be retried.
        purgePendingForDevice(pk);
        // If the peer is currently admitted, drop its log.
        const logKey = pubkeyToLogKey.get(pk);
        if (logKey) {
          admitted.delete(logKey);
          replicationStallState.delete(logKey); // WI-183: drop stale stall-tracking state
      dropReplicationLogState(opts.workspaceId, opts.harnessSlug, logKey); // P-004: liveness registry too
          dropReplicationLogState(opts.workspaceId, opts.harnessSlug, logKey); // P-004: liveness registry too
          pubkeyToLogKey.delete(pk);
          admittedIdentities.delete(logKey);
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_revoked',
            peerLabel(logKey),
          );
        }
      }
    }
    // Un-revoke reconciliation (G8): only refresh-sourced entries are eligible.
    for (const pk of [...revokedViaRefresh]) {
      if (!refreshed.has(pk)) {
        revoked.delete(pk);
        revokedViaRefresh.delete(pk);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'peer_unrevoked',
          `pubkey ${pk.slice(0, 12)}… dropped from the published revoked list — re-admissible`,
        );
      }
    }
  }

  // ── Channel-2 re-verify for admitted peers (rev-v2 Component A) ──
  //
  // Design (harden-shared-hive-to-256-peers P-002): the GitHub `verifyBinding`
  // I/O runs LOCKLESS — OFF the merge lock — mirroring the admissionQueue
  // deferred-mutation pattern. The OLD design awaited a SERIAL `verifyBinding`
  // call per admitted peer INSIDE the merge pass under the `merging` lock; at
  // 256 peers that's ~256 serial network round-trips holding the lock for tens
  // of seconds → read-merge convergence FREEZE. Now:
  //   • `reverifyAdmitted()` (the producer) snapshots `admittedIdentities`, makes
  //     the `verifyBinding` calls OFF the lock, and ENQUEUES each conclusive-`fail`
  //     logKey into `reverifyDropQueue`. It MUTATES nothing shared.
  //   • `drainReverifyDropQueue()` (the consumer) applies those drops UNDER the
  //     merge gate at the TOP of each pass, right alongside `drainAdmissionQueue()`
  //     (delete from the three maps + a `peer_revoked` boot-event).
  //   • `maybeReverifyAdmitted()` (still under the lock) only drains the drop queue
  //     and, when the cadence has elapsed and no verify is already in flight, KICKS
  //     OFF the lockless producer as a non-awaited `void (async …)()`. NET: zero
  //     GitHub I/O under the merge lock.
  // The slow cadence is enforced by `lastReverifyAt`; `reverifyInFlight` coalesces
  // so a long verify never stacks up behind every poll tick.
  //
  // Re-admit path: a channel-2-fail drop does NOT add the pubkey to the published
  // `revoked` set. A GitHub-deleted binding is a GitHub-side revocation, not a
  // permanent blocklist entry — if the binding is re-published the peer can
  // re-announce and be admitted through normal admission. This differs from
  // revoke() (which adds to `revoked` so a re-announce is permanently refused)
  // and is intentional: let normal admission re-verify rather than blocklisting.
  //
  // Scaling note: with N admitted peers each `reverifyAdmitted()` pass makes N
  // GitHub API calls. They now run OFF the lock so they no longer freeze merge,
  // but they are still SERIAL — at larger scale consider staggering calls across
  // passes (e.g. pick one peer per pass in round-robin) to spread the API load.
  // That optimisation is deferred to a later component.

  /** Timestamp of the last `reverifyAdmitted` KICK-OFF (ms). 0 = never. */
  let lastReverifyAt = 0;

  // P-002: logKeys whose channel-2 binding came back a conclusive `'fail'` from
  // the LOCKLESS `reverifyAdmitted()` producer. Drained + applied UNDER the merge
  // gate by `drainReverifyDropQueue()` at the top of each pass (mirror of
  // `admissionQueue`). `reverifyInFlight` coalesces overlapping verify runs.
  const reverifyDropQueue: string[] = [];
  let reverifyInFlight = false;

  const DEFAULT_REVERIFY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  const reverifyIntervalMs = Number.isFinite(opts.reverifyIntervalMs as number)
    ? (opts.reverifyIntervalMs as number)
    : DEFAULT_REVERIFY_INTERVAL_MS;

  // The `verifyBinding` function used for re-verification: the same one wired
  // into the admission decider (verifyBindingOverride in tests; real adapter in
  // production). Captured here as a stable reference.
  const verifyBinding = opts.verifyBindingOverride ?? buildVerifyBindingAdapter();

  /**
   * LOCKLESS channel-2 re-verify PRODUCER (P-002). Snapshots `admittedIdentities`
   * and makes the SERIAL GitHub `verifyBinding` calls OFF the merge lock. It does
   * NOT mutate `admitted` / `admittedIdentities` / `pubkeyToLogKey`; instead it
   * ENQUEUES each peer whose binding returns a conclusive `'fail'` into
   * `reverifyDropQueue`, which `drainReverifyDropQueue()` applies UNDER the merge
   * gate on a subsequent pass. Peers on `'pending'` / `'verified'` / a thrown
   * (transient) error are KEPT (fail-open per D-004) — only a conclusive `'fail'`
   * enqueues a drop. A drop does NOT add the pubkey to the published `revoked`
   * set (a GitHub-side removal is re-admittable; normal admission re-admits if the
   * binding returns).
   *
   * SAFE to call without holding the `merging` flag: it only READS a snapshot and
   * pushes logKeys onto the queue. The snapshot is taken up front so concurrent
   * merge-pass mutations (revoke / refresh drops) can't corrupt iteration; the
   * drain re-checks liveness before applying, so a peer already gone by drain time
   * is skipped.
   */
  async function reverifyAdmitted(): Promise<void> {
    // Snapshot identities up front so the off-lock awaits below iterate a stable
    // set even if a concurrent merge pass mutates the live maps. (Only admitted
    // PEERS have an identity entry — the own log is absent, so it is never
    // re-verified or enqueued.)
    const snapshot = [...admittedIdentities.entries()];
    for (const [logKey, identity] of snapshot) {
      // Never re-verify the own log (can't revoke yourself via GitHub-side removal).
      if (logKey === ownLog.keyHex) continue;
      if (!identity) continue;

      let result: 'verified' | 'pending' | 'fail';
      try {
        result = await verifyBinding(
          identity.devicePubkey,
          identity.githubLogin,
          identity.githubUserId,
          identity.attestationGistId,
        );
      } catch (e) {
        // Transient / network error — keep the peer (fail-open per D-004).
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `reverify transient error for ${peerLabel(logKey)}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      if (result === 'fail') {
        // Conclusive channel-2 revocation: ENQUEUE the drop. The actual map
        // mutation + `peer_revoked` event happen in `drainReverifyDropQueue()`
        // under the merge gate — never here, off the lock.
        reverifyDropQueue.push(logKey);
      }
      // 'pending' or 'verified': keep the peer (fail-open; only conclusive fail drops).
    }
  }

  /**
   * Apply queued channel-2 re-verify drops. MUST run under the merge gate
   * (called at the top of `mergeOnePass`, alongside `drainAdmissionQueue`, and
   * from `maybeReverifyAdmitted`). Idempotent: a peer already dropped between
   * enqueue and drain (e.g. by `revoke()` / `applyRevocationRefresh`) is skipped
   * without a duplicate event. Does NOT add to the published `revoked` set.
   */
  function drainReverifyDropQueue(): void {
    while (reverifyDropQueue.length > 0) {
      const logKey = reverifyDropQueue.shift()!;
      // Never drop the own log (defensive; the producer never enqueues it).
      if (logKey === ownLog.keyHex) continue;
      // Already gone (revoked / refreshed away since enqueue) → skip silently.
      if (!admitted.has(logKey) && !admittedIdentities.has(logKey)) continue;
      const identity = admittedIdentities.get(logKey);
      admitted.delete(logKey);
      replicationStallState.delete(logKey); // WI-183: drop stale stall-tracking state
      dropReplicationLogState(opts.workspaceId, opts.harnessSlug, logKey); // P-004: liveness registry too
      admittedIdentities.delete(logKey);
      // Clean up the pubkey→logKey reverse mapping.
      if (identity?.devicePubkey) {
        pubkeyToLogKey.delete(identity.devicePubkey);
      }
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'peer_revoked',
        `channel-2 revoked ${peerLabel(logKey)}`,
      );
    }
  }

  /**
   * Called inside `mergeOnePass` under the `merging` lock. Does ZERO GitHub I/O
   * under the lock: it only (1) drains any drops the lockless producer already
   * enqueued, and (2) when `reverifyIntervalMs` has elapsed and no verify is in
   * flight, KICKS OFF the lockless `reverifyAdmitted()` producer fire-and-forget
   * (mirroring the owner-admit fire-and-forget in `drainAdmissionQueue`). The
   * producer runs OFF the lock and requests a merge pass when it has drops to
   * apply. A no-op kick-off when `reverifyIntervalMs <= 0` (disabled — tests drive
   * `reverifyAdmitted()` + `mergeNow()` directly via the handle).
   */
  async function maybeReverifyAdmitted(): Promise<void> {
    // Apply drops a prior off-lock verify enqueued (cheap; usually empty).
    drainReverifyDropQueue();
    if (reverifyIntervalMs <= 0) return;
    const now = Date.now();
    if (now - lastReverifyAt < reverifyIntervalMs) return;
    if (reverifyInFlight) return; // coalesce: a verify is already running off-lock
    lastReverifyAt = now;
    reverifyInFlight = true;
    // Fire-and-forget: the GitHub I/O runs OFF the merge lock (mirrors the
    // owner-admit fire-and-forget in drainAdmissionQueue). When the producer
    // enqueues drops it requests a merge pass to apply them under the gate.
    void (async () => {
      try {
        await reverifyAdmitted();
        if (reverifyDropQueue.length > 0) {
          // Request a pass to drain the drops under the gate (coalesces with any
          // in-flight/poll pass). NOT awaited — this runs off the lock.
          void mergeNow();
        }
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `reverify run failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        reverifyInFlight = false;
      }
    })();
  }

  // ── Read-merge driver ── replaces the old Autobase read-loop. A pass:
  //   1. drain queued admissions (audit P-022 — see admissionQueue below).
  //   2. update() every REMOTE log first (the spike found remote `length`
  //      is stale until update() — own log is always current so skip it).
  //   3. version-gate each log (drop unknown-newer ops, D-024).
  //   4. mergeAdmittedLogs → LWW → existing projection writers → PG.
  // Serialized via the `inflightMerge` gate so the poll + on-admit + initial
  // passes don't race a half-applied merge.
  let stopped = false;
  // Teardown hooks (Stage 5 outbox drain stopper, etc.) run once on close().
  const closeHooks = new Set<() => void | Promise<void>>();
  // WI-253: drop this harness's rate-limiter registry entry on close so a stopped
  // harness is never served as if its limiter were still live.
  closeHooks.add(() => unregisterRateLimiter(opts.workspaceId, opts.harnessSlug));
  // EI-79 residual (p2p-performance-suite P-013): the INCREMENTAL merge cursor.
  // Replaces the lengths-snapshot steady-state skip with per-log read cursors +
  // a materialized winner-meta fold, so a changed tick decodes only the DELTA
  // (O(new ops)) instead of re-decoding + re-folding + re-applying the entire
  // history (O(total-history) — the original EI-79 burn; the snapshot skip only
  // rescued the *idle* tick). Also fixes EI-91: the per-log read budget is now
  // a per-PASS chunk the cursor advances through, so history beyond 50k ops is
  // delayed across passes, never silently dropped. The cursor is in-memory;
  // boot's first pass is the full-history fold (same cost as the old backfill).
  //
  // INVARIANT: the cursor's fold state is only valid for a stable log SET.
  // A log REMOVAL (revoke / channel-2 drop) resets the cursor — the next pass
  // re-folds the remaining logs from index 0 (exactly what the old full
  // re-merge did after a drop). A log ADDITION is additive (its cursor starts
  // at 0; lwwPick's total order makes fold order irrelevant) — no reset.
  let mergeCursor = createMergeCursor();

  // A-003 apply-side determinism (su-81f2e): set by rekey() after a hive-home
  // projection rebind to force ONE full re-fold of all admitted logs through the
  // freshly-rebound scopedApply. The owner's hive_members op may have been admitted
  // AND folded (cursor-marked done) during the home=<none> boot window — when the
  // hive_members projection was still bound to the MEMBER slug, so the op dropped at
  // hive-members.ts (row.hive_home_slug !== member slug) and never re-applied (the
  // cursor says done; the log SET didn't change so the log-removal reset never fires).
  // Re-folding from index 0 re-applies it through the now-hive-home-bound projection
  // → roster row lands → the pendingMemberContent drain fires. Checked + cleared UNDER
  // the merge gate (top of mergeOnePass), so it never races an in-flight pass.
  let forceReFold = false;

  // substrate-peer-log-compaction-2026-06-13 (design A, D-005) — FLAG-GATED, dark.
  // When on: (a) seed a fresh/reset cursor at each log's latest `__snapshot__`
  // index so a new joiner folds from the snapshot instead of replaying full
  // history (P-007), and (b) periodically compact the OWN log once it grows past
  // SNAPSHOT_COMPACT_EVERY_OPS ops since its last snapshot (P-005). The flag is
  // read ONCE at boot (boot-scoped, like the authority transports — a runtime
  // flip needs a reboot to take effect). OFF ⇒ both no-ops, cursor seeds at 0,
  // byte-identical to today. `lastSnapshotCoversUpTo` is seeded from the existing
  // latest snapshot so a restart (the watchdog recycles ~every 12 min) does NOT
  // re-compact a log that hasn't grown a threshold since.
  const snapshotEnabled = await getFlag(FLAGS.SUBSTRATE_LOG_SNAPSHOT, 'system').catch(() => false);
  let lastSnapshotCoversUpTo = snapshotEnabled
    ? ((await findLatestSnapshotIndex(ownLog).catch(() => null)) ?? 0)
    : 0;

  // ── SUBSTRATE_SIDECAR Option B replication-offload (WI-604) ── FLAG-GATED, dark.
  // Read ONCE at boot (boot-scoped, like the snapshot + authority transports). When
  // ON, the swarm connection handler hands each accepted peer socket to the sidecar
  // for `corestore.replicate()` (offloading merkle-verify CPU + replication RSS — the
  // EI-79 win) INSTEAD of replicating in-process; the substrate engine + own log +
  // every `handle.append()` caller stay in-process untouched. OFF (the default) ⇒ the
  // offload seam is never passed to joinHarnessSwarm, so replication is byte-identical
  // in-process. A test may force it via `sidecarOffloadOverride` without the flag.
  const sidecarOffloadEnabled =
    opts.sidecarOffloadOverride !== undefined
      ? false // an explicit override seam is the source of truth (see joinForBinding)
      : await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system').catch(() => false);

  // ── Admission queue (audit P-022, EI-115/EI-116 contributor) ── admitPeer
  // used to mutate admitted/pubkeyToLogKey/admittedIdentities directly while a
  // merge pass could be iterating them, and its mergeNow() no-op'd against an
  // in-flight pass, deferring the newly-admitted log to the next 1s poll.
  // Admissions now QUEUE here and are drained at the top of each pass under
  // the merge gate; mergeNow coalesces (a request landing mid-pass re-runs the
  // pass before the gate releases), so awaiting mergeNow after a queue push
  // always covers that admission.
  const admissionQueue: SignedAnnounce[] = [];

  // 'admitted' listeners (audit P-022): consumers (perf rigs) previously
  // polled handle.admitted.size on a 100ms timer to detect mesh-readiness —
  // emit directly at admission instead. Best-effort: a throwing listener
  // never breaks admission or the merge pass.
  const admittedListeners = new Set<
    (info: { logKeyHex: string; admittedSize: number }) => void
  >();
  function emitAdmitted(logKeyHex: string): void {
    for (const listener of [...admittedListeners]) {
      try {
        listener({ logKeyHex, admittedSize: admitted.size });
      } catch {
        // listener errors never break admission
      }
    }
  }

  /** Drain queued admissions. MUST run under the merge gate (mergeOnePass). */
  async function drainAdmissionQueue(): Promise<void> {
    while (admissionQueue.length > 0) {
      const frame = admissionQueue.shift()!;
      // Revocation can land BETWEEN enqueue and drain (the queue defers the
      // admission); admitting then would resurrect a revoked peer. The decider
      // checked `revoked` at announce time — re-check at drain time.
      if (revoked.has(frame.device_pubkey)) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `revoked-before-drain ${peerLabel(frame.log_core_key)}`,
        );
        continue;
      }
      try {
        // Record device_pubkey → log_core_key so `revoke(devicePubkey)` can
        // find and drop the right admitted log (admitted is keyed by
        // log_core_key).
        pubkeyToLogKey.set(frame.device_pubkey, frame.log_core_key);
        // Record the full identity for this admitted peer so
        // `reverifyAdmitted()` can re-call verifyBinding without needing the
        // original frame (rev-v2 A).
        admittedIdentities.set(frame.log_core_key, {
          devicePubkey: frame.device_pubkey,
          githubLogin: frame.github_login,
          githubUserId: frame.github_user_id,
          attestationGistId: frame.attestation_gist_id,
        });
        if (!admitted.has(frame.log_core_key)) {
          const remote = await (opts.openRemoteLogOverride ?? openRemoteLog)(
            store,
            frame.log_core_key,
          );
          admitted.set(frame.log_core_key, remote);
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_admitted',
            peerLabel(frame.log_core_key),
          );
          emitAdmitted(frame.log_core_key);
        }
        // WI-639 + WI-280 + WI-1585: the OWNER's trust-admit of an announced peer, gated on
        // the owner-signed membership policy. Runs for EVERY drained announce — NOT only the
        // first core-admission (WI-1585): announces arrive on (re)connect, and a peer whose
        // core is already admitted (presence flowing) still needs its membership refreshed —
        // the SECOND DEVICE of an already-member GitHub user would otherwise NEVER be
        // attested in this process lifetime (the ownerAdmitOrPend already_member branch is
        // the designed reconnect self-heal: idempotent upsert + BUG-B epoch-key re-grant).
        {
          // admitAnnouncedPeerAsOwner resolves the Hive
          // home (member→hive_slug via a fresh registry read, the WI-280 fix), self-gates to
          // the OWNER box, then routes the decision through ownerAdmitOrPend: open/allowlisted
          // → upsertHiveMember (+ idempotent epoch [0..current] re-grant); approval → record a
          // federated pending-join (NO trust-admit until hive:membership_decide approves);
          // banned/not-allowlisted → refuse. Open-mode is BYTE-EQUIVALENT to the prior
          // unconditional upsert. Core admission / revocation / read-cut+epoch / per-op
          // enforcement are untouched (their own seams). Fire-and-forget: drainAdmissionQueue
          // runs under the merge gate, so this must NOT block it.
          void (async () => {
            try {
              const { admitAnnouncedPeerAsOwner } = await import('../../hive-membership-admission');
              const res = await admitAnnouncedPeerAsOwner(
                {
                  workspaceId: opts.workspaceId,
                  harnessSlug: opts.harnessSlug,
                  peer: {
                    githubUserId: frame.github_user_id,
                    githubLogin: frame.github_login,
                    devicePubkey: frame.device_pubkey,
                    attestationGistId: frame.attestation_gist_id,
                  },
                },
                {
                  // The boot ALREADY resolved this harness's hive-home (and keeps it
                  // current across rekey rebinds) — hand it over instead of letting the
                  // default re-resolve via registry+PG reads per announce. In the
                  // substrate SIDECAR (and in-process test harnesses) those default
                  // reads can be unconfigured and threw per announce (WI-1460: the
                  // cross-peer suite died on the console.error; live, the admit
                  // silently skipped). Deterministic + free.
                  hiveHomeSlugForHarness: async () => hiveHomeProjectionSlug ?? ownHiveHomeSlug ?? null,
                },
              );
              if (res.action === 'pending') {
                recordBootEvent(
                  opts.workspaceId,
                  opts.harnessSlug,
                  'announce_pending',
                  `${peerLabel(frame.log_core_key)} awaiting owner approval (hive ${res.hiveHomeSlug})`,
                );
              } else if (res.action === 'refuse') {
                recordBootEvent(
                  opts.workspaceId,
                  opts.harnessSlug,
                  'announce_rejected',
                  `${peerLabel(frame.log_core_key)} membership refused:${res.reason} (hive ${res.hiveHomeSlug})`,
                );
              }
            } catch (e) {
              const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
              // The grant failure inside upsertHiveMember already records a queryable
              // `rekey_grant_failed` boot-event; this catch only fires if the resolve /
              // membership write itself throws. Stay non-blocking (merge-gated), best-effort.
              // eslint-disable-next-line no-console
              console.error(
                `[hive-rekey] owner admit failed for ${peerLabel(frame.log_core_key)}: ${detail}`,
              );
            }
          })();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          msg,
        );
        // WI-1544 root cause #3 (one-shot silent loss): the frame was already
        // shift()'d off the queue, announces are never re-delivered (sender-side
        // sentKeys dedup), and this catch was ring-only — a single throw here
        // (e.g. openRemoteLog racing a rekey) permanently stalled every A→B
        // surface until a restart. Re-buffer the frame into the D-006 pending
        // set so the retry tick re-runs the FULL admission, and say so on
        // stderr (the boot-history ring is in-memory only).
        if (
          !admitted.has(frame.log_core_key) &&
          !revoked.has(frame.device_pubkey) &&
          !pendingPeers.has(frame.log_core_key)
        ) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        // eslint-disable-next-line no-console
        console.error(
          `[hyperbee-admission] admit failed for ${peerLabel(frame.log_core_key)} — re-buffered for retry: ${msg}`,
        );
      }
    }
  }

  // The merge gate — one RUNNING pass + at most one PENDING follower.
  // A mergeNow() during a running pass coalesces onto the single follower,
  // which STARTS after the current pass finishes — so every caller's promise
  // resolves after a pass that began after its call (a queued admission is
  // always drained by then). BOUNDED on purpose: an earlier shape re-ran the
  // running chain while any re-run flag was set, so a steady caller stream
  // (the 1s poll under connection churn, where passes exceed 1s) re-armed it
  // forever and awaiters never resolved — peers stopped converging.
  let runningMerge: Promise<number> | null = null;
  let pendingMerge: Promise<number> | null = null;
  // WI-1544: stderr dedup state for the mergeOnePass outer catch (the poll
  // fires ~1Hz — a repeating failure logs once a minute, not 60 times).
  let lastMergeErrorMsg = '';
  let lastMergeErrorLogTs = 0;
  function mergeNow(): Promise<number> {
    if (stopped) return Promise.resolve(0);
    if (!runningMerge) {
      runningMerge = mergeOnePass().finally(() => {
        runningMerge = null;
      });
      return runningMerge;
    }
    if (!pendingMerge) {
      pendingMerge = runningMerge
        .catch(() => 0)
        .then(() => {
          // The running pass's finally has already cleared runningMerge, so
          // this re-entry starts the follower pass (or coalesces anew).
          pendingMerge = null;
          return mergeNow();
        });
    }
    return pendingMerge;
  }

  /**
   * WI-183: replication-stall detector. Samples an admitted REMOTE log's live
   * replicator-peer count (`RemoteLog.peersCount()` — best-effort, `undefined`
   * on a fake/mock log in tests, which is a silent no-op here) and records a
   * `replication_stalled` boot event the first time it has held at zero for
   * `REPLICATION_STALL_GRACE_MS`, having shown at least one peer before.
   *
   * Deliberately edge-triggered (fires once per stall episode, not every merge
   * tick) and deliberately gated on "was replicating before" — a peer that has
   * NEVER shown a live replicator peer is just offline (ordinary churn, not a
   * bug); the WI-183 symptom is specifically a log that WAS replicating and
   * then silently stopped while the swarm otherwise reports the peer connected.
   * Clears (allows a future re-alarm) the moment peers are seen again.
   */
  function checkReplicationStall(log: AdmittedLog): void {
    const maybePeersCount = log as Partial<{ peersCount(): number | undefined }>;
    if (typeof maybePeersCount.peersCount !== 'function') return;
    const count = maybePeersCount.peersCount();
    if (count === undefined) return; // underlying core doesn't expose .peers
    const now = Date.now();
    if (count > 0) {
      // Replicating (again) — (re)seed the clock and clear any prior alarm so
      // a later stall re-fires.
      replicationStallState.set(log.keyHex, { lastNonZeroPeersAtMs: now, alarmed: false });
      return;
    }
    // count === 0. A state entry exists ONLY for a log we've seen with peers > 0
    // at least once (never created on a zero observation — see above) — so a
    // MISSING entry here means this log has never shown a live replicator peer:
    // ordinarily offline, not the WI-183 symptom, and must never alarm.
    const state = replicationStallState.get(log.keyHex);
    if (!state || state.alarmed) return;
    if (now - state.lastNonZeroPeersAtMs < REPLICATION_STALL_GRACE_MS) return;
    state.alarmed = true;
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'replication_stalled',
      `log=${log.keyHex.slice(0, 12)}… has had 0 live replicator peers for ` +
        `${Math.round((now - state.lastNonZeroPeersAtMs) / 1000)}s (was previously replicating)`,
    );
  }

  /** One serialized merge pass. Only ever called from mergeNow's gate. */
  async function mergeOnePass(): Promise<number> {
    try {
      // Queued admissions land first so THIS pass merges them (P-022).
      await drainAdmissionQueue();

      // Apply any channel-2 re-verify drops the LOCKLESS producer enqueued
      // (P-002) — mirror of drainAdmissionQueue: the GitHub I/O ran off the
      // merge lock; this only applies its conclusive-fail results under the gate.
      drainReverifyDropQueue();

      // ── Revocation refresh BEFORE collecting the merge set (G7 fix) ──
      // A published revocation that has propagated to this peer's loader (e.g.
      // A's revoked_pubkeys row federated to B's PG) must drop the revoked
      // peer's log from `admitted` *before* this pass reads it — otherwise a
      // peer revoked in the SAME cycle as it appends new ops gets ONE final
      // merge of those ops (the refresh used to run only AFTER the merge body,
      // so a `changed` pass ingested the revoked-era ops before the drop). This
      // mirrors the ordering `revoke()` already uses: delete from `admitted`,
      // THEN merge. The cursor-reset check below sees the removed log and
      // re-folds the survivors without it. Fail-open per D-002 — and isolated
      // (WI-1544): a loadRevoked() throw at the TOP of the pass used to reach
      // the outer catch and abort EVERY pass, ring-only, silently stalling all
      // federation. A failed refresh now skips only the refresh; the next pass
      // retries it.
      try {
        await applyRevocationRefresh();
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'merge_error',
          `revocation-refresh: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const logs: AdmittedLog[] = [];
      for (const log of admitted.values()) {
        // Refresh remote logs so `length` reflects the writer's appends.
        // The own log is the local source of truth; calling update() on it
        // is unnecessary (and it has no `update`), so only remotes refresh.
        if (log.keyHex !== ownLog.keyHex) {
          const maybeRemote = log as Partial<{ update(): Promise<void> }>;
          if (typeof maybeRemote.update === 'function') {
            try {
              // Bound the per-remote update() the same way read-merge bounds its
              // per-op get(): a connected-but-stalled peer's core.update({wait})
              // can block forever, and we hold the `merging` lock across the
              // whole pass — so an unbounded await here would stall own-log
              // progress AND every other remote. Race it against a timeout;
              // a timed-out remote is merged at its last-known length (the
              // catch already tolerates a failed update), and the next pass
              // retries. Per-remote so one stalled peer doesn't block others.
              await raceWithTimeout(maybeRemote.update(), UPDATE_TIMEOUT_MS);
            } catch {
              // A remote that can't refresh (peer offline / stream closed /
              // timed out) is merged at its last-known length; next pass retries.
            }
          }
          // WI-183: sample this remote's live replicator-peer count and alarm
          // on a sustained stall. Best-effort — never lets a detector hiccup
          // block the merge pass it rides.
          try {
            checkReplicationStall(log);
          } catch {
            // diagnostic-only — swallow
          }
          // P-004 (WI-1840): feed the replication-liveness registry — the
          // read-time verdict + durable-EI escalation layer over the edge-only
          // boot event above. Adds the ATTACHED-BUT-FROZEN axis the peers-count
          // check can't see: merge position vs the writer's known length
          // (contiguousLength would false-alarm on snapshot-seeded sparse
          // replicas — see replication-liveness.ts). Same best-effort posture.
          try {
            const maybePeers = log as Partial<{ peersCount(): number | undefined }>;
            sampleReplicationLiveness(
              opts.workspaceId,
              opts.harnessSlug,
              {
                keyHex: log.keyHex,
                knownLength: log.length,
                mergedPosition: mergeCursor.positions.get(log.keyHex) ?? 0,
                peersCount:
                  typeof maybePeers.peersCount === 'function'
                    ? maybePeers.peersCount()
                    : undefined,
                // WI-183 zombie axis: live swarm connections for the harness
                // topic. Read from the CURRENT handle (rekey() reassigns it);
                // null handle (no swarm joined / mid-rekey window) → undefined
                // disables the axis for this sample, never alarms.
                swarmConnections: swarmHandle?.liveConnectionCount,
              },
              { graceMs: REPLICATION_STALL_GRACE_MS },
            );
          } catch {
            // diagnostic-only — swallow
          }
        }
        logs.push(versionGatedLog(slug, log));
      }

      // Log-set change detection: any cursor entry whose log is GONE from the
      // admitted set invalidates the fold state (its winners must be re-derived
      // without that log's ops) → reset and re-fold from zero this pass.
      const logKeys = new Set(logs.map((l) => l.keyHex));
      for (const known of mergeCursor.positions.keys()) {
        if (!logKeys.has(known)) {
          mergeCursor = createMergeCursor();
          break;
        }
      }

      // A-003 apply-side: a rekey rebind asked for a full re-fold (re-apply every
      // admitted log through the newly-bound projections). Reset HERE, under the merge
      // gate, mirroring the log-removal reset above — one-shot, cleared immediately so
      // steady-state passes are unaffected. Placed before snapshot seeding (below) so a
      // re-fold behaves identically to the log-removal reset path.
      if (forceReFold) {
        mergeCursor = createMergeCursor();
        forceReFold = false;
      }

      // P-007 (design A, flag-gated): seed a FRESH/reset cursor at each log's
      // latest snapshot so a new joiner (or a post-reset re-fold) starts from the
      // snapshot, not index 0. Idempotent — only seeds logs with no cursor
      // position yet, so steady-state passes are O(logs) cheap `.has()` checks.
      // OFF ⇒ never called ⇒ cursor seeds at 0 (unchanged).
      if (snapshotEnabled) {
        // WI-1544 isolation: a seed failure means "start that log at 0" (slower,
        // still correct) — it must never abort the pass via the outer catch.
        try {
          await seedCursorFromSnapshots(logs, mergeCursor);
        } catch (e) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `snapshot-seed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // EI-79 steady-state skip (cursor form): nothing new past any log's
      // cursor → skip decode/fold/apply entirely. Lengths are post-update()
      // so growth is caught promptly; the cadenced refresh/reverify hooks
      // below still run.
      let changed = false;
      for (const log of logs) {
        if (log.length > (mergeCursor.positions.get(log.keyHex) ?? 0)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        // applyRevocationRefresh + drainReverifyDropQueue already ran at the top
        // of this pass; on the idle tick maybeReverifyAdmitted only re-drains and
        // (cadence permitting) kicks off the LOCKLESS verify — zero I/O here.
        // Isolated (WI-1544): a reverify kick-off failure never aborts the pass.
        try {
          await maybeReverifyAdmitted();
        } catch (e) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `reverify: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return 0;
      }

      // ── Owner-enforcement seam (plan shared-hive-owner-enforcement-2026-06-19) ──
      // Read the owner-SIGNED Hive policy ONCE per merge pass. This runs only past the
      // !changed guard above (a pass with new content to merge) — an idle / un-policed
      // harness pays NOTHING. The policy is scoped to the Hive home (hiveHomeProjectionSlug
      // rebinds on the joiner re-key; the owner's home harness is its own slug). null ⇒
      // no policy ⇒ no enforcement.
      const ownerPolicy: HivePolicy | null =
        (
          await getHivePolicy(
            opts.workspaceId,
            hiveHomeProjectionSlug ?? opts.harnessSlug,
          ).catch(() => null)
        )?.policy ?? null;
      // Compose the single enforcement decorator EXACTLY as policy-admission.ts documents:
      // EN-2 rate (inner) wrapped by EN-4 ban → allowlist → takedown → content (outer),
      // over the CURRENT scopedApply (which `rekey` may have rebound). With no policy this
      // is `scopedApply` itself — byte-for-byte the prior behavior. Author attribution keys
      // off the unforgeable receiver-stamped sourceLogKeyHex via admittedIdentities; an
      // author-dependent rule with an unresolved author fails CLOSED (the wrappers' contract).
      const enforcedApply = ownerPolicy
        ? makePolicyEnforcedApply({
            currentPolicy: () => ownerPolicy,
            resolveAuthor: (k) => {
              const id = admittedIdentities.get(k);
              return id ? { githubUserId: id.githubUserId, githubUsername: id.githubLogin } : null;
            },
            ownLogKeyHex: ownLog.keyHex,
            isContentTakenDown: (policy, op) => isContentTakenDown(policy, op.hbKey ?? ''),
            apply: makeRateLimitedApply({
              limiter: rateLimiter,
              nicheLimiter: eliteNicheLimiter,
              ownLogKeyHex: ownLog.keyHex,
              resolveAuthorId: (k) => admittedIdentities.get(k)?.githubUserId ?? null,
              currentCaps: () => ownerPolicy.rate ?? null,
              apply: scopedApply,
            }),
          })
        : scopedApply;

      // C-001 re-key decrypt-gate seam (compose contract: findings-EN-4.md). The re-key's
      // epoch DECRYPT-gate, when armed, wraps the enforcement stack OUTERMOST
      // (decrypt → EN-4 → EN-2 → scopedApply) so policy/rate see PLAINTEXT and an
      // undecryptable op — the read-cut — drops before spending rate budget / content checks.
      // OWNERSHIP (op-path division, su-ee7e9 2026-06-19): the re-key lane owns `decryptGate`
      // + flips `rekeyOn` to the papercusp-hive-rekey flag (and may hoist both to boot scope
      // with the epoch-key deps). Identity stub today ⇒ `applyImpl === enforcedApply`,
      // byte-for-byte unchanged. ONE owner per this expression — never raced.
      const mergeOpts = {
        // D-021: route through THIS harness's scoped projection apply, not the
        // global registry (which the last-booted harness would own). EN-4: wrapped by
        // the owner-enforcement seam above (passthrough = scopedApply when no policy); the
        // C-001 re-key decrypt-gate (su-ee7e9) wraps THAT OUTERMOST when armed — built once
        // at boot scope (`rekeyDeps`, null ⇒ enforcedApply byte-for-byte). decrypt → EN-4 →
        // EN-2 → scopedApply, so policy/rate see PLAINTEXT and an undecryptable op (the
        // read-cut / defer) drops before spending rate budget / content checks.
        applyImpl: rekeyDeps ? rekeyDeps.epochGate(enforcedApply) : enforcedApply,
        // The old per-author cap, reshaped: a per-PASS read budget. A log with
        // more backlog than this advances chunk-by-chunk across the 1Hz poll
        // (≈50k ops/sec/log ingest ceiling) instead of losing its tail (EI-91).
        maxOpsPerPass: MAX_OPS_PER_AUTHOR,
        // Surface standing backlog in boot-history (best-effort observability).
        onBacklog: (keyHex: string, position: number, length: number) => {
          try {
            recordBootEvent(
              opts.workspaceId,
              opts.harnessSlug,
              'peer_capped',
              `${keyHex.slice(0, 8)} backlog ${position}/${length}`,
            );
          } catch {
            // observability must never abort the merge pass
          }
        },
      };
      let result = await mergeAdmittedLogsIncremental(logs, mergeCursor, mergeOpts);
      // EI-79 step 3 (correctness escape hatch): a TRUNCATED log (length dropped
      // below its cursor — a reset/forked peer log) invalidates the standing fold.
      // Reset the cursor and re-fold all logs from scratch THIS pass (the same
      // response as a log removal). One retry suffices: the reset cursor starts
      // every position at 0, so it can't re-trigger truncation.
      if (result.truncated) {
        try {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_capped',
            'truncated log → cursor reset + full re-fold',
          );
        } catch {
          // observability must never abort the merge pass
        }
        mergeCursor = createMergeCursor();
        result = await mergeAdmittedLogsIncremental(logs, mergeCursor, mergeOpts);
      }
      const { applied } = result;

      // ── C-001 re-key DRAIN HOOK (su-c2a63) ── A `hive_epoch_keys` row applying THIS pass
      // fired `onEpochKeyApplied` → queued its (hive, epoch). Re-apply the deferred epoch-N
      // content for those epochs (decryptable now the key is local) through THIS pass's
      // applyImpl (decrypt → EN-4 → EN-2 → scopedApply — the same path). No-op when the
      // re-key is off (queue stays empty) or nothing was deferred (the common keys-first
      // ordering). Bounded + non-re-entrant (content ops never fire onEpochKeyApplied). The
      // P-008 witness can't exercise this (it orders keys-first), so without it a REMAINING
      // member that receives content before its key would silently lose it — this is the
      // pre-ship convergence guarantee. Runs inside the serialized merge block.
      if (rekeyDeps && epochDrainQueue.length > 0) {
        // WI-1544 isolation: the pass already merged its ops — a drain failure
        // must not discard that progress via the outer catch (the queue keeps
        // its entries; the next keyed pass re-drains).
        try {
          await drainQueuedEpochContent({
            pending: rekeyDeps.pending,
            drainQueue: epochDrainQueue,
            applyImpl: mergeOpts.applyImpl,
          });
        } catch (e) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `epoch-drain: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // P-005 (design A, flag-gated): compact the OWN log once it has grown past
      // the threshold since its last snapshot — append ONE additive snapshot op
      // (no fork). Runs inside the serialized merge block so it can't race a pass;
      // fires only every ~SNAPSHOT_COMPACT_EVERY_OPS ops (the O(history) own-log
      // read is amortized). Best-effort: a failed compaction must NEVER abort the
      // merge pass. OFF ⇒ never runs (no snapshot ops ever produced).
      if (snapshotEnabled && shouldCompactOwnLog(ownLog.length, lastSnapshotCoversUpTo)) {
        try {
          const snap = await produceLogSnapshot(ownLog, {
            now: Date.now(),
            schemaVersion: CURRENT_SCHEMA_VERSION,
          });
          if (snap.appended) lastSnapshotCoversUpTo = snap.coversUpTo;
        } catch (e) {
          try {
            recordBootEvent(
              opts.workspaceId,
              opts.harnessSlug,
              'peer_capped',
              `log compaction failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          } catch {
            // observability must never abort the merge pass
          }
        }
      }

      // ── Merge-refresh (D-002): the revocation refresh now runs at the TOP of
      // the pass (G7 fix) — BEFORE the merge set is collected — so a peer revoked
      // via the published list is dropped before its log is read, never getting a
      // final merge of its revoked-era ops. (It used to run only here, after the
      // merge body, which let a `changed` pass ingest those ops before the drop.)
      // Kept inside the serialized merge block, under the merging lock, exactly as
      // before; no re-entrancy into mergeNow.

      // ── Channel-2 re-verify (rev-v2 Component A; P-002): the GitHub I/O runs
      // LOCKLESS. Here, under the merge gate, `maybeReverifyAdmitted` only drains
      // any conclusive-fail drops the off-lock producer enqueued and (cadence
      // permitting, and if no verify is in flight) KICKS OFF the next verify
      // fire-and-forget. It is a no-op kick-off when:
      //   (a) reverifyIntervalMs <= 0 (disabled; tests drive reverifyAdmitted directly), or
      //   (b) the slow cadence hasn't elapsed since the last kick-off.
      // No `verifyBinding` network call ever runs under this lock.
      // Isolated (WI-1544): the pass's `applied` count is already earned —
      // a reverify kick-off failure must not turn it into a merge_error+0.
      try {
        await maybeReverifyAdmitted();
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'merge_error',
          `reverify: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      return applied;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'merge_error', msg);
      // WI-1544: this catch was ring-only (in-memory, lost on restart) — a
      // persistently-throwing pass silently stalled ALL federation with zero
      // serve.log evidence. Mirror to stderr, deduped: log when the message
      // changes or at most once a minute for a repeating one.
      if (msg !== lastMergeErrorMsg || Date.now() - lastMergeErrorLogTs > 60_000) {
        lastMergeErrorMsg = msg;
        lastMergeErrorLogTs = Date.now();
        // eslint-disable-next-line no-console
        console.error(
          `[hyperbee-merge] merge pass FAILED harness=${opts.harnessSlug}: ${e instanceof Error ? (e.stack ?? msg) : msg}`,
        );
      }
      return 0;
    }
  }

  // P-066 bootstrap-progress tracker. Polls ownLog.length each second;
  // feeds the BootstrapProgressIndicator via /api/harness/:slug/
  // bootstrap-progress. Cheap; idempotent across reboots (keys by
  // (workspaceId, slug)).
  const progressPoller = startBootstrapProgressPoller({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    readLength: () => ownLog.length,
  });

  // Initial backfill merge + a polled fallback. On-remote-append merges
  // are driven by `onAnnounce` (4b) calling mergeNow after each admit.
  void mergeNow();
  const mergePollMs = Number.isFinite(opts.mergePollMs as number)
    ? (opts.mergePollMs as number)
    : MERGE_POLL_MS;
  // Poll-driven merge cadence. The revocation refresh now runs INSIDE mergeNow
  // under the merging lock (see above), so the poll-timer callback only needs
  // to call mergeNow() — no separate out-of-lock refresh here.
  const mergeTimer =
    mergePollMs > 0
      ? managedSetInterval('hyperbee-merge-poll', mergePollMs, async () => {
          await mergeNow();
        }, { category: 'lifecycle', instanced: true })
      : null;

  // ── Read-admission decider (4c) ── the D-004 + D-002 sig+binding decision
  // applied to an inbound announce. verifyBinding wires the write-free adapter
  // (verifyAttestation over the announce's attestation gist id — gists are
  // public, so no shared-repo context / gh-token is needed). Returns 3-state
  // 'verified'|'pending'|'fail'. Fail-closed: a missing/forged gist admits
  // nothing, so only the own log is merged.
  const admit = makeAdmissionDecider({
    // Reuse the same `verifyBinding` adapter captured above for the re-verify
    // path — one adapter instance shared by admission and re-verify (so the
    // override seam in tests is a single assignment that affects both).
    verifyBinding,
    // D-004: the live revocation set. The decider checks it FIRST (a revoked
    // pubkey is denied regardless of sig/binding), so a revoked peer's
    // re-announce is refused with reason 'revoked'. The set is mutated by
    // `revoke()` below; the decider closes over the same Set instance.
    revoked,
  });

  // D-002 P-001: the same-hive membership lookup (test seam or real resolveHiveMemberDeviceSet).
  // Returns ALL device pubkeys for the hive — no github_user_id (D-002: admit by AUTHOR IDENTITY).
  // Never throws (fail-closed to empty set → not-a-member → buffer).
  const loadHiveMembers: (hiveHomeSlug: string) => Promise<string[]> =
    opts.loadHiveMembersOverride ??
    (async (hiveHomeSlug) => {
      const { resolveHiveMemberDeviceSet } = await import('./hive-member-identity-set');
      const set = await resolveHiveMemberDeviceSet(opts.workspaceId, hiveHomeSlug).catch(
        () => new Set<string>(),
      );
      return [...set];
    });

  // WI-787 / WI-780 — owner-log BOOTSTRAP seam: resolve the OWNER device pubkey the SIGNED,
  // gh-verified hive-announce binds to a joined `hive_pubkey` (`owner_device_pubkey`,
  // captured at join from the verified directory descriptor and persisted on
  // `harness_shared.hives`). Used ONLY by the owner-bootstrap admit in resolveSameHiveMember.
  // Fail-closed to null (no bootstrap) on any error — never throws into the swarm handler.
  const ownerDeviceForHive: (hivePubkey: string) => Promise<string | null> =
    opts.ownerDeviceForHiveOverride ??
    (async (hivePubkey) => {
      const { loadHiveOwnerDevicePubkey } = await import('../../hive-membership-store');
      return loadHiveOwnerDevicePubkey(opts.workspaceId, hivePubkey).catch(() => null);
    });

  // D-053 — owner-bootstrap for a TOPIC-bound joiner. A real invite/link joiner boots on a
  // `{ kind:'topic', topic_hex }` binding (boot-all.ts defaultResolveSwarmBinding step 2: it
  // learns the Hive's TOPIC HASH from the link, NOT its pubkey, so it cannot rebuild a `hive:`
  // binding) — so `opts.swarmBinding.hive_pubkey` is ABSENT and the by-pubkey owner-bootstrap
  // (gated on `kind==='hive'`) never fires, leaving an empty-roster joiner unable to admit the
  // owner (the live cross-machine RECEIVE-side blocker: 0 roster / 0 epoch / 0 content). Recover
  // the bound hive's pubkey from the VERIFIED hive-directory cache by deriving each cached hive's
  // topic and matching `topic_hex`, then return that descriptor's owner device. Same one-device
  // guarantee as `ownerDeviceForHive`; fail-closed to null. The directory only records
  // descriptors that passed `verifyHiveAnnounce`, so the binding is cryptographically verified.
  const ownerDeviceForTopic: (topicHex: string) => Promise<string | null> =
    opts.ownerDeviceForTopicOverride ??
    (async (topicHex) => {
      const want = topicHex.toLowerCase();
      const { loadHiveOwnerDeviceBindings } = await import('../../hive-membership-store');
      const bindings = await loadHiveOwnerDeviceBindings(opts.workspaceId).catch(() => []);
      for (const b of bindings) {
        let derived: string;
        try {
          derived = deriveSwarmTopic({ kind: 'hive', hive_pubkey: b.hivePubkey })
            .toString('hex')
            .toLowerCase();
        } catch {
          continue; // a malformed cached pubkey can't derive a topic — skip it
        }
        if (derived === want) return b.ownerDevicePubkey;
      }
      return null;
    });

  // D-053 — resolve the owner device to bootstrap-admit for the CURRENTLY-JOINED hive,
  // regardless of the binding KIND: a `hive` binding carries the pubkey directly; a `topic`
  // binding (the invite/link joiner) recovers it from the directory cache by topic match. Used
  // by BOTH owner-bootstrap sites (admitsAsKnownHiveMember + resolveSameHiveMember) so they
  // can't drift. Returns null for a non-hive/non-topic binding (no hive to bootstrap).
  const resolveJoinedHiveOwnerDevice = async (): Promise<string | null> => {
    // WI-1544 defect D: read the CURRENT binding (rekey() updates it), not the
    // boot-time opts snapshot — post-rekey the owner lookup must key off the
    // NEW hive/topic or the bootstrap-admit vouches for the wrong hive.
    const binding = currentBinding;
    if (!binding) return null;
    const resolved =
      binding.kind === 'hive'
        ? await ownerDeviceForHive(binding.hive_pubkey).catch(() => null)
        : binding.kind === 'topic'
          ? await ownerDeviceForTopic(binding.topic_hex).catch(() => null)
          : null;
    // A→B owner-admit diagnostic (PAPERCUSP_A003_TRACE, off by default/in tests): did the
    // directory cache resolve the joined hive's owner device? `<null>` here is the live A→B
    // root — the owner-bootstrap admit + the roster member-set both depend on this resolving.
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      // eslint-disable-next-line no-console
      console.error(
        `[A-003] owner-resolve ${opts.harnessSlug}: binding.kind=${binding.kind} ` +
          `${binding.kind === 'hive' ? `hive_pubkey=${binding.hive_pubkey.slice(0, 10)}` : binding.kind === 'topic' ? `topic=${binding.topic_hex.slice(0, 12)}` : ''} ` +
          `→ ownerDevice=${resolved ? resolved.slice(0, 10) : '<null>'}`,
      );
    }
    return resolved;
  };

  /**
   * Admit (or reject) an inbound signed announce. Verifies the sig, runs the
   * D-004 + D-002 decision, and on admit opens + admits the peer's remote log
   * and merges. On 'pending', stores the peer for retry (D-006). Defensive:
   * never throws into the swarm handler.
   */
  // P-004: best-effort telemetry sink for conclusive admission rejections.
  // Defaults to enqueuing a diagnostic report (flushTelemetry forwards it to
  // PostHog when the user has opted in); never awaited and never throws, so it
  // can't add latency to or fail the admission path. Tests inject a capturing
  // override.
  const emitTelemetry: (kind: TelemetryKind, payload: Record<string, unknown>) => void =
    opts.recordTelemetryOverride ??
    ((kind, payload) => {
      void recordTelemetryReport({ kind, payload }).catch(() => {});
    });

  // WI-559: the same-hive cross-member SCOPE decision, SHARED by onAnnounce + retryPendingOnce so
  // the two paths can't drift. Precondition: the IDENTITY decider `admit()` has ALREADY passed for
  // this frame (sig + channel-2 binding valid, NOT revoked — revoked is checked FIRST, every call,
  // incl. each retry tick). This only widens SCOPE (slug → identity-membership); it NEVER bypasses
  // revocation or the read-cut. An out-of-own-scope frame is admitted iff its github_user_id is a
  // member of THIS harness's hive AND its device is one of that member's REGISTERED pubkeys. If we
  // have a hive home but that membership has NOT federated to us yet — the asymmetric A→B stall: B
  // permanently DROPS A's writer core because announces are not re-delivered and B's hive_members
  // lacked A at announce time — BUFFER the frame for retry instead of conclusively rejecting. The
  // 5s retry loop re-runs admit() (revoked re-checked) + this check each tick and admits the instant
  // A federates in, or drops it after the 30-min grace. So a REVOKED / READ-CUT peer can NEVER be
  // admitted via this buffer: admit() refuses it first on every retry, keeping the C-001 read cut
  // intact (shared-hive-rekey). Returns the AdmissionResult to RETURN (admit, or pending-buffered),
  // or null when this is not a same-hive-member candidate (caller falls through to A-003 / conclusive).
  async function resolveSameHiveMember(frame: SignedAnnounce): Promise<AdmissionResult | null> {
    const originSlug = frame.harness_slug ?? null;
    if (!(originSlug != null && originSlug !== slug)) return null;
    const { hiveHomeSlugForHarness } = await import('../../hive-federation');
    const myHiveHome =
      hiveHomeProjectionSlug ??
      (await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug).catch(() => null));
    if (myHiveHome == null) return null;
    // WI-787 / WI-780 — owner-log BOOTSTRAP admission (the keystone). A fresh joiner's
    // hive_members is EMPTY, so the OWNER's own announce 'miss'es below and buffers
    // forever — yet the roster that would admit the owner lives INSIDE the owner's
    // still-un-merged log (bootstrap deadlock). Break it by trusting the ONE device the
    // SIGNED, gh-verified hive-announce binds to THIS joined hive: its owner_device_pubkey.
    // Admit ONLY that exact device, gated on the frame's joined hive
    // (swarmBinding.hive_pubkey) — never on github_user_id alone and never any OTHER device
    // (that would hole the WI-259 membership guard). The IDENTITY decider (sig + channel-2
    // binding) has already passed for this frame upstream, so the device is gh-attested too.
    // D-053: resolve the joined hive's owner device for BOTH binding kinds (a topic-bound
    // invite/link joiner has no `hive_pubkey` — recover it from the directory cache by topic).
    const ownerDevice = await resolveJoinedHiveOwnerDevice();
    if (ownerDevice && frame.device_pubkey === ownerDevice) {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_admitted',
        `owner_bootstrap hive=${myHiveHome} ${peerLabel(frame.log_core_key)}`,
      );
      return admitPeer(frame);
    }
    const memberDevices = await loadHiveMembers(myHiveHome);
    const isKnownMember = memberDevices.includes(frame.device_pubkey);
    // D-023 BUG C owner-gate: on a membership MISS, am I the OWNER of this hive (hold its private
    // key)? The owner must ADMIT a verified brand-new joiner (whose member slug is out of our
    // home-slug scope) instead of buffering it, else admitAnnouncedPeerAsOwner (the upsert seam)
    // never runs and the open-mode auto-admission deadlocks. Resolved ONLY
    // on a miss (skip the keychain read on the common already-a-member path).
    // WI-1981 wake-#5515: canonical ownership (held key MATCHES the hives-row / registry
    // pubkey), not mere key presence — a divergent local key must not make this box
    // admit joiners as if it were the owner.
    const isOwner =
      !isKnownMember &&
      (await import('../../hive-identity')
        .then((m) => m.isCanonicalHiveOwner(opts.workspaceId, myHiveHome))
        .catch(() => false));
    const decision = classifySameHiveMember({
      originSlug,
      ownSlug: slug,
      hiveHome: myHiveHome,
      devicePubkey: frame.device_pubkey,
      memberDevices,
      isOwner,
    });
    if (decision === 'admit') {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_admitted',
        `${isKnownMember ? 'same_hive_member' : 'owner_admit_joiner'} origin=${originSlug} hive=${myHiveHome} ${peerLabel(frame.log_core_key)}`,
      );
      return admitPeer(frame);
    }
    // decision === 'miss' here (the pre-checks above already returned null for 'not-candidate').
    // MEMBERSHIP-MISS (WI-559) — plausible same-hive cross-member whose hive_members row has not
    // federated to us yet → BUFFER for retry instead of a conclusive drop. Idempotent: a no-op when
    // already pending (preserving its grace clock), and the boot event is recorded ONLY on the first
    // buffering so the 5s retry re-checks don't spam the log.
    if (!pendingPeers.has(frame.log_core_key)) {
      pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_pending',
        `membership_miss origin=${originSlug} hive=${myHiveHome} ${peerLabel(frame.log_core_key)}`,
      );
    }
    return { admit: false, reason: 'pending' };
  }

  async function admitsAsKnownHiveMember(
    frame: SignedAnnounce,
    sigValid: boolean,
  ): Promise<boolean> {
    if (!sigValid || revoked.has(frame.device_pubkey)) return false;
    // WI-797 — owner-log BOOTSTRAP at the IDENTITY stage (the keystone's missing half),
    // HOISTED ABOVE the `myHiveHome == null` gate (recv-but-no-admit-during-rekey fix; the
    // live-pinned A→B blocker). A fresh joiner's hive_members is EMPTY, so the OWNER's own
    // announce fails the gist-binding gate (`admit()` → 'binding_invalid' whenever the owner's
    // live attestation gist is unresolvable in the fresh-join window) and is CONCLUSIVELY
    // rejected in `onAnnounce` BEFORE `resolveSameHiveMember`'s owner-bootstrap (which only
    // runs AFTER a positive identity decision) can ever rescue it — the bootstrap deadlock the
    // A1 keystone (WI-787) was supposed to break. Admit the ONE directory-verified owner device
    // of the JOINED hive here, bypassing the gist gate.
    //
    // WHY ABOVE THE GATE: a fresh joiner boots home=<none> (its hive-home SLUG resolves only at
    // the 2c rekey), and the owner's announce arrives in that window. `resolveJoinedHiveOwnerDevice`
    // resolves the owner device from the swarm BINDING (`hive_pubkey` / `topic_hex`) + the seeded
    // directory cache — it does NOT need the resolved hive-home slug — so gating it behind
    // `myHiveHome != null` (the prior bug) DROPPED the owner frame (→ binding_invalid → conclusive
    // reject, NOT buffered), leaving the rekey replay nothing to re-drive → A→B never federated
    // (live-pinned via announce-debug: B RECEIVES A's owner announce but processes it at home=<none>).
    // Running the bootstrap FIRST lets the owner frame pass IDENTITY at home=<none> → the A-003
    // `scope_unresolved` buffer in `onAnnounce` holds it → `retryPendingOnce` (which re-runs THIS
    // fn) admits it once the rekey resolves the home.
    //
    // Identical cryptographic guarantee as the `resolveSameHiveMember` copy — the
    // `(hive_pubkey → owner_device_pubkey)` binding read by `ownerDeviceForHive`/`ownerDeviceForTopic`
    // comes from the offline hive-directory cache, which only records descriptors that passed
    // `verifyHiveAnnounce` (Ed25519 sig + the owner_device↔hive_pubkey binding). Strictly the ONE
    // bound owner device; `sigValid` is already checked above; never widens to github_user_id alone
    // or any other device (that would hole the WI-259 membership guard). D-053: BOTH binding kinds
    // (a topic-bound invite/link joiner has no `hive_pubkey` — recover it from the cache by topic).
    const ownerDevice = await resolveJoinedHiveOwnerDevice();
    // A→B owner-admit diagnostic (PAPERCUSP_A003_TRACE): did the IDENTITY-stage owner-bootstrap
    // fire + match this frame's device? match=true ⇒ B admits the owner log (the keystone);
    // match=false with ownerDevice=<null> ⇒ cache didn't resolve the owner (the live A→B root).
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      // eslint-disable-next-line no-console
      console.error(
        `[A-003] owner-admit ${opts.harnessSlug}: ownerDevice=${ownerDevice ? ownerDevice.slice(0, 10) : '<null>'} ` +
          `frame.device=${frame.device_pubkey.slice(0, 10)} match=${!!(ownerDevice && frame.device_pubkey === ownerDevice)}`,
      );
    }
    if (ownerDevice && frame.device_pubkey === ownerDevice) return true;
    // Member admission (below) needs the resolved hive-home slug — resolve it AFTER the
    // binding-only owner-bootstrap above, so a home=<none> joiner still bootstrap-admits the owner.
    const { hiveHomeSlugForHarness } = await import('../../hive-federation');
    const myHiveHome =
      hiveHomeProjectionSlug ??
      (await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug).catch(() => null));
    if (myHiveHome == null) return false;
    const memberDevices = await loadHiveMembers(myHiveHome);
    return trustedHiveMemberDeviceAdmission({
      devicePubkey: frame.device_pubkey,
      sigValid,
      memberDevices,
      revoked,
    });
  }

  // WI-1544 (round-1 live REJECT) — is this boot still inside its hive-JOIN bootstrap window?
  // True for a JOINER boot (a `hive`/`topic` swarm binding — an invite/link joiner) whose
  // hive-home has NOT yet resolved (home resolves at the 2c rekey's rebind). Inside this
  // window an identity-stage `binding_invalid` is NOT conclusive: the owner's log announce
  // races the hive-directory descriptor + the rekey by milliseconds, so the gist gate can
  // conclusively 'fail' BEFORE the verified owner-device binding (resolveJoinedHiveOwnerDevice)
  // or the federated roster can vouch for the frame — and announces are never re-delivered,
  // so a conclusive reject here is a PERMANENT A→B stall. Live-pinned on the WI-1544
  // Docker-frames rig: recv → owner-resolve=<null> (directory not yet populated) →
  // binding_invalid → dropped; the rekey resolved moments later with nothing left to replay.
  // Buffering instead admits NOTHING by itself: the frame still has to pass
  // admitsAsKnownHiveMember / admit() on a retry tick (revocation re-checked every tick),
  // and BOOT_PENDING_GRACE_MS caps the buffer. bad_sig / revoked stay conclusive always.
  // A standalone (non-joiner) boot never enters this window, keeping conclusive-reject
  // observability for genuinely foreign frames.
  const inJoinBootstrapWindow = (): boolean =>
    hiveHomeProjectionSlug == null &&
    (currentBinding?.kind === 'hive' || currentBinding?.kind === 'topic');

  async function onAnnounce(frame: SignedAnnounce): Promise<AdmissionResult> {
    let decision: AdmissionResult;
    try {
      const verifyResult = verifyAnnounceDetailed(frame);
      const sigValid = verifyResult.ok;
      // WI-1662: a stale_ts rejection means the sig itself is VALID but the sender's
      // clock is >5min off — record this distinctly (alongside the announce_rejected
      // this frame still gets below) so it doesn't read identically to a forged sig.
      if (verifyResult.reason === 'stale_ts') {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_clock_skew',
          `peer clock >5min off this machine — check clock/NTP ${peerLabel(frame.log_core_key)}`,
        );
      }
      const input: AdmissionInput = {
        device_pubkey: frame.device_pubkey,
        github_login: frame.github_login,
        github_user_id: frame.github_user_id,
        attestation_gist_id: frame.attestation_gist_id,
        sigValid,
      };
      decision = (await admitsAsKnownHiveMember(frame, sigValid))
        ? { admit: true }
        : await admit(input);
    } catch (e) {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_error',
        e instanceof Error ? e.message : String(e),
      );
      return { admit: false, reason: 'binding_invalid' };
    }
    if (!decision.admit) {
      // WI-1544: inside the join-bootstrap window a conclusive `binding_invalid` is
      // reclassified as RETRYABLE — buffered for the rekey replay / retry tick (see
      // inJoinBootstrapWindow above). Distinct label so a live grep can tell this buffer
      // from the D-006 gist-propagation 'pending'.
      if (decision.reason === 'binding_invalid' && inJoinBootstrapWindow()) {
        if (!pendingPeers.has(frame.log_core_key)) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_pending',
          `binding_unverified_window ${peerLabel(frame.log_core_key)}`,
        );
        if (process.env.PAPERCUSP_A003_TRACE === '1') {
          // eslint-disable-next-line no-console
          console.error(
            `[A-003] reclassify ${opts.harnessSlug}: binding_invalid → pending (join window, home=<none>) peer=${peerLabel(frame.log_core_key)}`,
          );
        }
        return { admit: false, reason: 'pending' };
      }
      if (decision.reason === 'pending') {
        // D-006: channel-2 file not yet visible on GitHub. Store this peer for
        // retry within the boot grace window; do NOT permanently reject.
        if (!pendingPeers.has(frame.log_core_key)) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_pending',
          peerLabel(frame.log_core_key),
        );
      } else {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `${decision.reason} ${peerLabel(frame.log_core_key)}`,
        );
        // P-004: forward the rejection to the diagnostic-telemetry pipeline
        // (PostHog when opted in) — a fleet-health signal for canonicalisation
        // drift / stale revocation / forgery attempts. Truncated peer label only.
        emitTelemetry(TELEMETRY_KINDS.substrate_admission_rejected, {
          harness_slug: opts.harnessSlug,
          reason: decision.reason,
          peer: peerLabel(frame.log_core_key),
        });
      }
      return decision;
    }
    // A-003 (a′): slug-aware admission scope. The decider above is IDENTITY-only
    // (sig + channel-2 binding + revocation) and every harness registers ALL
    // projections — so on a topic carrying MULTIPLE local harnesses' log announces
    // (dc9db's (a′) swarm.ts: the hive-home log broadcast alongside a member's on
    // the one channel), an identity-valid frame for ANOTHER harness's scope would
    // be admitted + cross-merged (e.g. the OWNER's hive-home harness applying a
    // member-log's features into the hive-home schema = pollution). The frame
    // carries a SIGNED `harness_slug`; admit a remote log ONLY into the harness
    // scope that should hold it: this harness's OWN slug, OR — for a JOINER's
    // member harness — the hive-home slug it rebinds (`hiveHomeProjectionSlug` =
    // joinerHiveHomeSlug(self), the receive-side rebind; live across rekey). ABSENT
    // (legacy / single-harness peer) → admit (backward-compatible: the field
    // post-dates single-harness federation + the two-hive integration test).
    const originSlug = frame.harness_slug ?? null;
    const inScope = announceSlugInScope(originSlug, slug, hiveHomeProjectionSlug);
    // A-003 diagnostic (env-gated): the per-frame slug-filter decision — so a live
    // witness can grep `[A-003] slug-filter` to see whether a joiner's member harness
    // ADMITS the owner's hive-home log (origin=<hive-home> → ADMIT requires
    // home=<hive-home>, i.e. the rebind resolved) or REJECTs it.
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      // eslint-disable-next-line no-console
      console.error(
        `[A-003] slug-filter ${opts.harnessSlug}: origin=${originSlug ?? '<none>'} own=${slug} ` +
          `home=${hiveHomeProjectionSlug ?? '<none>'} → ${inScope ? 'ADMIT' : 'REJECT'} ` +
          `peer=${peerLabel(frame.log_core_key)}`,
      );
    }
    if (!inScope) {
      // WI-259 STEP 1 + WI-559: a SAME-HIVE cross-member log is admitted by VERIFIED IDENTITY
      // (github_user_id ∈ this hive's members AND device registered), even when its signed slug is
      // out of this harness's own/rebind scope — `hive_members` is federated (P-006) where the
      // per-workspace `harness_registry` is not. SAFETY: this only lets the member's LOG replicate;
      // every projection's apply drops a wrong-slug op, so cross-member CONTENT does not land in PG
      // until WI-259 STEP 2 opts it in. Ordered BEFORE the A-003 buffer so a member log is admitted
      // immediately. On a membership-MISS (hive home resolved but not yet federated A in) the helper
      // BUFFERS for retry rather than letting the frame fall through to a conclusive drop (the WI-559
      // asymmetric-stall fix). Shared with retryPendingOnce so the decision can't drift.
      const sameHive = await resolveSameHiveMember(frame);
      if (sameHive) return sameHive;
      // A-003 fix: the slug scope can be UNRESOLVED at admit time. A joiner's member
      // harness only learns its hive-home slug at the 2c re-key (`hiveHomeProjectionSlug`
      // is set by `rekey`'s rebind, AFTER boot opens the topic + onAnnounce goes live).
      // If the owner's hive-home log announce races in during that `home=<none>` window,
      // a CONCLUSIVE out-of-scope reject would drop it permanently (announces are not
      // re-delivered) → the hive-home log never federates (the live-RED bug the witness
      // caught). So: while home is UNRESOLVED and the origin is some OTHER harness's slug
      // (a hive-home candidate that the pending rebind may bring in-scope), buffer the
      // frame for retry instead of rejecting — `retryPendingOnce` re-checks the slug
      // scope against the now-resolved `hiveHomeProjectionSlug` and admits iff in-scope.
      // Once home IS resolved, an out-of-scope frame is genuinely foreign → conclusive.
      if (hiveHomeProjectionSlug == null && originSlug != null && originSlug !== slug) {
        if (!pendingPeers.has(frame.log_core_key)) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_pending',
          `scope_unresolved origin=${originSlug} own=${slug} ${peerLabel(frame.log_core_key)}`,
        );
        return { admit: false, reason: 'pending' };
      }
      // The NORMAL broadcast-filtering outcome (one topic, many harnesses) — not an
      // alarm. Recorded for observability; NOT forwarded to the admission-rejection
      // telemetry (it is not a forgery / binding failure). Conclusive (never retried).
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_rejected',
        `out-of-scope origin=${originSlug} own=${slug} ${peerLabel(frame.log_core_key)}`,
      );
      return { admit: false, reason: 'out_of_scope' };
    }
    return admitPeer(frame);
  }

  /**
   * Queue + admit a peer's remote log and trigger a merge. The map mutations
   * (admitted/pubkeyToLogKey/admittedIdentities) happen inside the merge gate
   * (drainAdmissionQueue) so an in-flight pass never races them, and the
   * coalescing mergeNow guarantees the admission is processed before the
   * returned promise resolves (audit P-022). Extracted so the pending-retry
   * path uses the same logic as the initial admit path.
   */
  async function admitPeer(frame: SignedAnnounce): Promise<AdmissionResult> {
    admissionQueue.push(frame);
    await mergeNow();
    return { admit: true };
  }

  /**
   * Revoke a device pubkey (D-004). Adds it to the `revoked` set (so a future
   * announce is refused), drops its admitted log (so the next merge stops
   * reading it), drops it from the pending-retry set (D-006: a revoked peer
   * must never be retried), and re-merges so the removal takes effect immediately.
   * Best-effort + idempotent: an unknown / already-revoked pubkey still gets
   * added to `revoked` (a no-op for the set) and skips the log drop.
   */
  async function revoke(devicePubkey: string): Promise<void> {
    // (a) Block future admits + re-announces (decider checks `revoked` first).
    revoked.add(devicePubkey);
    // WI-193 (G8): a LIVE revoke is authoritative — evict from the refresh-sourced
    // provenance set (in case this pubkey was ALREADY refresh-tracked) so a later
    // published-list refresh can never silently reconcile this revoke away.
    revokedViaRefresh.delete(devicePubkey);
    // (a2) Drop ALL of this device's buffered logs from the pending-retry set —
    // a revoked peer must never be retried even if its channel-2 file eventually
    // appears.
    purgePendingForDevice(devicePubkey);
    // (b) Drop the already-admitted log for this pubkey, if any.
    const logKey = pubkeyToLogKey.get(devicePubkey);
    if (logKey) {
      admitted.delete(logKey);
      replicationStallState.delete(logKey); // WI-183: drop stale stall-tracking state
      dropReplicationLogState(opts.workspaceId, opts.harnessSlug, logKey); // P-004: liveness registry too
      pubkeyToLogKey.delete(devicePubkey);
      admittedIdentities.delete(logKey);
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'peer_revoked',
        peerLabel(logKey),
      );
    }
    // (c) Re-merge so the merge set no longer includes the revoked log.
    await mergeNow();
  }

  // ── Pending-peer retry loop (D-006) ── revisits peers that returned
  // 'pending' (channel-2 file not yet visible) at each tick. For each pending
  // peer the decider is re-run with a fresh sig check; on 'verified' the peer
  // is admitted normally; on conclusive failure (binding_invalid/bad_sig/revoked)
  // or once the boot-scoped grace window has passed, the peer is removed
  // (announce_rejected). `.unref()`'d so the timer never keeps the process alive
  // and cleared in `close()` alongside the merge timer.
  //
  // RE-ENTRANCY (audit P-022): sequential rescheduling, NOT a bare
  // setInterval(async …) — the old interval could fire a second tick while the
  // first still awaited admit()/admitPeer(), double-processing the same
  // pending peers. The next tick now arms only after the current one finishes.
  const pendingRetryMs = Number.isFinite(opts.pendingRetryMs as number)
    ? (opts.pendingRetryMs as number)
    : DEFAULT_PENDING_RETRY_MS;
  const pendingRetrySetTimeout = opts.pendingRetrySetTimeout ?? setTimeout;
  const pendingRetryClearTimeout = opts.pendingRetryClearTimeout ?? clearTimeout;
  let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // WI-1631: the promise of a CURRENTLY-EXECUTING retry tick, if any. `close()`
  // clearing `pendingRetryTimer` only cancels a still-SCHEDULED timer — a tick
  // that already fired and is mid-`retryPendingOnce()` (e.g. awaiting an
  // openRemoteLog call) keeps running in the background after `close()`
  // resolves, unawaited, and can still hit the tick's own `console.error(...)`
  // calls afterward — racing a caller that restores a `console.error` spy right
  // after `close()` returns (as boot.test.ts's WI-1544 #3 tests do), and
  // tripping vitest-fail-on-console on an already-restored, tracked
  // console.error. `close()` awaits this so no tick can straggle past it.
  let inFlightPendingRetryTick: Promise<void> | null = null;
  // WI-1544: once-per-peer stderr dedup for retry-tick failures (the tick fires
  // every ~5s for up to 30min — one line per peer is signal, 360 are noise).
  const loggedRetryErrorKeys = new Set<string>();
  async function retryPendingOnce(): Promise<void> {
    if (stopped || pendingPeers.size === 0) return;
    const nowMs = Date.now();
    // Snapshot keys to iterate safely while the map mutates.
    const keys = [...pendingPeers.keys()];
    for (const logCoreKey of keys) {
      const entry = pendingPeers.get(logCoreKey);
      if (!entry) continue; // removed between snapshot + loop body
      // Grace-window expiry: remove + reject, don't retry forever.
      if (nowMs - entry.since > BOOT_PENDING_GRACE_MS) {
        pendingPeers.delete(logCoreKey);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `pending_grace_expired ${peerLabel(entry.frame.log_core_key)}`,
        );
        continue;
      }
      // Re-verify: re-build the AdmissionInput from the stored frame.
      // Pass { nowMs: entry.since } so freshness is checked relative to
      // the arrival timestamp, NOT the current wall-clock. The announce
      // was fresh when it arrived (validated in onAnnounce). Re-running
      // freshness against Date.now() would cap the effective retry window
      // at DEFAULT_ANNOUNCE_WINDOW_MS (5 min), defeating the 30-min
      // BOOT_PENDING_GRACE_MS grace window that the pending-retry exists for.
      try {
        const verifyResult = verifyAnnounceDetailed(entry.frame, { nowMs: entry.since });
        const sigValid = verifyResult.ok;
        // WI-1662: same distinct clock-skew signal as onAnnounce, above.
        if (verifyResult.reason === 'stale_ts') {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_clock_skew',
            `peer clock >5min off this machine (pending-retry) — check clock/NTP ${peerLabel(entry.frame.log_core_key)}`,
          );
        }
        const input: AdmissionInput = {
          device_pubkey: entry.frame.device_pubkey,
          github_login: entry.frame.github_login,
          github_user_id: entry.frame.github_user_id,
          attestation_gist_id: entry.frame.attestation_gist_id,
          sigValid,
        };
        const decision = (await admitsAsKnownHiveMember(entry.frame, sigValid))
          ? ({ admit: true } as const)
          : await admit(input);
        if (decision.admit) {
          // A-003 + WI-559: identity is re-verified (admit() above re-checked revocation); now
          // re-resolve SCOPE against the now-current state, in the SAME order as onAnnounce.
          //  (1) slug scope — the joiner's hive-home rebind (`hiveHomeProjectionSlug`) may have
          //      landed since this frame was buffered → admit if now in-scope.
          //  (2) else, the same-hive MEMBERSHIP — A's `hive_members` row may have federated in
          //      since the buffer (the WI-559 asymmetric-stall case). resolveSameHiveMember admits
          //      if A is now a member, re-buffers (idempotent, grace clock preserved) on a still-
          //      missing membership, or returns null when this is not a same-hive candidate.
          //  (3) else (not a same-hive candidate) AND home RESOLVED → genuinely foreign → conclusive
          //      reject; home still unresolved → keep pending for the next tick.
          const originSlug = entry.frame.harness_slug ?? null;
          const inScope = announceSlugInScope(originSlug, slug, hiveHomeProjectionSlug);
          if (inScope) {
            // WI-1544 root cause #3: this used to delete BEFORE the awaited
            // admit — any throw inside the merge-gated drain made the frame a
            // one-shot silent loss (gone from every buffer; announces never
            // re-flow). Admit first; drop the buffer entry only once the log
            // actually landed in `admitted` (a failed drain re-buffers the
            // frame into pendingPeers — an unconditional delete here would
            // erase that re-buffered entry).
            await admitPeer(entry.frame);
            if (admitted.has(logCoreKey)) pendingPeers.delete(logCoreKey);
          } else {
            const sameHive = await resolveSameHiveMember(entry.frame);
            if (sameHive?.admit) {
              // resolveSameHiveMember admitted it (called admitPeer) → stop
              // retrying — but only once the log actually landed in `admitted`
              // (WI-1544: a failed drain re-buffers; delete only on success).
              if (admitted.has(logCoreKey)) pendingPeers.delete(logCoreKey);
            } else if (sameHive && sameHive.reason === 'pending') {
              // membership still not federated → leave pending (it re-buffered idempotently).
            } else if (hiveHomeProjectionSlug != null) {
              // not a same-hive candidate AND home resolved → genuinely foreign → conclusive.
              pendingPeers.delete(logCoreKey);
              recordBootEvent(
                opts.workspaceId,
                opts.harnessSlug,
                'announce_rejected',
                `out-of-scope origin=${originSlug} own=${slug} ${peerLabel(entry.frame.log_core_key)}`,
              );
            }
            // else: home still unresolved → leave pending for the next retry tick.
          }
        } else if (
          decision.reason !== 'pending' &&
          // WI-1544: a `binding_invalid` re-check inside the join-bootstrap window is NOT
          // conclusive (same rule as onAnnounce) — leave it pending for the rekey replay.
          !(decision.reason === 'binding_invalid' && inJoinBootstrapWindow())
        ) {
          // Conclusive failure (binding_invalid / bad_sig / revoked) —
          // stop retrying.
          pendingPeers.delete(logCoreKey);
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_rejected',
            `${decision.reason} ${peerLabel(entry.frame.log_core_key)}`,
          );
        }
        // If still 'pending', leave in the map for the next tick.
      } catch (e) {
        // Defensive: a tick failure never kills the retry chain — but it is
        // NOT silent anymore (WI-1544: a silently-swallowed retry error looks
        // identical to "still pending" and can hide a permanent stall). Ring
        // every time; stderr once per peer.
        const msg = e instanceof Error ? e.message : String(e);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `pending-retry ${peerLabel(entry.frame.log_core_key)}: ${msg}`,
        );
        if (!loggedRetryErrorKeys.has(logCoreKey)) {
          loggedRetryErrorKeys.add(logCoreKey);
          // eslint-disable-next-line no-console
          console.error(
            `[hyperbee-admission] pending-retry failed for ${peerLabel(entry.frame.log_core_key)} (kept pending; will retry until grace expiry): ${msg}`,
          );
        }
      }
    }
  }
  function armPendingRetry(): void {
    if (pendingRetryMs <= 0 || stopped) return;
    // The callback stays `async` (its returned promise resolves only once the
    // whole tick — including the re-arm — is done) so a caller that awaits
    // what `pendingRetrySetTimeout` schedules (the real setTimeout ignores
    // the return value; test doubles like admission-pending-retry.test.ts's
    // capturePendingRetryTimer().run() explicitly `await cb()`) keeps seeing
    // the exact same synchronization it always has. `inFlightPendingRetryTick`
    // is set synchronously, before this callback's first await, purely so
    // close() (running from a DIFFERENT call stack, e.g. concurrently with an
    // already-fired real timer tick) can also find and await it — see close().
    const timer = pendingRetrySetTimeout(async () => {
      const tick = (async () => {
        try {
          await retryPendingOnce();
        } catch {
          // Defensive: a tick failure must never kill the retry chain.
        } finally {
          armPendingRetry(); // arm the NEXT tick only after this one finished
        }
      })();
      inFlightPendingRetryTick = tick;
      try {
        await tick;
      } finally {
        if (inFlightPendingRetryTick === tick) inFlightPendingRetryTick = null;
      }
    }, pendingRetryMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    pendingRetryTimer = timer;
  }
  armPendingRetry();

  // ── Hyperswarm replication + announce exchange (4b) ──
  // Joins the swarm topic; the connection handler replicates the corestore
  // AND opens the `papercusp/announce` channel — sending OUR signed announce
  // and routing inbound announces to `onAnnounce` (admit → open remote log →
  // merge). Only fires for harnesses that pass swarmBinding; `state: private`
  // harnesses (no binding) stay local-only. Defensive: swarm join / identity
  // resolution failures don't fail the boot — the harness still works as a
  // single-peer substrate.
  let swarmHandle: SwarmHandle | null = null;
  // ── P-006 scoped-log federation state (P-108). The REGISTRY is boot-scoped
  // (own/admitted scoped cores survive a rekey — the store stays open); the
  // COORDINATOR is rebuilt per joinForBinding because it binds the resolved
  // announce identity + signer. `participatingScopes` is the durable declared
  // set so a rekey re-applies it to the fresh coordinator.
  let scopeRegistry: ScopeCoreRegistry | null = null;
  let scopeFederation: ScopeFederation | null = null;
  const participatingScopes = new Map<string, ScopeId>();

  /**
   * The swarm-facing announce hook: base admission first, then — for an
   * ADMITTED frame on a connection that supplied `ctx` — the scoped-log flow
   * (§5.3 serve gate → §5.2 disclosed-core admission → loop-damped directed
   * follow-up). Fire-and-forget: scoped handling never blocks or fails base
   * admission, and an unverified/rejected/pending frame NEVER reaches the
   * scoped layer (frame.github_user_id is only trustworthy once admitted).
   */
  async function onAnnounceWithConnection(
    frame: SignedAnnounce,
    ctx?: AnnounceConnectionContext,
  ): Promise<AdmissionResult> {
    const decision = await onAnnounce(frame);
    if (decision.admit && ctx && scopeFederation) {
      void scopeFederation.onPeerAnnounce(frame, ctx).catch(() => {});
    }
    return decision;
  }

  async function resolveKnownHiveMemberAnnounceIdentityForBinding(
    binding: SwarmBinding,
  ): Promise<LocalAnnounceIdentity | null> {
    if (binding.kind !== 'hive') return null;
    const { hiveHomeSlugForHarness } = await import('../../hive-federation');
    const hiveHomeSlug =
      hiveHomeProjectionSlug ??
      (await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug).catch(() => null));
    if (!hiveHomeSlug) return null;
    const { listHiveMembers } = await import('../../hive-membership-store');
    const members = await listHiveMembers(opts.workspaceId, hiveHomeSlug).catch(() => []);
    return resolveLocalAnnounceIdentityFromHiveMembers({ members });
  }

  // Join (or RE-KEY to) the swarm topic derived from `binding`, using THIS
  // boot's LIVE store + own log + onAnnounce. Extracted so `rekey()` can re-run
  // it against a NEW binding WITHOUT tearing down the store / open cores /
  // replication streams / merge loop. EI-681: a full reboot (close + boot)
  // disrupts the OWNER's corestore replication-SERVING of its own log core — the
  // re-keyed owner admits the joiner + connects but never UPLOADS its log, so
  // the feature never crosses. Re-keying in place leaves the replication streams
  // intact, so serving continues seamlessly onto the new topic.
  async function joinForBinding(binding: SwarmBinding): Promise<void> {
    try {
      const swarm = opts.swarmOverride ?? (await getSharedSwarm());
      const topic = deriveSwarmTopic(binding);
      // Build OUR announce: bind our log core to our device identity. For Hive
      // topics, prefer the durable local hive_members+keychain binding so a
      // known member can rejoin during a GitHub outage; fall back to live GitHub
      // identity resolution for first-time/non-Hive announces. Throws (→ caught
      // below) when neither path can resolve, keeping the harness local-only
      // rather than joining without an announce.
      const knownHiveIdentity = opts.announceIdentityOverride
        ? null
        : await resolveKnownHiveMemberAnnounceIdentityForBinding(binding);
      const identity = knownHiveIdentity ?? (await resolveLocalAnnounceIdentity({
        // Spread the test override FIRST so boot's own `logCoreKeyHex` always
        // wins (the announce must bind THIS peer's actual log core).
        ...(opts.announceIdentityOverride?.resolveOpts ?? {}),
        logCoreKeyHex: ownLog.keyHex,
      }));
      // The signer defaults to the keychain-backed `signWithDeviceKey`; tests
      // inject a signer over a self-generated keypair so no OS keychain is
      // touched (see `announceIdentityOverride`).
      const signAnnounce =
        opts.announceIdentityOverride?.sign ?? signWithDeviceKey;
      // WI-559 issue-2 — FRESH-ANNOUNCE-PER-CONNECTION. The announce BODY is static (this peer's
      // device identity + log core + signed origin slug); only `ts`+`sig` change per build. A single
      // frozen-`ts` frame built ONCE at boot is rejected by the peer's `verifyAnnounce` the moment it
      // is >5min old (DEFAULT_ANNOUNCE_WINDOW_MS) — so EVERY post-window / post-reconnect / post-reboot
      // connection sent a STALE announce → the peer admitted nothing → both sides stuck on own-only
      // admitted sets (the WI-559 stale-peering root cause, distinct from the membership-miss path).
      // So pass a FACTORY that re-stamps (current ts) + re-signs per connection; `ourAnnounce` (the
      // initial build) seeds the static log_core_key (swarm entry key) + the first send.
      const announceBody = {
        device_pubkey: identity.devicePubkeyBase64,
        github_user_id: identity.githubUserId,
        github_login: identity.githubLogin,
        attestation_gist_id: identity.attestationGistId,
        log_core_key: ownLog.keyHex,
        // A-003 (a′): the SIGNED origin-harness slug. When multiple local harnesses share one hive
        // topic (the hive-home log alongside a member's — dc9db's swarm.ts broadcasts each on the
        // single channel), the peer's onAnnounce slug-filter uses this to admit a log only into the
        // harness scope that should hold it. Absent on legacy peers → the filter treats absent as admit.
        harness_slug: opts.harnessSlug,
      };
      const signOurAnnounce = (bytes: Buffer) => signAnnounce(identity.keychainId, bytes);
      const buildOurAnnounce = () => buildAnnounce(announceBody, signOurAnnounce);
      const ourAnnounce = await buildOurAnnounce();
      // ── P-006 scoped-log federation coordinator (P-108). Best-effort: a
      // failure here leaves the scoped layer off (null) without failing the
      // join — base federation is independent of it. The scoped store is a
      // SEPARATE corestore that is NEVER passed to store.replicate (the §5.3
      // fail-closed premise); the roster/epoch reads federate under the hive
      // home slug when one is bound (grants/epochs live there), else our own.
      try {
        const scopedStore = await getHarnessScopedStore(storeOpts);
        if (!scopeRegistry) {
          // Narrowed at the boundary (scope-cores.ts convention): Corestore
          // sessions structurally satisfy ScopedSessionLike.
          scopeRegistry = new ScopeCoreRegistry(scopedStore as unknown as ScopedStoreLike);
        }
        const rosterHiveSlug = hiveHomeProjectionSlug ?? opts.harnessSlug;
        // P-101: the fleet directory widens the scope roster from owner-only to
        // owner ∪ publisher-set, and seeds this peer's participating scopes from
        // its directory records (owner or publisher of a live fleet ⇒ participant).
        const fleetDirectory = new PgFleetDirectory({
          workspaceId: opts.workspaceId,
          hiveSlug: rosterHiveSlug,
        });
        scopeFederation = new ScopeFederation({
          registry: scopeRegistry,
          roster: getScopeRoster({
            workspaceId: opts.workspaceId,
            hiveSlug: rosterHiveSlug,
            directory: fleetDirectory,
          }),
          selfGithubUserId: identity.githubUserId,
          buildScopedAnnounce: (scopedLogs) =>
            buildAnnounce({ ...announceBody, scoped_logs: scopedLogs }, signOurAnnounce),
          // M15/D-004: every refused scoped entry is a visible counter + boot
          // event, never a silent drop. Best-effort (PG may be unavailable in
          // rigs); the boot event is the always-on local witness.
          onRefusal: (r) => {
            const reason =
              r.kind === 'inbound-announce'
                ? `scoped-announce:${r.refusal.reason}`
                : `scoped-${r.kind}:${r.refusal.reason}`;
            recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_rejected', reason);
            void bumpRefusedOpCounter({
              workspaceId: opts.workspaceId,
              hiveSlug: rosterHiveSlug,
              reason,
            }).catch(() => {});
          },
        });
        // P-101 driver: union the directory-derived participation (fleets this
        // identity owns or publishes to) into the durable declared set. Best-
        // effort — a PG/directory failure leaves explicit declarations intact.
        const directoryScopes = await fleetDirectory
          .listParticipatingScopes(identity.githubUserId)
          .catch(() => [] as ScopeId[]);
        for (const s of directoryScopes) participatingScopes.set(formatScopeId(s), s);
        if (participatingScopes.size > 0) {
          await scopeFederation.ensureOwnScopes([...participatingScopes.values()]);
        }
      } catch (e) {
        scopeFederation = null;
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `scoped-log layer unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // SUBSTRATE_SIDECAR Option B (WI-604): build the replication-offload seam.
      // A test override wins; else, when the OFF-by-default flag is ON, route each
      // accepted peer socket to the sidecar via offloadReplicationToSidecar.
      // undefined (flag OFF + no override) ⇒ joinHarnessSwarm replicates in-process,
      // byte-identical to today.
      const offloadReplication:
        | ((socket: unknown, peerInfo?: unknown) => boolean)
        | undefined =
        opts.sidecarOffloadOverride ??
        (sidecarOffloadEnabled
          ? (socket: unknown) =>
              offloadReplicationToSidecar(socket, {
                workspaceId: opts.workspaceId,
                harnessSlug: opts.harnessSlug,
                workspaceRoot: opts.workspaceRoot,
                onResult: (r) => {
                  recordBootEvent(
                    opts.workspaceId,
                    opts.harnessSlug,
                    r.ok ? 'peer_connected' : 'swarm_join_failed',
                    r.ok
                      ? `sidecar-replicating conn=${r.connectionId ?? '?'}`
                      : `sidecar handoff failed: ${r.error ?? 'unknown'}`,
                  );
                },
              })
          : undefined);
      swarmHandle = await joinHarnessSwarm({
        store,
        topic,
        swarm,
        ourAnnounce,
        buildOurAnnounce,
        onAnnounce: onAnnounceWithConnection,
        offloadReplication,
        // WI-752 / FED-2: forward the self-heal re-peer cadence (defaults applied
        // inside joinHarnessSwarm when these are undefined).
        refreshMs: opts.swarmRefreshMs,
        fastWindowMs: opts.swarmFastWindowMs,
        slowRefreshMs: opts.swarmSlowRefreshMs,
        onPeerConnected: (keyHex) => {
          recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_connected');
          // eslint-disable-next-line no-console
          console.info(
            `[swarm] peer_connected harness=${opts.harnessSlug}` +
              (keyHex ? ` peer=${keyHex.slice(0, 12)}…` : ''),
          );
        },
        onPeerRejected: (keyHex, ip) => {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_rejected',
            peerLabel(keyHex, ip),
          );
        },
        onPeerRateLimited: (keyHex, ip) => {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_rate_limited',
            peerLabel(keyHex, ip),
          );
        },
        // P-008 (harden-shared-hive-to-256-peers): turn P-004's process-global
        // near-cap signal into a DURABLE, queryable boot-event. Hyperswarm
        // SILENTLY stops accepting once maxPeers is reached (peer N+1 never
        // connects, no error) — recording it makes approaching/hitting the 256
        // ceiling VISIBLE: the remedy is raising PAPERCUSP_SWARM_MAX_PEERS /
        // scaling the box, or (past 256 active) the trigger to un-defer the
        // relay/sharding re-architecture.
        onNearPeerCap: (info) => {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_cap_near',
            `${info.liveConnections}/${info.maxPeers} swarm peer connections` +
              (info.atCap
                ? ' — AT CAP: new peers are being silently refused; raise PAPERCUSP_SWARM_MAX_PEERS or scale the box'
                : ' — approaching the peer cap'),
          );
        },
      });
      // eslint-disable-next-line no-console
      console.info(
        `[swarm] joined topic ${topic.toString('hex').slice(0, 16)}… ` +
          `harness=${opts.harnessSlug} (announcing as github_user_id=${identity.githubUserId})`,
      );
    } catch (e) {
      // Swarm join failed (DHT unreachable / port blocked / gh-auth or keychain
      // can't resolve the announce identity / etc). Record + continue — local
      // writes still work. ALSO log to stderr: a silently-local-only harness is
      // a real federation regression that was previously invisible (only landed
      // in in-memory boot-history), which masked packaged two-instance debugging.
      const msg = e instanceof Error ? e.message : String(e);
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'swarm_join_failed', msg);
      // eslint-disable-next-line no-console
      console.warn(`[swarm] join FAILED harness=${opts.harnessSlug} — staying local-only: ${msg}`);
    }
  }

  if (currentBinding) {
    await joinForBinding(currentBinding);
  }

  // ── WI-752 / FED-2 JOIN-retry self-heal ──
  // The join above is one-shot. When it FAILED (swarmHandle stayed null — DHT
  // not ready, a gh-identity / keychain blip, a transient fault) the harness is
  // local-only and, pre-WI-752, would stay so until an operator RESTART. Retry
  // it on a bounded exponential backoff (sequential self-rearming setTimeout,
  // P-022 pattern) until it joins; back off to the cap on a persistent failure
  // so it never hammers, and stop the instant it succeeds. `unref()`'d; cleared
  // in close() (with `stopped` guarding a mid-tick re-arm).
  const swarmJoinRetryBaseMs = Number.isFinite(opts.swarmJoinRetryMs as number)
    ? (opts.swarmJoinRetryMs as number)
    : DEFAULT_SWARM_JOIN_RETRY_MS;
  let swarmJoinRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let swarmJoinRetryDelay = swarmJoinRetryBaseMs;
  function armSwarmJoinRetry(): void {
    if (swarmJoinRetryBaseMs <= 0 || stopped) return;
    if (swarmHandle !== null || !currentBinding) return; // already federating / nothing to join
    swarmJoinRetryTimer = setTimeout(async () => {
      swarmJoinRetryTimer = null;
      if (stopped || swarmHandle !== null || !currentBinding) return;
      // joinForBinding swallows its own errors (records swarm_join_failed); it
      // sets swarmHandle on success. WI-1544 defect D: join the CURRENT binding —
      // a retry firing inside a rekey's swarmHandle=null window must join the
      // NEW topic, never re-join the boot-time one from the opts snapshot.
      await joinForBinding(currentBinding);
      if (swarmHandle !== null) {
        // eslint-disable-next-line no-console
        console.info(
          `[swarm] join RECOVERED via retry harness=${opts.harnessSlug} — federation re-established without a restart`,
        );
        return; // joined — stop retrying
      }
      swarmJoinRetryDelay = Math.min(swarmJoinRetryDelay * 2, SWARM_JOIN_RETRY_CAP_MS);
      armSwarmJoinRetry();
    }, swarmJoinRetryDelay);
    if (typeof (swarmJoinRetryTimer as { unref?: () => void }).unref === 'function') {
      (swarmJoinRetryTimer as { unref: () => void }).unref();
    }
  }
  if (currentBinding && swarmHandle === null) {
    armSwarmJoinRetry();
  }

  recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_ok');

  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    store,
    ownLog,
    async append(op: LocalWriteOp): Promise<void> {
      // P-010 SEND seam: stamp a causal HLC on every federated write so
      // `lwwPick` orders cross-peer conflicts by HLC, not bare wall-clock `ts`.
      // A pre-set `op.hlc` is preserved. This is the single choke point every
      // LWW producer funnels through (the CDC drain + the log-first queue /
      // working-set / contributor / presence helpers all call `handle.append`);
      // the append-only claim path uses the raw `ownLog.append` and correctly
      // carries no HLC (claims are distinct-key per attempt, never LWW).
      const stamped = stampOpHlc(op, opts.hlcClock);
      await ownLog.append({
        type: stamped.type,
        table: stamped.table,
        hbKey: stamped.hbKey,
        value: stamped.value,
        ts: stamped.ts,
        schema_version: stamped.schema_version,
        hlc: stamped.hlc,
        // STAGE-5: thread the real device pubkey. Until then attribute to
        // the write's clobber pubkey (or empty), which the merge tolerates.
        author_pubkey: stamped.writerPubkey ?? '',
        // WI-808: carry the epoch stamp onto the WIRE op. The outbox drain's
        // EpochEncryptCapability sets `op.epoch` (+ encrypts `value`) for selected
        // hive-content ops; without this the stamp was dropped here, so the
        // receiver's decrypt-gate saw `epoch == null` and silently dropped every
        // encrypted content op. Absent on plaintext ops (json omits undefined).
        epoch: stamped.epoch,
      });
    },
    admitted,
    mergeNow,
    onAnnounce: onAnnounceWithConnection,
    async ensureScopeParticipation(scopes: readonly ScopeId[]): Promise<void> {
      for (const s of scopes) participatingScopes.set(formatScopeId(s), s);
      if (scopeFederation) await scopeFederation.ensureOwnScopes(scopes);
    },
    async rediscloseScopes(): Promise<void> {
      await scopeFederation?.redisclose();
    },
    get scopeFederation(): ScopeFederation | null {
      return scopeFederation;
    },
    onAdmitted(listener) {
      admittedListeners.add(listener);
      return () => {
        admittedListeners.delete(listener);
      };
    },
    revoke,
    reverifyAdmitted,
    // A live getter (not a snapshot): `rekey()` reassigns the inner
    // `swarmHandle`, so callers must observe the CURRENT topic, not the one
    // captured at boot return.
    get swarm(): SwarmHandle | null {
      return swarmHandle;
    },
    async rekey(binding: SwarmBinding): Promise<void> {
      // EI-681: re-key onto a NEW swarm topic IN PLACE — leave the old topic and
      // join the new one while keeping the store + own log + admitted set + merge
      // loop ALIVE. A full reboot (close + boot) disrupted the OWNER's corestore
      // replication-serving of its own log core (it admitted + connected to the
      // joiner but never UPLOADED its log → the feature never crossed). Re-keying
      // in place never tears down the replication streams, so serving continues.
      if (stopped) return;
      // WI-1544 defect D: publish the new binding FIRST so every reader
      // (owner resolve, bootstrap window, the swarm-join retry) sees the
      // rekey target throughout the close→rejoin window below.
      currentBinding = binding;
      const previous = swarmHandle;
      swarmHandle = null;
      if (previous) {
        try {
          await previous.close();
        } catch {
          // leaving the old topic is best-effort; the new join is what matters
        }
      }
      // A-003 (a′): re-resolve the joiner hive-home scope + rebind the two hive
      // projections BEFORE joining the new topic. A FIRST join re-keys this member
      // onto the Hive topic AFTER join-hive.ts stamps hive_slug + the remote_hive
      // home view (2/2b precede the 2c re-key), so the home is now resolvable.
      // ORDER MATTERS (A-003 live-RED root cause): `joinForBinding` opens the topic
      // and its onAnnounce begins admitting inbound frames — including the OWNER's
      // hive-home log announce. The onAnnounce slug-filter reads `hiveHomeProjection
      // Slug`; if we joined FIRST, A's hive-home announce could race in with the home
      // still UNRESOLVED → the slug-filter rejects it (and announces are not
      // re-delivered) → the hive-home log never federates to the joiner. The
      // resolution depends only on `binding` (+ the registry), never on the join, so
      // doing it first is safe. An `applyOverride` (the rigs) is never rebuilt — the
      // rig owns its apply. The next merge pass reads the new scopedApply
      // (mergeOnePass re-evaluates `applyImpl` each pass).
      if (!opts.applyOverride) {
        const next = await resolveHiveHomeProjectionSlug(binding);
        if (process.env.PAPERCUSP_A003_TRACE === '1') {
          // eslint-disable-next-line no-console
          console.error(
            `[A-003] rekey ${opts.harnessSlug}: binding.kind=${binding?.kind ?? '<none>'} next=${next ?? '<none>'} prev=${hiveHomeProjectionSlug ?? '<none>'} rebind=${next !== hiveHomeProjectionSlug}`,
          );
        }
        if (next !== hiveHomeProjectionSlug) {
          hiveHomeProjectionSlug = next;
          scopedApply = buildScopedApply(next);
          // ── Re-key GATE LIFECYCLE (su-c2a63, Gate 3) ── A mid-session join resolves the
          // hive-home (home <none> → the hive-home slug), making THIS harness a hive member
          // NOW. The boot-time buildHiveRekeyBootDeps returned null (not yet a hive), so without
          // this rebuild the member keeps applyImpl=enforcedApply (NO decrypt gate) until a
          // reboot → flag-on it would project raw __rekey ciphertext as content (garbage).
          // Rebuild beside the scopedApply rebind (the proven A-003 in-place path): `next` is
          // now the resolved hive-home, so buildHiveRekeyBootDeps builds the gate + a fresh
          // PendingEpochContent. Flag-dark (off ⇒ null ⇒ byte-for-byte). The next merge pass
          // re-reads rekeyDeps (applyImpl@mergeOpts + the per-pass drain), so it takes effect
          // with no reboot. NOTE: this rebind block runs on EVERY home-resolving rekey,
          // including the sameTopic in-place path (which skips only close+rejoin) — so a
          // same-topic first-join still rebuilds the gate. This is the witness's B path (a
          // mid-session joiner): without it K1 (B reads F-CTRL) can't pass.
          rekeyDeps = await buildHiveRekeyBootDeps({
            workspaceId: opts.workspaceId,
            harnessSlug: opts.harnessSlug,
          });
          registerAllHarnessProjections({
            workspaceId: opts.workspaceId,
            harnessSlug: opts.harnessSlug,
            hiveHomeSlug: next,
            // Re-wire the drain hook onto the re-registered hive_epoch_keys projection (shared
            // boot-scope epochDrainQueue via recordEpochDrain) when the re-key is now active.
            ...(rekeyDeps ? { onEpochKeyApplied: recordEpochDrain } : {}),
            // WI-259 P-004: keep the content-before-membership buffer wired on the joiner rebind
            // (a mid-session join makes this harness a hive member — content may now defer/drain).
            pendingMemberContent,
          });
          // A-003 apply-side determinism: the hive_members/hive_settings projections just
          // rebound from the member slug to the hive-home slug. An owner log admitted +
          // folded during the prior home=<none> window applied its hive_members op against
          // the OLD (member-slug) binding → it was dropped → empty roster → A's content
          // defers forever. Force the next merge pass to re-fold all admitted logs through
          // the NEW binding so that op re-applies and lands. Driven by the mergeNow() below.
          forceReFold = true;
        }
      } else if (process.env.PAPERCUSP_A003_TRACE === '1') {
        // eslint-disable-next-line no-console
        console.error(`[A-003] rekey ${opts.harnessSlug}: SKIPPED (applyOverride present)`);
      }
      await joinForBinding(binding);
      // A-003 fix (c) — replay-on-rebind. The rekey is the exact moment
      // `hiveHomeProjectionSlug` becomes known (a first join re-keys the member onto
      // the Hive topic only AFTER join-hive stamps hive_slug + the remote_hive home).
      // The owner's hive-home log announce that raced in during the `home=<none>`
      // boot window was BUFFERED (not rejected) by onAnnounce as `scope_unresolved`.
      // Re-drive the pending set NOW, against the freshly-resolved home, so that
      // hive-home log is admitted at the rebind instant — rather than waiting up to
      // `pendingRetryMs` (5s) for the periodic tick. That timer latency was the
      // residual live-RED window: the content-matrix / from-repo witness samples
      // hive_settings/hive_members within seconds of join, before the tick admits the
      // log. Idempotent + re-entrancy-safe (retryPendingOnce no-ops on an empty set;
      // mergeNow serializes internally), so racing the periodic tick is harmless.
      await retryPendingOnce();
      // A-003 apply-side determinism (su-81f2e): drive the re-fold requested by the
      // rebind block above. retryPendingOnce only re-ADMITS still-pending peers — but
      // the live A→B failure is an owner log that was ALREADY admitted (bootstrap-admit
      // at home=<none>) and folded BEFORE the rebind, so its hive_members op dropped
      // against the member-slug binding and the cursor marked it done. This mergeNow
      // consumes forceReFold (set on rebind) → resets the cursor → re-folds every admitted
      // log through the now-hive-home-bound scopedApply → A's roster row re-applies →
      // hive-members.ts drains the deferred member content → A's content lands. Idempotent
      // (LWW upserts), one-shot (flag cleared under the gate), coalesces with the periodic
      // merge. This is the deterministic replacement for the scheduling-dependent behaviour
      // that PAPERCUSP_A003_TRACE's stderr delay accidentally flipped green (run31 vs run32).
      await mergeNow();
    },
    registerCloseHook(hook: () => void | Promise<void>): () => void {
      closeHooks.add(hook);
      return () => {
        closeHooks.delete(hook);
      };
    },
    async close() {
      stopped = true;
      // P-004 (WI-1840): drop this harness's replication-liveness tracking so a
      // closed handle never reads as 'sampling_stale' on a status surface.
      try {
        dropReplicationLiveness(opts.workspaceId, opts.harnessSlug);
      } catch {
        /* best-effort */
      }
      // Run teardown hooks (e.g. the Stage-5 outbox drain stopper) FIRST, before
      // the store/swarm tear down — a drain mid-flight should stop appending to
      // an about-to-close store. Best-effort: a throwing hook is logged, not
      // fatal, and each hook runs once (the Set is drained as we go).
      const hooks = [...closeHooks];
      closeHooks.clear();
      for (const hook of hooks) {
        try {
          await hook();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            `[boot.close] close-hook failed for ${opts.workspaceId}::${opts.harnessSlug}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      // Stop the progress poller first so it doesn't read ownLog.length on
      // an about-to-close store.
      progressPoller.stop();
      // Stop the merge poller + pending-retry timer before the store closes
      // (a get() against a closing store throws; mergeNow bails on `stopped`,
      // but clear cleanly).
      if (mergeTimer) {
        try {
          mergeTimer.stop();
        } catch {
          // no-op
        }
      }
      if (pendingRetryTimer) {
        try {
          // The retry loop is a self-rearming setTimeout chain (P-022);
          // `stopped` (set above) prevents a mid-tick re-arm.
          pendingRetryClearTimeout(pendingRetryTimer);
        } catch {
          // no-op
        }
      }
      // WI-1631: clearTimeout above only cancels a still-SCHEDULED tick — a
      // tick that already FIRED and is mid-flight (e.g. awaiting
      // openRemoteLog inside retryPendingOnce) is NOT cancelled and keeps
      // running after close() would otherwise resolve. Await it here so any
      // console.error / side effect it still produces happens before close()
      // returns, not stragglingly after (the race a caller that restores a
      // console.error spy right after close() — e.g. a test's cleanup stack —
      // would otherwise lose to).
      if (inFlightPendingRetryTick) {
        try {
          await inFlightPendingRetryTick;
        } catch {
          // no-op — the tick's own catch already handled/logged its error.
        }
      }
      if (swarmJoinRetryTimer) {
        try {
          // WI-752 join-retry — same self-rearming-chain shape; `stopped`
          // (set above) prevents a mid-tick re-arm.
          clearTimeout(swarmJoinRetryTimer);
        } catch {
          // no-op
        }
      }
      // Leave the swarm before tearing down the store so we stop receiving
      // peer replication onto an about-to-close corestore.
      if (swarmHandle) {
        try { await swarmHandle.close(); } catch {}
      }
      // Close via closeHarnessStore (NOT a bare store.close()) so the closed
      // Corestore is EVICTED from the getHarnessStore cache — a bare close would
      // leave the dead instance cached and trip "Corestore is closed" on the next
      // boot. (A re-key never reaches here: rekeyHarness/handle.rekey leave the
      // old topic + join the new one WITHOUT closing the store — see boot-all.ts.)
      try { await closeHarnessStore(storeOpts); } catch {}
      // P-006: the scoped store is a separate Corestore instance — close +
      // evict it the same way (it was only opened if a swarm join ran).
      try { await closeHarnessScopedStore(storeOpts); } catch {}
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'close');
    },
  };
}

/**
 * Subscribe to the substrate's schema-version alerts. Returns an
 * unsubscribe function. The UI surfaces these as "newer Papercusp
 * available" toasts per D-024.
 */
export function onSchemaVersionAlert(handler: (alert: SchemaVersionAlert) => void): () => void {
  schemaVersionEvents.on('alert', handler);
  return () => { schemaVersionEvents.off('alert', handler); };
}
