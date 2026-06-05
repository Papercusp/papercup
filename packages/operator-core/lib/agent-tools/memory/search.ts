/**
 * memory:search — semantic recall over the user's persistent memories.
 *
 * The route's pre-turn injection auto-surfaces relevant memories every
 * turn; brain only needs to call this for targeted lookup ("did I tell
 * you about X?"). Searches user-scoped + harness-scoped (current
 * harness if `harness_slug` is passed, every harness in the workspace
 * otherwise). The deprecated workspace-shared pool was drained (D-005).
 *
 * Storage rides the neutral `MemoryBackend` seam; per-scope fan-out and
 * merge live behind it. RESPONSE CONTRACT (byte-stable — the TUI Memory
 * tab consumes it): { ok, reason?, results: [{ id, memory, metadata,
 * score }] }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend, type MemoryEntry } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { loadHarnessRegistry } from '../../harness-registry';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

/** Map a neutral entry onto the stable wire row the surfaces consume. */
export function toWireRow(e: MemoryEntry): {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  score?: number;
} {
  return {
    id: e.id,
    memory: e.text,
    ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    ...(e.score !== undefined ? { score: e.score } : {}),
  };
}

export default defineTool({
  name: 'memory:search',
  capability: 'memory:read',
  description:
    'Search the user\'s persistent memories by semantic similarity. Returns matched facts ranked by relevance.',
  guidance: {
    when:
      'When the user references specific context from past sessions ("what did I tell you about pricing?"). Pre-turn auto-injection covers most cases; only call this for targeted lookups.',
    notWhen:
      'For lookups by exact metadata (kind), use memory:list — it\'s faster than vector search for filter-only queries.',
    chaining:
      'Pair with memory:update / memory:forget when the user corrects something you recall.',
  },
  requirePrincipal: true, // auth-gated: principal required (unauthed HTTP → 401)
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 200 } },
  args: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
    harness_slug: z.string().optional()
      .describe('Scope the search to a single harness in addition to user memory. Omit to fan out across every harness in the workspace.'),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, results: [] }) }],
      };
    }
    const limit = args.limit ?? 8;

    let harnessSlugs: string[];
    if (args.harness_slug) {
      harnessSlugs = [args.harness_slug];
    } else {
      try {
        const reg = await loadHarnessRegistry(ctx.workspaceId);
        harnessSlugs = reg.projects.map((p) => p.slug);
      } catch {
        harnessSlugs = [];
      }
    }

    // The backend fans out per scope (limit applies per pool), merges,
    // de-dupes by id and sorts by score; we apply the global cap here.
    const hits = await backend.search(args.query, {
      scope: [user.id, ...harnessSlugs.map((slug) => `harness:${slug}`)],
      limit,
    });
    const results = hits.slice(0, limit).map(toWireRow);

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results }) }],
    };
  },
});
