/**
 * memory:list — browse all entries for the current user.
 *
 * Mostly used by the /settings/user/memory UI. Brain can call it for
 * filter-only queries (e.g. "show me all corrections") that don't
 * benefit from semantic search.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryClient } from '../../memory/mem0-client';
import { getSessionUserOrDefault } from '../../auth';

const KINDS = ['identity', 'preference', 'project', 'correction', 'ephemeral'] as const;

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'memory:list',
  capability: 'memory:read',
  description:
    'List all memories for the current user. Supports filtering by kind and harness scope.',
  guidance: {
    when:
      'When the user asks to inspect their memory ("what have you stored about me?") or you need a filter-only query.',
    notWhen:
      'For semantic lookup ("what did I say about X?"), use memory:search instead.',
  },
  requirePrincipal: true, // auth-gated: principal required (unauthed HTTP → 401)
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    kind: z.enum(KINDS).optional(),
    harness_slug: z.string().optional(),
    include_shared: z.boolean().optional()
      .describe('Include workspace-shared memories. Default true.'),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const client = await getMemoryClient();
    if (!client) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mem0_unavailable', results: [] }) }],
      };
    }
    const includeShared = args.include_shared !== false;

    // mem0 v3 rejects top-level userId on getAll() — use filters.user_id
    // (snake_case). topK high so the tool list isn't capped at 20.
    const userResults = await client.getAll({ filters: { user_id: user.id }, topK: 5000 });
    const sharedResults = includeShared
      ? await client.getAll({ filters: { user_id: `workspace:${ctx.workspaceId}` }, topK: 5000 })
      : { results: [] as { id: string; memory: string; metadata?: Record<string, unknown> }[] };

    let combined = [
      ...(userResults.results ?? []),
      ...(sharedResults.results ?? []),
    ];

    if (args.kind) {
      combined = combined.filter((m) => (m.metadata as Record<string, unknown>)?.kind === args.kind);
    }
    if (args.harness_slug) {
      combined = combined.filter((m) => (m.metadata as Record<string, unknown>)?.harness_slug === args.harness_slug);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: combined }) }],
    };
  },
});
