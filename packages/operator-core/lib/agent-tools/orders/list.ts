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
import { listOwnerDirectives, OWNER_DIRECTIVE_STATES, ownerDirectiveState } from '../../owner-directives';
import { listClearedDirectiveIds } from '../../owner-directive-agenda';
import { resolveAgentIdentity } from '../coordination/identity';

const LIST_BODY_CAP = 500;

export default defineTool({
  name: 'orders:list',
  profile: 'engineer',
  description:
    'List recorded owner directives for this workspace — open (undispositioned, the ones still owed) with { open: true }, closed with { open: false }, all when omitted. Bodies capped at 500 chars (orders:get for full verbatim).',
  guidance: {
    when:
      'Orienting on what the workspace still OWES the owner (the wake/orient render shows the same set), before loop:end / wind-down, or auditing how past directives were dispositioned. Use { state } to isolate one lifecycle stage — state:"pending" for the hook-captured queue awaiting promote/dismiss, state:"dismissed" for the audit trail of turns ruled not-directives.',
    notWhen:
      'You have the id and want the full verbatim — orders:get. Do NOT filter the returned page client-side on captureStatus: `limit` truncates in SQL first, so a match can be cut before you see it — pass { state } instead.',
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
        z.array(z.enum(OWNER_DIRECTIVE_STATES as unknown as [string, ...string[]])).min(1).max(5),
      ])
      .optional()
      .describe(
        "Exact lifecycle state(s): pending | open | dismissed | done | declined. The ONLY way to isolate the pending queue or the dismissed audit trail — `open` is a boolean over a five-state lifecycle, so it bundles pending with open and dismissed with done/declined. Applied in SQL before `limit`.",
      ),
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
              captureStatus: r.captureStatus ?? 'open',
              ...(r.captureStatus === 'pending' ? { needsResolution: true } : {}),
              ...(clearedByMe.has(r.id)
                ? { clearedFromYourAgenda: true, clearedNote: 'Cleared from YOUR banner only — still open for its addressee. orders:resolve-pending { action: \'clear\' } is reversible.' }
                : {}),
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
