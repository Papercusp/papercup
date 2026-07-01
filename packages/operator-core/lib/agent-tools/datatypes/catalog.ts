/**
 * datatypes:catalog — browse the GLOBAL catalog of APPROVED published datatypes (the shared
 * tier, reflexive-platform-extensibility-datatypes-2026-06-24 D-010 distribution).
 *
 * Datatypes other workspaces published + an operator approved (review_status='approved') are
 * globally READABLE (migration 426). This lists them so you can find one to reuse, then install
 * it into your workspace with `datatypes:install`. Read-only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { listApprovedPublishedDatatypes } from '../../datatype-registry-store';

export default defineTool({
  name: 'datatypes:catalog',
  description:
    'Browse the GLOBAL catalog of APPROVED published datatypes (the shared tier) — datatypes other workspaces ' +
    'published and an operator approved. Install one into your workspace with datatypes:install. Read-only.',
  guidance: {
    when: 'Before declaring a new datatype — check whether an approved global one already fits, to reuse instead of re-inventing.',
    notWhen: 'To browse YOUR workspace\'s datatypes (datatypes:list). To declare one (meta:define-datatype).',
    chaining: 'datatypes:catalog → datatypes:install { id } → work_items:create { kind } / blueprint dependencies.datatypes.',
    seeAlso: [
      'datatypes:install (install one from the catalog)',
      'datatypes:list (what is already installed)',
      'datatypes:get (inspect one before installing)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    limit: z.number().int().min(1).max(500).optional().describe('max rows (default 1000)'),
  }),
  async handler(args) {
    const reply = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
    const sql = getOrgPg().sql;
    const rows = await listApprovedPublishedDatatypes(sql, { limit: args.limit });
    return reply({
      ok: true,
      count: rows.length,
      datatypes: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        tier: r.tier,
        workItemKind: r.workItemKind,
        tags: r.tags,
      })),
    });
  },
});
