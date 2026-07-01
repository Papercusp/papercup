/**
 * datatypes:install — install an APPROVED global datatype into your workspace
 * (reflexive-platform-extensibility-datatypes-2026-06-24 D-010 distribution).
 *
 * Copies an approved published datatype's definition (from datatypes:catalog) into THIS
 * workspace as a LOCAL datatype, so it's usable like one you declared (a generic-kind's
 * work_item_kind becomes accepted; a blueprint can depend on it). The approved source is
 * globally readable (migration 426); the copy is written into the caller's own workspace
 * (RLS WITH CHECK), so an agent can only install INTO its own workspace. Idempotent.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { installPublishedDatatype } from '../../datatype-registry-store';

export default defineTool({
  name: 'datatypes:install',
  description:
    'Install an APPROVED global datatype (from datatypes:catalog) into your workspace — copies its definition ' +
    'as a LOCAL datatype you can use like one you declared. Idempotent: already-present ⇒ no change.',
  guidance: {
    when: 'After finding a useful approved datatype via datatypes:catalog — install it so this workspace can create instances / reference it.',
    notWhen: 'To declare a NEW datatype (meta:define-datatype). To publish one (datatypes:publish).',
    chaining: 'datatypes:catalog → datatypes:install { id } → work_items:create { kind } / dependencies.datatypes.',
    seeAlso: [
      'datatypes:catalog (browse the global catalog to install from)',
      'datatypes:list (what is already installed)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('the approved datatype id to install (from datatypes:catalog)'),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      return reply({ ok: false, reason: 'no_workspace', message: 'no workspace in the request context' });
    }
    const res = await installPublishedDatatype(sql, args.id, workspaceId);
    if (!res.ok) {
      return reply({
        ok: false,
        reason: res.reason,
        message:
          res.reason === 'not_found'
            ? `no APPROVED global datatype "${args.id}" — browse datatypes:catalog for installable ones`
            : `"${args.id}" is already present in this workspace`,
      });
    }
    return reply({
      ok: true,
      datatype: res.datatype,
      note:
        `installed "${res.datatype.id}" into this workspace — now usable locally` +
        (res.datatype.tier === 'generic-kind' && res.datatype.workItemKind
          ? ` (work_items:create { kind:"${res.datatype.workItemKind}" }).`
          : '.'),
    });
  },
});
