/**
 * harness:status — registry⊕projects merge cases NOT covered by
 * list-status-registry.test.ts (Gap 12).
 *
 * list-status-registry.test.ts already pins: registry-only resolution, a
 * projects-row detail, an org-only (no-registry) project, and the
 * degrade-everywhere case. This file adds the remaining merge teeth:
 *   - BOTH stores present → the registry PATH wins while the project row
 *     supplies status / budget_cents / spent_cents (the "merge", not "pick")
 *   - recentActivity is bound to the slug (the audit query filters on subject)
 *     and survives into the envelope
 *   - the `slug` echoed in `data.slug` is the ARG, not a row column
 *   - arg schema requires a non-empty slug
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

const run = async (args: Record<string, unknown>, tx: unknown) =>
  (await tool.handler(args as never, ctxWith(tx))) as {
    data: any;
    degraded?: boolean;
    degradedReasons?: string[];
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
    const r = await run({ slug: 'papercup' }, tx);
    expect(r.degraded).toBeUndefined();
    expect(r.data.source).toBe('registry'); // registry leg present → source registry
    expect(r.data.path).toBe('/repo/papercup'); // path comes from the registry
    expect(r.data.status).toBe('in_progress'); // status comes from the project row
    expect(r.data.budget_cents).toBe(100);
    expect(r.data.spent_cents).toBe(12);
    expect(r.data.updated_ts).toBe(5);
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
    const r = await run({ slug: 'papercup' }, tx);
    expect(boundBySubject).toContain('papercup'); // audit query filtered by slug
    expect(r.data.recentActivity).toHaveLength(2);
    expect(r.data.recentActivity[0].action).toBe('iterate');
  });

  it('echoes the ARG slug into data.slug (not a row column)', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const r = await run({ slug: 'papercup' }, tx);
    expect(r.data.slug).toBe('papercup');
  });
});

describe('harness:status — registry-fallback is non-vacuous (Gap 12 fault-injection)', () => {
  // A registry-ONLY harness (no projects row) is exactly the case the P-004
  // fix exists for: pre-fix, harness:status read only `projects` and returned
  // "not found" for a freshly-created (registry-written) harness. If the
  // registry leg were dropped today, `regEntry` would be null and — with no
  // project row — the handler would degrade. This test fails the moment that
  // regression returns, so the registry merge is provably load-bearing.
  it('a registry-only harness resolves (would degrade if the registry leg were dropped)', async () => {
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [REGISTRY_ROW] },
      { match: 'FROM harness_shared.projects', rows: [] }, // no project row
      { match: 'audit_log', rows: [] },
    ]);
    const r = await run({ slug: 'papercup' }, tx);
    expect(r.degraded).toBeUndefined();
    expect(r.data).not.toBeNull();
    expect(r.data.source).toBe('registry');
    expect(r.data.status).toBe('registered'); // the registry-only default
  });

  it('control: with the registry row absent AND no project row, the SAME slug degrades', async () => {
    // Proves the previous test is not vacuously green — remove the registry
    // row and the identical call now degrades, so the registry leg is what
    // saved it above.
    const { tx } = fakeTx([
      { match: 'harness_registry', rows: [] },
      { match: 'FROM harness_shared.projects', rows: [] },
      { match: 'audit_log', rows: [] },
    ]);
    const r = await run({ slug: 'papercup' }, tx);
    expect(r.data).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons![0]).toContain('papercup');
  });
});

describe('harness:status — arg schema + registration (Gap 12 / Gap 15)', () => {
  it('requires a non-empty slug', () => {
    expect(tool.args.safeParse({ slug: '' }).success).toBe(false);
    expect(tool.args.safeParse({ slug: 'sheets' }).success).toBe(true);
  });

  it('is registered under harness:status with the harness:read capability', () => {
    const t = lookupByMcpName('harness:status')!;
    expect(t).toBeDefined();
    expect(t.capabilities).toContain('harness:read');
  });
});
