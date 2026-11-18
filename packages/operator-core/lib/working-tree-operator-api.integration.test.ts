/**
 * WI-6554700010048234: the commit-independent operator-API test route.
 *
 * Drives scripts/operator-api-working-tree.mjs end to end, the way an agent
 * does: the CLI bundles the CURRENT WORKING TREE, boots it on private ports
 * against a disposable migrated PG (with-test-pg --isolated-runtime=operator-api),
 * runs a caller command with the operator URL / MCP URL / bearer exported, then
 * tears the host down and prints a WORKING_TREE_OPERATOR_API_RECEIPT line.
 * The caller here proves the exported environment reaches a real request
 * against the private host rather than a live operator port.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, type TestContext } from 'vitest';
import { defaultEvidenceRoot } from '@papercusp/verification-harness';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const workerOptions = isolatedWorkerOptions(600_000);
const LIVE_OPERATOR_PORTS = ['3055', '3070', '3170'];

// Keep the caller's decoder in the native suite so malformed/partial batches
// fail before an expensive private build. It has no closure dependencies and
// is serialized into the child below.
function decodePrivateToolResponse(response: { structuredContent?: unknown }) {
  const batch = response.structuredContent as {
    results?: Array<{ status?: string; output?: { structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }> } }>;
  } | undefined;
  if (batch?.results?.length !== 1) throw new Error('Expected exactly one private MCP operation');
  const operation = batch.results[0]!;
  if (!['completed', 'failed'].includes(operation.status ?? '') || !operation.output)
    throw new Error('Private MCP operation did not settle with a readable output');
  if (operation.output.structuredContent) return operation.output.structuredContent;
  const text = operation.output.content?.find(c => c.type === 'text' && c.text?.trim().startsWith('{'))?.text;
  if (!text) throw new Error('Private MCP operation has no complete JSON body');
  return JSON.parse(text);
}

it('R11 private caller decodes complete singleton results and refusals, rejecting omitted or ambiguous operations', () => {
  for (const status of ['completed', 'failed']) {
    const body = { ok: status === 'completed', code: status === 'failed' ? 'unregistered_instrument' : undefined };
    for (const output of [{ structuredContent: body }, { content: [{ type: 'text', text: JSON.stringify(body) }] }])
      expect(decodePrivateToolResponse({ structuredContent: { results: [{ status, output }] } })).toEqual(body);
  }
  for (const results of [[], [{ status: 'unknown-effect' }], [{ status: 'completed' }],
    [{ status: 'completed', output: { content: [] } }], [{}, {}]])
    expect(() => decodePrivateToolResponse({ structuredContent: { results } })).toThrow();
});

// Runs inside the private runtime as the CLI's caller command (`-- <caller>`).
const CALLER_SCRIPT = [
  "const base = process.env.PAPERCUSP_OPERATOR_URL ?? '';",
  "const mcp = process.env.PAPERCUSP_OPERATOR_MCP_URL ?? '';",
  "const bearer = process.env.PAPERCUSP_OPERATOR_BEARER ?? '';",
  "if (!base || !mcp.startsWith(base + '/api/mcp') || !bearer) process.exit(3);",
  "const health = await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(15000) })).json();",
  "console.log('WORKING_TREE_CALLER_SAW ' + JSON.stringify({ service: health.service ?? null, port: new URL(base).port }));",
].join('\n');

async function runPrivateCaller(context: TestContext, callerScript = CALLER_SCRIPT,
  extraSources: string[] = [], verify?: (rows: string[]) => void) {
  const runId = await recordIsolatedIntegrationProof({ root, signal: context.signal,
    minimumFileRunTimeoutMs: workerOptions.testTimeoutMs,
    filePath: 'packages/operator-core/lib/working-tree-operator-api.integration.test.ts',
    sourcePaths: ['scripts/operator-api-working-tree.mjs', 'scripts/with-test-pg.mjs',
      'scripts/lib/with-test-pg-env.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
      'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/working-tree-operator-api-fixture.ts',
      'packages/operator-core/lib/endpoint-route/routes/misc/health.ts',
      'packages/operator-core/lib/superuser-token.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts', ...extraSources],
    execute: async (observe, evidenceDir) => {
      // The CLI owns the evidence dir layout (tmp/, node_modules symlink) when
      // WORKING_TREE_OPERATOR_API_EVIDENCE_DIR is set, so nothing is pre-created here.
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        WORKING_TREE_OPERATOR_API_EVIDENCE_DIR: evidenceDir };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(resolve(root, 'scripts/operator-api-working-tree.mjs'), [
        '--', process.execPath, '--input-type=module', '-e', callerScript,
      ], { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, { ...workerOptions, signal: context.signal });
      expect(result, result.output.slice(-12_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });

      const rows = result.output.split('\n');
      const receiptLine = rows.find(row => row.startsWith('WORKING_TREE_OPERATOR_API_RECEIPT '));
      expect(receiptLine, result.output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(receiptLine!.slice('WORKING_TREE_OPERATOR_API_RECEIPT '.length));
      expect(receipt).toMatchObject({
        workspace: expect.stringMatching(/^test-runtime-/),
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        health: { service: 'papercusp-operator' },
        mode: 'caller', callerExit: 0, hostStopped: true,
        // The acceptance bar: the working-tree operator answers a real MCP tool call.
        probe: { calledTool: expect.stringMatching(/^coord[:_]whoami$/), calledToolOk: true,
          toolCount: expect.any(Number), responseVersion: 'batch-v1' },
      });
      expect(receipt.probe.toolCount).toBeGreaterThan(0);
      expect(LIVE_OPERATOR_PORTS).not.toContain(new URL(receipt.base).port);

      const sawLine = rows.find(row => row.startsWith('WORKING_TREE_CALLER_SAW '));
      expect(sawLine, result.output.slice(-8_000)).toBeTruthy();
      expect(JSON.parse(sawLine!.slice('WORKING_TREE_CALLER_SAW '.length))).toEqual({
        service: 'papercusp-operator', port: new URL(receipt.base).port,
      });
      verify?.(rows);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('WORKING_TREE_OPERATOR_API_PROOF_RUN ' + runId);
  return runId;
}

it('runs a caller against an operator bundled from the working tree on private ports, then tears it down', async context => {
  await runPrivateCaller(context);
}, workerOptions.testTimeoutMs);

it('R11 prepared operational rubric reaches public propose and complete readback on a private current-source operator without activation', async context => {
  // Exact prepared PG artifact, not a second operational contract. Its schedule
  // is retained for identity only; this private test never ratifies or arms it.
  const fixture = 'packages/operator-core/test/bug-scoreboard-operational-bindings.fixture.json';
  const preparedText = readFileSync(resolve(root, fixture), 'utf8').trimEnd();
  expect(preparedText.length).toBe(4039);
  const preparedSha256 = createHash('sha256').update(preparedText).digest('hex');
  const caller = CALLER_SCRIPT + '\n' + [
    "import assert from 'node:assert/strict';",
    "import { Client } from '@modelcontextprotocol/sdk/client/index.js';",
    "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
    'const prepared = JSON.parse(' + JSON.stringify(preparedText) + ');',
    "assert.match(process.env.PAPERCUSP_WORKSPACE_ID ?? '', /^test-runtime-/);",
    "assert.equal(prepared.status, 'prepared-only-not-proposed-not-ratified-not-armed');",
    "const client = new Client({ name: 'r11-private-proposal', version: '1' });",
    'try {',
    '  await client.connect(new StreamableHTTPClientTransport(new URL(mcp), { requestInit: { headers: { Authorization: `Bearer ${bearer}`, origin: base } } }), { timeout: 30000 });',
    '  const listing = await client.listTools(undefined, { timeout: 30000 });',
    '  const decode = ' + decodePrivateToolResponse.toString() + ';',
    '  const request = async (name, args) => {',
    "    const tool = listing.tools.find(t => t.name === name || t.name === name.replaceAll(':', '_'));",
    "    assert.ok(tool, 'Private operator must list ' + name);",
    "    const response = await client.callTool({ name: tool.name, arguments: args, _meta: { 'papercusp/batchResponseVersion': 'batch-v1' } }, undefined, { timeout: 30000 });",
    '    return decode(response);',
    '  };',
    "  const proposed = await request('rubrics:propose', { ...prepared.rubric, projection: { pick: ['ok', 'rubric.status', 'rubric.kind', 'rubric.ratifiedBy'] } });",
    '  assert.equal(proposed.ok, true, JSON.stringify(proposed));',
    "  assert.equal(proposed.rubric.status, 'proposed');",
    '  assert.equal(proposed.rubric.ratifiedBy, null);',
    "  assert.equal(proposed.rubric.kind, 'standard');",
    "  const loaded = await request('rubrics:get', { rubricRef: prepared.rubric.rubricRef, detail: 'full', projection: { pick: ['ok', 'results[].ok', 'results[].rubricRef', 'results[].rubric.criteria', 'results[].rubric.status', 'results[].rubric.ratifiedBy'] } });",
    '  assert.equal(loaded.ok, true, JSON.stringify(loaded));',
    '  const persisted = loaded.results.find(r => r.rubricRef === prepared.rubric.rubricRef);',
    '  assert.equal(persisted.ok, true);',
    "  assert.equal(persisted.rubric.status, 'proposed');",
    '  assert.equal(persisted.rubric.ratifiedBy, null);',
    '  assert.equal(persisted.rubric.criteria.length, prepared.rubric.criteria.length);',
    '  for (const [key, value] of Object.entries(prepared.rubric.criteria[0])) assert.deepEqual(persisted.rubric.criteria[0][key], value, key);',
    // An unregistered binding must still fail at the same public proposal door.
    "  const rejected = await request('rubrics:propose', { ...prepared.rubric, rubricRef: 'r11-private-unregistered-control', criteria: [{ ...prepared.rubric.criteria[0], instrumentKey: 'bugs:r11-unregistered-control', check: { kind: 'instrument', instrumentKey: 'bugs:r11-unregistered-control' } }] });",
    '  assert.equal(rejected.ok, false, JSON.stringify(rejected));',
    "  assert.match(rejected.code, /unregistered.*instrument|instrument.*unregistered/);",
    "  const absent = await request('rubrics:get', { rubricRef: 'r11-private-unregistered-control', detail: 'full' });",
    '  assert.equal(absent.results[0].ok, false, JSON.stringify(absent));',
    "  console.log('R11_PRIVATE_PROPOSAL ' + JSON.stringify({ workspace: process.env.PAPERCUSP_WORKSPACE_ID, rubricRef: prepared.rubric.rubricRef, preparedSha256: " + JSON.stringify(preparedSha256) + ", criteria: persisted.rubric.criteria.length, status: persisted.rubric.status, rejectedBinding: rejected.code, durableCanonicalProposal: false, activated: false }));",
    '} finally { await client.close(); }',
  ].join('\n');
  const runId = await runPrivateCaller(context, caller, [fixture,
    'packages/operator-core/lib/agent-tools/rubrics/propose.ts',
    'packages/operator-core/lib/agent-tools/rubrics/get.ts',
    'packages/operator-core/lib/rubric-instrument-registry.ts',
    'packages/operator-core/lib/harness/improvements/bug-scoreboard-instrument.ts',
  ], rows => {
    const proof = rows.find(row => row.startsWith('R11_PRIVATE_PROPOSAL '));
    expect(proof).toBeTruthy();
    expect(JSON.parse(proof!.slice('R11_PRIVATE_PROPOSAL '.length))).toMatchObject({
      workspace: expect.stringMatching(/^test-runtime-/), rubricRef: 'bug-scoreboard-daily-operations',
      preparedSha256, criteria: 1, status: 'proposed', durableCanonicalProposal: false, activated: false,
    });
  });
  const observation = JSON.parse(readFileSync(resolve(defaultEvidenceRoot('isolated-integration'), runId,
    'phases/execute/lifecycle-observation.json'), 'utf8'));
  expect(observation.ended).toMatchObject({ exitCode: 0, signal: null, runtimeRemoved: true, pgDataRemoved: true });
}, workerOptions.testTimeoutMs);
