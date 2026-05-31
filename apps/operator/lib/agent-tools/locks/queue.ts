/**
 * locks:queue — read-only inspection of who's holding/waiting on what.
 *
 * Does NOT take the workspace advisory lock — read-only over MVCC.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { ensureBootstrap, getTxPool, readQueue } from './su-lock-store';

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
  name: 'locks:queue',
  description:
    'Read the active locks and pending waiters for a workspace. Optionally filter by paths (overlap) or owner. Pass include_completed=true to also return terminal waiters from the last 24h (diagnostics).',
  guidance: {
    when: 'Diagnostics — "what are the other agents doing?" or "why am I blocked?". Cheap, MVCC read.',
    notWhen: 'Before every acquire — locks:acquire already returns busy context. Use queue when the user asks.',
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    paths: z.array(z.string()).optional(),
    owner: z.string().optional(),
    include_completed: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { coordinationDomain } = readIdentity(ctx);
    await ensureBootstrap();
    const sql = getTxPool();

    const result = await readQueue(sql, {
      coordinationDomain,
      paths: args.paths,
      owner: args.owner,
      includeCompleted: args.include_completed,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            active_locks: result.active_locks.map((l) => ({
              ...l,
              acquired_ts: l.acquired_ts.toISOString(),
              expires_ts: l.expires_ts.toISOString(),
            })),
            waiting: result.waiting.map((w) => ({
              ...w,
              queued_ts: w.queued_ts.toISOString(),
              wait_until: w.wait_until.toISOString(),
            })),
            completed: result.completed?.map((w) => ({
              ...w,
              queued_ts: w.queued_ts.toISOString(),
              wait_until: w.wait_until.toISOString(),
            })),
          }),
        },
      ],
    };
  },
});
