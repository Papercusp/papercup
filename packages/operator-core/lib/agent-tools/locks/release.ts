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
import {
  FILE_LOCK_OP_KINDS,
  emitReleaseLockEvents,
  type FileLockReleaseParams,
} from '../../authority/file-lock-authority-ops';
import { recordLockEvent } from '../../authority/lock-event-stream';
import { noteShaTokenRelease } from '../../authority/sha-token-registry';
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
    // G-0 (P-033) publish-then-release: the head sha you published to your
    // hive-git namespace before releasing. The authority stamps the NEXT grant
    // of these paths with it as requiredSha, so the next holder builds on your
    // work. Omit when you released without publishing.
    published_sha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
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

      const noteShaToken = (released: string[] | undefined): void => {
        // G-0 (P-033): remember the published sha for the next grant. On the
        // remote-authority path the authority records it too (from the routed
        // payload); this local note keeps the local-authority + fail-open paths
        // covered and is a harmless mirror otherwise.
        if (released && released.length > 0) {
          noteShaTokenRelease(coordinationDomain, released, args.published_sha ?? null, Date.now());
        }
      };
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
                publishedSha: args.published_sha ?? null,
              } satisfies FileLockReleaseParams,
              decode: (raw) => ({ released: (raw as { released?: string[] }).released ?? [] }),
            },
          },
        );
        noteShaToken(routed.value.released);
        // WI-1550 (P-015): a LOCALLY-decided release (we are the authority, or
        // fail-open/no-peers/unmanaged) never appended its own instant-handover
        // lock-event before this fix — only a release relayed to a REMOTE authority
        // did (inside buildFileLockAuthorityHandlers). Mirror that capture here.
        // No-ops when the scope isn't federating (the installed sink degrades to a
        // no-op) — always safe to call.
        if (routed.via !== 'remote-authority' && routed.scope && routed.value.released && routed.value.released.length > 0) {
          emitReleaseLockEvents((event) => void recordLockEvent(event), {
            scope: routed.scope,
            owner: ownerId,
            released: routed.value.released,
            ts: Date.now(),
            publishedSha: args.published_sha ?? null,
          });
        }
        return routed.value;
      } catch {
        // Routing-layer fault before a scope was resolved — degrade to the raw
        // local release (pre-cutover behavior). No lock-event emitted here, same
        // rationale as the acquire-side fallback in acquire.ts.
        const local = await localRelease();
        noteShaToken(local.released);
        return local;
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
