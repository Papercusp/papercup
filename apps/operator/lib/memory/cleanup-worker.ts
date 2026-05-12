/**
 * Auto-TTL cleanup for mem0 ephemeral memories.
 *
 * Plan 3.8. mem0 v2 OSS removed first-class expiration_date, but stores
 * `expires_at` as metadata. We poll periodically and delete entries
 * whose `metadata.expires_at < now`.
 *
 * Cadence: every 6 hours from instrumentation-node.ts boot. Cheap
 * (one filter query + deletes). Failure is non-fatal.
 *
 * Identity / preference / project / correction kinds are NEVER
 * auto-deleted — they don't carry expires_at by design. Only
 * 'ephemeral' entries have expires_at set.
 */

import { getMemoryClient } from './mem0-client';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let _sweepTimer: NodeJS.Timeout | null = null;
let _running = false;

async function sweep(): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    const client = await getMemoryClient();
    if (!client) return;
    const all = await client.getAll({});
    const now = Date.now();
    let purged = 0;
    for (const entry of all.results ?? []) {
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      const expiresAt = meta.expires_at;
      if (typeof expiresAt !== 'string') continue;
      const t = Date.parse(expiresAt);
      if (!Number.isFinite(t)) continue;
      if (t < now) {
        try {
          await client.delete(entry.id);
          purged += 1;
        } catch {
          /* best-effort */
        }
      }
    }
    if (purged > 0) {
      console.log(`[memory-cleanup] purged ${purged} expired ephemeral memories`);
    }
  } catch (err) {
    console.warn('[memory-cleanup] sweep failed:', (err as Error).message);
  } finally {
    _running = false;
  }
}

/**
 * Start the periodic cleanup sweep. Idempotent — safe to call multiple
 * times. Runs once on start, then every SWEEP_INTERVAL_MS.
 */
export function startMemoryCleanup(): void {
  if (_sweepTimer) return;
  // Initial sweep after 60s of process boot — avoids contending with
  // every other boot-time worker for resources.
  setTimeout(() => void sweep(), 60_000);
  // Periodic sweep thereafter.
  _sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  // Don't block process exit on the timer.
  if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
}

export function stopMemoryCleanup(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}
