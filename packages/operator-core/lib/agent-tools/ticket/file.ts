import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { fileTicketFromPlanRun, TicketFilingError, TICKET_FIELD_MAX, TICKET_TITLE_MAX } from '../../capability-verbs/ticket';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

/** Provider-neutral ticket filing for trigger-pack workflows (cupboard-distributable-integrations-2026-10-10 D-012). */
export default defineTool({
  name: 'ticket:file', needsWorkspaceTx: false, profile: 'engineer',
  capability: 'operator:write', requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description: 'File one ticket for your trigger-pack plan run at the destination its installation chose. You supply text only; the server picks the source and project, quotes the triggering message as untrusted evidence, and replays never file twice.',
  guidance: {
    when: 'A trigger-pack workflow (e.g. bug-triage) decided a ticket is warranted, with your own planRunId.',
    notWhen: 'Choosing or changing the destination, ad-hoc tickets outside a trigger-pack run, or re-filing after a pending result.',
    chaining: 'Keep externalRef as proof. pendingReconciliation means retry later with the same planRunId; it never re-creates.',
  },
  args: z.object({
    planRunId: z.number().int().positive(),
    title: z.string().min(1).max(TICKET_TITLE_MAX),
    observed: z.string().max(TICKET_FIELD_MAX),
    expected: z.string().max(TICKET_FIELD_MAX),
  }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('ticket_file_workspace_required');
    try {
      return { data: { ok: true, ...await fileTicketFromPlanRun(getOrgPg().sql, { workspaceId, ...args }) } };
    } catch (error) {
      if (error instanceof TicketFilingError) return { data: { ok: false, code: error.code, message: error.message } };
      throw error;
    }
  },
});
