/**
 * harness:list / harness:status read the harness REGISTRY merged with the
 * org projects table (autoloop-pot-operator-rebuild-2026-06-05 P-004).
 * Before this, both read only `harness_shared.projects`, so a harness
 * created via `harness:create` (registry write) was invisible to its own
 * read-back — the Pot could create a harness it then couldn't see.
 *
 * The fake tx routes on a SQL fragment, so the tests pin WHICH store each
 * query hits without a live PG.
 */
import { describe, expect, it } from 'vitest';
import listTool from './list';
import statusTool from './status';

type Row = Record<string, unknown>;

/** Tagged-template fake `tx` routing on a substring of the query text. */
function fakeTx(routes: Array<{ match: string; rows: Row[] }>) {
  return (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

const ctxWith = (tx: unknown) =>
  ({
    log() {},
    tx,
    principal: { slug: 'system:operator', workspaceId: 'ws-1', capabilities: new Set<string>() },
  }) as never;

const run = async (tool: { handler: (a: never, c: never) => Promise<unknown> }, args: Record<string, unknown>, tx: unknown) =>
  (await tool.handler(args as never, ctxWith(tx))) as { data: any; degraded?: boolean; degradedReasons?: string[] };

/** harness:status is now a bulk tool (keyed-array envelope); parse it and
 *  return the single result for the n=1 cases below. */
const statusOne = async (args: Record<string, unknown>, tx: unknown) => {
  const out = (await statusTool.handler(args as never, ctxWith(tx))) as { data: unknown };
  const envBody = out.data as { ok: boolean; results: any[]; counts: { ok: number; failed: number } };
  return envBody;
};

const REGISTRY_ROW = {
  payload: { projects: [{ slug: 'pot-verify', path: '/tmp/pot-verify' }, { slug: 'papercup', path: '/repo/papercup' }] },
};

describe('harness:list — registry + projects merge', () => {
  it('lists registry harnesses even with NO projects-table row', async () => {
    const tx = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
    ]);
    const r = await run(listTool, {}, tx);
    const slugs = r.data.map((x: Row) => x.slug);
    expect(slugs).toContain('pot-verify');
    expect(slugs).toContain('papercup');
    expect(r.data.find((x: Row) => x.slug === 'pot-verify').status).toBe('registered');
    expect(r.data.find((x: Row) => x.slug === 'pot-verify').source).toBe('registry');
  });

  it('enriches a registry harness from its projects row and keeps org-only projects', async () => {
    const tx = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      {
        match: 'FROM harness_shared.projects',
        rows: [
          { slug: 'papercup', name: 'Papercup', status: 'in_progress', updated_ts: 1 },
          { slug: 'barchart-landing', name: 'Barchart', status: 'in_progress', updated_ts: 2 },
        ],
      },
    ]);
    const r = await run(listTool, { detail: 'full' }, tx);
    const papercup = r.data.find((x: Row) => x.slug === 'papercup');
    expect(papercup.status).toBe('in_progress'); // enriched from projects
    expect(papercup.source).toBe('registry');
    const org = r.data.find((x: Row) => x.slug === 'barchart-landing');
    expect(org.source).toBe('project'); // org-only row stays visible
  });

  it('returns [] cleanly when neither store has rows', async () => {
    const tx = fakeTx([]);
    const r = await run(listTool, {}, tx);
    expect(r.data).toEqual([]);
  });
});

describe('harness:status — registry-first resolution (bulk envelope, n=1)', () => {
  it('finds a registry-only harness (the create → status round-trip)', async () => {
    const tx = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [{ ts: 1, action: 'created', actor: 'op', subject: 'pot-verify' }] },
    ]);
    const b = await statusOne({ slug: 'pot-verify' }, tx);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    const r = b.results[0];
    expect(r.slug).toBe('pot-verify');
    expect(r.status).toBe('registered');
    expect(r.path).toBe('/tmp/pot-verify');
    expect(r.source).toBe('registry');
    expect(r.recentActivity).toHaveLength(1);
  });

  it('keeps the projects-row detail when one exists', async () => {
    const tx = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      {
        match: 'FROM harness_shared.projects',
        rows: [{ slug: 'papercup', status: 'in_progress', updated_ts: 5, spent_cents: 10, budget_cents: 100 }],
      },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await statusOne({ slug: 'papercup' }, tx);
    expect(b.results[0].status).toBe('in_progress');
    expect(b.results[0].budget_cents).toBe(100);
  });

  it('still resolves an org-only project (no registry entry)', async () => {
    const tx = fakeTx([
      { match: 'harness_registry', rows: [] },
      { match: 'FROM harness_shared.projects', rows: [{ slug: 'barchart-landing', status: 'in_progress', updated_ts: 2 }] },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await statusOne({ slug: 'barchart-landing' }, tx);
    expect(b.results[0].source).toBe('project');
    expect(b.results[0].status).toBe('in_progress');
  });

  it('a slug that exists nowhere fails its item (counts.failed===1, batch ok)', async () => {
    const tx = fakeTx([]);
    const b = await statusOne({ slug: 'nope' }, tx);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0].ok).toBe(false);
    expect(b.results[0].error).toContain('nope');
  });
});
