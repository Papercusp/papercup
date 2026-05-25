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
import { recordBootEvent } from './boot-history';
import type Corestore from 'corestore';

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
}

export interface BootedHarnessHandle {
  workspaceId: string;
  harnessSlug: string;
  /** The Corestore — for swarm replication wiring + introspection. */
  store: Corestore;
  /** Autobase handle. Pass to claimFeature / appendOp callers. */
  base: AutobaseHarnessHandle;
  /** Cleanup. Idempotent. */
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

  recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_ok');

  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    store,
    base,
    async close() {
      // Stop the progress poller first so it doesn't race the
      // autobase teardown trying to read .view.length on a closed
      // store.
      progressPoller.stop();
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
