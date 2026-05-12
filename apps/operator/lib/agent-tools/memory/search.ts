/**
 * memory:search — semantic recall over the user's mem0 memories.
 *
 * The route's pre-turn injection auto-surfaces relevant memories every
 * turn; brain only needs to call this for targeted lookup ("did I tell
 * you about X?"). Per-user scoped + workspace-shared.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryClient } from '../../memory/mem0-client';
import { getSessionUserOrDefault } from '../../auth';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'memory:search',
  capability: 'memory:read',
  description:
    'Search the user\'s persistent memories by semantic similarity. Returns matched facts ranked by relevance.',
  guidance: {
    when:
      'When the user references specific context from past sessions ("what did I tell you about pricing?"). Pre-turn auto-injection covers most cases; only call this for targeted lookups.',
    notWhen:
      'For lookups by exact metadata (kind, expires_at), use memory:list — it\'s faster than vector search for filter-only queries.',
    chaining:
      'Pair with memory:update / memory:forget when the user corrects something you recall.',
  },
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 200 } },
  args: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const client = await getMemoryClient();
    if (!client) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mem0_unavailable', results: [] }) }],
      };
    }
    const limit = args.limit ?? 8;

    // Search across this user's memories AND workspace-shared ones.
    // mem0 v3: filter key is `user_id` (snake_case), not `userId`.
    const [userHits, sharedHits] = await Promise.all([
      client.search(args.query, { filters: { user_id: user.id }, limit }),
      client.search(args.query, { filters: { user_id: `workspace:${ctx.workspaceId}` }, limit }),
    ]);

    // Merge + dedupe by id, take top N by score.
    const all = [...(userHits.results ?? []), ...(sharedHits.results ?? [])];
    const byId = new Map<string, typeof all[0]>();
    for (const h of all) byId.set(h.id, h);
    const merged = [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: merged }) }],
    };
  },
});
