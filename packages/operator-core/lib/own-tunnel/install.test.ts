/**
 * external-app-access P-009: cloudflared is installed into the Papercusp data dir, verified
 * by running it before it replaces anything, and never installed when the download is bad.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloudflaredAssetFor, installCloudflared } from './install';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home() {
  const d = mkdtempSync(path.join(tmpdir(), 'own-tunnel-install-'));
  dirs.push(d);
  return d;
}

const BIG = Buffer.alloc(1_200_000, 7);
const okFetch = (async (url: string) => {
  okFetch.urls.push(String(url));
  return new Response(BIG, { status: 200 });
}) as unknown as typeof fetch & { urls: string[] };
okFetch.urls = [];

describe('cloudflaredAssetFor', () => {
  it('picks the official asset per platform', () => {
    expect(cloudflaredAssetFor('linux', 'x64')).toEqual({ asset: 'cloudflared-linux-amd64', tarball: false, exe: 'cloudflared' });
    expect(cloudflaredAssetFor('darwin', 'arm64')?.asset).toBe('cloudflared-darwin-arm64.tgz');
    expect(cloudflaredAssetFor('win32', 'x64')?.exe).toBe('cloudflared.exe');
    expect(cloudflaredAssetFor('freebsd', 'x64')).toBeNull();
  });
});

describe('installCloudflared', () => {
  it('downloads into <data dir>/bin and keeps it only after it runs', async () => {
    const h = home();
    const r = await installCloudflared({
      env: { PAPERCUSP_HOME: h },
      platform: 'linux',
      arch: 'x64',
      fetch: okFetch,
      run: async (_file, args) => (args[0] === '--version' ? 'cloudflared version 2026.9.0 (built 2026-09-01)' : ''),
    });
    expect(r).toEqual({ path: path.join(h, 'bin', 'cloudflared'), version: 'cloudflared version 2026.9.0' });
    expect(readFileSync(r.path).length).toBe(BIG.length);
    expect(okFetch.urls.at(-1)).toMatch(/\/cloudflared-linux-amd64$/);
  });

  it('refuses a binary that does not run, leaving nothing installed', async () => {
    const h = home();
    await expect(
      installCloudflared({ env: { PAPERCUSP_HOME: h }, platform: 'linux', arch: 'x64', fetch: okFetch, run: async () => 'Exec format error' }),
    ).rejects.toThrow(/did not run/);
    expect(existsSync(path.join(h, 'bin', 'cloudflared'))).toBe(false);
  });

  it('refuses a truncated download', async () => {
    const h = home();
    const tiny = (async () => new Response('404 page', { status: 200 })) as unknown as typeof fetch;
    await expect(installCloudflared({ env: { PAPERCUSP_HOME: h }, platform: 'linux', arch: 'x64', fetch: tiny })).rejects.toThrow(/only \d+ bytes/);
  });

  it('extracts the macOS tarball before verifying', async () => {
    const h = home();
    const calls: string[][] = [];
    await installCloudflared({
      env: { PAPERCUSP_HOME: h },
      platform: 'darwin',
      arch: 'arm64',
      fetch: okFetch,
      run: async (file, args) => {
        calls.push([path.basename(file), ...args.map((a) => (a.includes(path.sep) ? path.basename(a) : a))]);
        if (file === 'tar') {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(path.join(args[3]!, 'cloudflared'), 'bin');
          return '';
        }
        return 'cloudflared version 2026.9.0';
      },
    });
    expect(calls[0]).toEqual(['tar', '-xzf', 'cloudflared-darwin-arm64.tgz', '-C', expect.any(String)]);
    expect(calls[1]).toEqual(['cloudflared', '--version']);
  });
});
