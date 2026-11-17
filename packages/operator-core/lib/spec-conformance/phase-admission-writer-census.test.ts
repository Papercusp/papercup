import { describe, expect, it } from 'vitest';
import {
  assertPhaseWriterCensus, inventoryPhaseWriters, reconcilePhaseWriterCensus,
  type PhaseWriterReview, type PhaseWriterSite,
} from './phase-admission-writer-census';

const source = (content: string, path = 'packages/operator-core/lib/example.ts') => ({ path, content });
function review(site: PhaseWriterSite, disposition: PhaseWriterReview['disposition'] = 'advancing'): PhaseWriterReview {
  return { siteId: site.id, sourceSha256: site.sourceSha256, statementSha256: site.statementSha256,
    disposition, reason: 'Inspected the complete synthetic statement and its transaction boundary.',
    evidenceRefs: [`source:${site.path}#${site.operation}`],
    resolvedEdges: [...new Set([...site.dynamicEdges, ...site.unresolved, ...site.callees])].map(edge => ({
      edge, reason: 'Resolved in this isolated fixture; production review must name its real source.',
      evidenceRefs: [`source:${site.path}#${site.operation}`],
    })), revalidationSeam: 'exampleWrite transaction',
    raceTest: 'phase-admission.integration.test.ts :: example write current/stale variants' };
}
const write = 'async function exampleWrite(tx) { await tx`UPDATE harness_shared.work_items SET status=${status} WHERE feature_id=${id}`; }';

describe('phase binding writer census', () => {
  it('retains INSERT upsert UPDATE DELETE and writable CTE statements independently', () => {
    const inventory = inventoryPhaseWriters([source(`
      async function create(tx) {
        await tx\`INSERT INTO harness_shared.plan_item_claims(owner,item_id) VALUES ('a','P-001')
          ON CONFLICT(item_id) DO UPDATE SET owner=EXCLUDED.owner\`;
        await tx\`UPDATE harness_shared.work_items SET status='open' WHERE feature_id='WI-1'\`;
        await tx\`DELETE FROM harness_shared.plan_item_claims WHERE item_id='P-001'\`;
        await tx\`WITH changed AS (UPDATE harness_shared.work_items SET status='done' RETURNING *) SELECT * FROM changed\`;
      }
    `)]);
    expect(inventory.sites.filter(site => site.kind === 'sql')).toHaveLength(4);
    expect(inventory.sites.some(site => site.columns.includes('owner') && site.columns.includes('item_id'))).toBe(true);
    expect(inventory.sites.filter(site => site.columns.includes('status'))).toHaveLength(2);
    expect(new Set(inventory.sites.map(site => site.id)).size).toBe(4);
  });

  it('rejects unclassified and stale exempt writers without execution', () => {
    const inventory = inventoryPhaseWriters([source(write)]);
    expect(inventory.sites).toHaveLength(1);
    const site = inventory.sites[0]!;
    expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
    const exemption = review(site, 'isolated-fixture');
    expect(assertPhaseWriterCensus(inventory, [exemption]).coverage.notApplicable).toEqual([site.id]);
    const changed = inventoryPhaseWriters([source(write + '\nexport const changed = true;')]);
    expect(() => assertPhaseWriterCensus(changed, [exemption])).toThrow('stale-review');
    const deleted = inventoryPhaseWriters([]);
    expect(() => assertPhaseWriterCensus(deleted, [exemption])).toThrow('reviewed-writer-missing');
  });

  it('rejects unresolved dynamic edges and removed classification guards', () => {
    const inventory = inventoryPhaseWriters([source('async function execute(db, statement) { await db.unsafe(statement); }')]);
    const site = inventory.sites[0]!;
    expect(site.kind).toBe('unresolved');
    const inspected = review(site);
    expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected, resolvedEdges: [] }])).toThrow('unresolved-edge');
    expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
    expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected, revalidationSeam: undefined }])).toThrow('advancing-seam-or-race-test-missing');
    expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected, reason: '' }])).toThrow('review-proof-missing');
  });

  it('follows wrapper calls across the complete supplied population to a fixed point', () => {
    const inventory = inventoryPhaseWriters([
      source(write),
      source('export async function outer(tx) { await middle(tx); }', 'apps/operator/lib/outer.ts'),
      source('export async function middle(tx) { await exampleWrite(tx); }', 'libs/example/middle.ts'),
      source('export async function entry(tx) { await outer(tx); }', 'scripts/entry.ts'),
    ]);
    const edges = inventory.sites.filter(site => site.kind === 'helper-edge');
    expect(edges.map(site => site.operation).sort()).toEqual(['entry', 'middle', 'outer']);
    expect(reconcilePhaseWriterCensus(inventory, []).coverage.residue).toHaveLength(4);
  });

  it('keeps complete identities and the decisive writer beyond former lookahead boundaries', () => {
    for (const padding of [1199, 1200, 1201, 10000]) {
      const statement = `UPDATE harness_shared.harness_plans SET ${' '.repeat(padding)}content='new',content_hash='hash' WHERE plan_slug='p'`;
      const inventory = inventoryPhaseWriters([source(`async function write(tx) { await tx\`${statement}\`; }`)]);
      expect(inventory.sites).toHaveLength(1);
      expect(inventory.sites[0]!.statement).toContain(statement);
      expect(inventory.sites[0]!.columns).toEqual(['content', 'content_hash']);
    }
    const name = 'x'.repeat(400);
    const inventory = inventoryPhaseWriters([source(write.replaceAll('exampleWrite', name))]);
    expect(inventory.sites[0]!.operation).toBe(name);
    expect(inventory.sites[0]!.id).toContain(name);
  });

  it('preserves parse gaps trigger bodies opaque languages and append authorities as residue', () => {
    const inventory = inventoryPhaseWriters([
      source('export function broken( {', 'packages/broken.ts'),
      source('CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN UPDATE harness_shared.work_items SET status=NEW.status; RETURN NEW; END $$ LANGUAGE plpgsql', 'scripts/current-trigger.sql'),
      source('UPDATE harness_shared.work_items SET status = "open"', 'scripts/legacy.py'),
      source('async function claim(ownLog, op) { await ownLog.withAppendsHeld(async held => held.append(op)); }', 'libs/feature-claim.ts'),
    ], [{ id: 'submodule:libs/missing', reason: 'declared-submodule-not-enumerated' }]);
    expect(inventory.gaps.map(gap => gap.id).sort()).toEqual(['source:packages/broken.ts', 'submodule:libs/missing']);
    expect(inventory.sites.some(site => site.kind === 'sql-function')).toBe(true);
    expect(inventory.sites.some(site => site.operation === '<unparsed-source>')).toBe(true);
    expect(inventory.sites.some(site => site.kind === 'authority-append')).toBe(true);
    const report = reconcilePhaseWriterCensus(inventory, []);
    expect(report.ready).toBe(false);
    expect(report.coverage.notChecked).toEqual(report.coverage.population);
    expect(new Set(report.coverage.population).size).toBe(report.coverage.population.length);
  });

  it('produces exact disjoint coverage partitions independent of source and review order', () => {
    const sources = [source(write), source(write, 'apps/operator/lib/example.ts')];
    const inventory = inventoryPhaseWriters(sources);
    const reviews = inventory.sites.map((site, i) => review(site, i === 0 ? 'metadata-only' : 'historical/unreachable'));
    const forward = assertPhaseWriterCensus(inventory, reviews);
    const reverse = assertPhaseWriterCensus(inventoryPhaseWriters([...sources].reverse()), [...reviews].reverse());
    expect(reverse).toEqual(forward);
    expect(forward.coverage.residue).toEqual([]);
    expect([...forward.coverage.checked, ...forward.coverage.notChecked, ...forward.coverage.notApplicable].sort())
      .toEqual([...forward.coverage.population].sort());
    expect(() => assertPhaseWriterCensus(inventory, [...reviews, reviews[0]!])).toThrow('duplicate-review');
  });
});
