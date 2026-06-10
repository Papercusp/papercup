/** Tests for the gateway spawn-env patch (P-012). */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { gatewaySpawnEnv, gatewayPort, GATEWAY_BASE_URL_ENV } from './spawn-env';

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
  assert.deepEqual(gatewaySpawnEnv(true), { [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8788' });
});

test('gatewayPort — honors PAPERCUSP_GATEWAY_PORT, falls back to 8788', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9999';
  assert.equal(gatewayPort(), 9999);
  assert.deepEqual(gatewaySpawnEnv(true), { [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:9999' });
  process.env.PAPERCUSP_GATEWAY_PORT = 'not-a-number';
  assert.equal(gatewayPort(), 8788);
});
