/**
 * locks:acquire_resource — acquire a NAMED resource (shared/exclusive).
 *
 * Sibling to locks:acquire (which is file-path + exclusive only). A named
 * resource (registered in agent_resource_registry) takes MANY shared
 * holders + at most ONE exclusive holder, gated by a writer-priority
 * drain (plan named-resource-locks-drain; D-009 separate table, D-010
 * registered-names-only). For mode 'exclusive' with wait.max_drain_sec>0,
 * blocks until shared holders drain or the timeout fires.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryAcquireResource, type ResourceHolder } from './su-lock-store';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';
import { broadcastResourceDrainStart } from './resource-broadcast';
import { hardText, LIMITS } from '../limits';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC, MAX_LOCK_WAIT_SEC as MAX_WAIT_SEC } from './lock-config';

function holderJson(h: ResourceHolder) {
  return {
    owner: h.owner,
    owner_label: h.owner_label,
    mode: h.mode,
    status: h.status,
    reason: h.reason,
    expires_ts: h.expires_ts.toISOString(),
  };
}

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'locks:acquire_resource',
  description:
    'Acquire a NAMED resource (must be registered; see locks:list). mode:"shared" = "I am using it" (many coexist); mode:"exclusive" = "I need to restart/mutate it" (granted only once shared holders drain to zero). For exclusive, set wait:{max_drain_sec:N} (≤300) to block while existing shared holders finish — new shared acquisitions are refused meanwhile. Release with locks:release_resource.',
  guidance: {
    when: 'Before relying on a shared resource (mode shared), or before a destructive action on it like restarting the dev server (mode exclusive). Registered resources only — check locks:list.',
    notWhen: 'File edits — use locks:acquire only for deliberate multi-file claims or when hook diagnostics say the per-edit hook is unavailable. An unregistered ad-hoc name — register it first (locks are useless if names diverge).',
    chaining: 'shared: acquire_resource{mode:shared} → use it → release_resource. exclusive restart: acquire_resource{mode:exclusive,wait:{max_drain_sec}} → on ok+held do the restart → release_resource (signals it is back up).',
  },
  capability: 'locks:write',
  // exclusive wait can block up to max_drain_sec; bump past it with margin.
  timeoutSec: MAX_WAIT_SEC + 30,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    resource: z.string().min(1).max(200),
    mode: z.enum(['shared', 'exclusive']),
    reason: hardText(LIMITS.ANNOTATION).optional(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    wait: z
      .object({ max_drain_sec: z.number().int().nonnegative().max(MAX_WAIT_SEC) })
      .optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    const reason = args.reason ?? '';

    if (args.mode === 'shared') {
      const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryAcquireResource(tx, {
          coordinationDomain,
          resource: args.resource,
          mode: 'shared',
          owner: ownerId,
          ownerLabel,
          reason,
          ttlSec,
        }),
      );
      if (!r.ok) return json({ ok: false, reason: r.reason, holders: r.holders.map(holderJson) });
      return json({
        ok: true,
        lock_id: r.lock_id,
        mode: 'shared',
        status: r.status,
        owner: ownerId,
        expires_ts: r.expires_ts.toISOString(),
      });
    }

    // exclusive
    const maxWaitSec = args.wait?.max_drain_sec ?? 0;
    const coordId = resolveAgentIdentity(ctx);
    const r = await acquireResourceExclusiveWithWait({
      coordinationDomain,
      owner: ownerId,
      ownerLabel,
      resource: args.resource,
      reason,
      ttlSec,
      maxWaitSec,
      // P-009: tell the shared holders to release when the drain begins.
      onDrainStart: (holders) =>
        broadcastResourceDrainStart({ source: coordId, resource: args.resource, holders, reason }),
    });

    if (r.ok && r.status === 'held') {
      return json({
        ok: true,
        lock_id: r.lock_id,
        mode: 'exclusive',
        status: 'held',
        owner: ownerId,
        waited_sec: r.waited_sec,
        // D-001 fencing token — pass to a downstream action's stale-fence check.
        fence_seq: r.fence_seq,
      });
    }
    if (r.ok && r.status === 'draining') {
      // maxWaitSec was 0 — accepted but not yet effective; caller decides.
      return json({
        ok: true,
        lock_id: r.lock_id,
        mode: 'exclusive',
        status: 'draining',
        owner: ownerId,
        holders: r.holders.map(holderJson),
      });
    }
    if (!r.ok && r.reason === 'drain_timeout') {
      return json({
        ok: false,
        reason: 'drain_timeout',
        lock_id: r.lock_id,
        waited_sec: r.waited_sec,
        holders: r.holders.map(holderJson),
      });
    }
    // conflict (held_exclusive / holds_shared / unknown_resource)
    return json({ ok: false, reason: r.reason, holders: (r.holders ?? []).map(holderJson) });
  },
});
