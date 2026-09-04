import { describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  build: vi.fn(async (key: string, distinctId: string) => ({
    ok: true,
    key,
    distinctId,
    resolvedValue: true,
    compiledDefault: true,
  })),
}));

vi.mock('../../../flag-attestation', () => ({
  assertKnownFlagKey: (key: string) => {
    if (key !== 'known-flag') throw new Error('Unknown flag key ' + key);
  },
  buildProcessFlagAttestation: stubs.build,
}));
vi.mock('../../../schedule-federation', () => ({
  describeProcessRole: () => 'operator',
  ownHonoPort: () => 3170,
}));

const { default: route } = await import('./flag-attest');
const call = (url: string) => route.handler(new Request(url), {} as never) as Promise<Response>;

describe('GET /internal/flags-attest', () => {
  it('is a loopback-only route', () => {
    expect(route).toMatchObject({
      method: 'GET',
      path: '/internal/flags-attest',
      auth: 'loopback',
    });
  });

  it('calls the process-native resolver with the supplied distinct id', async () => {
    const response = await call('http://127.0.0.1:3170/api/internal/flags-attest?key=known-flag&distinctId=did-1');
    expect(response.status).toBe(200);
    expect(stubs.build).toHaveBeenCalledWith('known-flag', 'did-1', {
      role: 'operator',
      label: 'operator:3170',
      port: 3170,
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true, key: 'known-flag' });
  });

  it('returns 400 for missing or unknown keys', async () => {
    expect((await call('http://127.0.0.1:3170/api/internal/flags-attest')).status).toBe(400);
    expect((await call('http://127.0.0.1:3170/api/internal/flags-attest?key=made-up')).status).toBe(400);
  });

  it('keeps resolver failures as named diagnostic data instead of an opaque 5xx', async () => {
    stubs.build.mockRejectedValueOnce(new Error('override store unavailable'));
    const response = await call('http://127.0.0.1:3170/api/internal/flags-attest?key=known-flag');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      key: 'known-flag',
      error: 'override store unavailable',
    });
  });
});
