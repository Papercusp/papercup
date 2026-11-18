/** Assertions run by telemetry-kernel-capture.integration.test.ts inside the
 * maintained private working-tree operator route, never against shared hosts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrgPg } from '@papercusp/db-org';
import { IDOP_P001_BASELINE_REL, loadIdopP001DispatchPermissionReader, loadIdopP001RolePermissionReader,
  replayIdopP001KernelPermissionSnapshot, runIdopP001PermissionComparison } from './idop-p001-baseline';
import { idopAuthorityData, idopAuthorityValue, type PermissionInputJson } from './permission-input-data';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function jsonContent(result: unknown): Record<string, unknown> {
  const response = object(result);
  assert.notEqual(response.isError, true, JSON.stringify(result).slice(0, 4_000));
  assert.ok(Array.isArray(response.content));
  for (const block of response.content) {
    const item = object(block);
    if (item.type !== 'text' || typeof item.text !== 'string') continue;
    try { return object(JSON.parse(item.text)); } catch { /* routing hints are not the JSON result */ }
  }
  assert.fail('private MCP call returned no JSON object');
}

async function main() {
  const env = process.env;
  const workspace = env.PAPERCUSP_WORKSPACE_ID ?? '';
  const base = env.PAPERCUSP_OPERATOR_URL ?? '';
  assert.match(workspace, /^test-runtime-/);
  assert.equal(env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.ok(env.PAPERCUSP_PG_PORT && env.PAPERCUSP_PG_PORT !== '5432');
  assert.equal(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port, env.PAPERCUSP_PG_PORT);
  assert.ok(!['3055', '3070', '3170', '3271'].includes(new URL(base).port));
  const url = new URL(env.PAPERCUSP_OPERATOR_MCP_URL!);
  assert.equal(url.origin, base);
  assert.equal(url.searchParams.get('workspace'), workspace);
  const client = new Client({ name: 'idop-kernel-capture-integration', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: {
      origin: base, 'x-papercusp-workspace': workspace, Authorization: `Bearer ${env.PAPERCUSP_OPERATOR_BEARER}`,
    } } }), { timeout: 30_000 });
    await client.listTools(undefined, { timeout: 30_000 });
    const call = async (name: string, args: Record<string, unknown>) => jsonContent(
      await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }));
    let capture = await call('dev_telemetry', { view: 'kernel-permission-inputs', payloadTier: 'full' });
    if (capture.schemaVersion === 'papercusp.output-envelope/v1') {
      assert.equal(capture.state, 'incomplete');
      assert.ok(Array.isArray(capture.content));
      assert.equal(capture.content.length, 1);
      const reference = object(capture.content[0]);
      assert.equal(typeof reference.uri, 'string');
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const page = await call('capability_read', { uri: reference.uri, byte_offset: offset, byte_limit: 1500 });
        assert.equal(page.ok, true);
        assert.equal(page.byte_offset, offset);
        assert.equal(typeof page.data, 'string');
        const bytes = Buffer.from(page.data as string, 'base64');
        assert.equal(bytes.length, page.byte_length);
        assert.ok(bytes.length > 0);
        chunks.push(bytes);
        offset += bytes.length;
        if (page.eof === true) { assert.equal(page.next_cursor, null); break; }
        assert.ok(offset < 4 * 1024 * 1024, 'private capture exceeded bounded readback');
      }
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, reference.byteCount);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
      capture = jsonContent(JSON.parse(bytes.toString('utf8')));
    }
    assert.equal(capture.ok, true);
    assert.equal(capture.scope, 'original-host-self-kernel-permission-inputs');
    const provenance = object(capture.provenance);
    assert.equal(provenance.ownerId, url.searchParams.get('client'));
    assert.equal(provenance.workspaceId, workspace);
    assert.equal(typeof capture.sha256, 'string');
    const replay = replayIdopP001KernelPermissionSnapshot(capture.snapshot, capture.sha256 as string);
    const original = replay.createPorts();
    assert.equal(original.requests.length, 1);
    const request = original.requests[0]!;
    assert.equal(request.toolName, 'dev:telemetry');
    assert.equal(request.ctx.uiClientId, provenance.ownerId);
    assert.equal(request.ctx.workspaceId, workspace);
    assert.equal(request.ctx.isSuperuser, true);
    assert.deepEqual(request.args, { view: 'kernel-permission-inputs' });
    assert.equal(object(provenance.runtime).processId, original.inner.runtime.processId);
    assert.notEqual(original.inner.runtime.pid, process.pid);
    // Read the actual mandatory ledger row, rather than deriving caller
    // privilege from a launch record or from this fixture's credentials.
    // The injected database and the queried workspace are both private.
    const { sql } = getOrgPg();
    const [server] = await sql`SELECT inet_server_port() AS port`;
    assert.equal(Number(server.port), Number(env.PAPERCUSP_PG_PORT));
    assert.equal(typeof request.callId, 'string');
    const invocations = await sql<{ id: string; invokedAt: string; status: string;
      ownerId: string; metadata: Record<string, unknown> }[]>`
      SELECT id::text, invoked_at::text AS "invokedAt", status,
        coord_owner_id AS "ownerId", metadata_json AS metadata
      FROM harness_shared.tool_invocations
      WHERE workspace_id=${workspace} AND coord_owner_id=${provenance.ownerId as string}
        AND tool_name='dev:telemetry'
        AND metadata_json->'originalInvocation'->>'callId'=${request.callId!}
      ORDER BY id LIMIT 2`;
    assert.equal(invocations.length, 1, 'kernel capture must bind one original invocation');
    const invocation = invocations[0]!;
    assert.equal(invocation.status, 'ok');
    assert.ok(Number.isFinite(Date.parse(invocation.invokedAt)));
    const observed = object(invocation.metadata.originalInvocation);
    assert.equal(observed.callId, request.callId);
    assert.equal(observed.ownerId, provenance.ownerId);
    assert.equal(observed.workspaceId, workspace);
    assert.deepEqual(observed.runtime, { pid: original.inner.runtime.pid, ...object(provenance.runtime) });
    const permission = object(observed.permissionContext);
    assert.equal(permission.scope, 'original-dispatch-context-projection');
    assert.equal(permission.status, 'captured');
    const data = permission.data as PermissionInputJson;
    assert.equal(createHash('sha256').update(JSON.stringify(data)).digest('hex'), permission.sha256);
    const context = object(idopAuthorityValue(data));
    assert.deepEqual(idopAuthorityData(context), data);
    assert.deepEqual(permission.keys, Object.keys(context).sort());
    for (const key of ['workspaceId', 'uiClientId', 'isSuperuser', 'isPowerUser', 'role',
      'principal', 'gateBypass', 'advSessionId', 'requestedExecutionRevision', 'appliedExecutionRevision'] as const) {
      assert.equal(Object.hasOwn(context, key), Object.hasOwn(request.ctx, key), `original presence: ${key}`);
      assert.deepEqual(context[key], request.ctx[key], `original value: ${key}`);
    }
    assert.equal(Object.hasOwn(context, 'kernelState'), false);
    assert.equal(Object.hasOwn(context, 'headers'), false);
    const root = resolve(import.meta.dirname, '../../../..');
    const baseline = JSON.parse(readFileSync(resolve(root, IDOP_P001_BASELINE_REL), 'utf8'));
    const evaluate = async (revision: string, layer: 'inner' | 'outer') => {
      // Each source arm and kernel layer gets its own original state cursor.
      // An inner replay must never consume the outer replay's state reads.
      const ports = replay.createPorts();
      const reader = loadIdopP001RolePermissionReader({ root, revision, testingFullAccess: 'off' });
      const inner = await reader.createInnerKernelReader(ports.inner);
      let evaluateKernel = inner.evaluate;
      if (layer === 'outer') {
        const generic = await loadIdopP001DispatchPermissionReader({ root, revision });
        const structural = reader.createStructuralKernelReader({ resolveIdentity: ports.inner.resolveIdentity,
          sameKernelRevision: generic.sameKernelRevision });
        evaluateKernel = reader.createOuterKernelReader({ app: ports.app, organization: ports.organization,
          resolveControlAnchor: inner.evaluate,
          structural: request => structural(request, request.ctx.kernelState) });
      }
      const verdict = await evaluateKernel(ports.requests[0]!);
      assert.ok(verdict, 'canonical kernel returned no verdict');
      assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
      return JSON.parse(JSON.stringify(verdict));
    };
    const layers = ['inner', 'outer'] as const;
    const cases = layers.map(layer => ({ id: `private-self-${layer}-kernel`,
      input: { snapshotSha256: capture.sha256 as string, layer } }));
    const layerOf = (id: string) => {
      const layer = layers.find(layer => id === `private-self-${layer}-kernel`);
      assert.ok(layer, 'comparison requested an uncaptured kernel layer');
      return layer;
    };
    const comparison = await runIdopP001PermissionComparison({ population: () => cases.map(row => row.id),
      enumerate: () => cases,
      before: (_input, id) => evaluate(baseline.base.commit, layerOf(id)),
      after: (_input, id) => evaluate('working-tree', layerOf(id)), manifest: [] });
    assert.equal(comparison.passed, true, JSON.stringify(comparison));
    const evidenceDir = env.WORKING_TREE_OPERATOR_API_EVIDENCE_DIR!;
    writeFileSync(resolve(evidenceDir, 'idop-kernel-capture.json'), JSON.stringify(capture), { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(evidenceDir, 'idop-kernel-comparison.json'), JSON.stringify(comparison), { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(evidenceDir, 'idop-original-invocation.json'), JSON.stringify(invocation), { flag: 'wx', mode: 0o600 });
    console.info('IDOP_KERNEL_CAPTURE_HTTP_PASS ' + JSON.stringify({ workspace, snapshotSha256: capture.sha256,
      boundary: request.boundary, runtime: provenance.runtime, comparisonPassed: comparison.passed }));
  } finally {
    await client.close();
    await getOrgPg().sql.end({ timeout: 1 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
