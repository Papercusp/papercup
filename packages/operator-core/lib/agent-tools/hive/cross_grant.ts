/**
 * hive:cross_grant — owner management of cross-Hive capability grants
 * (cross-hive-boundary-2026-06-08 P-002). Grant / revoke / list which peer-Hive pubkeys
 * may send which kinds (ask | work-request) INTO this Hive. Default-deny: only granted
 * peer-Hives are admitted at the boundary (admitCrossHiveEnvelope). Grants live in
 * hive_settings, so they federate to every Swarm of this Hive (uniform admission policy).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadCrossHiveGrants, setCrossHiveGrant, revokeCrossHiveGrant } from '../../cross-hive-grants';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'hive:cross_grant',
  profile: 'engineer',
  description:
    'Owner cross-Hive capability grants: grant/revoke which peer-Hive pubkeys may send which kinds (ask | work-request) INTO this Hive, or list current grants. Default-deny — only granted peer-Hives are admitted at the cross-Hive boundary. Grants federate to all of this Hive\'s Swarms.',
  guidance: {
    when: 'Setting this Hive\'s cross-Hive admission policy: allow a peer Hive (by pubkey, from discovery:hives) to send asks/work-requests, revoke a peer, or review the current grants.',
    notWhen: 'Within-Hive coordination (coord:* / topics) or placing work on a Swarm (work_items:co_locate). This is ONLY the sovereignty boundary between separate Hives.',
    chaining: 'discovery:hives (find a peer Hive\'s pubkey) → hive:cross_grant { action: "grant", peerHivePubkey, kinds }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().min(1).max(120).describe("This Hive's home slug (grants are Hive-scoped + federate to its Swarms)."),
    action: z.enum(['grant', 'revoke', 'list']),
    peerHivePubkey: z.string().max(400).optional().describe('The peer Hive\'s pubkey (required for grant/revoke).'),
    kinds: z
      .array(z.enum(['ask', 'work-request']))
      .optional()
      .describe('Kinds to grant (grant action; default ["ask"]). An empty array clears the grant.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    if (args.action === 'list') {
      return json({ ok: true, action: 'list', hive: args.hive, grants: await loadCrossHiveGrants(ws, args.hive) });
    }
    if (!args.peerHivePubkey) {
      return json({ ok: false, error: 'peerHivePubkey is required for grant/revoke' });
    }
    if (args.action === 'grant') {
      await setCrossHiveGrant(ws, args.hive, args.peerHivePubkey, args.kinds ?? ['ask']);
    } else {
      await revokeCrossHiveGrant(ws, args.hive, args.peerHivePubkey);
    }
    return json({ ok: true, action: args.action, hive: args.hive, grants: await loadCrossHiveGrants(ws, args.hive) });
  },
});
