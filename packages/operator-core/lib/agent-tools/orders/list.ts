/**
 * orders:list — the owner-directives ledger for this workspace (EI-11484):
 * open (still owed) by default, or the full record with { open: false } /
 * omitted-open history. Bodies are capped here; orders:get returns the full
 * verbatim.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listOwnerDirectives } from '../../owner-directives';

const LIST_BODY_CAP = 500;

export default defineTool({
  name: 'orders:list',
  profile: 'engineer',
  description:
    'List recorded owner directives for this workspace — open (undispositioned, the ones still owed) with { open: true }, closed with { open: false }, all when omitted. Bodies capped at 500 chars (orders:get for full verbatim).',
  guidance: {
    when:
      'Orienting on what the workspace still OWES the owner (the wake/orient render shows the same set), before loop:end / wind-down, or auditing how past directives were dispositioned.',
    notWhen: 'You have the id and want the full verbatim — orders:get.',
    seeAlso: ['orders:get', 'orders:record', 'orders:disposition'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    open: z.boolean().optional().describe('true = only open; false = only dispositioned; omit = all.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';
    const rows = await listOwnerDirectives({ workspaceId, open: args.open, limit: args.limit });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rows.length,
            directives: rows.map((r) => ({
              id: r.id,
              open: r.dispositionedAtMs == null,
              captureStatus: r.captureStatus ?? 'open',
              ...(r.captureStatus === 'pending' ? { needsResolution: true } : {}),
              verbatim:
                r.verbatimText.length > LIST_BODY_CAP
                  ? `${r.verbatimText.slice(0, LIST_BODY_CAP)}… [orders:get #${r.id}]`
                  : r.verbatimText,
              recordedBy: r.recordedBy,
              createdAt: new Date(r.createdAtMs).toISOString(),
              ...(r.dispositionedAtMs != null
                ? {
                    dispositionStatus: r.dispositionStatus,
                    dispositionNote: r.dispositionNote,
                    dispositionedBy: r.dispositionedBy,
                    dispositionedAt: new Date(r.dispositionedAtMs).toISOString(),
                  }
                : {}),
            })),
          }),
        },
      ],
    };
  },
});
