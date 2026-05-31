/**
 * publish-start.test.ts — the integrity + caps gates of POST /publish/start
 * (Plan 2 Phase A, P-002).
 *
 * The most security-relevant behavior of the publish flow is the manifest
 * integrity gate: the body is re-canonicalized and its sha256 MUST equal the
 * sha256 the JWT was signed over (claims.sha256) — otherwise a tenant could
 * sign one manifest and upload a different one. After that come the size caps
 * (file count / per-file bytes / total bytes). All of these short-circuit
 * before any DB / project / rate-limit work, so this test drives the real route
 * with a pass-through jwtMiddleware and a controllable manifestSha256Hex.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  manifestSha256Hex: vi.fn(),
}));

vi.mock('@papercusp/publish-auth', () => ({
  manifestSha256Hex: h.manifestSha256Hex,
  mintFileToken: vi.fn(async () => 'tok'),
  deploymentId: vi.fn(() => 'dep-1'),
  b64uDecode: vi.fn(() => new Uint8Array(8)),
}));
// Pass-through auth: bind the claims the handler reads (sha256 it must match).
vi.mock('../jwt-middleware.ts', () => ({
  jwtMiddleware: () => async (c: any, next: any) => {
    c.set('jwt', { sha256: 'EXPECTED', jti: 'j', exp: 9_999_999_999, sub: 'tenant-1' });
    c.set('tenantId', 'tenant-1');
    await next();
  },
}));
vi.mock('../db.ts', () => ({
  clientIp: vi.fn(() => '1.2.3.4'),
  audit: vi.fn(async () => {}),
  findRecentDeploymentByManifest: vi.fn(async () => null),
  getProject: vi.fn(async () => null),
  insertDeployment: vi.fn(async () => {}),
  insertDeploymentFiles: vi.fn(async () => {}),
  insertProject: vi.fn(async () => {}),
  listDeploymentFiles: vi.fn(async () => []),
}));

import { publishStartRoute } from './publish-start.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = {
  DB: {},
  DEPLOYMENT_FILES_CAP: '3',
  DEPLOYMENT_BYTES_CAP: '1000',
  PER_FILE_BYTES_CAP: '500',
  VANITY_HOST: 'preview.example.com',
  PUBLISH_HOST: 'publish.example.com',
  JWT_SECRET: 'AAAA',
};
const file = (path: string, bytes: number) => ({ path, sha256: `sha-${path}`, bytes });
const start = (body: unknown, raw = false) =>
  publishStartRoute().request(
    '/publish/start',
    { method: 'POST', body: raw ? (body as string) : JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    env,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.manifestSha256Hex.mockResolvedValue('EXPECTED'); // matches claims by default
});
afterEach(() => vi.clearAllMocks());

describe('POST /publish/start — integrity + caps gates', () => {
  it('rejects an invalid JSON body with 400', async () => {
    const res = await start('this is not json', true);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid json body' });
  });

  it('rejects a malformed manifest (no deployment_slug / files) with 400', async () => {
    const res = await start({ files: [] }); // missing deployment_slug
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'malformed manifest' });
  });

  it('INTEGRITY GATE: rejects when the recomputed sha256 != the JWT claim', async () => {
    h.manifestSha256Hex.mockResolvedValue('OTHER'); // != claims.sha256 'EXPECTED'
    const res = await start({ deployment_slug: 'demo', files: [file('a', 10)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'manifest sha256 does not match jwt claim' });
  });

  it('rejects too many files with 413', async () => {
    const files = [file('a', 1), file('b', 1), file('c', 1), file('d', 1)]; // 4 > cap 3
    const res = await start({ deployment_slug: 'demo', files });
    expect(res.status).toBe(413);
  });

  it('rejects a file over the per-file byte cap with 413', async () => {
    const res = await start({ deployment_slug: 'demo', files: [file('big', 600)] }); // 600 > 500
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('per-file cap') });
  });

  it('rejects when total bytes exceed the cap with 413', async () => {
    const files = [file('a', 400), file('b', 400), file('c', 400)]; // each < 500, sum 1200 > 1000
    const res = await start({ deployment_slug: 'demo', files });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('total bytes') });
  });
});
