/**
 * processes:kill — send SIGTERM (or SIGKILL) to a host pid.
 *
 * Tier 1 sensitive — bearer-required, capability-gated. Agents that
 * pass URL spawn-context (no principal) cannot reach this; only callers
 * with a real bearer (dashboard via superuser token, future per-user
 * sessions) can invoke. Handler enforces a kind allowlist on top of the
 * capability gate.
 *
 * Audit log: every call writes a row to harness_shared.audit_log before
 * the signal is sent, so the action is recorded even if the kill
 * cascades through dependent processes.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { killProcess } from '../../process-kill';

export default defineTool({
  name: 'processes:kill',
  profile: 'engineer',
  guidance: {
    when: 'User says "kill that process", "stop the runaway harness" — sends SIGTERM (then SIGKILL after timeout) to a tracked OS process.',
    notWhen: 'For SPAWNED agents, use `orchestrator.cancel`. For DELEGATES, use the delegate-cancel endpoint. processes:kill is the OS-level escape hatch.',
  },
  capability: 'processes:kill',
  args: z.object({
    pid: z.number().int().positive(),
    signal: z.enum(['SIGTERM', 'SIGKILL']).optional(),
  }),
  async handler(args, ctx) {
    const result = await killProcess({
      pid: args.pid,
      signal: args.signal,
      actorSlug: ctx.principal.slug,
      workspaceId: ctx.principal.workspaceId,
    });
    return { data: result };
  },
});
