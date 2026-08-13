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

/**
 * Normalize public Responses API bodies for the proprietary ChatGPT subscription
 * backend, which accepts only the canonical input-item LIST and requires `store:false`.
 *
 * The public API defines a string as one user text message, so the expansion is
 * semantics-preserving. ChatGPT subscription requests cannot use API-side response
 * storage, so force that backend contract here instead of making every compatible
 * gateway client know it. Bodies that already use list input and `store:false` are
 * returned byte-identically, as are malformed or non-object bodies. This belongs at
 * the ChatGPT OAuth seam (not the bearer OpenAI path): api.openai.com already accepts
 * the shorthand and its own storage semantics, while chatgpt.com rejects incompatible
 * bodies with `400 Input must be a list` / `400 Store must be set to false`.
 */
export function normalizeCodexChatGptResponsesBody(
  bodyBuf: Buffer,
): { body: Buffer; inputNormalized: boolean } {
  if (!bodyBuf.length) return { body: bodyBuf, inputNormalized: false };
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: bodyBuf, inputNormalized: false };
    }
    const body = parsed as Record<string, unknown>;
    const inputNormalized = typeof body.input === 'string';
    if (inputNormalized) {
      body.input = [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }];
    }
    const storeNormalized = body.store !== false;
    if (storeNormalized) body.store = false;
    if (!inputNormalized && !storeNormalized) return { body: bodyBuf, inputNormalized: false };
    return { body: Buffer.from(JSON.stringify(body), 'utf8'), inputNormalized };
  } catch {
    return { body: bodyBuf, inputNormalized: false };
  }
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

// ---------------------------------------------------------------------------
// Codex model preflight (EI-20362893066852316)
// ---------------------------------------------------------------------------

export type CodexModelPreflight =
  | { verdict: 'ok'; status: number }
  | { verdict: 'refused'; status: number; detail: string }
  | { verdict: 'unknown'; status?: number; detail: string };

/** Matches the ChatGPT backend's definitive model refusal, e.g.
 *  `"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."` */
const MODEL_REFUSAL_RE = /model is not supported|unsupported model|unknown model/i;

/**
 * EI-20362893066852316: ONE tiny streaming request against the ChatGPT codex backend to answer
 * "will this subscription actually serve `model`?" BEFORE a fleet wave opens N terminals onto a
 * per-turn refusal (burned a 4-member wave on bare 'gpt-5.6', 2026-08-13 — working ids are
 * family-suffixed, e.g. gpt-5.6-sol).
 *
 * FAIL-OPEN BY DESIGN: only a definitive 4xx whose body matches the model-refusal shape returns
 * `refused`; a transport error, 401/403 (auth), 429 (capacity), 5xx, or an unrecognized body
 * returns `unknown` and the caller should PROCEED (the preflight must never become a new way for
 * a healthy launch to fail). A 200 means the stream opened — we cancel it immediately.
 */
export async function preflightCodexModel(
  home: string,
  model: string,
  deps: {
    fetchImpl?: typeof fetch;
    resolveAuth?: (home: string) => Promise<{ accessToken: string; accountId: string | null }>;
    timeoutMs?: number;
  } = {},
): Promise<CodexModelPreflight> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  let accessToken: string;
  let accountId: string | null;
  try {
    const auth = await (deps.resolveAuth ?? resolveCodexAccessToken)(home);
    accessToken = auth.accessToken;
    accountId = auth.accountId ?? null;
  } catch (e) {
    return { verdict: 'unknown', detail: `oauth resolve failed: ${(e as Error).message}` };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('codex model preflight timeout')), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(`${CODEX_CHATGPT_BACKEND_BASE}/responses`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
        'openai-beta': CODEX_OPENAI_BETA,
        originator: CODEX_ORIGINATOR,
      },
      body: JSON.stringify({
        model,
        stream: true,
        store: false,
        instructions: 'You are a model preflight.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '.' }] }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        include: [],
      }),
    } as RequestInit);
    if (res.ok) {
      // Model accepted — the stream opened. Cancel it; the reply is irrelevant.
      try { ac.abort(); } catch { /* settled */ }
      void res.body?.cancel().catch(() => undefined);
      return { verdict: 'ok', status: res.status };
    }
    const bodyText = await res.text().catch(() => '');
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429 && MODEL_REFUSAL_RE.test(bodyText)) {
      return { verdict: 'refused', status: res.status, detail: bodyText.slice(0, 300) };
    }
    return { verdict: 'unknown', status: res.status, detail: bodyText.slice(0, 200) };
  } catch (e) {
    return { verdict: 'unknown', detail: `preflight transport: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Codex rate-limit header dialect (WI-38582)
// ---------------------------------------------------------------------------

/** The account-pool window projection shape (structurally = capacity-probe's `CapacityWindows`;
 *  declared here to keep this module dependency-free of gateway/probe). */
export interface CodexCapacityWindows {
  utilization?: number;
  windowResetAt?: number;
  utilization7d?: number;
  windowResetAt7d?: number;
}

/** Windows at/under this many minutes land in the SHORT (5h) projection slot; longer ones in the
 *  7d slot. The boundary only has to separate ~300min (5h) from ~10080min (weekly) cleanly. */
const CODEX_SHORT_WINDOW_MAX_MINUTES = 720;

function codexWindowSlot(
  h: Record<string, string | undefined>,
  prefix: 'x-codex-primary' | 'x-codex-secondary',
  nowMs: number,
): { short: boolean; utilization: number; resetAt?: number } | null {
  const usedRaw = h[`${prefix}-used-percent`];
  const minutesRaw = h[`${prefix}-window-minutes`];
  if (usedRaw === undefined || usedRaw === '') return null;
  const used = Number(usedRaw);
  const minutes = Number(minutesRaw ?? '');
  // A zero/absent window length marks an inactive slot (observed live: pro plans report
  // `x-codex-secondary-window-minutes: 0` with an empty reset — that is "no such window",
  // not a 0-minute window).
  if (!Number.isFinite(used) || !Number.isFinite(minutes) || minutes <= 0) return null;
  let resetAt: number | undefined;
  const resetAtSec = Number(h[`${prefix}-reset-at`] ?? '');
  const resetAfterSec = Number(h[`${prefix}-reset-after-seconds`] ?? '');
  if (Number.isFinite(resetAtSec) && resetAtSec > 0) resetAt = resetAtSec * 1000;
  else if (Number.isFinite(resetAfterSec) && resetAfterSec > 0) resetAt = nowMs + resetAfterSec * 1000;
  return { short: minutes <= CODEX_SHORT_WINDOW_MAX_MINUTES, utilization: Math.max(0, used) / 100, resetAt };
}

/**
 * PURE: the ChatGPT codex backend's rate-limit response headers → the SAME account-pool window
 * projection the Anthropic unified-window parsers feed (WI-38582 — codex accounts read
 * `never-observed` forever because nothing ever parsed this dialect).
 *
 * Dialect (verified live against `chatgpt.com/backend-api/codex/responses`, 2026-08-13):
 *   x-codex-primary-used-percent: 0..100        x-codex-secondary-used-percent
 *   x-codex-primary-window-minutes: e.g. 300|10080 (0 ⇒ slot inactive)
 *   x-codex-primary-reset-at: epoch SECONDS      x-codex-primary-reset-after-seconds
 * Slots are classified by WINDOW LENGTH, not by primary/secondary position: a pro plan reports
 * its weekly window as PRIMARY (10080 min) with no secondary, while plus plans use primary=5h,
 * secondary=weekly. `used-percent` is 0..100 → recorded as a 0..1 fraction; `reset-at` seconds →
 * epoch ms. Returns {} when no codex rate-limit header is present.
 */
export function parseCodexRateLimitHeaders(
  h: Record<string, string | undefined>,
  nowMs: number = Date.now(),
): CodexCapacityWindows {
  const out: CodexCapacityWindows = {};
  for (const prefix of ['x-codex-primary', 'x-codex-secondary'] as const) {
    const slot = codexWindowSlot(h, prefix, nowMs);
    if (!slot) continue;
    if (slot.short) {
      if (out.utilization === undefined) {
        out.utilization = slot.utilization;
        if (slot.resetAt !== undefined) out.windowResetAt = slot.resetAt;
      }
    } else if (out.utilization7d === undefined) {
      out.utilization7d = slot.utilization;
      if (slot.resetAt !== undefined) out.windowResetAt7d = slot.resetAt;
    }
  }
  return out;
}
