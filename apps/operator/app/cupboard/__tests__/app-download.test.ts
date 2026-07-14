/**
 * app-download.test.ts — the pure helpers behind the standalone-app download
 * flow (cupboard-app-distribution-2026-07-14 P-005): OS-family mapping, the
 * denormalized platform-family read, fail-soft `latest.json` parsing, and the
 * viewer-OS installer resolution. These are the trust-critical bits the detail
 * page leans on — a mis-parse must degrade one panel, never dead-end a download.
 */
import { describe, it, expect } from 'vitest';
import {
  platformOsFamily,
  appPlatformFamilies,
  parseLatestManifest,
  installersFromManifest,
  resolveInstallerForViewer,
} from '../app-download';

const MANIFEST = JSON.stringify({
  version: '1.4.0',
  notes: 'Fixes the odds cache.',
  pub_date: '2026-07-14T00:00:00Z',
  platforms: {
    'darwin-aarch64': { signature: 'sig-mac', url: 'https://gh/rel/mac.tar.gz' },
    'linux-x86_64': { signature: 'sig-linux', url: 'https://gh/rel/linux.AppImage' },
    'windows-x86_64': { signature: 'sig-win', url: 'https://gh/rel/win.msi' },
  },
});

describe('platformOsFamily', () => {
  it('maps the updater keys to friendly OS families', () => {
    expect(platformOsFamily('darwin-aarch64')).toBe('macOS');
    expect(platformOsFamily('macos-x86_64')).toBe('macOS');
    expect(platformOsFamily('windows-x86_64')).toBe('Windows');
    expect(platformOsFamily('linux-x86_64')).toBe('Linux');
  });
  it('passes an unknown key through unchanged', () => {
    expect(platformOsFamily('freebsd-x86_64')).toBe('freebsd-x86_64');
  });
});

describe('appPlatformFamilies', () => {
  it('returns the distinct families from a denormalized platforms JSON string[]', () => {
    const fams = appPlatformFamilies(JSON.stringify(['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']));
    expect(fams.sort()).toEqual(['Linux', 'Windows', 'macOS']);
  });
  it('dedupes families that share an OS (two mac arches ⇒ one macOS)', () => {
    expect(appPlatformFamilies(JSON.stringify(['darwin-aarch64', 'darwin-x86_64']))).toEqual(['macOS']);
  });
  it('is fail-soft: null / malformed / non-array ⇒ []', () => {
    expect(appPlatformFamilies(null)).toEqual([]);
    expect(appPlatformFamilies(undefined)).toEqual([]);
    expect(appPlatformFamilies('{ not json')).toEqual([]);
    expect(appPlatformFamilies(JSON.stringify({ not: 'an array' }))).toEqual([]);
  });
});

describe('parseLatestManifest', () => {
  it('parses a good manifest with version + notes + pub_date + platforms', () => {
    const m = parseLatestManifest(MANIFEST);
    expect(m).not.toBeNull();
    expect(m!.version).toBe('1.4.0');
    expect(m!.notes).toBe('Fixes the odds cache.');
    expect(m!.pub_date).toBe('2026-07-14T00:00:00Z');
    expect(Object.keys(m!.platforms).sort()).toEqual(['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']);
    expect(m!.platforms['linux-x86_64'].url).toBe('https://gh/rel/linux.AppImage');
  });
  it('defaults notes/pub_date to null when absent', () => {
    const m = parseLatestManifest(JSON.stringify({ version: '1.0.0', platforms: { 'linux-x86_64': { url: 'https://x' } } }));
    expect(m).not.toBeNull();
    expect(m!.notes).toBeNull();
    expect(m!.pub_date).toBeNull();
  });
  it('is tolerant of a missing per-entry signature (download only needs the url)', () => {
    const m = parseLatestManifest(JSON.stringify({ version: '2.0.0', platforms: { 'linux-x86_64': { url: 'https://x' } } }));
    expect(m).not.toBeNull();
    expect(m!.platforms['linux-x86_64'].url).toBe('https://x');
    expect(m!.platforms['linux-x86_64'].signature).toBe('');
  });
  it('drops an entry with no url but keeps the usable ones', () => {
    const m = parseLatestManifest(JSON.stringify({
      version: '2.0.0',
      platforms: { 'linux-x86_64': { url: 'https://x' }, 'windows-x86_64': { signature: 'no-url' } },
    }));
    expect(Object.keys(m!.platforms)).toEqual(['linux-x86_64']);
  });
  it('returns null when nothing is downloadable / shape is wrong', () => {
    expect(parseLatestManifest('{ not json')).toBeNull();
    expect(parseLatestManifest('[]')).toBeNull();
    expect(parseLatestManifest(JSON.stringify({ platforms: { 'linux-x86_64': { url: 'https://x' } } }))).toBeNull(); // no version
    expect(parseLatestManifest(JSON.stringify({ version: '1.0.0' }))).toBeNull(); // no platforms
    expect(parseLatestManifest(JSON.stringify({ version: '1.0.0', platforms: { 'linux-x86_64': { signature: 's' } } }))).toBeNull(); // no usable url
  });
});

describe('installersFromManifest', () => {
  it('yields one installer per usable platform with its OS family + url', () => {
    const installers = installersFromManifest(parseLatestManifest(MANIFEST)!);
    expect(installers).toHaveLength(3);
    const mac = installers.find((i) => i.platformKey === 'darwin-aarch64')!;
    expect(mac.osFamily).toBe('macOS');
    expect(mac.url).toBe('https://gh/rel/mac.tar.gz');
    expect(mac.signature).toBe('sig-mac');
  });
});

describe('resolveInstallerForViewer', () => {
  const m = parseLatestManifest(MANIFEST)!;
  it('picks the installer matching the viewer OS family', () => {
    expect(resolveInstallerForViewer(m, 'macOS')?.platformKey).toBe('darwin-aarch64');
    expect(resolveInstallerForViewer(m, 'Windows')?.platformKey).toBe('windows-x86_64');
    expect(resolveInstallerForViewer(m, 'Linux')?.platformKey).toBe('linux-x86_64');
  });
  it('returns null when the viewer OS is undetectable (null)', () => {
    expect(resolveInstallerForViewer(m, null)).toBeNull();
  });
  it('returns null when the app has no build for the viewer OS', () => {
    const macOnly = parseLatestManifest(JSON.stringify({ version: '1.0.0', platforms: { 'darwin-aarch64': { url: 'https://x' } } }))!;
    expect(resolveInstallerForViewer(macOnly, 'Windows')).toBeNull();
  });
});
