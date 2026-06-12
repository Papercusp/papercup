/**
 * hive:cross_grant — owner management of cross-Hive capability grants
 * (cross-hive-boundary-2026-06-08 P-002; hive-network-surface-2026-06-11 P-004 B-05).
 * Grant / revoke / list which peer-Hive pubkeys may exchange which kinds
 * (ask | work-request) with this Hive, DIRECTED:
 *
 *   direction:'in'  — peers sending INTO this Hive (admission; admitCrossHiveEnvelope).
 *   direction:'out' — this Hive sending TO a peer (egress; admitOutboundCrossHive). The
 *                     Queen cannot ask / request work from a peer until the owner grants
 *                     it `out`.
 *
 * Default-deny in BOTH directions. Grants live in hive_settings, so they federate to every
 * Swarm of this Hive (uniform policy).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  loadDirectedCrossHiveGrants,
  setCrossHiveGrant,
  revokeCrossHiveGrant,
} from '../../cross-hive-grants';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'hive:cross_grant',
  profile: 'engineer',
  description:
    "Owner cross-Hive capability grants: grant/revoke which peer-Hive pubkeys may exchange which kinds (ask | work-request) with this Hive, or list current grants. DIRECTED — direction:'in' admits a peer's asks/work-requests INTO this Hive; direction:'out' lets THIS Hive send asks/work-requests TO a peer (required before the Queen can ask another Hive). Default-deny both directions; every grant is quota-capped (maxPerHour / maxBodyBytes, defaults 60/hr + 64KiB) and optionally expiring (expiresInHours). Grants federate to all of this Hive's Swarms.",
  guidance: {
    when: "Setting this Hive's cross-Hive policy: direction:'in' admits a peer Hive's asks/work-requests; direction:'out' authorizes ours to it (owner-gated before the Queen's first hive:ask to a new peer). Also list/revoke. maxPerHour/maxBodyBytes/expiresInHours tune a grant's quota/expiry (capped defaults otherwise).",
    notWhen:
      'Within-Hive coordination (coord:* / topics) or placing work on a Swarm (work_items:co_locate). This is ONLY the sovereignty boundary between separate Hives.',
    chaining:
      'discovery:hives (peer pubkey) → hive:cross_grant { action:"grant", direction, peerHivePubkey, kinds } — direction:"out" before hive:ask / hive:request_work.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().min(1).max(120).describe("This Hive's home slug (grants are Hive-scoped + federate to its Swarms)."),
    action: z.enum(['grant', 'revoke', 'list']),
    direction: z
      .enum(['in', 'out'])
      .optional()
      .describe("Grant direction: 'in' (peers→this Hive, admission) or 'out' (this Hive→peers, egress). Default 'in'."),
    peerHivePubkey: z.string().max(400).optional().describe('The peer Hive\'s pubkey (required for grant/revoke).'),
    kinds: z
      .array(z.enum(['ask', 'work-request']))
      .optional()
      .describe('Kinds to grant (grant action; default ["ask"]). An empty array clears the grant.'),
    maxPerHour: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('P-013 quota: max requests per rolling hour with this peer (default 60). Omitted on a re-grant = keep the existing value.'),
    maxBodyBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('P-013 quota: max request body size in bytes (default 65536). Omitted on a re-grant = keep the existing value.'),
    expiresInHours: z
      .number()
      .positive()
      .optional()
      .describe('P-013 expiry: void the grant after this many hours. Omitted on a re-grant = keep the existing expiry; revoke + re-grant to clear one.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    const direction = args.direction ?? 'in';
    if (args.action === 'list') {
      return json({ ok: true, action: 'list', hive: args.hive, grants: await loadDirectedCrossHiveGrants(ws, args.hive) });
    }
    if (!args.peerHivePubkey) {
      return json({ ok: false, error: 'peerHivePubkey is required for grant/revoke' });
    }
    if (args.action === 'grant') {
      await setCrossHiveGrant(ws, args.hive, args.peerHivePubkey, args.kinds ?? ['ask'], direction, undefined, {
        ...(args.maxPerHour != null ? { maxPerHour: args.maxPerHour } : {}),
        ...(args.maxBodyBytes != null ? { maxBodyBytes: args.maxBodyBytes } : {}),
        ...(args.expiresInHours != null ? { expiresAt: Date.now() + args.expiresInHours * 3_600_000 } : {}),
      });
    } else {
      await revokeCrossHiveGrant(ws, args.hive, args.peerHivePubkey, direction);
    }
    return json({
      ok: true,
      action: args.action,
      direction,
      hive: args.hive,
      grants: await loadDirectedCrossHiveGrants(ws, args.hive),
    });
  },
});
