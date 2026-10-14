/** Disposable native-device HTTPS acceptance, inside with-test-pg's operator-api profile.
 * Reuses the maintained protected listener and own-tunnel provisioning/removal contract.
 * node scripts/with-test-pg.mjs --isolated-runtime=operator-api -- node --import tsx
 *   packages/operator-core/lib/native-device-fixture.ts <private evidence dir> <cert.pem> [seconds]
 * The receipt is public-safe; pair-payload.json is private input and is removed on exit.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareApi, type CloudflareApi } from './own-tunnel/cloudflare-api';
import { assertPort, parseArgoTunnelCert, tunnelCnameTarget } from './own-tunnel/config';
import { provisionCloudflareTunnel, removeCloudflareTunnel, type RemovalTarget } from './own-tunnel/provision';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export function fixtureIdentity(env: NodeJS.ProcessEnv) {
  assert(/^test-runtime-[a-zA-Z0-9-]+$/.test(env.PAPERCUSP_WORKSPACE_ID ?? ''), 'Disposable workspace required');
  for (const key of ['PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_DBOS_ROUTINES'])
    assert.equal(env[key], '0', `${key} must be disabled`);
  assert.equal(env.PAPERCUSP_POT_HOME_SLUG, env.PAPERCUSP_WORKSPACE_ID, 'Disposable install identity required');
  assert.equal(env.PAPERCUSP_ALLOW_REMOTE_ADMIN, undefined, 'Remote admin must not be enabled');
  assert(env.HOME && env.PAPERCUSP_HOME && env.PAPERCUSP_SKIP_PG_DISCOVERY === '1', 'Private HOME and PG required');
  const base = new URL(env.PAPERCUSP_OPERATOR_URL ?? '');
  assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.pathname === '/', 'Private loopback operator required');
  const ingressPort = assertPort(Number(env.PAPERCUSP_EXTERNAL_INGRESS_PORT));
  assert(ingressPort !== Number(base.port) && ![3070, 3170, 3055].includes(ingressPort), 'Separate protected ingress required');
  return { workspaceId: env.PAPERCUSP_WORKSPACE_ID!, base: base.origin, ingressPort };
}

export async function verifyProtectedIngress(base: string, doFetch: typeof fetch = fetch) {
  const statuses: Record<string, number> = {};
  for (const path of ['/api/health', '/api/workspaces', '/api/device/desktop/mint-pair-token']) {
    const response = await doFetch(base + path, {
      method: path.endsWith('mint-pair-token') ? 'POST' : 'GET',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      ...(path.endsWith('mint-pair-token') ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(5000),
    });
    statuses[path] = response.status;
    assert([401, 403, 404].includes(response.status), `Protected ingress exposed ${path}: HTTP ${response.status}`);
    await response.arrayBuffer();
  }
  const heartbeat = await doFetch(base + '/api/device/heartbeat', {
    method: 'POST', signal: AbortSignal.timeout(5000),
  });
  statuses['/api/device/heartbeat'] = heartbeat.status;
  assert.equal(heartbeat.status, 401, 'Device heartbeat must require a JWT');
  await heartbeat.arrayBuffer();
  return statuses;
}

/** Recover partially provisioned owned resources; never delete a tunnel/record by a loose prefix. */
export async function cleanupFixtureTunnel(api: CloudflareApi, target: RemovalTarget & { tunnelName: string }) {
  const tunnels = await api.listTunnelsByName(target.accountId, target.tunnelName);
  const owned = tunnels.filter(t => t.name === target.tunnelName && !t.deleted_at);
  assert(owned.length <= 1, 'Ambiguous fixture tunnel ownership');
  if (owned.length) {
    assert.equal(owned[0]!.id, target.tunnelId, 'Fixture tunnel identity changed');
    await removeCloudflareTunnel(api, target);
  }
  const remaining = await api.listDnsRecords(target.zoneId, target.hostname);
  assert(!remaining.some(r => r.type === 'CNAME' && r.content === tunnelCnameTarget(target.tunnelId)), 'Owned fixture DNS remains');
  const after = await api.listTunnelsByName(target.accountId, target.tunnelName);
  assert(!after.some(t => t.id === target.tunnelId && !t.deleted_at), 'Owned fixture tunnel remains');
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await new Promise<void>(done => child.once('exit', () => done()));
  clearTimeout(kill);
}

export async function runNativeDeviceFixture(evidencePath: string, certPath: string, seconds = 1800) {
  const identity = fixtureIdentity(process.env); // All preconditions precede any external write.
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'Bounded lifetime required');
  const evidence = resolve(evidencePath);
  assert(isAbsolute(evidencePath) && relative(ROOT, evidence).startsWith('..'), 'Evidence/private input must be outside the repository');
  const login = parseArgoTunnelCert(readFileSync(certPath, 'utf8'));
  assert(login, 'A maintained Cloudflare login certificate is required');
  const api = cloudflareApi({ apiToken: login.apiToken });
  const zone = await api.getZone(login.zoneId);
  assert.equal(zone.account?.id, login.accountId, 'Certificate zone/account mismatch');
  const runId = randomUUID();
  const tunnelName = 'native-iphone-fixture-' + runId;
  const hostname = 'native-iphone-' + runId + '.' + zone.name;
  assert.equal((await api.listDnsRecords(zone.id, hostname)).length, 0, 'Fixture hostname already exists');
  assert.equal((await api.listTunnelsByName(login.accountId, tunnelName)).length, 0, 'Fixture tunnel already exists');
  mkdirSync(evidence, { mode: 0o700 }); // Refuse an existing attempt; retain earlier evidence.
  const receipt: Record<string, unknown> = { schemaVersion: 1, runId, ...identity, hostname,
    publicBase: 'https://' + hostname, controlPid: process.pid, home: process.env.HOME,
    sourceSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    startedAt: new Date().toISOString(), ready: false, cleanupVerified: false,
    scope: 'Disposable public HTTPS fixture; no native UI, cloud relay or release acceptance claimed' };
  const save = () => writeFileSync(resolve(evidence, 'runtime.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  let host: ChildProcess | undefined, connector: ChildProcess | undefined;
  let removal: (RemovalTarget & { tunnelName: string }) | undefined;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const logs: number[] = [];
  const start = (command: string, args: string[], env: NodeJS.ProcessEnv, logName: string) => {
    const fd = openSync(resolve(evidence, logName), 'wx', 0o600); logs.push(fd);
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
    child.on('error', error => { receipt.processError = error.message; stopped = true; });
    return child;
  };
  try {
    save();
    host = start(process.execPath, ['--import', 'tsx', resolve(ROOT, 'apps/operator/bin/hono-host.ts')], {
      ...process.env, MOBILE_JWT_SECRET: randomBytes(48).toString('base64url'),
      MOBILE_DESKTOP_PUBLIC_URL: String(receipt.publicBase), MOBILE_DESKTOP_HOST: hostname,
    }, 'host.log');
    receipt.hostPid = host.pid;
    const readyBy = Date.now() + 180_000;
    for (;;) {
      assert(!stopped && host.exitCode === null && host.signalCode === null, 'Fixture host exited before readiness');
      try {
        const health = await fetch(identity.base + '/api/health', { signal: AbortSignal.timeout(2000) });
        const registry = await fetch(identity.base + '/api/workspaces', { signal: AbortSignal.timeout(2000) });
        const h = await health.json(), r = await registry.json();
        assert(h.ok === true && h.service === 'papercusp-operator', 'Unexpected private health');
        assert(r.current === identity.workspaceId && r.workspaces.length === 1 && r.workspaces[0].id === identity.workspaceId,
          'Private workspace registry mismatch');
        receipt.localBoundary = await verifyProtectedIngress('http://127.0.0.1:' + identity.ingressPort);
        break;
      } catch (error) {
        if (Date.now() >= readyBy) throw error;
        await delay(500);
      }
    }
    // Track creation immediately, including a later config/DNS/token failure.
    const trackedApi: CloudflareApi = { ...api, createTunnel: async (accountId, name) => {
      const tunnel = await api.createTunnel(accountId, name);
      removal = { accountId, zoneId: zone.id, tunnelId: tunnel.id, hostname, tunnelName };
      receipt.tunnelId = tunnel.id; save(); return tunnel;
    } };
    const provisioned = await provisionCloudflareTunnel(trackedApi, {
      accountId: login.accountId, zoneId: zone.id, hostname, tunnelName, ingressPort: identity.ingressPort,
    });
    removal = { ...removal!, dnsRecordId: provisioned.dnsRecordId };
    connector = start('cloudflared', ['tunnel', '--no-autoupdate', 'run'], {
      ...process.env, TUNNEL_TOKEN: provisioned.runToken,
    }, 'connector.log');
    receipt.connectorPid = connector.pid; save();
    const publicReadyBy = Date.now() + 120_000;
    for (;;) {
      assert(!stopped && connector.exitCode === null && connector.signalCode === null, 'Fixture connector exited');
      try { receipt.publicBoundary = await verifyProtectedIngress(String(receipt.publicBase)); break; }
      catch (error) { if (Date.now() >= publicReadyBy) throw error; await delay(1000); }
    }
    const minted = await fetch(identity.base + '/api/device/desktop/mint-pair-token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: identity.workspaceId }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(minted.status, 200, 'Private pairing mint failed');
    const { qrPayload } = await minted.json();
    assert(qrPayload.workspaceId === identity.workspaceId && qrPayload.server === receipt.publicBase,
      'Fresh QR must advertise the exact public endpoint');
    writeFileSync(resolve(evidence, 'pair-payload.json'), JSON.stringify(qrPayload), { mode: 0o600, flag: 'wx' });
    receipt.ready = true; receipt.readyAt = new Date().toISOString(); save();
    console.log('NATIVE_HTTPS_FIXTURE_READY=' + JSON.stringify({ receipt: resolve(evidence, 'runtime.json'),
      publicBase: receipt.publicBase, workspaceId: identity.workspaceId }));
    const until = Date.now() + seconds * 1000;
    while (!stopped && Date.now() < until && !existsSync(resolve(evidence, 'stop'))) {
      assert(host.exitCode === null && connector.exitCode === null && host.signalCode === null && connector.signalCode === null,
        'Owned fixture process exited');
      await delay(500);
    }
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await stopChild(connector); await stopChild(host);
    receipt.processCleanupVerified = (!host || !host.pid || host.exitCode !== null || host.signalCode !== null) &&
      (!connector || !connector.pid || connector.exitCode !== null || connector.signalCode !== null);
    try {
      if (removal) await cleanupFixtureTunnel(api, removal);
      receipt.cloudCleanupVerified = true;
    } catch (error) { receipt.cleanupError = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
    const input = resolve(evidence, 'pair-payload.json'); if (existsSync(input)) unlinkSync(input);
    for (const fd of logs) closeSync(fd);
    receipt.cleanupVerified = receipt.processCleanupVerified === true && receipt.cloudCleanupVerified === true;
    receipt.finishedAt = new Date().toISOString(); save();
    console.log('NATIVE_HTTPS_FIXTURE_TERMINAL=' + JSON.stringify({ ready: receipt.ready, cleanupVerified: receipt.cleanupVerified,
      error: receipt.error, cleanupError: receipt.cleanupError }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [evidence, cert, lifetime] = process.argv.slice(2);
  runNativeDeviceFixture(evidence ?? '', cert ?? '', lifetime ? Number(lifetime) : 1800).catch(error => {
    console.error('NATIVE_HTTPS_FIXTURE_PREFLIGHT_FAILED=' + error.message); process.exitCode = 1;
  });
}
