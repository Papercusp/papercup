/**
 * locks:heartbeat — extend a lock's TTL.
 *
 * extended=false means the lock had already expired or been stolen.
 * The agent should re-acquire if it still wants to edit.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryHeartbeat } from './su-lock-store';

const DEFAULT_TTL_SEC = 1200;
const MAX_TTL_SEC = 3600;

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
  name: 'locks:heartbeat',
  description:
    'Extend a held lock\'s TTL. Returns extended=true on success; extended=false means the lock had already expired or been stolen.',
  guidance: {
    when: 'For edits expected to take >15 min, call once at the halfway mark.',
    notWhen: 'For short edits — the default 20-min TTL covers it. Heartbeating every minute is wasteful.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  roles: [...SU_ROLES],
  args: z.object({
    lock_id: z.string().uuid(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;

    const result = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
      tryHeartbeat(tx, coordinationDomain, ownerId, args.lock_id, ttlSec),
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            extended: result.extended,
            expires_ts: result.expires_ts?.toISOString() ?? null,
            owner: ownerId,
            owner_label: ownerLabel,
          }),
        },
      ],
    };
  },
});
