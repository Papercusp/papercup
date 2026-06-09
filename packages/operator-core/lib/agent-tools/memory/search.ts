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

/** Map a neutral entry onto the stable wire row the surfaces consume.
 *  `kind` is materialized into `metadata.kind` — the TUI Memory tab reads
 *  it there, and non-mem0 backends (e.g. claude-file) carry kind only at
 *  the entry level. For mem0 rows this is a no-op (kind already matches). */
export function toWireRow(e: MemoryEntry): {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  score?: number;
} {
  const metadata = e.kind !== undefined
    ? { ...(e.metadata ?? {}), kind: e.kind }
    : e.metadata;
  return {
    id: e.id,
    memory: e.text,
    ...(metadata !== undefined ? { metadata } : {}),
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
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so memory:search works from a psu
  // session instead of failing `workspace_required`. (EI: memory unreachable from psu.)
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
    harness_slug: z.string().optional()
      .describe('Scope the search to a single harness in addition to user memory. Omit to fan out across every harness in the workspace.'),
    workspace: z.string().optional()
      .describe('Superuser-only: from an UNSCOPED session, resolve harness fan-out within THIS workspace (the resolved workspace scopes the fan-out). Scoped/power-user sessions ignore it. Omit for personal (user-scoped) recall.'),
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
        // The principal carries the resolved workspace (incl. a per-call
        // `workspace` pin from an unscoped SU session); the old
        // `ctx.workspaceId` read was never populated on principal-gated
        // handlers, so the fan-out silently degraded to user-pool-only (P-004).
        const reg = await loadHarnessRegistry(ctx.principal.workspaceId);
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
