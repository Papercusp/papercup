import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from '../agent-tools/plans/source';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';
import { setSpecClause, listSpecClauses } from '../agent-tools/plans/spec-clauses-store';
import { writePlanItemAnchors } from '../plan-items/anchor-store';
import { readEngineeringEvidence, type EngineeringScope } from './engineering-evidence';
import { engineeringEvidenceStore } from './engineering-evidence-store';

describe('native engineering evidence canonical PG adapters', () => {
  let fixture: PlanPgFixture;
  let db: Sql;
  let scope: EngineeringScope;
  let root: string;
  let runId: number;
  let bindingId: number;
  const plan = 'ee-feature';
  const harness = `ee-reader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const path = 'src/evidence-feature.ts';
  const source = 'export function evidenceFeature() { return 1; }\n';
  const digest = createHash('sha256').update(source).digest('hex');
  const body = `---\ntitle: Evidence fixture\nslug: ${plan}\nstatus: active\n---\n# Evidence fixture\n\n## Work\n\n- **P-001** \`todo\` Inspect exact engineering evidence\n\n## Decisions\n\n### D-001 — Explicit rationale\nRelated: P-001\n\nThis item has an explicit governing rule.\n\n### D-002 — Unscoped context\n\nThis note declares no item relationship.\n\n### D-003 — Administrative amendment\n\nAmendment-Id: fixture-only\n`;
  const store = () => engineeringEvidenceStore({ sql: async () => db,
    root: async s => s.workspaceId === scope.workspaceId && s.harness === harness ? root : null });
  const query = { symbol: { path, name: 'evidenceFeature' } };

  beforeAll(async () => {
    fixture = await setupPlanPgFixture({ isolated: true });
    db = fixture.admin;
    root = await mkdtemp(join(tmpdir(), 'ee-reader-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, path), source);
    scope = { workspaceId: fixture.workspaceId, harness, root };
    await seedPlan(db, scope.workspaceId, harness, plan, body);
    await db.begin(async tx => {
      await writePlanIndexRows(tx as never, { workspaceId: scope.workspaceId, harnessSlug: harness, planSlug: plan }, deriveIndexFromContent(body));
      await writePlanItemAnchors(tx, { workspaceId: scope.workspaceId, harnessSlug: harness, planSlug: plan }, {
        itemId: 'P-001', anchors: [{ id: undefined, anchorKind: 'path', requested: path, symbolId: null,
          symbolName: null, path, line: null, signature: null, contentHash: digest, consumers: [], consumersTotal: 0,
          tests: [], resolution: 'resolved', unknownReason: null, freshness: 'fresh', resolvedCommit: null }],
      }, 'su-ee-author');
      expect(await setSpecClause({ planSlug: plan, specId: 'EE-1', expectedRevision: 0, planItemId: 'P-001',
        behavior: 'The scoped request returns exact declared engineering records.', behaviorClass: 'happy-path',
        requiredEvidence: ['tree'], requiredTestLayers: ['integration'], mutationRequired: false,
        lifecycleStatus: 'active', actorId: 'su-ee-author',
        falsifier: { observation: 'An unrelated record becomes support.', probeMethod: 'Query the scoped fixture and its foreign control.' },
      }, { executor: tx as never, workspaceId: scope.workspaceId, harnessSlug: harness })).toMatchObject({ status: 'created' });
    });
    const [spec] = await listSpecClauses({ workspaceId: scope.workspaceId, harnessSlug: harness, planSlug: plan, limit: 1 });
    expect(spec).toBeDefined();
    await db`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,source_plan_slug)
      VALUES (${scope.workspaceId},${harness},'WI-ee-proof',${plan})`;
    await db`INSERT INTO harness_shared.work_item_spec_revision_edges
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,created_by)
      VALUES (${scope.workspaceId},${harness},'WI-ee-proof',${plan},'EE-1',1,${spec!.contentHash},'su-ee-author')`;
    const [run] = await db`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,status,source,commit_sha,worktree_dirty)
      VALUES (${scope.workspaceId},${harness},'evidence-feature.integration.test.ts','vitest','pass','local',${'c'.repeat(40)},false)
      RETURNING id`;
    runId = Number(run!.id);
    await db`INSERT INTO harness_shared.test_case_runs (test_run_id,case_index,case_key,occurrence,status)
      VALUES (${runId},0,'ee.intent-exact',1,'pass')`;
    const [binding] = await db`INSERT INTO harness_shared.spec_evidence_bindings
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
        evidence_kind,evidence_ref,source_fingerprint,test_run_id,binding_fingerprint,created_by)
      VALUES (${scope.workspaceId},${harness},'WI-ee-proof',${plan},'EE-1',1,${spec!.contentHash},
        'test',${`test-run:${runId}`},${digest},${runId},${'b'.repeat(64)},'su-ee-author') RETURNING id`;
    bindingId = Number(binding!.id);
    // A separately scoped, same-file row must not become the requested owner.
    await seedPlan(db, 'ee-foreign', harness, 'foreign-plan', body.replaceAll(plan, 'foreign-plan'));
    await db`INSERT INTO harness_shared.plan_items (workspace_id,harness_slug,plan_slug,item_id,seq,item_text,status)
      VALUES ('ee-foreign',${harness},'foreign-plan','P-001',0,'Foreign ownership','todo')`;
    await db`INSERT INTO harness_shared.plan_item_anchors
      (workspace_id,harness_slug,plan_slug,item_id,anchor_kind,requested,path,content_hash,resolution,freshness,created_by)
      VALUES ('ee-foreign',${harness},'foreign-plan','P-001','path',${path},${path},${digest},'resolved','fresh','foreign-author')`;
  }, 180_000);

  afterAll(async () => {
    // Proof rows are append-only. Drop the owned private database through the
    // fixture lifecycle instead of attempting to DELETE its immutable history.
    try { if (root) await rm(root, { recursive: true, force: true }); }
    finally { await fixture?.dispose(); }
  });

  it('ee.intent-exact: traverses real compiler, anchor, immutable proof and exact case rows', async () => {
    const graph = await readEngineeringEvidence(query, scope, store());
    expect(graph.gaps.filter(g => g.code === 'authority-unavailable')).toEqual([]);
    expect(graph.nodes.find(n => n.kind === 'item')?.data).toMatchObject({ plan, item: 'P-001',
      anchor: { kind: 'path', fingerprintKind: 'file', fingerprint: digest, state: 'current' } });
    expect(graph.nodes.find(n => n.kind === 'proof')?.data).toMatchObject({ id: bindingId, revision: 1, runId });
    expect(graph.nodes.find(n => n.kind === 'test-case')?.data).toMatchObject({ runId, key: 'ee.intent-exact', occurrence: 1, status: 'pass' });
    expect(graph.nodes.filter(n => n.kind === 'decision').map(n => n.data.decision)).toEqual(['D-001']);
    expect(graph.execution.status).toBe('unobserved');
    expect(JSON.stringify(graph)).not.toContain('foreign-plan');
  }, 60_000);
  it('ee.tenant-repo: refuses an unregistered root and bounds actual SQL ownership results', async () => {
    await expect(readEngineeringEvidence(query, { ...scope, root: '/' }, store())).rejects.toThrow('scope_forbidden');
    const adapter = store();
    const [symbol] = await adapter.symbol(scope, query.symbol);
    expect(symbol).toBeDefined();
    const rows = await adapter.items(scope, query, symbol!, 1);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ workspaceId: scope.workspaceId, harness, plan });
    expect(await adapter.run({ ...scope, workspaceId: 'ee-foreign' }, runId)).toBeNull();
    expect(await adapter.cases({ ...scope, harness: 'foreign-repo' }, runId, 21)).toEqual([]);
  }, 60_000);
  it('ee.rename: source edits stale the declared file anchor without rewriting it', async () => {
    await writeFile(join(root, path), source.replace('return 1', 'return 2'));
    try {
      const graph = await readEngineeringEvidence(query, scope, store());
      expect(graph.edges.find(e => e.basis === 'declared-anchor')?.state).toBe('stale');
      expect(graph.nodes.find(n => n.kind === 'item')?.data.anchor).toMatchObject({ fingerprint: digest });
    } finally { await writeFile(join(root, path), source); }
  }, 60_000);
  it('ee.pruned-cases: retains the protected receipt and exposes missing case rows as unknown', async () => {
    await db`DELETE FROM harness_shared.test_case_runs WHERE test_run_id=${runId}`;
    await db`DELETE FROM harness_shared.test_runs WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} AND id=${runId}`;
    // Migration1378 deliberately retains any run cited by immutable proof.
    // Legacy absent-run handling is covered by the contract test; this current
    // schema must not defeat its retention guard merely to fabricate that state.
    expect(await store().run(scope, runId)).toMatchObject({ id: runId, status: 'pass' });
    const graph = await readEngineeringEvidence(query, scope, store());
    expect(graph.nodes.find(n => n.kind === 'proof')?.data.id).toBe(bindingId);
    expect(graph.nodes.find(n => n.kind === 'test-run')?.data).toMatchObject({ id: runId, status: 'pass' });
    expect(graph.nodes.filter(n => n.kind === 'test-case')).toEqual([]);
    expect(graph.gaps.some(g => g.code === 'test-cases-unavailable')).toBe(true);
    expect(graph.gaps.some(g => g.code === 'test-run-unavailable')).toBe(false);
  }, 60_000);
});
