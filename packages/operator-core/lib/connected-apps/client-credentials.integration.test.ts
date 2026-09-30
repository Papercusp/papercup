/**
 * client-credentials.integration.test.ts — the OAuth client-credentials grant on a LOCAL install,
 * end to end, against REAL Postgres with every migration applied (1261 included) and REAL RLS
 * (external-app-access-to-workspaces-2026-09-29 P-016: R-15, R-35; design D-022).
 *
 * The pieces are the ones the operator mounts: the real token endpoint (`createMcpOAuthRoutes`
 * with the real `PostgresClientCredentialsStore`), the real client-credentials routes (switch a
 * service key into client-credentials mode; the portal's relayed token request), the real
 * `verifyAppKey` bearer check and the real dispatch-seat scope enforcement. Requests travel the
 * same test wire as ./mcp-oauth.integration.test.ts: the public origin arrives through the
 * user's tunnel (plain http, public Host, X-Forwarded-*), the local origin is this computer, and
 * the global fetch is poisoned so nothing leaves the process.
 *
 * Harness copied from ./mcp-oauth.integration.test.ts: withWorkspace runs as harness_app
 * (RLS-subject) with the workspace GUC set; getOrgPg().sql is the admin client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any, adminSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
  getOrgPg: () => ({ sql: h.adminSql }),
}));

const { createMcpOAuthRoutes, createClientCredentialsRoutes } = await import('../endpoint-route/routes/connected-apps/oauth');
const { isLoopbackHost } = await import('../endpoint-route/routes/device/_shared');
const { PostgresOAuthStore } = await import('./mcp-oauth');
const { MCP_OAUTH_WELL_KNOWN } = await import('./mcp-oauth-discovery');
const { PostgresClientCredentialsStore, CLIENT_CREDENTIALS_TOKEN_TTL_SEC, JWT_BEARER_ASSERTION_TYPE } = await import('./client-credentials');
const { createAppKey, createServiceKey, resolveAppKeyScopes, revokeAppKey, setAppKeyPaused, setClientCredentialsMode, verifyAppKey } =
  await import('./store');
const { resolveAppKeyPrincipal } = await import('./principal');
const { enforceAppKeyScope } = await import('./enforce');
const { createOrgTestDb } = await import('../../test/_org-test-db');

/** The user's own tunnel (D-001). An unattended app elsewhere reaches the install here. */
const PUBLIC = 'https://ws.example.org';
/** The computer running Papercusp. */
const LOCAL = 'http://127.0.0.1:3070';
/** A portal token endpoint (D-021): the audience the portal relays for an assertion. */
const PORTAL_AUDIENCE = 'https://portal.example.com/api/workspaces/ws_portal/oauth/token';
const WS = `cc_ws_${randomBytes(3).toString('hex')}`;

type AnyRoute = { method: string; path: string; handler: (req: Request, ctx: never) => Promise<Response> | Response };

const clientCredentials = new PostgresClientCredentialsStore();
const routes: AnyRoute[] = [
  ...(createMcpOAuthRoutes({
    store: new PostgresOAuthStore(),
    resolveScopes: resolveAppKeyScopes,
    listWorkspaces: () => [{ id: WS, name: 'Test workspace' }],
    isLocal: isLoopbackHost,
    clientCredentials,
  }) as unknown as AnyRoute[]),
  ...(createClientCredentialsRoutes({
    store: clientCredentials,
    setMode: setClientCredentialsMode,
    workspaceExists: (id) => id === WS,
    isLocal: isLoopbackHost,
  }) as unknown as AnyRoute[]),
];

/** What the operator's HTTP host does with one request that has already reached it. */
async function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mapped = MCP_OAUTH_WELL_KNOWN[url.pathname];
  const path = mapped ?? url.pathname;
  if (!path.startsWith('/api/')) return new Response('not found', { status: 404 });
  const route = routes.find((r) => r.method === req.method && r.path === path.slice('/api'.length));
  if (!route) return new Response('not found', { status: 404 });
  if (mapped) {
    const target = new URL(url);
    target.pathname = mapped;
    target.search = '';
    req = new Request(target, { method: 'GET', headers: req.headers });
  }
  return route.handler(req, { params: {}, principal: null } as never);
}

/** The wire: the public origin arrives through the tunnel; the local origin is this computer. */
async function wire(input: string, init?: RequestInit): Promise<Response> {
  const sent = new Request(input, init);
  const url = new URL(sent.url);
  const headers = new Headers(sent.headers);
  headers.set('host', url.host);
  let arrived = url;
  if (url.origin === PUBLIC) {
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-for', '203.0.113.9');
    arrived = new URL(`http://${url.host}${url.pathname}${url.search}`);
  } else if (url.origin !== LOCAL) {
    throw new Error(`test wire refused ${url.origin}: only the tunnel and this computer exist here`);
  }
  const body = sent.method === 'GET' || sent.method === 'HEAD' ? undefined : await sent.arrayBuffer();
  return serve(new Request(arrived, { method: sent.method, headers, body, redirect: 'manual' }));
}

const postJson = (url: string, body: unknown) =>
  wire(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The token endpoint the install advertises to the outside (RFC 8414 metadata). */
async function tokenEndpoint(): Promise<string> {
  const meta = await (await wire(`${PUBLIC}/.well-known/oauth-authorization-server`)).json();
  return String(meta.token_endpoint);
}

/** An unattended app's token request, sent from outside through the tunnel. */
async function requestToken(fields: Record<string, string>, basic?: { id: string; secret: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`;
  const res = await wire(await tokenEndpoint(), {
    method: 'POST',
    headers,
    body: new URLSearchParams({ grant_type: 'client_credentials', ...fields }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** A service key switched into client-credentials mode through the real local route. */
async function secretClient(opts: { tools?: string[]; expiresAt?: Date | null } = {}) {
  const { app, key } = await createServiceKey({
    workspaceId: WS,
    userEmail: 'owner@example.test',
    label: `svc-${randomBytes(2).toString('hex')}`,
    spendCapCents: 500,
    tools: opts.tools ?? ['plans:*'],
    expiresAt: opts.expiresAt ?? null,
  });
  const res = await postJson(`${LOCAL}/api/connected-apps/client-credentials`, { workspaceId: WS, id: app.id, auth: 'client_secret' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, app: { id: app.id, kind: 'service', clientAuth: 'client_secret' } });
  return { id: app.id, secret: key };
}

async function tokenRows(appId: string) {
  return h.adminSql<{ id: string; token_hash: string; scopes: any; created_at: Date; expires_at: Date }[]>`
    SELECT id, token_hash, scopes, created_at, expires_at
      FROM harness_shared.connected_app_access_tokens WHERE app_id = ${appId}`;
}

describe('OAuth client-credentials on a local install (real PG + real RLS)', () => {
  let db: OrgTestDb;
  let net: MockInstance<typeof fetch>;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(() => {
    net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('the network was reached; every request here must stay on the test wire');
    });
  });

  afterEach(() => {
    expect(net).not.toHaveBeenCalled();
    net.mockRestore();
  });

  it('the install advertises the client-credentials grant and both client authentication methods', async () => {
    const meta = await (await wire(`${PUBLIC}/.well-known/oauth-authorization-server`)).json();
    expect(meta.token_endpoint).toBe(`${PUBLIC}/api/connected-apps/oauth/token`);
    expect(meta.grant_types_supported).toContain('client_credentials');
    expect(meta.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(['client_secret_basic', 'private_key_jwt']));
  });

  it('R-15: the secret buys a token that expires within the hour; only its digest is stored, with a finite expiry', async () => {
    const client = await secretClient();
    const answer = await requestToken({}, client);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    expect(answer.body).toMatchObject({ token_type: 'Bearer', expires_in: CLIENT_CREDENTIALS_TOKEN_TTL_SEC });
    const token = String(answer.body.access_token);
    expect(token).toMatch(/^pcat_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/);

    const rows = await tokenRows(client.id);
    expect(rows).toHaveLength(1);
    expect(token.startsWith(`pcat_${rows[0]!.id}_`)).toBe(true);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(rows[0]!.token_hash);
    const lifetimeMs = rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime();
    expect(lifetimeMs).toBeGreaterThan(0);
    expect(lifetimeMs).toBeLessThanOrEqual(CLIENT_CREDENTIALS_TOKEN_TTL_SEC * 1000);

    const verdict = await verifyAppKey(token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.app.id).toBe(client.id);
    expect(verdict.accessToken?.expires_at.getTime()).toBe(rows[0]!.expires_at.getTime());

    // An hour later the same token is refused.
    const later = new Date(rows[0]!.expires_at.getTime() + 1000);
    expect(await verifyAppKey(token, later)).toEqual({ ok: false, reason: 'expired' });
  });

  it('R-15: a client that expires in ten minutes gets a token that expires with it', async () => {
    const clientExpiry = new Date(Date.now() + 10 * 60_000);
    const client = await secretClient({ expiresAt: clientExpiry });
    const answer = await requestToken({ client_id: client.id, client_secret: client.secret });
    expect(answer.status).toBe(200);
    expect(Number(answer.body.expires_in)).toBeLessThanOrEqual(600);
    const rows = await tokenRows(client.id);
    expect(rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(clientExpiry.getTime());
  });

  it('R-15: the database refuses a token row without a future expiry', async () => {
    const client = await secretClient();
    const now = new Date();
    await expect(
      h.adminSql`
        INSERT INTO harness_shared.connected_app_access_tokens (id, token_hash, app_id, workspace_id, scopes, created_at, expires_at)
        VALUES (${randomBytes(8).toString('hex').slice(0, 16)}, ${'a'.repeat(64)}, ${client.id}, ${WS}, '{}'::jsonb, ${now}, ${now})`,
    ).rejects.toThrow(/connected_app_access_tokens_expiry_after_creation/);
  });

  it('R-35: a token never carries scope beyond its client — a narrower request narrows it, a wider one is refused', async () => {
    const client = await secretClient({ tools: ['plans:*'] });

    const wider = await requestToken({ scope: 'tool:work_items:get' }, client);
    expect(wider.status).toBe(400);
    expect(wider.body.error).toBe('invalid_scope');
    expect(await tokenRows(client.id)).toHaveLength(0);

    const narrowed = await requestToken({ scope: 'tool:plans:get' }, client);
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('tool:plans:get');
    const rows = await tokenRows(client.id);
    expect(rows[0]!.scopes.tools).toEqual(['plans:get']);

    // At the dispatch seat the token allows only what both it and its client allow.
    const token = String(narrowed.body.access_token);
    const principal = await resolveAppKeyPrincipal(new Headers({ authorization: `Bearer ${token}` }));
    expect(principal?.ok).toBe(true);
    if (!principal?.ok) return;
    const call = (toolName: string) =>
      enforceAppKeyScope({
        phase: 'enforce',
        boundary: 'dispatch',
        toolName,
        capabilities: [],
        args: {},
        ctx: { principal: principal.principal, workspaceId: WS } as never,
      });
    expect(await call('plans:get')).toBeNull();
    expect((await call('plans:list'))?.decision).toBe('deny');
    expect((await call('work_items:get'))?.decision).toBe('deny');
  });

  it('the client secret is accepted only at the token endpoint, never as a bearer', async () => {
    const client = await secretClient();
    expect(await verifyAppKey(client.secret)).toEqual({ ok: false, reason: 'token_endpoint_only' });
    const wrong = await requestToken({}, { id: client.id, secret: `${client.secret.slice(0, -1)}x` });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    expect(wrong.headers.get('www-authenticate')).toContain('Basic');
  });

  it('pausing or revoking the client stops its live token on the next call', async () => {
    const paused = await secretClient();
    const pausedToken = String((await requestToken({}, paused)).body.access_token);
    expect((await verifyAppKey(pausedToken)).ok).toBe(true);
    expect(await setAppKeyPaused(WS, paused.id, true)).toBe(true);
    expect(await verifyAppKey(pausedToken)).toMatchObject({ ok: false });
    expect((await requestToken({}, paused)).status).toBe(401);

    const revoked = await secretClient();
    const revokedToken = String((await requestToken({}, revoked)).body.access_token);
    expect(await revokeAppKey(WS, revoked.id)).toBe(true);
    expect(await verifyAppKey(revokedToken)).toMatchObject({ ok: false });
    expect((await requestToken({}, revoked)).status).toBe(401);
  });

  it('leaving client-credentials mode deletes the live tokens', async () => {
    const client = await secretClient();
    const token = String((await requestToken({}, client)).body.access_token);
    const res = await postJson(`${LOCAL}/api/connected-apps/client-credentials`, { workspaceId: WS, id: client.id, auth: null });
    expect(res.status).toBe(200);
    expect(await tokenRows(client.id)).toHaveLength(0);
    expect(await verifyAppKey(token)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('private_key_jwt: a signed assertion is accepted once, and its jti is remembered in the database', async () => {
    const { app } = await createServiceKey({ workspaceId: WS, userEmail: 'owner@example.test', label: 'jwt', spendCapCents: 500, tools: ['plans:*'] });
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const refusedPrivate = await postJson(`${LOCAL}/api/connected-apps/client-credentials`, {
      workspaceId: WS,
      id: app.id,
      auth: 'private_key_jwt',
      jwk: privateJwk,
    });
    expect(refusedPrivate.status).toBe(400);
    expect((await refusedPrivate.json()).error.code).toBe('invalid_jwk');

    const set = await postJson(`${LOCAL}/api/connected-apps/client-credentials`, {
      workspaceId: WS,
      id: app.id,
      auth: 'private_key_jwt',
      jwk: await exportJWK(publicKey),
    });
    expect(set.status).toBe(200);
    const stored = await h.adminSql<{ client_jwk: Record<string, unknown> }[]>`
      SELECT client_jwk FROM harness_shared.connected_apps WHERE id = ${app.id}`;
    expect(stored[0]!.client_jwk).not.toHaveProperty('d');

    const audience = await tokenEndpoint();
    const nowSec = Math.floor(Date.now() / 1000);
    const jti = `jti-${randomBytes(4).toString('hex')}`;
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(app.id)
      .setSubject(app.id)
      .setAudience(audience)
      .setJti(jti)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 120)
      .sign(privateKey);
    const fields = { client_assertion_type: JWT_BEARER_ASSERTION_TYPE, client_assertion: assertion };

    const first = await requestToken(fields);
    expect(first.status).toBe(200);
    expect((await verifyAppKey(String(first.body.access_token))).ok).toBe(true);
    const remembered = await h.adminSql`
      SELECT 1 FROM harness_shared.connected_app_client_assertions WHERE app_id = ${app.id} AND jti = ${jti}`;
    expect(remembered).toHaveLength(1);

    const replay = await requestToken(fields);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_client');
  });

  it('only a live service key can enter client-credentials mode, and only from this computer', async () => {
    const { app } = await createAppKey({ workspaceId: WS, userEmail: 'owner@example.test', label: 'plain', tools: ['plans:*'] });
    const notService = await postJson(`${LOCAL}/api/connected-apps/client-credentials`, { workspaceId: WS, id: app.id, auth: 'client_secret' });
    expect(notService.status).toBe(400);
    expect((await notService.json()).error.code).toBe('not_service_key');

    const { app: svc } = await createServiceKey({ workspaceId: WS, userEmail: 'owner@example.test', label: 'remote', spendCapCents: 500 });
    const outside = await postJson(`${PUBLIC}/api/connected-apps/client-credentials`, { workspaceId: WS, id: svc.id, auth: 'client_secret' });
    expect(outside.status).toBe(403);

    // The database enforces the same shape if any other writer tries.
    await expect(
      h.adminSql`UPDATE harness_shared.connected_apps SET client_auth = 'client_secret' WHERE id = ${app.id}`,
    ).rejects.toThrow(/connected_apps_client_auth_check/);
    await expect(
      h.adminSql`UPDATE harness_shared.connected_apps SET client_auth = 'private_key_jwt', client_jwk = NULL WHERE id = ${svc.id}`,
    ).rejects.toThrow(/connected_apps_client_jwk_check/);
  });

  it('the portal relay path issues a token for a portal audience, and only for a caller on this computer', async () => {
    const client = await secretClient();
    const body = {
      fields: { grant_type: 'client_credentials', client_id: client.id, client_secret: client.secret },
      audience: PORTAL_AUDIENCE,
    };
    const relayed = await postJson(`${LOCAL}/api/connected-apps/portal-token`, body);
    expect(relayed.status).toBe(200);
    const answer = await relayed.json();
    expect(answer).toMatchObject({ ok: true, status: 200, body: { token_type: 'Bearer' } });
    expect((await verifyAppKey(String(answer.body.access_token))).ok).toBe(true);

    expect((await postJson(`${PUBLIC}/api/connected-apps/portal-token`, body)).status).toBe(403);
    expect((await postJson(`${LOCAL}/api/connected-apps/portal-token`, { ...body, audience: 'https://evil.example/token' })).status).toBe(400);
  });
});
