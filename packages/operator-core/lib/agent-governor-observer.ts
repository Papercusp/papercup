/**
 * Agent rate-limit-governor observability wiring (RB-009).
 *
 * The domain-free `RateLimitGovernor` fires `onPause` (via the registry's `onGovernorPause`
 * emitter) whenever a bucket's pause is newly set or extended — i.e. on a real 429 /
 * backpressure transition. This module is the OPERATOR-side host for that signal: it surfaces
 * a "rate-limited — paused until <reset>" status to coord (a broadcast message, mirroring the
 * service-health monitor) and the toast stream (`notifications:recent`), so a human/agent sees
 * the fleet is throttled instead of silently waiting. The on-demand snapshot lives in the
 * `dev:rate_governor_status` tool.
 *
 * Lib stays domain-free; all the coord/PG coupling is here. Best-effort + throttled — a
 * surfacing failure must never affect the limiter or the spawn path.
 */
import { onGovernorPause } from '@papercusp/papercusp-shared/agent';
import { getOrgPg, generated } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { notifySyncInvalidate } from './sync-sse';

const GOVERNOR_IDENTITY: AgentIdentity = {
  ownerId: 'rate-governor',
  ownerLabel: 'rate-governor',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

// Per-bucket throttle: a sustained rate-limit can extend the pause several times; surface at
// most once per bucket per window so we don't spam coord/toasts.
const SURFACE_THROTTLE_MS = 30_000;
const TOAST_RING_BUFFER = 2000;
const lastSurfaced = new Map<string, number>();
let initialized = false;

/** Register the pause→coord+toast surfacing. Idempotent; call once at operator boot. */
export function initAgentGovernorObserver(): void {
  if (initialized) return;
  initialized = true;
  onGovernorPause((ev) => {
    // A transport pause (egress-proxy circuit) is not a rate-limit — surfacing "rate-limited — paused"
    // for a flaky proxy is misleading noise. The egress circuit has its own observability.
    if (ev.source === 'transport') return;
    const now = Date.now();
    if (now - (lastSurfaced.get(ev.key) ?? 0) < SURFACE_THROTTLE_MS) return;
    lastSurfaced.set(ev.key, now);
    const untilIso = new Date(ev.pausedUntil).toISOString();
    void surfacePause(ev.key, untilIso, ev.source).catch(() => {
      /* observability is best-effort */
    });
  });
}

async function surfacePause(bucketKey: string, untilIso: string, source: string): Promise<void> {
  const summary = `⏳ agent rate-limit — bucket "${bucketKey}" paused until ${untilIso} (${source})`;
  // Coord broadcast (transition only), mirroring the service-health monitor.
  // Ambient category → default-excluded from coord:inbox (opt-in to see it).
  await sendMessage(GOVERNOR_IDENTITY, { to: ['*'], summary, category: 'agent-governor' }).catch(() => {});
  // Toast stream (notifications:recent), mirroring writeVerifierWarningToast.
  try {
    const tl = generated.toastLogInHarnessShared;
    const { db } = getOrgPg();
    await db.insert(tl).values({
      level: 'warning',
      message: 'Agent rate-limited — paused',
      description: `Rate-limit bucket "${bucketKey}" is paused until ${untilIso}. Agent spawns + in-process LLM calls on this provider/model-class wait until the reset (no work is lost; they resume automatically).`,
      harnessSlug: null,
      createdAt: Date.now(),
      actionLabel: null,
      actionHref: null,
    });
    void (async () => {
      const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
      if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
    })().catch(() => {});
    void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
  } catch {
    /* PG not ready / write failed — best-effort */
  }
}

/** Test-only — reset the throttle + init flag. */
export function _resetAgentGovernorObserver(): void {
  initialized = false;
  lastSurfaced.clear();
}
