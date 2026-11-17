import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPhaseWriterCensus, assertPhaseWriterTreeCensus, inventoryPhaseWriters, reconcilePhaseWriterCensus,
  inventoryPhaseWriterTree, readPhaseWriterCensus, verifyPhaseWriterTreeSnapshot, writePhaseWriterCensus,
  type PhaseWriterReview, type PhaseWriterSite, type PhaseWriterTreeManifest,
} from './phase-admission-writer-census';

const source = (content: string, path = 'packages/operator-core/lib/example.ts') => ({ path, content });
function review(site: PhaseWriterSite, disposition: PhaseWriterReview['disposition'] = 'advancing'): PhaseWriterReview {
  return { siteId: site.id, sourceSha256: site.sourceSha256, statementSha256: site.statementSha256,
    sourceProofs: [{ path: site.path, sha256: site.sourceSha256 }],
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

  it('retains canonical claim read and release reviews without accepting advancing writes', () => {
    const root = new URL('../../../../', import.meta.url);
    const reviewed = JSON.parse(readFileSync(new URL(
      'docs/evidence/phase-admission-claim-source-reviews-20261117.json', root), 'utf8')) as {
        basis: string;
        reviewedSourcePaths: string[];
        reviews: PhaseWriterReview[];
        pendingAdvancing: Array<{ siteId: string }>;
      };
    expect(reviewed.basis).toBe('partial-source-review-not-full-census-or-runtime-acceptance');
    const sources = reviewed.reviewedSourcePaths.map(path => ({
      path, content: readFileSync(new URL(path, root), 'utf8'),
    }));
    const inventory = inventoryPhaseWriters(sources);
    const report = reconcilePhaseWriterCensus(inventory, reviewed.reviews);
    const accepted = reviewed.reviews.map(row => row.siteId).sort();
    expect(report.ready).toBe(false);
    expect([...report.coverage.checked].sort()).toEqual(accepted);
    expect(report.coverage.notApplicable).toEqual([]);
    const unreviewed = inventory.sites.filter(site => !accepted.includes(site.id)).map(site => site.id);
    expect([...report.coverage.notChecked].sort()).toEqual([...unreviewed].sort());
    expect([...report.coverage.residue].sort()).toEqual([...unreviewed].sort());
    for (const { siteId } of reviewed.pendingAdvancing) {
      expect(report.problems).toContainEqual({ id: siteId, reasons: ['unclassified-writer'] });
    }
    expect(reviewed.pendingAdvancing.length).toBeGreaterThan(0);

    // A new source snapshot cannot silently re-approve the notifier dependency.
    // Claim statements stay identical; a whole SQL module gets a new identity.
    const dependency = 'libs/papercusp/libs/db/sql/525-fleet-assignment-work-items-notify.sql';
    const changed = inventoryPhaseWriters(sources.map(source => source.path === dependency
      ? { ...source, content: source.content + '\n-- changed notifier source\n' } : source));
    const stale = reconcilePhaseWriterCensus(changed, reviewed.reviews);
    for (const { siteId: id, sourceProofs } of reviewed.reviews) {
      if (!sourceProofs.some(proof => proof.path === dependency)) {
        expect(stale.coverage.checked).toContain(id);
        continue;
      }
      if (!changed.sites.some(site => site.id === id)) {
        const orphan = `orphan-review:${id}`;
        expect(stale.problems).toContainEqual({ id: orphan, reasons: ['reviewed-writer-missing'] });
        expect(stale.coverage.notChecked).toContain(orphan);
        expect(stale.coverage.residue).toContain(orphan);
        const replacements = changed.sites.filter(site => site.path === dependency);
        expect(replacements.length).toBeGreaterThan(0);
        for (const site of replacements) {
          expect(stale.problems).toContainEqual({ id: site.id, reasons: ['unclassified-writer'] });
          expect(stale.coverage.residue).toContain(site.id);
        }
        continue;
      }
      expect(stale.problems).toContainEqual({ id, reasons: [`stale-source-proof:${dependency}`] });
      expect(stale.coverage.notChecked).toContain(id);
      expect(stale.coverage.residue).toContain(id);
    }
    expect([...stale.coverage.checked].sort()).toEqual(reviewed.reviews
      .filter(row => !row.sourceProofs.some(proof => proof.path === dependency))
      .map(row => row.siteId).sort());
  });

  it('pins manually reviewed SQL modules without accepting changed bodies or adjacent migrations', () => {
    const root = new URL('../../../../', import.meta.url);
    const reviewed = JSON.parse(readFileSync(new URL(
      'docs/evidence/phase-admission-claim-source-reviews-20261117.json', root), 'utf8')) as {
        reviewedSourcePaths: string[]; reviews: PhaseWriterReview[];
      };
    const sources = reviewed.reviewedSourcePaths.map(path => ({
      path, content: readFileSync(new URL(path, root), 'utf8'),
    }));
    const inventory = inventoryPhaseWriters(sources);
    const modules = inventory.sites.filter(site => site.path.endsWith('.sql'));
    expect(modules.map(site => site.path).sort()).toEqual(sources
      .filter(source => source.path.endsWith('.sql')).map(source => source.path).sort());
    const byId = new Map(reviewed.reviews.map(row => [row.siteId, row]));
    const report = reconcilePhaseWriterCensus(inventory, reviewed.reviews);
    for (const site of modules) {
      expect(byId.get(site.id)).toMatchObject({ disposition: 'metadata-only',
        sourceSha256: site.sourceSha256, statementSha256: site.statementSha256 });
      expect(report.coverage.checked).toContain(site.id);
      for (const dependency of modules) expect(byId.get(site.id)?.sourceProofs).toContainEqual({
        path: dependency.path, sha256: dependency.sourceSha256,
      });
      const changed = inventoryPhaseWriters(sources.map(source => source.path === site.path
        ? { ...source, content: source.content + '\nUPDATE harness_shared.plan_item_claims SET owner = \'new-holder\';\n' }
        : source));
      const stale = reconcilePhaseWriterCensus(changed, reviewed.reviews);
      const changedSite = changed.sites.find(row => row.path === site.path && row.operation === '<sql-module>')!;
      expect(stale.coverage.notChecked).toContain(changedSite.id);
      expect(stale.coverage.residue).toContain(changedSite.id);
      expect(stale.problems).toContainEqual({ id: changedSite.id, reasons: ['unclassified-writer'] });
      for (const other of modules.filter(row => row.path !== site.path)) {
        expect(stale.problems).toContainEqual({ id: other.id, reasons: [`stale-source-proof:${site.path}`] });
      }
    }
    const adjacent = source('UPDATE harness_shared.plan_item_claims SET owner = \'new-holder\';',
      'libs/papercusp/libs/db/sql/unreviewed-claim-migration.sql');
    const extended = inventoryPhaseWriters([...sources, adjacent]);
    const unexplained = extended.sites.filter(site => site.path === adjacent.path);
    expect(unexplained).toHaveLength(1);
    const extendedReport = reconcilePhaseWriterCensus(extended, reviewed.reviews);
    expect(extendedReport.ready).toBe(false);
    expect(extendedReport.problems).toContainEqual({ id: unexplained[0]!.id, reasons: ['unclassified-writer'] });
    expect(extendedReport.coverage.residue).toContain(unexplained[0]!.id);
  });

  it('binds pure claim helper reviews to their exact source without exempting same named writers', () => {
    const root = new URL('../../../../', import.meta.url);
    const reviewed = JSON.parse(readFileSync(new URL(
      'docs/evidence/phase-admission-claim-source-reviews-20261117.json', root), 'utf8')) as {
        reviewedSourcePaths: string[]; reviews: PhaseWriterReview[];
      };
    const sources = reviewed.reviewedSourcePaths.map(path => ({
      path, content: readFileSync(new URL(path, root), 'utf8'),
    }));
    const claims = 'packages/operator-core/lib/plan-items/claims.ts';
    const inventory = inventoryPhaseWriters(sources);
    const helpers = inventory.sites.filter(site => site.path === claims && site.kind === 'helper-edge'
      && ['clampTtl', 'claimFromDb', 'synthMissing'].includes(site.callees[0] ?? ''));
    expect(helpers.length).toBeGreaterThan(0);
    const byId = new Map(reviewed.reviews.map(row => [row.siteId, row]));
    for (const helper of helpers) {
      expect(byId.get(helper.id)).toMatchObject({ disposition: 'metadata-only',
        sourceProofs: [{ path: claims, sha256: helper.sourceSha256 }] });
    }

    // Changing a helper body leaves its callers' statement identities intact.
    // The required full-file source pin must still invalidate every call review.
    const changed = inventoryPhaseWriters(sources.map(source => source.path === claims
      ? { ...source, content: source.content.replace('function clampTtl(n: number): number {',
        'function clampTtl(n: number): number { acquireClaimLocal({} as AcquireOpts);') }
      : source));
    const stale = reconcilePhaseWriterCensus(changed, reviewed.reviews);
    for (const helper of helpers) {
      expect(changed.sites.some(site => site.id === helper.id)).toBe(true);
      expect(stale.coverage.checked).not.toContain(helper.id);
      expect(stale.problems.find(row => row.id === helper.id)?.reasons)
        .toContain(`stale-source-proof:${claims}`);
    }

    // A same-spelled helper in another module cannot inherit the exemption.
    const shadow = source('async function clampTtl(sql) { await sql`UPDATE harness_shared.plan_item_claims SET owner=\'changed\'`; }\n'
      + 'async function caller(sql) { await clampTtl(sql); }', 'packages/unreviewed-claim-helper.ts');
    const added = inventoryPhaseWriters([...sources, shadow]);
    const report = reconcilePhaseWriterCensus(added, reviewed.reviews);
    const candidates = added.sites.filter(site => site.path === shadow.path);
    expect(candidates.some(site => site.kind === 'sql')).toBe(true);
    expect(candidates.some(site => site.kind === 'helper-edge' && site.operation === 'caller')).toBe(true);
    for (const candidate of candidates) {
      expect(report.coverage.notChecked).toContain(candidate.id);
      expect(report.coverage.residue).toContain(candidate.id);
    }
  });
  it('pins read only claim accessors without accepting their following authority routes', () => {
    const root = new URL('../../../../', import.meta.url);
    const reviewed = JSON.parse(readFileSync(new URL(
      'docs/evidence/phase-admission-claim-source-reviews-20261117.json', root), 'utf8')) as {
        reviewedSourcePaths: string[]; reviews: PhaseWriterReview[];
      };
    const sources = reviewed.reviewedSourcePaths.map(path => ({
      path, content: readFileSync(new URL(path, root), 'utf8'),
    }));
    const claims = 'packages/operator-core/lib/plan-items/claims.ts';
    const inventory = inventoryPhaseWriters(sources);
    const accessors = inventory.sites.filter(site => site.path === claims && site.kind === 'helper-edge'
      && ['getClaimAuthority', 'planItemRef'].includes(site.callees[0] ?? ''));
    expect(accessors.length).toBeGreaterThan(0);
    const byId = new Map(reviewed.reviews.map(row => [row.siteId, row]));
    for (const site of accessors) {
      expect(byId.get(site.id)).toMatchObject({ disposition: 'metadata-only' });
      expect(byId.get(site.id)?.sourceProofs).toContainEqual({
        path: site.helperTarget!.path, sha256: site.helperTarget!.sha256,
      });
    }
    const report = reconcilePhaseWriterCensus(inventory, reviewed.reviews);
    const routes = inventory.sites.filter(site => site.path === claims && site.kind === 'unresolved'
      && site.dynamicEdges.includes('getClaimAuthority().route'));
    expect(routes.length).toBeGreaterThan(0);
    for (const site of routes) {
      expect(byId.has(site.id)).toBe(false);
      expect(report.coverage.notChecked).toContain(site.id);
      expect(report.coverage.residue).toContain(site.id);
    }
    for (const target of new Set(accessors.map(site => site.helperTarget!.path))) {
      const changed = inventoryPhaseWriters(sources.map(source => source.path === target
        ? { ...source, content: source.content + '\nexport const changedAccessorSource = true;\n' } : source));
      const stale = reconcilePhaseWriterCensus(changed, reviewed.reviews);
      for (const site of accessors.filter(site => site.helperTarget!.path === target)) {
        expect(changed.sites.some(current => current.id === site.id)).toBe(true);
        expect(stale.coverage.notChecked).toContain(site.id);
        expect(stale.problems.find(row => row.id === site.id)?.reasons)
          .toContain(`stale-source-proof:${target}`);
      }
    }
  });

  it('keeps receiving payload validation separate from coordinator execution', () => {
    const root = new URL('../../../../', import.meta.url);
    const reviewed = JSON.parse(readFileSync(new URL(
      'docs/evidence/phase-admission-claim-source-reviews-20261117.json', root), 'utf8')) as {
        reviewedSourcePaths: string[]; reviews: PhaseWriterReview[];
      };
    const sources = reviewed.reviewedSourcePaths.map(path => ({
      path, content: readFileSync(new URL(path, root), 'utf8'),
    }));
    const receiver = 'packages/operator-core/lib/plan-items/plan-item-claim-authority-ops.ts';
    const inventory = inventoryPhaseWriters(sources);
    const validators = inventory.sites.filter(site => site.path === receiver && site.kind === 'helper-edge'
      && ['asAcquireOpts', 'asHeartbeatParams', 'asReleaseParams', 'asForceReleaseParams',
        'asForceTakeoverParams'].includes(site.callees[0] ?? ''));
    expect(validators.length).toBeGreaterThan(0);
    const byId = new Map(reviewed.reviews.map(row => [row.siteId, row]));
    for (const site of validators) {
      expect(byId.get(site.id)).toMatchObject({ disposition: 'metadata-only',
        sourceProofs: [{ path: receiver, sha256: site.sourceSha256 }] });
    }
    const report = reconcilePhaseWriterCensus(inventory, reviewed.reviews);
    const coordinators = inventory.sites.filter(site => site.path === receiver && site.kind === 'unresolved'
      && site.dynamicEdges.some(edge => edge.startsWith('coordinator.')));
    expect(coordinators.map(site => site.dynamicEdges[0]).sort())
      .toEqual(['coordinator.acquire', 'coordinator.heartbeat', 'coordinator.release']);
    for (const site of coordinators) {
      expect(byId.has(site.id)).toBe(false);
      expect(report.coverage.notChecked).toContain(site.id);
      expect(report.coverage.residue).toContain(site.id);
    }
    const changed = inventoryPhaseWriters(sources.map(source => source.path === receiver
      ? { ...source, content: source.content.replace('function asAcquireOpts(payload: unknown): AcquireOpts {',
        'function asAcquireOpts(payload: unknown): AcquireOpts { acquireClaimLocal({} as AcquireOpts);') }
      : source));
    const stale = reconcilePhaseWriterCensus(changed, reviewed.reviews);
    for (const site of validators) {
      expect(changed.sites.some(current => current.id === site.id)).toBe(true);
      expect(stale.coverage.notChecked).toContain(site.id);
      expect(stale.problems.find(row => row.id === site.id)?.reasons)
        .toContain(`stale-source-proof:${receiver}`);
    }
  });

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

  it('distinguishes SELECT row locks from UPDATE statements without dropping either source identity', () => {
    const statements = [
      'SELECT item_id FROM harness_shared.plan_item_claims FOR UPDATE',
      'UPDATE harness_shared.plan_item_claims SET owner = \'current\' RETURNING item_id',
      'WITH changed AS (UPDATE harness_shared.plan_item_claims SET owner = \'current\' RETURNING item_id) SELECT item_id FROM changed FOR UPDATE',
    ];
    const inventory = inventoryPhaseWriters(statements.map((sql, i) =>
      source(`export const result = sql\`${sql}\`;`, `packages/lock-${i}.ts`)));
    expect(inventory.gaps).toEqual([]);
    expect(inventory.sites).toHaveLength(3);
    for (const site of inventory.sites) expect(site.unresolved).not.toContain('mutation-relation-unresolved');
    const lock = inventory.sites.find(site => site.path === 'packages/lock-0.ts')!;
    expect(lock.statement).toBe(`sql\`${statements[0]}\``);
    expect(lock.relations).toEqual([]);
    expect(lock.columns).toEqual([]);
    for (const path of ['packages/lock-1.ts', 'packages/lock-2.ts']) {
      const mutation = inventory.sites.find(site => site.path === path)!;
      expect(mutation.relations).toEqual(['harness_shared.plan_item_claims']);
      expect(mutation.columns).toEqual(['owner']);
    }
    expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
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

  it('invalidates an unchanged writer exemption when its reviewed authority dependency changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-writer-proof-source-'));
    try {
      mkdirSync(join(root, 'packages'));
      const writerPath = 'packages/writer.ts', policyPath = 'packages/authority.ts';
      writeFileSync(join(root, writerPath), write);
      writeFileSync(join(root, policyPath), 'export const mayDispatch = false;');
      const before = inventoryPhaseWriterTree(root), site = before.sites[0]!;
      const inspected = { ...review(site, 'metadata-only'), sourceProofs: before.sources,
        reason: 'The independently registered authority policy prevents this audit writer from granting execution.',
        evidenceRefs: [`source:${writerPath}`, `source:${policyPath}`] };
      expect(assertPhaseWriterTreeCensus(root, [inspected]).ready).toBe(true);

      // The writer bytes, its statement and all discovered call frontiers stay
      // unchanged. Only the source used to justify its exemption has changed.
      writeFileSync(join(root, policyPath), 'export const mayDispatch = true;');
      const after = inventoryPhaseWriterTree(root);
      expect(after.sites).toEqual(before.sites);
      expect(verifyPhaseWriterTreeSnapshot(after).ready).toBe(true);
      const report = reconcilePhaseWriterCensus(after, [inspected]);
      expect(report.ready).toBe(false);
      expect(report.problems).toEqual([{ id: site.id, reasons: [`stale-source-proof:${policyPath}`] }]);
      expect(report.coverage.notChecked).toEqual([site.id]);
      expect(report.coverage.residue).toEqual([site.id]);
      expect(() => assertPhaseWriterTreeCensus(root, [inspected])).toThrow('stale-source-proof');
      // Updating hashes is an explicit new source review, never an automatic
      // consequence of rebuilding a fresh inventory.
      const revised = { ...inspected, disposition: 'advancing' as const,
        sourceProofs: after.sources, reason: 'Re-reviewed the changed execution policy; admission is required.' };
      expect(assertPhaseWriterTreeCensus(root, [revised]).ready).toBe(true);
      rmSync(join(root, policyPath));
      expect(reconcilePhaseWriterCensus(inventoryPhaseWriterTree(root), [revised]).problems)
        .toEqual([{ id: site.id, reasons: [`missing-source-proof:${policyPath}`] }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires complete valid source proofs and preserves a changed dependency after the boundary and recovery', async () => {
    for (const size of [63, 64, 65]) {
      const sources = [source(write), ...Array.from({ length: size }, (_, i) =>
        source(`export const policy = ${i};`, `packages/policy-${i}.ts`))];
      const inventory = inventoryPhaseWriters(sources), site = inventory.sites[0]!;
      const inspected = { ...review(site, 'historical/unreachable'), sourceProofs: inventory.sources };
      const rows: string[] = [];
      await writePhaseWriterCensus(inventory, [inspected], line => { rows.push(line); });
      let recovered: PhaseWriterReview | undefined;
      await readPhaseWriterCensus(rows, row => {
        if (row.kind === 'review') recovered = row.value as PhaseWriterReview;
      });
      expect(recovered).toEqual(inspected);
      const decisive = `packages/policy-${size - 1}.ts`;
      const changed = inventoryPhaseWriters(sources.map(s => s.path === decisive
        ? { ...s, content: 'export const policy = "new authority";' } : s).reverse());
      for (const sourceProofs of [recovered!.sourceProofs, [...recovered!.sourceProofs].reverse()]) {
        const report = reconcilePhaseWriterCensus(changed, [{ ...recovered!, sourceProofs }]);
        expect(report.problems).toEqual([{ id: site.id, reasons: [`stale-source-proof:${decisive}`] }]);
        expect(report.coverage).toEqual({ population: [site.id], checked: [], notChecked: [site.id],
          notApplicable: [], residue: [site.id] });
      }
      expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected, sourceProofs: [] }]))
        .toThrow('review-source-proofs-missing');
      const legacy = { ...inspected };
      Reflect.deleteProperty(legacy, 'sourceProofs');
      expect(() => assertPhaseWriterCensus(inventory, [legacy])).toThrow('review-source-proofs-missing');
      const own = inspected.sourceProofs.find(proof => proof.path === site.path)!;
      expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected, sourceProofs: [own, own] }]))
        .toThrow('duplicate-source-proof');
      expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected,
        sourceProofs: inspected.sourceProofs.filter(proof => proof.path !== site.path) }]))
        .toThrow('writer-source-proof-missing');
      expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected,
        sourceProofs: [{ path: '../outside.ts', sha256: own.sha256 }] }]))
        .toThrow('invalid-source-proof');
      expect(() => assertPhaseWriterCensus(inventory, [{ ...inspected,
        sourceProofs: [{ ...own, sha256: 'incomplete-digest' }] }]))
        .toThrow('invalid-source-proof');
    }
  });

  it('retains ORM and SQL builder mutations without relying on another writer name', () => {
    const statements = [
      'db.insert(table).values(values).returning()',
      'db.update(table).set({ owner, status }).where(predicate)',
      'db.delete(table).where(predicate)',
      'db.insertInto(table).values(values).onConflict(conflict)',
      'db.updateTable(table).set(values).execute()',
      'db.deleteFrom(table).where(predicate).execute()',
      'db.mergeInto(table).using(source).whenMatchedThenUpdate(values)',
      'db.upsert(table, values)',
      'db["insert"](table).values(values)',
    ];
    for (const statement of statements) {
      const inventory = inventoryPhaseWriters([source(`async function freshOrmWriter(db, table, values) { await ${statement}; }`)]);
      const mutations = inventory.sites.filter(site => site.unresolved.includes('mutation-builder-target-requires-review'));
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.statement).toBe(statement);
      expect(mutations[0]!.dynamicEdges).toContain('table');
      expect(reconcilePhaseWriterCensus(inventory, []).coverage.residue).toContain(mutations[0]!.id);
      expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
    }
  });

  it('preserves complete builder columns and opaque targets instead of inferring a safe relation', () => {
    const statement = 'db.update(resolveTable(subject)).set({ owner, [column]: value, ...rest }).where(predicate)';
    const inventory = inventoryPhaseWriters([source(`async function freshOrmWriter() { await ${statement}; }`)]);
    const mutation = inventory.sites.find(site => site.unresolved.includes('mutation-builder-target-requires-review'))!;
    expect(mutation.statement).toBe(statement);
    expect(mutation.dynamicEdges).toContain('resolveTable(subject)');
    expect(mutation.columns).toEqual(['owner']);
    expect(mutation.unresolved).toContain('mutation-builder-columns-require-review');
    expect(mutation.relations).toEqual([]);
    const inspected = inventory.sites.map(site => review(site));
    const missingTarget = inspected.map(row => row.siteId === mutation.id ? { ...row,
      resolvedEdges: row.resolvedEdges.filter(edge => edge.edge !== 'resolveTable(subject)') } : row);
    expect(reconcilePhaseWriterCensus(inventory, missingTarget).problems.find(row => row.id === mutation.id)!.reasons)
      .toContain('unresolved-edge:resolveTable(subject)');
  });

  it('classifies every source writer and rejects unexplained advancing mutations', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-writer-native-guard-'));
    try {
      mkdirSync(join(root, 'packages'));
      const path = 'packages/writer.ts';
      writeFileSync(join(root, path), write);
      const original = inventoryPhaseWriterTree(root);
      // This control comes from the known fixture, independently of the
      // collector output used to construct the review population below.
      expect(original.sites).toEqual([expect.objectContaining({ path, operation: 'exampleWrite', kind: 'sql',
        statement: 'tx`UPDATE harness_shared.work_items SET status=${status} WHERE feature_id=${id}`',
        relations: ['harness_shared.work_items'], columns: ['status'] })]);
      const reviews = original.sites.map(site => review(site));
      const current = assertPhaseWriterTreeCensus(root, reviews);
      expect(current.ready).toBe(true);
      expect(current.inventory.scope).toEqual({ kind: 'repository', root });
      expect(current.inventory.sources).toEqual(original.sources);
      expect(current.census.coverage.checked).toEqual(original.sites.map(site => site.id));
      expect(current.census.coverage.residue).toEqual([]);
      expect(current.freshness.coverage.residue).toEqual([]);
      expect(Number.isNaN(Date.parse(current.observedAt))).toBe(false);

      // Mutate the actual tree after its complete, reviewed snapshot. An old
      // artifact stays internally valid but cannot be used as current truth.
      const latePath = 'packages/new-writer.sql';
      writeFileSync(join(root, latePath), "INSERT INTO harness_shared.plan_item_claims(item_id, owner) VALUES ('P-002', 'late')");
      expect(assertPhaseWriterCensus(original, reviews).ready).toBe(true);
      let refused: ReturnType<typeof assertPhaseWriterTreeCensus> | undefined;
      try { assertPhaseWriterTreeCensus(root, reviews); }
      catch (error) { refused = (error as Error & { report: typeof current }).report; }
      expect(refused?.ready).toBe(false);
      const late = refused!.inventory.sites.find(site => site.path === latePath)!;
      expect(late.statement).toContain("('P-002', 'late')");
      expect(refused!.census.problems.find(problem => problem.id === late.id)!.reasons).toEqual(['unclassified-writer']);
      expect(refused!.census.coverage.residue).toContain(late.id);
      expect([...refused!.census.coverage.checked, ...refused!.census.coverage.notChecked,
        ...refused!.census.coverage.notApplicable].sort()).toEqual([...refused!.census.coverage.population].sort());
      rmSync(join(root, latePath));
      expect(assertPhaseWriterTreeCensus(root, reviews).ready).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses stale exemptions dynamic frontiers and parse gaps through the actual tree guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-writer-native-refusal-'));
    try {
      mkdirSync(join(root, 'packages'));
      const path = 'packages/writer.ts';
      writeFileSync(join(root, path), write);
      const reviews = inventoryPhaseWriterTree(root).sites.map(site => review(site, 'isolated-fixture'));
      expect(assertPhaseWriterTreeCensus(root, reviews).ready).toBe(true);
      writeFileSync(join(root, path), write + '\nconst changed = true;');
      expect(() => assertPhaseWriterTreeCensus(root, reviews)).toThrow('stale-review');
      writeFileSync(join(root, path), write);
      const dynamicPath = 'packages/dynamic.ts';
      writeFileSync(join(root, dynamicPath), 'async function freshDynamic(db, statement) { await db.unsafe(statement); }');
      const dynamic = inventoryPhaseWriterTree(root);
      const unproved = dynamic.sites.map(site => site.path === dynamicPath
        ? { ...review(site), resolvedEdges: [] } : reviews.find(row => row.siteId === site.id)!);
      let dynamicReport: ReturnType<typeof assertPhaseWriterTreeCensus> | undefined;
      try { assertPhaseWriterTreeCensus(root, unproved); }
      catch (error) { dynamicReport = (error as Error & { report: NonNullable<typeof dynamicReport> }).report; }
      expect(dynamicReport?.ready).toBe(false);
      expect(dynamicReport?.census.problems.some(problem => problem.reasons.includes('unresolved-edge:statement'))).toBe(true);
      rmSync(join(root, dynamicPath));
      writeFileSync(join(root, 'packages/broken.ts'), 'export function broken( {');
      let report: ReturnType<typeof assertPhaseWriterTreeCensus> | undefined;
      try { assertPhaseWriterTreeCensus(root, reviews); }
      catch (error) { report = (error as Error & { report: NonNullable<typeof report> }).report; }
      expect(report?.census.coverage.residue).toContain('gap:source:packages/broken.ts');
      expect(report?.freshness.coverage.residue).toContain('gap:source:packages/broken.ts');
      expect(report?.ready).toBe(false);
      rmSync(join(root, 'packages/broken.ts'));
      expect(assertPhaseWriterTreeCensus(root, reviews).ready).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  it('retains aliased callbacks computed dispatch and returned helpers as unresolved candidates', () => {
    const inventory = inventoryPhaseWriters([
      source(write),
      source("import { exampleWrite as imported } from './example'; const first = imported; let second; second = first; async function outer(tx) { await second(tx); await invoke(second); }", 'packages/aliases.ts'),
      source('async function dispatch(db, method, statement, callback) { await db[method](statement); await getWriter()(statement); await callback(statement); }', 'packages/computed.ts'),
    ]);
    const aliases = inventory.sites.filter(site => site.path === 'packages/aliases.ts' && site.kind === 'helper-edge');
    expect(aliases.map(site => site.statement)).toEqual(['second(tx)', 'invoke(second)']);
    const indirect = inventory.sites.filter(site => site.path === 'packages/computed.ts'
      && site.unresolved.includes('indirect-call-target-requires-review'));
    expect(indirect.map(site => site.statement).sort()).toEqual(['callback(statement)', 'db[method](statement)', 'getWriter()(statement)']);
    const report = reconcilePhaseWriterCensus(inventory, []);
    expect(report.ready).toBe(false);
    expect(report.coverage.notChecked).toEqual(report.coverage.population);
  });

  it('reuses source bound default namespace and barrel targets without granting an exemption', () => {
    const inventory = inventoryPhaseWriters([
      source('export default async function mutate(tx) { await tx`UPDATE harness_shared.work_items SET status=\'open\'`; }', 'packages/writer.ts'),
      source('export { default as advance } from "./writer";', 'packages/barrel.ts'),
      source('import invoke from "./writer"; export async function entry(tx) { await invoke(tx); }', 'packages/default.ts'),
      source('import * as api from "./barrel"; export async function start(tx) { await api.advance(tx); }', 'packages/namespace.ts'),
    ]);
    for (const path of ['packages/default.ts', 'packages/namespace.ts']) {
      const helper = inventory.sites.find(site => site.path === path && site.kind === 'helper-edge')!;
      expect(helper.helperTarget).toEqual({ path: 'packages/writer.ts',
        sha256: inventory.sources.find(source => source.path === 'packages/writer.ts')!.sha256,
        basis: 'syntax-bound-module-target-not-runtime-closure' });
      expect(helper.dynamicEdges).toContain(`source:packages/writer.ts#${helper.helperTarget!.sha256}`);
      expect(reconcilePhaseWriterCensus(inventory, []).coverage.residue).toContain(helper.id);
    }
  });

  it('retains wrapped and destructured callback parameter invocations as unresolved frontiers', () => {
    const variants = [
      { parameters: 'callback, statement', call: '(callback)(statement)' },
      { parameters: 'callback, statement', call: '(callback as Function)(statement)' },
      { parameters: 'callback, statement', call: 'callback!(statement)' },
      { parameters: 'callback, statement', call: '(callback satisfies Function)(statement)' },
      { parameters: 'callbacks, statement', call: 'callbacks.advance(statement)' },
      { parameters: 'callbacks, statement', call: '(callbacks).advance?.(statement)', target: '(callbacks).advance' },
      { parameters: 'callbacks, statement', call: 'callbacks.nested.advance(statement)' },
      { parameters: '{ advance: callback }, statement', call: 'callback(statement)' },
      { parameters: '{ nested: { advance: callback } }, statement', call: '(callback)(statement)' },
      { parameters: '[callback], statement', call: 'callback(statement)' },
      { parameters: '...callbacks', call: 'callbacks[0](statement)' },
      { parameters: 'callback, statement', call: '(0, callback)(statement)' },
      { parameters: 'statement', call: 'getCallbacks().advance(statement)' },
    ];
    for (const { parameters, call, target } of variants) {
      const inventory = inventoryPhaseWriters([source(`async function dispatch(${parameters}) { await ${call}; }`)]);
      const indirect = inventory.sites.filter(site => site.unresolved.includes('indirect-call-target-requires-review'));
      expect(indirect.map(site => site.statement), call).toEqual([call]);
      expect(indirect[0]!.dynamicEdges).toEqual([target ?? call.slice(0, call.lastIndexOf('('))]);
      expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
      const inspected = inventory.sites.map(site => review(site));
      expect(assertPhaseWriterCensus(inventory, inspected).ready).toBe(true);
      expect(() => assertPhaseWriterCensus(inventory, inspected.map(row => ({ ...row, resolvedEdges: [] }))))
        .toThrow('unresolved-edge');
    }
  });

  it('invalidates an unchanged helper review when its resolved target changes', () => {
    const sources = [
      source('export async function exampleWrite(tx) { await tx`UPDATE work_items SET status=\'open\'`; }', 'packages/writer.ts'),
      source('import { exampleWrite } from "./writer"; export function entry(tx) { return exampleWrite(tx); }', 'packages/entry.ts'),
    ];
    const before = inventoryPhaseWriters(sources), reviews = before.sites.map(site => review(site));
    expect(assertPhaseWriterCensus(before, reviews).ready).toBe(true);
    const after = inventoryPhaseWriters([{ ...sources[0]!, content: sources[0]!.content + '\nconst changed = true;' }, sources[1]!]);
    const helper = before.sites.find(site => site.path === 'packages/entry.ts')!;
    expect(after.sites.find(site => site.id === helper.id)!.sourceSha256).toBe(helper.sourceSha256);
    expect(reconcilePhaseWriterCensus(after, reviews).problems.find(row => row.id === helper.id)!.reasons)
      .toContain(`stale-edge-review:source:packages/writer.ts#${helper.helperTarget!.sha256}`);
  });

  it('retains missing shadowed and ambiguous import frontiers with no invented target', () => {
    const inventory = inventoryPhaseWriters([
      source('export async function work(tx) { await tx`UPDATE work_items SET status=\'open\'`; }', 'packages/writer.ts'),
      source('import missing from "./absent"; export function entry(tx) { return missing(tx); }', 'packages/missing.ts'),
      source('import { work as target } from "./writer"; export function entry(target, tx) { return target(tx); }', 'packages/shadow.ts'),
      source('export function work() {}', 'packages/other.ts'),
      source('export * from "./writer"; export * from "./other";', 'packages/barrel.ts'),
      source('import { work as ambiguous } from "./barrel"; export function entry(tx) { return ambiguous(tx); }', 'packages/ambiguous.ts'),
    ]);
    for (const path of ['packages/missing.ts', 'packages/shadow.ts', 'packages/ambiguous.ts']) {
      const helper = inventory.sites.find(site => site.path === path && site.kind === 'helper-edge')!;
      expect(helper).toBeDefined();
      expect(helper.helperTarget).toBeUndefined();
      expect(helper.unresolved).toContain('imported-call-target-requires-review');
      expect(reconcilePhaseWriterCensus(inventory, []).coverage.residue).toContain(helper.id);
    }
  });

  it('retains the import frontier when the maintained export resolver cannot finish within its bound', () => {
    for (const depth of [31, 32, 33]) {
      const name = (i: number) => `chain-${String(i).padStart(3, '0')}`;
      const sources = Array.from({ length: depth + 1 }, (_, i) => source(i === depth
        ? 'export async function work(tx) { await tx`UPDATE work_items SET status=\'open\'`; }'
        : `export * from "./${name(i + 1)}";`, `packages/${name(i)}.ts`));
      sources.push(source(`import { work } from "./${name(0)}"; export function entry(tx) { return work(tx); }`, 'packages/use.ts'));
      const inventory = inventoryPhaseWriters(sources);
      const helper = inventory.sites.find(site => site.path === 'packages/use.ts')!;
      expect(helper).toBeDefined();
      if (depth === 31) expect(helper.helperTarget?.path).toBe(`packages/${name(depth)}.ts`);
      else {
        expect(helper.helperTarget).toBeUndefined();
        expect(helper.unresolved).toContain('helper-symbol-export-resolution-incomplete');
      }
      expect(reconcilePhaseWriterCensus(inventory, []).coverage.residue).toContain(helper.id);
    }
  });

  it('retains the serialized append and its batch authority as separate source identities', () => {
    const inventory = inventoryPhaseWriters([source('async function claim(log, ops) { await log.withAppendsHeld(async held => { await held.appendBatch(ops); }); }', 'libs/claims.ts')]);
    const appends = inventory.sites.filter(site => site.kind === 'authority-append');
    expect(appends).toHaveLength(2);
    expect(appends.some(site => site.statement === 'held.appendBatch(ops)')).toBe(true);
    expect(new Set(appends.map(site => site.id)).size).toBe(2);
    expect(() => assertPhaseWriterCensus(inventory, [])).toThrow('unclassified-writer');
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

  it('revalidates the entire exported source and enumeration snapshot after consumer recovery', async () => {
    for (const size of [3, 4, 5, 81]) {
      const root = mkdtempSync(join(tmpdir(), 'phase-writer-snapshot-'));
      try {
        mkdirSync(join(root, 'packages'));
        mkdirSync(join(root, 'docs'));
        for (let i = 0; i < size; i++) writeFileSync(join(root, `packages/${i}.ts`), write);
        writeFileSync(join(root, 'docs/excluded.md'), 'Explicitly outside the runtime roots.');
        const inventory = inventoryPhaseWriterTree(root), lines: string[] = [];
        await writePhaseWriterCensus(inventory, [], line => { lines.push(line); });
        const restored: PhaseWriterTreeManifest = { scope: inventory.scope,
          sources: [], gaps: [], excluded: [], enumeration: { scanned: [], unscanned: [] } };
        async function* resumedBatches() {
          // A consumer resumes at a record cursor; it still verifies the whole
          // stream, including the final source and completion footer.
          for (let cursor = 0; cursor < lines.length; cursor += 4) {
            yield* lines.slice(cursor, cursor + 4);
            await Promise.resolve();
          }
        }
        await readPhaseWriterCensus(resumedBatches(), row => {
          if (row.kind === 'source') restored.sources.push(row.value as PhaseWriterTreeManifest['sources'][number]);
          if (row.kind === 'gap') restored.gaps.push(row.value as PhaseWriterTreeManifest['gaps'][number]);
          if (row.kind === 'excluded') restored.excluded.push(row.value as PhaseWriterTreeManifest['excluded'][number]);
          if (row.kind === 'scanned' || row.kind === 'unscanned') restored.enumeration[row.kind].push(row.value as string);
        });
        const current = verifyPhaseWriterTreeSnapshot(restored);
        expect(current.ready).toBe(true);
        expect(current.coverage.residue).toEqual([]);
        const path = `packages/${size - 1}.ts`;
        writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8') + '\nconst changed = true;');
        const stale = verifyPhaseWriterTreeSnapshot(restored);
        expect(stale.ready).toBe(false);
        expect(stale.differences).toEqual([expect.objectContaining({ id: `source:${path}`, reason: 'changed' })]);
        expect(stale.coverage.notChecked).toEqual([`source:${path}`]);
        expect(stale.coverage.residue).toEqual([`source:${path}`]);
        expect(verifyPhaseWriterTreeSnapshot({ ...restored, sources: [...restored.sources].reverse(),
          excluded: [...restored.excluded].reverse() }).differences).toEqual(stale.differences);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('keeps unchanged parser gaps out of the resolved freshness differences', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-writer-parser-freshness-'));
    try {
      mkdirSync(join(root, 'packages'));
      const path = 'packages/broken.ts';
      writeFileSync(join(root, path), 'export function broken( {');
      const snapshot = inventoryPhaseWriterTree(root);
      expect(snapshot.gaps).toEqual([{ id: `source:${path}`, reason: 'typescript-parse-unresolved' }]);
      const current = verifyPhaseWriterTreeSnapshot(snapshot);
      expect(current.ready).toBe(false);
      expect(current.differences).toEqual([]);
      expect(current.coverage.notChecked).toEqual([`gap:source:${path}`]);
      expect(current.coverage.residue).toEqual([`gap:source:${path}`]);

      // A changed file may still fail parsing. A different byte hash alone
      // cannot establish that the previous gap has been resolved.
      writeFileSync(join(root, path), 'export function stillBroken( {');
      const changed = verifyPhaseWriterTreeSnapshot(snapshot);
      expect(changed.differences).toEqual([expect.objectContaining({ id: `source:${path}`, reason: 'changed' })]);
      expect(changed.coverage.residue).toEqual([`gap:source:${path}`, `source:${path}`]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports parser gap removal only after parsing repaired source or observing deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-writer-parser-repair-'));
    try {
      mkdirSync(join(root, 'packages'));
      const path = 'packages/broken.ts';
      writeFileSync(join(root, path), 'export function broken( {');
      const snapshot = inventoryPhaseWriterTree(root);
      writeFileSync(join(root, path), 'export const repaired = true;');
      const repaired = verifyPhaseWriterTreeSnapshot(snapshot);
      expect(repaired.ready).toBe(false);
      expect(repaired.differences).toEqual([
        { id: `gap:source:${path}`, reason: 'removed', expected: 'typescript-parse-unresolved', actual: null },
        expect.objectContaining({ id: `source:${path}`, reason: 'changed' }),
      ]);
      // Recovery requires a fresh analysis snapshot; the old source hash
      // remains stale even though its parse failure is now resolved.
      expect(verifyPhaseWriterTreeSnapshot(inventoryPhaseWriterTree(root)).ready).toBe(true);
      rmSync(join(root, path));
      const removed = verifyPhaseWriterTreeSnapshot(snapshot);
      expect(removed.differences).toEqual([
        { id: `gap:source:${path}`, reason: 'removed', expected: 'typescript-parse-unresolved', actual: null },
        expect.objectContaining({ id: `source:${path}`, reason: 'removed' }),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses added removed excluded and unreadable sources without dropping their identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-writer-enumeration-'));
    try {
      mkdirSync(join(root, 'packages'));
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'packages/old.ts'), write);
      writeFileSync(join(root, 'packages/invalid.ts'), Buffer.from([0xff]));
      writeFileSync(join(root, 'docs/old.md'), 'Named exclusion.');
      const snapshot = inventoryPhaseWriterTree(root);
      expect(verifyPhaseWriterTreeSnapshot(snapshot).coverage.residue).toEqual(['gap:source:packages/invalid.ts']);
      rmSync(join(root, 'packages/old.ts'));
      rmSync(join(root, 'docs/old.md'));
      writeFileSync(join(root, 'packages/new.ts'), write);
      writeFileSync(join(root, 'docs/new.md'), 'New exclusion.');
      const stale = verifyPhaseWriterTreeSnapshot(snapshot);
      expect(stale.ready).toBe(false);
      expect(stale.differences.map(row => [row.id, row.reason])).toEqual([
        ['excluded:docs/new.md', 'added'], ['excluded:docs/old.md', 'removed'],
        ['source:packages/new.ts', 'added'], ['source:packages/old.ts', 'removed'],
      ]);
      expect([...stale.coverage.checked, ...stale.coverage.notChecked, ...stale.coverage.notApplicable].sort())
        .toEqual(stale.coverage.population);
      expect(new Set(stale.coverage.population).size).toBe(stale.coverage.population.length);
      expect(stale.coverage.residue).toContain('gap:source:packages/invalid.ts');
      expect(() => verifyPhaseWriterTreeSnapshot({ ...snapshot, scope: { kind: 'supplied-sources' } }))
        .toThrow('repository-snapshot-required');
      expect(() => verifyPhaseWriterTreeSnapshot({ ...snapshot, sources: [...snapshot.sources, snapshot.sources[0]!] }))
        .toThrow('duplicate-snapshot-identity');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
