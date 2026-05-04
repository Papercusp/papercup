/**
 * harness.* — fast queries about harness state.
 *
 * Reflects what voice / Oracle / Pi all need to read fast: status, list,
 * features, last-scan, recent-suggestions. Pi already has narrower variants
 * via papercusp-mcp-server; PR 6 will migrate Pi's MCP server to delegate
 * to these same definitions.
 *
 * All queries are server-runnable (browser:'none' implicit since they're
 * QueryDef). Browser-side reflexive queries fetch through `/api/...`
 * endpoints that this registry def then calls server-side via a relative
 * URL — avoiding workspace-state coupling.
 *
 * Workspace scoping: every query receives ctx.workspace and includes it
 * in the underlying HTTP call where the endpoint is workspace-scoped.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { QueryDef } from '../types';

// Resolve the operator app's own base URL — works both in-page (relative)
// and server-side (loopback to localhost on the dev port).
function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

const StatusArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
});

const harnessStatus: QueryDef<z.infer<typeof StatusArgs>> = {
  id: 'harness.status',
  kind: 'query',
  description: 'Get current state of a harness: alive/paused, last decision, feature counts.',
  promptDescription:
    'Returns harness status — alive/paused flag, current iteration, last decision, ' +
    'and a feature-status breakdown (passed/in-progress/failed/blocked). Use to answer ' +
    'questions like "is the harness running?" or "what\'s the harness working on?"',
  schema: StatusArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug }) => {
    const [statusR, summaryR] = await Promise.all([
      fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`),
      fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/summary`).catch(() => null),
    ]);
    if (!statusR.ok) throw new Error(`status fetch failed: HTTP ${statusR.status}`);
    const status = await statusR.json();
    const summary = summaryR && summaryR.ok ? await summaryR.json().catch(() => null) : null;
    const features = Array.isArray(status?.features) ? status.features : [];
    const counts: Record<string, number> = {};
    for (const f of features) {
      const s = f?.status ?? 'unknown';
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return {
      slug,
      path: status?.project?.path,
      alive: !!status?.alive,
      paused: !!status?.paused,
      iteration: status?.iteration,
      feature_counts: counts,
      feature_total: features.length,
      recent_features: features.slice(-5).map((f: any) => ({
        id: f.id,
        status: f.status,
        title: f.title,
      })),
      summary_excerpt: typeof summary?.summary === 'string'
        ? summary.summary.slice(0, 1200)
        : null,
    };
  },
};

const ListArgs = z.object({}).describe('No args.');

const harnessList: QueryDef<z.infer<typeof ListArgs>> = {
  id: 'harness.list',
  kind: 'query',
  description: 'List harnesses registered for the active workspace.',
  promptDescription:
    'Returns each harness as { slug, path, harness_kind, hasState, hasSpec }. ' +
    'Use to answer "what harnesses do I have?" or to find a slug before navigating.',
  schema: ListArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async () => {
    const r = await fetch(`${baseUrl()}/api/harness/projects/lite`);
    if (!r.ok) throw new Error(`harness.list failed: HTTP ${r.status}`);
    const d = await r.json();
    return { harnesses: d?.projects ?? [] };
  },
};

const ListFeaturesArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  status: z.string().nullable().optional().describe('Optional status filter (passed/in-progress/failed/blocked).'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max rows to return (default 50, cap 200).'),
});

const harnessListFeatures: QueryDef<z.infer<typeof ListFeaturesArgs>> = {
  id: 'harness.list-features',
  kind: 'query',
  description: 'List features in the harness queue (filterable by status).',
  promptDescription:
    'Returns features as [{id, title, status, claims, attempts}]. Filter by status if ' +
    'the user asked specifically (e.g. "what failed?"). Default returns 50, cap 200.',
  schema: ListFeaturesArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, status, limit }) => {
    const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`);
    if (!r.ok) throw new Error(`harness.list-features failed: HTTP ${r.status}`);
    const d = await r.json();
    let features: any[] = Array.isArray(d?.features) ? d.features : [];
    if (status) features = features.filter((f) => f.status === status);
    features = features.slice(0, limit);
    return { slug, count: features.length, features: features.map((f) => ({
      id: f.id,
      title: f.title,
      status: f.status,
      claims: f.claims,
      attempts: f.attempts,
    })) };
  },
};

const LastScanArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
});

const harnessLastScan: QueryDef<z.infer<typeof LastScanArgs>> = {
  id: 'harness.last-scan',
  kind: 'query',
  description: 'Get the cached most-recent Operator scan summary for a harness.',
  promptDescription:
    'Returns the cached summary from the last Operator scan (the same summary ' +
    'that lives in the panel after a scan completes). Cheap; does NOT trigger a ' +
    'fresh scan. Use to answer "what did the operator find?" without burning a ' +
    'Claude call.',
  schema: LastScanArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug }) => {
    const r = await fetch(
      `${baseUrl()}/api/agent-mcp/operator-last-scan?slug=${encodeURIComponent(slug)}`,
    );
    if (!r.ok) {
      if (r.status === 404) return { slug, summary: null, hasContent: false };
      throw new Error(`harness.last-scan failed: HTTP ${r.status}`);
    }
    const d = await r.json();
    return {
      slug,
      summary: d?.summary ?? d?.text ?? null,
      hasContent: !!(d?.summary ?? d?.text),
      ts: d?.ts ?? null,
    };
  },
};

const RecentSuggestionsArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max suggestions (default 10, cap 50).'),
});

const harnessRecentSuggestions: QueryDef<z.infer<typeof RecentSuggestionsArgs>> = {
  id: 'harness.recent-suggestions',
  kind: 'query',
  description: 'List recent Operator-panel suggestions for a harness (cached).',
  promptDescription:
    'Returns the last N suggestion cards Operator surfaced for this harness. ' +
    'Each suggestion has a title, kind (auto/needs-input/etc), and a one-line ' +
    'preview. Use after the user asks "what was the operator suggesting?"',
  schema: RecentSuggestionsArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, limit }) => {
    // Reuses the existing dismissed-cache endpoint that holds recent
    // suggestion fingerprints alongside their parsed shape.
    const r = await fetch(
      `${baseUrl()}/api/agent-mcp/operator-last-scan?slug=${encodeURIComponent(slug)}&include=suggestions`,
    );
    if (!r.ok) {
      if (r.status === 404) return { slug, count: 0, suggestions: [] };
      throw new Error(`harness.recent-suggestions failed: HTTP ${r.status}`);
    }
    const d = await r.json();
    const suggestions: any[] = Array.isArray(d?.suggestions) ? d.suggestions : [];
    return { slug, count: suggestions.length, suggestions: suggestions.slice(0, limit) };
  },
};

register(harnessStatus);
register(harnessList);
register(harnessListFeatures);
register(harnessLastScan);
register(harnessRecentSuggestions);
