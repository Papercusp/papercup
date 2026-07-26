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
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { hostGlobalLockDomain, HOST_GLOBAL_RESOURCES } from './coordination-domain';
import {
  getTxPool,
  getResource,
  listResources,
  readResourceQueue,
  type ResourceHolder,
  type ResourceRegistryRow,
} from './su-lock-store';
import { shapeLocksList } from './list-shape';

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
    seeAlso: [
      'locks:acquire_resource (acquire a resource you found)',
      'locks:queue (file-lock contention, not named resources)',
    ],
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    resource: z.string().min(1).max(200).optional(),
  }),
  // context-trimming-tiers P-023: trimmed/standard sessions get clipped
  // registry rules + lean holder rows (see list-shape.ts). NOT hook-consumed
  // (only locks:acquire/release/check_command are), so the {data} conversion
  // is safe.
  shape: {
    standard: (data) => shapeLocksList(data, 'standard'),
    trimmed: (data) => shapeLocksList(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const { coordinationDomain: callerDomain } = readIdentity(ctx);
    const pool = getTxPool();

    const registry = args.resource
      ? [await getResource(pool, args.resource)].filter((r): r is ResourceRegistryRow => r !== null)
      : await listResources(pool);

    // EI-18674647773291145 Defect 2: a host-global resource (e.g. 'release-deploy')
    // is acquired under hostGlobalLockDomain(), NOT the caller-tree-scoped domain
    // readIdentity resolves — querying only the caller's domain here is exactly what
    // produced a false `holders: []` for a lock provably held elsewhere. When the
    // caller scoped the query to one such resource, follow it into its real domain;
    // when unscoped (listing everything), query BOTH domains and merge so an
    // unscoped `locks:list` can never silently omit a host-global resource's
    // holders just because the caller happens to be running from a different tree.
    const hgDomain = hostGlobalLockDomain();
    const domains = args.resource
      ? [HOST_GLOBAL_RESOURCES.has(args.resource) ? hgDomain : callerDomain]
      : callerDomain === hgDomain
        ? [callerDomain]
        : [callerDomain, hgDomain];

    const queues = await Promise.all(
      domains.map((coordinationDomain) => readResourceQueue(pool, { coordinationDomain, resource: args.resource })),
    );
    const holders = queues.flatMap((q) => q.holders);
    const draining = queues.some((q) => q.draining);

    // {data} envelope so the payload-tier shapers apply.
    return {
      data: {
        ok: true,
        resources: registry.map(registryJson),
        holders: holders.map(holderJson),
        draining,
      },
    };
  },
});
