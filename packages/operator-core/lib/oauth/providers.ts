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
import { createHash } from 'node:crypto';

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
  buildAuthorizeUrl(scopes: string[], state: string): string;
  exchangeCode(code: string): Promise<TokenResponse>;
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
      const scopes = scopeHeader.split(',').map((s) => s.trim()).filter(Boolean);
      return { scopes };
    },
  };
}

/* ─── Claude (Anthropic subscription) provider ─── */

/**
 * The well-known PUBLIC Claude Code OAuth client (PKCE; no client secret). This is the
 * same client id the `claude` CLI uses, and a refresh token minted under it can ONLY be
 * refreshed under it (Anthropic binds the refresh grant to the minting client_id). Used
 * by the hive inference gateway to mint + refresh per-account `.credentials.json` bundles
 * (hive-inference-gateway-2026-06-09 P-003/P-004). Endpoints are overridable via env so we
 * can switch the older `console.anthropic.com` host to the newer `platform.claude.com` one
 * without a code change.
 */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_DEFAULTS = {
  clientId: CLAUDE_CODE_CLIENT_ID,
  /** claude.ai issues the auth code for a Max/Pro subscription login… */
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  /** …and console exchanges + refreshes it (form-encoded; JSON bodies can time out). */
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'] as const,
} as const;

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
  const authorizeUrl = config.authorizeUrl ?? process.env.CLAUDE_OAUTH_AUTHORIZE_URL ?? CLAUDE_OAUTH_DEFAULTS.authorizeUrl;
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
export async function loadAndRegisterProvidersFromDisk(rootDir?: string): Promise<string[]> {
  const { papercuspRoot } = await import('../papercusp-root');
  const root = rootDir ?? papercuspRoot();
  const path = join(root, 'oauth-apps.json');
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return []; // no providers configured
  }
  let parsed: OAuthAppsFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const registered: string[] = [];
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
    // V2: slack, linear, notion, jira providers.
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

export function compareScopes(
  granted: string[],
  required: string[],
): ScopeVerificationOutcome {
  const g = new Set(granted);
  const missing = required.filter((s) => !g.has(s));
  if (missing.length > 0) return { kind: 'subset', missing };
  const r = new Set(required);
  const extra = granted.filter((s) => !r.has(s));
  if (extra.length > 0) return { kind: 'superset', extra };
  return { kind: 'exact' };
}
