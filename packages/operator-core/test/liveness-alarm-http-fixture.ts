/** Real request-worker alarm lifecycle in the maintained private operator profile. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { writeSharedSnapshot } from '../lib/derived-reads/shared-snapshot';
import { createPrivateHealthSnapshot } from './private-http-workspace-preflight';
import type { AgentStrandHealth } from '../lib/system-health/agent-strand-census';
import type { CoordinationHealth } from '../lib/system-health/types';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private alarm host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.LIVENESS_ALARM_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  const sources = ['packages/operator-core/lib/system-health/liveness-alarm.ts',
    'packages/operator-core/lib/system-health/agent-strand-census.ts',
    'packages/operator-core/lib/system-health/compute.ts',
    'packages/operator-core/lib/derived-reads/shared-snapshot.ts',
    'packages/operator-core/lib/agent-tools/coordination/escalations.ts',
    'apps/operator/bin/hono-host.ts'];
  const fingerprint = () => Object.fromEntries(sources.map(path => [path,
    createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const sourceBefore = fingerprint();
  const bundle = join(evidenceDir, 'hono-host.mjs');
  console.log('LIVENESS_ALARM_HTTP_PHASE bundle-start');
  try {
    const output = execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle],
      { cwd: root, env: e, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(evidenceDir, 'build.log'), output);
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    writeFileSync(join(evidenceDir, 'build.log'), String(failure.stdout ?? '') + String(failure.stderr ?? ''));
    throw error;
  }
  const bytes = readFileSync(bundle);
  assert.ok(bytes.includes(Buffer.from('system-health/liveness-alarm.ts')), 'alarm missing from executed artifact');
  assert.ok(bytes.includes(Buffer.from('agentStrandObservation')), 'runtime observation missing from executed artifact');
  assert.deepEqual(fingerprint(), sourceBefore, 'source moved while building the tested artifact');
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  const headers = { origin: base, 'x-papercusp-workspace': workspace };
  // Only the existing interval knob changes: dedup and production dependencies
  // remain default. The supervisor owns a private DB, HOME, workspace and ports.
  const intervalMs = 500;
  async function startHost() {
    host = spawn(process.execPath, [bundle], { cwd: root,
      env: { ...e, PAPERCUSP_INFRA_LIVENESS_ALARM: '1', PAPERCUSP_INFRA_LIVENESS_ALARM_MS: String(intervalMs) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', chunk => process.stdout.write(chunk));
    host.stderr!.on('data', chunk => process.stderr.write(chunk));
    hostIdentity = readProcessIdentity(host.pid!);
    assert.ok(hostIdentity, 'private host kernel identity required');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      assert.equal(host.exitCode, null, 'private host exited before readiness');
      assert.equal(host.signalCode, null, 'private host was signaled before readiness');
      try {
        const response = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          const health = await response.json();
          assert.equal(health.service, 'papercusp-operator');
          assert.ok(health.sha, 'loaded bundle identity is required');
          return { pid: host.pid!, identity: hostIdentity, health };
        }
      } catch { /* bounded readiness convergence only */ }
      await new Promise(done => setTimeout(done, 250));
    }
    throw new Error('private alarm operator never became ready');
  }
  const { sql } = getOrgPg();
  async function snapshot(wedged: number | null) {
    const at = Date.now();
    const health = createPrivateHealthSnapshot(workspace, false, at);
    const strand: AgentStrandHealth = { checked: wedged ?? 0, wedged: wedged ?? 0,
      wedgedByClass: { 'auth-blocked': 0, 'quota-blocked': wedged ?? 0, 'unbound-successor': 0, 'pending-turn-stuck': 0 },
      wedgedSample: [], stranded: 0, strandedSample: [], wedgedUnreadable: wedged === null, strandedUnreadable: false };
    health.panels.coordination.status = 'warn';
    health.panels.coordination.data = { agentStrand: strand } as CoordinationHealth;
    await writeSharedSnapshot('system.health', workspace, health, 1);
    return at;
  }
  const raises = async () => (await sql`SELECT body FROM harness_shared.coord_event_log
    WHERE workspace_id = ${workspace} AND surface = 'escalations'
      AND body->>'from' = 'system:infra-liveness-alarm' AND body->>'livenessSignature' = 'agents-wedged'
    ORDER BY ts`).map(row => row.body);
  const resolutions = async (id: string) => (await sql`SELECT body FROM harness_shared.coord_event_log
    WHERE workspace_id = ${workspace} AND surface = 'escalations'
      AND body->>'kind' = 'escalation_resolved' AND body->>'related_msg_id' = ${id}
    ORDER BY ts`).map(row => row.body);
  async function until<T>(name: string, read: () => Promise<T>, ready: (value: T) => boolean) {
    const deadline = Date.now() + 30_000;
    let value: T;
    do {
      assert.equal(host!.exitCode, null, 'alarm worker exited during ' + name);
      value = await read();
      if (ready(value)) return value;
      await new Promise(done => setTimeout(done, intervalMs));
    } while (Date.now() < deadline);
    throw new Error(name + ' did not converge: ' + JSON.stringify(value!));
  }
  async function standing(id: string) {
    const rows = await sql`SELECT body FROM harness_shared.coord_open_escalations
      WHERE workspace_id = ${workspace} AND body->>'msg_id' = ${id}`;
    assert.equal(rows.length, 1, 'threshold alarm must remain durably open');
    assert.equal((await resolutions(id)).length, 0, 'absence of evidence cannot resolve a standing alarm');
    assert.equal((await raises()).length, 1, 'one threshold episode must have one alarm');
  }
  const thresholdAt = await snapshot(10);
  const first = await startHost();
  console.log('LIVENESS_ALARM_HTTP_PHASE threshold-worker-ready');
  const raised = (await until('threshold alarm', raises, rows => rows.length === 1))[0];
  assert.match(raised.body, /Signal: agents-wedged/);
  assert.equal(raised.agentStrandObservation.wedged, 10);
  assert.equal(raised.agentStrandObservation.snapshotAtMs, thresholdAt);
  assert.equal(raised.agentStrandObservation.thresholds.wedged, 10);
  assert.equal(raised.agentStrandObservation.runtime.pid, first.pid);
  assert.equal(raised.agentStrandObservation.runtime.sha, first.health.sha);
  await new Promise(done => setTimeout(done, intervalMs * 4));
  await standing(raised.msg_id);
  await stopHost();
  const second = await startHost();
  assert.notEqual(second.identity, first.identity, 'restart must exercise a new worker lifetime');
  await new Promise(done => setTimeout(done, intervalMs * 4));
  await standing(raised.msg_id);
  console.log('LIVENESS_ALARM_HTTP_PHASE restart-dedup-verified');
  await snapshot(null);
  await new Promise(done => setTimeout(done, intervalMs * 4));
  await standing(raised.msg_id);
  await snapshot(9);
  const recovered = (await until('measured below-threshold recovery', () => resolutions(raised.msg_id), rows => rows.length === 1))[0];
  assert.equal(recovered.choice, 'auto-resolved');
  assert.match(recovered.note, /wedged=9/);
  assert.match(recovered.note, /alarm threshold >= 10/);
  assert.doesNotMatch(recovered.note, /no per-signature evidence/);
  assert.equal((await raises()).length, 1);
  assert.deepEqual(fingerprint(), sourceBefore, 'source changed during the live journey');
  await stopHost();
  console.log('LIVENESS_ALARM_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true,
    threshold: 10, belowThreshold: 9, alarmCount: 1, restartDedupCount: 1,
    unknownPreserved: true, sourceUnchanged: true, sourceFingerprints: sourceBefore,
    bundleSha256, intervalMs, first, second, raised, recovered }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('LIVENESS_ALARM_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await getOrgPg().sql.end({ timeout: 1 });
}
