import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./updates-github', () => ({
  GITHUB_DESKTOP_REPO: 'Papercusp/papercusp-desktop',
  resolveGithubToken: vi.fn(async () => 'test-token'),
  fetchAssetText: vi.fn(async () => null),
  fetchAssetResponse: vi.fn(async () => null),
  githubApiHeaders: () => ({}),
  releaseHostBase: vi.fn(() => null),
}));

import route from './updates-download';
import { fetchAssetResponse, releaseHostBase } from './updates-github';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

async function download(qs: string): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3070/api/updates/download${qs}`);
  return (await (route as unknown as {
    handler: (r: Request, c: unknown) => Promise<Response>;
  }).handler(req, {})) as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(fetchAssetResponse).mockResolvedValue(null);
  vi.mocked(releaseHostBase).mockReturnValue(null);
});

describe('GET /api/updates/download', () => {
  it('streams a GitHub asset through, preserving content-length', async () => {
    vi.mocked(fetchAssetResponse).mockResolvedValue(
      new Response('BINARY_PAYLOAD', {
        status: 200,
        headers: { 'content-length': '14', 'content-type': 'application/octet-stream' },
      }),
    );
    const res = await download('?asset_id=42&name=Papercusp.GUI_0.0.4_x64-setup.exe');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('14');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('BINARY_PAYLOAD');
  });

  it('502s (does not hang the updater) when the asset is unreachable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await download('?asset_id=42');
    expect(res.status).toBe(502);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('rejects a non-numeric asset_id', async () => {
    expect((await download('?asset_id=../../evil')).status).toBe(400);
  });

  it('rejects unsafe artifact names', async () => {
    expect((await download('?tag=desktop-v0.0.4-alpha&name=..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
  });

  it('404s on tag+name when no release host is configured', async () => {
    const res = await download('?tag=desktop-v0.0.4-alpha&name=Papercusp_GUI_0.0.4_amd64.AppImage');
    expect(res.status).toBe(404);
  });

  it('streams an off-GitHub artifact from the configured release host', async () => {
    vi.mocked(releaseHostBase).mockReturnValue('http://10.0.2.2:8043');
    mockFetch
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(
        new Response('APPIMAGE_BYTES', {
          status: 200,
          headers: { 'content-length': '14' },
        }),
      );
    const res = await download('?tag=desktop-v0.0.4-alpha&name=Papercusp_GUI_0.0.4_amd64.AppImage');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('APPIMAGE_BYTES');
    // tried <host>/<tag>/<file> first, then <host>/<file>
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('400s when neither asset_id nor tag+name are passed', async () => {
    expect((await download('')).status).toBe(400);
  });
});
