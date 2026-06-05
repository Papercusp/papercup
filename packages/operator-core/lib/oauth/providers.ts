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
