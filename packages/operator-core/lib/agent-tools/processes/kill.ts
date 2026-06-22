/**
 * processes:kill — send SIGTERM (or SIGKILL) to one OR many host pids.
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
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `pid` for one or `pids`
 * for several → { ok, results:[{ ok, pid, kind, signal | error }], counts }.
 * Each result self-describes its pid (killProcess already returns the pid +
 * verdict), so a protected/absent pid fails ONLY itself. `signal` is
 * batch-level.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { killProcess } from '../../process-kill';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

export default defineTool({
  name: 'processes:kill',
  profile: 'engineer',
  description:
    'Send SIGTERM (or SIGKILL) to one OR many tracked OS pids in ONE call — pass `pid` for one or `pids` for several. Returns { ok, results:[{ ok, pid, kind, signal | error }], counts } — correlate each result by its pid, not by position; a protected/absent pid fails only itself.',
  guidance: {
    when: 'User says "kill that process", "stop the runaway harness" — sends SIGTERM (then SIGKILL after timeout) to tracked OS process(es). Killing several at once? Pass them all via `pids`.',
    notWhen: 'For SPAWNED agents, use `orchestrator.cancel`. For DELEGATES, use the delegate-cancel endpoint. processes:kill is the OS-level escape hatch.',
  },
  capability: 'processes:kill',
  args: z
    .object({
      pid: z.number().int().positive().optional().describe('a single host pid (n=1 shorthand for pids:[pid])'),
      pids: z.array(z.number().int().positive()).min(1).max(100).optional().describe('host pids to signal (1–100)'),
      signal: z.enum(['SIGTERM', 'SIGKILL']).optional().describe('the signal to send (batch-level; default SIGTERM)'),
    })
    .refine((a) => Boolean(a.pid) || (a.pids?.length ?? 0) > 0, {
      message: 'pass `pid` (one) or `pids` (many)',
    }),
  async handler(args, ctx) {
    const pids = [...new Set([...toList<number>(args.pid), ...toList<number>(args.pids)])];
    const env = await runBulk(
      pids,
      async (pid) => {
        const result = await killProcess({
          pid,
          signal: args.signal,
          actorSlug: ctx.principal.slug,
          workspaceId: ctx.principal.workspaceId,
        });
        // killProcess returns { ok, pid, kind, signal | error, detail? } — already
        // self-keyed by pid; surface it verbatim so a per-item failure rides through.
        return { ...result, ok: result.ok, pid: result.pid ?? pid };
      },
      { keyOf: (pid) => ({ pid }) },
    );
    return bulkContent(env);
  },
});
