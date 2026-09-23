/**
 * orders:list — the owner-directives ledger for this workspace (EI-11484):
 * open (still owed) by default, or the full record with { open: false } /
 * omitted-open history. Nothing is truncated (D-004 of
 * owner-directive-delivery-redesign-2026-09-22): a directive within the verbatim
 * cap is returned whole; a longer one carries its agent summary and the
 * orders:get pointer to the full verbatim.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  directiveNeedsSummary,
  listOwnerDirectives,
  OWNER_DIRECTIVE_STATES,
  OWNER_DIRECTIVE_VERBATIM_CAP,
  ownerDirectiveState,
} from '../../owner-directives';
import { listClearedDirectiveIds } from '../../owner-directive-agenda';
import { resolveAgentIdentity } from '../coordination/identity';

export default defineTool({
  name: 'orders:list',
  profile: 'engineer',
  description: `List recorded owner directives for this workspace — open (the ones still owed) with { open: true }, closed with { open: false }, all when omitted. Directives ≤ ${OWNER_DIRECTIVE_VERBATIM_CAP} chars come back verbatim; longer ones as their agent summary + an orders:get pointer.`,
  guidance: {
    when:
      'Orienting on what the workspace still OWES the owner, before loop:end / wind-down, or auditing how past directives were closed. Use { state } to separate done from declined.',
    notWhen:
      'You have the id and want the full verbatim — orders:get. Do NOT filter the returned page client-side: `limit` truncates in SQL first, so a match can be cut before you see it — pass { state } instead.',
    seeAlso: ['orders:get', 'orders:record', 'orders:disposition'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    open: z.boolean().optional().describe('true = only open; false = only dispositioned; omit = all.'),
    state: z
      .union([
        z.enum(OWNER_DIRECTIVE_STATES as unknown as [string, ...string[]]),
        z.array(z.enum(OWNER_DIRECTIVE_STATES as unknown as [string, ...string[]])).min(1).max(3),
      ])
      .optional()
      .describe('Exact lifecycle state(s): open | done | declined. Applied in SQL before `limit`.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';
    const rows = await listOwnerDirectives({
      workspaceId,
      open: args.open,
      state: args.state as Parameters<typeof listOwnerDirectives>[0]['state'],
      limit: args.limit,
    });
    // This is the LEDGER, so it deliberately does NOT apply `viewerOwnerId`:
    // the rows you cleared off your own banner must stay findable here, or
    // `clear` becomes an untraceable disappearance rather than a per-session
    // agenda action. They are ANNOTATED instead — that annotation is also what
    // explains why a row visible here is absent from your Orientation banner.
    let clearedByMe = new Set<number>();
    try {
      const ownerId = resolveAgentIdentity(ctx).ownerId;
      clearedByMe = await listClearedDirectiveIds({ ownerId, workspaceId });
    } catch {
      /* unattributable caller — no agenda to annotate against */
    }
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
              state: ownerDirectiveState(r),
              ...(clearedByMe.has(r.id)
                ? { clearedFromYourAgenda: true, clearedNote: 'Cleared from YOUR banner only (orders:clear) — still open for its addressee.' }
                : {}),
              ...(directiveNeedsSummary(r)
                ? {
                    summary: r.summaryText ?? null,
                    summaryBy: r.summaryBy ?? null,
                    verbatimChars: r.verbatimText.trim().length,
                    fullText: `orders:get #${r.id}`,
                  }
                : { verbatim: r.verbatimText.trim() }),
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
