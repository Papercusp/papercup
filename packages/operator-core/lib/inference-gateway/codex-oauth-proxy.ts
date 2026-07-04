/**
 * codex-oauth-proxy.ts — the PURE, testable half of the codex ChatGPT-subscription
 * OAuth STREAMING proxy (WI-2198, owner-chosen Option B 2026-07-04).
 *
 * THE PROBLEM
 * -----------
 * A codex FLEET agent runs the real `codex` CLI configured with a custom
 * `model_provider` (papercusp-codex-gateway, `wire_api = "responses"`) pointed at
 * OUR gateway — so it STREAMS native Responses requests to `/v1/responses`. The
 * pre-existing bridge (`codex-cli-bridge.ts`) serves that by shelling out to
 * `codex exec` ONE-SHOT and REJECTS `stream:true` — fine for the low-volume
 * in-process scout/judge callers, useless for a streaming fleet agent.
 *
 * THE FIX (this module + `serveCodexOAuthProxy` in gateway.ts)
 * -----------------------------------------------------------
 * A TRANSPARENT reverse-proxy: forward the codex CLI's native Responses request
 * straight to the real ChatGPT backend (`chatgpt.com/backend-api/codex/responses`)
 * with the ChatGPT-subscription OAuth bearer injected from `~/.codex/auth.json`,
 * stream the SSE back untouched, and refresh the token on expiry/401. The codex
 * CLI keeps ALL of its own multi-turn / tool-call / session state — the gateway is
 * STATELESS per request; it only swaps auth in and meters/paces. This module owns
 * the auth + header + refresh logic (unit-tested here); gateway.ts owns the
 * streaming plumbing (reusing its stall-guards + AIMD + admission slot).
 *
 * REVERSE-ENGINEERED TRANSPORT (from ~/.codex/auth.json + the codex binary, 2026-07-04):
 *   auth.json  = { auth_mode:"chatgpt", tokens:{ access_token, refresh_token,
 *                  account_id, id_token }, last_refresh }
 *   backend    = https://chatgpt.com/backend-api/codex/responses
 *   refresh    = form-urlencoded POST https://auth.openai.com/oauth/token
 *                (grant_type=refresh_token, refresh_token, client_id)
 *   headers    = Authorization: Bearer <access_token>, ChatGPT-Account-Id,
 *                OpenAI-Beta: responses=experimental, originator: codex_cli_rs
 *
 * Every constant is env-overridable so a rotated client_id / moved endpoint is a
 * config change, not a redeploy (the OAuth transport is proprietary + unversioned).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The ChatGPT backend that serves codex Responses for ChatGPT-subscription auth. */
export const CODEX_CHATGPT_BACKEND_BASE =
  process.env.CODEX_CHATGPT_BACKEND_BASE || 'https://chatgpt.com/backend-api/codex';

/** OAuth token endpoint for the refresh_token grant. */
export const CODEX_OAUTH_TOKEN_URL =
  process.env.CODEX_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token';

/** The codex CLI's public OAuth client_id (from the codex binary; well-known).
 *  Env-overridable because OpenAI can rotate it and it is undocumented. */
export const CODEX_OAUTH_CLIENT_ID =
  process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';

/** codex stamps this originator on every ChatGPT-backend request. */
export const CODEX_ORIGINATOR = process.env.CODEX_ORIGINATOR || 'codex_cli_rs';

/** The OpenAI-Beta header value codex sends for the Responses backend. */
export const CODEX_OPENAI_BETA = process.env.CODEX_OPENAI_BETA || 'responses=experimental';

/** Refresh proactively when the access token expires within this window (ms). */
const EXPIRY_SKEW_MS = 60_000;

export interface CodexAuth {
  authMode: string | null;
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  idToken: string | null;
  lastRefresh: string | null;
}

/** Absolute path to a codex home's auth.json. */
export function codexAuthPath(home: string): string {
  return path.join(home, 'auth.json');
}

/** Read + validate a codex home's auth.json. Returns null if absent / malformed /
 *  not a usable ChatGPT-subscription credential (no access_token). */
export async function readCodexAuth(home: string): Promise<CodexAuth | null> {
  let raw: string;
  try {
    raw = await fs.readFile(codexAuthPath(home), 'utf8');
  } catch {
    return null;
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const obj = j as Record<string, unknown>;
  const tokens = (obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : {}) as Record<string, unknown>;
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  if (!accessToken) return null;
  return {
    authMode: typeof obj.auth_mode === 'string' ? obj.auth_mode : null,
    accessToken,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    lastRefresh: typeof obj.last_refresh === 'string' ? obj.last_refresh : null,
  };
}

/** Decode a JWT's `exp` (seconds since epoch) without verifying the signature.
 *  Returns null for a non-JWT / unparseable token (→ treat as never-proactively-expiring;
 *  the 401-retry backstop still covers a genuinely-expired token). */
export function jwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True if the access token is expired or within EXPIRY_SKEW_MS of expiry. `nowMs`
 *  is injectable for tests. A token with no decodable exp is treated as NOT expired
 *  (the 401 backstop handles it) so we never refresh-spam an opaque token. */
export function accessTokenExpired(accessToken: string, nowMs: number): boolean {
  const exp = jwtExpMs(accessToken);
  if (exp === null) return false;
  return nowMs >= exp - EXPIRY_SKEW_MS;
}

/** The upstream URL for an incoming gateway Responses request: rewrite the codex
 *  CLI's `/v1/responses[...]` onto the ChatGPT backend base (which already ends in
 *  `/codex`), preserving any query string. `/v1/responses` → `<base>/responses`. */
export function codexBackendUrl(incomingUrl: string): string {
  const stripped = incomingUrl.replace(/^\/v1/, '');
  return `${CODEX_CHATGPT_BACKEND_BASE}${stripped}`;
}

/** Build the upstream request headers: start from the codex CLI's incoming headers
 *  (minus hop-by-hop / auth / host, which the caller strips), then inject the
 *  ChatGPT-subscription OAuth bearer + account + originator. Session/thread ids the
 *  codex CLI already sent as headers pass through untouched. */
export function buildCodexUpstreamHeaders(args: {
  base: Record<string, string>;
  accessToken: string;
  accountId: string | null;
}): Record<string, string> {
  const h: Record<string, string> = { ...args.base };
  h.authorization = `Bearer ${args.accessToken}`;
  if (args.accountId) h['chatgpt-account-id'] = args.accountId;
  // Only set the codex signatures the CLI didn't already provide (it usually does).
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'originator')) h.originator = CODEX_ORIGINATOR;
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'openai-beta')) h['openai-beta'] = CODEX_OPENAI_BETA;
  h['accept-encoding'] = 'identity';
  return h;
}

// Per-home in-flight refresh, so 10 fleet agents sharing one auth.json can't stampede
// the OAuth endpoint or clobber each other's write — concurrent callers await the same
// promise. Keyed by home; cleared when it settles.
const refreshInFlight = new Map<string, Promise<CodexAuth>>();

export interface RefreshOpts {
  clientId?: string;
  fetchImpl?: typeof fetch;
  /** Skip the atomic write-back to auth.json (tests). */
  noPersist?: boolean;
}

/** Refresh the access token via the refresh_token grant, persist the new tokens back
 *  to auth.json atomically, and return the fresh CodexAuth. Coalesced per home. Re-reads
 *  auth.json first so a token codex itself already refreshed is picked up without a call. */
export function refreshCodexToken(home: string, current: CodexAuth, opts: RefreshOpts = {}): Promise<CodexAuth> {
  const existing = refreshInFlight.get(home);
  if (existing) return existing;
  const p = doRefresh(home, current, opts).finally(() => {
    if (refreshInFlight.get(home) === p) refreshInFlight.delete(home);
  });
  refreshInFlight.set(home, p);
  return p;
}

async function doRefresh(home: string, current: CodexAuth, opts: RefreshOpts): Promise<CodexAuth> {
  // Someone (codex itself, or a peer) may have refreshed the shared file already.
  const onDisk = await readCodexAuth(home);
  if (onDisk && onDisk.accessToken !== current.accessToken && !accessTokenExpired(onDisk.accessToken, Date.now())) {
    return onDisk;
  }
  const refreshToken = (onDisk?.refreshToken ?? current.refreshToken) || '';
  if (!refreshToken) throw new Error('codex-oauth-proxy: no refresh_token in auth.json — re-login with `codex`');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientId = opts.clientId ?? CODEX_OAUTH_CLIENT_ID;
  const res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`codex-oauth-proxy: token refresh failed ${res.status} ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!body.access_token) throw new Error('codex-oauth-proxy: token refresh returned no access_token');
  const next: CodexAuth = {
    authMode: current.authMode ?? 'chatgpt',
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    accountId: onDisk?.accountId ?? current.accountId,
    idToken: body.id_token ?? onDisk?.idToken ?? current.idToken,
    lastRefresh: new Date().toISOString(),
  };
  if (!opts.noPersist) await persistCodexAuth(home, next);
  return next;
}

/** Atomically write the refreshed tokens back to auth.json (tmp + rename) so a
 *  concurrent reader (codex CLI / a peer gateway) never sees a half-written file. */
export async function persistCodexAuth(home: string, auth: CodexAuth): Promise<void> {
  const target = codexAuthPath(home);
  // Preserve any unknown top-level fields codex may write.
  let prior: Record<string, unknown> = {};
  try {
    prior = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh / unreadable — write a minimal valid shape */
  }
  const merged = {
    ...prior,
    auth_mode: auth.authMode ?? 'chatgpt',
    tokens: {
      ...((prior.tokens && typeof prior.tokens === 'object' ? prior.tokens : {}) as Record<string, unknown>),
      access_token: auth.accessToken,
      refresh_token: auth.refreshToken,
      account_id: auth.accountId,
      id_token: auth.idToken,
    },
    last_refresh: auth.lastRefresh,
  };
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/** Resolve a usable access token for a home: read auth.json, refresh proactively if
 *  the token is expired/near-expiry. Returns { auth } or throws with a clear reason.
 *  The 401-on-request backstop (in gateway.ts) covers a token that expires between
 *  this check and the upstream call. */
export async function resolveCodexAccessToken(
  home: string,
  opts: RefreshOpts & { nowMs?: number } = {},
): Promise<CodexAuth> {
  const auth = await readCodexAuth(home);
  if (!auth) throw new Error(`codex-oauth-proxy: no usable auth.json at ${codexAuthPath(home)}`);
  if (accessTokenExpired(auth.accessToken, opts.nowMs ?? Date.now())) {
    return refreshCodexToken(home, auth, opts);
  }
  return auth;
}

/** Test-only: clear the per-home refresh coalescing map. */
export function __resetCodexRefreshState(): void {
  refreshInFlight.clear();
}
