/**
 * mode:get — read the current mode set of yourself or any agent
 * (modes-and-intake-ux-2026-07-05 P-006/P-007).
 *
 * The read side of modes-as-data: presence/orient show modes ambiently; this
 * is the direct point read (with optional full contracts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { modeById } from '../../modes/registry';
import { getModes } from '../../modes/store';

export default defineTool({
  name: 'mode:get',
  profile: 'engineer',
  description:
    "Read an agent's current modes: { agent? (default you), contracts? }. Returns active modes with axis, reason, " +
    'who set them, owner-sticky flag, and (contracts:true) the full binding contract text.',
  guidance: {
    when:
      "Before redirecting a peer (is it owner-directed? then request, don't override) or to re-read your own binding " +
      'contracts mid-session. Ambient visibility is already in coord:presence / coord:orient — reach for this for the detail.',
    notWhen: 'Fleet-wide mode surveys — read coord:presence once instead of N mode:get calls.',
    chaining: 'mode:get { agent } → mode:set { agent, mode, reason } (or a coord:send request when ownerDirected).',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().max(120).optional().describe('target ownerId (exact); omit for yourself'),
    contracts: z.boolean().optional().describe('include each active mode’s full contract text'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const target = args.agent?.trim() || ident.ownerId;
    const rows = await getModes(ident.workspaceId ?? 'default', target);
    const modes = rows.map((r) => {
      const def = modeById(r.mode);
      return {
        mode: r.mode,
        axis: def?.axis ?? r.axisKey,
        reason: r.reason,
        setBy: r.setBy,
        ownerDirected: r.ownerDirected,
        setAt: r.setAt,
        ...(args.contracts && def ? { contract: def.contract } : {}),
      };
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, agent: target, modes }) }] };
  },
});
