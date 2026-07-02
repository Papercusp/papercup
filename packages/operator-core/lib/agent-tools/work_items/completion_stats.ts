/**
 * work_items:completion_stats — the WI-1405 genuine-completions metric
 * (work-item-completion-integrity-2026-07-01 P-003, contract C-1 consumer).
 *
 * WI-1403's gate rejects a terminal transition missing an owner+completionRef UNLESS the
 * caller passes skipCompletionGate — the shape the watchdog/hygiene/revert dedup markers
 * use (WI-1404). That means the raw terminal-state count silently blends genuine
 * completions with dedup flips. This read separates them: `genuineCompletions` counts ONLY
 * terminal work-items carrying BOTH terminal_owner and terminal_completion_ref;
 * `dedupOrUnverified` is everything else terminal (a dedup flip, or a pre-migration-432
 * historical row). Fleet-facing progress reports should read `genuineCompletions`, not
 * `terminalTotal`, when the question is "how much real work landed".
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getCompletionIntegrityStats } from '../../work-items';

export default defineTool({
  name: 'work_items:completion_stats',
  profile: 'engineer',
  description:
    "Genuine-completions metric for one harness: terminalTotal (every done/closed work-item, both families) vs genuineCompletions (terminal AND carrying both an owner and a completion_ref — the only rows the completion-integrity gate would accept without a skip) vs dedupOrUnverified (the difference — watchdog/hygiene/revert dedup flips, or pre-gate historical rows).",
  guidance: {
    when:
      'Reporting progress on a harness and the question is "how much REAL work landed", not just the raw done/closed count — a watchdog dedup sweep or hygiene close inflates the raw terminal count without any owner doing the work.',
    notWhen: 'Per-item detail — that is work_items:get. A live roster of who is doing what — that is fleet:status / fleet:assignments.',
    seeAlso: [
      'work_items:get (per-item terminalOwner/terminalCompletionRef detail)',
      'harness:health (the harness health rollup)',
      'fleet:status (who is doing what right now)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80).describe('Harness slug to read the completion split for.'),
  }),
  async handler(args) {
    const stats = await getCompletionIntegrityStats(args.harness);
    // { data } shape (tool-data-shape ratchet P-003): the framework owns wire encoding.
    return { data: { ok: true, ...stats } };
  },
});
