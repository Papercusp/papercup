/**
 * locks:release_granular — release a multi-granularity intention lock-set (D-005).
 *
 * Frees the whole lock-set acquired under one lock_id: the leaf node + every
 * ancestor intention lock placed with it. Owner-checked — you can only drop your
 * own rows (a leaked lock_id can't release someone else's hold).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { releaseGranular } from './su-lock-store';

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'locks:release_granular',
  description:
    'Release a granular intention lock-set you hold, by lock_id. Frees the leaf node + all of its ancestor intention locks in one call. Owner-checked.',
  guidance: {
    when: 'As soon as the subtree/directory work the lock guarded is done.',
    notWhen: 'While still working under the lock. Release is owner-checked — you can only drop your own lock-set.',
    chaining: 'locks:acquire_granular → work → locks:release_granular { lock_id }.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    lock_id: z.string().uuid(),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      releaseGranular(tx, coordinationDomain, ownerId, args.lock_id),
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, released: r.released }) }],
    };
  },
});
