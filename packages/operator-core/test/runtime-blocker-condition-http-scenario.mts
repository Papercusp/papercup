/** Actual API calls on the maintained disposable operator; never a live workspace. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';

const e = process.env;
const workspace = e.PAPERCUSP_WORKSPACE_ID ?? '';
const base = e.PAPERCUSP_OPERATOR_URL ?? '';
const bearer = e.PAPERCUSP_OPERATOR_BEARER ?? '';
const evidenceDir = e.WORKING_TREE_OPERATOR_API_EVIDENCE_DIR ?? '';
assert.match(workspace, /^test-runtime-/);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(!['3055', '3070', '3170', '3271'].includes(new URL(base).port));
assert.ok(bearer && evidenceDir);
assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
const root = resolve(import.meta.dirname, '../../..');
// ESM file URLs preserve the committed-source loader's child-module boundary.
const { createWorkItem, getWorkItem } = await import(pathToFileURL(join(root,
  'packages/operator-core/lib/work-items.ts')).href) as typeof import('../lib/work-items');
const { readExternalBlockers } = await import(pathToFileURL(join(root,
  'packages/operator-core/lib/external-blockers.ts')).href) as typeof import('../lib/external-blockers');
const { runtimeBindingSha256 } = await import(pathToFileURL(join(root,
  'packages/operator-core/lib/runtime-blocker-condition.ts')).href) as typeof import('../lib/runtime-blocker-condition');
const harness = workspace;
const custodianClient = 'private-runtime-binding-custodian-' + workspace;
const reviewerClient = 'private-runtime-binding-reviewer-' + workspace;
const requests: Array<{ name: string; client: string; status: number; args: unknown; envelope: unknown }> = [];

async function invoke(name: string, args: Record<string, unknown>, client = custodianClient, allowRefusal = false) {
  const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base,
      'x-papercusp-workspace': workspace, authorization: 'Bearer ' + bearer },
    body: JSON.stringify({ name, args, harness, callerSid: client }), signal: AbortSignal.timeout(30_000) });
  const envelope = await response.json() as any;
  requests.push({ name, client, status: response.status, args, envelope });
  assert.equal(response.status, 200, JSON.stringify(envelope));
  if (!allowRefusal) {
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
  }
  const block = envelope.result?.content?.find((part: any) => part.type === 'text'
    && typeof part.text === 'string' && part.text.trim().startsWith('{'));
  const data = envelope.result?.structuredContent ?? (block ? JSON.parse(block.text) : envelope.result?.data);
  assert.ok(data, JSON.stringify(envelope));
  return data;
}

async function main() {
  const { sql } = getOrgPg();
  const [database] = await sql`SELECT inet_server_port() AS port`;
  assert.ok(Number.isInteger(Number(database.port)) && Number(database.port) > 0);
  assert.notEqual(Number(database.port), 5432);
  assert.equal(Number(database.port), Number(e.PAPERCUSP_PG_PORT));
  const custodian = (await invoke('coord:whoami', {})).ownerId as string;
  const reviewer = (await invoke('coord:whoami', {}, reviewerClient)).ownerId as string;
  assert.ok(custodian && reviewer);
  assert.notEqual(custodian, reviewer, 'Private authenticated clients must resolve to distinct identities');
  const now = new Date().toISOString();
  const ref = 'private-reviewed-runtime-condition';
  const blocker = { kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit', ref,
    summary: 'Exact private runtime binding fixture', status: 'active', createdAt: now, updatedAt: now, createdBy: custodian };
  const item = await createWorkItem({ kind: 'change', title: 'Private reviewed binding API fixture',
    harness, workspaceId: workspace, createdBy: custodian, assignee: custodian,
    payload: { keep: 'unrelated private payload', externalBlockers: [blocker] } });
  const binding = { schemaVersion: 1, host: 'port-' + new URL(base).port,
    sourceBlobs: { 'packages/operator-core/lib/runtime-blocker-condition.ts': '1'.repeat(40) },
    toolSchema: { tool: 'work_items:set_blocker', sha256: '1'.repeat(64) },
    reason: 'Private first-binding fixture', reasonRef: 'fixture:runtime-binding-http' };
  const first = (await invoke('work_items:set_blocker', { id: item.id, harness, ref,
    bindRuntimeCondition: binding })).results[0];
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.changed, true);
  const original = first.workItem;
  const prior = original.payload.externalBlockers[0].runtimeConditionBinding;
  const upgrade = { expectedBindingSha256: runtimeBindingSha256(prior), binding: { ...binding,
    sourceBlobs: { 'packages/operator-core/lib/runtime-blocker-condition.ts': '2'.repeat(40) },
    toolSchema: { ...binding.toolSchema, sha256: '2'.repeat(64) }, reason: 'Private exact reviewed pin upgrade' } };
  const apply = async (approvalRef?: string, extra: Record<string, unknown> = {}, allowRefusal = false) => {
    const result = await invoke('work_items:set_blocker', { id: item.id, harness, ref,
      rebindRuntimeCondition: { ...upgrade, ...extra, ...(approvalRef ? { approvalRef } : {}) } },
    custodianClient, allowRefusal);
    return result.results?.[0] ?? result;
  };
  const preview = await apply();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.changed, false);
  assert.equal(preview.preview.workItemId, item.id);
  const discussion = await invoke('conversations:post', { title: 'Private binding receipts',
    body: 'Private fixture receipts; no live work is authorized.', harness });
  assert.ok(discussion.conversation_id);
  const approve = async (receipt: unknown, client: string) => {
    const post = await invoke('conversations:post', { conversation_id: discussion.conversation_id,
      body: JSON.stringify(receipt) }, client);
    assert.ok(post.post_id);
    return 'thread-post:' + post.post_id;
  };
  const selfApproval = await approve(preview.preview, custodianClient);
  assert.equal((await apply(selfApproval, {}, true)).code, 'runtime_binding_invalid');
  const alteredApproval = await approve({ ...preview.preview, workItemId: 'WI-foreign' }, reviewerClient);
  assert.equal((await apply(alteredApproval, {}, true)).code, 'runtime_binding_invalid');
  const approvalRef = await approve(preview.preview, reviewerClient);
  const [post] = await sql<Array<{ author_id: string; origin: string; body: string }>>`
    SELECT author_id, origin, body FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${workspace} AND id = ${approvalRef.slice('thread-post:'.length)}::bigint`;
  assert.equal(post.author_id, reviewer);
  assert.equal(post.origin, 'local');
  assert.deepEqual(JSON.parse(post.body), preview.preview);
  const applied = await apply(approvalRef);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.changed, true);
  assert.equal(applied.audit.approvedBy, reviewer);
  assert.equal(applied.audit.approvalRef, approvalRef);
  assert.deepEqual(applied.audit.priorBinding, prior);
  assert.equal(applied.audit.appliedBy, custodian);
  const replay = await apply(approvalRef);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.changed, false);
  assert.equal(replay.replayed, true);
  assert.equal((await apply(approvalRef, { expectedBindingSha256: '0'.repeat(64) }, true)).code, 'runtime_binding_invalid');
  const stored = await getWorkItem(item.id, harness);
  assert.ok(stored);
  assert.equal(stored.state, original.state);
  assert.equal(stored.assignee, custodian);
  assert.equal((stored.payload as { keep: string }).keep, 'unrelated private payload');
  const [active] = readExternalBlockers(stored.payload);
  assert.equal(active.ref, ref);
  assert.equal(active.status, 'active');
  assert.equal(active.runtimeConditionBindingTransitions?.length, 1);
  assert.deepEqual(active.runtimeConditionBindingTransitions?.[0].nextBinding, applied.audit.nextBinding);
  console.info('RUNTIME_BINDING_HTTP_VERIFIED ' + JSON.stringify({ workspace, itemId: item.id,
    custodian, reviewer, approvalRef, auditEntries: 1, reviewerAuthenticated: true,
    activeBlockerRetained: true, lifecycleUnchanged: true, selfApprovalRefused: true,
    alteredReceiptRefused: true, stalePinsRefused: true, replayed: true }));
}

try { await main(); }
finally {
  await writeFile(join(evidenceDir, 'runtime-binding-http-requests.json'), JSON.stringify(requests, null, 2));
  await _resetForTests();
}
