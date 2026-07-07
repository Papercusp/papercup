/** Tests for the gateway spawn-env patch (P-012). */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  gatewaySpawnEnv,
  gatewayLlmEnv,
  gatewayPort,
  GATEWAY_BASE_URL_ENV,
  GATEWAY_SDK_URL_ENV,
  GATEWAY_CLIENT_AUTH_TOKEN,
} from './spawn-env';

const orig = process.env.PAPERCUSP_GATEWAY_PORT;
afterEach(() => {
  if (orig === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = orig;
});

test('gatewaySpawnEnv — disabled returns no patch', () => {
  assert.deepEqual(gatewaySpawnEnv(false), {});
});

test('gatewaySpawnEnv — enabled points ANTHROPIC_BASE_URL at the localhost gateway', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.deepEqual(gatewaySpawnEnv(true), {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8788',
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
  });
});

test('gatewaySpawnEnv — enabled ALWAYS hands the CLI the gateway bearer, so a fresh config dir with no local login still sends (mac fleet-member "Not logged in", 2026-07-06)', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  // The claude CLI gates on ITS OWN auth state before making any request: with no auth-token env
  // and no live local credential (the fresh-config-dir mac member), it boots "Not logged in ·
  // Please run /login" and never reaches the gateway at all. The bearer is a placeholder — the
  // gateway strips + reinjects the routed account's real OAuth — but it must be present on EVERY
  // enabled variant (plain, pinned, owner-attributed), and never when the gateway is off.
  assert.equal(gatewaySpawnEnv(true).ANTHROPIC_AUTH_TOKEN, GATEWAY_CLIENT_AUTH_TOKEN);
  assert.equal(gatewaySpawnEnv(true, { accountId: 'acct-x', hardPin: true }).ANTHROPIC_AUTH_TOKEN, GATEWAY_CLIENT_AUTH_TOKEN);
  assert.equal(gatewaySpawnEnv(true, { ownerId: 'spawn-7', priority: 'su' }).ANTHROPIC_AUTH_TOKEN, GATEWAY_CLIENT_AUTH_TOKEN);
  assert.equal(gatewaySpawnEnv(false).ANTHROPIC_AUTH_TOKEN, undefined);
});

test('gatewayPort — honors PAPERCUSP_GATEWAY_PORT, falls back to 8788', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9999';
  assert.equal(gatewayPort(), 9999);
  assert.deepEqual(gatewaySpawnEnv(true), {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:9999',
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
  });
  process.env.PAPERCUSP_GATEWAY_PORT = 'not-a-number';
  assert.equal(gatewayPort(), 8788);
});

test('gatewayLlmEnv — disabled returns no patch', () => {
  assert.deepEqual(gatewayLlmEnv(false), {});
});

test('gatewayLlmEnv — enabled patches BOTH the CLI and the anthropic-direct SDK base URLs (FB-16)', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.deepEqual(gatewayLlmEnv(true), {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8788',
    [GATEWAY_SDK_URL_ENV]: 'http://127.0.0.1:8788',
  });
  // distinct env vars so the in-process judge (SDK) and spawned agents (CLI) both route through it
  assert.notEqual(GATEWAY_BASE_URL_ENV, GATEWAY_SDK_URL_ENV);
});

test('gatewaySpawnEnv — with an accountId emits the x-papercusp-account routing header (P-004)', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.deepEqual(gatewaySpawnEnv(true, { accountId: 'acct-x' }), {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8788',
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
    ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-account: acct-x',
  });
});

test('gatewaySpawnEnv — hardPin adds the x-papercusp-account-pin: hard marker (only with an accountId) (account-hard-pin-2026-06-29)', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.deepEqual(gatewaySpawnEnv(true, { accountId: 'acct-x', hardPin: true }), {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8788',
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
    ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-account: acct-x\nx-papercusp-account-pin: hard',
  });
  // hardPin without an accountId is meaningless → no pin marker (nothing to pin to)
  assert.equal(gatewaySpawnEnv(true, { hardPin: true }).ANTHROPIC_CUSTOM_HEADERS, undefined);
  // a SOFT pin (no hardPin) is unchanged — the bee path never emits the marker
  assert.equal(gatewaySpawnEnv(true, { accountId: 'acct-x' }).ANTHROPIC_CUSTOM_HEADERS, 'x-papercusp-account: acct-x');
});

test('gatewaySpawnEnv — no accountId sets no routing header; disabled ignores the accountId (P-004)', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.equal(gatewaySpawnEnv(true).ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.deepEqual(gatewaySpawnEnv(false, { accountId: 'acct-x' }), {});
});

test('gatewaySpawnEnv — with an ownerId emits the x-papercusp-owner header (stall-autowake P-001)', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.equal(gatewaySpawnEnv(true, { ownerId: 'spawn-7' }).ANTHROPIC_CUSTOM_HEADERS, 'x-papercusp-owner: spawn-7');
});

test('gatewaySpawnEnv — accountId + ownerId emit BOTH custom headers, newline-separated', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.equal(
    gatewaySpawnEnv(true, { accountId: 'acct-x', ownerId: 'spawn-7' }).ANTHROPIC_CUSTOM_HEADERS,
    'x-papercusp-account: acct-x\nx-papercusp-owner: spawn-7',
  );
  // disabled still ignores everything
  assert.deepEqual(gatewaySpawnEnv(false, { accountId: 'acct-x', ownerId: 'spawn-7' }), {});
});

test('gatewayPort — rejects empty / zero / negative / unset PAPERCUSP_GATEWAY_PORT and falls back to 8788', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '';
  assert.equal(gatewayPort(), 8788, 'empty string (Number("")===0) → default');
  process.env.PAPERCUSP_GATEWAY_PORT = '0';
  assert.equal(gatewayPort(), 8788, 'zero is not a valid port → default');
  process.env.PAPERCUSP_GATEWAY_PORT = '-5';
  assert.equal(gatewayPort(), 8788, 'negative → default');
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  assert.equal(gatewayPort(), 8788, 'unset → default');
});

test('gatewayLlmEnv — honors PAPERCUSP_GATEWAY_PORT for BOTH the CLI and SDK base URLs', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9100';
  assert.deepEqual(gatewayLlmEnv(true), {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:9100',
    [GATEWAY_SDK_URL_ENV]: 'http://127.0.0.1:9100',
  });
});
