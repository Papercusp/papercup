/**
 * docs:outline / docs:get / docs:search — PURE handler-level tests.
 *
 * The sibling `routing.test.ts` covers the exported `resolveAdapter`
 * branching (which adapter for which ctx). This file covers the part
 * `resolveAdapter` does NOT: the `defineTool` HANDLER pipeline around it —
 *
 *   - the `resolveHarnessScope` gate → `harness_required` error envelope
 *     (isError:true, no engine call) when no harness is in scope;
 *   - the `resolved.error` → error envelope shaping (`{error, slug}`,
 *     isError:true) without ever calling the engine;
 *   - the happy-path projection: the engine payload is wrapped with
 *     `surface` (+ `cached` for outline) and serialized to one text part;
 *   - docs:outline's per-run cache: first call MISS (cached:false, engine
 *     invoked once), second call HIT (cached:true, engine NOT re-invoked);
 *   - `ctx.metadata` emission (surface + harness_slug for a concrete slug).
 *
 * The docs-engine (buildOutline/getDocs/searchDocs) and the on-disk adapters
 * are mocked, so nothing touches the real docs tree or fs. The harness
 * registry is mocked to control the harness/engineering routing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the docs-engine so no real fs/content tree is read. ----------------
// Each engine fn returns a recognizable payload; adapter factories return an
// opaque sentinel (handlers only pass it through to the engine fn).
const buildOutline = vi.fn(async () => ({ pages: [{ slug: 'p1', title: 'P1', headings: [] }] }));
const getDocs = vi.fn(async () => ({ pages: [{ slug: 'p1', body: 'BODY' }] }));
const searchDocs = vi.fn(async () => ({ hits: [{ slug: 'p1', title: 'P1', excerpt: 'ex' }] }));

vi.mock('@papercusp/docs-engine', () => ({
  buildOutline,
  getDocs,
  searchDocs,
  withPreamble: (body: unknown) => body,
  genericFsAdapter: (root: string) => ({ __adapter: 'generic', root }),
  harnessFsAdapter: (path: string) => ({ __adapter: 'harness', path }),
  starlightContentAdapter: () => ({ __adapter: 'starlight' }),
  // RunCache is real-behaviored but tiny — re-implement the get/set/key
  // contract the outline handler depends on (per-run keyed by runId+scope).
  RunCache: class<T> {
    private m = new Map<string, T>();
    private k(ctx: { runId?: string; spawnId?: string }, scope = '') {
      const base = ctx.runId ?? ctx.spawnId ?? '_';
      return scope ? `${base}:${scope}` : base;
    }
    get(ctx: { runId?: string; spawnId?: string }, scope = '') {
      return this.m.get(this.k(ctx, scope));
    }
    set(ctx: { runId?: string; spawnId?: string }, v: T, scope = '') {
      this.m.set(this.k(ctx, scope), v);
    }
  },
}));

function mockRegistry(projects: Array<{ slug: string; path: string }>) {
  vi.doMock('../../../harness-registry', () => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects })),
  }));
}

const ORIGINAL_ENV = process.env.PAPERCUSP_PROJECT_DOCS_ROOT;

beforeEach(() => {
  vi.resetModules();
  buildOutline.mockClear();
  getDocs.mockClear();
  searchDocs.mockClear();
  delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
});

afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
  else process.env.PAPERCUSP_PROJECT_DOCS_ROOT = ORIGINAL_ENV;
});

/** Parse the single text content part a docs handler returns. */
function payloadOf(res: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(res.content[0].text);
}

describe('docs:outline handler — harness_required gate', () => {
  it('no arg + ctx harnessSlug="*" → harness_required, engine never called', async () => {
    mockRegistry([]);
    const tool = (await import('../outline')).default;
    const res = await tool.handler({} as never, { harnessSlug: '*' } as never);
    expect(res.isError).toBe(true);
    expect(payloadOf(res as never).error).toBe('harness_required');
    expect(payloadOf(res as never).detail).toContain('harness');
    expect(buildOutline).not.toHaveBeenCalled();
  });

  it('no arg + unset ctx harnessSlug → harness_required', async () => {
    mockRegistry([]);
    const tool = (await import('../outline')).default;
    const res = await tool.handler({} as never, {} as never);
    expect(res.isError).toBe(true);
    expect(payloadOf(res as never).error).toBe('harness_required');
    expect(buildOutline).not.toHaveBeenCalled();
  });
});

describe('docs:outline handler — resolved.error → error envelope', () => {
  it('unknown slug → harness_not_registered envelope, engine never called', async () => {
    mockRegistry([]); // empty registry → any concrete slug is unregistered
    const tool = (await import('../outline')).default;
    const res = await tool.handler({ harness: 'nope' } as never, { harnessSlug: '*' } as never);
    expect(res.isError).toBe(true);
    const p = payloadOf(res as never);
    expect(p.error).toBe('harness_not_registered');
    expect(p.slug).toBe('nope');
    expect(buildOutline).not.toHaveBeenCalled();
  });

  it('non-SU caller, all scope, no project-docs env → no_docs_source envelope', async () => {
    mockRegistry([]);
    const tool = (await import('../outline')).default;
    // arg "all" → operator scope; isSuperuser unset, no env var → no_docs_source.
    const res = await tool.handler({ harness: 'all' } as never, { harnessSlug: '*' } as never);
    expect(res.isError).toBe(true);
    expect(payloadOf(res as never).error).toBe('no_docs_source');
    expect(buildOutline).not.toHaveBeenCalled();
  });
});

describe('docs:outline handler — happy path + per-run cache', () => {
  it('first call MISS (cached:false, engine called once), second HIT (cached:true, not re-called)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    const ctx = { harnessSlug: 'sheets', runId: 'run_A', metadata: vi.fn() } as never;

    const r1 = await tool.handler({} as never, ctx);
    const p1 = payloadOf(r1 as never);
    expect(p1.cached).toBe(false);
    expect(p1.surface).toBe('harness');
    expect(p1.pages[0].slug).toBe('p1'); // engine payload spread through
    expect(buildOutline).toHaveBeenCalledTimes(1);

    const r2 = await tool.handler({} as never, ctx);
    const p2 = payloadOf(r2 as never);
    expect(p2.cached).toBe(true);
    expect(p2.surface).toBe('harness');
    // Cache HIT: engine NOT invoked a second time for the same run+scope.
    expect(buildOutline).toHaveBeenCalledTimes(1);
  });

  it('emits metadata { surface, harness_slug } for a concrete harness scope', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    const metadata = vi.fn();
    await tool.handler({} as never, { harnessSlug: 'sheets', runId: 'run_B', metadata } as never);
    expect(metadata).toHaveBeenCalledWith({ surface: 'harness', harness_slug: 'sheets' });
  });

  it('a different run does NOT share the cache (cached:false again)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    await tool.handler({} as never, { harnessSlug: 'sheets', runId: 'run_C' } as never);
    const r2 = await tool.handler({} as never, { harnessSlug: 'sheets', runId: 'run_D' } as never);
    expect(payloadOf(r2 as never).cached).toBe(false);
    expect(buildOutline).toHaveBeenCalledTimes(2);
  });
});

describe('docs:get handler', () => {
  it('harness_required gate fires (no arg, ctx "*") with no engine call', async () => {
    mockRegistry([]);
    const tool = (await import('../get')).default;
    const res = await tool.handler({ slugs: ['p1'] } as never, { harnessSlug: '*' } as never);
    expect(res.isError).toBe(true);
    expect(payloadOf(res as never).error).toBe('harness_required');
    expect(getDocs).not.toHaveBeenCalled();
  });

  it('happy path wraps the engine response with surface (no cached flag)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    const res = await tool.handler({ slugs: ['p1'] } as never, { harnessSlug: 'sheets' } as never);
    const p = payloadOf(res as never);
    expect(p.surface).toBe('harness');
    expect(p.pages[0].body).toBe('BODY');
    expect(p).not.toHaveProperty('cached'); // get does not cache
    expect(getDocs).toHaveBeenCalledTimes(1);
    // engine receives args (slugs) so the heading-narrowing path is reachable.
    expect(getDocs).toHaveBeenCalledWith(expect.anything(), { slugs: ['p1'] }, expect.anything());
  });

  it('args schema rejects heading with multiple slugs (heading is single-slug only)', async () => {
    const mod = await import('../get');
    const parsed = mod.default.args.safeParse({ slugs: ['a', 'b'], heading: 'x' });
    expect(parsed.success).toBe(false);
  });

  it('args schema accepts a single slug + heading', async () => {
    const mod = await import('../get');
    const parsed = mod.default.args.safeParse({ slugs: ['a'], heading: 'sec-1' });
    expect(parsed.success).toBe(true);
  });

  it('args schema rejects an empty slugs array', async () => {
    const mod = await import('../get');
    expect(mod.default.args.safeParse({ slugs: [] }).success).toBe(false);
  });
});

describe('docs:search handler', () => {
  it('harness_required gate fires with no engine call', async () => {
    mockRegistry([]);
    const tool = (await import('../search')).default;
    const res = await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: '*' } as never);
    expect(res.isError).toBe(true);
    expect(payloadOf(res as never).error).toBe('harness_required');
    expect(searchDocs).not.toHaveBeenCalled();
  });

  it('happy path wraps the engine response with surface', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../search')).default;
    const res = await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: 'sheets' } as never);
    const p = payloadOf(res as never);
    expect(p.surface).toBe('harness');
    expect(p.hits[0].slug).toBe('p1');
    expect(searchDocs).toHaveBeenCalledTimes(1);
  });

  it('project surface when PAPERCUSP_PROJECT_DOCS_ROOT is set and arg is "all"', async () => {
    process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/proj-docs';
    mockRegistry([]);
    const tool = (await import('../search')).default;
    const res = await tool.handler(
      { query: 'auth flow', limit: 8, harness: 'all' } as never,
      { harnessSlug: '*' } as never,
    );
    expect(payloadOf(res as never).surface).toBe('project');
    expect(searchDocs).toHaveBeenCalledTimes(1);
  });

  it('args schema enforces query min length 2', async () => {
    const mod = await import('../search');
    expect(mod.default.args.safeParse({ query: 'a' }).success).toBe(false);
    expect(mod.default.args.safeParse({ query: 'ab' }).success).toBe(true);
  });
});
