/**
 * Unit coverage for the pure completion-time generator-expansion helpers (P-043).
 */
import { describe, it, expect, vi } from 'vitest';
import { selectCompletionTimeWaves, planGeneratorChildren, expandGeneratorsForFeature } from './expand-generators';
import { FanoutCapError } from '@papercusp/fanout-resolver';
import type { PromoteWave } from './promote-policy';

const genWave = (id: string, from_feature: string, titleTpl = 'Fix {item}'): PromoteWave => ({
  id,
  generate: { for_each: { from_feature }, feature_template: { title: titleTpl } },
});

describe('selectCompletionTimeWaves', () => {
  it('matches a from_feature wave by feature id', () => {
    const policy = { waves: [genWave('w2', 'F-SCAN')] };
    expect(selectCompletionTimeWaves(policy, 'F-SCAN').map((w) => w.id)).toEqual(['w2']);
  });

  it('matches by title when the id does not match', () => {
    const policy = { waves: [genWave('w2', 'Scan all routes')] };
    expect(selectCompletionTimeWaves(policy, 'F-XYZ', 'Scan all routes').map((w) => w.id)).toEqual(['w2']);
  });

  it('ignores promote-time resolvers (items/glob/sql) and static waves', () => {
    const policy = {
      waves: [
        { id: 'static', features: [{ title: 'X' }] } as PromoteWave,
        { id: 'glob', generate: { for_each: { glob: '**/*.ts' }, feature_template: { title: 'T {item}' } } } as PromoteWave,
        genWave('comp', 'F-SCAN'),
      ],
    };
    expect(selectCompletionTimeWaves(policy, 'F-SCAN').map((w) => w.id)).toEqual(['comp']);
  });

  it('returns nothing when no wave sources from this feature', () => {
    expect(selectCompletionTimeWaves({ waves: [genWave('w2', 'F-OTHER')] }, 'F-SCAN')).toEqual([]);
  });
});

describe('planGeneratorChildren', () => {
  const wave = genWave('w2', 'F-SCAN', 'Add test for {item}');

  it('mints one child per item, blocked_by the source, with generated_by provenance', () => {
    const children = planGeneratorChildren(wave, ['/a', '/b'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(children).toHaveLength(2);
    expect(children[0].title).toBe('Add test for /a');
    expect(children[0].blocked_by).toEqual(['F-SCAN']);
    expect(children[0].source_plan_slug).toBe('p');
    expect(children[0].metadata.generated_by).toEqual({ plan: 'p', wave: 'w2', source: 'F-SCAN' });
    expect(children[0].id).toMatch(/^F-GEN-[a-z0-9]{7}$/);
  });

  it('is idempotent: same (plan, wave, item) → same deterministic id', () => {
    const a = planGeneratorChildren(wave, ['/a'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    const b = planGeneratorChildren(wave, ['/a'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(a[0].id).toBe(b[0].id);
  });

  it('different items / waves / plans → different ids', () => {
    const id = (item: string, slug = 'p', w = wave) =>
      planGeneratorChildren(w, [item], { planSlug: slug, sourceFeatureId: 'F-SCAN' })[0].id;
    expect(id('/a')).not.toBe(id('/b'));
    expect(id('/a')).not.toBe(id('/a', 'other-plan'));
    expect(id('/a')).not.toBe(id('/a', 'p', genWave('w3', 'F-SCAN', 'Add test for {item}')));
  });

  it('dedupes + trims items', () => {
    const children = planGeneratorChildren(wave, [' /a ', '/a', '/b', ''], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(children.map((c) => c.title).sort()).toEqual(['Add test for /a', 'Add test for /b']);
  });

  it('throws FanoutCapError over the cap (never truncates)', () => {
    const many = Array.from({ length: 5 }, (_, i) => `i-${i}`);
    expect(() => planGeneratorChildren(wave, many, { planSlug: 'p', sourceFeatureId: 'F-SCAN', cap: 3 })).toThrow(
      FanoutCapError,
    );
  });

  it('folds the template acceptance bullets into the child summary', () => {
    const w: PromoteWave = {
      id: 'w2',
      generate: {
        for_each: { from_feature: 'F-SCAN' },
        feature_template: { title: 'Fix {item}', acceptance: ['{item} returns 200'] },
      },
    };
    const children = planGeneratorChildren(w, ['/a'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(children[0].summary).toContain('/a returns 200');
  });
});

// ── Driver glue (expandGeneratorsForFeature) — DI seam, no PG / no loopback ──
// The pure helpers above are covered; here we assert the async GLUE: the
// source-plan + items lookups, the D-012a "never silently yields zero"
// escalation, /features/import success & failure, and per-wave isolation.
type ExpandDeps = NonNullable<Parameters<typeof expandGeneratorsForFeature>[0]['deps']>;
type SqlReturn = unknown[] | Error;

/** Fake org-PG tagged-template: canned rows per call in order; records values. */
function makeSql(returns: SqlReturn[]) {
  let i = 0;
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args.slice(1));
    const r = returns[i++] ?? [];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return Object.assign(fn, { calls });
}
const asSql = (returns: SqlReturn[]) => makeSql(returns) as unknown as ExpandDeps['sql'];

const promotePlan = (waves: string) =>
  '---\ntitle: T\nslug: my-plan\nstatus: active\n---\n\n# T\n\n## Now\n\n**State:** x\n\n' +
  '## Promote\n\n```yaml\ntarget_harness: restart\nwaves:\n' +
  waves +
  '```\n\n## Decisions\n';
const STATIC_WAVE = '  - id: tier1\n    features:\n      - title: "Discover types"\n';
const genFromScan = (id: string) =>
  `  - id: ${id}\n    blocked_by: tier1\n    generate:\n      for_each:\n        from_feature: "F-SCAN"\n` +
  '      feature_template:\n        title: "Schema: {item}"\n        acceptance: ["validates {item}"]\n';
const PLAN_ONE_WAVE = promotePlan(STATIC_WAVE + genFromScan('tier2'));
const PLAN_TWO_WAVES = promotePlan(STATIC_WAVE + genFromScan('tier2') + genFromScan('tier3'));
const PLAN_NO_COMP_WAVE = promotePlan(STATIC_WAVE);

const readPlanReturning = (raw: string | null): ExpandDeps['readPlan'] =>
  async () => (raw == null ? null : { parsed: { raw } });
const okFetch = () =>
  vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({
    ok: true,
    status: 200,
    text: async () => '',
  }));

const BASE = { harnessSlug: 'h', featureId: 'F-SCAN', workspaceId: 'ws-1' };
const EMPTY = { expanded: 0, waves: 0, childIds: [], escalations: [] };

describe('expandGeneratorsForFeature — driver glue', () => {
  it('feature has no source_plan → EMPTY (no plan read, no import)', async () => {
    const readPlan = vi.fn(readPlanReturning(PLAN_ONE_WAVE));
    const fetchImport = okFetch();
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: { sql: asSql([[{ title: 'X', source_plan: null }]]), readPlan, fetchImport },
    });
    expect(r).toEqual(EMPTY);
    expect(readPlan).not.toHaveBeenCalled();
    expect(fetchImport).not.toHaveBeenCalled();
  });

  it('source_plan set but plan not found → EMPTY', async () => {
    const fetchImport = okFetch();
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: {
        sql: asSql([[{ title: 'X', source_plan: 'gone' }]]),
        readPlan: readPlanReturning(null),
        fetchImport,
      },
    });
    expect(r).toEqual(EMPTY);
    expect(fetchImport).not.toHaveBeenCalled();
  });

  it('no wave sources from this feature → EMPTY (waves: 0)', async () => {
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: {
        sql: asSql([[{ title: 'X', source_plan: 'my-plan' }]]),
        readPlan: readPlanReturning(PLAN_NO_COMP_WAVE),
        fetchImport: okFetch(),
      },
    });
    expect(r.waves).toBe(0);
    expect(r.expanded).toBe(0);
  });

  it('requireItems + a sourced wave with zero published items → escalation (D-012a, never silently yields zero)', async () => {
    const fetchImport = okFetch();
    const r = await expandGeneratorsForFeature({
      ...BASE,
      requireItems: true,
      deps: {
        // feature lookup → has source_plan; items lookup → no rows (zero items)
        sql: asSql([[{ title: 'X', source_plan: 'my-plan' }], []]),
        readPlan: readPlanReturning(PLAN_ONE_WAVE),
        fetchImport,
      },
    });
    expect(r.waves).toBe(1);
    expect(r.expanded).toBe(0);
    expect(r.escalations).toHaveLength(1);
    expect(r.escalations[0]).toMatch(/published no items/);
    expect(fetchImport).not.toHaveBeenCalled();
  });

  it('/features/import returns not-ok → escalation, nothing expanded', async () => {
    const fetchImport = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'kaboom' }));
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: {
        sql: asSql([[{ title: 'X', source_plan: 'my-plan' }], [{ items: ['/a', '/b'] }]]),
        readPlan: readPlanReturning(PLAN_ONE_WAVE),
        fetchImport: fetchImport as unknown as ExpandDeps['fetchImport'],
      },
    });
    expect(r.expanded).toBe(0);
    expect(r.childIds).toEqual([]);
    expect(r.escalations).toHaveLength(1);
    expect(r.escalations[0]).toMatch(/import failed: 500/);
  });

  it('/features/import throws → escalation (best-effort, never throws)', async () => {
    const fetchImport = vi.fn(async () => {
      throw new Error('socket hangup');
    });
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: {
        sql: asSql([[{ title: 'X', source_plan: 'my-plan' }], [{ items: ['/a'] }]]),
        readPlan: readPlanReturning(PLAN_ONE_WAVE),
        fetchImport: fetchImport as unknown as ExpandDeps['fetchImport'],
      },
    });
    expect(r.expanded).toBe(0);
    expect(r.escalations[0]).toMatch(/import error/);
  });

  it('success → mints one child per item via /features/import (URL + payload), reports expanded + childIds', async () => {
    const fetchImport = okFetch();
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: {
        sql: asSql([[{ title: 'X', source_plan: 'my-plan' }], [{ items: ['/a', '/b'] }]]),
        readPlan: readPlanReturning(PLAN_ONE_WAVE),
        fetchImport,
      },
    });
    expect(r.expanded).toBe(2);
    expect(r.childIds).toHaveLength(2);
    expect(r.childIds.every((id) => /^F-GEN-[a-z0-9]{7}$/.test(id))).toBe(true);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImport.mock.calls[0];
    expect(url).toContain('/api/harness/h/features/import');
    const body = JSON.parse(init.body) as { features: Array<{ title: string; blocked_by: string[] }> };
    expect(body.features.map((f) => f.title).sort()).toEqual(['Schema: /a', 'Schema: /b']);
    expect(body.features[0].blocked_by).toEqual(['F-SCAN']); // each child waits for its producer
  });

  it('per-wave isolation: one wave’s import failure does not sink the next wave', async () => {
    const fetchImport = vi.fn();
    fetchImport
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    const r = await expandGeneratorsForFeature({
      ...BASE,
      deps: {
        sql: asSql([[{ title: 'X', source_plan: 'my-plan' }], [{ items: ['/a'] }]]),
        readPlan: readPlanReturning(PLAN_TWO_WAVES),
        fetchImport: fetchImport as unknown as ExpandDeps['fetchImport'],
      },
    });
    expect(r.waves).toBe(2);
    expect(fetchImport).toHaveBeenCalledTimes(2);
    expect(r.escalations).toHaveLength(1); // only the first wave failed
    expect(r.expanded).toBe(1); // the second wave still minted its child
  });
});
