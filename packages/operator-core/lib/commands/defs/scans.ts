/**
 * scans.list / scans.get — Operator can ask "what did the last scan
 * find?" or "show me what changed since yesterday's scans" without
 * burning a fresh Claude call.
 *
 * Backed by harness_shared.operator_scans (lib/operator-scans.ts).
 *
 * IMPORTANT shape difference between list + get to keep the agent's
 * context small:
 *   - scans.list returns SUMMARIES ONLY (id, summary, suggestionCount,
 *     costUsd, startedAt, error) — typical row is ~300 chars.
 *   - scans.get returns the FULL row INCLUDING the suggestions array,
 *     for when the agent needs to talk about a specific past scan in
 *     detail.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { QueryDef } from '../types';

// Indirect dynamic-import so Turbopack doesn't statically trace the
// path into operator-scans.ts (which is `server-only` and pulls
// postgres). Without this, the OperatorPanel client chunk reaches
// operator-scans → sync-sse → postgres and the dev server breaks for
// every route (manifests as a duplicate DOM in Tauri/WebKitGTK — see
// apps/operator/docs/duplicate-dashboard-report-2026-05-12.md).
//
// Same pattern used in lib/memory/mem0-client.ts for the @huggingface
// transformers import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-implied-eval
const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const SERVER_OPERATOR_SCANS = '../../operator-scans';

const ListArgs = z.object({
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max scans to return (default 20).'),
});
type ListArgsT = z.infer<typeof ListArgs>;

const GetArgs = z.object({
  id: z.number().int().min(1).describe('Scan id from scans.list.'),
});
type GetArgsT = z.infer<typeof GetArgs>;

interface ScanSummary {
  id: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  suggestionCount: number;
  costUsd: number;
  cached: boolean;
  error: string | null;
  agentSessionId: string | null;
}

function toSummary(r: any): ScanSummary {
  return {
    id: r.id,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    summary: r.summary,
    suggestionCount: r.suggestionCount,
    costUsd: r.costUsd,
    cached: r.cached,
    error: r.error,
    agentSessionId: r.agentSessionId,
  };
}

const scansList: QueryDef<ListArgsT, { count: number; scans: ScanSummary[] }> = {
  id: 'scans.list',
  kind: 'query',
  description: 'List recent Papercup scans (summaries only — for context-light browsing).',
  promptDescription:
    'Returns recent operator scans as { count, scans: [{id, startedAt, endedAt, summary, suggestionCount, costUsd, cached, error, agentSessionId}, ...] }. ' +
    'SUMMARIES ONLY — does NOT include the full suggestions array. Use to answer ' +
    '"what have I been scanning?", "what did the last few scans find?", or to find a ' +
    'scan id before scans.get. Default 20 most-recent.',
  schema: ListArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ limit }, ctx) => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/operator-scans?${params}`);
      if (!r.ok) throw new Error(`scans.list failed: HTTP ${r.status}`);
      const data = await r.json();
      const scans = (data.scans ?? []).map(toSummary);
      return { count: scans.length, scans };
    }
    const { listOperatorScans } = await dynamicImport(SERVER_OPERATOR_SCANS);
    const rows = await listOperatorScans({ workspaceId: ctx.workspace, limit });
    const scans = rows.map(toSummary);
    return { count: scans.length, scans };
  },
};

const scansGet: QueryDef<GetArgsT, { scan: any }> = {
  id: 'scans.get',
  kind: 'query',
  description: 'Get a single Papercup scan with its full suggestion list.',
  promptDescription:
    'Returns the full scan record for a given id, including the suggestions array. ' +
    'Use AFTER scans.list when the user asks about a specific past scan ("what was ' +
    'in scan 5?") and you need the cards. Each card has {id, title, action, tier, ' +
    'reason, body}. Do not read the full body verbatim out loud — paraphrase the ' +
    'titles and the headline finding.',
  schema: GetArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ id }, ctx) => {
    if (typeof window !== 'undefined') {
      const r = await fetch(`/api/agent-mcp/operator-scans?id=${id}`);
      if (!r.ok) throw new Error(`scans.get failed: HTTP ${r.status}`);
      const data = await r.json();
      return { scan: data.scan ?? null };
    }
    const { getOperatorScan } = await dynamicImport(SERVER_OPERATOR_SCANS);
    const scan = await getOperatorScan({ workspaceId: ctx.workspace, id });
    return { scan };
  },
};

const SearchArgs = z.object({
  query: z.string().min(1).describe('Free-text needle. Matches against summary, request, and suggestions.'),
  limit: z.number().int().min(1).max(50).default(10).optional()
    .describe('Max scans to return (default 10).'),
});
type SearchArgsT = z.infer<typeof SearchArgs>;

const scansSearch: QueryDef<SearchArgsT, { count: number; scans: ScanSummary[] }> = {
  id: 'scans.search',
  kind: 'query',
  description: 'Search past Papercup scans by free-text query (summary/request/cards).',
  promptDescription:
    'Returns matching scans as { count, scans: [...] } (summaries only, same shape as scans.list). ' +
    'Use when the user names a topic that might appear in older scans ("scans about the harness", ' +
    '"the one that mentioned typecheck"). Cheaper than reading scans.list and scanning by eye. ' +
    'Use scans.get for the full payload of a specific id.',
  schema: SearchArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ query, limit }, ctx) => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/operator-scans?${params}`);
      if (!r.ok) throw new Error(`scans.search failed: HTTP ${r.status}`);
      const data = await r.json();
      const scans = (data.scans ?? []).map(toSummary);
      return { count: scans.length, scans };
    }
    const { searchOperatorScans } = await dynamicImport(SERVER_OPERATOR_SCANS);
    const rows = await searchOperatorScans({ workspaceId: ctx.workspace, query, limit });
    const scans = rows.map(toSummary);
    return { count: scans.length, scans };
  },
};

register(scansList);
register(scansGet);
register(scansSearch);
