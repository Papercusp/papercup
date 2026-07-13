/**
 * orders:get — one owner directive, FULL VERBATIM (EI-11484). The render
 * points excerpt long rows with substr + a pointer to this tool; this is the
 * pointer's target.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getOwnerDirective } from '../../owner-directives';

export default defineTool({
  name: 'orders:get',
  profile: 'engineer',
  description:
    'Fetch one recorded owner directive by id — the FULL verbatim text plus provenance and disposition. The target of the "[orders:get #id]" pointer the budgeted wake/orient render leaves on long rows.',
  guidance: {
    when: 'A wake/orient render or orders:list showed a truncated directive and you need the owner\'s full words before acting.',
    notWhen: 'Browsing the set — orders:list.',
    seeAlso: ['orders:list', 'orders:disposition'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.number().int().positive().describe('The directive id.'),
  }),
  async handler(args) {
    const row = await getOwnerDirective(args.id);
    if (!row) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'not_found', id: args.id }) }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            directive: {
              id: row.id,
              open: row.dispositionedAtMs == null,
              verbatim: row.verbatimText,
              owner: row.ownerId,
              recordedBy: row.recordedBy,
              sessionRef: row.sessionRef,
              sourceTurnRef: row.sourceTurnRef,
              createdAt: new Date(row.createdAtMs).toISOString(),
              ...(row.dispositionedAtMs != null
                ? {
                    dispositionStatus: row.dispositionStatus,
                    dispositionNote: row.dispositionNote,
                    dispositionedBy: row.dispositionedBy,
                    dispositionedAt: new Date(row.dispositionedAtMs).toISOString(),
                  }
                : {}),
            },
          }),
        },
      ],
    };
  },
});
