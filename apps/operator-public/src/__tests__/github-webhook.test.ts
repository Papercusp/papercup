/**
 * GitHub App push webhook — cupboard-release-pipeline-content-trust-2026-09-16
 * P-006 (SPEC-P-006 / SPEC-P-006b), route-level through the real
 * `POST /github/webhook` handler against REAL SQLite with every shipped
 * migration applied.
 *
 * D-009: the "Papercusp Cupboard" App is not registered yet (P-005 is
 * owner-gated), so GitHub is an injected fake — a test-generated RSA key, a
 * fixed webhook secret, and a fetch seam that answers the installation-token
 * and Check Run endpoints (verifying the App JWT it is handed) and delegates
 * every other GitHub call to the shared `stubGithub`.
 *
 * Two clauses are load-bearing:
 *  - SPEC-P-006:  a delivery whose X-Hub-Signature-256 does not match is 401
 *    and performs NO listing mutation (and makes no GitHub call);
 *  - SPEC-P-006b: a signature-valid push whose head differs from
 *    `pinned_commit_sha` sets drift=1 and leaves every `pinned_*` /
 *    `approved_*` column untouched — the pin never auto-advances.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GithubAppKeyError, mintAppJwt, pkcs1ToPkcs8, verifyWebhookSignature } from '../github-app.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub, stubTreeFor, type GhStubTreeEntry } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1';

type Raw = ReturnType<typeof makeSqliteDb>['raw'];
type Env = ReturnType<typeof makeEnv>['env'];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SECRET = 'whsec_test_secret';
const APP_ID = '424242';
const INSTALLATION_ID = 99;
const INSTALL_TOKEN = 'ghs_install_token';
const REPO_ID = 8;
const PUBLISHER = { id: 5, login: 'pub' };
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Crypto helpers: a throwaway RSA key and the signatures/JWT checks built on it
// ---------------------------------------------------------------------------

let publicKey: CryptoKey;
let pkcs8Bytes: Uint8Array;

function toPem(label: string, der: Uint8Array): string {
  let binary = '';
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** The PKCS#8 header of a 2048-bit RSA key is exactly 26 bytes; GitHub's PKCS#1 is what follows. */
const pkcs8Pem = (): string => toPem('PRIVATE KEY', pkcs8Bytes);
const pkcs1Pem = (): string => toPem('RSA PRIVATE KEY', pkcs8Bytes.slice(26));

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  publicKey = pair.publicKey;
  pkcs8Bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

const sign = async (secret: string, body: string): Promise<string> => `sha256=${await hmacHex(secret, body)}`;

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Verify an RS256 JWT against the test public key; returns its claims or null. */
async function verifyJwt(jwt: string): Promise<{ iss?: string; iat?: number; exp?: number } | null> {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) return null;
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    b64urlToBytes(signature),
    encoder.encode(`${header}.${payload}`),
  );
  if (!ok) return null;
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
}

// ---------------------------------------------------------------------------
// github-app.ts unit behaviour
// ---------------------------------------------------------------------------

describe('P-006 github-app primitives', () => {
  it('verifyWebhookSignature accepts only the HMAC of the exact raw body under the exact secret', async () => {
    const body = '{"a":1}';
    const good = await sign(SECRET, body);
    expect(await verifyWebhookSignature(SECRET, body, good)).toBe(true);
    expect(await verifyWebhookSignature('other-secret', body, good)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, '{"a":2}', good)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, good.replace('sha256=', 'sha1='))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, 'sha256=not-hex')).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, 'sha256=')).toBe(false);
    // Same length, one nibble flipped — the constant-time compare must still reject.
    const flipped = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
    expect(await verifyWebhookSignature(SECRET, body, flipped)).toBe(false);
    // An empty secret authenticates nothing (and WebCrypto cannot even import a
    // zero-length HMAC key, so the guard must fire before any import).
    expect(await verifyWebhookSignature('', body, good)).toBe(false);
  });

  it('pkcs1ToPkcs8 reproduces the exact PKCS#8 envelope WebCrypto exports', () => {
    expect(pkcs1ToPkcs8(pkcs8Bytes.slice(26))).toEqual(pkcs8Bytes);
  });

  it.each([
    ['PKCS#8', () => pkcs8Pem()],
    ['PKCS#1 (GitHub format)', () => pkcs1Pem()],
    ['PKCS#1 with literal \\n escapes', () => pkcs1Pem().replace(/\n/g, '\\n')],
  ])('mintAppJwt signs a verifiable RS256 App JWT from a %s key', async (_label, pem) => {
    const claims = await verifyJwt(await mintAppJwt(APP_ID, pem(), 1_000_000));
    expect(claims).toEqual({ iat: 1_000_000 - 60, exp: 1_000_000 + 540, iss: APP_ID });
  });

  it('mintAppJwt refuses a key that is not a PEM RSA private key without echoing it', async () => {
    await expect(mintAppJwt(APP_ID, 'not a key', 1)).rejects.toBeInstanceOf(GithubAppKeyError);
    await expect(mintAppJwt(APP_ID, toPem('PRIVATE KEY', new Uint8Array([1, 2, 3])), 1)).rejects.toBeInstanceOf(GithubAppKeyError);
  });
});

// ---------------------------------------------------------------------------
// Route fixtures
// ---------------------------------------------------------------------------

interface CheckCall {
  url: string;
  authorization: string;
  body: { name: string; head_sha: string; conclusion: string; output: { title: string; summary: string } };
}
interface AppCalls {
  tokens: Array<{ installation: string; claims: { iss?: string } | null }>;
  checks: CheckCall[];
}

interface Ctx {
  env: Env;
  raw: Raw;
  calls: AppCalls;
  api: ReturnType<typeof buildApi>;
  /** Re-point the GitHub fake (tree/blobs) between publish and delivery. */
  github: (stub?: { entries?: GhStubTreeEntry[]; blobs?: Record<string, { content: string }> }) => void;
  setAppFetch: (opts: { tokenStatus?: number; checkStatus?: number }) => void;
}

function setup(envOverrides: Record<string, string | undefined> = {}): Ctx {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ DB: db });
  const fullEnv = {
    ...env,
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY: pkcs1Pem(),
    GITHUB_APP_WEBHOOK_SECRET: SECRET,
    ...envOverrides,
  } as Env;
  const calls: AppCalls = { tokens: [], checks: [] };
  let appOpts: { tokenStatus?: number; checkStatus?: number } = {};
  const github: Ctx['github'] = (stub = {}) => {
    stubGithub({
      user: PUBLISHER,
      repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: A },
      tree: { entries: stub.entries ?? [...stubTreeFor('quality-plan'), ...stubTreeFor('second-plan')] },
      ...(stub.blobs ? { blobs: stub.blobs } : {}),
    });
  };
  github();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const tokenMatch = /\/app\/installations\/(\d+)\/access_tokens$/.exec(u);
    if (tokenMatch) {
      const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, '') ?? '';
      calls.tokens.push({ installation: tokenMatch[1]!, claims: await verifyJwt(bearer) });
      if (appOpts.tokenStatus && appOpts.tokenStatus >= 400) return new Response('', { status: appOpts.tokenStatus });
      return new Response(JSON.stringify({ token: INSTALL_TOKEN }), { status: 201 });
    }
    if (/\/repos\/[^/]+\/[^/]+\/check-runs$/.test(u) && init?.method === 'POST') {
      calls.checks.push({
        url: u,
        authorization: (init.headers as Record<string, string>).Authorization!,
        body: JSON.parse(String(init.body)),
      });
      return new Response('{}', { status: appOpts.checkStatus ?? 201 });
    }
    // Everything else (tree / blob fetches) is the shared GitHub fake — read
    // lazily so `ctx.github(...)` re-pointing between steps takes effect.
    return globalThis.fetch(url, init);
  }) as typeof fetch;
  return {
    env: fullEnv,
    raw,
    calls,
    api: buildApi({ fetchImpl }),
    github,
    setAppFetch: (opts) => {
      appOpts = opts;
    },
  };
}

const publishBody = (ref: string) => ({
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
  github_repository_id: REPO_ID,
  listing_kind: 'plan',
  listing_ref: ref,
});

/** Publish `ref` pinned at `sha`; returns the listing id. */
async function publish(ctx: Ctx, ref: string, sha: string): Promise<string> {
  stubGithub({
    user: PUBLISHER,
    repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha },
    tree: { entries: [...stubTreeFor('quality-plan'), ...stubTreeFor('second-plan')] },
  });
  const res = await ctx.api.request(
    '/listings',
    { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(publishBody(ref)) },
    ctx.env,
  );
  expect(res.status).toBe(200);
  ctx.github();
  return (ctx.raw.prepare('SELECT id FROM harnesses WHERE listing_ref = ?').get(ref) as unknown as { id: string }).id;
}

const row = (ctx: Ctx, id: string): Record<string, unknown> =>
  ctx.raw.prepare('SELECT * FROM harnesses WHERE id = ?').get(id) as unknown as Record<string, unknown>;

const pushPayload = (after: string, overrides: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  after,
  repository: { id: REPO_ID, default_branch: 'main' },
  installation: { id: INSTALLATION_ID },
  ...overrides,
});

async function deliver(
  ctx: Ctx,
  payload: unknown,
  opts: { event?: string; signature?: string | null; secret?: string; body?: string } = {},
): Promise<Response> {
  const body = opts.body ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-github-event': opts.event ?? 'push' };
  const signature = opts.signature === undefined ? await sign(opts.secret ?? SECRET, body) : opts.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return ctx.api.request('/github/webhook', { method: 'POST', headers, body }, ctx.env);
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe('P-006 POST /github/webhook', () => {
  it.each(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET'])(
    'fails closed with 503 app_not_configured when %s is absent, even for a correctly signed push',
    async (missing) => {
      const ctx = setup({ [missing]: undefined });
      const id = await publish(ctx, 'quality-plan', A);
      const before = row(ctx, id);
      const res = await deliver(ctx, pushPayload(B));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'app_not_configured' });
      expect(row(ctx, id)).toEqual(before);
      expect(ctx.calls.tokens).toHaveLength(0);
      expect(ctx.calls.checks).toHaveLength(0);
    },
  );

  it('SPEC-P-006: a missing, wrong-secret, tampered-body, or malformed signature is 401 and mutates no listing', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    const before = row(ctx, id);
    const payload = pushPayload(B);
    const good = await sign(SECRET, JSON.stringify(payload));
    const attempts: Array<[string, Parameters<typeof deliver>[2]]> = [
      ['no header', { signature: null }],
      ['wrong secret', { secret: 'attacker-secret' }],
      ['tampered body', { signature: good, body: JSON.stringify(pushPayload(B, { ref: 'refs/heads/main ' })) }],
      ['not sha256=', { signature: good.replace('sha256=', 'sha1=') }],
      ['not hex', { signature: 'sha256=zzzz' }],
    ];
    for (const [label, opts] of attempts) {
      const res = await deliver(ctx, payload, opts);
      expect(res.status, label).toBe(401);
      expect(await res.json(), label).toEqual({ error: 'bad_signature' });
    }
    expect(row(ctx, id)).toEqual(before);
    expect(row(ctx, id).drift).toBe(0);
    expect(ctx.calls.tokens).toHaveLength(0);
    expect(ctx.calls.checks).toHaveLength(0);
  });

  it('answers a signed ping 200 and ignores non-push events without touching GitHub or listings', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    const before = row(ctx, id);
    expect((await deliver(ctx, { zen: 'hi' }, { event: 'ping' })).status).toBe(200);
    const issue = await deliver(ctx, { action: 'opened' }, { event: 'issues' });
    expect(issue.status).toBe(202);
    expect(await issue.json()).toMatchObject({ ignored: 'event_not_handled' });
    expect(row(ctx, id)).toEqual(before);
    expect(ctx.calls.tokens).toHaveLength(0);
  });

  it('ignores a push to a non-default branch, a branch deletion, and a repo with no active listing', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    const before = row(ctx, id);
    const branch = await deliver(ctx, pushPayload(B, { ref: 'refs/heads/feature' }));
    expect(branch.status).toBe(202);
    expect(await branch.json()).toMatchObject({ ignored: 'not_default_branch' });
    const deleted = await deliver(ctx, pushPayload('0'.repeat(40), { deleted: true }));
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toMatchObject({ ignored: 'ref_deleted' });
    expect(row(ctx, id)).toEqual(before);

    const other = await deliver(ctx, pushPayload(B, { repository: { id: 12345, default_branch: 'main' } }));
    expect(other.status).toBe(202);
    expect(await other.json()).toMatchObject({ ignored: 'no_active_listing' });
    ctx.raw.prepare('UPDATE harnesses SET unlisted_at = 1 WHERE id = ?').run(id);
    const unlisted = await deliver(ctx, pushPayload(B));
    expect(unlisted.status).toBe(202);
    expect(await unlisted.json()).toMatchObject({ ignored: 'no_active_listing' });
    expect(row(ctx, id).drift).toBe(0);
    expect(ctx.calls.tokens).toHaveLength(0);
  });

  it('rejects a push with a malformed commit sha or payload before touching listings', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    const before = row(ctx, id);
    expect((await deliver(ctx, pushPayload('not-a-sha'))).status).toBe(400);
    expect((await deliver(ctx, { ref: 'refs/heads/main' })).status).toBe(400);
    expect((await deliver(ctx, null, { body: '{not json' })).status).toBe(400);
    expect(row(ctx, id)).toEqual(before);
  });

  it('SPEC-P-006b: a signed push whose head differs from the pin sets drift=1 and leaves the pin and approval untouched', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    const before = row(ctx, id);
    expect(before).toMatchObject({ pinned_commit_sha: A, drift: 0 });

    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results).toEqual([
      expect.objectContaining({ listing_id: id, verdict: 'pass', drift: true, check_run: { ok: true, status: 201 } }),
    ]);

    // Only `drift` moved: every other column — pinned_*, approved_*, review_status — is byte-identical.
    expect(row(ctx, id)).toEqual({ ...before, drift: 1 });

    // The App authenticated as itself, then as the installation, and reported on the pushed commit.
    expect(ctx.calls.tokens).toEqual([{ installation: String(INSTALLATION_ID), claims: expect.objectContaining({ iss: APP_ID }) }]);
    expect(ctx.calls.checks).toHaveLength(1);
    expect(ctx.calls.checks[0]).toMatchObject({
      url: 'https://api.github.com/repos/papercupai/demo-project/check-runs',
      authorization: `Bearer ${INSTALL_TOKEN}`,
      body: { name: 'Papercusp Cupboard: plan/quality-plan', head_sha: B, conclusion: 'success' },
    });
  });

  it('a push to the pinned commit leaves drift alone and never CLEARS an existing drift flag', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    expect((await deliver(ctx, pushPayload(A))).status).toBe(200);
    expect(row(ctx, id).drift).toBe(0);

    // Deliveries can arrive out of order: a late push of the OLD pinned commit
    // must not hide a newer unverified one. Only the admin approve path resets it.
    ctx.raw.prepare('UPDATE harnesses SET drift = 1 WHERE id = ?').run(id);
    expect((await deliver(ctx, pushPayload(A))).status).toBe(200);
    expect(row(ctx, id).drift).toBe(1);
    expect(row(ctx, id).pinned_commit_sha).toBe(A);
  });

  it('an identity leak at the pushed tip fails the check without echoing the leaked value, and still flags drift', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    const identity = 'publisher-handle-42';
    const leak = JSON.stringify({ launchSettings: { defaults: { account: identity } }, duty: `notify ${identity}` });
    ctx.github({ blobs: { ['1'.repeat(40)]: { content: btoa(leak) } } });

    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ verdict: string; drift: boolean }> };
    expect(body.results[0]).toMatchObject({ verdict: 'identity_leak', drift: true });
    expect(row(ctx, id)).toMatchObject({ drift: 1, pinned_commit_sha: A });

    expect(ctx.calls.checks).toHaveLength(1);
    const check = ctx.calls.checks[0]!;
    expect(check.body.conclusion).toBe('failure');
    expect(check.body.output.summary).toContain('quality-plan/listing.json');
    expect(JSON.stringify(check.body)).not.toContain(identity);
  });

  it('a GitHub outage while scanning is a neutral check (not a failure of the publisher) and drift is still set', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    ctx.github({ blobs: { ['1'.repeat(40)]: { error: 503 } as never } });
    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(200);
    expect(ctx.calls.checks[0]!.body.conclusion).toBe('neutral');
    expect(row(ctx, id).drift).toBe(1);
  });

  it('drift is recorded BEFORE the installation token is minted: a token failure is 502 but the flag survives', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    ctx.setAppFetch({ tokenStatus: 503 });
    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'installation_token_unavailable', status: 503, drifted: 1 });
    expect(row(ctx, id)).toMatchObject({ drift: 1, pinned_commit_sha: A });
    expect(ctx.calls.checks).toHaveLength(0);
  });

  it('a malformed GITHUB_APP_PRIVATE_KEY is a 502 that does not echo the key, and drift is still recorded', async () => {
    const ctx = setup({ GITHUB_APP_PRIVATE_KEY: 'definitely-not-a-pem' });
    const id = await publish(ctx, 'quality-plan', A);
    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('definitely-not-a-pem');
    expect(row(ctx, id).drift).toBe(1);
  });

  it('a failed Check Run post is reported in the response but never undoes the drift flag', async () => {
    const ctx = setup();
    const id = await publish(ctx, 'quality-plan', A);
    ctx.setAppFetch({ checkStatus: 500 });
    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ check_run: { ok: boolean; status: number } }> };
    expect(body.results[0]!.check_run).toEqual({ ok: false, status: 500 });
    expect(row(ctx, id).drift).toBe(1);
  });

  it('a repo holding two active listings gets one drift flag and one named Check Run per listing', async () => {
    const ctx = setup();
    const first = await publish(ctx, 'quality-plan', A);
    const second = await publish(ctx, 'second-plan', A);
    const res = await deliver(ctx, pushPayload(B));
    expect(res.status).toBe(200);
    expect(row(ctx, first).drift).toBe(1);
    expect(row(ctx, second).drift).toBe(1);
    expect(ctx.calls.tokens).toHaveLength(1); // one installation token serves every listing
    expect(ctx.calls.checks.map((c) => c.body.name).sort()).toEqual([
      'Papercusp Cupboard: plan/quality-plan',
      'Papercusp Cupboard: plan/second-plan',
    ]);
  });
});
