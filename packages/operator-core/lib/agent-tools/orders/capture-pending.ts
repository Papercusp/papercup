/** Hook-facing owner-turn capture. This is intentionally tiny and fail-soft at the caller. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { recordOwnerDirective, countOpenOwnerDirectives, OWNER_DIRECTIVE_VERBATIM_MAX } from '../../owner-directives';

export default defineTool({
  name: 'orders:capture-pending',
  profile: 'engineer',
  description: 'Capture an OWNER (interactive) prompt verbatim as a pending owner directive for next-turn promotion or dismissal.',
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    verbatim: z.string().min(4).max(OWNER_DIRECTIVE_VERBATIM_MAX),
    sourceTurnRef: z.string().min(1).max(300),
    sessionRef: z.string().max(300).optional(),
    ownerName: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';
    const row = await recordOwnerDirective({
      workspaceId,
      ownerId: args.ownerName,
      sessionRef: args.sessionRef ?? null,
      sourceTurnRef: args.sourceTurnRef,
      verbatimText: args.verbatim,
      recordedBy: identity.ownerId,
      captureStatus: 'pending',
    });
    const openCount = await countOpenOwnerDirectives(workspaceId).catch(() => null);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: row.id, captureStatus: row.captureStatus, ...(openCount == null ? {} : { openCount }) }) }] };
  },
});
