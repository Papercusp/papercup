/**
 * Anthropic Console API-key accounts (`apikey:` credentialRef) —
 * anthropic-credits-gateway-2026-09-30 P-005 (BARs R-1..R-6).
 *
 * Fixture keys are ASSEMBLED at runtime (never a key-shaped literal in the tree), so the
 * secrets guard and the pot-git publish guard never see a key-shaped string in this file.
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCredentialRef,
  parseApiKeySource,
  makeCredentialResolver,
  makeBearerCredentialResolver,
  scrubSecrets,
  _setApiKeyCredentialsReaderForTests,
  _setKeychainReaderForTests,
  _setKeychainListerForTests,
} from './credential-store';
import { registerAccount, getAccount } from '../deployment/account-pool';

const fixtureKey = (kind: string, body: string) => ['sk', 'ant', kind, body].join('-');
const API_KEY = fixtureKey('api03', 'FIXTUREfixtureFIXTUREfixture0123456789_abcdefAA');
const OTHER_API_KEY = fixtureKey('api03', 'OTHERotherOTHERother0123456789');
const OAUTH_TOKEN = fixtureKey('oat01', 'subscriptionTokenFixture0123456789');
const ENV_NAME = 'PAPERCUSP_TEST_ANTHROPIC_KEY_P005';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ig-apikey-'));
});
afterEach(async () => {
  delete process.env[ENV_NAME];
  _setApiKeyCredentialsReaderForTests(null);
  _setKeychainReaderForTests(null);
  _setKeychainListerForTests(null);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

// R-1 — an apikey:env credentialRef returns the value of the environment variable it names.
test('R-1: apikey:env resolves the named environment variable', async () => {
  process.env[ENV_NAME] = API_KEY;
  const r = makeCredentialResolver(`apikey:env:${ENV_NAME}`);
  assert.equal(await r.current(), API_KEY);
  process.env[ENV_NAME] = OTHER_API_KEY;
  assert.equal(await r.current(), API_KEY, 'cached until invalidated');
  r.invalidate();
  assert.equal(await r.current(), OTHER_API_KEY, 'a rotated key is picked up after invalidate()');
});

test('R-1: an unset variable fails loudly instead of sending an empty key', async () => {
  const r = makeCredentialResolver(`apikey:env:${ENV_NAME}`);
  await assert.rejects(r.current(), /no Anthropic API key in environment variable/);
});

test('R-1: apikey:file reads the key from a file (a terminal-wrapped paste is re-joined)', async () => {
  const p = join(dir, 'key');
  await fs.writeFile(p, `  ${API_KEY.slice(0, 20)}\n${API_KEY.slice(20)}\n`);
  assert.equal(await makeCredentialResolver(`apikey:file:${p}`).current(), API_KEY);
});

// R-2 — every apikey: source reports authMode api-key.
test('R-2: apikey: resolvers report authMode api-key', () => {
  for (const ref of [`apikey:env:${ENV_NAME}`, `apikey:file:${join(dir, 'k')}`, 'apikey:credentials']) {
    const r = makeCredentialResolver(ref);
    assert.equal(r.authMode, 'api-key', ref);
    assert.equal(r.kind, 'apikey', ref);
  }
});

// R-3 — subscription refs keep authMode oauth.
test('R-3: subscription credentialRefs report authMode oauth', async () => {
  const tokenPath = join(dir, 'setup-token');
  await fs.writeFile(tokenPath, OAUTH_TOKEN);
  _setKeychainReaderForTests(() => null);
  _setKeychainListerForTests(() => []);
  for (const ref of [`token:${tokenPath}`, `file:${join(dir, '.credentials.json')}`, 'keychain:Claude Code-credentials']) {
    const r = makeCredentialResolver(ref);
    assert.equal(r.authMode, 'oauth', ref);
    assert.notEqual(r.kind, 'apikey', ref);
  }
  // Bearer (codex) accounts authenticate with a Bearer header, never x-api-key.
  process.env[ENV_NAME] = 'openai-bearer-fixture';
  assert.equal(makeBearerCredentialResolver(`env:${ENV_NAME}`).authMode, 'oauth');
});

// R-4 — apikey:credentials returns the stored anthropic_api_key.
test('R-4: apikey:credentials returns the operator credentials store anthropic_api_key', async () => {
  let reads = 0;
  _setApiKeyCredentialsReaderForTests(async () => {
    reads += 1;
    return API_KEY;
  });
  const r = makeCredentialResolver('apikey:credentials');
  assert.equal(await r.current(), API_KEY);
  assert.equal(await r.current(), API_KEY);
  assert.equal(reads, 1, 'the store is read once, then cached');
});

test('R-4: an empty credentials store names setup:save_key as the fix', async () => {
  _setApiKeyCredentialsReaderForTests(async () => undefined);
  await assert.rejects(makeCredentialResolver('apikey:credentials').current(), /setup:save_key/);
});

test('a subscription OAuth token registered under apikey: is refused (it would 401 as x-api-key)', async () => {
  process.env[ENV_NAME] = OAUTH_TOKEN;
  await assert.rejects(makeCredentialResolver(`apikey:env:${ENV_NAME}`).current(), /subscription OAuth token/);
});

test('parseCredentialRef / parseApiKeySource accept the three sources and reject anything else', () => {
  assert.deepEqual(parseCredentialRef(`apikey:env:${ENV_NAME}`), { kind: 'apikey', path: `env:${ENV_NAME}` });
  assert.deepEqual(parseApiKeySource('credentials'), { kind: 'credentials' });
  assert.deepEqual(parseApiKeySource(`env:${ENV_NAME}`), { kind: 'env', name: ENV_NAME });
  assert.deepEqual(parseApiKeySource('file:/tmp/k'), { kind: 'file', path: '/tmp/k' });
  assert.throws(() => parseCredentialRef('apikey:vault:x'), /unsupported apikey source/);
  assert.throws(() => parseCredentialRef('apikey:env:not a name'), /environment variable name/);
  assert.throws(() => parseCredentialRef('raw-secret-without-scheme'), /apikey:env:NAME/);
  assert.throws(() => makeBearerCredentialResolver(`apikey:env:${ENV_NAME}`), /Claude-only/);
});

// R-5 — scrubSecrets removes the secret part of a Console API key.
test('R-5: scrubSecrets redacts a Console API key embedded in a message', () => {
  const msg = `upstream 401 for x-api-key ${API_KEY} (account console-api)`;
  const out = scrubSecrets(msg);
  assert.ok(!out.includes(API_KEY), out);
  assert.ok(!out.includes(API_KEY.slice(12)), 'no tail of the secret survives');
  assert.ok(out.includes(`${API_KEY.slice(0, 12)}…[redacted]`), 'keeps an identifying prefix');
  // Control: a message without a key passes through untouched.
  assert.equal(scrubSecrets('no secret here'), 'no secret here');
});

// R-6 — registration stores a claude account whose credentialRef uses the apikey: scheme.
test('R-6: registerAccount stores a claude account whose credentialRef is apikey:', () => {
  const pool = registerAccount({ accounts: [] }, { id: 'console-api', credentialRef: 'apikey:credentials', label: 'Console credits' }, 1);
  const a = getAccount(pool, 'console-api');
  assert.ok(a);
  assert.equal(a.credentialRef, 'apikey:credentials');
  assert.equal(a.provider, 'claude');
  assert.equal(makeCredentialResolver(a.credentialRef).authMode, 'api-key', 'the stored ref round-trips into an api-key resolver');
});
