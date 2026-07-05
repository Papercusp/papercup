/**
 * locks:queue — read-only inspection of who's holding/waiting on what.
 *
 * Does NOT take the workspace advisory lock — read-only over MVCC.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { ensureBootstrap, getTxPool, readQueue } from './su-lock-store';
import { acquireWithContentionRetry } from './contention-retry';

export default defineTool({
  name: 'locks:queue',
  description:
    'Read the active locks and pending waiters for a workspace. Optionally filter by paths (overlap) or owner. Pass include_completed=true to also return terminal waiters from the last 24h (diagnostics).',
  guidance: {
    when: 'Diagnostics — "what are the other agents doing?" or "why am I blocked?". Cheap, MVCC read.',
    notWhen: 'Before every acquire — locks:acquire already returns busy context. Use queue when the user asks.',
    seeAlso: [
      'locks:list (named-resource holders, not file-lock contention)',
      'coord:roster { view:"live" } (what the other agents are doing overall)',
    ],
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    paths: z.array(z.string()).optional(),
    owner: z.string().optional(),
    include_completed: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { coordinationDomain } = readIdentity(ctx);
    await ensureBootstrap();
    const sql = getTxPool();

    // EI-7454: readQueue scopes a 1s statement_timeout to this read (plan §6.1) —
    // under fleet-load DB contention a plain indexed SELECT can transiently trip
    // it (pg 57014) even though the query itself is cheap. Retry-with-backoff
    // (same helper file-lock-guard.ts already uses for the analogous acquire-path
    // 57014/55P03) rides out the dip instead of surfacing a raw tool error to a
    // diagnostic-only read.
    const result = await acquireWithContentionRetry(() =>
      readQueue(sql, {
        coordinationDomain,
        paths: args.paths,
        owner: args.owner,
        includeCompleted: args.include_completed,
      }),
    );

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
