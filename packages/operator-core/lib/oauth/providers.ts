/**
 * OAuth provider registry.
 *
 * Each provider is an object describing how to:
 *   - build the authorize URL
 *   - exchange a code for tokens
 *   - refresh a token
 *   - introspect a pasted token (paste-PAT scope verification)
 *
 * Substrate platform-owners register providers at boot via
 * `~/.papercusp/oauth-apps.json` (clientId + clientSecret + scopes).
 *
 * Spec: /docs/snapshots/oauth-integration#substrate-level-provider-config.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

import { CLAUDE_CODE_CLIENT_ID, CLAUDE_OAUTH_DEFAULTS } from '@papercusp/papercusp-shared/agent';
import { operatorApiBase } from '../operator-api-base';
import type { OAuthFlowPrivateContext } from './state';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  userInfoUrl?: string;
  /**
   * Token-introspection endpoint (for paste-PAT scope verification).
   * Optional — providers without one accept any pasted token.
   */
  introspectUrl?: string;
  redirectUri: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires; undefined if no expiry. */
  expiresAt?: number;
  /** Provider-reported granted scope list. */
  scopes?: string[];
}

export interface IntrospectionResult {
  /** Scopes the token actually has (may differ from what plugin requested). */
  scopes: string[];
  /** True if the token belongs to the substrate's OAuth app (vs a fine-grained PAT). */
  belongsToOurApp?: boolean;
}

export interface OAuthProvider {
  id: string;
  config: OAuthProviderConfig;
  /** Curated scopes used when the start route receives no explicit scope list. */
  defaultScopes?: readonly string[];
  /** Optional allowlist enforced by the start route before redirecting. */
  allowedScopes?: readonly string[];
  /** Create server-only state for this authorize→callback round trip. */
  createFlowContext?(): OAuthFlowPrivateContext | Promise<OAuthFlowPrivateContext>;
  buildAuthorizeUrl(scopes: string[], state: string, privateContext?: OAuthFlowPrivateContext): string;
  exchangeCode(code: string, privateContext?: OAuthFlowPrivateContext): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  introspect?(token: string): Promise<IntrospectionResult>;
}

/* ─── GitHub provider ─── */

export function makeGithubProvider(config: OAuthProviderConfig): OAuthProvider {
  return {
    id: 'github',
    config,
    buildAuthorizeUrl(scopes, state) {
      const u = new URL(config.authorizeUrl);
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUri);
      u.searchParams.set('scope', scopes.join(' '));
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode(code) {
      const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
        }),
      });
      if (!res.ok) throw new Error(`github token exchange ${res.status}`);
      const j = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
      };
      if (j.error || !j.access_token) {
        throw new Error(`github token exchange failed: ${j.error ?? 'no access_token'}`);
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
        scopes: j.scope ? j.scope.split(/[\s,]+/).filter(Boolean) : [],
      };
    },
    async refresh(refreshToken) {
      // GitHub OAuth Apps don't issue refresh tokens by default; this
      // covers GitHub Apps + new OAuth flows that opt into refresh.
      const url = config.refreshUrl ?? config.tokenUrl;
      const res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      if (!res.ok) throw new Error(`github token refresh ${res.status}`);
      const j = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (j.error || !j.access_token) {
        throw new Error(`github token refresh failed: ${j.error ?? 'no access_token'}`);
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token ?? refreshToken,
        expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      };
    },
    async introspect(token) {
      // GitHub: hit /user and read X-OAuth-Scopes header (works for any
      // token type — fine-grained PAT, classic PAT, or OAuth-app token).
      const res = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`github introspect ${res.status}`);
      const scopeHeader = res.headers.get('x-oauth-scopes') ?? '';
      const scopes = scopeHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { scopes };
    },
  };
}

/* ─── Google Workspace installed-app provider ─── */

/** Scope required by the People API connections resource used for Contacts. */
export const GOOGLE_CONTACTS_READONLY_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const GOOGLE_GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Optional Calendar write permission; requested only while the Calendar capability is enabled. */
export const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * Contacts validation must use `connections.list`. The superficially similar
 * `/v1/people/me` profile resource requires the `profile` scope and therefore
 * returns 403 for a token that correctly has only `contacts.readonly`.
 */
export const GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT = 'https://people.googleapis.com/v1/people/me/connections';

export const GOOGLE_WORKSPACE_SCOPES = [
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_CONTACTS_READONLY_SCOPE,
] as const;

export const GOOGLE_WORKSPACE_ALLOWED_SCOPES = [...GOOGLE_WORKSPACE_SCOPES, GOOGLE_CALENDAR_EVENTS_SCOPE] as const;

export const GOOGLE_OAUTH_CLIENT_PATH = join(homedir(), '.config', 'papercusp', 'google-oauth-client.json');

export interface GoogleDesktopClientConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

function googleTokenResponse(j: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}): TokenResponse {
  if (j.error || !j.access_token) {
    throw new Error(`google oauth: ${j.error_description ?? j.error ?? 'no access_token in response'}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scopes: j.scope ? j.scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

function requireGooglePkce(privateContext?: OAuthFlowPrivateContext): string {
  const verifier = privateContext?.codeVerifier?.trim();
  if (!verifier) throw new Error('google oauth missing server-side PKCE verifier');
  return verifier;
}

/** Google Workspace OAuth for a locally installed desktop client. */
export function makeGoogleProvider(config: GoogleDesktopClientConfig): OAuthProvider {
  const cfg: OAuthProviderConfig = { ...config };
  return {
    id: 'google',
    config: cfg,
    defaultScopes: GOOGLE_WORKSPACE_SCOPES,
    allowedScopes: GOOGLE_WORKSPACE_ALLOWED_SCOPES,
    createFlowContext() {
      // 64 base64url characters, within RFC 7636's 43–128 character range.
      return { codeVerifier: b64url(randomBytes(48)) };
    },
    buildAuthorizeUrl(scopes, state, privateContext) {
      const verifier = requireGooglePkce(privateContext);
      const u = new URL(config.authorizeUrl);
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('include_granted_scopes', 'true');
      u.searchParams.set('scope', (scopes.length ? scopes : GOOGLE_WORKSPACE_SCOPES).join(' '));
      u.searchParams.set('code_challenge', pkceChallenge(verifier));
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode(code, privateContext) {
      const verifier = requireGooglePkce(privateContext);
      const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof googleTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`google oauth code exchange ${res.status}`);
      return googleTokenResponse(j);
    },
    async refresh(refreshToken) {
      const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof googleTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`google oauth token refresh ${res.status}`);
      const out = googleTokenResponse(j);
      return { ...out, refreshToken: out.refreshToken ?? refreshToken };
    },
  };
}

interface GoogleDesktopClientFile {
  installed?: {
    client_id?: string;
    client_secret?: string;
    auth_uri?: string;
    token_uri?: string;
  };
}

export function googleOAuthRedirectUri(): string {
  return (
    process.env.PAPERCUSP_GOOGLE_OAUTH_REDIRECT_URI ?? new URL('/api/oauth/callback', operatorApiBase()).toString()
  );
}

/**
 * Read the well-known Google Desktop-client JSON. Absence is an expected setup
 * wall and returns null; a present but malformed/non-Desktop credential fails
 * loudly so the operator does not silently expose an unknown provider.
 */
export async function loadGoogleProviderFromDesktopClientFile(
  path = GOOGLE_OAUTH_CLIENT_PATH,
  redirectUri = googleOAuthRedirectUri(),
): Promise<OAuthProvider | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: GoogleDesktopClientFile;
  try {
    parsed = JSON.parse(raw) as GoogleDesktopClientFile;
  } catch {
    throw new Error(`google oauth client JSON is malformed: ${path}`);
  }
  const installed = parsed.installed;
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(`google oauth client must be a Desktop app credential: ${path}`);
  }
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) {
    throw new Error('google Desktop OAuth redirect must use an HTTP loopback host');
  }
  return makeGoogleProvider({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    authorizeUrl: installed.auth_uri ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: installed.token_uri ?? 'https://oauth2.googleapis.com/token',
    redirectUri: redirect.toString(),
  });
}

/* ─── Meta / Facebook provider ─── */

export const FACEBOOK_OAUTH_SCOPES = ['public_profile', 'user_posts', 'user_photos'] as const;

interface FacebookTokenBody {
  access_token?: string;
  expires_in?: number;
  error?: { message?: string };
}

function facebookToken(body: FacebookTokenBody, scopes = FACEBOOK_OAUTH_SCOPES): TokenResponse {
  const accessToken = body.access_token?.trim();
  if (!accessToken) {
    throw new Error('facebook oauth: ' + (body.error?.message ?? 'no access_token in response'));
  }
  return {
    accessToken,
    // Meta does not issue a distinct refresh token for this flow. Retaining the
    // current long-lived token in the refresh slot lets the shared token store
    // re-run the documented exchange before expiry without inventing a second
    // credential mechanism.
    refreshToken: accessToken,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    scopes: [...scopes],
  };
}

/** Facebook Login with an immediate server-side long-lived token exchange. */
export function makeFacebookProvider(config: OAuthProviderConfig): OAuthProvider {
  const exchangeLongLived = async (token: string): Promise<TokenResponse> => {
    const url = new URL(config.refreshUrl ?? config.tokenUrl);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('client_secret', config.clientSecret);
    url.searchParams.set('fb_exchange_token', token);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const body = (await response.json().catch(() => ({}))) as FacebookTokenBody;
    if (!response.ok && !body.error) throw new Error('facebook long-lived token exchange ' + response.status);
    return facebookToken(body);
  };
  return {
    id: 'facebook',
    config,
    defaultScopes: FACEBOOK_OAUTH_SCOPES,
    allowedScopes: FACEBOOK_OAUTH_SCOPES,
    buildAuthorizeUrl(scopes, state) {
      const url = new URL(config.authorizeUrl);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', (scopes.length ? scopes : FACEBOOK_OAUTH_SCOPES).join(','));
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode(code) {
      const url = new URL(config.tokenUrl);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('client_secret', config.clientSecret);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('code', code);
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const body = (await response.json().catch(() => ({}))) as FacebookTokenBody;
      if (!response.ok && !body.error) throw new Error('facebook token exchange ' + response.status);
      const shortLived = facebookToken(body);
      return exchangeLongLived(shortLived.accessToken);
    },
    refresh(refreshToken) {
      return exchangeLongLived(refreshToken);
    },
  };
}

/* ─── Claude (Anthropic subscription) provider ─── */

/**
 * The well-known PUBLIC Claude Code OAuth client (PKCE; no client secret) + its endpoints,
 * used here to mint + refresh per-account `.credentials.json` bundles for the hive inference
 * gateway (hive-inference-gateway-2026-06-09 P-003/P-004). The values — and the EI-553 record
 * of how they were verified against the live `claude` CLI — live at the LEAF
 * (`@papercusp/papercusp-shared/agent` → `claude-oauth.ts`), because the stateless
 * `anthropic-direct` transport there refreshes the same bundle on an upstream rejection and
 * papercusp-shared cannot import operator-core. Re-exported here so this module stays the
 * name every existing consumer imports — one definition, no second copy to go stale the way
 * EI-553's did.
 */
export { CLAUDE_CODE_CLIENT_ID, CLAUDE_OAUTH_DEFAULTS };

export interface ClaudeProviderConfig {
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  redirectUri?: string;
  /** The PKCE code_verifier for THIS authorize→exchange round-trip (login flow, P-004). */
  codeVerifier?: string;
}

/** base64url (no padding) of a buffer — the PKCE encoding. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Derive the S256 PKCE code_challenge from a verifier. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

function claudeTokenResponse(j: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}): TokenResponse {
  if (j.error || !j.access_token) {
    throw new Error(`claude oauth: ${j.error_description ?? j.error ?? 'no access_token in response'}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scopes: j.scope ? j.scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

/**
 * Claude/Anthropic subscription OAuth provider. `refresh()` is the P-003 deliverable —
 * a plain `grant_type=refresh_token` form post that `getOAuthToken` drives on near-expiry;
 * `buildAuthorizeUrl`/`exchangeCode` are the PKCE login round-trip (P-004), which needs the
 * `codeVerifier` set on the config for that one flow.
 */
export function makeClaudeProvider(config: ClaudeProviderConfig = {}): OAuthProvider {
  const clientId = config.clientId ?? process.env.CLAUDE_OAUTH_CLIENT_ID ?? CLAUDE_OAUTH_DEFAULTS.clientId;
  const authorizeUrl =
    config.authorizeUrl ?? process.env.CLAUDE_OAUTH_AUTHORIZE_URL ?? CLAUDE_OAUTH_DEFAULTS.authorizeUrl;
  const tokenUrl = config.tokenUrl ?? process.env.CLAUDE_OAUTH_TOKEN_URL ?? CLAUDE_OAUTH_DEFAULTS.tokenUrl;
  const redirectUri = config.redirectUri ?? process.env.CLAUDE_OAUTH_REDIRECT_URI ?? CLAUDE_OAUTH_DEFAULTS.redirectUri;
  const cfg: OAuthProviderConfig = { clientId, clientSecret: '', authorizeUrl, tokenUrl, redirectUri };

  return {
    id: 'claude',
    config: cfg,
    buildAuthorizeUrl(scopes, state) {
      const u = new URL(authorizeUrl);
      u.searchParams.set('code', 'true');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', (scopes.length ? scopes : [...CLAUDE_OAUTH_DEFAULTS.scopes]).join(' '));
      if (config.codeVerifier) {
        u.searchParams.set('code_challenge', pkceChallenge(config.codeVerifier));
        u.searchParams.set('code_challenge_method', 'S256');
      }
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode(code) {
      // claude.ai presents the code as `code#state`; the token endpoint wants them split.
      const [rawCode, stateFromCode] = code.split('#');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: rawCode,
        redirect_uri: redirectUri,
        client_id: clientId,
      });
      if (stateFromCode) body.set('state', stateFromCode);
      if (config.codeVerifier) body.set('code_verifier', config.codeVerifier);
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof claudeTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`claude oauth code exchange ${res.status}`);
      return claudeTokenResponse(j);
    },
    async refresh(refreshToken) {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof claudeTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`claude oauth token refresh ${res.status}`);
      const out = claudeTokenResponse(j);
      // Anthropic ROTATES the refresh token on use; fall back to the old one only if the
      // response omits a new one (so we never persist an empty refresh token).
      return { ...out, refreshToken: out.refreshToken ?? refreshToken };
    },
  };
}

/* ─── Registry ─── */

const registry = new Map<string, OAuthProvider>();

export function registerProvider(provider: OAuthProvider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: string): OAuthProvider | null {
  return registry.get(id) ?? null;
}

export function listProviderIds(): string[] {
  return [...registry.keys()];
}

/* ─── Bootstrap from disk ─── */

interface OAuthAppsFile {
  [providerId: string]: {
    clientId: string;
    clientSecret?: string;
    clientSecretFile?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;
    userInfoUrl?: string;
    introspectUrl?: string;
    redirectUri: string;
  };
}

const DEFAULT_GITHUB_ENDPOINTS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userInfoUrl: 'https://api.github.com/user',
};

const DEFAULT_FACEBOOK_ENDPOINTS = {
  authorizeUrl: 'https://www.facebook.com/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/oauth/access_token',
};

async function readClientSecret(entry: OAuthAppsFile[string]): Promise<string> {
  if (entry.clientSecret) return entry.clientSecret;
  if (entry.clientSecretFile) {
    const raw = await fs.readFile(entry.clientSecretFile, 'utf8');
    return raw.trim();
  }
  throw new Error('OAuth provider missing clientSecret / clientSecretFile');
}

/**
 * Load oauth-apps.json from `$PAPERCUSP_HOME` (or `~/.papercusp`) and
 * register each provider. Idempotent — calling again replaces existing
 * registrations.
 */
export async function loadAndRegisterProvidersFromDisk(
  rootDir?: string,
  googleClientPath: string | null = GOOGLE_OAUTH_CLIENT_PATH,
): Promise<string[]> {
  const { papercuspRoot } = await import('../papercusp-root');
  const root = rootDir ?? papercuspRoot();
  const path = join(root, 'oauth-apps.json');
  let raw: string | null = null;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    // No legacy provider file configured. Google has its own well-known path.
  }
  const registered: string[] = [];
  let parsed: OAuthAppsFile = {};
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw) as OAuthAppsFile;
    } catch {
      parsed = {};
    }
    for (const [id, entry] of Object.entries(parsed)) {
      let clientSecret: string;
      try {
        clientSecret = await readClientSecret(entry);
      } catch {
        continue;
      }
      if (id === 'github') {
        const cfg: OAuthProviderConfig = {
          clientId: entry.clientId,
          clientSecret,
          authorizeUrl: entry.authorizeUrl ?? DEFAULT_GITHUB_ENDPOINTS.authorizeUrl,
          tokenUrl: entry.tokenUrl ?? DEFAULT_GITHUB_ENDPOINTS.tokenUrl,
          refreshUrl: entry.refreshUrl,
          userInfoUrl: entry.userInfoUrl ?? DEFAULT_GITHUB_ENDPOINTS.userInfoUrl,
          introspectUrl: entry.introspectUrl,
          redirectUri: entry.redirectUri,
        };
        registerProvider(makeGithubProvider(cfg));
        registered.push('github');
      }
      if (id === 'facebook') {
        const cfg: OAuthProviderConfig = {
          clientId: entry.clientId,
          clientSecret,
          authorizeUrl: entry.authorizeUrl ?? DEFAULT_FACEBOOK_ENDPOINTS.authorizeUrl,
          tokenUrl: entry.tokenUrl ?? DEFAULT_FACEBOOK_ENDPOINTS.tokenUrl,
          refreshUrl: entry.refreshUrl ?? entry.tokenUrl ?? DEFAULT_FACEBOOK_ENDPOINTS.tokenUrl,
          userInfoUrl: entry.userInfoUrl ?? 'https://graph.facebook.com/me',
          redirectUri: entry.redirectUri,
        };
        registerProvider(makeFacebookProvider(cfg));
        registered.push('facebook');
      }
      // V2: slack, linear, notion, jira providers.
    }
  }
  if (googleClientPath !== null) {
    const google = await loadGoogleProviderFromDesktopClientFile(googleClientPath);
    if (google) {
      registerProvider(google);
      registered.push('google');
    }
  }
  return registered;
}

/** Test-only: clear the registry. */
export function __resetRegistryForTest(): void {
  registry.clear();
}

/* ─── Scope verification ─── */

export type ScopeVerificationOutcome =
  | { kind: 'exact' }
  | { kind: 'superset'; extra: string[] }
  | { kind: 'subset'; missing: string[] };

export function compareScopes(granted: string[], required: string[]): ScopeVerificationOutcome {
  const g = new Set(granted);
  const missing = required.filter((s) => !g.has(s));
  if (missing.length > 0) return { kind: 'subset', missing };
  const r = new Set(required);
  const extra = granted.filter((s) => !r.has(s));
  if (extra.length > 0) return { kind: 'superset', extra };
  return { kind: 'exact' };
}
