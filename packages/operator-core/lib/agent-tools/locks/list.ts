/**
 * locks:list — discover registered named resources + their live state.
 *
 * The authoritative answer to "what named locks exist, how strict is each,
 * and who holds them right now" (P-013 + P-014). Returns the registry
 * (resource, rule_text, enforcement) and the live holders for the caller's
 * coordination domain, with a draining flag per resource. Pass `resource`
 * to scope to one.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import {
  getTxPool,
  getResource,
  listResources,
  readResourceQueue,
  type ResourceHolder,
  type ResourceRegistryRow,
} from './su-lock-store';

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

function holderJson(h: ResourceHolder) {
  return {
    owner: h.owner,
    owner_label: h.owner_label,
    mode: h.mode,
    status: h.status,
    reason: h.reason,
    acquired_ts: h.acquired_ts.toISOString(),
    expires_ts: h.expires_ts.toISOString(),
  };
}

function registryJson(r: ResourceRegistryRow) {
  return {
    resource: r.resource,
    description: r.description,
    rule_text: r.rule_text,
    enforcement: r.enforcement,
  };
}

export default defineTool({
  name: 'locks:list',
  description:
    'List registered named resources (name, rule, enforcement level) and who currently holds each, with a draining flag. The authoritative discovery surface for resource locks — only registered names are acquirable.',
  guidance: {
    when: 'Before acquiring a named resource (to learn the exact name + the rule), or to see who holds a resource / whether it is draining.',
    notWhen: 'File-lock contention — that is locks:queue.',
    chaining: 'locks:list → locks:acquire_resource { resource, mode }.',
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    resource: z.string().min(1).max(200).optional(),
  }),
  async handler(args, ctx) {
    const { coordinationDomain } = readIdentity(ctx);
    const pool = getTxPool();

    const registry = args.resource
      ? [await getResource(pool, args.resource)].filter((r): r is ResourceRegistryRow => r !== null)
      : await listResources(pool);

    const queue = await readResourceQueue(pool, {
      coordinationDomain,
      resource: args.resource,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            resources: registry.map(registryJson),
            holders: queue.holders.map(holderJson),
            draining: queue.draining,
          }),
        },
      ],
    };
  },
});
