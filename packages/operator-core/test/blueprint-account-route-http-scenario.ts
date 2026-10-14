/** Real primary routing proof, composed inside the maintained private HTTP fixture. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { updateAccountPool } from '../lib/deployment/account-pool-store';
import { startGatewayService } from '../lib/inference-gateway/launch';
import { fireLaunchBlueprint } from '../lib/blueprint/launch-blueprint';
import { readProcessIdentity } from '../lib/process-identity';
import { harnessPackageDir, invokeOnceBin, tsxBin } from '../lib/harness-paths';

function descendants(rootPid: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* process exited during the measured snapshot */ }
  }
  const result = [rootPid];
  for (let i = 0; i < result.length; i++) for (const [pid, ppid] of parents) if (ppid === result[i]) result.push(pid);
  return result;
}

async function eventually<T>(read: () => Promise<T | null | undefined>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read(); if (value != null) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Private routing proof did not observe ${label}`);
}

export async function prepareBlueprintAccountRouteScenario(input: { workspace: string; evidenceDir: string }) {
  const { workspace, evidenceDir } = input;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  const e = process.env;
  delete e.PAPERCUSP_CODEX_GATEWAY;
  delete e.PAPERCUSP_ACCOUNT_ID;
  e.PAPERCUSP_MCP_PROXY = '0';
  // A private HOME has no development harness symlink. Select the maintained
  // checkout explicitly before the bundled host resolves its sibling invoke.
  const root = resolve(import.meta.dirname, '../../..');
  e.PAPERCUSP_HARNESS_DIR = realpathSync(join(root, 'libs/papercusp/packages/harness'));
  const runtimeInputs = { harness: harnessPackageDir(), invoke: invokeOnceBin(), tsx: tsxBin() };
  for (const [name, path] of Object.entries(runtimeInputs))
    assert.ok(existsSync(path), `private primary preflight requires ${name}: ${path}`);
  assert.ok(runtimeInputs.invoke.startsWith(join(root, 'libs/papercusp/packages/orchestrator/')),
    'primary proof must execute the selected checkout orchestrator');
  assert.ok(runtimeInputs.invoke.endsWith('.ts'), 'current-source proof must not use a stale packaged invoke bundle');
  const source = JSON.parse(readFileSync(e.FGR_R6_ACCOUNT_POOL_REFERENCE_FILE!, 'utf8'));
  assert.ok(source.accounts.length > 0, 'private pool requires real configured account references');
  await updateAccountPool(() => ({ accounts: source.accounts }), workspace);
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === workspace);
  assert.ok(home, 'private home harness missing');
  const project = join(evidenceDir, 'private-project');
  mkdirSync(join(project, '.papercusp'), { recursive: true });
  const prompt = join(project, '.papercusp', 'inert-release-fixer.md');
  writeFileSync(prompt, 'You are an inert routing fixture. Reply with the single word READY. Do not invoke any tool, execute a command, read a file, claim work, acquire a lock, edit files, or operate a release gate.');
  const config = { promptOverrides: { 'release-fixer': prompt }, timeouts: { 'release-fixer': 90 } };
  // invoke-once reads its maintained effective config from STATE_DIR/config.json.
  writeFileSync(join(project, '.papercusp', 'config.json'), JSON.stringify(config));
  assert.equal(JSON.parse(readFileSync(join(project, '.papercusp', 'config.json'), 'utf8'))
    .promptOverrides['release-fixer'], prompt);
  await saveHarnessRegistry({ ...registry, projects: registry.projects.map(entry => entry.slug === workspace
    ? { ...entry, path: project, configOverrides: { ...entry.configOverrides,
      ...config } } : entry) }, workspace);
  writeFileSync(join(evidenceDir, 'account-route-preflight.json'), JSON.stringify({ runtimeInputs,
    declared: { codexGatewayPresent: Object.hasOwn(e, 'PAPERCUSP_CODEX_GATEWAY'), account: 'auto' },
    prompt, config, observedAt: source.observedAt, accountIds: source.accounts.map((account: any) => account.id) }));
  console.log('BLUEPRINT_ACCOUNT_ROUTE_PHASE runtime-preflight-ready');
  const { sql } = getOrgPg();
  let spawnId: string | undefined;
  let stopped = false;
  let nativeProcesses: Array<{ pid: number; identity: ReturnType<typeof readProcessIdentity> }> = [];
  let upstream: { status: number; requests: number } | undefined;
  let requestCount = 0;
  let releaseResponse: (() => void) | undefined;
  const responseHeld = new Promise<void>(done => { releaseResponse = done; });
  let ready: (() => void) | undefined;
  const realResponseReady = new Promise<void>(done => { ready = done; });
  const gateway = await startGatewayService({ workspace, port: 0, refreshIntervalMs: 0,
    poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0, durableAdmission: false,
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/responses(?:\?|$)/, 'only the declared real first inference request is permitted');
      assert.equal(++requestCount, 1, 'bounded primary fixture permits exactly one real request');
      const response = await fetch(url, init);
      // Read the real body while withholding it from the native child. No mock response
      // or model completion can reach the child before its whole lineage is stopped.
      await response.clone().text();
      upstream = { status: response.status, requests: requestCount };
      ready!();
      await responseHeld;
      return response;
    },
  });
  e.PAPERCUSP_GATEWAY_PORT = String(gateway.port);
  async function measureNative() {
    assert.ok(spawnId);
    const [row] = await sql`SELECT pid, run_id FROM harness_shared.spawned_agents WHERE spawn_id=${spawnId}`;
    // A pending launch row names the initiating process, not an admitted child.
    if (!row?.pid || !String(row.run_id).startsWith('invoke-launch-')) return false;
    assert.notEqual(Number(row.pid), process.pid, 'never terminate the initiating fixture');
    nativeProcesses = descendants(Number(row.pid)).map(pid => ({ pid, identity: readProcessIdentity(pid) }));
    return true;
  }
  async function stopNative() {
    if (!spawnId || stopped) return;
    if (!nativeProcesses.length && !await measureNative()) return;
    for (const { pid, identity } of [...nativeProcesses].reverse()) {
      if (identity && readProcessIdentity(pid) === identity) try { process.kill(pid, 'SIGKILL'); } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await eventually(async () => nativeProcesses.every(({ pid, identity }) => !identity || readProcessIdentity(pid) !== identity)
      ? true : null, 'native lineage cleanup', 10_000);
    stopped = true;
  }
  return {
    async execute(stopInvokeHost: () => Promise<void>) {
      console.log('BLUEPRINT_ACCOUNT_ROUTE_PHASE launch-real-primary');
      const launched = await fireLaunchBlueprint('release-fix', { installSlug: workspace, workspaceId: workspace,
        kickoff: 'Inert routing proof: reply READY without tools.', timeoutMs: 90_000,
        bodyExtra: { account: 'auto', spawnBackend: 'codex', spawnModel: 'gpt-5.4:high' } });
      spawnId = launched.spawn?.spawnId ?? undefined;
      assert.ok(spawnId, 'production blueprint launcher must return its exact spawn identity');
      await Promise.race([realResponseReady, eventually(async () => {
        const [row] = await sql`SELECT status, error_message FROM harness_shared.spawned_agents WHERE spawn_id=${spawnId!}`;
        if (row?.status === 'failed') throw new Error(`Real primary launch failed before response: ${row.error_message}`);
        return null;
      }, 'real primary response', 100_000), new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('real first provider response timed out')), 100_000); timer.unref();
      })]);
      assert.equal(upstream?.status, 200, 'real upstream must accept and serve the request');
      assert.ok(await measureNative(), 'actual invoke handoff must precede the provider response');
      assert.ok(nativeProcesses.length > 1, 'real native descendant must exist');
      // Close the private invoke endpoint before killing its child. The real
      // launcher's no-turn fallback can no longer admit another native process.
      await stopInvokeHost();
      await stopNative();
      releaseResponse!();
      const row = await eventually(async () => {
        const [entry] = await sql`SELECT account_route, first_gateway_request FROM harness_shared.spawned_agents WHERE spawn_id=${spawnId!}`;
        return entry?.first_gateway_request ? entry : null;
      }, 'persisted exact first gateway request');
      const ownerReport = await (await fetch(`http://127.0.0.1:${gateway.port}/admin/owner-report?owner=${encodeURIComponent(spawnId)}`)).json() as any;
      const first = ownerReport.stageTelemetry.recent.find((entry: any) => entry.ownerId === spawnId);
      assert.ok(first, 'same gateway must report the same explicit owner');
      assert.equal(row.first_gateway_request.ownerId, spawnId);
      assert.equal(row.first_gateway_request.servingAccountId, first.cache.servingAccountId);
      assert.ok(row.account_route.resolvedAccountIds.includes(first.cache.servingAccountId));
      assert.equal(row.first_gateway_request.model, row.account_route.launchedModel);
      assert.equal(row.first_gateway_request.effort, row.account_route.launchedEffort);
      const [state] = await sql`SELECT count(*) AS claims FROM harness_shared.work_item_claims`;
      assert.equal(Number(state.claims), 0, 'private child must not claim work');
      return { workspace, spawnId, route: row.account_route, firstRequest: row.first_gateway_request,
        upstream, telemetry: { servingAccountId: first.cache.servingAccountId, requestId: first.requestId },
        childStopped: stopped, stoppedPids: nativeProcesses.map(({ pid }) => pid),
        responseDeliveredToChild: false, canonicalTreeReadOnly: true, privateMcp: true,
        gatewayRuntime: ownerReport.process,
        runtimeInputs,
        declared: { account: 'auto', backend: 'codex', model: 'gpt-5.4', effort: 'high', codexGatewayPresent: false },
        preflight: { observedAt: source.observedAt, headroom: source.headroom,
          accountIds: source.accounts.map((account: any) => account.id) } };
    },
    async dispose() {
      try { await stopNative(); }
      finally { releaseResponse!(); await gateway.stop(); }
    },
  };
}
