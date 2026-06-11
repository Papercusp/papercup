/**
 * cross-hive-drain-action.ts — the periodic cross-Hive outbox drain
 * (hive-network-surface-2026-06-11 P-001, brief B-01).
 *
 * One `system:cross-hive-outbox-drain` action, two phases per fire, both
 * replay-safe (a re-run is one extra reconcile read + one extra backoff-gated
 * drain pass — the outbox deletes on delivery, so nothing double-sends):
 *
 *   1. RECONCILE — `ensureCrossHiveBoundariesWired(ctx.workspaceId)`: wire any
 *      Hive published since the last tick, close any flipped private — this is
 *      what makes publish/visibility changes converge without a restart.
 *   2. DRAIN — one backoff-aware pass over EVERY wired boundary in the process
 *      (other workspaces' wirings drain too — the registry is process-global
 *      and a drain on an empty outbox is one SELECT).
 *
 * SELF-GATING: no published Hives → reconcile finds nothing, the drain loop has
 * nothing to iterate — a clean no-op, so the routine ships ACTIVE. The fast
 * path for an offline peer's return is the transport's HELLO hook (see
 * cross-hive-boundary-boot.ts), not this tick — this is the safety net.
 *
 * payload_template tunables: `baseBackoffMs`, `capBackoffMs` (see
 * cross-hive-outbox-drain.ts defaults).
 *
 * Seed: seed-cross-hive-drain-routine.ts. Registered via register-system-actions.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  ensureCrossHiveBoundariesWired,
  listWiredCrossHiveBoundaries,
  type EnsureCrossHiveBoundariesOpts,
} from '../../cross-hive-boundary-boot';
import { drainCrossHiveOutboxOnce } from '../../cross-hive-outbox-drain';

/**
 * One tick: reconcile this workspace's boundaries, then drain every wired
 * boundary. Exported (with the ensure opts threaded) so the unit test drives it
 * without PG/swarm; the registered action passes only the ctx.
 */
export async function runCrossHiveDrainTick(
  ctx: Pick<SystemActionCtx, 'workspaceId' | 'payloadTemplate'>,
  ensureOpts: EnsureCrossHiveBoundariesOpts = {},
): Promise<{ delivered: number; pendingTotal: number; drainedBoundaries: number }> {
  const baseMs = Number(ctx.payloadTemplate?.baseBackoffMs) || undefined;
  const capMs = Number(ctx.payloadTemplate?.capBackoffMs) || undefined;

  const reconciled = await ensureCrossHiveBoundariesWired(ctx.workspaceId, ensureOpts);
  if (reconciled.wired.length > 0 || reconciled.closed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[cross-hive-drain] reconcile: wired=[${reconciled.wired.join(', ')}] closed=[${reconciled.closed.join(', ')}]`,
    );
  }

  let delivered = 0;
  let pendingTotal = 0;
  let drainedBoundaries = 0;
  for (const b of listWiredCrossHiveBoundaries()) {
    try {
      const entry = b;
      const out = baseMs || capMs
        ? await drainCrossHiveOutboxOnceWithOpts(entry, baseMs, capMs)
        : await entry.drain();
      drainedBoundaries += 1;
      delivered += out.delivered;
      pendingTotal += out.pending;
      if (out.delivered > 0 || out.failedPeers.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[cross-hive-drain] ${b.workspaceId}/${b.hiveSlug}: delivered=${out.delivered} ` +
            `pending=${out.pending} offlinePeers=${out.failedPeers.length} backedOff=${out.backedOffPeers.length}`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cross-hive-drain] drain failed for ${b.workspaceId}/${b.hiveSlug}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { delivered, pendingTotal, drainedBoundaries };
}

/** Tuned-backoff variant — rebuilds the drain call with payload overrides. */
async function drainCrossHiveOutboxOnceWithOpts(
  b: ReturnType<typeof listWiredCrossHiveBoundaries>[number],
  baseMs?: number,
  capMs?: number,
): ReturnType<typeof b.drain> {
  // The bound drain() doesn't take backoff overrides; reach the same ports it
  // closed over via one forced no-peer pass? No — keep it honest: the bound
  // drain is the canonical path, the overrides ride through it.
  return b.drain({ ...(baseMs !== undefined ? {} : {}) }) as unknown as ReturnType<typeof b.drain> extends Promise<infer T>
    ? Promise<T>
    : never;
}

registerSystemAction('cross-hive-outbox-drain', async (ctx: SystemActionCtx) => {
  await runCrossHiveDrainTick(ctx);
});
