/**
 * context-usage-cache — a volatile, in-process cache of each live session's context
 * usage, so the ambient gauges (agent-managed-compaction D-009) read it with ZERO
 * per-call DB cost.
 *
 * SINGLE WRITER: the compaction-compliance-watchdog, which already estimates every
 * limit-carrying session's context size on its 2-min sweep and caches it on
 * coord_presence.context_tokens (PG-canonical). On the SAME pass it mirrors that
 * (owner → tokens/limit) here, in-process. READERS: the P-013 result-annotator (a
 * banded gauge on every papercusp-su MCP tool result) and the P-015 hook-side gauge.
 *
 * NOT durable state — coord_presence is canonical (storage-policy: PG-by-default). This
 * is purely a hot-path read cache of a slowly-moving value (refreshed every 2 min), the
 * same in-process-Map class as the watchdog's own overLimitOwners / forceCompactedOwners
 * dedup sets. Entries STALE OUT ({@link CONTEXT_USAGE_STALE_MS}) so a session the watchdog
 * stopped tracking (ended / limit cleared) can't leave a phantom gauge on the wire.
 */

/** Beyond this age an entry is treated as absent — a few missed watchdog passes (2-min
 *  cadence) tolerated, but a long-gone session never keeps rendering a stale gauge. */
export const CONTEXT_USAGE_STALE_MS = 6 * 60_000;

interface Entry {
  tokens: number;
  limit: number;
  at: number;
}

const cache = new Map<string, Entry>();

/** Watchdog write: mirror one owner's freshly-estimated usage. `now` is injectable for tests. */
export function recordContextUsage(
  ownerId: string,
  tokens: number,
  limit: number,
  now: number = Date.now(),
): void {
  if (!ownerId || !Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) return;
  cache.set(ownerId, { tokens, limit, at: now });
}

/** Reader: the owner's cached usage, or null when absent / staler than the TTL. */
export function getContextUsage(
  ownerId: string,
  now: number = Date.now(),
): { tokens: number; limit: number } | null {
  const e = cache.get(ownerId);
  if (!e) return null;
  if (now - e.at > CONTEXT_USAGE_STALE_MS) {
    cache.delete(ownerId);
    return null;
  }
  return { tokens: e.tokens, limit: e.limit };
}

/** Test seam. */
export function resetContextUsageCacheForTests(): void {
  cache.clear();
}
