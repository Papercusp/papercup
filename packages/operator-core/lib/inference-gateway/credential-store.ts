/**
 * Credential resolution + automated refresh for the hive inference gateway
 * (hive-inference-gateway-2026-06-09 P-003).
 *
 * The gateway is the SOLE egress to api.anthropic.com for a machine's bees, so it holds the
 * bound account's OAuth and injects it. A bound account is named by an account-pool
 * `credentialRef` (the same shape the frame-installer / `accounts:register` use):
 *
 *   - `token:<path>`  — a long-lived `claude setup-token` (`sk-ant-oat…`). No expiry, no
 *                       refresh; used as the bearer verbatim. The proven owner-add channel.
 *   - `file:<path>` / absolute / `~` — a `.credentials.json` bundle (a `claudeAiOauth` block:
 *                       accessToken + refreshToken + expiresAt). Access tokens are short-lived
 *                       (~hours), so the gateway REFRESHES them transparently via the claude
 *                       OAuth provider (`grant_type=refresh_token`, same client_id that minted
 *                       them) and rewrites the bundle in place — the piece the pool lacked.
 *
 * Refresh reuses `oauth/token.ts getOAuthToken` (near-expiry refresh + concurrent-refresh
 * dedup), backed by a bundle-shaped `TokenStorage`. A small in-memory token cache keeps the
 * hot proxy path off disk between refreshes.
 */
import { promises as fs } from 'node:fs';
import { getOAuthToken, type TokenStorage } from '../oauth/token';
import { getProvider, registerProvider, makeClaudeProvider } from '../oauth/providers';

/** The OAuth beta flag a subscription (non-API-key) request must carry. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** Refresh this far before the access token's expiry (mirrors getOAuthToken's window). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** The on-disk `~/.claude/.credentials.json` bundle shape. */
export interface ClaudeCredentialBundle {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string;
    /** Epoch ms. */
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

let claudeProviderRegistered = false;
/** Idempotently register the default (refresh-capable) claude provider in the OAuth registry. */
export function ensureClaudeProvider(): void {
  if (claudeProviderRegistered) return;
  if (!getProvider('claude')) registerProvider(makeClaudeProvider());
  claudeProviderRegistered = true;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p;
}

/** Parse a credentialRef into its channel + path (mirrors `resolveCredential`). Every account is a
 *  consumer Claude Max OAuth subscription — `token:` (a `claude setup-token`) or `file:` (a
 *  refreshable `.credentials.json` bundle). There is NO static-API-key channel: this deployment has
 *  no `ANTHROPIC_API_KEY`, and a raw billed key would 400 against the subscription-only
 *  `oauth-2025-04-20` beta the gateway sends. */
export function parseCredentialRef(ref: string): { kind: 'token' | 'file' | 'env'; path: string } {
  if (ref.startsWith('token:')) return { kind: 'token', path: expandHome(ref.slice(6)) };
  if (ref.startsWith('file:')) return { kind: 'file', path: expandHome(ref.slice(5)) };
  if (ref.startsWith('env:')) return { kind: 'env', path: ref.slice(4).trim() };
  if (ref.startsWith('/') || ref.startsWith('~')) return { kind: 'file', path: expandHome(ref) };
  throw new Error(`inference-gateway: unsupported credentialRef '${ref}' (expected token:/file:/path — Claude Max OAuth only)`);
}

/**
 * A `TokenStorage` backed by a `.credentials.json` bundle file. Maps the helper's
 * `(field, field_refresh, field_expires_at)` config keys onto `claudeAiOauth.*` and persists
 * a refresh by rewriting the bundle atomically (0600), preserving the other bundle fields.
 */
export function bundleTokenStorage(path: string): TokenStorage {
  const FIELD = 'access';
  return {
    async read() {
      const bundle = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
      const o = bundle.claudeAiOauth ?? ({} as ClaudeCredentialBundle['claudeAiOauth']);
      return {
        [FIELD]: o.accessToken,
        [`${FIELD}_refresh`]: o.refreshToken,
        [`${FIELD}_expires_at`]: o.expiresAt ?? null,
      };
    },
    async update(_plugin, _harness, patch) {
      const bundle = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
      const o = bundle.claudeAiOauth ?? ({} as ClaudeCredentialBundle['claudeAiOauth']);
      if (typeof patch[FIELD] === 'string') o.accessToken = patch[FIELD] as string;
      if (typeof patch[`${FIELD}_refresh`] === 'string') o.refreshToken = patch[`${FIELD}_refresh`] as string;
      if (`${FIELD}_expires_at` in patch) {
        const v = patch[`${FIELD}_expires_at`];
        o.expiresAt = typeof v === 'number' ? v : undefined;
      }
      bundle.claudeAiOauth = o;
      const tmp = `${path}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(bundle, null, 2), { mode: 0o600 });
      await fs.rename(tmp, path);
    },
  };
}

export interface CredentialResolver {
  /** A fresh bearer token (refreshing a near-expiry bundle transparently). */
  current(): Promise<string>;
  /** Force the next `current()` to re-read/refresh (call after an upstream 401). */
  invalidate(): void;
  /** The credential channel: `token` (a setup-token, never refreshes) or `file` (a bundle the
   *  gateway refreshes near expiry). Both are subscription OAuth → Bearer + the oauth beta. */
  readonly kind: 'token' | 'file';
}

/**
 * Collapse a raw credential string to the single header-safe token it is meant to be. A bearer is
 * one RFC 7230 field token — but a hand-pasted credential wrapped by a terminal carries an
 * EMBEDDED newline that `trim()` cannot see. Left in, it is injected verbatim into the
 * `Authorization` header and every request on that account dies with
 * `Headers.append: … is an invalid header value` (502 for the caller) — the 2026-07-03 incident:
 * three pool accounts had never served a single request because their token files were pasted
 * with a mid-token line wrap. Stripping ALL whitespace reconstructs the intended token (the
 * token alphabet has no whitespace), so normalize every read through this.
 */
export function normalizeBearerToken(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * Redact credential material from a string bound for a client-facing error body or a log line.
 * The 2026-07-03 `Headers.append: "Bearer sk-ant-oat01-…" is an invalid header value` 502 echoed a
 * LIVE account token verbatim into every caller's terminal + journald — an upstream/runtime error
 * message is never guaranteed secret-free, so every gateway error surface must pass through this.
 * Keeps a short identifying prefix so operators can still tell WHICH credential is involved.
 */
export function scrubSecrets(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{12,}/g, (m) => `${m.slice(0, 12)}…[redacted]`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]');
}

function pickBearerString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return normalizeBearerToken(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of ['value', 'apiKey', 'api_key', 'key']) {
    const candidate = rec[key];
    if (typeof candidate === 'string' && candidate.trim()) return normalizeBearerToken(candidate);
  }
  return undefined;
}

function extractBearerFromFile(raw: string, path: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`inference-gateway: empty bearer token at ${path}`);
  if (!trimmed.startsWith('{')) return normalizeBearerToken(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } };
    const apiKey = pickBearerString(parsed.OPENAI_API_KEY);
    if (apiKey) return apiKey;
    if (parsed.auth_mode === 'chatgpt') {
      throw new Error(
        `inference-gateway: Codex/OpenAI gateway credential at ${path} is a ChatGPT auth.json; ` +
          'register an OpenAI API bearer via token:<path> or env:NAME instead',
      );
    }
    const token = parsed?.tokens?.access_token;
    if (typeof token === 'string' && token.trim()) return normalizeBearerToken(token);
  } catch (e) {
    if (e instanceof Error && e.message.includes('ChatGPT auth.json')) throw e;
    throw new Error(`inference-gateway: bearer credential JSON at ${path} failed to parse`);
  }
  throw new Error(`inference-gateway: bearer credential JSON at ${path} has no tokens.access_token`);
}

export async function credentialRefSupportsOpenAiBearer(credentialRef: string): Promise<boolean> {
  try {
    await makeBearerCredentialResolver(credentialRef).current();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a resolver for one account's credentialRef. `token:` returns the staged setup-token
 * verbatim (cached; no expiry). `file:` returns the bundle's access token, refreshing via the
 * claude provider when within REFRESH_SKEW_MS of expiry; an in-memory {token, expiresAt} cache
 * keeps the per-request path off disk between refreshes. `harnessKey` scopes the
 * concurrent-refresh dedup so distinct accounts never share a refresh.
 */
export function makeCredentialResolver(credentialRef: string, harnessKey?: string): CredentialResolver {
  ensureClaudeProvider();
  const { kind, path } = parseCredentialRef(credentialRef);
  if (kind === 'env') {
    throw new Error(`inference-gateway: unsupported Claude credentialRef '${credentialRef}' (env: is only valid for bearer accounts)`);
  }
  const dedupKey = harnessKey ?? path;

  let cachedToken: string | undefined;
  let cachedExpiresAt = 0; // epoch ms; 0 = unknown/no-expiry

  return {
    kind,
    invalidate() {
      cachedToken = undefined;
      cachedExpiresAt = 0;
    },
    async current() {
      if (kind === 'token') {
        if (cachedToken) return cachedToken;
        cachedToken = normalizeBearerToken(await fs.readFile(path, 'utf8'));
        if (!cachedToken) throw new Error(`inference-gateway: empty setup-token at ${path}`);
        return cachedToken;
      }
      // file: bundle — serve the cache until near expiry, else refresh-on-read via getOAuthToken.
      const now = Date.now();
      if (cachedToken && (cachedExpiresAt === 0 || cachedExpiresAt - now > REFRESH_SKEW_MS)) {
        return cachedToken;
      }
      const token = await getOAuthToken(
        {
          plugin: 'inference-gateway',
          harness: dedupKey,
          storage: bundleTokenStorage(path),
          resolveProvider: () => ({ provider: 'claude' }),
        },
        'access',
      );
      if (!token) throw new Error(`inference-gateway: no access token in bundle ${path}`);
      const normalized = normalizeBearerToken(token);
      // Re-read the (possibly refreshed) expiry to set the cache window.
      try {
        const bundle = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
        cachedExpiresAt = bundle.claudeAiOauth?.expiresAt ?? 0;
      } catch {
        cachedExpiresAt = 0;
      }
      cachedToken = normalized;
      return normalized;
    },
  };
}

export function makeBearerCredentialResolver(credentialRef: string): CredentialResolver {
  const { kind, path } = parseCredentialRef(credentialRef);
  let cachedToken: string | undefined;
  return {
    kind: kind === 'env' ? 'token' : kind,
    invalidate() {
      cachedToken = undefined;
    },
    async current() {
      if (cachedToken) return cachedToken;
      if (kind === 'env') {
        const value = normalizeBearerToken(process.env[path] ?? '');
        if (!value) throw new Error(`inference-gateway: env credential ${path} is empty or unset`);
        cachedToken = value;
        return cachedToken;
      }
      cachedToken = extractBearerFromFile(await fs.readFile(path, 'utf8'), path);
      return cachedToken;
    },
  };
}

/**
 * Build the `anthropic-beta` header to send upstream on an OAuth (subscription) request: the
 * client's existing beta flags PLUS the required `oauth-2025-04-20`, de-duplicated.
 */
export function withOAuthBeta(incoming: string | null | undefined): string {
  const flags = new Set(
    (incoming ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  flags.add(CLAUDE_OAUTH_BETA);
  return [...flags].join(',');
}
