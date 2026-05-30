/**
 * Single-function composer: bring a harness's Hyperbee sync substrate
 * fully online.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Production call site (when instrumentation-node.ts boot wiring lands):
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
 * Each handle returned is the entry point for that harness's Autobase
 * (the orchestrator's `claimFeature` takes one), and `close()` is the
 * cleanup hook for harness-remove.
 *
 * What this function does NOT do:
 *   - Hyperswarm replication setup. The `corestore.replicate()` call
 *     against a swarm topic is intentionally separated — testable in
 *     isolation, swappable for an offline mode, and not all harnesses
 *     swarm-join at boot (private harnesses skip it entirely).
 *   - PG → Hyperbee write hooks. Those land per-table as call sites
 *     opt into "fan out my PG write to Hyperbee too." Until then the
 *     substrate only consumes remote ops; local writes still flow
 *     through PG-direct.
 */

import { getHarnessStore, type HarnessStoreOpts } from './corestore';
import { createAutobaseHarness, type AutobaseHarnessHandle } from './autobase-setup';
import { acceptOpVersion, type SchemaVersionAlert } from './schema-version';
import { schemaVersionEvents } from './schema-version';
import { registerAllHarnessProjections } from './projections/register-all';
import { startBootstrapProgressPoller } from './bootstrap-progress-poller';
import { startHyperbeeReadLoop, type ReadLoopHandle } from './read-loop';
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

export interface BootHarnessOpts {
  workspaceRoot: string;
  workspaceId: string;
  harnessSlug: string;
  /**
   * For non-bootstrap writers (joining a shared harness), the bootstrap
   * peer's Autobase key (hex). Omit when this peer creates the harness
   * (i.e. share-wizard P-029 flow → `bootstrap: null`).
   */
  bootstrap?: string | null;
  /**
   * Optional swarm binding. When present, the harness joins a
   * Hyperswarm topic + plugs corestore.replicate into every peer
   * stream so writes federate cross-machine. Omit (or pass null) for
   * `state: private` harnesses that stay single-engineer.
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
}

export interface BootedHarnessHandle {
  workspaceId: string;
  harnessSlug: string;
  /** The Corestore — for swarm replication wiring + introspection. */
  store: Corestore;
  /** Autobase handle. Pass to claimFeature / appendOp callers. */
  base: AutobaseHarnessHandle;
  /** Swarm handle. Null when this boot didn't join a swarm
   *  (private harness OR swarmBinding omitted). */
  swarm: SwarmHandle | null;
  /** Cleanup. Idempotent. Tears down swarm + Autobase + Corestore. */
  close(): Promise<void>;
}

/**
 * Compose the full substrate for one harness. Order matters:
 *
 *   1. Open / create the per-harness corestore.
 *   2. Build the Autobase view over it, gated by the per-harness
 *      schema-version filter.
 *   3. Register all 8 per-table PG projection writers.
 *
 * Returns a handle whose `close()` tears down the Autobase + Corestore
 * cleanly. Projection registrations are global and currently leak across
 * harness re-boots; that's safe because registerProjection overwrites
 * by tableTag and the closure binds the new workspace/slug.
 */
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

async function bootHarnessSubstrateInner(opts: BootHarnessOpts): Promise<BootedHarnessHandle> {
  const storeOpts: HarnessStoreOpts = {
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  };
  const store = await getHarnessStore(storeOpts);

  const slug = opts.harnessSlug;
  const base = await createAutobaseHarness({
    store,
    bootstrap: opts.bootstrap ?? null,
    // Schema-version filter: every op carries schema_version per D-024.
    // The substrate drops unknown-newer ops + emits a single alert per
    // (slug, version) pair so the UI can surface "newer Papercusp
    // available."
    acceptOp: (op) => acceptOpVersion(slug, op.schema_version),
  });

  // Wire the 8 per-table PG projection writers. Idempotent (re-running
  // overwrites by tableTag).
  registerAllHarnessProjections({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
  });

  // P-066 bootstrap-progress tracker. Polls base.view.length each
  // second; feeds the BootstrapProgressIndicator via /api/harness/
  // :slug/bootstrap-progress. Cheap (one async getter call per
  // second per harness); idempotent across reboots since the tracker
  // map keys by (workspaceId, slug).
  const progressPoller = startBootstrapProgressPoller({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    base,
  });

  // P-031 read side: replay the merged Autobase view back into PG so remote
  // (and local) substrate ops actually land in PG / the UI — without this the
  // substrate is write-only (applyHyperbeeOpToPg had no runtime caller). Runs
  // for private AND swarmed harnesses; idempotent op-replay over the view log.
  const readLoop: ReadLoopHandle = startHyperbeeReadLoop({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    base,
  });

  // ── Hyperswarm replication (final substrate piece) ──
  // Joins the swarm topic + plugs corestore.replicate into every
  // peer stream. Only fires for harnesses that pass swarmBinding;
  // `state: private` harnesses (no binding) stay local-only.
  // Defensive: swarm join failures don't fail the boot — harness
  // still works as a local-only substrate; UI can show "offline"
  // status if needed.
  let swarmHandle: SwarmHandle | null = null;
  if (opts.swarmBinding) {
    try {
      const swarm = opts.swarmOverride ?? (await getSharedSwarm());
      const topic = deriveSwarmTopic(opts.swarmBinding);
      swarmHandle = await joinHarnessSwarm({
        store,
        topic,
        swarm,
        onPeerConnected: () => {
          recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_connected');
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
    base,
    swarm: swarmHandle,
    async close() {
      // Stop the progress poller first so it doesn't race the
      // autobase teardown trying to read .view.length on a closed
      // store.
      progressPoller.stop();
      // Same for the read-loop — stop before the view closes (a get() against
      // a closing store throws; the loop bails defensively, but stop cleanly).
      readLoop.stop();
      // Leave the swarm before tearing down autobase/store so we
      // stop receiving peer replication onto an about-to-close
      // corestore.
      if (swarmHandle) {
        try { await swarmHandle.close(); } catch {}
      }
      // Autobase first, then corestore — autobase holds open writers
      // into the store.
      try { await base.close(); } catch {}
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
