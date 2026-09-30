/**
 * Connect an app — credential issuance on a LOCAL install
 * (external-app-access-to-workspaces-2026-09-29 P-005).
 *
 *   POST /connected-apps                    local-only  create an app key directly ("Connect an app")
 *   POST /connected-apps/device/code        public      an app starts a device-code sign-in (RFC 8628)
 *   GET  /connected-apps/device             local-only  the approval page (server-rendered)
 *   GET  /connected-apps/device/pending     local-only  pending sign-ins, for the desktop UI
 *   POST /connected-apps/device/decision    local-only  approve (into a workspace) or deny a code
 *   POST /connected-apps/device/token       public      the app polls; an approved code becomes a key
 *
 * Both issuance paths return the key exactly once, with a curl and an MCP-config snippet. No step
 * involves the portal (D-004): the grant, the approval and the key are local rows. The route shape
 * mirrors the portal's psu sign-in (../hosted-cli), which is the reference RFC 8628 implementation
 * here; the difference is WHO approves — on a local install, whoever is at the machine, gated by
 * `isLoopbackHost` (loopback Host, trusted loopback peer, and not a tunnel/relay request — P-004).
 *
 * The code and token routes are public on purpose: an app on another host reaches them through
 * the user's tunnel. Creating a grant grants nothing; only a local approval does.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { isLoopbackHost } from '../device/_shared';
import { readRegistry, workspaceById } from '../../../workspace-registry';
import {
  AppKeyScopeError,
  createAppKey,
  resolveAppKeyScopes,
  type AppKeyScopeRequest,
  type AppKeyScopes,
  type CreatedAppKey,
  type CreateAppKeyOptions,
} from '../../../connected-apps/store';
import { PostgresDeviceGrantStore, type DeviceGrantStore } from '../../../connected-apps/device-grants';
import { normalizeUserCode, sanitizeClientLabel } from '../hosted-cli';

export const CONNECTED_APP_DEVICE_CODE_TTL_MS = 10 * 60_000;
export const CONNECTED_APP_POLL_INTERVAL_MS = 5_000;
/** The key's owner on a single-user local install — the same identity phone pairing uses. */
export const LOCAL_OWNER_EMAIL = 'local@desktop';

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const DEVICE_CODE_RE = /^pad_[A-Za-z0-9_-]{43}$/;
const DEVICE_PAGE_PATH = '/api/connected-apps/device';

type AnyRoute = RouteDefinition<any>;

export interface ConnectedAppRouteDependencies {
  readonly grants: DeviceGrantStore;
  readonly createKey: (opts: CreateAppKeyOptions) => Promise<CreatedAppKey>;
  /** Normalize + validate requested scopes; throws AppKeyScopeError. */
  readonly resolveScopes: (req: AppKeyScopeRequest) => AppKeyScopes;
  readonly workspaceExists: (id: string) => boolean;
  readonly listWorkspaces: () => ReadonlyArray<{ id: string; name: string }>;
  /** True when the request is from this machine and not through a tunnel or relay. */
  readonly isLocal: (req: Request) => boolean;
  readonly clock?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const noStore = { 'cache-control': 'no-store' };

function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: { code, ...extra } }, { status, headers: noStore });
}

/** RFC 8628 §3.5 token-endpoint error. */
function deviceTokenError(error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, ...extra }, { status: 400, headers: noStore });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return undefined;
  return value as string[];
}

/** The scope fields of a request body; null when one is present but not a string array. */
function scopeRequestOf(body: Record<string, unknown>): AppKeyScopeRequest | null {
  const out: AppKeyScopeRequest = {};
  for (const field of ['tools', 'harnesses', 'capabilities'] as const) {
    if (body[field] === undefined) continue;
    const list = stringList(body[field]);
    if (!list) return null;
    out[field] = list;
  }
  return out;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function htmlPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Papercusp</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:30rem;padding:2rem}
code{font-size:1.4rem;letter-spacing:.15em;font-weight:600}.row{display:flex;gap:.75rem;margin-top:1.25rem}
button,input,select{font:inherit;padding:.45rem .9rem;border-radius:8px}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...noStore,
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'same-origin',
    },
  });
}

/**
 * CSRF guard for the decision route. A browser always sends Origin on a POST, so a present Origin
 * must be this server's; `Origin: null` passes only with a same-origin Fetch-Metadata header. A
 * local non-browser caller (curl, the desktop shell's native fetch) sends no Origin and is already
 * proven local by `isLocal`.
 */
function isSameOriginOrNonBrowser(req: Request): boolean {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (origin === null) return true;
  if (origin === 'null') return site === 'same-origin';
  return origin === new URL(req.url).origin;
}

/** How to call the workspace with a key: a curl line for the HTTP API and an MCP client config. */
export function connectionSnippets(baseUrl: string, key: string) {
  const base = baseUrl.replace(/\/$/, '');
  return {
    baseUrl: base,
    curl: `curl -sS -X POST ${base}/api/agent-tools/<group>/<verb> -H 'Authorization: Bearer ${key}' -H 'content-type: application/json' -d '{}'`,
    mcp: { mcpServers: { papercusp: { type: 'http', url: `${base}/api/mcp`, headers: { Authorization: `Bearer ${key}` } } } },
  };
}

function keyView(created: CreatedAppKey) {
  const { app } = created;
  return { id: app.id, label: app.label, workspaceId: app.workspace_id, scopes: app.scopes, expiresAt: app.expires_at };
}

export function createConnectedAppRoutes(deps: ConnectedAppRouteDependencies): ReadonlyArray<AnyRoute> {
  const clock = deps.clock ?? (() => new Date());
  const random = deps.randomBytes ?? ((size: number) => nodeRandomBytes(size));

  function randomString(size: number): string {
    const bytes = Buffer.from(random(size));
    if (bytes.byteLength !== size) throw new Error('connected_apps_entropy_source_returned_wrong_size');
    return bytes.toString('base64url');
  }
  function randomUserCode(): string {
    let code = '';
    for (const byte of Buffer.from(random(8))) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  function scopeRefusal(err: unknown): Response {
    if (err instanceof AppKeyScopeError) return jsonError('invalid_scope', 400, { problems: err.problems });
    throw err;
  }

  const connectApp = defineTool({
    method: 'POST',
    path: '/connected-apps',
    auth: 'public',
    async handler(req) {
      if (!deps.isLocal(req)) return jsonError('local_only', 403);
      const body = await readJson(req);
      if (!body) return jsonError('invalid_json', 400);
      const label = typeof body.label === 'string' ? sanitizeClientLabel(body.label) : '';
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
      const scopes = scopeRequestOf(body);
      const expiresAt = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : null;
      if (!label || !workspaceId || !scopes || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
        return jsonError('invalid_request', 400);
      }
      if (!deps.workspaceExists(workspaceId)) return jsonError('workspace_not_found', 400);
      let created: CreatedAppKey;
      try {
        created = await deps.createKey({ workspaceId, userEmail: LOCAL_OWNER_EMAIL, label, ...scopes, expiresAt });
      } catch (err) {
        return scopeRefusal(err);
      }
      return Response.json(
        { ok: true, app: keyView(created), key: created.key, snippets: connectionSnippets(new URL(req.url).origin, created.key) },
        { status: 201, headers: noStore },
      );
    },
  });

  const deviceCode = defineTool({
    method: 'POST',
    path: '/connected-apps/device/code',
    auth: 'public',
    async handler(req) {
      const body = (await readJson(req)) ?? {};
      const scopeRequest = scopeRequestOf(body);
      if (!scopeRequest) return jsonError('invalid_request', 400);
      let requestedScopes: AppKeyScopes;
      try {
        requestedScopes = deps.resolveScopes(scopeRequest);
      } catch (err) {
        return scopeRefusal(err);
      }
      const clientLabel = sanitizeClientLabel(body.clientLabel);
      const now = clock();
      const expiresAt = new Date(now.getTime() + CONNECTED_APP_DEVICE_CODE_TTL_MS);
      const code = `pad_${randomString(32)}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const userCode = randomUserCode();
        let created: boolean;
        try {
          created = await deps.grants.createGrant({
            deviceCodeHash: sha256Hex(code),
            userCode,
            clientLabel,
            requestedScopes,
            createdAt: now,
            expiresAt,
          });
        } catch {
          return jsonError('device_code_unavailable', 503);
        }
        if (!created) continue; // a live user code collided; draw another
        // The approval page only answers on this machine, so a remote caller gets the path and
        // the instruction, never a link it could follow.
        const origin = deps.isLocal(req) ? new URL(req.url).origin : null;
        const verificationUri = origin ? `${origin}${DEVICE_PAGE_PATH}` : null;
        return Response.json(
          {
            ok: true,
            deviceCode: code,
            userCode,
            verificationUri,
            verificationUriComplete: verificationUri ? `${verificationUri}?user_code=${encodeURIComponent(userCode)}` : null,
            verification: `On the computer running Papercusp, open Settings → Remote access (or ${DEVICE_PAGE_PATH}) and approve code ${userCode}.`,
            expiresIn: Math.round(CONNECTED_APP_DEVICE_CODE_TTL_MS / 1000),
            interval: Math.round(CONNECTED_APP_POLL_INTERVAL_MS / 1000),
          },
          { headers: noStore },
        );
      }
      return jsonError('device_code_unavailable', 503);
    },
  });

  const devicePage = defineTool({
    method: 'GET',
    path: '/connected-apps/device',
    auth: 'public',
    async handler(req) {
      if (!deps.isLocal(req)) return htmlPage('Not available here', '<p>Approve app sign-ins on the computer running Papercusp.</p>', 403);
      const raw = new URL(req.url).searchParams.get('user_code');
      const userCode = normalizeUserCode(raw);
      if (!userCode) {
        const invalid = raw ? '<p>That code is not in the right form. It looks like <code>ABCD-EFGH</code>.</p>' : '';
        return htmlPage(
          'Connect an app',
          `${invalid}<p>Enter the code the app is showing.</p><form method="get" action="${DEVICE_PAGE_PATH}">
<input name="user_code" autocomplete="off" autofocus maxlength="12" placeholder="ABCD-EFGH" required>
<div class="row"><button type="submit">Continue</button></div></form>`,
        );
      }
      const grant = await deps.grants.findPendingGrant(userCode, clock()).catch(() => null);
      if (!grant) return htmlPage('Code not found', '<p>This code has expired, was already used, or does not exist.</p>', 404);
      const tools = grant.requestedScopes.tools?.length ? grant.requestedScopes.tools.map(escapeHtml).join(', ') : 'none';
      const harnesses = grant.requestedScopes.harnesses?.length ? grant.requestedScopes.harnesses.map(escapeHtml).join(', ') : 'any';
      const options = deps
        .listWorkspaces()
        .map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`)
        .join('');
      return htmlPage(
        `Allow ${grant.clientLabel} to use a workspace?`,
        `<p>Check that the app shows <code>${escapeHtml(grant.userCode)}</code>.</p>
<p>It asks to call these tools: <b>${tools}</b>, in harnesses: <b>${harnesses}</b>.</p>
<form method="post" action="${DEVICE_PAGE_PATH}/decision"><input type="hidden" name="user_code" value="${escapeHtml(grant.userCode)}">
<label>Workspace <select name="workspace_id" required>${options}</select></label>
<div class="row"><button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></div></form>`,
      );
    },
  });

  const devicePending = defineTool({
    method: 'GET',
    path: '/connected-apps/device/pending',
    auth: 'public',
    async handler(req) {
      if (!deps.isLocal(req)) return jsonError('local_only', 403);
      const grants = await deps.grants.listPendingGrants(clock());
      return Response.json({ ok: true, grants }, { headers: noStore });
    },
  });

  const deviceDecision = defineTool({
    method: 'POST',
    path: '/connected-apps/device/decision',
    auth: 'public',
    async handler(req) {
      if (!deps.isLocal(req)) return jsonError('local_only', 403);
      if (!isSameOriginOrNonBrowser(req)) return jsonError('cross_origin_blocked', 403);
      const isForm = (req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
      const fields: Record<string, unknown> | null = isForm
        ? Object.fromEntries(new URLSearchParams(await req.text()))
        : await readJson(req);
      if (!fields) return jsonError('invalid_json', 400);
      const userCode = normalizeUserCode(fields.user_code ?? fields.userCode);
      const decision = fields.decision === 'approve' ? 'approved' : fields.decision === 'deny' ? 'denied' : null;
      const rawWorkspace = fields.workspace_id ?? fields.workspaceId;
      const workspaceId = typeof rawWorkspace === 'string' && rawWorkspace ? rawWorkspace : null;
      if (!userCode || !decision) return jsonError('invalid_decision', 400);
      if (decision === 'approved' && (!workspaceId || !deps.workspaceExists(workspaceId))) {
        return jsonError('workspace_not_found', 400);
      }
      const decided = await deps.grants.decideGrant({ userCode, decision, workspaceId, decidedBy: LOCAL_OWNER_EMAIL, at: clock() });
      if (!isForm) return decided ? Response.json({ ok: true, decision }, { headers: noStore }) : jsonError('grant_not_pending', 404);
      if (!decided) return htmlPage('Code not found', '<p>This code has expired or was already used.</p>', 404);
      return decision === 'approved'
        ? htmlPage('App connected', '<p>The app will receive its key on its next check. You can close this page.</p>')
        : htmlPage('Sign-in denied', '<p>The app was not connected.</p>');
    },
  });

  const deviceToken = defineTool({
    method: 'POST',
    path: '/connected-apps/device/token',
    auth: 'public',
    async handler(req) {
      const body = await readJson(req);
      const code = typeof body?.deviceCode === 'string' ? body.deviceCode : '';
      if (!DEVICE_CODE_RE.test(code)) return deviceTokenError('invalid_grant');
      let result;
      try {
        result = await deps.grants.exchangeGrant({
          deviceCodeHash: sha256Hex(code),
          now: clock(),
          minPollIntervalMs: CONNECTED_APP_POLL_INTERVAL_MS - 1_000,
        });
      } catch {
        return jsonError('authority_unavailable', 503);
      }
      switch (result.status) {
        case 'issued':
          return Response.json(
            {
              ok: true,
              accessToken: result.issued.key,
              tokenType: 'Bearer',
              app: keyView(result.issued),
              snippets: connectionSnippets(new URL(req.url).origin, result.issued.key),
            },
            { headers: noStore },
          );
        case 'pending':
          return deviceTokenError('authorization_pending');
        case 'slow_down':
          return deviceTokenError('slow_down');
        case 'denied':
          return deviceTokenError('access_denied');
        case 'expired':
          return deviceTokenError('expired_token');
        case 'invalid_scope':
          return deviceTokenError('invalid_scope', { problems: result.problems });
        default:
          return deviceTokenError('invalid_grant');
      }
    },
  });

  return [connectApp, deviceCode, devicePage, devicePending, deviceDecision, deviceToken];
}

const routes: ReadonlyArray<AnyRoute> = createConnectedAppRoutes({
  grants: new PostgresDeviceGrantStore(),
  createKey: createAppKey,
  resolveScopes: resolveAppKeyScopes,
  workspaceExists: (id) => Boolean(workspaceById(id)),
  listWorkspaces: () => readRegistry().workspaces.map((w) => ({ id: w.id, name: w.name ?? w.id })),
  isLocal: isLoopbackHost,
});

export default routes;
