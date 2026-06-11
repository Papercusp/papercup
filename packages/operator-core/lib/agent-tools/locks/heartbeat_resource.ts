/**
 * locks:heartbeat_resource — extend a held named-resource lease's TTL.
 *
 * For a long-held shared or exclusive lease, heartbeat at roughly the
 * halfway mark so the lease doesn't lapse and get swept (which, for a
 * shared holder, would let a draining exclusive proceed without you).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryHeartbeatResource } from './su-lock-store';

const DEFAULT_TTL_SEC = 1200;
const MAX_TTL_SEC = 3600;

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
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    lock_id: z.string().uuid(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      tryHeartbeatResource(tx, coordinationDomain, ownerId, args.lock_id, ttlSec),
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: r.extended,
            extended: r.extended,
            expires_ts: r.expires_ts ? r.expires_ts.toISOString() : null,
          }),
        },
      ],
    };
  },
});
