/**
 * harness:list — registry⊕projects merge tests (the autoloop-pot-operator
 * P-004 fix: registry harnesses must be visible, not just org-project rows).
 *
 * `ctx.tx` is mocked as a sql template tag routing on the table name. The
 * merge logic under test:
 *   - registry rows lead, enriched from a matching projects row
 *     (name/status/updated_ts) with `source:'registry'`; a registry row with
 *     NO project row defaults status 'registered' / name = slug
 *   - project rows NOT in the registry are kept as `source:'project'`
 *     (the org/Pot view never disappears)
 *   - a project row whose slug IS in the registry is not duplicated
 *   - `limit` slices the merged list (registry first)
 *   - summary projects {slug, status, source}; full keeps name/updated_ts/path
 *   - registry payload guards (readRegistryProjects): missing row / non-array
 *     `projects` / entries without a string slug → treated as no registry
 *   - arg schema: detail default 'summary', limit default 50 / max 200
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './list';

let registryPayload: unknown = null; // the harness_registry payload column, or null = no row
let projectRows: Array<Record<string, unknown>> = [];

const tx = (strings: TemplateStringsArray, ..._values: unknown[]) => {
  const text = strings.join(' ');
  if (text.includes('harness_registry')) {
    return Promise.resolve(registryPayload === null ? [] : [{ payload: registryPayload }]);
  }
  if (text.includes('harness_shared.projects')) return Promise.resolve(projectRows);
  throw new Error(`unexpected query: ${text}`);
};

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx,
    log: vi.fn(),
  }) as never;

const ARGS = (over: Record<string, unknown> = {}) => tool.args.parse({ ...over }) as never;

beforeEach(() => {
  registryPayload = null;
  projectRows = [];
});

describe('harness:list — merge semantics', () => {
  it('a registry row with no project row defaults to status registered / name=slug', async () => {
    registryPayload = { projects: [{ slug: 'fresh', path: '/tmp/fresh' }] };
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([{ slug: 'fresh', status: 'registered', source: 'registry' }]);
  });

  it('a registry row is enriched from its matching project row (and not duplicated)', async () => {
    registryPayload = { projects: [{ slug: 'sheets', path: '/tmp/sheets' }] };
    projectRows = [{ slug: 'sheets', name: 'Sheets', status: 'active', updated_ts: 9 }];
    const res = await tool.handler(ARGS({ detail: 'full' }), CTX());
    expect(res.data).toEqual([
      {
        slug: 'sheets',
        name: 'Sheets',
        status: 'active',
        updated_ts: 9,
        path: '/tmp/sheets',
        source: 'registry',
      },
    ]);
  });

  it('project rows outside the registry stay visible as source:project', async () => {
    registryPayload = { projects: [{ slug: 'reg-only', path: '/r' }] };
    projectRows = [{ slug: 'org-only', name: 'Org', status: 'paused', updated_ts: 1 }];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([
      { slug: 'reg-only', status: 'registered', source: 'registry' },
      { slug: 'org-only', status: 'paused', source: 'project' },
    ]);
  });

  it('limit slices the merged list, registry rows first', async () => {
    registryPayload = { projects: [{ slug: 'r1', path: '/1' }, { slug: 'r2', path: '/2' }] };
    projectRows = [{ slug: 'p1', name: null, status: 'active', updated_ts: 1 }];
    const res = await tool.handler(ARGS({ limit: 2 }), CTX());
    expect((res.data as unknown[]).length).toBe(2);
    expect(res.data).toEqual([
      { slug: 'r1', status: 'registered', source: 'registry' },
      { slug: 'r2', status: 'registered', source: 'registry' },
    ]);
  });

  it('summary drops name/updated_ts/path; full keeps them', async () => {
    registryPayload = { projects: [{ slug: 's', path: '/s' }] };
    const summary = await tool.handler(ARGS(), CTX());
    expect(Object.keys((summary.data as Array<Record<string, unknown>>)[0]).sort()).toEqual(
      ['slug', 'source', 'status'],
    );
    const full = await tool.handler(ARGS({ detail: 'full' }), CTX());
    expect((full.data as Array<Record<string, unknown>>)[0]).toHaveProperty('path', '/s');
  });
});

describe('harness:list — registry payload guards', () => {
  it('no registry row → projects-only view', async () => {
    projectRows = [{ slug: 'p', name: 'P', status: 'active', updated_ts: 1 }];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([{ slug: 'p', status: 'active', source: 'project' }]);
  });

  it('non-array projects payload → treated as empty registry', async () => {
    registryPayload = { projects: 'corrupt' };
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([]);
  });

  it('entries without a string slug are filtered out', async () => {
    registryPayload = { projects: [{ slug: 'ok', path: '/ok' }, { path: '/no-slug' }, 'junk', null] };
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([{ slug: 'ok', status: 'registered', source: 'registry' }]);
  });
});

describe('harness:list — arg schema', () => {
  it('detail defaults to summary; limit defaults 50 and caps at 200', () => {
    const parsed = tool.args.parse({});
    expect(parsed.detail).toBe('summary');
    expect(parsed.limit).toBe(50);
    expect(() => tool.args.parse({ limit: 201 })).toThrow();
  });
});
