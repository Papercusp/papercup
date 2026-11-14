import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';
import { getClaimTimeTaskBrief, type TaskBriefDeps } from './task-brief';
import { firstPartyCallers } from './first-party-callers';
import { declarationContentHash, type PlanItemAnchor } from '../plan-items/anchors';
import { ensureBootstrap, getTxPool, tryAcquire, tryRelease, _resetForTests as resetLockStore } from '../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../agent-tools/locks/in-workspace-txn';
import { toolsetFromNames } from './push-toolset';
import { readPushSourceLinks } from './push-channel';
import { liveLockHoldingsStrict } from '../agent-tools/locks/live-lock-paths';

describe('plan anchors P008 persisted claim context', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  let lockAcquired = false;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(); }, 180_000);
  afterAll(async () => {
    try {
      if (lockAcquired) await inWorkspaceTxn(state.root, 'su-p008-peer', tx => tryRelease(tx as never, {
        coordinationDomain: state.root, owner: 'su-p008-peer', allMine: true,
      }), { paths: ['consumer.ts'] });
    } finally { try { await resetLockStore(); } finally { await state?.dispose(); } }
  });

  it('returns exact function impact with real doc/spec/lock readers and records delivered and skipped claims', async () => {
    const { root, path, scope, harness, plan, db, bindingId } = state;
    const source = state.source + 'export function unlinkedFeature() { return 2; }\n';
    await writeFile(join(root, path), source);
    await writeFile(join(root, 'consumer.ts'), 'import { evidenceFeature } from "./src/evidence-feature";\nexport function consumer() { return evidenceFeature(); }\n');
    await writeFile(join(root, 'added.ts'), 'import { evidenceFeature } from "./src/evidence-feature";\nexport const value = evidenceFeature();\n');
    await writeFile(join(root, 'feature.test.ts'), 'import { consumer } from "./consumer";\nexport const check = consumer();\n');
    await writeFile(join(root, 'unlinked.ts'), 'import { unlinkedFeature } from "./src/evidence-feature";\nexport const other = unlinkedFeature();\n');
    await db`INSERT INTO harness_shared.harness_docs (workspace_id,harness_slug,doc_id,anchor_paths)
      VALUES (${scope.workspaceId},${harness},'anchored-feature-guide',${[path]}::text[])`;
    // Extend the canonical fixture's existing immutable proof with source-path measurement metadata.
    await db`INSERT INTO harness_shared.spec_evidence_bindings
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
       evidence_kind,evidence_ref,source_fingerprint,binding_fingerprint,created_by,details)
      SELECT workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
        evidence_kind,'p008-source-link',source_fingerprint,${'d'.repeat(64)},created_by,
        ${db.json({ currentMeasurement: { kind: 'repo-files', rootHarnessSlug: harness, sourcePaths: [path] } })}
      FROM harness_shared.spec_evidence_bindings WHERE id=${bindingId}`;
    await ensureBootstrap();
    const lockDb = getTxPool();
    const [expected, actual] = await Promise.all([
      db`SELECT inet_server_addr()::text AS host, inet_server_port() AS port`,
      lockDb`SELECT inet_server_addr()::text AS host, inet_server_port() AS port, current_database() AS name`,
    ]);
    // The lock package deliberately derives a side database on the configured test server.
    expect(actual[0]).toEqual({ ...expected[0], name: 'papercusp_su' });
    expect(await inWorkspaceTxn(root, 'su-p008-peer', tx => tryAcquire(tx as never, { coordinationDomain: root,
      owner: 'su-p008-peer', ownerLabel: 'P008 fixture peer', paths: ['consumer.ts'], intent: 'fixture consumer edit',
      goalRef: 'WI-p008-consumer', ttlSec: 120 }), { paths: ['consumer.ts'] })).toMatchObject({ ok: true });
    lockAcquired = true;
    // Fail at the real reader seam before the bounded brief can hide a fixture
    // route error as unknown context. Keep phase/row evidence for slow failures.
    const timings: Record<string, number> = {};
    async function preflight<T>(name: string, read: () => Promise<T>): Promise<T> {
      const startedAt = performance.now();
      try { return await read(); }
      catch (error) {
        console.info('P008_CONTEXT_PREFLIGHT', JSON.stringify({ phase: name,
          error: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' && 'code' in error ? error.code : null }));
        throw error;
      }
      finally {
        timings[name] = Math.round(performance.now() - startedAt);
        console.info('P008_CONTEXT_PREFLIGHT', JSON.stringify({ phase: name, elapsedMs: timings[name] }));
      }
    }
    const [sourceLinks, holdings] = await Promise.all([
      preflight('source-links', () => readPushSourceLinks({ workspace: scope.workspaceId,
        harness, root, owner: 'su-p008-claim', calls: [] }, [path])),
      preflight('consumer-locks', () => liveLockHoldingsStrict()),
    ]);
    expect(sourceLinks.byPath?.[path], JSON.stringify({ sourceLinks, timings })).toEqual({
      docs: ['anchored-feature-guide'], specs: [`${plan}#EE-1@1`],
    });
    expect(holdings, JSON.stringify({ holdings, timings })).toEqual(expect.arrayContaining([
      expect.objectContaining({ coordinationDomain: root, path: 'consumer.ts',
        owner: 'su-p008-peer', goalRef: 'WI-p008-consumer' }),
    ]));
    console.info('P008_CONTEXT_PREFLIGHT', JSON.stringify({ phase: 'rows-verified', timings,
      docs: sourceLinks.byPath?.[path]?.docs, specs: sourceLinks.byPath?.[path]?.specs,
      locks: holdings.filter(holding => holding.coordinationDomain === root) }));
    const contentHash = await declarationContentHash(source, { id: 'evidenceFeature', name: 'evidenceFeature', path,
      line: 1, column: 17, sha256: '', signature: '', aliases: [], callers: [] });
    const anchor: PlanItemAnchor = { anchorKind: 'symbol', requested: 'evidenceFeature', symbolId: 'evidenceFeature',
      symbolName: 'evidenceFeature', path, line: 1, signature: null, contentHash, consumers: [{ path: 'consumer.ts', line: 2 }],
      consumersTotal: 1, tests: [], resolution: 'resolved', unknownReason: null, freshness: 'fresh', resolvedCommit: 'a'.repeat(40) };
    const graph = firstPartyCallers({ ts, root, name: 'evidenceFeature', filePath: path, paths: ['.'],
      op: 'impact', direction: 'downstream', maxDepth: 5, maxPaths: 20, limit: 50 });
    expect(graph.error).toBeNull();
    const deps: TaskBriefDeps = { root: async () => root,
      effects: { exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => '', now: () => new Date(0) },
      graph: async () => { throw new Error('Whole-file graph must not run for an anchored claim.'); },
      anchors: { graph: async () => graph, writeArtifact: async () => 'fixture-artifact',
        // Exercise the same default reader while retaining its original failure
        // before the production bounded wrapper returns unknown context.
        links: (input, paths) => preflight('claim-source-links', () => readPushSourceLinks({ ...input, calls: [] }, paths)),
      },
      reuse: { providers: [] }, toolset: async () => toolsetFromNames(['code:pack', 'work_items:get']),
      pack: async (_op, args) => {
        const artifact = join(root, 'claim.xml');
        await writeFile(artifact, (await Promise.all(args.include.map(async file => `<file path="${file}">${await readFile(join(root, file), 'utf8')}</file>`))).join('\n'));
        return { answer: { error: null, sites: args.include.map(path => ({ path })) },
          artifact: { path: artifact, provenance: { commit: 'fixture-commit' } } } as never;
      },
    };
    const ref = { workspaceId: scope.workspaceId, reuse: { owner: 'su-p008-claim', invocation: 'claim-anchored' },
      workItem: { id: 'WI-p008-claim', harness, payload: { anchors: [anchor] } } };
    const brief = (await getClaimTimeTaskBrief(ref, deps))!.taskBrief;
    expect(brief.anchors, JSON.stringify(brief)).toMatchObject({
      subjects: [expect.objectContaining({ callers: expect.arrayContaining(['consumer.ts:2', 'added.ts:2']),
        tests: ['feature.test.ts'], impact: expect.arrayContaining(['consumer.ts', 'added.ts', 'feature.test.ts']),
        addedSincePlanning: ['added.ts:2'] })],
      docs: ['anchored-feature-guide'], specs: [`${plan}#EE-1@1`],
      locks: [{ path: 'consumer.ts', owner: 'su-p008-peer', goalRef: 'WI-p008-consumer' }],
    });
    expect(JSON.stringify(brief.anchors)).not.toContain('unlinked.ts');
    await getClaimTimeTaskBrief({ ...ref, reuse: { ...ref.reuse, invocation: 'claim-no-links' },
      workItem: { ...ref.workItem, payload: { anchors: [] } } }, deps);
    const rows = await db<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id=${scope.workspaceId} AND owner_id='su-p008-claim' AND leg='claim-brief' ORDER BY id`;
    expect(rows.map(row => JSON.parse(row.subject))).toEqual([
      expect.objectContaining({ invocation: 'claim-anchored', outcome: 'delivered', reason: null }),
      expect.objectContaining({ invocation: 'claim-no-links', outcome: 'skipped', reason: expect.any(String) }),
    ]);
  }, 60_000);
});
