import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => ({ update_channel: 'stable' })),
}));

import route, { pickAssetUrl } from './updates-manifest';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

async function manifestStatus(qs: string): Promise<number> {
  const req = new Request(`http://127.0.0.1/api/updates/manifest${qs}`);
  const res = (await (route as unknown as {
    handler: (r: Request, c: unknown) => Promise<Response>;
  }).handler(req, {})) as Response;
  return res.status;
}

const release = {
  tag_name: 'desktop-v0.0.2-alpha',
  published_at: '2026-06-11T00:00:00Z',
  prerelease: true,
  draft: false,
  assets: [
    'Papercusp_universal.app.tar.gz',
    'Papercusp_universal.app.tar.gz.sig',
    'Papercusp_0.0.2_universal.dmg',
    'Papercusp_0.0.2_amd64.AppImage.tar.gz',
    'Papercusp_0.0.2_amd64.AppImage.tar.gz.sig',
    'Papercusp_0.0.2_x64_en-US.msi.zip',
    'latest.json',
  ].map((name) => ({ name, browser_download_url: `https://gh.test/${name}` })),
};

describe('pickAssetUrl', () => {
  it('serves a darwin universal bundle to BOTH mac arches', () => {
    expect(pickAssetUrl(release, 'darwin', 'x86_64')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
    expect(pickAssetUrl(release, 'darwin', 'aarch64')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
  });

  it('never serves the .dmg as an update payload (tar.gz/zip only)', () => {
    const dmgOnly = {
      ...release,
      assets: release.assets.filter((a) => a.name.endsWith('.dmg')),
    };
    expect(pickAssetUrl(dmgOnly, 'darwin', 'x86_64')).toBeNull();
  });

  it('keeps linux/windows arch matching unchanged', () => {
    expect(pickAssetUrl(release, 'linux', 'x86_64')).toBe(
      'https://gh.test/Papercusp_0.0.2_amd64.AppImage.tar.gz',
    );
    expect(pickAssetUrl(release, 'windows', 'x86_64')).toBe(
      'https://gh.test/Papercusp_0.0.2_x64_en-US.msi.zip',
    );
    expect(pickAssetUrl(release, 'linux', 'aarch64')).toBeNull();
  });

  it('does not leak the universal wildcard to non-darwin targets', () => {
    const weird = {
      ...release,
      assets: [{ name: 'Papercusp_universal.tar.gz', browser_download_url: 'https://gh.test/u' }],
    };
    expect(pickAssetUrl(weird, 'linux', 'x86_64')).toBeNull();
  });

  it('picks the Tauri v2 NSIS -setup.exe for windows (the real published shape), never its .sig', () => {
    const v2 = {
      ...release,
      assets: [
        'Papercusp_universal.app.tar.gz',
        'Papercusp_universal.app.tar.gz.sig',
        'Papercusp_0.0.2_universal.dmg',
        'Papercusp_0.0.2_amd64.deb',
        'Papercusp_0.0.2_x64-setup.exe',
        'Papercusp_0.0.2_x64-setup.exe.sig',
        'papercusp-latest-desktop-v0.0.2-alpha.json',
      ].map((name) => ({ name, browser_download_url: `https://gh.test/${name}` })),
    };
    expect(pickAssetUrl(v2, 'windows', 'x86_64')).toBe(
      'https://gh.test/Papercusp_0.0.2_x64-setup.exe',
    );
    // the bare exe never leaks to other targets
    expect(pickAssetUrl(v2, 'linux', 'x86_64')).toBeNull();
    expect(pickAssetUrl(v2, 'darwin', 'x86_64')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
  });
});

describe('GET /api/updates/manifest — graceful degradation when GitHub is unreachable', () => {
  // The route intentionally warns server-side on a fetch failure (ops observability);
  // spy it so the repo's fail-on-console guard is satisfied AND assert it fired.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockFetch.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('returns 204 (NOT 502) when GitHub rate-limits the releases fetch (403)', async () => {
    // Unauthenticated polling hits GitHub's 60/hr per-IP cap → 403. Previously this
    // 502'd and the Tauri updater logged "update endpoint did not respond with a
    // successful status code" on every poll. It must degrade to 204 = "no update".
    mockFetch.mockResolvedValue(new Response('rate limited', { status: 403 }));
    expect(await manifestStatus('?target=linux&arch=x86_64&current_version=0.0.1')).toBe(204);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns 204 when the releases fetch throws (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    expect(await manifestStatus('?target=linux&arch=x86_64&current_version=0.0.1')).toBe(204);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns 204 when GitHub 5xxs', async () => {
    mockFetch.mockResolvedValue(new Response('boom', { status: 503 }));
    expect(await manifestStatus('?target=linux&arch=x86_64&current_version=0.0.1')).toBe(204);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
