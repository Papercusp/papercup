/**
 * publish-file.test.ts — PUT /publish/file/:depId/:sha256 (Plan 2 Phase A, P-002b).
 *
 * The per-file upload endpoint is guarded by a signed upload token (minted by
 * publish-start, scoped to deploymentId + sha256) and a content-integrity check
 * (the uploaded bytes' sha256 must equal the URL sha). This pins both gates plus
 * the size cap and the success fan-out (CF upload + R2 archive + markUploaded),
 * with publish-auth / db / cf / r2 mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verifyFileToken: vi.fn(),
  fileSha256Hex: vi.fn(),
  getDeployment: vi.fn(),
  getProject: vi.fn(),
  markFileUploaded: vi.fn(async () => {}),
  uploadFile: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

vi.mock('@papercusp/publish-auth', () => ({
  verifyFileToken: h.verifyFileToken,
  fileSha256Hex: h.fileSha256Hex,
  b64uDecode: vi.fn(() => new Uint8Array(8)),
}));
vi.mock('../db.ts', () => ({
  getDeployment: h.getDeployment,
  getProject: h.getProject,
  markFileUploaded: h.markFileUploaded,
}));
vi.mock('../cf-pages.ts', () => ({ uploadFile: h.uploadFile }));
vi.mock('../r2-archive.ts', () => ({ writeFile: h.writeFile }));

import { publishFileRoute } from './publish-file.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = { DB: {}, JWT_SECRET: 'AAAA', PER_FILE_BYTES_CAP: '100' };
const put = (path: string, body: Uint8Array, contentLength?: string) =>
  publishFileRoute().request(
    path,
    {
      method: 'PUT',
      body,
      headers: { 'content-length': contentLength ?? String(body.byteLength) },
    },
    env,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyFileToken.mockResolvedValue(true);
  h.getDeployment.mockResolvedValue({ id: 'dep-1', tenant_id: 'tenant-1', harness_slug: 'demo' });
  h.getProject.mockResolvedValue({ cf_project_name: 'cf-demo' });
  h.fileSha256Hex.mockResolvedValue('abc'); // matches the :sha256 in the URLs below
});
afterEach(() => vi.clearAllMocks());

describe('PUT /publish/file/:depId/:sha256', () => {
  it('TOKEN GATE: 401 when the upload token is invalid/expired', async () => {
    h.verifyFileToken.mockResolvedValue(false);
    const res = await put('/publish/file/dep-1/abc?token=bad', new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(401);
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it('404 for an unknown deployment', async () => {
    h.getDeployment.mockResolvedValue(null);
    const res = await put('/publish/file/nope/abc?token=t', new Uint8Array([1]));
    expect(res.status).toBe(404);
  });

  it('413 when the declared content-length exceeds the per-file cap', async () => {
    const res = await put('/publish/file/dep-1/abc?token=t', new Uint8Array([1, 2, 3]), '999');
    expect(res.status).toBe(413);
  });

  it('INTEGRITY: 400 when the uploaded bytes do not hash to the URL sha256', async () => {
    h.fileSha256Hex.mockResolvedValue('different');
    const res = await put('/publish/file/dep-1/abc?token=t', new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('sha256 mismatch') });
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it('uploads on success: CF + R2 fan-out, then marks the file uploaded', async () => {
    const res = await put('/publish/file/dep-1/abc?token=t', new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    expect(h.writeFile).toHaveBeenCalledTimes(1);
    expect(h.markFileUploaded).toHaveBeenCalledWith(expect.anything(), 'dep-1', 'abc');
  });
});
