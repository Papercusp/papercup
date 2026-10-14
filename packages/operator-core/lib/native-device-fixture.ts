/** Disposable native-device HTTPS acceptance, inside with-test-pg's operator-api profile.
 * Reuses the maintained protected listener and own-tunnel provisioning/removal contract.
 * node scripts/with-test-pg.mjs --isolated-runtime=operator-api -- node --import tsx
 *   packages/operator-core/lib/native-device-fixture.ts <private evidence dir> <cert.pem> [seconds]
 * The receipt is public-safe; pair-payload.json is private input and is removed on exit.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Resolver, resolve4, resolveNs } from 'node:dns/promises';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareApi, type CloudflareApi, type CloudflareZone } from './own-tunnel/cloudflare-api';
import { assertPort, parseArgoTunnelCert, tunnelCnameTarget } from './own-tunnel/config';
import { provisionCloudflareTunnel, removeCloudflareTunnel, type RemovalTarget } from './own-tunnel/provision';
import { isCliEntry } from './util/cli-entry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export function fixtureFailure(error: unknown) {
  const detail = error instanceof Error ? error : new Error(String(error));
  const code = (value: unknown) => value && typeof value === 'object' && 'code' in value
    ? String(value.code) : undefined;
  return { message: detail.message, code: code(detail),
    causeCode: code(detail.cause), causeMessage: detail.cause instanceof Error ? detail.cause.message : undefined };
}

export async function verifyFixtureZone(zone: CloudflareZone, readNs = resolveNs) {
  assert(zone.status === 'active' && zone.paused === false, 'Fixture requires an active unpaused DNS zone');
  assert(zone.name_servers?.length, 'Fixture zone must name authoritative servers');
  const delegated = await readNs(zone.name);
  const normalized = (names: ReadonlyArray<string>) => names.map(n => n.toLowerCase().replace(/\.$/, '')).sort();
  assert.deepEqual(normalized(delegated), normalized(zone.name_servers), 'Fixture DNS delegation mismatch');
}

/** Do not poison a recursive resolver with NXDOMAIN before the new record is published. */
export async function waitForFixtureDns(hostname: string, nameservers: ReadonlyArray<string>, options: {
  read?: () => Promise<string[]>; pause?: () => Promise<void>; now?: () => number;
  onFailure?: (error: unknown) => void;
} = {}) {
  const now = options.now ?? Date.now;
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  if (!options.read) resolver.setServers((await Promise.all(nameservers.map(ns => resolve4(ns)))).flat());
  const read = options.read ?? (() => resolver.resolve4(hostname));
  const deadline = now() + 120_000;
  for (;;) {
    try {
      const addresses = await read();
      assert(addresses.length > 0, 'Authoritative DNS has no fixture address');
      return addresses;
    } catch (error) {
      options.onFailure?.(error);
      if (now() >= deadline) throw error;
      await (options.pause ?? (() => delay(1000)))();
    }
  }
}

export function fixtureIdentity(env: NodeJS.ProcessEnv) {
  assert(/^test-runtime-[a-zA-Z0-9-]+$/.test(env.PAPERCUSP_WORKSPACE_ID ?? ''), 'Disposable workspace required');
  for (const key of ['PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_DBOS_ROUTINES'])
    assert.equal(env[key], '0', `${key} must be disabled`);
  assert.equal(env.PAPERCUSP_POT_HOME_SLUG, env.PAPERCUSP_WORKSPACE_ID, 'Disposable install identity required');
  assert.equal(env.PAPERCUSP_ALLOW_REMOTE_ADMIN, undefined, 'Remote admin must not be enabled');
  assert(env.HOME && env.PAPERCUSP_HOME && env.PAPERCUSP_SKIP_PG_DISCOVERY === '1', 'Private HOME and PG required');
  const base = new URL(env.PAPERCUSP_OPERATOR_URL ?? '');
  assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.pathname === '/', 'Private loopback operator required');
  assert.equal(env.PAPERCUSP_HONO_PORT, base.port, 'Private child operator port must match');
  const pgPort = assertPort(Number(env.PAPERCUSP_PG_PORT));
  assert(pgPort !== 5432, 'Owned isolated Postgres required');
  const pg = new URL(env.PAPERCUSP_TEST_PG_ADMIN_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(pg.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(pg.hostname) &&
    pg.port === String(pgPort) && pg.username && pg.pathname.slice(1), 'Maintained isolated-runtime Postgres receipt required');
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

/** Stop the exact owned operator, retain its private DB/signing identity, then replace it. */
export async function interruptFixtureHost(child: ChildProcess, restart: () => Promise<ChildProcess>,
  seconds: number, record: (value: Record<string, unknown>) => void,
  env = process.env, pause = delay) {
  fixtureIdentity(env);
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 120, 'Bounded operator interruption required');
  assert(child.pid && child.exitCode === null && child.signalCode === null, 'Owned operator must be live');
  const stoppedPid = child.pid;
  await stopChild(child);
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned operator must exit before recovery');
  record({ stoppedPid, stoppedAt: new Date().toISOString(), exitCode: child.exitCode, signal: child.signalCode });
  await pause(seconds * 1000);
  const restored = await restart();
  assert(restored.pid && restored.pid !== stoppedPid && restored.exitCode === null && restored.signalCode === null,
    'Recovery must start a different live operator process');
  record({ restoredPid: restored.pid, restoredAt: new Date().toISOString() });
  return restored;
}

/** Expire only an unused token in this request-only fixture's private database. */
export async function expireFixturePair(pairToken: string, workspaceId: string, env = process.env) {
  const identity = fixtureIdentity(env);
  assert.equal(workspaceId, identity.workspaceId, 'Pair token must belong to this fixture');
  assert(pairToken.length > 0, 'Pair token is required');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const expiresAt = Date.now() - 1000;
  const rows = await sql`UPDATE harness_shared.mobile_pair_tokens SET expires_at_ms = ${expiresAt}
    WHERE pair_token = ${pairToken} AND workspace_id = ${workspaceId} AND consumed = false
    RETURNING expires_at_ms`;
  assert.equal(rows.length, 1, 'Exactly one unused owned pairing token must expire');
  assert.equal(Number(rows[0]!.expires_at_ms), expiresAt);
  return expiresAt;
}

export async function runNativeDeviceFixture(evidencePath: string, certPath: string, seconds = 1800,
  interruptionSeconds = Number(process.env.PAPERCUSP_NATIVE_OFFLINE_SECONDS ?? '0')) {
  const identity = fixtureIdentity(process.env); // All preconditions precede any external write.
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'Bounded lifetime required');
  assert(interruptionSeconds === 0 || (Number.isInteger(interruptionSeconds) && interruptionSeconds >= 30 &&
    interruptionSeconds <= 120), 'Offline fixture interval must be 30 to 120 seconds');
  const evidence = resolve(evidencePath);
  assert(isAbsolute(evidencePath) && relative(ROOT, evidence).startsWith('..'), 'Evidence/private input must be outside the repository');
  const login = parseArgoTunnelCert(readFileSync(certPath, 'utf8'));
  assert(login, 'A maintained Cloudflare login certificate is required');
  const api = cloudflareApi({ apiToken: login.apiToken });
  const zone = await api.getZone(login.zoneId);
  assert.equal(zone.account?.id, login.accountId, 'Certificate zone/account mismatch');
  await verifyFixtureZone(zone); // Fail closed before creating external resources.
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
    const hostEnv = {
      ...process.env, MOBILE_JWT_SECRET: randomBytes(48).toString('base64url'),
      MOBILE_DESKTOP_PUBLIC_URL: String(receipt.publicBase), MOBILE_DESKTOP_HOST: hostname,
    };
    const startHost = (log: string) => start(process.execPath,
      ['--import', 'tsx', resolve(ROOT, 'apps/operator/bin/hono-host.ts')], hostEnv, log);
    host = startHost('host.log');
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
        receipt.localLastFailure = fixtureFailure(error); save();
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
    receipt.authoritativeAddresses = await waitForFixtureDns(hostname, zone.name_servers!, {
      onFailure: error => { receipt.dnsLastFailure = fixtureFailure(error); save(); },
    });
    receipt.dnsPublishedAt = new Date().toISOString(); save();
    const publicReadyBy = Date.now() + 120_000;
    for (;;) {
      assert(!stopped && connector.exitCode === null && connector.signalCode === null, 'Fixture connector exited');
      try { receipt.publicBoundary = await verifyProtectedIngress(String(receipt.publicBase)); break; }
      catch (error) {
        receipt.publicLastFailure = fixtureFailure(error); save();
        if (Date.now() >= publicReadyBy) throw error;
        await delay(1000);
      }
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
    const expiryMint = await fetch(identity.base + '/api/device/desktop/mint-pair-token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: identity.workspaceId }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(expiryMint.status, 200, 'Private expiry pairing mint failed');
    const expiredPayload = (await expiryMint.json()).qrPayload;
    assert(expiredPayload?.workspaceId === identity.workspaceId && expiredPayload.server === receipt.publicBase &&
      typeof expiredPayload.pairToken === 'string' && expiredPayload.pairToken !== qrPayload.pairToken,
      'Expiry probe must use a separate owned token');
    const expiresAt = await expireFixturePair(expiredPayload.pairToken, identity.workspaceId);
    const refusal = await fetch(String(receipt.publicBase) + '/api/device/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: expiredPayload.pairToken }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(refusal.status, 401, 'Real public backend must refuse the expired pairing token');
    await refusal.arrayBuffer();
    writeFileSync(resolve(evidence, 'expired-pair-payload.json'), JSON.stringify(expiredPayload),
      { mode: 0o600, flag: 'wx' });
    receipt.pairExpiry = { expiresAt, refusalStatus: refusal.status, separateFreshControl: true };
    receipt.ready = true; receipt.readyAt = new Date().toISOString(); save();
    console.log('NATIVE_HTTPS_FIXTURE_READY=' + JSON.stringify({ receipt: resolve(evidence, 'runtime.json'),
      publicBase: receipt.publicBase, workspaceId: identity.workspaceId }));
    const until = Date.now() + seconds * 1000;
    let interruptionDone = false;
    while (!stopped && Date.now() < until && !existsSync(resolve(evidence, 'stop'))) {
      assert(host.exitCode === null && connector.exitCode === null && host.signalCode === null && connector.signalCode === null,
        'Owned fixture process exited');
      if (interruptionSeconds && !interruptionDone) {
        const { listDevices } = await import('./device-store');
        const devices = await listDevices(identity.workspaceId);
        assert(devices.length <= 1, 'Offline acceptance requires exactly one owned phone');
        if (devices.length === 1 && devices[0]!.last_seen) {
          // Let the visible authorized read finish before disconnecting. The
          // native case then waits on actual UI outcomes, not this timer.
          receipt.interruption = { pairedDeviceCount: 1, heartbeatBeforeStop: true,
            seconds: interruptionSeconds, requestedAt: new Date().toISOString() }; save();
          await delay(15_000);
          host = await interruptFixtureHost(host, async () => startHost('restored-host.log'),
            interruptionSeconds, value => {
              Object.assign(receipt.interruption as object, value); save();
            });
          receipt.hostPid = host.pid;
          const recoveryBy = Date.now() + 120_000;
          for (;;) {
            assert(host.exitCode === null && host.signalCode === null, 'Restored operator exited');
            try {
              const health = await fetch(identity.base + '/api/health', { signal: AbortSignal.timeout(2000) });
              assert((await health.json()).ok === true, 'Restored operator health failed');
              receipt.restoredPublicBoundary = await verifyProtectedIngress(String(receipt.publicBase));
              const after = await listDevices(identity.workspaceId);
              assert(after.length === 1 && after[0]!.device_id === devices[0]!.device_id,
                'Recovery must preserve the original paired phone');
              Object.assign(receipt.interruption as object, { readyAt: new Date().toISOString(),
                originalDevicePreserved: true }); save();
              break;
            } catch (error) {
              receipt.recoveryLastFailure = fixtureFailure(error); save();
              if (Date.now() >= recoveryBy) throw error;
              await delay(1000);
            }
          }
          interruptionDone = true;
        }
      }
      await delay(500);
    }
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    receipt.failure = fixtureFailure(error);
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
    for (const name of ['pair-payload.json', 'expired-pair-payload.json']) {
      const input = resolve(evidence, name); if (existsSync(input)) unlinkSync(input);
    }
    for (const fd of logs) closeSync(fd);
    receipt.cleanupVerified = receipt.processCleanupVerified === true && receipt.cloudCleanupVerified === true;
    receipt.finishedAt = new Date().toISOString(); save();
    console.log('NATIVE_HTTPS_FIXTURE_TERMINAL=' + JSON.stringify({ ready: receipt.ready, cleanupVerified: receipt.cleanupVerified,
      error: receipt.error, cleanupError: receipt.cleanupError }));
  }
}

if (isCliEntry(import.meta.url)) {
  const [evidence, cert, lifetime, offlineSeconds] = process.argv.slice(2);
  runNativeDeviceFixture(evidence ?? '', cert ?? '', lifetime ? Number(lifetime) : 1800,
    offlineSeconds === undefined ? undefined : Number(offlineSeconds)).catch(error => {
    console.error('NATIVE_HTTPS_FIXTURE_PREFLIGHT_FAILED=' + error.message); process.exitCode = 1;
  });
}
