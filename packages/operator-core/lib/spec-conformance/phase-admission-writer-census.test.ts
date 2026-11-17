import { describe, expect, it } from 'vitest';
import {
  assertPhaseWriterCensus, inventoryPhaseWriters, reconcilePhaseWriterCensus,
  readPhaseWriterCensus, writePhaseWriterCensus,
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

  it('discovers dormant literals renamed imports and dynamic relation targets', () => {
    const inventory = inventoryPhaseWriters([
      source(write),
      source("import { exampleWrite as renamed } from './example'; async function alias(tx) { await renamed(tx); }", 'packages/operator-core/lib/alias.ts'),
      source('const dormant = "UPDATE harness_shared.work_items SET status=\'open\'";', 'scripts/dormant.ts'),
      source('async function dynamic(tx, table) { await tx`UPDATE ${table} SET status=${status}`; }', 'apps/operator/lib/dynamic.ts'),
    ]);
    expect(inventory.sites.some(site => site.path === 'scripts/dormant.ts' && site.kind === 'sql')).toBe(true);
    expect(inventory.sites.some(site => site.operation === 'alias' && site.kind === 'helper-edge')).toBe(true);
    const dynamic = inventory.sites.find(site => site.operation === 'dynamic')!;
    expect(dynamic.dynamicEdges).toContain('table');
    expect(dynamic.unresolved).toContain('sql-parse-unresolved');
    expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
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

  it('keeps SELECT helper calls delegated function bodies and opaque dynamic SQL unclassified', () => {
    const inventory = inventoryPhaseWriters([
      source('async function advance(tx) { await tx`SELECT public.forward_phase(${id})`; }'),
      source('CREATE FUNCTION public.bridge() RETURNS void AS $$ SELECT public.forward_phase(); $$ LANGUAGE sql', 'scripts/bridge.sql'),
      source('SELECT public.bridge()', 'scripts/invoke.sql'),
      source('def run(db, query):\n    db.execute(query)', 'scripts/dynamic.py'),
      source('async function opaque(tx, query) { await tx`SELECT ${query}`; }', 'packages/opaque.ts'),
    ]);
    expect(inventory.sites.find(site => site.operation === 'advance')!.callees).toEqual(['public.forward_phase']);
    expect(inventory.sites.find(site => site.path === 'scripts/bridge.sql')!.kind).toBe('sql-function');
    expect(inventory.sites.find(site => site.path === 'scripts/invoke.sql')!.callees).toEqual(['public.bridge']);
    expect(inventory.sites.find(site => site.path === 'scripts/dynamic.py')!.unresolved).toContain('source-language-requires-review');
    expect(inventory.sites.find(site => site.path === 'packages/opaque.ts')!.dynamicEdges).toEqual(['query']);
    const reviews = inventory.sites.map(site => review(site));
    const helper = inventory.sites.find(site => site.path === 'scripts/invoke.sql')!;
    const unproved = reviews.map(row => row.siteId === helper.id ? { ...row, resolvedEdges: [] } : row);
    expect(reconcilePhaseWriterCensus(inventory, unproved).problems.find(row => row.id === helper.id)!.reasons)
      .toContain('unresolved-edge:public.bridge');
    expect(() => assertPhaseWriterCensus(inventory, unproved)).toThrow('phase_writer_census_incomplete');
    expect(reconcilePhaseWriterCensus(inventory, []).coverage.residue).toHaveLength(inventory.sites.length);
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

  it('streams complete records through a backpressured consumer across batch boundaries', async () => {
    for (const size of [3, 4, 5, 81]) {
      const inventory = inventoryPhaseWriters(Array.from({ length: size }, (_, i) =>
        source(write, `packages/example/${i}.ts`)));
      const reviews = inventory.sites.map(site => review(site, 'metadata-only'));
      // The decisive unreviewed writer is last, after many consumer batches.
      const last = inventory.sites.at(-1)!;
      const lines: string[] = [];
      let writing = false;
      const footer = await writePhaseWriterCensus({ ...inventory,
        excluded: [{ path: 'docs/full-identity.md', reason: 'outside-declared-runtime-roots' }],
        enumeration: { scanned: ['.', 'libs/papercusp'], unscanned: [] } },
      reviews.filter(row => row.siteId !== last.id), async line => {
        expect(writing).toBe(false);
        writing = true;
        await Promise.resolve();
        lines.push(line);
        writing = false;
      });
      const restored: Array<{ kind: string; value: any }> = [];
      async function* batches() {
        for (let start = 0; start < lines.length; start += 4) {
          for (const line of lines.slice(start, start + 4)) yield line;
          await Promise.resolve();
        }
      }
      expect(await readPhaseWriterCensus(batches(), row => { restored.push(row); })).toEqual(footer);
      expect(footer.ready).toBe(false);
      expect(restored.filter(row => row.kind === 'site').map(row => row.value)).toEqual(inventory.sites);
      expect(restored.filter(row => row.kind === 'source').map(row => row.value)).toEqual(inventory.sources);
      expect(restored.find(row => row.kind === 'excluded')!.value.path).toBe('docs/full-identity.md');
      expect(restored.filter(row => row.kind === 'scanned').map(row => row.value)).toEqual(['.', 'libs/papercusp']);
      const coverage = restored.filter(row => row.kind === 'coverage').map(row => row.value);
      expect(coverage.map(row => row.id)).toEqual(inventory.sites.map(site => site.id));
      expect(coverage.at(-1)).toMatchObject({ id: last.id, partition: 'notChecked', residue: true });
    }
  });

  it('refuses interrupted corrupt reordered or appended exports and recovers by complete regeneration', async () => {
    const inventory = inventoryPhaseWriters([source(write)]), lines: string[] = [];
    const reviews = inventory.sites.map(site => review(site));
    const footer = await writePhaseWriterCensus(inventory, reviews, line => { lines.push(line); });
    expect(footer.ready).toBe(true);
    for (let end = 0; end < lines.length; end++) {
      await expect(readPhaseWriterCensus(lines.slice(0, end))).rejects.toThrow('incomplete');
    }
    const corrupt = [...lines]; corrupt[1] = corrupt[1]!.replace('sha256', 'sha255');
    await expect(readPhaseWriterCensus(corrupt)).rejects.toThrow('integrity');
    await expect(readPhaseWriterCensus([lines[1]!, lines[0]!, ...lines.slice(2)])).rejects.toThrow('sequence');
    await expect(readPhaseWriterCensus([...lines, lines[0]!])).rejects.toThrow('after_footer');
    const regenerated: string[] = [];
    await expect(writePhaseWriterCensus(inventory, reviews, line => {
      if (JSON.parse(line).kind === 'site') throw new Error('sink-unavailable');
    })).rejects.toThrow('sink-unavailable');
    await writePhaseWriterCensus(inventory, reviews, line => { regenerated.push(line); });
    expect(regenerated).toEqual(lines);
    expect(await readPhaseWriterCensus(regenerated)).toEqual(footer);
  });

  it('preserves the complete refusal report outside the diagnostic preview', () => {
    const inventory = inventoryPhaseWriters(Array.from({ length: 81 }, (_, i) =>
      source(write, `packages/example/${i}.ts`)));
    let error: (Error & { report: ReturnType<typeof reconcilePhaseWriterCensus> }) | undefined;
    try { assertPhaseWriterCensus(inventory, []); }
    catch (caught) { error = caught as typeof error; }
    expect(error?.message).toContain('first-reason-preview; complete report on error.report');
    expect(error?.report).toEqual(reconcilePhaseWriterCensus(inventory, []));
    expect(error?.report.coverage.residue.at(-1)).toBe(inventory.sites.at(-1)!.id);
  });
});
