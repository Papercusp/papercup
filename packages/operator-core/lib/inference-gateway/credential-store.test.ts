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

test('parseCredentialRef — token / file / bare / ~ channels', () => {
  assert.deepEqual(parseCredentialRef('token:/a/b'), { kind: 'token', path: '/a/b' });
  assert.deepEqual(parseCredentialRef('file:/a/b'), { kind: 'file', path: '/a/b' });
  assert.deepEqual(parseCredentialRef('/a/b'), { kind: 'file', path: '/a/b' });
  assert.throws(() => parseCredentialRef('env:NAME'));
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
