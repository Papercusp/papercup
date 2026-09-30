/**
 * Connect an app on a LOCAL install (external-app-access-to-workspaces-2026-09-29 P-005).
 *
 * R-9: a device-code sign-in approved on the local server issues a scoped connected-app key with
 * no portal involved. The routes run for real (the real `isLoopbackHost` local gate, the real
 * scope resolver and key minting); only persistence is an in-memory store with the SQL store's
 * semantics (hash-only grants, single consumption). `fetch` is replaced by a spy that fails the
 * test if anything reaches for the network — the "no portal involved" half of R-9.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createConnectedAppRoutes, LOCAL_OWNER_EMAIL } from './index';
import { DEFAULT_CLIENT_LABEL } from '../hosted-cli';
import { isLoopbackHost } from '../device/_shared';
import { resolveAppKeyScopes, type AppKeyRow, type AppKeyScopes, type CreatedAppKey } from '../../../connected-apps/store';
import { mintAppKey, parseAppKey, hashAppKey } from '../../../connected-apps/key';
import type { DeviceGrantStore, PendingDeviceGrant } from '../../../connected-apps/device-grants';

const LOCAL = 'http://127.0.0.1:3070';
const KNOWN_TOOLS = new Map([
  ['plans:list', { name: 'plans:list', capabilities: ['plans:read'], crossWorkspace: false }],
  ['work_items:get', { name: 'work_items:get', capabilities: ['work_items:read'], crossWorkspace: false }],
  ['capability:bash', { name: 'capability:bash', capabilities: ['capability:bash'], crossWorkspace: false }],
]) as never;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

interface IssuedRecord { workspaceId: string; userEmail: string; label: string; scopes: AppKeyScopes; tokenHash: string }

function appRow(id: string, workspaceId: string, userEmail: string, label: string, scopes: AppKeyScopes): AppKeyRow {
  return {
    id, user_email: userEmail, workspace_id: workspaceId, kind: 'app', label, scopes, limits: {},
    paired_at: new Date(), expires_at: null, paused_at: null, revoked_at: null, last_seen: null, last_ip: null,
    spend_cap_cents: null, spend_cap_window_sec: null, rotated_at: null, previous_token_valid_until: null, client_auth: null,
  };
}

/** In-memory grant store with PostgresDeviceGrantStore's semantics. */
function memoryGrants(issued: IssuedRecord[]) {
  type G = PendingDeviceGrant & { state: string; workspaceId: string | null; approvedBy: string | null; lastPolledAt: Date | null };
  const grants = new Map<string, G>();
  const store: DeviceGrantStore = {
    async createGrant(input) {
      if ([...grants.values()].some((g) => g.state === 'pending' && g.userCode === input.userCode)) return false;
      grants.set(input.deviceCodeHash, {
        userCode: input.userCode, clientLabel: input.clientLabel, requestedScopes: input.requestedScopes,
        createdAt: input.createdAt, expiresAt: input.expiresAt, state: 'pending', workspaceId: null, approvedBy: null, lastPolledAt: null,
      });
      return true;
    },
    async findPendingGrant(userCode, now) {
      return [...grants.values()].find((g) => g.userCode === userCode && g.state === 'pending' && g.expiresAt > now) ?? null;
    },
    async listPendingGrants(now) {
      return [...grants.values()].filter((g) => g.state === 'pending' && g.expiresAt > now);
    },
    async decideGrant({ userCode, decision, workspaceId, decidedBy, at }) {
      if (decision === 'approved' && !workspaceId) return false;
      const g = [...grants.values()].find((x) => x.userCode === userCode && x.state === 'pending' && x.expiresAt > at);
      if (!g) return false;
      Object.assign(g, { state: decision, workspaceId: decision === 'approved' ? workspaceId : null, approvedBy: decidedBy });
      return true;
    },
    async exchangeGrant({ deviceCodeHash, now, minPollIntervalMs }) {
      const g = grants.get(deviceCodeHash);
      if (!g || g.state === 'consumed') return { status: 'invalid' };
      if (g.expiresAt <= now) return { status: 'expired' };
      if (g.state === 'denied') return { status: 'denied' };
      if (g.state === 'pending') {
        if (g.lastPolledAt && now.getTime() - g.lastPolledAt.getTime() < minPollIntervalMs) return { status: 'slow_down' };
        g.lastPolledAt = now;
        return { status: 'pending' };
      }
      const scopes = resolveAppKeyScopes({ ...g.requestedScopes, knownTools: KNOWN_TOOLS });
      const minted = mintAppKey();
      issued.push({ workspaceId: g.workspaceId!, userEmail: g.approvedBy!, label: g.clientLabel, scopes, tokenHash: minted.tokenHash });
      g.state = 'consumed';
      const created: CreatedAppKey = { key: minted.key, app: appRow(minted.id, g.workspaceId!, g.approvedBy!, g.clientLabel, scopes) };
      return { status: 'issued', issued: created };
    },
  };
  return { store, grants };
}

function setup() {
  const issued: IssuedRecord[] = [];
  const created: Array<{ workspaceId: string; label: string; tools?: readonly string[] }> = [];
  const { store, grants } = memoryGrants(issued);
  let now = new Date('2026-09-30T12:00:00Z');
  const routes = createConnectedAppRoutes({
    grants: store,
    createKey: async (opts) => {
      const scopes = resolveAppKeyScopes({ ...opts, knownTools: KNOWN_TOOLS });
      created.push({ workspaceId: opts.workspaceId, label: opts.label, tools: opts.tools });
      const minted = mintAppKey();
      return { key: minted.key, app: appRow(minted.id, opts.workspaceId, opts.userEmail, opts.label, scopes) };
    },
    // Rotation is covered by connected-apps/service-keys.test.ts; these device-code tests never rotate.
    rotateKey: async () => null,
    resolveScopes: (req) => resolveAppKeyScopes({ ...req, knownTools: KNOWN_TOOLS }),
    workspaceExists: (id) => id === 'ws-local' || id === 'ws-other',
    listWorkspaces: () => [{ id: 'ws-local', name: 'Local' }, { id: 'ws-other', name: 'Other' }],
    isLocal: isLoopbackHost,
    clock: () => now,
  });
  const route = (method: string, path: string) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  /** A request as this machine sends it (loopback Host) unless `remote` adds a tunnel's forwarding header. */
  const call = (method: string, path: string, body?: unknown, opts: { remote?: boolean; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: '127.0.0.1:3070', 'content-type': 'application/json', ...opts.headers };
    if (opts.remote) headers['x-forwarded-for'] = '203.0.113.9';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return route(method, path).handler(new Request(`${LOCAL}/api${path}`, init), { params: {}, principal: null } as never) as Promise<Response>;
  };
  return { call, issued, created, grants, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => { throw new Error('no network call is allowed during a local sign-in'); });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('local device-code sign-in (R-9)', () => {
  it('issues a key scoped to what the app asked for, into the approved workspace, with no portal involved', async () => {
    const t = setup();
    // The app is on another host and reaches the code endpoint through the user's tunnel.
    const codeRes = await t.call('POST', '/connected-apps/device/code', {
      clientLabel: 'nightly-report', tools: ['plans:list', 'work_items:get'], harnesses: ['papercusp'],
    }, { remote: true });
    expect(codeRes.status).toBe(200);
    const code = await codeRes.json();
    expect(code.deviceCode).toMatch(/^pad_[A-Za-z0-9_-]{43}$/);
    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // A remote caller never receives a link to the local-only approval page.
    expect(code.verificationUri).toBeNull();
    // The device code is stored only as its hash.
    expect([...t.grants.keys()]).toEqual([sha256(code.deviceCode)]);

    // Before approval the poll is pending.
    const early = await t.call('POST', '/connected-apps/device/token', { deviceCode: code.deviceCode }, { remote: true });
    expect(early.status).toBe(400);
    expect((await early.json()).error).toBe('authorization_pending');

    // The person at the machine sees the pending sign-in and approves it into a workspace.
    const pending = await (await t.call('GET', '/connected-apps/device/pending')).json();
    expect(pending.grants.map((g: PendingDeviceGrant) => g.userCode)).toEqual([code.userCode]);
    const decided = await t.call('POST', '/connected-apps/device/decision',
      { userCode: code.userCode, decision: 'approve', workspaceId: 'ws-local' },
      { headers: { origin: LOCAL, 'sec-fetch-site': 'same-origin' } });
    expect(await decided.json()).toEqual({ ok: true, decision: 'approved' });

    t.advance(6_000);
    const tokenRes = await t.call('POST', '/connected-apps/device/token', { deviceCode: code.deviceCode }, { remote: true });
    expect(tokenRes.status).toBe(200);
    const token = await tokenRes.json();
    const parsed = parseAppKey(token.accessToken);
    expect(parsed).not.toBeNull();
    expect(token.tokenType).toBe('Bearer');
    expect(token.app).toMatchObject({ id: parsed!.id, workspaceId: 'ws-local', label: 'nightly-report' });
    expect(token.app.scopes).toEqual({ capabilities: [], tools: ['plans:list', 'work_items:get'], harnesses: ['papercusp'] });
    expect(t.issued).toEqual([{
      workspaceId: 'ws-local', userEmail: LOCAL_OWNER_EMAIL, label: 'nightly-report',
      scopes: { capabilities: [], tools: ['plans:list', 'work_items:get'], harnesses: ['papercusp'] },
      tokenHash: hashAppKey(token.accessToken),
    }]);
    expect(token.snippets.mcp.mcpServers.papercusp.headers.Authorization).toBe(`Bearer ${token.accessToken}`);
    expect(token.snippets.curl).toContain('/api/agent-tools/');

    // The key is handed out once: the next poll finds the grant consumed.
    t.advance(6_000);
    const again = await t.call('POST', '/connected-apps/device/token', { deviceCode: code.deviceCode }, { remote: true });
    expect((await again.json()).error).toBe('invalid_grant');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses approval from anywhere but this machine', async () => {
    const t = setup();
    const code = await (await t.call('POST', '/connected-apps/device/code', { clientLabel: 'x', tools: ['plans:list'] })).json();
    const viaTunnel = await t.call('POST', '/connected-apps/device/decision',
      { userCode: code.userCode, decision: 'approve', workspaceId: 'ws-local' }, { remote: true });
    expect(viaTunnel.status).toBe(403);
    const crossSite = await t.call('POST', '/connected-apps/device/decision',
      { userCode: code.userCode, decision: 'approve', workspaceId: 'ws-local' },
      { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    expect((await crossSite.json()).error.code).toBe('cross_origin_blocked');
    expect((await t.call('GET', '/connected-apps/device/pending', undefined, { remote: true })).status).toBe(403);
    expect([...t.grants.values()][0]!.state).toBe('pending');
  });

  it('refuses a hard-denied tool before any grant exists', async () => {
    const t = setup();
    const res = await t.call('POST', '/connected-apps/device/code', { clientLabel: 'x', tools: ['capability:bash'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_scope');
    expect(t.grants.size).toBe(0);
  });

  it('a denied code never becomes a key', async () => {
    const t = setup();
    const code = await (await t.call('POST', '/connected-apps/device/code', { clientLabel: 'x', tools: ['plans:list'] })).json();
    await t.call('POST', '/connected-apps/device/decision', { userCode: code.userCode, decision: 'deny' });
    const res = await t.call('POST', '/connected-apps/device/token', { deviceCode: code.deviceCode });
    expect((await res.json()).error).toBe('access_denied');
    expect(t.issued).toEqual([]);
  });
});

describe('Connect an app (local key creation)', () => {
  it('creates a scoped key on this machine and returns it once with snippets', async () => {
    const t = setup();
    const res = await t.call('POST', '/connected-apps', { label: 'zapier', workspaceId: 'ws-local', tools: ['plans:list'] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(parseAppKey(body.key)).not.toBeNull();
    expect(body.app).toMatchObject({ workspaceId: 'ws-local', label: 'zapier', scopes: { tools: ['plans:list'] } });
    expect(body.snippets.mcp.mcpServers.papercusp.url).toBe(`${LOCAL}/api/mcp`);
    expect(t.created).toEqual([{ workspaceId: 'ws-local', label: 'zapier', tools: ['plans:list'] }]);
  });

  it('refuses a caller that is not on this machine', async () => {
    const t = setup();
    const res = await t.call('POST', '/connected-apps', { label: 'zapier', workspaceId: 'ws-local' }, { remote: true });
    expect(res.status).toBe(403);
    expect(t.created).toEqual([]);
  });

  it('refuses a label with nothing printable in it instead of naming the key for it', async () => {
    const t = setup();
    for (const label of ['', '   ', '\u0007', '\n\t']) {
      const res = await t.call('POST', '/connected-apps', { label, workspaceId: 'ws-local', tools: ['plans:list'] });
      expect(res.status, JSON.stringify(label)).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    }
    expect(t.created).toEqual([]);
  });

  it('names a device-code client that sends no usable label with the default label', async () => {
    const t = setup();
    for (const clientLabel of [undefined, '', '\u0007']) {
      const res = await t.call('POST', '/connected-apps/device/code', { clientLabel, tools: ['plans:list'] });
      expect(res.status).toBe(200);
    }
    expect([...t.grants.values()].map((g) => g.clientLabel)).toEqual([DEFAULT_CLIENT_LABEL, DEFAULT_CLIENT_LABEL, DEFAULT_CLIENT_LABEL]);
  });
});
