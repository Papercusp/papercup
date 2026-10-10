/** Private HTTP/native acceptance fixture, launched by its registered integration suite. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getAdvSessionInWorkspace, markAdvSessionEnded, recordAdvSession } from '../lib/adv-sessions';
import { preparePortalBrowserSource, preparePrivateHttpWorkspaces } from './private-http-workspace-preflight';
import { verifyPrivateCoordReceipt } from './private-coord-receipt';

const root = resolve(import.meta.dirname, '../../..');
const evidence = process.env.ROSTER_STOP_HTTP_EVIDENCE_DIR!;
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const base = process.env.PAPERCUSP_OPERATOR_URL!;
assert.match(workspace, /^test-runtime-/);
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
assert.ok(evidence);
const portalSourceRoot = process.env.ROSTER_COORD_BROWSER_PROOF === '1' || process.env.ROSTER_STOP_BROWSER_PROOF === '1'
  ? preparePortalBrowserSource(process.argv) : undefined;
// Evidence paths are intentionally long; AF_UNIX addresses are bounded by bytes.
// Keep the mutable socket namespace short and retain its identity in the receipt.
const discovery = mkdtempSync(join(tmpdir(), 'rs-'));
assert.ok(Buffer.byteLength(join(discovery, 'su-rs-123456789-neighbor.sock')) < 104,
  'private socket directory exceeds the native address limit');
writeFileSync(join(evidence, 'discovery.json'), JSON.stringify({ discovery }));
process.env.PAPERCUSP_PSU_PTY_DIR = discovery;
process.env.PAPERCUSP_TURN_PROVENANCE_DIR = join(evidence, 'turn-provenance');
const { socketPathFor, metaPathFor, encodeControl } = await import('../../../apps/operator/scripts/psu-pty-host.mjs');
const { shutdownViaPty } = await import('../lib/events/await/psu-pty-discovery');
const { sql } = getOrgPg();
const sessions: Array<{ owner: string; id: number; startedAt: string; done: Promise<number>; closed: boolean; output: () => string }> = [];
let api: ChildProcess | undefined;
const endings: Promise<unknown>[] = [];

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`roster stop fixture timeout: ${label}`);
}

async function child(label: string) {
  const owner = `su-rs-${process.pid}-${label}`;
  const id = await recordAdvSession({ workspaceId: workspace, mode: 'console', agent: 'codex', role: 'su', coordOwnerId: owner });
  assert.ok(id);
  const row = await getAdvSessionInWorkspace(id, workspace);
  assert.ok(row);
  let output = '';
  const session = { owner, id, startedAt: row.startedAt, closed: false, output: () => output, done: Promise.resolve(0) };
  const host = spawn(process.execPath, [join(root, 'packages/operator-core/test/psu-pty-host-canary.mjs'), owner, String(id)], {
    cwd: evidence, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', PAPERCUSP_PSU_PTY_DIR: discovery,
      PAPERCUSP_TURN_PROVENANCE_DIR: join(evidence, 'turn-provenance'),
      PAPERCUSP_SID: owner, PAPERCUSP_LAUNCHED_BY: 'su-private-roster-acceptance' },
  });
  host.stdout!.on('data', chunk => { output += String(chunk); });
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  session.done = new Promise((done, reject) => {
    host.once('error', reject);
    host.once('close', (code, osSignal) => {
      session.closed = true;
      const line = output.split('\n').find(value => value.startsWith('ROSTER_CANARY_EXIT '));
      const signal = line ? JSON.parse(line.slice('ROSTER_CANARY_EXIT '.length)).signal : osSignal;
      endings.push(markAdvSessionEnded(id, code, signal ? 'signal' : 'self', { signal, throwOnError: true }));
      done(code ?? 1);
    });
  });
  sessions.push(session);
  await until(() => existsSync(socketPathFor(owner)) && existsSync(metaPathFor(owner)), `${label} host ready`);
  const metadata = JSON.parse(readFileSync(metaPathFor(owner), 'utf8'));
  assert.equal(metadata.pid, host.pid, 'discovery must identify its dedicated PSU host');
  return session;
}

async function responds(session: typeof sessions[number], marker: string) {
  assert.equal(session.closed, false, `${session.owner} must remain alive`);
  let ack = '';
  await new Promise<void>((done, reject) => {
    const socket = net.connect(socketPathFor(session.owner), () => {
      socket.end(encodeControl({ mode: 'raw', data: marker + '\n', ownerId: session.owner }));
    });
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error('private canary socket timeout')); });
    // Reading the reply puts the stream in flowing mode; otherwise close can
    // remain blocked behind the unread ACK (the maintained native helper's contract).
    socket.setEncoding('utf8');
    socket.on('data', value => { ack += value; });
    socket.once('error', reject); socket.once('close', () => done());
  });
  assert.equal(JSON.parse(ack.trim().split('\n')[0]).ok, true, 'private canary raw control ACK');
  await until(() => session.output().includes(`ECHO:${marker}`), `${session.owner} reply`);
}

async function quiet(session: typeof sessions[number]) {
  await until(() => {
    assert.equal(session.closed, false, 'canary must survive until the stop request');
    const metadata = JSON.parse(readFileSync(metaPathFor(session.owner), 'utf8'));
    return Number(metadata.lastOutputAt) > 0 && Date.now() - Number(metadata.lastOutputAt) >= 1_500;
  }, `${session.owner} native output quiet`);
}

async function request(payload: Record<string, unknown>) {
  const response = await fetch(base + '/api/adv/sessions/close-window', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Exercise the real cookie principal and persisted inbox without touching a live agent. */
async function coordCanary(health: unknown) {
  const { signup, login, getSessionUser, SESSION_COOKIE } = await import('../lib/auth');
  const { getMessageById, readInbox } = await import('../lib/agent-tools/coordination/messages');
  const selected = `su-coord-${process.pid}-selected`;
  const neighbor = `su-coord-${process.pid}-neighbor`;
  const foreign = `su-coord-${process.pid}-foreign`;
  const stale = `su-coord-${process.pid}-stale`;
  const foreignWorkspace = workspace + '-foreign';
  for (const [owner, scope] of [[selected, workspace], [neighbor, workspace], [foreign, foreignWorkspace], [stale, workspace]]) {
    const id = await recordAdvSession({ workspaceId: scope, mode: 'console', agent: 'codex', role: 'su', coordOwnerId: owner });
    assert.ok(id);
    if (owner === stale) await markAdvSessionEnded(id, 0, 'self', { throwOnError: true });
  }
  const username = `coord_${process.pid}`;
  await signup(username, 'Private roster canary', null);
  const ownSession = await login(username, null, { workspace_id: workspace });
  const foreignSession = await login(username, null, { workspace_id: foreignWorkspace });
  const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;
  const ownPrincipal = await getSessionUser(new Headers({ cookie: cookie(ownSession.token) }));
  assert.equal(ownPrincipal?.workspace_id, workspace);
  const marker = `private-coord-${process.pid}`;
  const receipts: Array<{ status: number; body: any }> = [];
  const post = async (to: string[], wake = false, overrides: Record<string, string> = {}) => {
    const response = await fetch(base + '/api/admin/coord/send', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: cookie(ownSession.token),
        'x-papercusp-workspace': foreignWorkspace, ...overrides },
      body: JSON.stringify({ to, summary: marker, body: [{ text: marker }], expects: 'none',
        ...(wake ? { wake: 'required' } : {}) }), signal: AbortSignal.timeout(25_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const verifyReceipt = (receipt: { status: number; body: any }, expectedOwner: string, wake: boolean, summary = marker) =>
    verifyPrivateCoordReceipt(receipt, { ownerId: expectedOwner, summary, wake }, getMessageById);
  if (process.env.ROSTER_COORD_BROWSER_PROOF === '1') {
    const { runPortalRosterBrowser } = await import('./portal-roster-browser-fixture');
    const receipt = await runPortalRosterBrowser({ evidence, base, workspace, selected, neighbor, portalSourceRoot: portalSourceRoot!,
      cookieName: SESSION_COOKIE, ownToken: ownSession.token, foreignToken: foreignSession.token,
      verifyReceipt: (value, summary, wake) => verifyReceipt(value, selected, wake, summary) });
    console.log('ROSTER_COORD_BROWSER_RECEIPT ' + JSON.stringify({ ...receipt, health,
      apiBundleSha256: createHash('sha256').update(readFileSync(join(evidence, 'hono-host.mjs'))).digest('hex') }));
    return;
  }
  for (const wake of [false, true]) {
    const accepted = await post([selected], wake);
    receipts.push(accepted);
    const msgId = await verifyReceipt(accepted, selected, wake);
    // Positive control: a successful response attributed to the neighbor must fail.
    await assert.rejects(() => verifyReceipt(accepted, neighbor, wake), /selected-recipient receipt correlation/);
    const inbox = await readInbox(selected, {}, { enough: entries => entries.length >= 20 });
    assert.ok(inbox.some(message => message.msg_id === msgId), 'selected inbox must contain the returned message');
  }
  const selectedIds = receipts.map(receipt => receipt.body.results[0].msg_id);
  assert.equal(new Set(selectedIds).size, 2);
  const beforeDenials = (await readInbox(selected, {}, { enough: entries => entries.length >= 20 })).filter(message => message.summary === marker).map(message => message.msg_id).sort();
  const denied = [
    await post([foreign]), await post([selected, foreign]), await post([stale]),
    await post([selected], false, { cookie: cookie(foreignSession.token), 'x-papercusp-workspace': workspace }),
    await post([selected], false, { origin: 'https://unapproved.invalid' }),
  ];
  assert.deepEqual(denied.map(receipt => receipt.status), [403, 403, 403, 403, 403]);
  const afterDenials = (await readInbox(selected, {}, { enough: entries => entries.length >= 20 })).filter(message => message.summary === marker).map(message => message.msg_id).sort();
  assert.deepEqual(afterDenials, beforeDenials, 'denied requests must not persist a partial delivery');
  for (const owner of [neighbor, foreign, stale]) {
    assert.equal((await readInbox(owner, {}, { enough: entries => entries.length >= 20 })).some(message => message.summary === marker), false,
      `${owner} must not receive the private marker`);
  }
  // Tokens are deliberately absent from retained evidence.
  console.log('ROSTER_COORD_HTTP_RECEIPT ' + JSON.stringify({ workspace, health,
    bundleSha256: createHash('sha256').update(readFileSync(join(evidence, 'hono-host.mjs'))).digest('hex'),
    authenticatedUser: ownPrincipal?.id, authMethod: 'cookie-session', selected, neighbor, foreign, stale,
    selectedMessageIds: selectedIds, receipts, denialStatuses: denied.map(receipt => receipt.status),
    neighborIsolated: true, positiveControl: 'wrong-recipient rejected',
    pickupScope: 'persisted message and synchronous wake receipt only; no parked-agent turn attested' }));
}

async function main() {
  if (process.env.ROSTER_COORD_BROWSER_PROOF === '1' || process.env.ROSTER_STOP_BROWSER_PROOF === '1') {
    // Use the existing static-serving seam on this private API origin. No
    // cross-origin transport, API response interception or local-mode identity.
    process.env.PAPERCUSP_SPA_DIST = join(evidence, 'portal-roster-spa');
  }
  if (process.env.ROSTER_COORD_HTTP_PROOF === '1' || process.env.ROSTER_STOP_BROWSER_PROOF === '1') {
    const prepared = preparePrivateHttpWorkspaces();
    assert.equal(prepared.workspace, workspace);
    console.log('ROSTER_STOP_HTTP_PHASE registry-ready');
  }
  const bundle = join(evidence, 'hono-host.mjs');
  console.log('ROSTER_STOP_HTTP_PHASE bundle-start');
  try { execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }); }
  catch (error: any) { writeFileSync(join(evidence, 'build.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
  const log = (chunk: Buffer) => process.stdout.write(chunk);
  api = spawn(process.execPath, [bundle], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout!.on('data', log); api.stderr!.on('data', log);
  let health: any;
  await until(async () => {
    assert.equal(api!.exitCode, null, 'private API exited');
    try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { health = await response.json(); return health.service === 'papercusp-operator'; } }
    catch { /* bounded boot convergence only */ }
    return false;
  }, 'private API readiness', 90_000);
  console.log('ROSTER_STOP_HTTP_PHASE request-ready');
  if (process.env.ROSTER_COORD_HTTP_PROOF === '1') {
    await coordCanary(health);
    return;
  }
  const selected = await child('selected');
  const neighbor = await child('neighbor');
  if (process.env.ROSTER_STOP_BROWSER_PROOF === '1') {
    const { signup, login, getSessionUser, SESSION_COOKIE } = await import('../lib/auth');
    const username = `stop_${process.pid}`;
    await signup(username, 'Private confirmed stop canary', null);
    const ownSession = await login(username, null, { workspace_id: workspace });
    const foreignSession = await login(username, null, { workspace_id: workspace + '-foreign' });
    assert.equal((await getSessionUser(new Headers({ cookie: `${SESSION_COOKIE}=${ownSession.token}` })))?.workspace_id, workspace);
    const { runPortalRosterBrowser } = await import('./portal-roster-browser-fixture');
    let aliveProbe = 0;
    let neighborProbe = 0;
    const receipt = await runPortalRosterBrowser({ evidence, base, workspace, selected: selected.owner, neighbor: neighbor.owner,
      portalSourceRoot: portalSourceRoot!, cookieName: SESSION_COOKIE, ownToken: ownSession.token, foreignToken: foreignSession.token,
      stop: { selected, neighbor,
        assertChildrenAlive: async () => {
          aliveProbe++;
          await responds(selected, `selected-before-confirmed-stop-${aliveProbe}`);
          await responds(neighbor, `neighbor-before-confirmed-stop-${aliveProbe}`);
          await Promise.all([quiet(selected), quiet(neighbor)]);
        },
        assertSelectedStopped: async () => {
          await until(() => selected.closed, 'browser selected child stopped');
          await selected.done; await Promise.all(endings);
          assert.ok((await getAdvSessionInWorkspace(selected.id, workspace))?.endedAt);
          assert.equal(existsSync(socketPathFor(selected.owner)), false);
          await responds(neighbor, 'neighbor-after-browser-selected-stop');
        },
        assertNeighborAlive: async () => {
          await responds(neighbor, `neighbor-after-browser-control-${++neighborProbe}`);
          await quiet(neighbor);
        },
        invalidateNeighborLaunch: async () => {
          await sql`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${neighbor.id}`;
          assert.notEqual((await getAdvSessionInWorkspace(neighbor.id, workspace))?.startedAt, neighbor.startedAt);
        },
      } });
    console.log('ROSTER_STOP_BROWSER_RECEIPT ' + JSON.stringify({ ...receipt, health,
      apiBundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') }));
    return;
  }
  const valid = { ownerId: selected.owner, managedSessionId: selected.id, expectedStartedAt: selected.startedAt, confirmed: true };
  const foreignId = await recordAdvSession({ workspaceId: workspace + '-foreign', mode: 'console', agent: 'codex', coordOwnerId: 'su-private-foreign' });
  assert.ok(foreignId);
  const denied = [
    await request({ ...valid, confirmed: false }),
    await request({ ...valid, managedSessionId: neighbor.id }),
    await request({ ...valid, ownerId: 'su-private-foreign', managedSessionId: foreignId }),
    await request({ ...valid, pid: process.pid }),
    await request({ ...valid, expectedStartedAt: '2000-01-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(denied.map(value => value.status), [400, 403, 403, 400, 403]);
  await responds(selected, 'selected-after-denials');
  await responds(neighbor, 'neighbor-after-denials');
  // Reactivation can reuse a row id. Replay must fail against changed launch time.
  await sql`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${neighbor.id}`;
  const replay = await request({ ownerId: neighbor.owner, managedSessionId: neighbor.id,
    expectedStartedAt: neighbor.startedAt, confirmed: true });
  assert.equal(replay.status, 403);
  await responds(neighbor, 'neighbor-after-reactivation-replay');
  const currentNeighbor = await getAdvSessionInWorkspace(neighbor.id, workspace);
  assert.ok(currentNeighbor);
  // ECHO output must settle before exercising the existing supported idle stop.
  await Promise.all([quiet(selected), quiet(neighbor)]);
  const misroute = process.env.ROSTER_STOP_HTTP_MUTATION === 'misroute';
  const accepted = await request(misroute ? { ownerId: neighbor.owner, managedSessionId: neighbor.id,
    expectedStartedAt: currentNeighbor.startedAt, confirmed: true } : valid);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.body.managedSessionId, selected.id, 'selected-session receipt correlation');
  await until(() => selected.closed, 'selected child stopped');
  await selected.done;
  await Promise.all(endings);
  assert.ok((await getAdvSessionInWorkspace(selected.id, workspace))?.endedAt);
  assert.equal(existsSync(socketPathFor(selected.owner)), false);
  await responds(neighbor, 'neighbor-after-selected-stop');
  console.log('ROSTER_STOP_HTTP_RECEIPT ' + JSON.stringify({ workspace, health,
    bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    selected: { owner: selected.owner, id: selected.id, ended: selected.closed },
    neighbor: { owner: neighbor.owner, id: neighbor.id, alive: !neighbor.closed }, denied, replay, accepted }));
}

try { await main(); }
catch (error: any) { console.error('ROSTER_STOP_HTTP_FAILURE ' + JSON.stringify({ message: error.message, stack: error.stack })); process.exitCode = 1; }
finally {
  for (const session of sessions) if (!session.closed) await shutdownViaPty(session.owner, { reason: 'Private acceptance cleanup', force: true });
  await Promise.all(sessions.map(session => session.done));
  await Promise.all(endings);
  if (api?.exitCode === null && api.signalCode === null) {
    const closed = new Promise<void>(done => api!.once('close', () => done()));
    api.kill('SIGTERM');
    const timer = setTimeout(() => api!.kill('SIGKILL'), 5_000);
    await closed; clearTimeout(timer);
  }
  await sql.end({ timeout: 5 });
  rmSync(discovery, { recursive: true });
  console.log('ROSTER_STOP_HTTP_CLEANUP ' + JSON.stringify({ childrenStopped: sessions.every(session => session.closed), apiStopped: !api || api.exitCode !== null || api.signalCode !== null }));
}
