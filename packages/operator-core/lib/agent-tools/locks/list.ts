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
import {
  hostGlobalLockDomain,
  HOST_GLOBAL_RESOURCES,
  isWorkspaceScopedResource,
  workspaceScopedLockDomain,
} from './coordination-domain';
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
    resource: h.resource,
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
    'List registered named resources (name, rule, enforcement level) and who currently holds each, with a draining flag. This is a workspace-global lock diagnostic: omit workspace/harness and pass resource only when narrowing. The authoritative discovery surface for resource locks — only registered names are acquirable.',
  guidance: {
    when: 'Before acquiring a named resource (to learn the exact name + the rule), or to see who holds a resource / whether it is draining. This is workspace-global: omit workspace/harness and pass only resource.',
    notWhen: 'File-lock contention — that is locks:queue.',
    chaining: 'Workspace-global diagnostic (omit workspace/harness) → locks:list { resource? } → locks:acquire_resource { resource, mode }.',
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

    // EI-18674647773291145 Defect 2 / WI-5960: a special-domain resource (a
    // host-global one like 'release-deploy', OR a workspace-scoped one like
    // `git-sync:<slug>`) is acquired under a DIFFERENT domain than the
    // caller-tree-scoped one readIdentity resolves — querying only the
    // caller's domain here is exactly what produced a false `holders: []`
    // for a lock provably held elsewhere (observed live for both families:
    // 'release-deploy' under EI-18674647773291145, `git-sync:<slug>` under
    // WI-5960 — an su that had genuinely acquired the tree-pause lock saw
    // `locks:list` report it as unheld). When the caller scoped the query to
    // one such resource, follow it into its real domain; when unscoped
    // (listing everything), query every domain that's actually in play and
    // merge, so an unscoped `locks:list` can never silently omit a
    // special-domain resource's holders just because the caller happens to
    // be running from a different tree / a different workspace.
    const hgDomain = hostGlobalLockDomain();
    const wsDomain = workspaceScopedLockDomain();
    const domains = args.resource
      ? [
          HOST_GLOBAL_RESOURCES.has(args.resource)
            ? hgDomain
            : isWorkspaceScopedResource(args.resource)
              ? wsDomain
              : callerDomain,
        ]
      : [...new Set([callerDomain, hgDomain, wsDomain])];

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
        // EI-19400582907190258: this result enumerates the NAMED-RESOURCE lock
        // plane only (dev:restart, db:migrate, git-sync:<slug>, …) — rows carry
        // no `path` field at all. A caller asking "does a peer hold THIS FILE"
        // (the file-lock plane — locks:acquire/locks:acquireGranular/locks:queue)
        // gets zero matches here no matter what, which reads exactly like "safe
        // to edit" and is not. Stamp the plane + a pointer directly on the
        // result so that reading is caught even when the tool's own `notWhen`
        // guidance was skipped — an empty `holders: []` here proves nothing
        // about a specific file.
        plane: 'resource' as const,
        fileLockHint: 'This is the NAMED-RESOURCE lock plane, not file locks. To check whether a peer holds a specific FILE path, use locks:queue { paths: [...] } instead — an empty result here never answers that question.',
      },
    };
  },
});
