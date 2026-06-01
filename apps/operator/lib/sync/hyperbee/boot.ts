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
  mergeAdmittedLogs,
  type AdmittedLog,
} from './read-merge';
import { acceptOpVersion, type SchemaVersionAlert } from './schema-version';
import { schemaVersionEvents } from './schema-version';
import { registerAllHarnessProjections } from './projections/register-all';
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
import { resolveLocalAnnounceIdentity } from './local-announce-identity';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import { signWithDeviceKey } from '@/lib/identity/sign-with-device-key';

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
// Stage 6 (DoS Phase-4 reshape): cap how many ops the merge ingests from any
// single author per pass. A noisy/Sybil peer bloats only its OWN log, so this
// bounds per-pass ingest rather than mitigating a shared-structure flood.
const MAX_OPS_PER_AUTHOR = 50_000;

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
   * this undefined and the real `buildVerifyBindingAdapter` (verifyBoth over
   * the local harness's shared.json + gh-token) is used. Tests inject a pure
   * predicate so `onAnnounce` admit/reject can be exercised without network.
   */
  verifyBindingOverride?: (
    devicePubkeyBase64: string,
    githubLogin: string,
    githubUserId: number,
  ) => Promise<boolean>;
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
  /** Swarm handle. Null when this boot didn't join a swarm
   *  (private harness OR swarmBinding omitted). */
  swarm: SwarmHandle | null;
  /** Cleanup. Idempotent. Tears down swarm + merge poller + Corestore. */
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

  // Wire the 8 per-table PG projection writers. Idempotent (re-running
  // overwrites by tableTag).
  registerAllHarnessProjections({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
  });

  // ── Admitted-set ── keyHex → log. Seeded with the own log (which is
  // structurally an AdmittedLog). Remote logs are added on admit (4b).
  const admitted = new Map<string, AdmittedLog>();
  admitted.set(ownLog.keyHex, ownLog);

  // ── Read-merge driver ── replaces the old Autobase read-loop. A pass:
  //   1. update() every REMOTE log first (the spike found remote `length`
  //      is stale until update() — own log is always current so skip it).
  //   2. version-gate each log (drop unknown-newer ops, D-024).
  //   3. mergeAdmittedLogs → LWW → existing projection writers → PG.
  // Serialized via `merging` so the poll + on-admit + initial passes don't
  // race a half-applied merge.
  let merging = false;
  let stopped = false;
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
              await maybeRemote.update();
            } catch {
              // A remote that can't refresh (peer offline / stream closed)
              // is merged at its last-known length; the next pass retries.
            }
          }
        }
        logs.push(versionGatedLog(slug, log));
      }
      return await mergeAdmittedLogs(logs, {
        maxOpsPerAuthor: MAX_OPS_PER_AUTHOR,
        // Surface a capped author in boot-history (best-effort observability).
        onCapped: (keyHex, total, cap) => {
          try {
            recordBootEvent(
              opts.workspaceId,
              opts.harnessSlug,
              'peer_capped',
              `${keyHex.slice(0, 8)} capped ${cap}/${total}`,
            );
          } catch {
            // observability must never abort the merge pass
          }
        },
      });
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
  const mergeTimer =
    mergePollMs > 0 ? setInterval(() => void mergeNow(), mergePollMs) : null;
  if (mergeTimer && typeof (mergeTimer as { unref?: () => void }).unref === 'function') {
    (mergeTimer as { unref: () => void }).unref();
  }

  // ── Read-admission decider (4c) ── the D-004 sig+binding decision applied to
  // an inbound announce. verifyBinding wires verifyBoth over the LOCAL harness's
  // {repoOwner, repoName, token} (resolved from shared.json + gh-token, cached).
  // Fail-closed: a private harness / no-gh-auth context admits nothing, so only
  // the own log is merged. Admits only on status === 'verified'.
  const admit = makeAdmissionDecider({
    verifyBinding:
      opts.verifyBindingOverride ??
      buildVerifyBindingAdapter({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        workspaceRoot: opts.workspaceRoot,
      }),
  });

  /**
   * Admit (or reject) an inbound signed announce. Verifies the sig, runs the
   * D-004 decision, and on admit opens + admits the peer's remote log and
   * merges. Defensive: never throws into the swarm handler.
   */
  async function onAnnounce(frame: SignedAnnounce): Promise<AdmissionResult> {
    let decision: AdmissionResult;
    try {
      const sigValid = verifyAnnounce(frame);
      const input: AdmissionInput = {
        device_pubkey: frame.device_pubkey,
        github_login: frame.github_login,
        github_user_id: frame.github_user_id,
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
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_rejected',
        `${decision.reason} ${peerLabel(frame.log_core_key)}`,
      );
      return decision;
    }
    // Admitted: open the remote log + add to the admitted-set + merge.
    try {
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
    return decision;
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
        logCoreKeyHex: ownLog.keyHex,
      });
      const ourAnnounce = await buildAnnounce(
        {
          device_pubkey: identity.devicePubkeyBase64,
          github_user_id: identity.githubUserId,
          github_login: identity.githubLogin,
          log_core_key: ownLog.keyHex,
        },
        (bytes) => signWithDeviceKey(identity.keychainId, bytes),
      );
      swarmHandle = await joinHarnessSwarm({
        store,
        topic,
        swarm,
        ourAnnounce,
        onAnnounce,
        onPeerConnected: () => {
          recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_connected');
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
    } catch (e) {
      // Swarm join failed (DHT unreachable / port blocked / etc).
      // Record + continue — local writes still work.
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'swarm_join_failed',
        e instanceof Error ? e.message : String(e),
      );
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
    swarm: swarmHandle,
    async close() {
      stopped = true;
      // Stop the progress poller first so it doesn't read ownLog.length on
      // an about-to-close store.
      progressPoller.stop();
      // Stop the merge poller before the store closes (a get() against a
      // closing store throws; mergeNow bails on `stopped`, but clear cleanly).
      if (mergeTimer) {
        try {
          clearInterval(mergeTimer);
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
