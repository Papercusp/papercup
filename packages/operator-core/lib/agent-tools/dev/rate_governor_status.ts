/**
 * dev:rate_governor_status — the on-demand snapshot of the agent RateLimitGovernor buckets
 * (RB-009). One row per live `(provider, modelClass)` bucket: whether it's paused (and until
 * when), in-flight concurrency vs the cap, and the RPM/ITPM/OTPM headroom in the current
 * window. The governor additionally broadcasts a coord message + toast on each pause
 * transition (agent-governor-observer); this tool is the pull-side status.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { snapshotGovernors } from '@papercusp/papercup-shared/agent';

export default defineTool({
  name: 'dev:rate_governor_status',
  description:
    'Snapshot the agent rate-limit governor buckets now: per (provider, model-class) — paused/until, in-flight vs maxConcurrent, and RPM/ITPM/OTPM usage vs limit in the current 60s window. Empty until a bucket has been used (created lazily on first agent turn). Use to see whether the fleet/gym is currently rate-limit-paced or paused.',
  guidance: {
    when: 'Diagnose whether agent spawns / meridian calls are being paced or paused by the rate-limit governor (e.g. "why are runs slow / stalled?").',
    notWhen: 'Service up/down — dev:service_health. Migration drift — db:check_drift.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator'],
  args: z.object({}),
  async handler() {
    const now = Date.now();
    const buckets = snapshotGovernors().map((b) => {
      const s = b.state;
      const windowAgeMs = now - s.windowStart;
      const windowActive = windowAgeMs < 60_000;
      return {
        key: b.key,
        provider: b.provider,
        modelClass: b.modelClass,
        // D-006: precise (apiKey, token-bucket active) vs coarse (subscription, concurrency+rpm).
        limitModel: b.limitModel,
        paused: s.pausedUntil > now,
        pausedUntil: s.pausedUntil > now ? new Date(s.pausedUntil).toISOString() : null,
        msUntilReset: s.pausedUntil > now ? s.pausedUntil - now : 0,
        // Pre-emptive pacing gap when remaining is low (review #7/#8); 0 = healthy headroom.
        paceDelayMs: s.paceDelayMs,
        inFlight: s.inFlight,
        maxConcurrent: s.limits.maxConcurrent,
        window: {
          rpm: { used: windowActive ? s.reqInWindow : 0, limit: s.limits.rpm ?? null },
          itpm: { used: windowActive ? s.inTokInWindow : 0, limit: s.limits.itpm ?? null },
          otpm: { used: windowActive ? s.outTokInWindow : 0, limit: s.limits.otpm ?? null },
        },
      };
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, now: new Date(now).toISOString(), bucketCount: buckets.length, buckets }),
        },
      ],
    };
  },
});
