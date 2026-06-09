/**
 * GET /cupboard/tools + GET /cupboard/provides — the Discovery-lane routes
 * (tool-distribution-discovery-2026-06-08 P-005/P-006/P-007).
 *
 * The pure builders (buildToolsDiscovery / buildToolProvenance / searchTools)
 * are unit-tested separately; here we pin the ROUTES' job: parse q / status /
 * category / tool, derive the (mocked) catalog, inject the live tool meta, and
 * return the right payload — with input validation. derivePackCatalog +
 * collectToolMeta (the IO) are stubbed; the real builders run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cupboard/pack-catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../cupboard/pack-catalog')>();
  return { ...real, derivePackCatalog: vi.fn() };
});
vi.mock('../../cupboard/tools-discovery', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../cupboard/tools-discovery')>();
  return { ...real, collectToolMeta: vi.fn(() => new Map()) };
});
vi.mock('../../plugin-host-runtime', () => ({ getPluginHost: vi.fn(async () => ({})) }));

import routes from '../routes/cupboard';
import { assemblePackCatalog, derivePackCatalog } from '../../cupboard/pack-catalog';
import { collectToolMeta, type ToolMetaIndex } from '../../cupboard/tools-discovery';

type Route = { path: string; handler: (req: Request) => Promise<Response> };
const byPath = (p: string) => (routes as unknown as Route[]).find((r) => r.path === p)!;
const toolsRoute = byPath('/cupboard/tools');
const providesRoute = byPath('/cupboard/provides');

function get(route: Route, qs = ''): Promise<Response> {
  return route.handler(new Request(`http://localhost${route.path}${qs}`, { method: 'GET' }));
}

const CATALOG = assemblePackCatalog({
  installed: [],
  projectedTools: [{ pluginName: 'agent-mcp', mcpName: 'coord:send' }],
  legacyCatalogNames: ['plans:get'],
  cupboardUnits: [
    {
      name: 'markdown-tools',
      kind: 'pack',
      listingId: 'lst-1',
      providesTools: ['md.render', 'md.lint'],
      description: 'Markdown helpers',
    },
  ],
  cupboardReachable: true,
});

const META: ToolMetaIndex = new Map([
  ['coord:send', { description: 'send a message to a peer', capability: 'coord:write' }],
]);

beforeEach(() => {
  vi.mocked(derivePackCatalog).mockResolvedValue(CATALOG);
  vi.mocked(collectToolMeta).mockReturnValue(META);
});

describe('GET /cupboard/tools', () => {
  it('returns every resolved tool with counts + category facets', async () => {
    const res = await get(toolsRoute);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      tools: { tool: string }[];
      counts: { available: number; installable: number };
      categories: { name: string; count: number }[];
    };
    expect(json.tools.map((t) => t.tool).sort()).toEqual(['coord:send', 'md.lint', 'md.render', 'plans:get']);
    expect(json.counts).toEqual({ available: 2, installable: 2 });
    expect(json.categories[0]).toEqual({ name: 'md', count: 2 });
  });

  it('400s on an invalid status filter', async () => {
    const res = await get(toolsRoute, '?status=bogus');
    expect(res.status).toBe(400);
    expect((await res.json()) as { field: string }).toMatchObject({ error: 'invalid_field', field: 'status' });
  });

  it('narrows to a category', async () => {
    const res = await get(toolsRoute, '?category=md');
    const json = (await res.json()) as { tools: { tool: string }[] };
    expect(json.tools.map((t) => t.tool)).toEqual(['md.lint', 'md.render']);
  });

  it('capability-searches by a word only in a tool description', async () => {
    const res = await get(toolsRoute, '?q=message');
    const json = (await res.json()) as { tools: { tool: string }[] };
    expect(json.tools.map((t) => t.tool)).toEqual(['coord:send']);
  });
});

describe('GET /cupboard/provides', () => {
  it('400s when neither tool nor q is given', async () => {
    const res = await get(providesRoute);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'missing_query' });
  });

  it('resolves an exact tool name to its providing unit + install action', async () => {
    const res = await get(providesRoute, '?tool=md.render');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      resolved: { tool: string; provider: { listingId: string } } | null;
      matches: { tool: string }[];
    };
    expect(json.resolved?.tool).toBe('md.render');
    expect(json.resolved?.provider.listingId).toBe('lst-1');
    expect(json.matches[0]?.tool).toBe('md.render');
  });

  it('answers a capability phrase with ranked candidates', async () => {
    const res = await get(providesRoute, '?q=markdown');
    const json = (await res.json()) as { resolved: unknown; matches: { tool: string }[] };
    expect(json.resolved).toBeNull();
    expect(json.matches.map((m) => m.tool)).toEqual(expect.arrayContaining(['md.render', 'md.lint']));
  });
});
