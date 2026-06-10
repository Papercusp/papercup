/**
 * Unit tests for the /harness/projects route family (audit P-005 + P-006).
 *
 * Drives the route handlers directly with a hand-built RouteContext, mocking
 * the registry + org-PG seams. Asserts the route's OWN logic:
 *   - GET enrichment computes hasState from ONE batched work_items query on
 *     the shared org pool (EI-64 — was a per-slug PG pool per project), and
 *     the cache signature derives from registry CONTENTS (not dead file
 *     stats), so a path-only registry change busts it.
 *   - DELETE removes atomically via mutateHarnessRegistry (EI-82).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Seams ────────────────────────────────────────────────────────────
let registry: { projects: Array<Record<string, unknown>> } = { projects: [] };
const batchedQueryCalls: unknown[][] = [];
let workItemSlugs: string[] = [];

vi.mock('../../harness-registry', async (importActual) => ({
  ...(await importActual<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => JSON.parse(JSON.stringify(registry)),
  mutateHarnessRegistry: async (
    mutator: (reg: typeof registry) => typeof registry,
  ) => {
    registry = mutator(JSON.parse(JSON.stringify(registry)));
    return registry;
  },
}));

// Partial mock — the route module's import graph (agent-mcp bootstrap) pulls
// many db-org exports; only the shared org pool is faked.
vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    // tagged template: capture interpolated values, return work_items rows
    sql: (_strings: TemplateStringsArray, ...values: unknown[]) => {
      batchedQueryCalls.push(values);
      return Promise.resolve(workItemSlugs.map((s) => ({ harness_slug: s })));
    },
  }),
}));

vi.mock('../../harness-core', async (importActual) => ({
  ...(await importActual<typeof import('../../harness-core')>()),
  harnessDir: (p: { path: string }) => `${p.path}/.papercusp`,
}));

import type { RouteContext } from '../define-route';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = {
  method: string;
  path: string;
  handler: (req: Request, ctx: RouteContext) => Promise<Response>;
};

async function route(method: string, path: string): Promise<Route> {
  const mod = await import('../routes/harness/projects');
  const r = (mod.default as Route[]).find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`${method} ${path} not registered`);
  return r;
}

function resetProjectsCache(): void {
  // The route module captures the cache object reference at import time —
  // mutate it in place (replacing the global would leave the module's
  // captured reference stale).
  const key = Symbol.for('papercusp.harnessProjectsCache');
  const g = globalThis as Record<symbol, { sig: string; expires: number; inflight: unknown; value: unknown } | undefined>;
  const entry = g[key];
  if (entry) {
    entry.sig = '';
    entry.expires = 0;
    entry.inflight = null;
    entry.value = null;
  }
  const liteKey = Symbol.for('papercusp.harnessProjectsLiteCache');
  delete (globalThis as Record<symbol, unknown>)[liteKey];
}

beforeEach(() => {
  registry = {
    projects: [
      { slug: 'alpha', path: '/tmp/papercusp-route-test-alpha' },
      { slug: 'beta', path: '/tmp/papercusp-route-test-beta' },
    ],
  };
  workItemSlugs = ['alpha'];
  batchedQueryCalls.length = 0;
  resetProjectsCache();
});

describe('GET /harness/projects — batched hasState (P-005 / EI-64)', () => {
  it('computes hasState from ONE org-pool query for the whole registry', async () => {
    const r = await route('GET', '/harness/projects');
    const res = await r.handler(new Request('http://localhost/api/harness/projects'), CTX);
    const body = (await res.json()) as { projects: Array<{ slug: string; hasState: boolean }> };

    expect(batchedQueryCalls).toHaveLength(1); // one query, not one per project
    expect(batchedQueryCalls[0][0]).toEqual(['alpha', 'beta']); // ANY(slugs)
    expect(body.projects.find((p) => p.slug === 'alpha')!.hasState).toBe(true);
    expect(body.projects.find((p) => p.slug === 'beta')!.hasState).toBe(false);
  });

  it('busts the cache on a path-only registry change (content-derived signature)', async () => {
    const r = await route('GET', '/harness/projects');
    await r.handler(new Request('http://localhost/api/harness/projects'), CTX);
    expect(batchedQueryCalls).toHaveLength(1);

    // Same slugs, different path — the old slug-list+dead-file-stat signature
    // kept serving the stale enrichment for the TTL window.
    registry = {
      projects: [
        { slug: 'alpha', path: '/tmp/papercusp-route-test-alpha-MOVED' },
        { slug: 'beta', path: '/tmp/papercusp-route-test-beta' },
      ],
    };
    await r.handler(new Request('http://localhost/api/harness/projects'), CTX);
    expect(batchedQueryCalls).toHaveLength(2); // re-enriched
  });

  it('serves the cached value within TTL for an unchanged registry', async () => {
    const r = await route('GET', '/harness/projects');
    await r.handler(new Request('http://localhost/api/harness/projects'), CTX);
    await r.handler(new Request('http://localhost/api/harness/projects'), CTX);
    expect(batchedQueryCalls).toHaveLength(1);
  });
});

describe('DELETE /harness/projects/:slug — atomic removal (P-006 / EI-82)', () => {
  it('removes via the serialized mutator and reports ok', async () => {
    const r = await route('DELETE', '/harness/projects/:slug');
    const res = await r.handler(
      new Request('http://localhost/api/harness/projects/alpha', { method: 'DELETE' }),
      { ...CTX, params: { slug: 'alpha' } },
    );
    expect(res.status).toBe(200);
    expect(registry.projects.map((p) => p.slug)).toEqual(['beta']);
  });

  it('404s on an unknown slug without writing', async () => {
    const r = await route('DELETE', '/harness/projects/:slug');
    const res = await r.handler(
      new Request('http://localhost/api/harness/projects/ghost', { method: 'DELETE' }),
      { ...CTX, params: { slug: 'ghost' } },
    );
    expect(res.status).toBe(404);
    expect(registry.projects).toHaveLength(2);
  });
});
