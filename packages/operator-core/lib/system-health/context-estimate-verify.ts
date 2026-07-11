/**
 * context-estimate-verify — verify-before-alarm for the context gauge (WI-4154).
 *
 * The gauge's cached estimate (coord_presence.context_tokens, mirrored in
 * context-usage-cache) goes stale ACROSS A COMPACTION BOUNDARY: the watchdog
 * refreshes it only on its ~2-min sweep and nothing invalidates it when a
 * compaction lands, so for up to one sweep after every compaction each surface
 * (the coord:inbox usage line + hook gauge, the P-013 result annotator) served
 * the PRE-compaction number — a false LOUD/CRITICAL alarm at exactly the moment
 * the agent decides whether to compact. Two sessions burned pointless
 * compactions on 126%/87% readings whose real post-boundary usage was 14–15%
 * (WI-4154).
 *
 * Rule: a cached reading may only ALARM (≥ CONTEXT_GAUGE_LOUD_PCT) after being
 * re-derived from the transcript within the last {@link VERIFY_FRESH_MS}. The
 * estimator is boundary-aware (bytes since the last isCompactSummary marker),
 * so a fresh derive self-corrects at any compaction boundary — including native
 * auto-compactions no host event ever reports. Verified values are written
 * THROUGH to both caches so every surface converges. Below the alarm band the
 * cached value passes through untouched — the common path pays nothing.
 */

import { estimateContextTokensForOwner } from '../compaction-usage';
import { recordContextUsage } from './context-usage-cache';
import {
  contextUsagePct,
  CONTEXT_GAUGE_LOUD_PCT,
} from '../agent-tools/coordination/tools/inbox-context-usage';

/** An alarm-band estimate older than this must be re-derived before it may render.
 *  Bounds the re-derive cost to ≤3 transcript scans/min/owner while genuinely hot,
 *  and bounds the worst-case stale-alarm window to this instead of the 2-min sweep. */
export const VERIFY_FRESH_MS = 20_000;

/** ownerId → last time a transcript-derived estimate was confirmed (this process). */
const lastFreshAt = new Map<string, number>();
/** Owners with a background re-derive in flight (annotator kick dedup). */
const inFlight = new Set<string>();

export interface ContextVerifyDeps {
  estimate?: (ownerId: string) => Promise<number | null>;
  writePgEstimate?: (ownerId: string, tokens: number) => Promise<void>;
  recordUsage?: typeof recordContextUsage;
  now?: () => number;
}

/** Dynamic import keeps this module (and the sync annotator importing it) off the
 *  presence/db-org graph until a write-through actually happens. */
async function defaultWritePgEstimate(ownerId: string, tokens: number): Promise<void> {
  const { setContextEstimate } = await import('../agent-tools/coordination/presence');
  await setContextEstimate(ownerId, tokens);
}

/** Mark an owner's estimate as freshly transcript-derived (verify/refresh write paths). */
export function markContextEstimateFresh(ownerId: string, now: number = Date.now()): void {
  lastFreshAt.set(ownerId, now);
}

function verifiedRecently(ownerId: string, now: number): boolean {
  const at = lastFreshAt.get(ownerId);
  return at != null && now - at < VERIFY_FRESH_MS;
}

/**
 * The async verify: returns the tokens a surface may render. Below the alarm band
 * (or with no computable pct) the cached value passes straight through; at/above
 * it, re-derive from the transcript unless already verified within the TTL, write
 * the fresh value through to both caches, and return it. Never throws; an
 * unresolvable estimate falls back to the cached reading (a blind estimator must
 * not silence a possibly-real alarm).
 */
export async function verifyContextTokensForAlarm(
  ownerId: string,
  cachedTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
  deps: ContextVerifyDeps = {},
): Promise<number | null> {
  const cached = cachedTokens ?? null;
  try {
    const pct = contextUsagePct(cachedTokens, compactionLimit);
    if (pct == null || pct < CONTEXT_GAUGE_LOUD_PCT) return cached;
    const now = (deps.now ?? Date.now)();
    if (verifiedRecently(ownerId, now)) return cached;
    const fresh = await (deps.estimate ?? estimateContextTokensForOwner)(ownerId);
    if (fresh == null) return cached;
    markContextEstimateFresh(ownerId, now);
    try {
      await (deps.writePgEstimate ?? defaultWritePgEstimate)(ownerId, fresh);
    } catch {
      /* best-effort — the verified value still returns to the caller */
    }
    if (compactionLimit && compactionLimit > 0) {
      (deps.recordUsage ?? recordContextUsage)(ownerId, fresh, compactionLimit, now);
    }
    return fresh;
  } catch {
    return cached;
  }
}

/**
 * SYNC gate for the P-013 result annotator (a sync dispatch hot path that cannot
 * await a re-derive): should this alarm-band cached reading be suppressed pending
 * verification? Below the alarm band → false (render as-is). At/above it with a
 * recent verification → false (confirmed — render). Otherwise kick ONE background
 * re-derive (its write-through corrects both caches) and return true: this render
 * is suppressed and the next call renders the corrected value — a REAL alarm is
 * delayed by at most one tool result, a stale one never fires.
 */
export function gaugeNeedsVerification(
  ownerId: string,
  tokens: number,
  limit: number,
  deps: ContextVerifyDeps = {},
): boolean {
  const pct = contextUsagePct(tokens, limit);
  if (pct == null || pct < CONTEXT_GAUGE_LOUD_PCT) return false;
  const now = (deps.now ?? Date.now)();
  if (verifiedRecently(ownerId, now)) return false;
  if (!inFlight.has(ownerId)) {
    inFlight.add(ownerId);
    void verifyContextTokensForAlarm(ownerId, tokens, limit, deps)
      .catch(() => null)
      .finally(() => inFlight.delete(ownerId));
  }
  return true;
}

/**
 * Boundary refresh (the fast path): re-derive + write through the moment a
 * compaction completes — called by the emit-session-compacted bridge CLI (psu
 * mode:'compact' step 4) so coord_presence reads post-boundary within seconds
 * instead of serving the pre-compaction number until the next watchdog sweep.
 * Best-effort; never throws. (Native auto-compactions have no completion event —
 * the verify gate above covers those.)
 */
export async function refreshContextEstimateAtBoundary(
  ownerId: string,
  deps: ContextVerifyDeps = {},
): Promise<number | null> {
  try {
    const fresh = await (deps.estimate ?? estimateContextTokensForOwner)(ownerId);
    if (fresh == null) return null;
    markContextEstimateFresh(ownerId, (deps.now ?? Date.now)());
    try {
      await (deps.writePgEstimate ?? defaultWritePgEstimate)(ownerId, fresh);
    } catch {
      /* best-effort */
    }
    return fresh;
  } catch {
    return null;
  }
}

/** Test seam. */
export function resetContextVerifyForTests(): void {
  lastFreshAt.clear();
  inFlight.clear();
}
