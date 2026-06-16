/**
 * account-link-store — the EXPERIMENTAL one-click "link a Max account via OAuth" flow
 * (accounts-pool-tab-2026-06-15 P-002 / D-004; lead su-c7b4c, this is the backend lane).
 *
 * The DEFAULT add-account path is the proven `claude setup-token` paste
 * (deploy-accounts-register.ts). THIS is the experimental one-click alternative,
 * unverified against live claude.ai (the owner confirms acceptance on wake — D-005);
 * the SPA offers it as a beta below the paste default.
 *
 * The flow is OAuth PKCE with our server as the confidential client:
 *   1. startAccountLink → generate a PKCE verifier, build the claude.ai authorize URL
 *      (the CHALLENGE, never the verifier, goes to claude.ai), and return an opaque
 *      HMAC-signed `linkId` carrying { accountId, label, verifier, exp }.
 *   2. The owner opens the URL in a browser logged into the TARGET Max account,
 *      authorizes, and claude.ai shows a `code` to paste.
 *   3. completeAccountLink({ linkId, code }) → verify the linkId (HMAC + exp), exchange
 *      the code with the carried verifier, write the `.credentials.json` bundle (0600),
 *      and registerAccount. The TOKEN never leaves the server (no response/log carries
 *      it — only the `file:<path>` credentialRef).
 *
 * SECURITY: PKCE is preserved (the verifier is never sent to claude.ai — only the
 * S256 challenge in the authorize URL). The verifier rides the signed `linkId` held
 * by the owner's same-origin SPA — standard PKCE keeps the verifier client-side; what
 * must stay server-side is the TOKEN, and the server-side exchange guarantees that.
 * Replay is bounded by claude.ai's single-use auth `code` (a second exchange 400s) +
 * the exp-bound linkId + idempotent re-register. A server-side single-use nonce
 * (oauth_nonces) is the hardening follow-up if this graduates from experimental.
 *
 * Storage-policy note: deliberately NO new PG table / migration — operator-state's
 * StateTable is a closed union, and an in-process TTL Map is forbidden; the
 * stateless signed-linkId is the migration-free, standard-PKCE design.
 */
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeClaudeProvider, CLAUDE_OAUTH_DEFAULTS, type TokenResponse } from '../oauth/providers';
import type { ClaudeCredentialBundle } from '../inference-gateway/credential-store';
import { registerAccount } from './account-pool';
import { updateAccountPool, accountStatus, type AccountStatusRow } from './account-pool-store';
import { papercuspPath } from '../papercusp-root';

/** Account-id charset (mirrors accounts:register / deploy-accounts-register). */
const ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000; // 10 min to authorize + paste

/** The claims an opaque `linkId` carries between start and complete. */
interface LinkClaims {
  accountId: string;
  label?: string;
  /** The PKCE code_verifier for this round-trip (held client-side, standard PKCE). */
  verifier: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

let secretKey: Buffer | null = null;
/** HMAC key for the linkId — the same env secret the OAuth state uses, else a
 *  process-lifetime random key (a restart invalidates in-flight links; acceptable). */
function getSecret(): Buffer {
  if (secretKey) return secretKey;
  const env = process.env.PAPERCUSP_OAUTH_STATE_SECRET;
  secretKey = env && env.length >= 32 ? Buffer.from(env, 'utf8') : randomBytes(32);
  return secretKey;
}

/** Sign a linkId carrying the claims. Opaque to the caller (the SPA holds it verbatim). */
export function signLinkId(claims: LinkClaims): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export type VerifyLinkResult =
  | { ok: true; claims: LinkClaims }
  | { ok: false; error: 'malformed' | 'bad-signature' | 'expired' };

/** Verify a linkId's HMAC + expiry, returning its claims. */
export function verifyLinkId(linkId: string, now: number): VerifyLinkResult {
  if (!linkId || typeof linkId !== 'string' || !linkId.includes('.')) return { ok: false, error: 'malformed' };
  const [body, sig] = linkId.split('.', 2);
  if (!body || !sig) return { ok: false, error: 'malformed' };
  const expected = b64url(createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'bad-signature' };
  let claims: LinkClaims;
  try {
    claims = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (typeof claims.accountId !== 'string' || typeof claims.verifier !== 'string' || typeof claims.exp !== 'number') {
    return { ok: false, error: 'malformed' };
  }
  if (claims.exp < now) return { ok: false, error: 'expired' };
  return { ok: true, claims };
}

export interface StartAccountLinkInput {
  accountId: string;
  label?: string;
  ttlMs?: number;
  /** Injected for tests — defaults to Date.now / crypto random. */
  now?: () => number;
  genVerifier?: () => string;
}

export type StartAccountLinkResult =
  | { ok: true; authorizeUrl: string; linkId: string }
  | { ok: false; error: string };

/**
 * Begin an account link: build the claude.ai authorize URL (PKCE challenge) and the
 * opaque signed linkId carrying the verifier. Pure — no IO; the caller surfaces the URL.
 */
export function startAccountLink(input: StartAccountLinkInput): StartAccountLinkResult {
  const accountId = input.accountId?.trim();
  if (!accountId || !ID_RE.test(accountId)) {
    return { ok: false, error: 'accountId required (allowed: A-Za-z0-9 . _ -)' };
  }
  const now = input.now?.() ?? Date.now();
  const genVerifier = input.genVerifier ?? (() => b64url(randomBytes(32)));
  const verifier = genVerifier();
  // State echoed by claude.ai in `code#state` — a random binding value, NOT the verifier.
  const state = b64url(randomBytes(16));
  const provider = makeClaudeProvider({ codeVerifier: verifier });
  const authorizeUrl = provider.buildAuthorizeUrl([...CLAUDE_OAUTH_DEFAULTS.scopes], state);
  const linkId = signLinkId({
    accountId,
    label: input.label?.trim() || undefined,
    verifier,
    exp: now + (input.ttlMs ?? DEFAULT_LINK_TTL_MS),
  });
  return { ok: true, authorizeUrl, linkId };
}

export interface CompleteAccountLinkDeps {
  /** Exchange the pasted code with the verifier (default: the real claude provider). */
  exchangeCode?: (code: string, verifier: string) => Promise<TokenResponse>;
  /** Persist the credential bundle, returning the credentialRef (default: write 0600 + register). */
  writeCredential?: (accountId: string, bundle: ClaudeCredentialBundle) => Promise<string>;
  /** Register/refresh the account in the pool (default: updateAccountPool(registerAccount)). */
  register?: (accountId: string, credentialRef: string, label: string | undefined, ws?: string) => Promise<void>;
  /** Read back the registered account row (default: accountStatus()). */
  readAccount?: (accountId: string, ws?: string) => Promise<AccountStatusRow | null>;
  /** Best-effort UI refresh (default: notifySyncInvalidate('accounts.pool')). */
  notify?: () => void;
  now?: () => number;
}

export interface CompleteAccountLinkInput {
  linkId: string;
  /** The pasted value — may be `code` or `code#state`; the provider splits it. */
  code: string;
  workspace?: string;
}

export type CompleteAccountLinkResult =
  | { ok: true; account: AccountStatusRow | null }
  | { ok: false; error: string };

/** Default credential write: `~/.papercusp/deploy-credentials/<id>.credentials.json` (0600). */
async function defaultWriteCredential(accountId: string, bundle: ClaudeCredentialBundle): Promise<string> {
  const credPath = papercuspPath('deploy-credentials', `${accountId}.credentials.json`);
  await mkdir(dirname(credPath), { recursive: true });
  await writeFile(credPath, JSON.stringify(bundle), { mode: 0o600 });
  await chmod(credPath, 0o600);
  return `file:${credPath}`;
}

function defaultNotify(): void {
  void import('../sync-sse')
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
    .catch(() => {});
}

/**
 * Complete an account link: verify the linkId, exchange the code → token, write the
 * credential bundle server-side, and registerAccount. Returns the account row WITHOUT
 * the token. IO is injected so it unit-tests with a mocked exchange + no fs/PG.
 */
export async function completeAccountLink(
  input: CompleteAccountLinkInput,
  deps: CompleteAccountLinkDeps = {},
): Promise<CompleteAccountLinkResult> {
  const now = deps.now?.() ?? Date.now();
  const code = input.code?.trim();
  if (!code) return { ok: false, error: 'code required (paste the value claude.ai shows)' };
  const verified = verifyLinkId(input.linkId, now);
  if (!verified.ok) return { ok: false, error: `invalid link (${verified.error}) — restart the add-account flow` };
  const { accountId, label, verifier } = verified.claims;

  const exchangeCode = deps.exchangeCode ?? ((c, v) => makeClaudeProvider({ codeVerifier: v }).exchangeCode(c));
  const writeCredential = deps.writeCredential ?? defaultWriteCredential;
  const register =
    deps.register ??
    ((id, ref, lbl, ws) => updateAccountPool((p) => registerAccount(p, { id, credentialRef: ref, label: lbl }, now), ws).then(() => undefined));
  const readAccount = deps.readAccount ?? (async (id, ws) => (await accountStatus(ws)).find((a) => a.id === id) ?? null);

  let token: TokenResponse;
  try {
    token = await exchangeCode(code, verifier);
  } catch (e) {
    return { ok: false, error: `code exchange failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
  }
  const bundle: ClaudeCredentialBundle = {
    claudeAiOauth: {
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      ...(token.scopes ? { scopes: token.scopes } : {}),
    },
  };
  let credentialRef: string;
  try {
    credentialRef = await writeCredential(accountId, bundle);
    await register(accountId, credentialRef, label, input.workspace);
  } catch (e) {
    return { ok: false, error: `register failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
  }
  (deps.notify ?? defaultNotify)();
  return { ok: true, account: await readAccount(accountId, input.workspace).catch(() => null) };
}

/** Test-only: drop the HMAC-key cache. */
export function __resetForTest(): void {
  secretKey = null;
}
