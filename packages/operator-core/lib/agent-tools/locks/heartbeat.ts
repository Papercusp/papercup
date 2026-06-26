/**
 * locks:heartbeat — extend a lock's TTL.
 *
 * extended=false means the lock had already expired or been stolen.
 * The agent should re-acquire if it still wants to edit.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { SuLocksCoordinator } from './coordinator';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC } from './lock-config';

export default defineTool({
  name: 'locks:heartbeat',
  description:
    'Extend a held lock\'s TTL. Returns extended=true on success; extended=false means the lock had already expired or been stolen.',
  guidance: {
    when: 'For edits expected to take >15 min, call once at the halfway mark.',
    notWhen: 'For short edits — the default 20-min TTL covers it. Heartbeating every minute is wasteful.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      lock_id: z.string().uuid().optional().describe('single lock id to heartbeat'),
      lock_ids: z.array(z.string().uuid()).min(1).max(200).optional().describe('lock ids to heartbeat in one call'),
      ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
    })
    .refine((a) => Boolean(a.lock_id) || (a.lock_ids?.length ?? 0) > 0, {
      message: 'pass `lock_id` or `lock_ids`',
    }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;

    // Dispatch through the shared FileClaimCoordinator interface
    // (file-locking #11). heartbeat is the one locks:* tool whose
    // contract maps 1:1 onto the cross-backend interface — see the
    // file-locking plan §11 for why acquire/release/cancel_wait do
    // not. SuLocksCoordinator.heartbeat reads only claim.claimId +
    // claim.owner, so a minimal claim suffices.
    const coordinator = new SuLocksCoordinator({ coordinationDomain });
    const lockIds = mergeIds(args.lock_id, args.lock_ids);
    const env = await runBulk(
      lockIds,
      async (lockId) => {
        const result = await coordinator.heartbeat(
          { claimId: lockId, owner: ownerId, paths: [], expiresAt: null },
          ttlSec * 1000,
        );
        return {
          ok: result.ok,
          lock_id: lockId,
          extended: result.ok,
          expires_ts: result.ok ? (result.claim.expiresAt?.toISOString() ?? null) : null,
          owner: ownerId,
          owner_label: ownerLabel,
          ...(result.ok ? {} : { error: 'not_found_or_not_yours_or_expired' }),
        };
      },
      { keyOf: (lockId) => ({ lock_id: lockId }) },
    );

    return bulkContent(env);
  },
});
