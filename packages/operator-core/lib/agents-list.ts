/**
 * Cross-harness agent enumeration. Server-side implementation shared
 * between the registry query (agents.across-workspace) and the HTTP
 * endpoint that serves it to the delegate's MCP tool.
 *
 * Reads from the agent-chats Hono store via the same internal HTTP
 * surface clients use — keeps the query responsive to chat-store
 * schema changes without re-implementing them here.
 */

import { loopbackFetch, readJsonBody } from './loopback-fetch';

interface AgentRow {
  slug: string;
  role: string;
  chat_count: number;
  last_active: string | null;
}

// Use the operator's own base URL. Was hardcoded to :3155 (a since-retired
// papercup-main worktree port); production on :3070 was hitting ECONNREFUSED
// and returning 500. PAPERCUSP_OPERATOR_BASE is the same env var every other
// internal-fetch site uses. Fall back to PORT (Next sets it to whatever port
// the server bound on) before defaulting to dev's 3055.
function operatorBase(): string {
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE;
  if (process.env.PAPERCUSP_OPERATOR_BASE) return process.env.PAPERCUSP_OPERATOR_BASE;
  const port = process.env.PORT ?? '3055';
  return `http://localhost:${port}`;
}

// Cache the slug-less result (the heavy case). Per-slug calls are already
// fast (~1 fetch); the no-slug variant fetches /agent-chats for every
// registered project and was doing it SERIALLY — 70 round-trips per call,
// dragging it to >8 s. Cache for 10 s; data is only used by tooling +
// audit views, doesn't need sub-second freshness.
interface AgentsCacheEntry {
  expires: number;
  inflight: Promise<AgentRow[]> | null;
  value: AgentRow[] | null;
}
const __agentsCacheKey = Symbol.for('papercusp.agentsAcrossWorkspaceCache');
type AgentsCacheGlobals = typeof globalThis & { [__agentsCacheKey]?: AgentsCacheEntry };
const __agentsCache: AgentsCacheEntry = (() => {
  const g = globalThis as AgentsCacheGlobals;
  if (!g[__agentsCacheKey]) g[__agentsCacheKey] = { expires: 0, inflight: null, value: null };
  return g[__agentsCacheKey]!;
})();

async function fetchOneSlug(slug: string, base: string): Promise<AgentRow[]> {
  const cr = await loopbackFetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`).catch(() => null);
  if (!cr || !cr.ok) return [];
  const cd = (await cr.json().catch(() => null)) as { chats?: Array<any> } | null;
  const chats = Array.isArray(cd?.chats) ? cd!.chats : [];
  const byRole = new Map<string, AgentRow>();
  for (const c of chats) {
    const role = c?.role ?? 'unknown';
    const existing = byRole.get(role) ?? { slug, role, chat_count: 0, last_active: null };
    existing.chat_count += 1;
    if (!existing.last_active || String(c?.updated_at ?? '') > existing.last_active) {
      existing.last_active = c?.updated_at ?? null;
    }
    byRole.set(role, existing);
  }
  return Array.from(byRole.values());
}

async function computeAllAgents(base: string): Promise<AgentRow[]> {
  const projR = await loopbackFetch(`${base}/api/harness/projects`);
  if (!projR.ok) return [];
  // readJsonBody (not bare .json()) so an empty/truncated body during a host
  // restart rethrows an ATTRIBUTABLE error naming this URL — not the frame-less
  // `SyntaxError: Unexpected end of JSON input` that fatal-exited :3070 (EI-20).
  const projData = await readJsonBody<{ projects?: Array<{ slug: string }> }>(projR);
  const slugs = (projData.projects ?? []).map((p) => p.slug);
  // Parallelize: was a serial for-loop doing 70 round-trips back-to-back.
  const perSlug = await Promise.all(slugs.map((s) => fetchOneSlug(s, base)));
  return perSlug.flat();
}

export async function listAgentsAcrossWorkspace(opts: {
  slug?: string;
  limit?: number;
}): Promise<AgentRow[]> {
  const limit = opts.limit ?? 40;
  const base = operatorBase();

  // Single-slug case: no cache, just one fetch.
  if (opts.slug) {
    const rows = await fetchOneSlug(opts.slug, base);
    rows.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')));
    return rows.slice(0, limit);
  }

  // No-slug case: cache + in-flight dedup. The full walk is heavy.
  const now = Date.now();
  const TTL_MS = 10_000;
  let value = __agentsCache.value;
  if (!(value && __agentsCache.expires > now)) {
    if (!__agentsCache.inflight) {
      __agentsCache.inflight = (async () => {
        const all = await computeAllAgents(base);
        all.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')));
        __agentsCache.value = all;
        __agentsCache.expires = Date.now() + TTL_MS;
        __agentsCache.inflight = null;
        return all;
      })();
    }
    value = await __agentsCache.inflight;
  }
  return value!.slice(0, limit);
}
