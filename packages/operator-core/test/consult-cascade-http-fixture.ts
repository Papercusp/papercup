/** Private operator-api worker; reuses the maintained builder and lifetime observer. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.CONSULT_CASCADE_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  const bundle = join(evidenceDir, 'hono-host.mjs');
  console.log('CONSULT_CASCADE_HTTP_PHASE bundle-start');
  try {
    const output = execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle],
      { cwd: root, env: e, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(evidenceDir, 'build.log'), output);
  } catch (error: any) {
    writeFileSync(join(evidenceDir, 'build.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  const bytes = readFileSync(bundle);
  assert.ok(bytes.includes(Buffer.from('makeDeferredConsultReachDispatcher')), 'executed bundle lacks deferred cascade adapter');
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  host = spawn(process.execPath, [bundle], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  let health: any;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'private host exited before readiness');
    assert.equal(host.signalCode, null, 'private host was signaled before readiness');
    try {
      const response = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(2000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* bounded readiness convergence */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.equal(health?.service, 'papercusp-operator');
  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
      body: JSON.stringify({ name, args, harness: workspace, callerSid: 'private-cascade-fixture' }),
      signal: AbortSignal.timeout(20_000) });
    const envelope = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const text = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data ?? envelope.result);
    assert.ok(!result.error, JSON.stringify(result));
    return result;
  }
  const identity = await call('coord:whoami', {});
  assert.equal(identity.workspaceId, workspace);
  assert.ok(identity.ownerId, 'HTTP actor identity required');
  const { sql } = getOrgPg();
  const lockKey = 741101;
  // Hold ONLY the background lease transition. The queued intent/post and
  // HTTP response must commit while this real production UPDATE waits.
  await sql.unsafe(`CREATE FUNCTION harness_shared.p011_hold_launch_lease() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.routing #>> '{cascadeDispatch,leaseToken}' IS NOT NULL
        AND OLD.routing #>> '{cascadeDispatch,leaseToken}' IS NULL THEN
        PERFORM pg_advisory_xact_lock(${lockKey});
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE TRIGGER p011_hold_launch_lease BEFORE UPDATE ON harness_shared.consult_state
    FOR EACH ROW EXECUTE FUNCTION harness_shared.p011_hold_launch_lease()`);
  console.log('CONSULT_CASCADE_HTTP_PHASE request-ready');
  const requests: Array<Record<string, unknown>> = [];
  for (const kind of ['reply', 'decline'] as const) {
    const id = `private-cascade-${kind}`;
    const thread = `thread-${id}`;
    const next = `private-untracked-${kind}`;
    await sql`INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, asker_id, body)
      VALUES (${workspace}, ${id}, 'consult', 'private-requester', 'Private acknowledgement control')`;
    await sql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref)
      VALUES (${workspace}, ${thread}, 'conversation', ${id})`;
    const selected = [identity.ownerId, next].map(ownerId => ({ ownerId, via: 'floor', score: 0.9, similarity: 0.8 }));
    await sql`INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question, routing, expires_at)
      VALUES (${workspace}, ${id}, 'private-requester', ${identity.ownerId}, 'awaiting_responder',
        'Private acknowledgement control', ${sql.json({ selection: { min: 1, selected } })}, now() + interval '10 minutes')`;
    const hold = await sql.reserve();
    try {
      await hold`BEGIN`;
      await hold`SELECT pg_advisory_xact_lock(${lockKey})`;
      const args = kind === 'reply' ? { conversation_id: id, kind: 'new_fact', body: 'Exact private fact' }
        : { conversation_id: id, reason: 'Different subsystem' };
      const result = await call(`consult:${kind}`, args);
      writeFileSync(join(evidenceDir, `${kind}.json`), JSON.stringify({ base, identity, result }));
      assert.ok(Number.isInteger(result.post_id), JSON.stringify(result));
      assert.equal(result.cascade?.pending, true, JSON.stringify(result));
      assert.equal(result.cascade?.advanced_to, next, JSON.stringify(result));
      assert.equal(result.cascade?.woke, 0, JSON.stringify(result));
      let waiting = false;
      for (const stop = Date.now() + 5000; Date.now() < stop;) {
        const rows = await sql`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
          AND objid = ${lockKey}::oid AND NOT granted`;
        if (rows.length) { waiting = true; break; }
        await new Promise(done => setTimeout(done, 25));
      }
      assert.ok(waiting, 'production continuation did not reach the held lease');
      const [row] = await sql`SELECT cascade_cursor, routing, dispatch_attempts FROM harness_shared.consult_state
        WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
      assert.equal(row.cascade_cursor, 1);
      assert.equal(row.routing.cascadeDispatch.responder, next);
      assert.equal(row.routing.cascadeDispatch.leaseToken, null);
      assert.deepEqual(row.dispatch_attempts, []);
      const posts = await sql`SELECT post_id FROM harness_shared.consult_post_meta
        WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
      assert.deepEqual(posts.map(post => Number(post.post_id)), [result.post_id]);
      await hold`ROLLBACK`;
      let completed: any;
      for (const stop = Date.now() + 10_000; Date.now() < stop;) {
        const [after] = await sql`SELECT routing, dispatch_attempts FROM harness_shared.consult_state
          WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
        if (!after.routing.cascadeDispatch && after.dispatch_attempts.length) { completed = after; break; }
        await new Promise(done => setTimeout(done, 25));
      }
      assert.ok(completed, 'released production continuation never recorded its refusal');
      assert.ok(completed.dispatch_attempts.every((attempt: any) => attempt.dispatched === false));
      assert.ok(completed.dispatch_attempts.every((attempt: any) => attempt.attempts.length === 0));
      requests.push({ kind, pending: true, leaseWaitObserved: waiting, persistedPosts: posts.length,
        postId: result.post_id, afterRelease: 'no-launch-refusal' });
    } finally {
      await hold`ROLLBACK`.catch(() => {});
      hold.release();
    }
  }
  await stopHost();
  console.log('CONSULT_CASCADE_HTTP_RECEIPT ' + JSON.stringify({ workspace, identity,
    hostPid: host.pid, hostStopped: true, bundleSha256, health, requests }));
}

try { await main(); }
catch (error) {
  const failure = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('CONSULT_CASCADE_HTTP_FAILURE ' + JSON.stringify({ message: failure.message ?? String(error),
    stack: failure.stack, actual: failure.actual, expected: failure.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await getOrgPg().sql.end({ timeout: 1 });
}
