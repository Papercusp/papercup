/** Tests for the hive inference gateway credential resolver (P-003). */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCredentialRef,
  withOAuthBeta,
  bundleTokenStorage,
  makeCredentialResolver,
  makeBearerCredentialResolver,
  type ClaudeCredentialBundle,
} from './credential-store';
import {
  registerProvider,
  __resetRegistryForTest,
  type OAuthProvider,
} from '../oauth/providers';
import { __resetTokenCacheForTest } from '../oauth/token';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ig-cred-'));
  __resetRegistryForTest();
  __resetTokenCacheForTest();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A fake claude provider whose refresh() hands back a counted new token. */
function fakeClaude(): { provider: OAuthProvider; refreshes: () => number } {
  let n = 0;
  const provider: OAuthProvider = {
    id: 'claude',
    config: { clientId: 'x', clientSecret: '', authorizeUrl: 'a', tokenUrl: 't', redirectUri: 'r' },
    buildAuthorizeUrl: () => 'url',
    exchangeCode: async () => ({ accessToken: 'a' }),
    refresh: async (rt) => {
      n += 1;
      return { accessToken: `refreshed-${n}`, refreshToken: `${rt}-rotated`, expiresAt: Date.now() + 3_600_000 };
    },
  };
  return { provider, refreshes: () => n };
}

test('parseCredentialRef — token / file / bare / ~ / env channels (no static key: literal)', () => {
  assert.deepEqual(parseCredentialRef('token:/a/b'), { kind: 'token', path: '/a/b' });
  assert.deepEqual(parseCredentialRef('file:/a/b'), { kind: 'file', path: '/a/b' });
  assert.deepEqual(parseCredentialRef('/a/b'), { kind: 'file', path: '/a/b' });
  // env: reads the secret from an env VAR (the Codex/OpenAI API-key channel, 2026-06-21) — supported.
  assert.deepEqual(parseCredentialRef('env:NAME'), { kind: 'env', path: 'NAME' });
  // A STATIC key: literal is still rejected — secrets never live inline in a credentialRef.
  assert.throws(() => parseCredentialRef('key:/a/b'), /unsupported/);
});

test('withOAuthBeta — always includes oauth flag, de-duplicated, preserves others', () => {
  assert.equal(withOAuthBeta(null), 'oauth-2025-04-20');
  assert.equal(withOAuthBeta('oauth-2025-04-20'), 'oauth-2025-04-20');
  assert.equal(withOAuthBeta('fine-grained-tool-streaming-2025-05-14'), 'fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20');
});

test('bundleTokenStorage — read maps claudeAiOauth, update rewrites + preserves other fields', async () => {
  const path = join(dir, 'b.json');
  const bundle: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 123, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  };
  await fs.writeFile(path, JSON.stringify(bundle));
  const store = bundleTokenStorage(path);
  const cfg = await store.read('inference-gateway', path);
  assert.equal(cfg.access, 'AT');
  assert.equal(cfg.access_refresh, 'RT');
  assert.equal(cfg.access_expires_at, 123);

  await store.update('inference-gateway', path, { access: 'AT2', access_refresh: 'RT2', access_expires_at: 999 });
  const after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.accessToken, 'AT2');
  assert.equal(after.claudeAiOauth.refreshToken, 'RT2');
  assert.equal(after.claudeAiOauth.expiresAt, 999);
  assert.equal(after.claudeAiOauth.subscriptionType, 'max', 'preserves non-token fields');
  assert.equal(after.claudeAiOauth.rateLimitTier, 'default_claude_max_20x');
});

test('makeCredentialResolver — token: returns the raw setup-token, cached (no refresh)', async () => {
  const path = join(dir, 'tok');
  await fs.writeFile(path, '  sk-ant-oat-abc\n');
  const r = makeCredentialResolver(`token:${path}`);
  assert.equal(r.kind, 'token');
  assert.equal(await r.current(), 'sk-ant-oat-abc');
  // mutate the file; cached value should persist until invalidate()
  await fs.writeFile(path, 'sk-ant-oat-CHANGED');
  assert.equal(await r.current(), 'sk-ant-oat-abc');
  r.invalidate();
  assert.equal(await r.current(), 'sk-ant-oat-CHANGED');
});

test('makeBearerCredentialResolver — file: rejects Codex ChatGPT auth.json for gateway bearer use', async () => {
  const path = join(dir, 'codex-auth.json');
  await fs.writeFile(path, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'codex-access-token',
      refresh_token: 'codex-refresh-token',
    },
  }));
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(r.kind, 'file');
  await assert.rejects(r.current(), /ChatGPT auth\.json.*OpenAI API bearer/);
});

test('makeBearerCredentialResolver — file: extracts bearer JSON tokens.access_token when it is not a ChatGPT auth bundle', async () => {
  const path = join(dir, 'bearer-json.json');
  await fs.writeFile(path, JSON.stringify({ tokens: { access_token: 'bearer-access-token' } }));
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(r.kind, 'file');
  assert.equal(await r.current(), 'bearer-access-token');
  await fs.writeFile(path, JSON.stringify({ tokens: { access_token: 'changed' } }));
  assert.equal(await r.current(), 'bearer-access-token', 'serves cached token until invalidated');
  r.invalidate();
  assert.equal(await r.current(), 'changed');
});

test('makeBearerCredentialResolver — file: still accepts raw bearer token files', async () => {
  const path = join(dir, 'raw-openai-token');
  await fs.writeFile(path, '  sk-openai-test\n');
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'sk-openai-test');
});

test('makeCredentialResolver — file: refreshes a near-expiry bundle once, then serves the cache', async () => {
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider); // pre-register so ensureClaudeProvider keeps our fake
  const path = join(dir, 'b.json');
  const expired: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'stale', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
  };
  await fs.writeFile(path, JSON.stringify(expired));

  const r = makeCredentialResolver(`file:${path}`);
  assert.equal(r.kind, 'file');
  assert.equal(await r.current(), 'refreshed-1', 'expired bundle triggers a refresh');
  assert.equal(refreshes(), 1);
  // the bundle was rewritten with the new token + rotated refresh token
  const after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.accessToken, 'refreshed-1');
  assert.equal(after.claudeAiOauth.refreshToken, 'RT-rotated');
  // second call within the fresh window serves the cache — no second refresh
  assert.equal(await r.current(), 'refreshed-1');
  assert.equal(refreshes(), 1);
});

test('makeCredentialResolver — file: serves a still-fresh token without refreshing', async () => {
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider);
  const path = join(dir, 'b.json');
  const fresh: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'good', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 },
  };
  await fs.writeFile(path, JSON.stringify(fresh));
  const r = makeCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'good');
  assert.equal(refreshes(), 0, 'fresh token is not refreshed');
});

// ── Backlog #6: credential-store deeper edges (continuation; prior owner su-c8455e93) ──

test('parseCredentialRef — expands ~ to $HOME for bare/file:/token: refs; env: trims the var name', () => {
  const prevHome = process.env.HOME;
  process.env.HOME = '/home/tester';
  try {
    assert.deepEqual(parseCredentialRef('~/x'), { kind: 'file', path: '/home/tester/x' });
    assert.deepEqual(parseCredentialRef('file:~/c.json'), { kind: 'file', path: '/home/tester/c.json' });
    assert.deepEqual(parseCredentialRef('token:~/.claude/tok'), { kind: 'token', path: '/home/tester/.claude/tok' });
    // env: names a process.env var — surrounding whitespace is trimmed off the name.
    assert.deepEqual(parseCredentialRef('env:  MY_KEY  '), { kind: 'env', path: 'MY_KEY' });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('withOAuthBeta — splits a multi-flag header, trims + drops empties, dedups a mid-list oauth flag', () => {
  // whitespace around commas + an empty segment are normalised away; oauth appended last
  assert.equal(withOAuthBeta('flag-a , , flag-b'), 'flag-a,flag-b,oauth-2025-04-20');
  // oauth already present mid-list → not duplicated, first-seen order preserved
  assert.equal(withOAuthBeta('flag-a,oauth-2025-04-20,flag-b'), 'flag-a,oauth-2025-04-20,flag-b');
  // an all-whitespace header collapses to just the required oauth flag
  assert.equal(withOAuthBeta('   '), 'oauth-2025-04-20');
});

test('makeCredentialResolver — rejects an env: ref (env is a bearer-only channel)', () => {
  assert.throws(() => makeCredentialResolver('env:SOME_KEY'), /env: is only valid for bearer accounts/);
});

test('makeCredentialResolver — token: empty file throws rather than serving an empty bearer', async () => {
  const path = join(dir, 'empty-tok');
  await fs.writeFile(path, '   \n');
  const r = makeCredentialResolver(`token:${path}`);
  await assert.rejects(r.current(), /empty setup-token/);
});

test('makeBearerCredentialResolver — env: reads process.env, trims it, throws when unset or empty', async () => {
  const VAR = `IG_TEST_CRED_${process.pid}`;
  const prev = process.env[VAR];
  try {
    process.env[VAR] = '  sk-from-env  ';
    const r = makeBearerCredentialResolver(`env:${VAR}`);
    assert.equal(r.kind, 'token', 'env channel reports as a non-refreshing token');
    assert.equal(await r.current(), 'sk-from-env');
    // unset var → a fresh resolver throws
    delete process.env[VAR];
    await assert.rejects(makeBearerCredentialResolver(`env:${VAR}`).current(), /empty or unset/);
    // whitespace-only var → also throws
    process.env[VAR] = '   ';
    await assert.rejects(makeBearerCredentialResolver(`env:${VAR}`).current(), /empty or unset/);
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
});

test('makeBearerCredentialResolver — file: rejects empty file, JSON without access_token, and malformed JSON', async () => {
  const empty = join(dir, 'empty-bearer');
  await fs.writeFile(empty, '   \n');
  await assert.rejects(makeBearerCredentialResolver(`file:${empty}`).current(), /empty bearer token/);

  const noTok = join(dir, 'no-access.json');
  await fs.writeFile(noTok, JSON.stringify({ tokens: { refresh_token: 'r' } }));
  await assert.rejects(makeBearerCredentialResolver(`file:${noTok}`).current(), /no tokens\.access_token/);

  const bad = join(dir, 'bad.json');
  await fs.writeFile(bad, '{ not valid json ');
  await assert.rejects(makeBearerCredentialResolver(`file:${bad}`).current(), /failed to parse/);
});

test('makeCredentialResolver — file: invalidate() drops the cache so a post-401 read re-refreshes', async () => {
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider);
  const path = join(dir, 'b.json');
  const expired: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'stale', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
  };
  await fs.writeFile(path, JSON.stringify(expired));

  const r = makeCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'refreshed-1');
  assert.equal(refreshes(), 1);

  // Mimic the 401 path: invalidate the in-memory cache, and the bundle has since gone stale again.
  r.invalidate();
  const expiredAgain: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'refreshed-1', refreshToken: 'RT2', expiresAt: Date.now() - 1000 },
  };
  await fs.writeFile(path, JSON.stringify(expiredAgain));
  assert.equal(await r.current(), 'refreshed-2', 'invalidate re-reads disk and refreshes again');
  assert.equal(refreshes(), 2);
});

test('bundleTokenStorage — read tolerates a bundle missing the claudeAiOauth block', async () => {
  const path = join(dir, 'empty-bundle.json');
  await fs.writeFile(path, JSON.stringify({}));
  const cfg = await bundleTokenStorage(path).read('inference-gateway', path);
  assert.equal(cfg.access, undefined);
  assert.equal(cfg.access_refresh, undefined);
  assert.equal(cfg.access_expires_at, null);
});

test('bundleTokenStorage — update clears expiresAt on a non-number value, leaves it untouched when the key is absent', async () => {
  const path = join(dir, 'b2.json');
  const base: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 5000, subscriptionType: 'max' },
  };
  const store = bundleTokenStorage(path);

  // key present but null (the getOAuthToken writeback when a provider returns no expiry) → cleared
  await fs.writeFile(path, JSON.stringify(base));
  await store.update('inference-gateway', path, { access: 'AT2', access_expires_at: null });
  let after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.accessToken, 'AT2');
  assert.equal(after.claudeAiOauth.expiresAt, undefined, 'null expires_at clears the field');
  assert.equal(after.claudeAiOauth.subscriptionType, 'max', 'still preserves unrelated fields');

  // key absent from the patch → expiresAt is left exactly as it was
  await fs.writeFile(path, JSON.stringify(base));
  await store.update('inference-gateway', path, { access: 'AT3' });
  after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.expiresAt, 5000, 'absent expires_at key leaves the field unchanged');
});
