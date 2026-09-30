/** Tests for the gateway spawn-env patch (P-012). */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  gatewaySpawnEnv,
  gatewayLlmEnv,
  applyGatewayLlmEnv,
  isDirectAnthropicApiUrl,
  gatewayPort,
  GATEWAY_BASE_URL_ENV,
  GATEWAY_SDK_URL_ENV,
  GATEWAY_CLIENT_AUTH_TOKEN,
  ACCOUNT_ROUTING_MODE_ENV,
  accountRoutingMode,
  sanitizeInheritedWakeEnv,
  wakeAccountRouteFromArgv,
} from './spawn-env';

test('public build never routes a claude spawn through the gateway (P-019 gateway-reinjection)', () => {
  const saved = {
    profile: process.env.PAPERCUSP_DISTRIBUTION_PROFILE,
    optIn: process.env.PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY,
  };
  try {
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'public';
    delete process.env.PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY;
    assert.deepEqual(gatewaySpawnEnv(true, { accountId: 'acct-1' }), {});
    process.env.PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY = '1';
    assert.ok(gatewaySpawnEnv(true)[GATEWAY_BASE_URL_ENV], 'own-accounts opt-in restores the route');
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'dogfood';
    delete process.env.PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY;
    assert.ok(gatewaySpawnEnv(true)[GATEWAY_BASE_URL_ENV], 'dogfood build keeps the gateway route');
  } finally {
    if (saved.profile === undefined) delete process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
    else process.env.PAPERCUSP_DISTRIBUTION_PROFILE = saved.profile;
    if (saved.optIn === undefined) delete process.env.PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY;
    else process.env.PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY = saved.optIn;
  }
});

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

test('isDirectAnthropicApiUrl — recognizes the public API endpoint, including a path, but not custom endpoints', () => {
  assert.equal(isDirectAnthropicApiUrl('https://api.anthropic.com'), true);
  assert.equal(isDirectAnthropicApiUrl('https://api.anthropic.com/v1'), true);
  assert.equal(isDirectAnthropicApiUrl('http://api.anthropic.com/'), true);
  assert.equal(isDirectAnthropicApiUrl('http://127.0.0.1:8788'), false);
  assert.equal(isDirectAnthropicApiUrl('https://proxy.example.test'), false);
  assert.equal(isDirectAnthropicApiUrl('api.anthropic.com'), false);
});

test('applyGatewayLlmEnv — replaces inherited public API defaults but preserves explicit local/custom endpoints', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  const env: NodeJS.ProcessEnv = {
    [GATEWAY_BASE_URL_ENV]: 'https://api.anthropic.com/v1',
    [GATEWAY_SDK_URL_ENV]: 'https://api.anthropic.com',
  };
  assert.deepEqual(applyGatewayLlmEnv(true, env), [GATEWAY_BASE_URL_ENV, GATEWAY_SDK_URL_ENV]);
  assert.equal(env[GATEWAY_BASE_URL_ENV], 'http://127.0.0.1:8788');
  assert.equal(env[GATEWAY_SDK_URL_ENV], 'http://127.0.0.1:8788');

  const custom: NodeJS.ProcessEnv = {
    [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:9901',
    [GATEWAY_SDK_URL_ENV]: 'http://localhost:9902',
  };
  assert.deepEqual(applyGatewayLlmEnv(true, custom), []);
  assert.equal(custom[GATEWAY_BASE_URL_ENV], 'http://127.0.0.1:9901');
  assert.equal(custom[GATEWAY_SDK_URL_ENV], 'http://localhost:9902');
});

test('applyGatewayLlmEnv — fills unset values and leaves the environment unchanged when disabled', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(applyGatewayLlmEnv(false, env), []);
  assert.deepEqual(env, {});
  assert.deepEqual(applyGatewayLlmEnv(true, env), [GATEWAY_BASE_URL_ENV, GATEWAY_SDK_URL_ENV]);
  assert.equal(env[GATEWAY_BASE_URL_ENV], 'http://127.0.0.1:8788');
  assert.equal(env[GATEWAY_SDK_URL_ENV], 'http://127.0.0.1:8788');
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

test('wake account route — persisted default reconstructs a direct Claude route and settings purge', () => {
  const route = wakeAccountRouteFromArgv(['psu', '--account=default'], 'owner-default');
  assert.equal(route?.mode, 'default');
  assert.equal(route?.accountId, null);
  assert.deepEqual(route?.env, { [ACCOUNT_ROUTING_MODE_ENV]: 'default' });
  assert.equal(route?.claudeArgs[0], '--settings');
  const settings = JSON.parse(route?.claudeArgs[1] ?? '{}');
  assert.equal(settings.apiKeyHelper, '');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, '');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, '');
});

test('wake account route — auto and pin reuse gatewaySpawnEnv with owner attribution', () => {
  delete process.env.PAPERCUSP_GATEWAY_PORT;
  const auto = wakeAccountRouteFromArgv(['psu', '--account=auto'], 'owner-auto');
  assert.equal(auto?.mode, 'auto');
  assert.equal(auto?.accountId, null);
  assert.equal(auto?.env[ACCOUNT_ROUTING_MODE_ENV], 'auto');
  assert.equal(auto?.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8788');
  assert.equal(auto?.env.ANTHROPIC_AUTH_TOKEN, GATEWAY_CLIENT_AUTH_TOKEN);
  assert.equal(auto?.env.ANTHROPIC_CUSTOM_HEADERS, 'x-papercusp-owner: owner-auto');

  const pin = wakeAccountRouteFromArgv(['psu', '--account=acct-pin'], 'owner-pin');
  assert.equal(pin?.mode, 'pin');
  assert.equal(pin?.accountId, 'acct-pin');
  assert.equal(pin?.env[ACCOUNT_ROUTING_MODE_ENV], 'pin');
  assert.equal(pin?.env.PAPERCUSP_ACCOUNT_ID, 'acct-pin');
  assert.equal(
    pin?.env.ANTHROPIC_CUSTOM_HEADERS,
    'x-papercusp-account: acct-pin\nx-papercusp-account-pin: hard\nx-papercusp-owner: owner-pin',
  );
});

test('sanitizeInheritedWakeEnv — removes the operator gateway route but preserves unrelated env', () => {
  assert.deepEqual(
    sanitizeInheritedWakeEnv({
      PATH: '/usr/bin',
      PAPERCUSP_WORKSPACE: 'ws',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
      PAPERCUSP_ANTHROPIC_URL: 'http://127.0.0.1:8788',
      ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
      ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-owner: inherited',
      PAPERCUSP_ACCOUNT_ID: 'inherited-account',
      [ACCOUNT_ROUTING_MODE_ENV]: 'auto',
    }),
    { PATH: '/usr/bin', PAPERCUSP_WORKSPACE: 'ws' },
  );
});
