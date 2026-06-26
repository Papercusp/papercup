/**
 * locks:heartbeat_resource — extend a held named-resource lease's TTL.
 *
 * For a long-held shared or exclusive lease, heartbeat at roughly the
 * halfway mark so the lease doesn't lapse and get swept (which, for a
 * shared holder, would let a draining exclusive proceed without you).
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryHeartbeatResource } from './su-lock-store';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC } from './lock-config';

export default defineTool({
  name: 'locks:heartbeat_resource',
  description:
    'Extend a named-resource lease you hold (by lock_id) for another ttl_sec. Owner-checked; no-op if the lease already lapsed.',
  guidance: {
    when: 'Holding a named resource longer than its TTL — heartbeat near the halfway mark.',
    notWhen: 'Short holds within one TTL window. Released locks need no heartbeat.',
    chaining: 'locks:acquire_resource → (long work, heartbeat periodically) → locks:release_resource.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      lock_id: z.string().uuid().optional().describe('single named-resource lock id to heartbeat'),
      lock_ids: z.array(z.string().uuid()).min(1).max(200).optional().describe('named-resource lock ids to heartbeat in one call'),
      ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    })
    .refine((a) => Boolean(a.lock_id) || (a.lock_ids?.length ?? 0) > 0, {
      message: 'pass `lock_id` or `lock_ids`',
    }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    const lockIds = mergeIds(args.lock_id, args.lock_ids);
    const env = await runBulk(
      lockIds,
      async (lockId) => {
        const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
          tryHeartbeatResource(tx, coordinationDomain, ownerId, lockId, ttlSec),
        );
        return {
          ok: r.extended,
          lock_id: lockId,
          extended: r.extended,
          expires_ts: r.expires_ts ? r.expires_ts.toISOString() : null,
          ...(r.extended ? {} : { error: 'not_found_or_not_yours_or_expired' }),
        };
      },
      { keyOf: (lockId) => ({ lock_id: lockId }) },
    );
    return bulkContent(env);
  },
});
