/**
 * dev:stall_waker_status — runtime observability for the stall-waker poll loop
 * (EI-2432, gateway-rate-limit-stall-autowake). The loop's only prior signal
 * was a `console.log('[stall-waker] started')` + per-tick console output
 * buried in the operator's stdout — not queryable, so even a full-access su
 * session could not confirm the loop was running, its cadence, or its recent
 * activity without grepping host logs. The loop runs IN the operator process
 * (same process as this tool handler), so this reads its in-process singleton
 * directly — no HTTP hop to the standalone gateway sidecar needed.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getStallWakerStatus } from '../../inference-gateway/stall-waker-loop';

export default defineTool({
  name: 'dev:stall_waker_status',
  description:
    "Runtime status of the stall-waker poll loop that auto-wakes bees stalled on a rate-limited account. Returns { running, workspaceId, startedAt, pollMs, idleSilenceMs, tickCount, lastTickAt, lastTickOk, lastTickError, pendingCount, breadcrumbCount, wokenTotal, droppedTotal, unwedgedTotal }. `running:false` means the loop never started (gateway off / no spawn yet) or was stopped. Reads the operator's in-process singleton — no gateway HTTP call.",
  guidance: {
    when: "Confirming the stall-waker is actually running (vs grepping operator stdout for '[stall-waker]'), checking its poll cadence / last-tick health, or how many bees it's currently tracking/has woken.",
    notWhen: 'Per-owner outcomes (429/shed/stall) — gateway:owner_report. Live admission/pool state — gateway:status / dev:rate_governor_status.',
    seeAlso: ['gateway:owner_report (per-agent stall/wake outcomes)', 'dev:rate_governor_status (live rate-limit pacing)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'curator'],
  args: z.object({}),
  async handler() {
    return { data: { ok: true, ...getStallWakerStatus() } };
  },
});
