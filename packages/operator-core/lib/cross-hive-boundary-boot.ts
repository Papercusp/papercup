/**
 * cross-hive-boundary-boot — the BOOT call-site that finally lights the
 * cross-Hive boundary in the shipped product (hive-network-surface-2026-06-11
 * P-001, brief B-01; the deferred follow-on of cross-hive-boundary-2026-06-08
 * P-006).
 *
 * The boundary composition (`wireCrossHiveBoundary`) shipped Hetzner-proven but
 * DORMANT — nothing ever invoked it at boot, so no production Hive was ever
 * reachable. This module owns the production policy + lifecycle around it:
 *
 *   WHO   — every directory-PUBLISHED Hive (visibility public/invite, the same
 *           owner share-intent gate hive-federation.ts uses). A private Hive
 *           stays dark: no transport, no topic join, zero DHT footprint.
 *   WHEN  — boot (boot-all, per workspace, fire-and-forget) + every
 *           `system:cross-hive-outbox-drain` routine tick (the reconcile that
 *           makes publish/unpublish/visibility changes converge without a
 *           restart).
 *   DRAIN — each wired Hive's durable PG outbox (mig 196) is drained on wire
 *           (boot), per routine tick (periodic), and on a peer's HELLO
 *           (reconnect) — see cross-hive-outbox-drain.ts for the per-peer
 *           backoff policy.
 *
 * Idempotent at every level: re-ensuring an already-wired Hive is a no-op; a
 * Hive republished with unchanged visibility is a no-op; a Hive flipped to
 * private (or unpublished) is CLOSED on the next ensure. Everything is
 * best-effort — a boundary failure must NEVER break harness boot (same posture
 * as hive-directory-boot.ts, which this module deliberately mirrors).
 *
 * Seam note (brief B-01): this module owns the call-site COMPOSITION only —
 * transports, outboxes, ports are constructed here and INJECTED into
 * `wireCrossHiveBoundary`; cross-hive-wiring.ts internals belong to B-03.
 */
import type { Sql } from 'postgres';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import {
  wireCrossHiveBoundary,
  type CrossHiveBoundaryWiring,
  type WireCrossHiveBoundaryDeps,
} from './cross-hive-wiring';
import { makeSwarmCrossHiveTransport } from './cross-hive-swarm-transport';
import type { CrossHiveOutbox, CrossHiveTransport } from './cross-hive-transport';
import { PgCrossHiveOutbox } from './cross-hive-outbox-pg';
import {
  drainCrossHiveOutboxOnce,
  type DrainableOutbox,
  type DrainOutcome,
} from './cross-hive-outbox-drain';
import {
  registerCrossHiveBoundary,
  unregisterCrossHiveBoundary,
  __clearCrossHiveBoundaryRegistry,
} from './cross-hive-boundary-registry';
import type { HiveDirectoryMeta } from './hive-publish';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** One wired (workspace, hive) boundary + the ports its drain needs. */
export interface WiredCrossHiveBoundary {
  workspaceId: string;
  hiveSlug: string;
  /** This Hive's Ed25519 identity pubkey (the dial address peers use). */
  hivePubkey: string;
  wiring: CrossHiveBoundaryWiring;
  /** One backoff-aware drain pass over this Hive's durable outbox. */
  drain(opts?: {
    forcePeers?: Iterable<string>;
    nowMs?: number;
    baseMs?: number;
    capMs?: number;
  }): Promise<DrainOutcome>;
}

const _wired = new Map<string, WiredCrossHiveBoundary>();
const _inflight = new Map<string, Promise<EnsureCrossHiveBoundariesResult>>();

function key(workspaceId: string, hiveSlug: string): string {
  return `${workspaceId}::${hiveSlug}`;
}

export interface EnsureCrossHiveBoundariesOpts {
  /** Owned-hive metadata source. Default: listOwnedHiveMeta(workspaceId). */
  listHives?: (workspaceId: string) => Promise<HiveDirectoryMeta[]>;
  /** Hive identity pubkey loader. Default: loadHivePubkey (keychain/hives). */
  loadPubkey?: (workspaceId: string, hiveSlug: string) => Promise<string | null>;
  /** The shared process swarm. Default getSharedSwarm() (lazy — only fetched
   *  when a hive actually needs a live transport). */
  swarm?: HyperswarmLike;
  /** Transport factory (tests inject a fake mesh). Default: the live
   *  makeSwarmCrossHiveTransport over `swarm`. */
  makeTransport?: (o: {
    hiveSlug: string;
    selfHivePubkey: string;
    onPeerHello: (peerPubkey: string) => void;
  }) => CrossHiveTransport;
  /** Outbox factory. Default: PgCrossHiveOutbox(ws, hiveSlug). */
  makeOutbox?: (workspaceId: string, hiveSlug: string) => CrossHiveOutbox & DrainableOutbox;
  /** Extra deps threaded VERBATIM into wireCrossHiveBoundary (test seams:
   *  requestPorts, loadGrants, signer, sql). Never set in production. */
  wireDeps?: Partial<WireCrossHiveBoundaryDeps>;
  /** Run a drain pass right after wiring (the boot trigger). Default true;
   *  fire-and-forget (a drain dials peers — boot must not wait on it). */
  drainOnWire?: boolean;
  /** Optional test PG client for the default outbox. */
  sql?: Sql;
}

export interface EnsureCrossHiveBoundariesResult {
  /** Hives newly wired this call. */
  wired: string[];
  /** Hives already wired (republish/no-op). */
  alreadyWired: string[];
  /** Hives torn down (now private / unpublished). */
  closed: string[];
  /** Published hives skipped (no identity pubkey / wire failure). */
  skipped: string[];
}

/**
 * Reconcile the live cross-Hive boundaries for a workspace against its
 * directory-publish state: wire every published (public/invite) Hive not yet
 * wired, tear down every wired Hive that is no longer published. Safe to call
 * repeatedly (boot, every drain tick, after a publish/visibility change);
 * concurrent calls for the same workspace coalesce.
 */
export async function ensureCrossHiveBoundariesWired(
  workspaceId: string,
  opts: EnsureCrossHiveBoundariesOpts = {},
): Promise<EnsureCrossHiveBoundariesResult> {
  const existing = _inflight.get(workspaceId);
  if (existing) return existing;
  const p = reconcileWorkspace(workspaceId, opts).finally(() => _inflight.delete(workspaceId));
  _inflight.set(workspaceId, p);
  return p;
}

async function reconcileWorkspace(
  workspaceId: string,
  opts: EnsureCrossHiveBoundariesOpts,
): Promise<EnsureCrossHiveBoundariesResult> {
  const out: EnsureCrossHiveBoundariesResult = { wired: [], alreadyWired: [], closed: [], skipped: [] };

  let metas: HiveDirectoryMeta[] = [];
  try {
    metas = opts.listHives
      ? await opts.listHives(workspaceId)
      : await (await import('./hive-directory-meta')).listOwnedHiveMeta(workspaceId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cross-hive-boot] owned-hive listing failed for workspace ${workspaceId} — leaving boundaries as-is: ` +
        `${e instanceof Error ? e.message : e}`,
    );
    return out;
  }

  const published = metas.filter((m) => m.visibility !== 'private');
  const publishedSlugs = new Set(published.map((m) => m.hiveId));

  // 1. Tear down boundaries whose Hive is no longer published — private Hives
  //    stay (go) dark. Close errors are non-fatal; the entry is gone either way.
  for (const entry of [..._wired.values()]) {
    if (entry.workspaceId !== workspaceId || publishedSlugs.has(entry.hiveSlug)) continue;
    _wired.delete(key(workspaceId, entry.hiveSlug));
    unregisterCrossHiveBoundary(workspaceId, entry.hiveSlug);
    try {
      await entry.wiring.close();
    } catch {
      /* non-fatal */
    }
    out.closed.push(entry.hiveSlug);
    // eslint-disable-next-line no-console
    console.log(`[cross-hive-boot] boundary closed for ${workspaceId}/${entry.hiveSlug} (no longer published)`);
  }

  // 2. Wire each published Hive not yet wired. Per-hive best-effort.
  for (const meta of published) {
    const k = key(workspaceId, meta.hiveId);
    if (_wired.has(k)) {
      out.alreadyWired.push(meta.hiveId);
      continue;
    }
    try {
      const entry = await wireOneHive(workspaceId, meta.hiveId, opts);
      if (!entry) {
        out.skipped.push(meta.hiveId);
        continue;
      }
      _wired.set(k, entry);
      // The send tools (hive:ask / hive:request_work, B-04) resolve the live
      // boundary through the shared registry — never a second transport.
      registerCrossHiveBoundary(workspaceId, meta.hiveId, entry.wiring);
      out.wired.push(meta.hiveId);
      // eslint-disable-next-line no-console
      console.log(
        `[cross-hive-boot] boundary live for ${workspaceId}/${meta.hiveId} ` +
          `(${meta.visibility}; pubkey ${entry.hivePubkey.slice(0, 8)}…)`,
      );
      if (opts.drainOnWire !== false) {
        // The boot drain — fire-and-forget: a drain dials peers (multi-second
        // waits) and boot must never block on an offline peer.
        void entry.drain().catch(() => {});
      }
    } catch (e) {
      out.skipped.push(meta.hiveId);
      // eslint-disable-next-line no-console
      console.warn(
        `[cross-hive-boot] boundary wire failed for ${workspaceId}/${meta.hiveId} (skipped): ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return out;
}

/** Compose one Hive's boundary: pubkey → transport (+ reconnect drain hook) → outbox → wiring. */
async function wireOneHive(
  workspaceId: string,
  hiveSlug: string,
  opts: EnsureCrossHiveBoundariesOpts,
): Promise<WiredCrossHiveBoundary | null> {
  const loadPubkey =
    opts.loadPubkey ?? (await import('./identity/hive-keypair')).loadHivePubkey;
  const hivePubkey = await loadPubkey(workspaceId, hiveSlug).catch(() => null);
  if (!hivePubkey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cross-hive-boot] ${workspaceId}/${hiveSlug} is published but holds no Hive identity pubkey — staying dark`,
    );
    return null;
  }

  const outbox = opts.makeOutbox
    ? opts.makeOutbox(workspaceId, hiveSlug)
    : new PgCrossHiveOutbox(workspaceId, hiveSlug, opts.sql);

  // A peer's HELLO = it just became reachable → force-drain ITS queue now
  // (bypassing backoff). Looked up via the registry so the callback is inert
  // until the entry is registered, and after the entry is closed.
  const onPeerHello = (peerPubkey: string): void => {
    const entry = _wired.get(key(workspaceId, hiveSlug));
    if (!entry) return;
    void entry.drain({ forcePeers: [peerPubkey] }).catch(() => {});
  };

  let transport = opts.wireDeps?.transport;
  if (!transport) {
    if (opts.makeTransport) {
      transport = opts.makeTransport({ hiveSlug, selfHivePubkey: hivePubkey, onPeerHello });
    } else {
      const swarm =
        opts.swarm ?? (await (await import('./sync/hyperbee/swarm')).getSharedSwarm());
      transport = makeSwarmCrossHiveTransport({ swarm, selfHivePubkey: hivePubkey, onPeerHello });
    }
  }

  // The boundary's system identity — what an admitted ask's conversation /
  // work-request's work_item is attributed to (makeLiveBoundaryPorts).
  const identity: AgentIdentity = {
    ownerId: `xhive-boundary-${hiveSlug}`,
    ownerLabel: `cross-Hive boundary (${hiveSlug})`,
    source: 'principal',
    workspaceId,
    userId: null,
  };

  const wiring = wireCrossHiveBoundary({
    workspaceId,
    hiveSlug,
    hivePubkey,
    transport,
    outbox,
    identity,
    harness: hiveSlug,
    ...(opts.sql ? { sql: opts.sql } : {}),
    ...(opts.wireDeps ?? {}),
  });

  return {
    workspaceId,
    hiveSlug,
    hivePubkey,
    wiring,
    drain: (o = {}) =>
      drainCrossHiveOutboxOnce({
        outbox,
        transport: transport!,
        ...(o.forcePeers ? { forcePeers: o.forcePeers } : {}),
        ...(o.nowMs !== undefined ? { nowMs: o.nowMs } : {}),
        ...(o.baseMs !== undefined ? { baseMs: o.baseMs } : {}),
        ...(o.capMs !== undefined ? { capMs: o.capMs } : {}),
      }),
  };
}

// NOTE: the live-boundary RESOLVE point for send-side callers (hive:ask /
// hive:request_work) is cross-hive-boundary-registry.ts (`getCrossHiveBoundary`)
// — this module is the only WRITER of that registry (register on wire,
// unregister on close).

/** Snapshot of every wired boundary (the periodic drain iterates this). */
export function listWiredCrossHiveBoundaries(): WiredCrossHiveBoundary[] {
  return [..._wired.values()];
}

/** Tear down every wired boundary. For shutdown + test cleanup. */
export async function closeAllCrossHiveBoundaries(): Promise<number> {
  const entries = [..._wired.values()];
  _wired.clear();
  let closed = 0;
  await Promise.all(
    entries.map(async (e) => {
      unregisterCrossHiveBoundary(e.workspaceId, e.hiveSlug);
      try {
        await e.wiring.close();
        closed += 1;
      } catch {
        /* ignore */
      }
    }),
  );
  return closed;
}

/** Test seam: drop the wiring state WITHOUT closing (when transports are fakes).
 *  Also clears the shared resolve registry — this module is its only writer. */
export function __resetCrossHiveBoundaryBootForTests(): void {
  _wired.clear();
  _inflight.clear();
  __clearCrossHiveBoundaryRegistry();
}
