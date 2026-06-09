/**
 * locks:release — release locks and fire the grant cascade.
 *
 * Inside the same transaction, runs grant_cascade(coordinationDomain, now())
 * which iterates FIFO waiters and grants any whose paths are now free.
 * NOTIFY fires inside the cascade function; the app doesn't need to
 * loop the result.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryRelease, releaseAllResourcesForOwner } from './su-lock-store';
import { broadcastResourceBackUp } from './resource-broadcast';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import { FILE_LOCK_OP_KINDS, type FileLockReleaseParams } from '../../authority/file-lock-authority-ops';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'locks:release',
  description:
    'Release a held lock set. Pass lock_id (with optional paths filter) for a specific lock, or all_mine=true to release every lock owned by this agent. Fires the grant cascade for waiting agents.',
  guidance: {
    when: 'Immediately after the edit is committed. On context loss / restart, call with all_mine=true to release everything.',
    notWhen: 'Mid-edit. The lock should outlive the edit by enough that no other agent races between release and PR merge.',
    chaining: 'locks:acquire → edit → locks:release { lock_id }. Or: session-end → locks:release { all_mine: true }.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    lock_id: z.string().uuid().optional(),
    paths: z.array(z.string()).optional(),
    all_mine: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);

    if (!args.lock_id && !args.all_mine) {
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

    // fed-reanchor-2026-06-06 P-060 (cutover 2): release through the SAME file-lock
    // authority the matching acquire routed to, so a lock taken on a remote authority's
    // store is actually freed there (else it lingers to TTL). N=1 → op.local() passthrough
    // (no peers); a routing fault degrades to the raw local release.
    const localRelease = (): Promise<Awaited<ReturnType<typeof tryRelease>>> =>
      inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
        tryRelease(tx, {
          coordinationDomain,
          owner: ownerId,
          lockId: args.lock_id,
          paths: args.paths,
          allMine: args.all_mine,
        }),
      );

    let result: Awaited<ReturnType<typeof tryRelease>>;
    try {
      const routed = await routeFileLockOp<Awaited<ReturnType<typeof tryRelease>>>(
        coordinationDomain,
        {
          local: localRelease,
          remote: {
            kind: FILE_LOCK_OP_KINDS.release,
            payload: {
              owner: ownerId,
              lockId: args.lock_id,
              paths: args.paths,
              allMine: args.all_mine,
              coordinationDomain,
            } satisfies FileLockReleaseParams,
            decode: (raw) => ({ released: (raw as { released?: string[] }).released ?? [] }),
          },
        },
      );
      result = routed.value;
    } catch {
      result = await localRelease();
    }

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
