/**
 * sha-token-registry — the lock authority's per-(coordinationDomain, path)
 * sha-token state for the G-0 handoff protocol (Phase 7 P-033,
 * cross-machine-coord-parity-and-trust-2026-07-01; D-011 hole 1).
 *
 * THE PROTOCOL (intent-plane keystone): a hive-scoped file-lock RELEASE
 * publishes-then-releases — the holder commits, pushes its own hive-git
 * namespace, then hands the authority the published head sha
 * (`locks:release { published_sha }`). The authority remembers that sha per
 * (domain, path) and stamps the NEXT grant with it as `requiredSha`: the new
 * holder builds on the prior holder's work once `requiredSha` is an ancestor
 * of its local staging (acquirer-side check —
 * sync/hive-git/handoff-token.ts `classifyRequiredSha`/`gradeShaTokenGrant`,
 * which also downgrade grants into PARKED heads loudly, G-0b). When the prior
 * grant EXPIRED without a release (the holder died / lost its session before
 * publishing), the next grant instead carries `unsyncedRisk: true` — the
 * acquirer is warned the prior work may exist only on the dead holder's
 * machine.
 *
 * SCOPE: intent-plane, advisory, in-memory on the authority — the same
 * durability class as the authority role itself (deterministic re-election,
 * D-005). Fail-open by design: an empty registry (fresh authority / restart)
 * yields `{ requiredSha: null, unsyncedRisk: false }`, which is exactly the
 * pre-protocol behavior; git remains the data-safety backstop (D-004). For
 * failover continuity the release LockEvent (P-015 stream) carries
 * `publishedSha`, so a NEW authority can rebuild this state from the stream —
 * that reconstruction is a follow-up, not wired here.
 *
 * Pure + injectable-clock (callers pass `nowMs`), module-singleton like the
 * other authority registries, bounded (FIFO eviction) so a pathological
 * path-cardinality can't grow it unbounded.
 */

/** The sha-token stamp attached to a file-lock grant (G-0). */
export interface ShaTokenGrant {
  /** The last sha a releasing holder published for these paths (null = none known). */
  requiredSha: string | null;
  /** True when the prior grant expired WITHOUT a release — the expiry-reclaim
   *  case: the prior holder's work may never have synced. */
  unsyncedRisk: boolean;
}

interface PathTokenState {
  /** Last published sha for this path + when it was handed to the authority. */
  lastPublished?: { sha: string; ts: number };
  /** The currently-outstanding grant (cleared by a release). */
  active?: { owner: string; expiresAtMs: number };
}

/** Bound on tracked (domain, path) entries — FIFO-evicted beyond this. */
const MAX_ENTRIES = 8192;

const state = new Map<string, PathTokenState>();

/** `\0` can appear in neither a repo realpath nor a lock path. */
function key(domain: string, path: string): string {
  return `${domain}\0${path}`;
}

function entry(domain: string, path: string): PathTokenState {
  const k = key(domain, path);
  let e = state.get(k);
  if (!e) {
    e = {};
    if (state.size >= MAX_ENTRIES) {
      const oldest = state.keys().next().value;
      if (oldest !== undefined) state.delete(oldest);
    }
    state.set(k, e);
  }
  return e;
}

/**
 * Compute the sha-token stamp for a grant over `paths` — call BEFORE
 * {@link noteShaTokenGrant} for the same grant. `requiredSha` is the most
 * recently published sha across the paths (one repo domain ⇒ one lineage);
 * `unsyncedRisk` is true when ANY path's outstanding grant expired without a
 * release.
 */
export function shaTokenForGrant(domain: string, paths: readonly string[], nowMs: number): ShaTokenGrant {
  let latest: { sha: string; ts: number } | null = null;
  let unsyncedRisk = false;
  for (const p of paths) {
    const e = state.get(key(domain, p));
    if (!e) continue;
    if (e.lastPublished && (!latest || e.lastPublished.ts > latest.ts)) latest = e.lastPublished;
    if (e.active && nowMs > e.active.expiresAtMs) unsyncedRisk = true;
  }
  return { requiredSha: latest?.sha ?? null, unsyncedRisk };
}

/** Record a grant (successful acquire) over `paths`. */
export function noteShaTokenGrant(
  domain: string,
  paths: readonly string[],
  owner: string,
  expiresAtMs: number,
): void {
  for (const p of paths) {
    entry(domain, p).active = { owner, expiresAtMs };
  }
}

/**
 * Record a release over `paths`. `publishedSha` is the head the holder
 * published before releasing (G-0 publish-then-release); null = the holder
 * released without publishing (nothing to carry — the prior published sha, if
 * any, stands, and there is no unsynced risk because the release was clean).
 */
export function noteShaTokenRelease(
  domain: string,
  paths: readonly string[],
  publishedSha: string | null,
  nowMs: number,
): void {
  for (const p of paths) {
    const e = entry(domain, p);
    delete e.active;
    if (publishedSha) e.lastPublished = { sha: publishedSha, ts: nowMs };
  }
}

/** Test seam. */
export const _shaTokenTesting = {
  reset: () => state.clear(),
  size: () => state.size,
  maxEntries: MAX_ENTRIES,
};
