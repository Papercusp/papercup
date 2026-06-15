/**
 * dev:rate_governor_status — the on-demand snapshot of the fleet rate-limit layer
 * (RB-009 + rate-limit-layer-v2). Serves the shared `buildFleetRateStatus` read-model:
 * the live config (maxSimultaneousAgents + AIMD floor), the fleet cap vs in-flight vs
 * AIMD-effective concurrency (D-004/D-005), one row per live `(provider, modelClass)`
 * governor bucket (paused/until, in-flight vs cap, RPM/ITPM/OTPM headroom), and the
 * recent usage telemetry (tokens, $spend, usage% where a ceiling is known — D-002).
 * The governor additionally broadcasts a coord message + toast on each pause
 * transition (agent-governor-observer); this tool is the pull-side status.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildFleetRateStatus } from '../../fleet-rate-status';

export default defineTool({
  name: 'dev:rate_governor_status',
  description:
    'Snapshot the fleet rate-limit layer now: live config (maxSimultaneousAgents + AIMD floor), fleet cap vs in-flight vs AIMD-effective concurrency, per (provider, model-class) governor buckets (paused/until, in-flight vs maxConcurrent, RPM/ITPM/OTPM headroom), and recent usage telemetry (token throughput, $spend, usage% where a provider ceiling is known). Buckets are empty until a governed agent turn has run. Use to see whether the fleet/gym is currently rate-limit-paced, paused, or AIMD-throttled.',
  guidance: {
    when: 'Diagnose whether agent spawns / stateless LLM calls are being paced or paused by the rate-limit governor (e.g. "why are runs slow / stalled?"), or read the fleet cap / effective concurrency / usage% the top-bar shows.',
    notWhen: 'Service up/down — dev:service_health. Migration drift — db:check_drift. EDITING the cap — operator:rate_limit_config.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  // + overwatch (overwatch-role-2026-06-15 B-01): the supervisor reads the governor's
  // paused buckets / failovers / 429s to detect the token-saturation anomaly (the
  // 2026-06-15 opus-pacing stall) and nudge the Queen.
  agentRoles: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator', 'bee', 'overwatch'],
  args: z.object({
    usageWindowMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional()
      .describe('Lookback for the usage/$spend aggregation (default 60 minutes).'),
  }),
  async handler(args) {
    const status = await buildFleetRateStatus((args.usageWindowMinutes ?? 60) * 60_000);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...status, bucketCount: status.buckets.length }) }],
    };
  },
});
