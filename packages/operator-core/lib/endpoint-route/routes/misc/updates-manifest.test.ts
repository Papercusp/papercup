import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => ({ update_channel: 'stable' })),
}));

// The manifest route resolves a GitHub token + fetches .sig asset content
// through updates-github; mock the module so tests never shell out to the
// gh CLI or hit the network for sig content.
vi.mock('./updates-github', () => ({
  GITHUB_DESKTOP_REPO: 'Papercusp/papercusp-desktop',
  resolveGithubToken: vi.fn(async () => 'test-token'),
  fetchAssetText: vi.fn(async () => 'SIG_CONTENT'),
  fetchAssetResponse: vi.fn(async () => null),
  githubApiHeaders: (token: string | null) => ({
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }),
  releaseHostBase: vi.fn(() => null),
}));

import route, { pickAssetUrl, normalizeTagVersion } from './updates-manifest';
import { resolveGithubToken, fetchAssetText, releaseHostBase } from './updates-github';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

async function manifestResponse(qs: string): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3070/api/updates/manifest${qs}`);
  return (await (route as unknown as {
    handler: (r: Request, c: unknown) => Promise<Response>;
  }).handler(req, {})) as Response;
}

async function manifestStatus(qs: string): Promise<number> {
  return (await manifestResponse(qs)).status;
}

function toAssets(names: string[]) {
  return names.map((name, i) => ({
    id: i + 1,
    name,
    browser_download_url: `https://gh.test/${name}`,
  }));
}

const release = {
  tag_name: 'desktop-v0.0.2-alpha',
  published_at: '2026-06-11T00:00:00Z',
  prerelease: true,
  draft: false,
  assets: toAssets([
    'Papercusp_universal.app.tar.gz',
    'Papercusp_universal.app.tar.gz.sig',
    'Papercusp_0.0.2_universal.dmg',
    'Papercusp_0.0.2_amd64.AppImage.tar.gz',
    'Papercusp_0.0.2_amd64.AppImage.tar.gz.sig',
    'Papercusp_0.0.2_x64_en-US.msi.zip',
    'latest.json',
  ]),
};

describe('normalizeTagVersion', () => {
  it('strips the desktop-v prefix into valid semver', () => {
    expect(normalizeTagVersion('desktop-v0.0.4-alpha')).toBe('0.0.4-alpha');
    expect(normalizeTagVersion('desktop-v0.0.2-alpha.4')).toBe('0.0.2-alpha.4');
    expect(normalizeTagVersion('desktop-v1.2.3')).toBe('1.2.3');
    expect(normalizeTagVersion('v0.0.9')).toBe('0.0.9');
    expect(normalizeTagVersion('0.0.9')).toBe('0.0.9');
  });
});

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
      assets: [{ id: 1, name: 'Papercusp_universal.tar.gz', browser_download_url: 'https://gh.test/u' }],
    };
    expect(pickAssetUrl(weird, 'linux', 'x86_64')).toBeNull();
  });

  it('picks the Tauri v2 NSIS -setup.exe for windows (the real published shape), never its .sig', () => {
    const v2 = {
      ...release,
      assets: toAssets([
        'Papercusp_universal.app.tar.gz',
        'Papercusp_universal.app.tar.gz.sig',
        'Papercusp_0.0.2_universal.dmg',
        'Papercusp_0.0.2_amd64.deb',
        'Papercusp_0.0.2_x64-setup.exe',
        'Papercusp_0.0.2_x64-setup.exe.sig',
        'papercusp-latest-desktop-v0.0.2-alpha.json',
      ]),
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

  it('scopes assets by PRODUCT — the GUI never gets a Server installer (and vice versa)', () => {
    const split = {
      ...release,
      assets: toAssets([
        'Papercusp.GUI_0.0.3_x64-setup.exe',
        'Papercusp.GUI_0.0.3_x64-setup.exe.sig',
        'Papercusp.Server_0.0.3_x64-setup.exe',
        'Papercusp.Server_0.0.3_x64-setup.exe.sig',
        'Papercusp GUI.app.tar.gz',
        'Papercusp Server.app.tar.gz',
      ]),
    };
    expect(pickAssetUrl(split, 'windows', 'x86_64', 'gui')).toBe(
      'https://gh.test/Papercusp.GUI_0.0.3_x64-setup.exe',
    );
    expect(pickAssetUrl(split, 'windows', 'x86_64', 'server')).toBe(
      'https://gh.test/Papercusp.Server_0.0.3_x64-setup.exe',
    );
    // default = gui
    expect(pickAssetUrl(split, 'windows', 'x86_64')).toBe(
      'https://gh.test/Papercusp.GUI_0.0.3_x64-setup.exe',
    );
    // pre-split assets (no product token) still serve both products
    expect(pickAssetUrl(release, 'darwin', 'x86_64', 'server')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
  });
});

describe('GET /api/updates/manifest — manifest contract with tauri-plugin-updater', () => {
  const guiRelease = {
    tag_name: 'desktop-v0.0.4-alpha',
    body: 'notes here',
    published_at: '2026-07-09T00:00:00Z',
    prerelease: true,
    draft: false,
    assets: toAssets([
      'Papercusp.GUI_0.0.4_x64-setup.exe',
      'Papercusp.GUI_0.0.4_x64-setup.exe.sig',
      'Papercusp_GUI_0.0.4_amd64.AppImage',
      'Papercusp_GUI_0.0.4_amd64.AppImage.sig',
      'papercusp-latest-desktop-v0.0.4-alpha.json',
    ]),
  };

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(resolveGithubToken).mockResolvedValue('test-token');
    vi.mocked(fetchAssetText).mockResolvedValue('SIG_CONTENT');
    vi.mocked(releaseHostBase).mockReturnValue(null);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([guiRelease]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('serves semver version, INLINE sig content, and a proxied download URL', async () => {
    const res = await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3&channel=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    // NOT "desktop-v0.0.4-alpha" — the plugin semver-parses this field.
    expect(body.version).toBe('0.0.4-alpha');
    const win = body.platforms['windows-x86_64'];
    // NOT a URL — the plugin base64-decodes this as minisign content.
    expect(win.signature).toBe('SIG_CONTENT');
    // Token-gated asset → served through the local operator proxy.
    expect(win.url).toContain('http://127.0.0.1:3070/api/updates/download?asset_id=1');
  });

  it('picks the bare .AppImage for linux and proxies it', async () => {
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.3&channel=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Record<string, { url: string }> };
    expect(body.platforms['linux-x86_64'].url).toContain('/api/updates/download?asset_id=3');
  });

  it('204s when current_version already matches the candidate (normalized)', async () => {
    expect(
      await manifestStatus('?target=windows&arch=x86_64&current_version=0.0.4-alpha&channel=alpha'),
    ).toBe(204);
  });

  it('204s (with a server-side warn) when NO GitHub token is available — private repo', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(resolveGithubToken).mockResolvedValue(null);
    expect(await manifestStatus('?target=windows&arch=x86_64&current_version=0.0.3')).toBe(204);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('falls back to latest.json + release host for artifacts too big for GitHub (Linux)', async () => {
    const noLinuxAssets = {
      ...guiRelease,
      assets: toAssets([
        'Papercusp.GUI_0.0.4_x64-setup.exe',
        'Papercusp.GUI_0.0.4_x64-setup.exe.sig',
        'papercusp-latest-desktop-v0.0.4-alpha.json',
      ]),
    };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([noLinuxAssets]), { status: 200 }),
    );
    vi.mocked(releaseHostBase).mockReturnValue('http://10.0.2.2:8043');
    vi.mocked(fetchAssetText).mockResolvedValue(
      JSON.stringify({
        version: '0.0.4-alpha',
        pub_date: '2026-07-09T00:00:00Z',
        platforms: {
          'linux-x86_64': {
            signature: 'INLINE_SIG_FROM_LATEST_JSON',
            url: '__RELEASE_HOST__/Papercusp_GUI_0.0.4_amd64.AppImage',
          },
        },
      }),
    );
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.3&channel=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    expect(body.version).toBe('0.0.4-alpha');
    const linux = body.platforms['linux-x86_64'];
    expect(linux.signature).toBe('INLINE_SIG_FROM_LATEST_JSON');
    expect(linux.url).toContain('/api/updates/download?tag=desktop-v0.0.4-alpha');
    expect(linux.url).toContain('name=Papercusp_GUI_0.0.4_amd64.AppImage');
  });

  it('404s with a clear error when the platform has no asset anywhere', async () => {
    vi.mocked(releaseHostBase).mockReturnValue(null);
    expect(await manifestStatus('?target=linux&arch=aarch64&current_version=0.0.3&channel=alpha')).toBe(404);
  });
});

describe('GET /api/updates/manifest — graceful degradation when GitHub is unreachable', () => {
  // The route intentionally warns server-side on a fetch failure (ops observability);
  // spy it so the repo's fail-on-console guard is satisfied AND assert it fired.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(resolveGithubToken).mockResolvedValue('test-token');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('returns 204 (NOT 502) when GitHub rate-limits the releases fetch (403)', async () => {
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
