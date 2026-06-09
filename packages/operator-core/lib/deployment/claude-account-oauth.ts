/**
 * claude-account-oauth.ts — mint a Claude SUBSCRIPTION OAuth credential for a SEPARATE account
 * (a per-machine / remote-frame DEPLOY credential), driven from the operator UI's "Deploy Accounts"
 * flow. The credential bundle this writes is exactly the `~/.claude/.credentials.json` shape that
 * `account-pool.credentialRef = file:<path>` (+ the deploy frame-installer) already consume.
 *
 * Why a UI flow and not pure automation: `claude.ai` is behind Cloudflare's anti-bot challenge,
 * which hard-blocks headless browsers — so the LOGIN must happen in the owner's real browser. This
 * module owns the parts around that one manual step: PKCE + authorize-URL generation and the
 * server-side token exchange + bundle write. It NEVER touches this machine's `~/.claude` login.
 *
 * Public-client PKCE: the `code_verifier` is generated here, handed to the trusted admin UI, and
 * sent back at exchange time (standard SPA/public-client PKCE — there is no client secret; the
 * claude-code OAuth client is public). OAuth params extracted from the claude-code 2.1.169 binary.
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
/** Scopes a subscription claude-code session uses (mirrors ~/.claude/.credentials.json). */
export const CLAUDE_OAUTH_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code';

export interface ClaudeOAuthBundle {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    /** Epoch ms when the access token expires. */
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
  };
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh PKCE pair + random CSRF state for one authorize round-trip. */
export interface AuthorizeStart {
  /** The full authorize URL — the owner opens this in a real browser + signs in as the target account. */
  authorizeUrl: string;
  /** PKCE verifier — held by the (trusted) UI, sent back to `exchangeClaudeCode`. */
  codeVerifier: string;
  /** CSRF state — also the value the callback page echoes back after the `#`. */
  state: string;
}

/** Generate PKCE + the authorize URL. `code=true` puts claude.ai in the manual flow (the callback
 *  page DISPLAYS `<code>#<state>` instead of redirecting to a localhost listener). */
export function buildClaudeAuthorize(): AuthorizeStart {
  const codeVerifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const state = b64url(randomBytes(16));
  const u = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', CLAUDE_OAUTH_REDIRECT_URI);
  u.searchParams.set('scope', CLAUDE_OAUTH_SCOPES);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return { authorizeUrl: u.toString(), codeVerifier, state };
}

/**
 * Exchange the authorization code (pasted from the callback page) for tokens.
 * `rawCode` may be the bare code or the `<code>#<state>` form the callback page shows.
 */
export async function exchangeClaudeCode(args: {
  rawCode: string;
  codeVerifier: string;
  expectedState?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeOAuthBundle> {
  const doFetch = args.fetchImpl ?? fetch;
  const [code, returnedState] = String(args.rawCode).trim().split('#');
  if (!code) throw new Error('no authorization code provided');
  if (args.expectedState && returnedState && returnedState !== args.expectedState) {
    throw new Error('OAuth state mismatch — the pasted code is from a different sign-in attempt');
  }
  const res = await doFetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: returnedState || args.expectedState || '',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      code_verifier: args.codeVerifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  let j: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    subscription_type?: string;
  };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!j.access_token) throw new Error('token exchange returned no access_token');
  return {
    claudeAiOauth: {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? '',
      expiresAt: Date.now() + (j.expires_in ?? 0) * 1000,
      scopes: (j.scope || CLAUDE_OAUTH_SCOPES).split(' ').filter(Boolean),
      subscriptionType: j.subscription_type || 'unknown',
    },
  };
}

/** Write the credential bundle to `filePath` (0600), creating its directory. Returns the path. */
export async function writeCredentialBundle(filePath: string, bundle: ClaudeOAuthBundle): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}
