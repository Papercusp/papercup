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
import { hostGlobalLockDomain, workspaceScopedLockDomain } from './coordination-domain';
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
    // `locks:list` report it as unheld).
    //
    // EI-21733256625452096: those two fixes each taught the SCOPED branch one
    // more name-shaped special case, and the branch stayed wrong for every
    // resource whose name does not advertise its domain. `libs-papercusp-submodule`
    // is the live case: git-sync acquires EVERY lock in its set — the restart
    // barrier, `git-sync:<slug>`, AND each `trigger_config.extra_lock_resources`
    // name — under one `cd = workspaceId || '*'` (git-sync-action.ts's
    // `handleGitSync`), but the extras match neither HOST_GLOBAL_RESOURCES nor
    // isWorkspaceScopedResource(), so this branch looked in the caller's tree
    // domain and reported `holders: []` for a lock held, exclusive and
    // unexpired, under the workspace domain (falsified against
    // agent_resource_locks 21:20:11Z, reproduced 8 min apart).
    //
    // So stop INFERRING the one right domain from the name and query all the
    // domains actually in play, exactly as the unscoped branch already did.
    // The asymmetry was the whole defect: the same call answered truthfully
    // when unscoped and falsely when scoped to one resource. Over-reporting a
    // holder from another domain is safe (a reader waits); under-reporting
    // reads as permission to write on a resource a peer holds, and enforcement
    // on these rows is `advisory`, so nothing downstream would stop it.
    const hgDomain = hostGlobalLockDomain();
    const wsDomain = workspaceScopedLockDomain();
    const domains = [...new Set([callerDomain, hgDomain, wsDomain])];

    const queues = await Promise.all(
      domains.map(async (coordinationDomain) => ({
        coordinationDomain,
        queue: await readResourceQueue(pool, { coordinationDomain, resource: args.resource }),
      })),
    );
    // Stamp the domain each row came from: merging several domains makes an
    // unlabelled holder list ambiguous about WHICH namespace holds the lock,
    // and that is precisely what a reader needs in order to act on it.
    const holders = queues.flatMap(({ coordinationDomain, queue }) =>
      queue.holders.map((h) => ({ ...holderJson(h), coordination_domain: coordinationDomain })),
    );
    const draining = queues.some(({ queue }) => queue.draining);

    // {data} envelope so the payload-tier shapers apply.
    return {
      data: {
        ok: true,
        resources: registry.map(registryJson),
        holders,
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
