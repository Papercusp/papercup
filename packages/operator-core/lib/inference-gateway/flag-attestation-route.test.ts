import { afterEach, describe, expect, it } from 'vitest';
import { ALL_FLAG_KEYS, FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { createInferenceGateway } from './gateway';
import {
  GATEWAY_ADMISSION_BYPASS_KEYS,
  GATEWAY_ADMISSION_BYPASS_REGISTRY,
  gatewayAdmissionBypassKeyForRequest,
  gatewayAdmissionKindForBypassKey,
} from './admission-context';

const KEY = ALL_FLAG_KEYS[0] as FlagKey;
const ENV_KEY = 'PAPERCUSP_FLAG_' + KEY.toUpperCase().replace(/-/g, '_');
let gateway: ReturnType<typeof createInferenceGateway> | undefined;

afterEach(async () => {
  delete process.env[ENV_KEY];
  await gateway?.close();
  gateway = undefined;
});

describe('inference-gateway flag attestation route', () => {
  it('is an explicit metadata bypass rather than falling through the generic not-found bypass', () => {
    const key = gatewayAdmissionBypassKeyForRequest('GET', '/internal/flags-attest?key=' + encodeURIComponent(KEY));
    expect(key).toBe(GATEWAY_ADMISSION_BYPASS_KEYS.flagAttest);
    expect(GATEWAY_ADMISSION_BYPASS_REGISTRY.has(key as string)).toBe(true);
    expect(gatewayAdmissionKindForBypassKey(key!)).toBe('metadata');
  });

  it('reports the gateway process live resolver value and identity', async () => {
    process.env[ENV_KEY] = FLAG_DEFAULTS[KEY] ? '0' : '1';
    gateway = createInferenceGateway({
      accountId: 'test-account',
      token: async () => 'test-token',
      proactiveEgressProbeMs: 0,
      selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);

    const response = await fetch('http://127.0.0.1:' + port + '/internal/flags-attest?key=' + encodeURIComponent(KEY));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      key: KEY,
      resolvedValue: !FLAG_DEFAULTS[KEY],
      compiledDefault: FLAG_DEFAULTS[KEY],
      source: 'env-override',
      process: {
        role: 'inference-gateway',
        label: 'inference-gateway:' + port,
        port,
        pid: process.pid,
      },
    });
  });

  it('rejects an unknown key as caller input', async () => {
    gateway = createInferenceGateway({
      accountId: 'test-account',
      token: async () => 'test-token',
      proactiveEgressProbeMs: 0,
      selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = await fetch('http://127.0.0.1:' + port + '/internal/flags-attest?key=definitely-made-up');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
