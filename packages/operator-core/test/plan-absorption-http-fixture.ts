/** Current-build public-tool proof on the maintained disposable operator/PG runtime. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { deriveIndexFromContent } from '../lib/agent-tools/plans/derive-index';
import { writePlanIndexRows } from '../lib/agent-tools/plans/plan-index-rows';
import { readPlanLineNodes, writePlanLineNodes } from '../lib/agent-tools/plans/plan-line-graph';
import { absorptionDecisionHash } from '../lib/plan-duplicate-absorption';
import { mutateWorkItemDependenciesInTransaction, withWorkItemDependencyAdmissionTransaction } from '../lib/dbos/work-item-deps-store';
import { privateBundleRuntimeEnv, resolvePreparedPrivateApiBundle, waitForPrivateOperator,
  stopPrivateOperatorHost } from './private-http-workspace-preflight';

let host: ChildProcess | undefined;
const actor = 'private-absorption-http-fixture';
const producer = 'private-absorption-producer';
async function main() {
  const env = process.env;
  const workspace = env.PAPERCUSP_WORKSPACE_ID!;
  const base = env.PAPERCUSP_OPERATOR_URL!;
  const evidenceDir = env.PLAN_ABSORPTION_HTTP_EVIDENCE_DIR!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(env.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const bundle = resolvePreparedPrivateApiBundle(process.argv.slice(2), evidenceDir);
  assert.ok(bundle, 'original prepared current API required');
  const bytes = readFileSync(bundle);
  assert.ok(bytes.includes(Buffer.from('plan_absorption_refused')), 'absorption implementation missing from runtime');
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  const hostEnv = privateBundleRuntimeEnv(env);
  host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  const hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('PLAN_ABSORPTION_HTTP_PHASE request-ready');
  const { sql } = getOrgPg();
  const content = '---\ntitle: Private absorption portfolio\nstatus: draft\n---\n\n## Items\n\n'
    + '- **P-001** `todo` Prerequisite.\n'
    + '- **P-003** `todo` Duplicate implementation. (blocked-by: P-001)\n'
    + '- **P-005** `todo` Consumer. (blocked-by: P-003)\n\n## Decisions\n\n'
    + '### D-006 — Preserve duplicate obligations\nAbsorb P-003 while retaining pending producer and sequencing obligations.\nRelated: P-003\n';
  const producerContent = '---\ntitle: Private producer\nstatus: draft\n---\n\n## Items\n\n- **P-001** `todo` Canonical producer.\n';
  await withWorkItemDependencyAdmissionTransaction(sql, async tx => {
    for (const [slug, body] of [['private-absorption', content], ['private-producer', producerContent]]) {
      const index = deriveIndexFromContent(body);
      await tx`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,status,content,content_hash,items,decisions)
        VALUES (${workspace},${workspace},${slug},${index.title},'draft',${body},
          ${createHash('sha256').update(body).digest('hex')},${JSON.stringify(index.items)}::jsonb,${JSON.stringify(index.decisions)}::jsonb)`;
      await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
        { workspaceId: workspace, harnessSlug: workspace, planSlug: slug }, index);
      const mutations = await writePlanLineNodes(tx, { workspaceId: workspace, harnessSlug: workspace, slug }, [], index.items);
      await mutateWorkItemDependenciesInTransaction(tx, { workspaceId: 'default', itemWorkspaceId: workspace, mutations });
    }
  });
  const nodes = await readPlanLineNodes(sql, { workspaceId: workspace, harnessSlug: workspace, slug: 'private-absorption' });
  const [target] = await readPlanLineNodes(sql, { workspaceId: workspace, harnessSlug: workspace, slug: 'private-producer' });
  const source = nodes.find(row => row.id === 'P-003')!;
  const prerequisite = nodes.find(row => row.id === 'P-001')!;
  const consumer = nodes.find(row => row.id === 'P-005')!;
  assert.ok(source && prerequisite && consumer && target, 'canonical private nodes required');
  // Fixtures own these disposable rows. Authenticated HTTP uses this same actor;
  // no production claim, hold, principal or workspace is modified.
  await sql`UPDATE harness_shared.work_items SET payload=payload-'_claimHold'-'claim_hold_by',
      taken_by=CASE WHEN feature_id=${source.featureId} THEN ${actor} ELSE ${producer} END,
      taken_at=now() WHERE workspace_id=${workspace} AND feature_id IN (${source.featureId},${target.featureId})`;
  const governing = deriveIndexFromContent(content).decisions.find(row => row.id === 'D-006')!;
  assert.ok(governing, 'governing fixture decision required');
  let requests = 0;
  async function tool(args: Record<string, unknown>) {
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
      body: JSON.stringify({ name: 'plans:set-status', args, harness: workspace, callerSid: actor, confirmed: true }),
      signal: AbortSignal.timeout(45_000) });
    const envelope = await response.json() as any;
    writeFileSync(join(evidenceDir, `absorption-request-${requests++}.json`), JSON.stringify({ status: response.status, args, envelope }));
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const json = envelope.result?.content?.find((part: any) => part.type === 'text' && part.text?.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (json ? JSON.parse(json.text) : envelope.result?.data ?? envelope.result);
    return result.results?.[0] ?? result;
  }
  const args = { slug: 'private-absorption', item: 'P-003', status: 'dropped', expectedStatus: 'todo',
    note: 'Administrative duplicate receipt retains accountable producer execution.', harness: workspace };
  const abandoned = await tool(args);
  assert.equal(abandoned.ok, false, JSON.stringify(abandoned));
  assert.equal(abandoned.error, 'blocker_decision_evidence', JSON.stringify(abandoned));
  const ref = { kind: 'work-item', ref: `${workspace}#${target.featureId}` };
  const blockerDecision = { schemaVersion: 1, idempotencyKey: 'private-absorption-1', disposition: 'absorb',
    symptom: 'Duplicate implementation lane', attempts: [], evidenceRefs: [ref],
    investigation: [{ action: 'Read canonical source and producer', outcome: 'Producer owns the duplicate obligation', evidenceRefs: [ref] }],
    absorption: { rationale: 'Preserve producer execution and source sequencing', decisionId: governing.id,
      decisionHash: absorptionDecisionHash(governing.title, governing.body),
      survivors: [{ harness: workspace, id: target.featureId, responsibleParty: producer }] } };
  const accepted = await tool({ ...args, blockerDecision });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.blockerDecision?.record?.decision?.disposition, 'absorb', JSON.stringify(accepted));
  const blocked = async () => (await sql<{ blocked: boolean }[]>`
    SELECT harness_shared.work_item_is_blocked(${workspace},${consumer.featureId},${workspace}) AS blocked`)[0].blocked;
  assert.equal(await blocked(), true, 'pending mapped producer must withhold consumer');
  const [persisted] = await sql`SELECT status,payload FROM harness_shared.work_items
    WHERE workspace_id=${workspace} AND feature_id=${source.featureId}`;
  assert.equal(persisted.status, 'dropped');
  assert.equal(persisted.payload.blockerResolution.history.at(-1).decision.disposition, 'absorb');
  const [custody] = await sql`SELECT status,taken_by FROM harness_shared.work_items
    WHERE workspace_id=${workspace} AND feature_id=${target.featureId}`;
  assert.equal(custody.taken_by, producer);
  assert.equal(custody.status, 'open');
  const replay = await tool({ ...args, blockerDecision });
  assert.equal(replay.blockerDecision?.replayed, true, JSON.stringify(replay));
  await sql`UPDATE harness_shared.work_items SET status='done',authority='committed',taken_by=NULL
    WHERE workspace_id=${workspace} AND feature_id IN (${prerequisite.featureId},${target.featureId})`;
  assert.equal(await blocked(), false, 'actual required completion must release consumer');
  await stopPrivateOperatorHost(host);
  host = undefined;
  console.log('PLAN_ABSORPTION_HTTP_RECEIPT ' + JSON.stringify({ workspace, bundleSha256, health,
    sourceId: source.featureId, targetId: target.featureId, consumerId: consumer.featureId,
    abandonmentRefused: true, absorptionPersisted: true, pendingConsumerBlocked: true,
    actualCompletionReleased: true, producerCustodyPreserved: true, replayed: true, hostStopped: true }));
}
try { await main(); }
catch (error) { console.error('PLAN_ABSORPTION_HTTP_FAILURE', error); process.exitCode = 1; }
finally { if (host) await stopPrivateOperatorHost(host); await getOrgPg().sql.end({ timeout: 1 }); }
