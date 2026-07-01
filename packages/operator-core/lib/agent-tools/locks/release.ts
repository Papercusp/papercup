/**
 * locks:release — release locks and fire the grant cascade.
 *
 * Inside the same transaction, runs grant_cascade(coordinationDomain, now())
 * which iterates FIFO waiters and grants any whose paths are now free.
 * NOTIFY fires inside the cascade function; the app doesn't need to
 * loop the result.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryRelease, releaseAllResourcesForOwner } from './su-lock-store';
import { broadcastResourceBackUp } from './resource-broadcast';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import { FILE_LOCK_OP_KINDS, type FileLockReleaseParams } from '../../authority/file-lock-authority-ops';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

export default defineTool({
  name: 'locks:release',
  description:
    'Release one or many held lock sets. Single: pass lock_id (with optional paths filter) or all_mine=true. Many: pass lock_ids:[…]. Fires the grant cascade for waiting agents.',
  guidance: {
    when: 'Immediately after the edit is committed. Release several selected lock sets at once via lock_ids:[…]. On context loss / restart, call with all_mine=true to release everything.',
    notWhen: 'Mid-edit. The lock should outlive the edit by enough that no other agent races between release and PR merge.',
    chaining: 'locks:acquire → edit → locks:release { lock_id } or { lock_ids:[…] }. Or: session-end → locks:release { all_mine: true }.',
    seeAlso: [
      'locks:release_granular (for a subtree/directory lock)',
      'locks:release_resource (for a named-resource lock)',
      'locks:heartbeat (extend a long edit instead of releasing early)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    lock_id: z.string().uuid().optional(),
    lock_ids: z.array(z.string().uuid()).min(1).max(200).optional(),
    paths: z.array(z.string()).optional(),
    all_mine: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const lockIds = mergeIds(args.lock_id, args.lock_ids);

    if (lockIds.length === 0 && !args.all_mine) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'locks:release requires lock_id or all_mine=true',
            }),
          },
        ],
      };
    }
    if (args.all_mine && lockIds.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'locks:release accepts either all_mine=true or selected lock_id(s), not both',
            }),
          },
        ],
      };
    }

    async function releaseFileLocks(lockId: string | undefined, allMine = false) {
      const localRelease = (): Promise<Awaited<ReturnType<typeof tryRelease>>> =>
        inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
          tryRelease(tx, {
            coordinationDomain,
            owner: ownerId,
            lockId,
            paths: args.paths,
            allMine,
          }),
        );

      try {
        const routed = await routeFileLockOp<Awaited<ReturnType<typeof tryRelease>>>(
          coordinationDomain,
          {
            local: localRelease,
            remote: {
              kind: FILE_LOCK_OP_KINDS.release,
              payload: {
                owner: ownerId,
                lockId,
                paths: args.paths,
                allMine,
                coordinationDomain,
              } satisfies FileLockReleaseParams,
              decode: (raw) => ({ released: (raw as { released?: string[] }).released ?? [] }),
            },
          },
        );
        return routed.value;
      } catch {
        return localRelease();
      }
    }

    if (lockIds.length > 0) {
      const env = await runBulk(
        lockIds,
        async (lockId) => {
          const result = await releaseFileLocks(lockId);
          return { ok: true as const, lock_id: lockId, released: result.released };
        },
        { keyOf: (lockId) => ({ lock_id: lockId }) },
      );
      return bulkContent(env);
    }

    // fed-reanchor-2026-06-06 P-060 (cutover 2): release through the SAME file-lock
    // authority the matching acquire routed to, so a lock taken on a remote authority's
    // store is actually freed there (else it lingers to TTL). N=1 → op.local() passthrough
    // (no peers); a routing fault degrades to the raw local release.
    //
    // Reached ONLY when lockIds.length===0 AND args.all_mine===true — the two guards above
    // enforce it (neither → error, both → error, any lock_id(s) → the bulk branch). Pass the
    // arg explicitly rather than a hardcoded literal so the all_mine intent stays coupled to
    // the caller (defense-in-depth if those guards ever change); tryRelease filters by
    // owner=ownerId, so all_mine only ever frees the CALLER's own locks (no cross-agent reach).
    const result = await releaseFileLocks(undefined, Boolean(args.all_mine));

    // Session-end (all_mine) also clears this owner's NAMED-resource locks
    // (P-019) — file locks and resource locks live in separate tables, so one
    // call must sweep both. Broadcast "back up" for any exclusive we freed.
    let resourcesReleased = 0;
    if (args.all_mine) {
      const rr = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        releaseAllResourcesForOwner(tx, coordinationDomain, ownerId),
      );
      resourcesReleased = rr.released;
      if (rr.exclusiveResources.length > 0) {
        const coordId = resolveAgentIdentity(ctx);
        for (const res of rr.exclusiveResources) {
          await broadcastResourceBackUp({ source: coordId, resource: res, waiters: rr.waiters[res] ?? [] }).catch(() => {});
        }
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            released: result.released,
            resources_released: resourcesReleased,
            owner: ownerId,
            owner_label: ownerLabel,
          }),
        },
      ],
    };
  },
});
