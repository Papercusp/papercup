/** Real current-build routes, isolated PG and generated native hook dispatchers.
 * Fixture identities have no native activation: their attribution must stay
 * UNKNOWN. Hook stdout alone cannot label content or prove native consumption. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { collectContextPackingReceiptSources } from '../lib/context-packing-receipts';
import { exportContextPackingAttemptSnapshot, sampleFinalDeliveredContext,
  validateFinalDeliveredContextSample } from '../lib/memory/injection-delivery-coverage';
import { privateBundleRuntimeEnv, resolvePreparedPrivateApiBundle, waitForPrivateOperator,
  stopPrivateOperatorHost } from './private-http-workspace-preflight';
import { retainIsolatedWorkerProgress } from './isolated-integration-proof';

let host: ChildProcess | undefined;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function dispatch(root: string, client: 'codex' | 'claude' | 'omp', port: 'turn-start' | 'mid-turn',
  owner: string, workspace: string, base: string, evidenceDir: string) {
  const event = port === 'turn-start' ? { prompt: 'context packing receipt approval' }
    : client === 'codex' ? { tool_name: 'Grep', tool_input: { pattern: 'context packing receipt' }, tool_response: '' }
    : client === 'claude' ? { tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'context packing receipt' }, tool_response: '' }] }
    : { message: { content: [{ type: 'toolCall', id: 'packing-call', name: 'Grep',
      arguments: { pattern: 'context packing receipt' } }] },
    toolResults: [{ toolCallId: 'packing-call', toolName: 'Grep', content: [{ type: 'text', text: '' }] }] };
  const name = port === 'turn-start' ? (client === 'omp' ? 'before_agent_start' : 'UserPromptSubmit')
    : client === 'codex' ? 'PostToolUse' : client === 'claude' ? 'PostToolBatch' : 'turn_end';
  const outcomeFile = join(evidenceDir, `${client}-${port}-hook-outcome.ndjson`);
  const child = spawn(process.execPath, [join(root, 'apps/operator/scripts/hooks/inject/index.mjs'),
    `--client=${client}`, `--event=${name}`], { cwd: root,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: process.env.HOME,
      PAPERCUSP_HOME: process.env.PAPERCUSP_HOME, PAPERCUSP_SID: owner,
      PAPERCUSP_WORKSPACE: workspace, PAPERCUSP_HARNESS_SLUG: workspace, PAPERCUSP_OPERATOR_URL: base,
      PAPERCUSP_HOOK_OUTCOME_FILE: outcomeFile },
    stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
    child.stdin.end(JSON.stringify(event));
    return { ...await terminal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
      outcomeTrace: existsSync(outcomeFile) ? readFileSync(outcomeFile, 'utf8') : null };
  } finally { clearTimeout(timer); }
}

async function main() {
  const env = process.env, workspace = env.PAPERCUSP_WORKSPACE_ID!, base = env.PAPERCUSP_OPERATOR_URL!;
  const evidenceDir = env.CONTEXT_INJECTION_HTTP_EVIDENCE_DIR!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(env.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const bundle = resolvePreparedPrivateApiBundle(process.argv.slice(2), evidenceDir);
  assert.ok(bundle, 'prepared current API required');
  const bytes = readFileSync(bundle), bundleSha256 = hash(bytes);
  assert.ok(bytes.includes(Buffer.from('native-session-unavailable')), 'attribution implementation missing');
  const hostEnv = privateBundleRuntimeEnv(env);
  host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  const hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('CONTEXT_INJECTION_HTTP_PHASE request-ready');
  let routes = 0, nativeDispatchers = 0, sampled = 0;
  for (const client of ['codex', 'claude', 'omp'] as const) for (const port of ['turn-start', 'mid-turn'] as const) {
    retainIsolatedWorkerProgress(evidenceDir, 'packing-http-start', { client, port });
    const owner = `private-context-${client}-${port}`;
    const request = { owner, workspace, harness: workspace, client, cwd: root, wallMs: 10_000,
      prompt: 'context packing receipt approval', tool: 'Grep', toolInput: { pattern: 'context packing receipt' } };
    const response = await fetch(base + '/api/agent-mcp/' + (port === 'turn-start' ? 'turn-start-memory' : 'mid-turn-context'),
      { method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { ok?: boolean; packingReceipt?: unknown };
    writeFileSync(join(evidenceDir, `${client}-${port}-http.json`), JSON.stringify({ request, status: response.status, body }));
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.ok(body.packingReceipt, `missing ${client}/${port} production packing receipt: ${JSON.stringify(body)}`);
    routes++;
    retainIsolatedWorkerProgress(evidenceDir, 'packing-http-complete', { client, port });
    retainIsolatedWorkerProgress(evidenceDir, 'packing-hook-start', { client, port });
    const dispatched = await dispatch(root, client, port, owner, workspace, base, evidenceDir);
    writeFileSync(join(evidenceDir, `${client}-${port}-hook.json`), JSON.stringify(dispatched));
    assert.equal(dispatched.code, 0, dispatched.stderr);
    assert.equal(dispatched.signal, null, dispatched.stderr);
    nativeDispatchers++;
    retainIsolatedWorkerProgress(evidenceDir, 'packing-hook-complete', { client, port });
    retainIsolatedWorkerProgress(evidenceDir, 'packing-census-start', { client, port });
    const measuredAt = new Date().toISOString();
    const census = await collectContextPackingReceiptSources({ workspaceId: workspace, ownerId: owner,
      harness: workspace, port, client });
    assert.equal(census.complete, true, JSON.stringify(census.unknown));
    retainIsolatedWorkerProgress(evidenceDir, 'packing-census-complete', { client, port });
    // Direct HTTP and the generated dispatcher must each prepare a retained
    // source; a successful silent hook exit is not proof it reached its route.
    assert.ok(census.sources.length >= 2, `${client}/${port}: hook did not produce a second retained attempt`);
    for (const source of census.sources) {
      const attribution = source.stored.preparation?.attribution ?? source.stored.preparationWithheld?.attribution;
      assert.equal(attribution?.nativeSession, null, 'unregistered fixture native identity must remain unknown');
      assert.ok(attribution.unknown.includes('native-session-unavailable'));
    }
    retainIsolatedWorkerProgress(evidenceDir, 'packing-sample-start', { client, port });
    const exported = exportContextPackingAttemptSnapshot(census, { snapshotId: `${client}-${port}`,
      sourceSchemaSha256: hash(readFileSync(join(root, 'packages/operator-core/lib/context-packing-receipts.ts'))),
      measuredAt, runtimeGeneration: bundleSha256,
      environmentSha256: hash(JSON.stringify({ workspace, base })),
      configurationSha256: hash(JSON.stringify({ client, port, wallMs: request.wallMs })) });
    assert.ok(exported.snapshot, JSON.stringify(exported.unknown));
    const sample = sampleFinalDeliveredContext(exported.snapshot);
    const replay = validateFinalDeliveredContextSample(sample,
      { sourceSnapshot: exported.snapshot, sourceSnapshotSha256: sample.sourceSnapshotSha256 });
    assert.equal(replay.valid, true, replay.errors.join(','));
    assert.equal(sample.usefulSuccesses, 0, 'preparation and hook stdout cannot invent delivery or independent labels');
    assert.equal(sample.usefulUnknown, sample.attempted);
    assert.ok(sample.attempted >= 2, 'actual attempts must remain in the sample denominator');
    sampled += sample.attempted;
    writeFileSync(join(evidenceDir, `${client}-${port}-sample.json`), JSON.stringify({ census, exported, sample, replay }));
    retainIsolatedWorkerProgress(evidenceDir, 'packing-sample-complete', { client, port, attempted: sample.attempted });
  }
  await stopPrivateOperatorHost(host); host = undefined;
  console.log('CONTEXT_INJECTION_HTTP_RECEIPT ' + JSON.stringify({ workspace, bundleSha256, health,
    routes, nativeDispatchers, sampled, sampleReplayVerified: true, emissionClaimed: false,
    independentLabelsClaimed: false, hostStopped: true }));
}
try { await main(); }
catch (error) { console.error('CONTEXT_INJECTION_HTTP_FAILURE', error); process.exitCode = 1; }
finally { if (host) await stopPrivateOperatorHost(host); await getOrgPg().sql.end({ timeout: 1 }); }
