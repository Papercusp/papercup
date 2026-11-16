/** Real HTTP/MCP and git-sync composition, always under with-test-pg isolation. */
import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { handler } from '../../../apps/operator/bin/host-handler';
import { createMcpProxy, readMcpWorkerTargets } from '../../../apps/operator/lib/mcp-proxy/proxy';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { writeEndpointIpcDiscovery } from '../lib/endpoint-ipc-discovery';
import { readSuperuserToken, superuserTokenPath } from '../lib/superuser-token';
import { getServingHostIdentity } from '../lib/serving-host-identity';
import { readProcessIdentity } from '../lib/process-identity';
import { runEmbedSidecarServer } from '../lib/memory/embed-sidecar-server';
import { registerGitSyncResource } from '../lib/harness/git-sync/git-sync-action';
import { inWorkspaceTxn } from '../lib/agent-tools/locks/in-workspace-txn';
import { registerAwait, listActiveAwaits } from '../lib/events/await/store';
import { emitAwaitedEvent } from '../lib/events/await/engine';

const root = process.env.FRICTION_SOURCE_ROOT!;
assert.ok(root, 'explicit source root required for the bundled private fixture');
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const workerMode = process.argv.includes('--worker');
const releaseScenario = process.env.FRICTION_RELEASE_CONTINUATION === '1';
const metadataScenario = process.argv.includes('--metadata-repair');
const privateRoot = dirname(process.env.HOME!);
assert.match(workspace, /^test-runtime-/);
assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
const servers: Server[] = [];
const phase = (stage: string) => console.log('FRICTION_WORKER_PHASE ' + JSON.stringify({ stage, workerMode, pid: process.pid }));
const requestOptions = { timeout: 30_000, maxTotalTimeout: 30_000, resetTimeoutOnProgress: false };
const listen = (server: Server) => new Promise<number>((done, reject) => {
  servers.push(server); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port));
});
const closeServers = async () => {
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
};
const stopWorker = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  phase('worker-stop-start');
  let timer: ReturnType<typeof setTimeout>;
  const stopped = new Promise<void>((done, reject) => {
    child.once('close', () => done());
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('private worker did not close after SIGTERM'));
    }, 15_000);
  });
  child.kill('SIGTERM');
  try { await stopped; } finally { clearTimeout(timer!); }
  phase('worker-stop-complete');
};
const parse = (result: any) => {
  const block = result.content?.find((entry: any) => entry.type === 'text' && entry.text.trim().startsWith('{'));
  assert.ok(block, JSON.stringify(result));
  return JSON.parse(block.text);
};

export async function runGitSyncTargetWorkerFixture() {
  if (workerMode) {
    assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
    // This fixture composes the side-effect-free request handler, so it owns
    // the listener lifecycle that the production host bootstrap normally owns.
    process.once('SIGTERM', () => {
      phase('worker-shutdown');
      void closeServers().then(async () => {
        await getOrgPg().sql.end({ timeout: 5 });
        await _resetForTests();
        process.exit(0);
      }).catch(error => { console.error('FRICTION_WORKER_FAILURE', error); process.exit(1); });
    });
    const port = await listen(createServer(getRequestListener(handler)));
    await writeEndpointIpcDiscovery(join(process.env.PAPERCUSP_HOME!, 'private-worker.sock'), { port });
    const descriptor = JSON.parse(readFileSync(join(process.env.PAPERCUSP_HOME!, `endpoint-ipc.${port}.json`), 'utf8'));
    assert.equal(descriptor.processRole, 'bg-host');
    assert.equal(descriptor.port, port);
    assert.equal(descriptor.pid, process.pid);
    assert.equal(descriptor.executionProcessId, readProcessIdentity(process.pid));
    assert.ok(descriptor.executionTarget?.buildSha);
    process.send?.({ kind: 'worker-ready', port, target: descriptor.executionTarget, pid: process.pid,
      identity: descriptor.executionProcessId });
    return;
  }
  // The maintained background runtime enables explicit work, with global
  // routines disabled. This side-effect-free HTTP handler is the request-only
  // control; the separate child below retains the background role.
  process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
  const token = randomUUID();
  mkdirSync(dirname(superuserTokenPath()), { recursive: true });
  writeFileSync(superuserTokenPath(), token, { mode: 0o600 });
  assert.equal(readSuperuserToken(), token);
  const slug = 'friction-private-repository';
  const repository = join(privateRoot, 'git-sync-repository');
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  // Fixture-only git setup. The product action performs the measured commit.
  git('init', '-b', 'staging'); git('config', 'user.name', 'Private acceptance');
  git('config', 'user.email', 'private-acceptance@example.invalid');
  writeFileSync(join(repository, 'payload.txt'), 'initial\n');
  if (metadataScenario) {
    mkdirSync(join(repository, 'packages/member'), { recursive: true });
    const manifest = { name: 'private-worker-metadata', version: '1.0.0', private: true,
      workspaces: ['packages/*'] };
    writeFileSync(join(repository, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(repository, 'packages/member/package.json'),
      JSON.stringify({ name: 'private-worker-member', version: '2.0.0' }));
    writeFileSync(join(repository, 'package-lock.json'), JSON.stringify({ name: manifest.name,
      version: manifest.version, lockfileVersion: 3, packages: { '': manifest,
        'packages/member': { version: '1.0.0' },
        'node_modules/private-worker-member': { resolved: 'packages/member', link: true } } }));
  }
  git('add', '--all'); git('commit', '-m', 'private fixture initial state');
  const remote = join(privateRoot, 'origin.git');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '--set-upstream', 'origin', 'staging');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(repository, 'payload.txt'), 'measured private mutation\n');
  const pendingLock = metadataScenario ? readFileSync(join(repository, 'package-lock.json')) : undefined;
  const repairMetadata = pendingLock ? { base: before,
    expectedPendingLockSha256: createHash('sha256').update(pendingLock).digest('hex'),
    requestId: 'private-worker-metadata-repair', generation: 1, publishedLibrarySelections: [] } : undefined;
  const mutation = { installSlug: slug, ...(repairMetadata ? { repairMetadata } : {}) };
  const otherRepository = join(privateRoot, 'non-target-repository');
  mkdirSync(otherRepository);
  const otherGit = (...args: string[]) => execFileSync('git', ['-C', otherRepository, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  otherGit('init', '-b', 'staging');
  otherGit('config', 'user.name', 'Private acceptance');
  otherGit('config', 'user.email', 'private-acceptance@example.invalid');
  writeFileSync(join(otherRepository, 'payload.txt'), 'non-target initial\n');
  otherGit('add', 'payload.txt'); otherGit('commit', '-m', 'non-target fixture initial state');
  const otherBefore = otherGit('rev-parse', 'HEAD');
  writeFileSync(join(otherRepository, 'payload.txt'), 'non-target dirty state\n');
  const otherStatus = otherGit('status', '--porcelain');
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug, path: repository, hive_slug: workspace },
    { slug: `${slug}-non-target`, path: otherRepository, hive_slug: workspace }] }, workspace);
  phase('private-repository-ready');
  let child: ChildProcess | undefined;
  const clients: Client[] = [];
  let scenarioFailure: unknown;
  try {
    const requestPort = await listen(createServer(getRequestListener(handler)));
    child = fork(import.meta.filename, ['--worker'], { cwd: root, execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_BACKGROUND_WORKERS: '1', PAPERCUSP_SERVING_BUILD: 'staging' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout!.on('data', data => process.stdout.write(data));
    child.stderr!.on('data', data => process.stderr.write(data));
    const ready = await new Promise<any>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('private worker readiness deadline')), 60_000);
      child!.on('message', (message: any) => { if (message.kind === 'worker-ready') { clearTimeout(timer); done(message); } });
      child!.once('error', error => { clearTimeout(timer); reject(error); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); });
    });
    phase('background-worker-ready');
    assert.ok(ready.identity, 'the private worker must report its actual process identity');
    assert.equal(readProcessIdentity(ready.pid), ready.identity);
    const discovered = () => readMcpWorkerTargets(process.env.PAPERCUSP_HOME!);
    assert.equal(discovered().filter(worker => worker.port === ready.port).length, 1);
    const proxyPort = await listen(createMcpProxy({ listenPort: 0, targetPort: requestPort,
      resolveWorkerTargets: discovered, retryWindowMs: 100, retryBackoffMs: 5, log: () => {} }));
    const connect = async (port: number) => {
      phase(`initialize-start:${port}`);
      const client = new Client({ name: 'private-friction-acceptance', version: '1' });
      clients.push(client);
      const query = new URLSearchParams({ superuser: '1', client: 'friction-private-acceptance', workspace, harness: slug, format: 'json', profile: 'engineer' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp?${query}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }), requestOptions);
      phase(`initialize-complete:${port}`);
      const catalog = await client.listTools(undefined, requestOptions);
      if (metadataScenario) {
        const tool = catalog.tools.find(entry => entry.name === 'git-sync:run');
        assert.ok(tool?.inputSchema.properties?.repairMetadata, 'loaded worker catalog must expose metadata repair');
        assert.ok(tool.inputSchema.properties.target, 'loaded worker catalog must expose the exact target');
      }
      phase(`catalog-complete:${port}`);
      return client;
    };
    const direct = await connect(requestPort);
    phase('request-only-start');
    const requestOnly = parse(await direct.callTool({ name: 'git-sync:run', arguments: { installSlug: slug } }, undefined, requestOptions));
    assert.equal(requestOnly.reason, 'request-only-host', JSON.stringify(requestOnly));
    assert.equal(git('rev-parse', 'HEAD'), before);
    phase('request-only-refused');
    const client = await connect(proxyPort);
    phase('preview-start');
    const preview = parse(await client.callTool({ name: 'git-sync:run', arguments: { ...mutation, target: ready.target, dryRun: true } }, undefined, requestOptions));
    assert.equal(preview.fired, false);
    if (repairMetadata) assert.deepEqual(preview.repair_metadata, repairMetadata);
    assert.equal(git('rev-parse', 'HEAD'), before);
    phase('preview-complete');
    const wrong = await fetch(`http://127.0.0.1:${proxyPort}/api/mcp`, { method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'git-sync:run', arguments: { ...mutation, target: { ...ready.target, buildSha: '0'.repeat(40) } } } }) });
    assert.equal(wrong.status, 503);
    const principal = await fetch(`http://127.0.0.1:${proxyPort}/api/mcp`, { method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'tools:invoke', arguments: { name: 'git-sync:run', args: { ...mutation, target: ready.target }, authenticatedPrincipal: {} } } }) });
    assert.equal(principal.status, 400);
    assert.equal(git('rev-parse', 'HEAD'), before);
    let releaseContinuation: Record<string, unknown> | undefined;
    if (releaseScenario) {
    // Register only this disposable harness's resource. Acquisition and release
    // go through the real MCP handlers in the private runtime.
    const resource = `git-sync:${slug}`;
    await inWorkspaceTxn(workspace, 'friction-private-setup', tx =>
      registerGitSyncResource(tx as Parameters<typeof registerGitSyncResource>[0], slug));
    const lease = parse(await client.callTool({ name: 'locks:acquire_resource', arguments: {
      resource, mode: 'exclusive', reason: 'private release-continuation acceptance', ttl_sec: 300,
      wait: { max_drain_sec: 0 },
    } }, undefined, requestOptions));
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.ok(lease.lock_id, JSON.stringify(lease));
    const blocked = parse(await client.callTool({ name: 'git-sync:run', arguments: {
      installSlug: slug, target: ready.target,
    } }, undefined, requestOptions));
    assert.equal(blocked.outcome?.reason, 'held_exclusive', JSON.stringify(blocked));
    assert.equal(git('rev-parse', 'HEAD'), before, 'a blocked fire must not commit');
    const holder = blocked.outcome.holders.find((entry: any) => entry.lock_id === lease.lock_id);
    assert.ok(holder, JSON.stringify(blocked));
    const acquiredAtMs = Date.parse(holder.acquired_ts);
    assert.ok(Number.isFinite(acquiredAtMs));
    const completion = blocked.continuation.completion_event;
    assert.equal(completion.key, `resource:released:${resource}`);
    assert.deepEqual(completion.payload_filter, { all: [
      { resource: { equals: resource } }, { workspaceId: { equals: workspace } },
      { releasedAtMs: { gte: acquiredAtMs } },
    ] });
    const subscriberId = 'friction-private-release';
    const waiting = await registerAwait({ subscriberId, eventKey: completion.key,
      policy: 'notify', once: true, timeoutSec: 60, timeoutBehavior: 'expire',
      payloadFilter: completion.payload_filter });
    // A delayed old release uses the real event engine and migrated await store.
    // Its timestamp must not consume the continuation for the current lease.
    const stale = await emitAwaitedEvent({ key: completion.key, workspaceId: workspace,
      source: 'resource-locks', payload: { resource, workspaceId: workspace, releasedAtMs: acquiredAtMs - 1 } });
    assert.equal(stale.latchRecorded, true);
    assert.equal(stale.waiters, 0, JSON.stringify(stale));
    assert.ok((await listActiveAwaits(subscriberId)).some(row => row.id === waiting.id));
    assert.equal(git('rev-parse', 'HEAD'), before);
    phase('stale-release-rejected');
    const release = parse(await client.callTool({ name: 'locks:release_resource', arguments: {
      lock_id: lease.lock_id,
    } }, undefined, requestOptions));
    assert.equal(release.ok, true, JSON.stringify(release));
    assert.equal(release.results[0]?.released, 1, JSON.stringify(release));
    const deadline = Date.now() + 30_000;
    let released: any;
    while (Date.now() < deadline) {
      const rows = await getOrgPg().sql`
        SELECT fired_at, fired_reason, fired_payload FROM harness_shared.event_awaits WHERE id = ${waiting.id}
      `;
      released = rows[0];
      if (released?.fired_at) break;
      await delay(25);
    }
    assert.equal(released?.fired_reason, 'event', JSON.stringify(released));
    assert.equal(released.fired_payload.resource, resource);
    assert.equal(released.fired_payload.workspaceId, workspace);
    assert.ok(released.fired_payload.releasedAtMs >= acquiredAtMs, JSON.stringify(released));
    assert.equal((await listActiveAwaits(subscriberId)).length, 0);
    phase('real-release-consumed');
    releaseContinuation = { resource, lockId: lease.lock_id, acquiredAtMs,
      staleReleaseRejected: true, actualReleaseConsumed: true,
      releasedAtMs: released.fired_payload.releasedAtMs, awaitId: waiting.id };
    }
    if (repairMetadata) {
      const stale = parse(await client.callTool({ name: 'git-sync:run', arguments: { ...mutation,
        repairMetadata: { ...repairMetadata, expectedPendingLockSha256: '0'.repeat(64) }, target: ready.target,
      } }, undefined, requestOptions));
      assert.equal(stale.status, 'error', JSON.stringify(stale));
      assert.ok(stale.outcome.errors.some((error: any) => error.message === 'generated-lock-request-pending-mismatch'), JSON.stringify(stale));
      assert.equal(git('rev-parse', 'HEAD'), before, 'stale metadata input must not commit');
      assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/papercusp/source-custody'), '',
        'stale metadata input must not capture a candidate');
      assert.deepEqual(readFileSync(join(repository, 'package-lock.json')), pendingLock);
      phase('stale-pending-refused');
    }
    phase('mutation-start');
    const result = parse(await client.callTool({ name: 'git-sync:run', arguments: { ...mutation, target: ready.target } }, undefined,
      { timeout: 60_000, maxTotalTimeout: 60_000, resetTimeoutOnProgress: false }));
    phase('mutation-returned');
    const after = git('rev-parse', 'HEAD');
    assert.equal(result.fired, true, JSON.stringify(result));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.status, metadataScenario ? 'committed' : 'synced', JSON.stringify(result));
    assert.notEqual(after, before, JSON.stringify(result));
    assert.equal(git('rev-list', '--count', `${before}..${after}`), '1', 'one request creates exactly one expected commit');
    let metadataRepair: Record<string, unknown> | undefined;
    if (repairMetadata) {
      const proof = result.outcome.metadataRepair;
      assert.equal(proof.commit, after, JSON.stringify(result));
      assert.equal(proof.base, before);
      assert.equal(proof.publication, 'committed');
      assert.equal(proof.remoteEgressConfirmed, false);
      assert.deepEqual(result.outcome.pushed, []);
      assert.deepEqual(proof.paths, ['package-lock.json']);
      assert.equal(proof.sourceFingerprint.schemaVersion, 2);
      assert.deepEqual(proof.sourceFingerprint.publishedLibrarySelections, []);
      assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', before, after), 'package-lock.json');
      const lock = JSON.parse(git('show', 'HEAD:package-lock.json'));
      assert.equal(lock.packages['packages/member'].version, '2.0.0');
      assert.deepEqual(lock.packages['node_modules/private-worker-member'], { resolved: 'packages/member', link: true });
      assert.equal(git('show', 'HEAD:payload.txt'), 'initial');
      assert.equal(readFileSync(join(repository, 'payload.txt'), 'utf8'), 'measured private mutation\n');
      assert.deepEqual(readFileSync(join(repository, 'package-lock.json')), pendingLock,
        'the metadata publication must preserve the caller pending lock');
      assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/staging'), before,
        'metadata publication must not push');
      const replay = parse(await client.callTool({ name: 'git-sync:run', arguments: { ...mutation, target: ready.target } }, undefined,
        { timeout: 60_000, maxTotalTimeout: 60_000, resetTimeoutOnProgress: false }));
      assert.equal(replay.outcome.metadataRepair.publication, 'already-published', JSON.stringify(replay));
      assert.equal(replay.outcome.metadataRepair.commit, after);
      assert.equal(replay.outcome.committedCount, 0);
      assert.deepEqual(replay.outcome.pushed, []);
      assert.equal(git('rev-parse', 'HEAD'), after, 'replay must not create another commit');
      assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/staging'), before);
      assert.deepEqual(readFileSync(join(repository, 'package-lock.json')), pendingLock);
      assert.equal(readFileSync(join(repository, 'payload.txt'), 'utf8'), 'measured private mutation\n');
      metadataRepair = { ...proof, stalePendingRefused: true, lockMemberVersion: lock.packages['packages/member'].version,
        pendingLockPreserved: true, unrelatedPendingPreserved: true,
        replayPublication: replay.outcome.metadataRepair.publication, replayCommittedCount: replay.outcome.committedCount };
      phase('metadata-repair-verified');
    } else {
      assert.equal(git('show', 'HEAD:payload.txt'), 'measured private mutation');
      assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/staging'), after);
    }
    assert.equal(otherGit('rev-parse', 'HEAD'), otherBefore, 'non-target ref must not move');
    assert.equal(otherGit('status', '--porcelain'), otherStatus, 'non-target dirty state must remain unchanged');
    assert.equal(readFileSync(join(otherRepository, 'payload.txt'), 'utf8'), 'non-target dirty state\n');
    phase('mutation-verified');
    for (const client of clients.splice(0)) await client.close();
    phase('clients-closed');
    await stopWorker(child);
    assert.equal(child.exitCode, 0, 'private worker must shut down gracefully');
    assert.equal(readProcessIdentity(ready.pid), null);
    console.log('FRICTION_WORKER_RECEIPT ' + JSON.stringify({ workspace, runtimeRoot: privateRoot,
      target: ready.target, worker: { pid: ready.pid, identity: ready.identity },
      before, after, committed: true, wrongTargetDispatched: false, principalDispatched: false,
      requestOnlyRefused: true, workerStopped: true, resultStatus: result.status,
      remoteConfirmed: !metadataScenario, nonTargetUnchanged: true, commits: 1,
      ...(metadataRepair ? { metadataRepair, remoteUnchanged: true } : {}),
      ...(releaseContinuation ? { releaseContinuation } : {}),
      sourceHost: getServingHostIdentity() }));
  } catch (error) {
    scenarioFailure = error;
    throw error;
  } finally {
    try {
      for (const client of clients) await client.close();
      if (child?.exitCode === null && child.signalCode === null) {
        await stopWorker(child);
      }
      await closeServers();
      await getOrgPg().sql.end({ timeout: 5 });
      await _resetForTests();
    } catch (cleanupFailure) {
      if (scenarioFailure !== undefined) {
        throw new AggregateError([scenarioFailure, cleanupFailure],
          `Private git-sync scenario failed: ${String(scenarioFailure)}; cleanup failed: ${String(cleanupFailure)}`);
      }
      throw cleanupFailure;
    }
  }
}
// The maintained embedding client re-executes its containing bundle. Honor
// that production entry contract instead of re-entering fixture setup.
if (process.env.PAPERCUSP_EMBED_SIDECAR_MODE === '1') runEmbedSidecarServer();
else if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  runGitSyncTargetWorkerFixture().then(() => { if (!workerMode) process.exit(0); }).catch(error => {
    console.error('FRICTION_WORKER_FAILURE', error); process.exit(1);
  });
}
