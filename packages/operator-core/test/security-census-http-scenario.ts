/** Authenticated discovery custody on the maintained disposable API/PG host. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connectAgentMcp } from '../lib/agent-mcp-client';
import { readSuperuserToken } from '../lib/superuser-token';
import { loadImmutableTextArtifact } from '../lib/text-artifacts';
import { verifyAuthenticatedRuntimeSecurityCensus } from '../lib/coverage-census/security-qualification';

const sources = ['packages/operator-core/lib/observability/runtime.ts',
  'packages/operator-core/lib/plugin-host-runtime.ts', 'packages/plugin-loader/src/index.ts'];
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyInvalidSecurityCensusBearerRefusal(url: URL, workspace: string) {
  // Initialize negotiates the MCP session. Authentication of a local SU bearer
  // happens at tools/call, so exercise the producer rather than its handshake.
  const { client } = await connectAgentMcp({ name: 'invalid-census-control', url: url.href,
    mode: 'http', timeoutMs: 10_000,
    headers: { Authorization: 'Bearer invalid-private-census-token' } });
  try {
    const result = await client.callTool({ name: 'dev:telemetry',
      arguments: { view: 'security-census', capture: true, harness: workspace } }, undefined,
    { timeout: 10_000 });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim();
    assert.equal(result.isError, true, 'invalid bearer must not enter the discovery producer');
    assert.equal(text, 'request_rejected: superuser_invalid_bearer',
      `invalid bearer control returned an unrelated refusal: ${text.slice(0, 1000)}`);
    return { tool: 'dev:telemetry', reason: 'superuser_invalid_bearer', isError: true } as const;
  } finally { await client.close(); }
}

export async function measureSecurityCensusScenario(o: {
  workspace: string; base: string; evidenceDir: string; bundle: string; hostPid: number; expectedSha: string;
}) {
  assert.match(o.workspace, /^test-runtime-/);
  const token = readSuperuserToken();
  assert.ok(token, 'disposable MCP bearer must be installed before private host boot');
  const url = new URL(o.base + '/api/mcp');
  for (const [key, value] of Object.entries({ superuser: '1', workspace: o.workspace, harness: o.workspace,
    client: 'su-private-security-census', format: 'json', structured: '1' })) url.searchParams.set(key, value);
  const invalidBearerRefusal = await verifyInvalidSecurityCensusBearerRefusal(url, o.workspace);

  const { client } = await connectAgentMcp({ name: 'private-security-census', url: url.href,
    mode: 'http', headers: { Authorization: `Bearer ${token}` } });
  try {
    await client.listTools();
    async function invoke(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name: 'tools:invoke', arguments: { name, args } }, undefined,
        { timeout: 45_000 });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const text = (result.content as Array<{ type: string; text?: string }>).find(part =>
        part.type === 'text' && part.text?.trim().startsWith('{'))?.text;
      assert.ok(text, 'structured producer receipt required');
      const body = JSON.parse(text);
      assert.notEqual(body.schemaVersion, 'papercusp.output-envelope/v1', 'bounded receipt must be inline');
      return body;
    }
    const identity = await invoke('coord:whoami', {});
    assert.equal(identity.workspaceId, o.workspace);
    assert.ok(identity.ownerId);
    const capture = await invoke('dev:telemetry', { view: 'security-census', capture: true, harness: o.workspace,
      projection: { pick: ['snapshotRef', 'receiptRef', 'discoverySha256', 'producer', 'status',
        'total', 'readbackVerified', 'populationComplete', 'closureAccepted', 'executionAdmitted'] } });
    assert.equal(capture.producer, identity.ownerId);
    assert.equal(capture.status, 'captured');
    assert.equal(capture.readbackVerified, true);
    for (const field of ['populationComplete', 'closureAccepted', 'executionAdmitted']) assert.equal(capture[field], false);
    const verified = await verifyAuthenticatedRuntimeSecurityCensus(o.workspace, capture);
    const { snapshot, receipt } = verified;
    assert.equal(receipt.actor, identity.ownerId);
    assert.equal(snapshot.runtimeIdentity.processId, o.hostPid);
    assert.equal(snapshot.count, snapshot.total);
    assert.equal(snapshot.rows.length, snapshot.total);
    assert.ok(snapshot.total > 0);
    assert.equal(snapshot.offset, 0);
    assert.equal(snapshot.truncatedByLimit, false);
    assert.equal(snapshot.populationComplete, false);
    assert.equal(snapshot.closureAccepted, false);
    assert.equal(snapshot.executionAdmitted, false);
    assert.ok(snapshot.unresolved.some(reason => reason.startsWith('security-population-not-closed:')));
    const artifact = snapshot.runtimeIdentity.artifact;
    assert.equal(artifact.status, 'measured', JSON.stringify(artifact));
    assert.ok('sourceBlobs' in artifact);
    assert.equal(artifact.sourceBindingScope, 'boot-bundle-tracked-inputs-only');
    // Health exposes the bundler's abbreviated commit; the artifact preserves
    // the full commit. Both must identify the same selected source.
    assert.match(o.expectedSha, /^[a-f0-9]{7,64}$/);
    assert.ok(artifact.sourceSha.startsWith(o.expectedSha), 'boot artifact differs from the serving build');
    const bundleSha256 = sha256(await readFile(o.bundle));
    assert.equal(artifact.bundleSha256, bundleSha256);
    const root = resolve(import.meta.dirname, '../../..');
    const sourcePins = [];
    for (const path of sources) {
      const bytes = await readFile(join(root, path));
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(artifact.sourceBlobs[path], blob, `boot-measured input differs: ${path}`);
      sourcePins.push({ path, blob, sha256: sha256(bytes), bytes: bytes.length });
    }
    const saved = await loadImmutableTextArtifact(o.workspace, capture.snapshotRef);
    assert.ok(saved);
    assert.equal(sha256(saved), capture.snapshotRef);
    assert.deepEqual(JSON.parse(saved), snapshot);
    await assert.rejects(verifyAuthenticatedRuntimeSecurityCensus(o.workspace,
      { receiptRef: capture.receiptRef, snapshotRef: '0'.repeat(64) }), /discovery_pin_substitution/);
    await writeFile(join(o.evidenceDir, 'security-census-snapshot.json'), saved, { flag: 'wx' });
    const signed = await loadImmutableTextArtifact(o.workspace, capture.receiptRef);
    assert.ok(signed);
    assert.equal(sha256(signed), capture.receiptRef);
    await writeFile(join(o.evidenceDir, 'security-census-signed-receipt.json'), signed, { flag: 'wx' });
    const proof = { workspace: o.workspace, hostPid: o.hostPid, producer: identity.ownerId,
      sourceSha: artifact.sourceSha, bundleSha256, sourcePins, snapshotRef: capture.snapshotRef,
      receiptRef: capture.receiptRef, discoverySha256: capture.discoverySha256, total: snapshot.total,
      invalidBearerRefusal, substitutionRefused: true, readbackVerified: true,
      populationComplete: false, closureAccepted: false, executionAdmitted: false,
      scope: 'private current-build authenticated runtime discovery; security qualification remains open' };
    await writeFile(join(o.evidenceDir, 'security-census-proof.json'), JSON.stringify(proof), { flag: 'wx' });
    return proof;
  } finally { await client.close(); }
}
