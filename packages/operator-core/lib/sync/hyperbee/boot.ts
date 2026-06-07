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

import { getHarnessStore, type HarnessStoreOpts } from './corestore';
import { openOwnLog, openRemoteLog, type OwnLog, type PeerLogOp } from './peer-log';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  DEFAULT_GET_TIMEOUT_MS,
  type AdmittedLog,
} from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import { acceptOpVersion, type SchemaVersionAlert } from './schema-version';
import { schemaVersionEvents } from './schema-version';
import { loadRevokedPubkeys } from './load-revoked-pubkeys';
import {
  registerAllHarnessProjections,
  buildHarnessProjectionApply,
} from './projections/register-all';
import { startBootstrapProgressPoller } from './bootstrap-progress-poller';
import { recordBootEvent } from './boot-history';
import type Corestore from 'corestore';
import {
  deriveSwarmTopic,
  type SwarmBinding,
} from './derive-swarm-topic';
import {
  joinHarnessSwarm,
  getSharedSwarm,
  type HyperswarmLike,
  type SwarmHandle,
} from './swarm';
import {
  buildAnnounce,
  verifyAnnounce,
  type SignedAnnounce,
} from './announce';
import {
  makeAdmissionDecider,
  type AdmissionInput,
  type AdmissionResult,
} from './read-admission';
import {
  resolveLocalAnnounceIdentity,
  type ResolveLocalAnnounceIdentityOpts,
} from './local-announce-identity';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { recordTelemetryReport } from '../../record-telemetry';
import { TELEMETRY_KINDS, type TelemetryKind } from '../../telemetry-kinds';

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
   * Slow re-verify interval (ms). At this cadence, every admitted peer's
   * channel-2 binding is re-checked via `verifyBinding`. A conclusive `'fail'`
   * drops the peer from the admitted set (but does NOT add it to the published
   * `revoked` blocklist — a deleted GitHub branch may be re-published later;
   * normal admission re-admits it if the binding returns). `'pending'` / a thrown
   * error keeps the peer (fail-open per D-004).
   *
   * The re-verify runs INSIDE `mergeNow` under the `merging` lock, throttled so
   * it only actually fires at most once per `reverifyIntervalMs` — this avoids
   * racing a concurrent merge mutating `admitted` without a separate lock.
   *
   * Channel-2 reads hit the GitHub API; keep this cadence slow (default
   * 15 min). With small dogfood peer counts this is negligible load; at scale
   * consider staggering per-peer calls (a comment in `reverifyAdmitted` notes
   * this).
   *
   * Set to `0` to disable the automatic throttle-in-mergeNow trigger entirely
   * (tests drive `reverifyAdmitted()` by hand via the handle). Default 15 min.
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
   * triggers a merge.
   */
  onAnnounce(frame: SignedAnnounce): Promise<AdmissionResult>;
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
   * Re-verify all admitted peers' channel-2 bindings (rev-v2 Component A).
   * Exposed for testing so `reverifyIntervalMs: 0` tests can drive it by hand.
   *
   * For each admitted peer EXCEPT the own log, calls `verifyBinding` with the
   * peer's recorded `{devicePubkey, githubLogin, githubUserId}`:
   *   - `'fail'` (conclusive) → drops the peer from `admitted` +
   *     `admittedIdentities` (does NOT add to the published `revoked` set —
   *     a GitHub-deleted binding may be re-published; normal admission re-admits
   *     if it returns). Records a `peer_revoked` boot-history event noting
   *     channel-2 revocation.
   *   - `'pending'` / thrown error → keeps the peer (fail-open per D-004).
   *
   * IMPORTANT: callers MUST hold the `merging` flag or otherwise guarantee
   * single-threaded access to `admitted` while this runs. The
   * throttled-in-mergeNow path guarantees this; direct test calls should use
   * `reverifyIntervalMs: 0` and drive this while no concurrent merge is running.
   */
  reverifyAdmitted(): Promise<void>;
  /** Swarm handle. Null when this boot didn't join a swarm
   *  (private harness OR swarmBinding omitted). */
  swarm: SwarmHandle | null;
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
   *  poller + Corestore. */
  close(): Promise<void>;
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

  // Wire the per-table PG projection writers into the GLOBAL registry too —
  // some non-Model-B callers (CLI introspection, single-harness contexts) still
  // read the global registry via `applyHyperbeeOpToPg`. Idempotent (re-running
  // overwrites by tableTag).
  registerAllHarnessProjections({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
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
  const scopedApply =
    opts.applyOverride ??
    buildHarnessProjectionApply({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      ownLogKeyHex: ownLog.keyHex,
    });

  // ── Admitted-set ── keyHex → log. Seeded with the own log (which is
  // structurally an AdmittedLog). Remote logs are added on admit (4b).
  const admitted = new Map<string, AdmittedLog>();
  admitted.set(ownLog.keyHex, ownLog);

  // ── Revocation (D-004) ── the only blocklist. `revoked` holds device pubkeys
  // (base64) the read-admission decider refuses; `pubkeyToLogKey` records the
  // device_pubkey → log_core_key mapping at admit time so `revoke()` can find
  // and drop the corresponding admitted log. `admitted` is keyed by
  // `log_core_key`, but a revoke names a `device_pubkey`, so the mapping is the
  // bridge between the two.
  const revoked = new Set<string>();
  const pubkeyToLogKey = new Map<string, string>();

  // ── Per-admitted-peer identity store (rev-v2 Component A) ── populated at
  // admit time from the SignedAnnounce frame so `reverifyAdmitted()` can
  // re-call `verifyBinding(devicePubkey, githubLogin, githubUserId, gistId)`
  // without the original frame. Keyed by `log_core_key` (same key as `admitted`).
  // Cleaned up in every drop path: `revoke()`, `applyRevocationRefresh()`, and
  // the attestation re-verify drop inside `reverifyAdmitted()`.
  const admittedIdentities = new Map<
    string,
    { devicePubkey: string; githubLogin: string; githubUserId: number; attestationGistId: string }
  >();

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
    (() => loadRevokedPubkeys({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug }));
  try {
    const seeded = await loadRevoked();
    for (const pk of seeded) revoked.add(pk);
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
  // propagated yet. Stored as device_pubkey → {frame, since}. The retry timer
  // re-runs admission for each pending peer; on 'verified' the peer is admitted
  // normally; on conclusive failure or grace-window expiry the peer is removed
  // without admit. Revocation also drops a peer from this set.
  const pendingPeers = new Map<string, { frame: SignedAnnounce; since: number }>();

  // ── Revocation refresh helper (D-002) ── load the current published revoked set
  // from PG (via `loadRevoked`) and union any NEW pubkeys into `revoked`. For each
  // newly-added pubkey that is CURRENTLY admitted, apply the same drop steps
  // `revoke()` uses. Fail-open: a load failure is caught by the caller.
  // IMPORTANT: callers MUST hold the `merging` flag or otherwise guarantee
  // single-threaded access to `admitted` / `pendingPeers` while this runs.
  async function applyRevocationRefresh(): Promise<void> {
    const refreshed = await loadRevoked();
    for (const pk of refreshed) {
      if (!revoked.has(pk)) {
        // New revocation discovered from PG.
        revoked.add(pk);
        // Drop from the pending-retry set — a revoked peer must never be retried.
        pendingPeers.delete(pk);
        // If the peer is currently admitted, drop its log.
        const logKey = pubkeyToLogKey.get(pk);
        if (logKey) {
          admitted.delete(logKey);
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
  }

  // ── Channel-2 re-verify for admitted peers (rev-v2 Component A) ──
  //
  // Design: throttled inside mergeNow under the `merging` lock (mirrors
  // rev-v1's applyRevocationRefresh pattern). This avoids a separate timer
  // racing a concurrent merge mutating `admitted`. The slow cadence is enforced
  // by `lastReverifyAt` — mergeNow calls `maybeReverifyAdmitted()` every pass,
  // but the actual per-peer GitHub calls only fire when >= reverifyIntervalMs has
  // elapsed since the last run.
  //
  // Re-admit path: a channel-2-fail drop does NOT add the pubkey to the published
  // `revoked` set. A GitHub-deleted binding is a GitHub-side revocation, not a
  // permanent blocklist entry — if the binding is re-published the peer can
  // re-announce and be admitted through normal admission. This differs from
  // revoke() (which adds to `revoked` so a re-announce is permanently refused)
  // and is intentional: let normal admission re-verify rather than blocklisting.
  //
  // Scaling note: with N admitted peers each `reverifyAdmitted()` pass makes N
  // GitHub API calls. For small dogfood peer counts (< ~20) at 15 min cadence
  // this is negligible. At larger scale, consider staggering calls across passes
  // (e.g. pick one peer per pass in round-robin) to spread the GitHub API load.
  // That optimisation is deferred to a later component.

  /** Timestamp of the last successful `reverifyAdmitted` run (ms). 0 = never. */
  let lastReverifyAt = 0;

  const DEFAULT_REVERIFY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  const reverifyIntervalMs = Number.isFinite(opts.reverifyIntervalMs as number)
    ? (opts.reverifyIntervalMs as number)
    : DEFAULT_REVERIFY_INTERVAL_MS;

  // The `verifyBinding` function used for re-verification: the same one wired
  // into the admission decider (verifyBindingOverride in tests; real adapter in
  // production). Captured here as a stable reference.
  const verifyBinding = opts.verifyBindingOverride ?? buildVerifyBindingAdapter();

  /**
   * Re-verify every admitted peer's channel-2 binding. Drops peers whose
   * binding returns a conclusive `'fail'`. Keeps peers on `'pending'` or
   * thrown error (fail-open per D-004). Does NOT add dropped peers to the
   * published `revoked` set — a channel-2 drop is a GitHub-side removal, not
   * a permanent blocklist (normal admission re-admits if the binding returns).
   *
   * MUST be called while holding the `merging` flag (or when no merge is
   * running) — it mutates `admitted` / `admittedIdentities` / `pubkeyToLogKey`
   * synchronously after each await, the same way `applyRevocationRefresh` does.
   */
  async function reverifyAdmitted(): Promise<void> {
    // Snapshot the log keys to iterate safely while the map mutates.
    const logKeys = [...admitted.keys()];
    for (const logKey of logKeys) {
      // Never re-verify the own log (can't revoke yourself via GitHub-side removal).
      if (logKey === ownLog.keyHex) continue;

      const identity = admittedIdentities.get(logKey);
      if (!identity) continue; // own log or peer admitted before identity tracking

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
        // Conclusive channel-2 revocation: drop from admitted set.
        // Do NOT add to `revoked` — this is a GitHub-side deletion, not a
        // permanent self-revocation. The peer can re-announce and be re-admitted
        // if the binding is re-published.
        admitted.delete(logKey);
        admittedIdentities.delete(logKey);
        // Clean up the pubkey→logKey reverse mapping.
        if (identity.devicePubkey) {
          pubkeyToLogKey.delete(identity.devicePubkey);
        }
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'peer_revoked',
          `channel-2 revoked ${peerLabel(logKey)}`,
        );
      }
      // 'pending' or 'verified': keep the peer (fail-open; only conclusive fail drops).
    }
  }

  /**
   * Run `reverifyAdmitted()` if the slow cadence has elapsed. Intended to be
   * called inside `mergeNow` under the `merging` lock. A no-op when
   * `reverifyIntervalMs <= 0` (disabled — tests drive it directly via the
   * handle).
   */
  async function maybeReverifyAdmitted(): Promise<void> {
    if (reverifyIntervalMs <= 0) return;
    const now = Date.now();
    if (now - lastReverifyAt < reverifyIntervalMs) return;
    lastReverifyAt = now;
    await reverifyAdmitted();
  }

  // ── Read-merge driver ── replaces the old Autobase read-loop. A pass:
  //   1. update() every REMOTE log first (the spike found remote `length`
  //      is stale until update() — own log is always current so skip it).
  //   2. version-gate each log (drop unknown-newer ops, D-024).
  //   3. mergeAdmittedLogs → LWW → existing projection writers → PG.
  // Serialized via `merging` so the poll + on-admit + initial passes don't
  // race a half-applied merge.
  let merging = false;
  let stopped = false;
  // Teardown hooks (Stage 5 outbox drain stopper, etc.) run once on close().
  const closeHooks = new Set<() => void | Promise<void>>();
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
  async function mergeNow(): Promise<number> {
    if (merging || stopped) return 0;
    merging = true;
    try {
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
        await applyRevocationRefresh();
        await maybeReverifyAdmitted();
        return 0;
      }

      const { applied } = await mergeAdmittedLogsIncremental(logs, mergeCursor, {
        // D-021: route through THIS harness's scoped projection apply, not the
        // global registry (which the last-booted harness would own).
        applyImpl: scopedApply,
        // The old per-author cap, reshaped: a per-PASS read budget. A log with
        // more backlog than this advances chunk-by-chunk across the 1Hz poll
        // (≈50k ops/sec/log ingest ceiling) instead of losing its tail (EI-91).
        maxOpsPerPass: MAX_OPS_PER_AUTHOR,
        // Surface standing backlog in boot-history (best-effort observability).
        onBacklog: (keyHex, position, length) => {
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
      });

      // ── Merge-refresh (D-002): ALWAYS run inside the serialized merge block
      // (merging=true) so it cannot race a concurrent merge pass. This collapses
      // the former test/production asymmetry: the refresh now runs under the lock
      // on every mergeNow() call regardless of whether an override is in use.
      // `applyRevocationRefresh` calls `loadRevoked` (which may call the real PG
      // loader in production) then synchronously drops any newly-revoked peers from
      // admitted/pubkeyToLogKey/pendingPeers — no re-entrancy into mergeNow.
      // (A peer it drops vanishes from `admitted`; the cursor-reset check at the
      // top of the NEXT pass sees the removal and re-folds without it.)
      await applyRevocationRefresh();

      // ── Channel-2 re-verify (rev-v2 Component A): run inside the same
      // serialized merge block so it cannot race a concurrent merge mutating
      // `admitted`. `maybeReverifyAdmitted` is a no-op when:
      //   (a) reverifyIntervalMs <= 0 (disabled; tests drive reverifyAdmitted directly), or
      //   (b) the slow cadence hasn't elapsed since the last run.
      // When it does fire, it re-checks every admitted peer's channel-2 binding
      // via verifyBinding, dropping any whose binding conclusively fails. Kept
      // under the merging lock for the same reason applyRevocationRefresh is.
      await maybeReverifyAdmitted();

      return applied;
    } catch (e) {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'merge_error',
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    } finally {
      merging = false;
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
      ? setInterval(async () => {
          await mergeNow();
        }, mergePollMs)
      : null;
  if (mergeTimer && typeof (mergeTimer as { unref?: () => void }).unref === 'function') {
    (mergeTimer as { unref: () => void }).unref();
  }

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

  async function onAnnounce(frame: SignedAnnounce): Promise<AdmissionResult> {
    let decision: AdmissionResult;
    try {
      const sigValid = verifyAnnounce(frame);
      const input: AdmissionInput = {
        device_pubkey: frame.device_pubkey,
        github_login: frame.github_login,
        github_user_id: frame.github_user_id,
        attestation_gist_id: frame.attestation_gist_id,
        sigValid,
      };
      decision = await admit(input);
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
      if (decision.reason === 'pending') {
        // D-006: channel-2 file not yet visible on GitHub. Store this peer for
        // retry within the boot grace window; do NOT permanently reject.
        if (!pendingPeers.has(frame.device_pubkey)) {
          pendingPeers.set(frame.device_pubkey, { frame, since: Date.now() });
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
    return admitPeer(frame);
  }

  /**
   * Open + admit a peer's remote log and trigger a merge. Extracted so the
   * pending-retry path can use the same logic as the initial admit path.
   */
  async function admitPeer(frame: SignedAnnounce): Promise<AdmissionResult> {
    try {
      // Record device_pubkey → log_core_key so `revoke(devicePubkey)` can find
      // and drop the right admitted log (admitted is keyed by log_core_key).
      pubkeyToLogKey.set(frame.device_pubkey, frame.log_core_key);
      // Record the full identity for this admitted peer so `reverifyAdmitted()`
      // can re-call verifyBinding without needing the original frame (rev-v2 A).
      admittedIdentities.set(frame.log_core_key, {
        devicePubkey: frame.device_pubkey,
        githubLogin: frame.github_login,
        githubUserId: frame.github_user_id,
        attestationGistId: frame.attestation_gist_id,
      });
      if (!admitted.has(frame.log_core_key)) {
        const remote = await openRemoteLog(store, frame.log_core_key);
        admitted.set(frame.log_core_key, remote);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_admitted',
          peerLabel(frame.log_core_key),
        );
      }
      await mergeNow();
    } catch (e) {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_error',
        e instanceof Error ? e.message : String(e),
      );
    }
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
    // (a2) Drop from the pending-retry set — a revoked peer must never be
    // retried even if its channel-2 file eventually appears.
    pendingPeers.delete(devicePubkey);
    // (b) Drop the already-admitted log for this pubkey, if any.
    const logKey = pubkeyToLogKey.get(devicePubkey);
    if (logKey) {
      admitted.delete(logKey);
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

  // ── Pending-peer retry timer (D-006) ── revisits peers that returned
  // 'pending' (channel-2 file not yet visible) at each tick. For each pending
  // peer the decider is re-run with a fresh sig check; on 'verified' the peer
  // is admitted normally; on conclusive failure (binding_invalid/bad_sig/revoked)
  // or once the boot-scoped grace window has passed, the peer is removed
  // (announce_rejected). `.unref()`'d so the timer never keeps the process alive
  // and cleared in `close()` alongside the merge timer.
  const pendingRetryMs = Number.isFinite(opts.pendingRetryMs as number)
    ? (opts.pendingRetryMs as number)
    : DEFAULT_PENDING_RETRY_MS;
  const pendingRetryTimer =
    pendingRetryMs > 0
      ? setInterval(async () => {
          if (stopped || pendingPeers.size === 0) return;
          const nowMs = Date.now();
          // Snapshot keys to iterate safely while the map mutates.
          const keys = [...pendingPeers.keys()];
          for (const devicePubkey of keys) {
            const entry = pendingPeers.get(devicePubkey);
            if (!entry) continue; // removed between snapshot + loop body
            // Grace-window expiry: remove + reject, don't retry forever.
            if (nowMs - entry.since > BOOT_PENDING_GRACE_MS) {
              pendingPeers.delete(devicePubkey);
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
              const sigValid = verifyAnnounce(entry.frame, { nowMs: entry.since });
              const input: AdmissionInput = {
                device_pubkey: entry.frame.device_pubkey,
                github_login: entry.frame.github_login,
                github_user_id: entry.frame.github_user_id,
                attestation_gist_id: entry.frame.attestation_gist_id,
                sigValid,
              };
              const decision = await admit(input);
              if (decision.admit) {
                // Verified! Remove from pending + admit.
                pendingPeers.delete(devicePubkey);
                await admitPeer(entry.frame);
              } else if (decision.reason !== 'pending') {
                // Conclusive failure (binding_invalid / bad_sig / revoked) —
                // stop retrying.
                pendingPeers.delete(devicePubkey);
                recordBootEvent(
                  opts.workspaceId,
                  opts.harnessSlug,
                  'announce_rejected',
                  `${decision.reason} ${peerLabel(entry.frame.log_core_key)}`,
                );
              }
              // If still 'pending', leave in the map for the next tick.
            } catch {
              // Defensive: retry errors are silent (observability stays non-fatal).
            }
          }
        }, pendingRetryMs)
      : null;
  if (
    pendingRetryTimer &&
    typeof (pendingRetryTimer as { unref?: () => void }).unref === 'function'
  ) {
    (pendingRetryTimer as { unref: () => void }).unref();
  }

  // ── Hyperswarm replication + announce exchange (4b) ──
  // Joins the swarm topic; the connection handler replicates the corestore
  // AND opens the `papercusp/announce` channel — sending OUR signed announce
  // and routing inbound announces to `onAnnounce` (admit → open remote log →
  // merge). Only fires for harnesses that pass swarmBinding; `state: private`
  // harnesses (no binding) stay local-only. Defensive: swarm join / identity
  // resolution failures don't fail the boot — the harness still works as a
  // single-peer substrate.
  let swarmHandle: SwarmHandle | null = null;
  if (opts.swarmBinding) {
    try {
      const swarm = opts.swarmOverride ?? (await getSharedSwarm());
      const topic = deriveSwarmTopic(opts.swarmBinding);
      // Build OUR announce: bind our log core to our device identity. Throws
      // (→ caught below) when gh-auth / keychain can't resolve, keeping the
      // harness local-only rather than joining without an announce.
      const identity = await resolveLocalAnnounceIdentity({
        // Spread the test override FIRST so boot's own `logCoreKeyHex` always
        // wins (the announce must bind THIS peer's actual log core).
        ...(opts.announceIdentityOverride?.resolveOpts ?? {}),
        logCoreKeyHex: ownLog.keyHex,
      });
      // The signer defaults to the keychain-backed `signWithDeviceKey`; tests
      // inject a signer over a self-generated keypair so no OS keychain is
      // touched (see `announceIdentityOverride`).
      const signAnnounce =
        opts.announceIdentityOverride?.sign ?? signWithDeviceKey;
      const ourAnnounce = await buildAnnounce(
        {
          device_pubkey: identity.devicePubkeyBase64,
          github_user_id: identity.githubUserId,
          github_login: identity.githubLogin,
          attestation_gist_id: identity.attestationGistId,
          log_core_key: ownLog.keyHex,
        },
        (bytes) => signAnnounce(identity.keychainId, bytes),
      );
      swarmHandle = await joinHarnessSwarm({
        store,
        topic,
        swarm,
        ourAnnounce,
        onAnnounce,
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

  recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_ok');

  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    store,
    ownLog,
    async append(op: LocalWriteOp): Promise<void> {
      await ownLog.append({
        type: op.type,
        table: op.table,
        hbKey: op.hbKey,
        value: op.value,
        ts: op.ts,
        schema_version: op.schema_version,
        // STAGE-5: thread the real device pubkey. Until then attribute to
        // the write's clobber pubkey (or empty), which the merge tolerates.
        author_pubkey: op.writerPubkey ?? '',
      });
    },
    admitted,
    mergeNow,
    onAnnounce,
    revoke,
    reverifyAdmitted,
    swarm: swarmHandle,
    registerCloseHook(hook: () => void | Promise<void>): () => void {
      closeHooks.add(hook);
      return () => {
        closeHooks.delete(hook);
      };
    },
    async close() {
      stopped = true;
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
          clearInterval(mergeTimer);
        } catch {
          // no-op
        }
      }
      if (pendingRetryTimer) {
        try {
          clearInterval(pendingRetryTimer);
        } catch {
          // no-op
        }
      }
      // Leave the swarm before tearing down the store so we stop receiving
      // peer replication onto an about-to-close corestore.
      if (swarmHandle) {
        try { await swarmHandle.close(); } catch {}
      }
      try { await store.close(); } catch {}
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
