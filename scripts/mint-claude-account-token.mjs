#!/usr/bin/env node
/**
 * mint-claude-account-token.mjs — mint a Claude SUBSCRIPTION OAuth credential for a SEPARATE
 * account (a remote-frame / per-machine deploy credential), WITHOUT touching this machine's
 * `~/.claude` login. Output is a `.credentials.json` bundle (the shape `account-pool.credentialRef`
 * = `file:<path>` expects, identical to `~/.claude/.credentials.json`).
 *
 * Two phases — the browser login in between is driven separately (verdict, in a CLEAN/isolated
 * session as the target account):
 *
 *   authorize --id=<acct>
 *       → prints the OAuth authorize URL + stashes the PKCE verifier/state in a 0600 temp file.
 *   exchange  --id=<acct> --code=<code-from-callback-page> --out=<path>
 *       → exchanges the code for {access,refresh} tokens, writes the `.credentials.json` bundle.
 *
 * ISOLATION (the whole point): this never reads/writes `~/.claude`. The credential's IDENTITY comes
 * from the BROWSER LOGIN session, so the login MUST run in a clean/incognito browser as the TARGET
 * account — never the local browser session, which would mint the local account's token instead.
 *
 * OAuth params extracted from the claude-code 2.1.169 binary (the public claude-code OAuth client).
 */
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
// The canonical claude-code setup-token scopes (NOT user:sessions:claude_code — that's the
// interactive-login flow's scope; mixing it in makes claude.ai reject "Invalid request format").
const SCOPES = 'org:create_api_key user:profile user:inference';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const stateFile = (id) => join(tmpdir(), `claude-oauth-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
const argOf = (rest, name) => {
  const hit = rest.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

function authorize(id) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  writeFileSync(stateFile(id), JSON.stringify({ verifier, state }), { mode: 0o600 });
  // Build the query manually with encodeURIComponent so spaces in `scope` encode as %20 (NOT the
  // `+` that URLSearchParams emits — claude.ai rejects `+` with "Invalid request format").
  const params = [
    ['code', 'true'], // manual flow: the callback page DISPLAYS the code (no localhost listener)
    ['client_id', CLIENT_ID],
    ['response_type', 'code'],
    ['redirect_uri', REDIRECT_URI],
    ['scope', SCOPES],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
  ];
  const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  console.log(`${AUTHORIZE_URL}?${qs}`);
}

async function exchange(id, rawCode, outPath) {
  const { verifier, state } = JSON.parse(readFileSync(stateFile(id), 'utf8'));
  // The callback page shows `code#state` (claude-code format) — split if present.
  const [code, returnedState] = String(rawCode).split('#');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: returnedState || state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`token exchange failed: HTTP ${res.status}\n${text.slice(0, 400)}`);
    process.exit(1);
  }
  const j = JSON.parse(text);
  const bundle = {
    claudeAiOauth: {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in ?? 0) * 1000,
      scopes: (j.scope || SCOPES).split(' '),
      subscriptionType: j.subscription_type || 'unknown',
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  // Never print the tokens — only non-secret metadata.
  console.log(
    `✓ wrote ${outPath}\n  subscriptionType=${bundle.claudeAiOauth.subscriptionType}` +
      `  scopes=${bundle.claudeAiOauth.scopes.join(',')}` +
      `  expiresInH=${Math.round((bundle.claudeAiOauth.expiresAt - Date.now()) / 3.6e6)}` +
      `  hasRefresh=${Boolean(bundle.claudeAiOauth.refreshToken)}`,
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const id = argOf(rest, 'id') || 'default';
if (cmd === 'authorize') {
  authorize(id);
} else if (cmd === 'exchange') {
  const code = argOf(rest, 'code');
  const out = argOf(rest, 'out') || `/tmp/claude-account-${id}.credentials.json`;
  if (!code) {
    console.error('exchange needs --code=<code from the callback page>');
    process.exit(1);
  }
  await exchange(id, code, out);
} else {
  console.error('usage:\n  authorize --id=<acct>\n  exchange --id=<acct> --code=<code> --out=<path>');
  process.exit(1);
}
