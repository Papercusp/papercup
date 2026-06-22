/**
 * harness:status — registry⊕projects merge cases (Gap 12) AND the bulk
 * keyed-array dual-arity (bulk-endpoint-standardization-2026-06-21 P-006).
 *
 * list-status-registry.test.ts already pins: registry-only resolution, a
 * projects-row detail, an org-only (no-registry) project, and the
 * degrade-everywhere case. This file adds the remaining merge teeth (now read
 * out of the bulk envelope's per-slug result):
 *   - BOTH stores present → the registry PATH wins while the project row
 *     supplies status / budget_cents / spent_cents (the "merge", not "pick")
 *   - recentActivity is bound to the slug (the audit query filters on subject)
 *     and survives into the envelope
 *   - the `slug` echoed in the result is the ARG, not a row column
 *   - arg schema requires `slug` (one) or `slugs` (many)
 *
 * Bulk contract: the n=1 `{ slug }` call returns the SAME { ok, results:[…],
 * counts } envelope as `{ slugs:[…] }`; a not-found harness fails only ITSELF
 * (top-level ok:true, counts.failed===1) while siblings resolve.
 *
 * Plus a fault-injection (the prompt's "prove non-vacuous" ask): if the
 * registry leg is silently dropped (regression to projects-only), a
 * registry-ONLY harness goes back to "not found". We assert the live tree
 * does NOT do that — and the inline note documents the failing-mutant.
 *
 * Folds Gap 15 (registration: harness:status defined + harness:read cap).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';
import tool from './status';

type Row = Record<string, unknown>;

/** Tagged-template fake `tx` routing on a substring of the query text. */
function fakeTx(routes: Array<{ match: string; rows: Row[] }>) {
  const boundBySubject: unknown[] = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('audit_log')) boundBySubject.push(...values);
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
  return { tx, boundBySubject };
}

const ctxWith = (tx: unknown) =>
  ({
    log() {},
    tx,
    principal: { slug: 'system:operator', workspaceId: 'ws-1', capabilities: new Set<string>() },
  }) as never;

type Out = { content: { text: string }[] };
/** Run the bulk handler and parse the keyed-array envelope. */
const env = async (args: Record<string, unknown>, tx: unknown) =>
  JSON.parse(((await tool.handler(args as never, ctxWith(tx))) as Out).content[0]!.text) as {
    ok: boolean;
    results: any[];
    counts: { ok: number; failed: number };
  };

const REGISTRY_ROW = {
  payload: { projects: [{ slug: 'papercup', path: '/repo/papercup' }] },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('harness:status — both stores merge (Gap 12)', () => {
  it('registry PATH wins while the project row supplies status + budget + spend', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      {
        match: 'FROM harness_shared.projects',
        rows: [{ slug: 'papercup', status: 'in_progress', updated_ts: 5, spent_cents: 12, budget_cents: 100 }],
      },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slug: 'papercup' }, tx);
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    const r = b.results[0];
    expect(r.ok).toBe(true);
    expect(r.source).toBe('registry'); // registry leg present → source registry
    expect(r.path).toBe('/repo/papercup'); // path comes from the registry
    expect(r.status).toBe('in_progress'); // status comes from the project row
    expect(r.budget_cents).toBe(100);
    expect(r.spent_cents).toBe(12);
    expect(r.updated_ts).toBe(5);
  });
});

describe('harness:status — recentActivity (Gap 12)', () => {
  it('binds the slug to the audit query and surfaces the rows', async () => {
    const { tx, boundBySubject } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      {
        match: 'audit_log',
        rows: [
          { ts: 2, action: 'iterate', actor: 'worker', subject: 'papercup' },
          { ts: 1, action: 'created', actor: 'op', subject: 'papercup' },
        ],
      },
    ]);
    const b = await env({ slug: 'papercup' }, tx);
    expect(boundBySubject).toContain('papercup'); // audit query filtered by slug
    expect(b.results[0].recentActivity).toHaveLength(2);
    expect(b.results[0].recentActivity[0].action).toBe('iterate');
  });

  it('echoes the ARG slug into the result (not a row column)', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slug: 'papercup' }, tx);
    expect(b.results[0].slug).toBe('papercup');
  });
});

describe('harness:status — bulk keyed-array dual-arity (P-006)', () => {
  it('n=1 { slug } returns the same { ok, results, counts } envelope (one result)', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slug: 'papercup' }, tx);
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results).toHaveLength(1);
    expect(b.results[0]).toMatchObject({ ok: true, slug: 'papercup', source: 'registry' });
  });

  it('slugs:[…] reads many; a not-found harness fails only itself', async () => {
    // Registry knows only `papercup`; `gone` has no registry + no project row → not found.
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slugs: ['papercup', 'gone'] }, tx);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results.map((r) => [r.slug, r.ok])).toEqual([
      ['papercup', true],
      ['gone', false],
    ]);
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'gone' });
    expect(b.results[1].error).toContain('gone');
  });

  it('dedups slug + slugs into one merged list', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slug: 'papercup', slugs: ['papercup', 'gone'] }, tx);
    expect(b.results.map((r) => r.slug)).toEqual(['papercup', 'gone']);
  });
});

describe('harness:status — registry-fallback is non-vacuous (Gap 12 fault-injection)', () => {
  // A registry-ONLY harness (no projects row) is exactly the case the P-004
  // fix exists for: pre-fix, harness:status read only `projects` and returned
  // "not found" for a freshly-created (registry-written) harness. If the
  // registry leg were dropped today, the entry would be null and — with no
  // project row — the item would fail. This test fails the moment that
  // regression returns, so the registry merge is provably load-bearing.
  it('a registry-only harness resolves (would fail if the registry leg were dropped)', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] }, // no project row
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slug: 'papercup' }, tx);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].source).toBe('registry');
    expect(b.results[0].status).toBe('registered'); // the registry-only default
  });

  it('control: with the registry row absent AND no project row, the SAME slug fails its item', async () => {
    // Proves the previous test is not vacuously green — remove the registry
    // row and the identical call now fails the item, so the registry leg is what
    // saved it above.
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const b = await env({ slug: 'papercup' }, tx);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0].ok).toBe(false);
    expect(b.results[0].error).toContain('papercup');
  });
});

describe('harness:status — arg schema + registration (Gap 12 / Gap 15)', () => {
  it('requires `slug` (one) or `slugs` (many)', () => {
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ slug: '' }).success).toBe(false);
    expect(tool.args.safeParse({ slug: 'sheets' }).success).toBe(true);
    expect(tool.args.safeParse({ slugs: ['sheets', 'docs'] }).success).toBe(true);
  });

  it('is registered under harness:status with the harness:read capability', () => {
    const t = lookupByMcpName('harness:status')!;
    expect(t).toBeDefined();
    expect(t.capabilities).toContain('harness:read');
  });
});
