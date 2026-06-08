/**
 * locks:release_resource — release a held named-resource lock.
 *
 * Runs resource_grant_cascade inside the same txn: releasing the LAST
 * shared holder is exactly what completes a pending exclusive's drain (it
 * flips to held + NOTIFYs the waiter). Releasing an exclusive frees the
 * resource for new shared holders.
 *
 * NOTE (Phase 3, P-010): on an exclusive release we should also broadcast
 * "<resource> back up" to anyone who was refused while it was held. That
 * coord broadcast is not wired yet; the PG-side state is already correct.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryReleaseResource } from './su-lock-store';
import { broadcastResourceBackUp } from './resource-broadcast';

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'locks:release_resource',
  description:
    'Release a named-resource lock you hold — pass lock_id (preferred) or the resource name. Releasing the last shared holder completes a pending exclusive\'s drain; releasing an exclusive frees the resource.',
  guidance: {
    when: 'As soon as you are done using a shared resource, or immediately after an exclusive action (e.g. the dev-server restart) completes.',
    notWhen: 'While still using the resource. Do not release another agent\'s lock — release is owner-checked and only drops your own rows.',
    chaining: 'locks:acquire_resource → use/act → locks:release_resource { lock_id }.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    lock_id: z.string().uuid().optional(),
    resource: z.string().min(1).max(200).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    if (!args.lock_id && !args.resource) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: 'locks:release_resource requires lock_id or resource' }) },
        ],
      };
    }
    const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      tryReleaseResource(tx, {
        coordinationDomain,
        owner: ownerId,
        lockId: args.lock_id,
        resource: args.resource,
      }),
    );

    // P-010 + A4: releasing an exclusive frees the resource — tell the agents
    // who were WAITING on it (not the whole fleet) that it's back up.
    if (r.exclusiveResources.length > 0) {
      const coordId = resolveAgentIdentity(ctx);
      for (const res of r.exclusiveResources) {
        await broadcastResourceBackUp({ source: coordId, resource: res, waiters: r.waiters[res] ?? [] });
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            released: r.released,
            released_modes: r.releasedModes,
            exclusive_resources: r.exclusiveResources,
          }),
        },
      ],
    };
  },
});
