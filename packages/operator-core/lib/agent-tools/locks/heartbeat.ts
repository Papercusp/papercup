/**
 * locks:heartbeat — extend a lock's TTL.
 *
 * extended=false means the lock had already expired or been stolen.
 * The agent should re-acquire if it still wants to edit.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { SuLocksCoordinator } from './coordinator';

const DEFAULT_TTL_SEC = 1200;
const MAX_TTL_SEC = 3600;

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
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    lock_id: z.string().uuid(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
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
    const result = await coordinator.heartbeat(
      { claimId: args.lock_id, owner: ownerId, paths: [], expiresAt: null },
      ttlSec * 1000,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            extended: result.ok,
            expires_ts: result.ok
              ? (result.claim.expiresAt?.toISOString() ?? null)
              : null,
            owner: ownerId,
            owner_label: ownerLabel,
          }),
        },
      ],
    };
  },
});
