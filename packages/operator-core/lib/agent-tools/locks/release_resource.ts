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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryReleaseResource } from './su-lock-store';
import { broadcastResourceBackUp } from './resource-broadcast';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const releaseItem = z.object({
  lock_id: z.string().uuid().optional(),
  resource: z.string().min(1).max(200).optional(),
}).refine((i) => Boolean(i.lock_id) || Boolean(i.resource), {
  message: 'each item requires lock_id or resource',
});

export default defineTool({
  name: 'locks:release_resource',
  description:
    'Release one or many named-resource locks you hold. Single: pass lock_id (preferred) or resource. Many: pass lock_ids:[…], resources:[…], or items:[{lock_id|resource}].',
  guidance: {
    when: 'As soon as you are done using a shared resource, or immediately after an exclusive action (e.g. the dev-server restart) completes. Release several selected resource locks at once via lock_ids/resources/items.',
    notWhen: 'While still using the resource. Do not release another agent\'s lock — release is owner-checked and only drops your own rows.',
    chaining: 'locks:acquire_resource → use/act → locks:release_resource { lock_id } or { lock_ids:[…] }.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    lock_id: z.string().uuid().optional(),
    lock_ids: z.array(z.string().uuid()).min(1).max(200).optional(),
    resource: z.string().min(1).max(200).optional(),
    resources: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
    items: z.array(releaseItem).min(1).max(200).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const lockIds = mergeIds(args.lock_id, args.lock_ids);
    const resources = [...(args.resource ? [args.resource] : []), ...(args.resources ?? [])];
    const bulkItems = args.items?.length
      ? args.items
      : [
          ...lockIds.map((lock_id) => ({ lock_id })),
          ...resources.map((resource) => ({ resource })),
        ];

    if (bulkItems.length === 0) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: 'locks:release_resource requires lock_id or resource' }) },
        ],
      };
    }

    async function releaseOne(item: z.infer<typeof releaseItem>) {
      const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryReleaseResource(tx, {
          coordinationDomain,
          owner: ownerId,
          lockId: item.lock_id,
          resource: item.resource,
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

      return r;
    }

    if (args.items?.length || args.lock_ids?.length || args.resources?.length) {
      const env = await runBulk(
        bulkItems,
        async (item) => {
          const r = await releaseOne(item);
          return {
            ok: true as const,
            ...(item.lock_id ? { lock_id: item.lock_id } : {}),
            ...(item.resource ? { resource: item.resource } : {}),
            released: r.released,
            released_modes: r.releasedModes,
            exclusive_resources: r.exclusiveResources,
          };
        },
        {
          keyOf: (item) => ({
            ...(item.lock_id ? { lock_id: item.lock_id } : {}),
            ...(item.resource ? { resource: item.resource } : {}),
          }),
        },
      );
      return bulkContent(env);
    }

    const r = await releaseOne(bulkItems[0]!);

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
