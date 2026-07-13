import { describe, expect, it } from 'vitest';
import { buildHistory, buildHistoryFromStatic, type StaticHistory } from './updates-history';
import type { GhRelease } from './updates-manifest';

/** Minimal GitHub release fixture. */
function rel(
  tag: string,
  published_at: string,
  opts: { prerelease?: boolean; draft?: boolean; assets?: string[]; body?: string } = {},
): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    body: opts.body ?? `notes for ${tag}`,
    published_at,
    prerelease: opts.prerelease ?? (tag.includes('-alpha') || tag.includes('-beta')),
    draft: opts.draft ?? false,
    assets: (opts.assets ?? []).map((name, i) => ({
      id: i + 1,
      name,
      browser_download_url: `https://example/${name}`,
    })),
  };
}

const RELEASES: GhRelease[] = [
  rel('desktop-v0.0.7-alpha', '2026-07-10T00:00:00Z', {
    assets: ['Papercusp GUI_0.0.7_x64-setup.exe', 'Papercusp GUI_0.0.7_x64-setup.exe.sig'],
  }),
  rel('desktop-v0.0.6-beta', '2026-07-08T00:00:00Z'),
  rel('desktop-v0.0.5', '2026-07-05T00:00:00Z', { prerelease: false }), // stable
  rel('desktop-v0.0.4-draft', '2026-07-09T00:00:00Z', { draft: true }), // never shown
];

const baseOpts = {
  target: 'windows',
  arch: 'x86_64',
  product: 'gui' as const,
  currentVersion: '',
  limit: 20,
};

describe('buildHistory — Update Center release list (pure)', () => {
  it('an alpha user sees every channel, newest-first, drafts excluded', () => {
    const h = buildHistory(RELEASES, { ...baseOpts, channel: 'alpha' });
    expect(h.map((e) => e.tag)).toEqual([
      'desktop-v0.0.7-alpha',
      'desktop-v0.0.6-beta',
      'desktop-v0.0.5',
    ]);
    expect(h.some((e) => e.tag.includes('draft'))).toBe(false);
  });

  it('a beta user sees beta+stable but NOT alpha', () => {
    const h = buildHistory(RELEASES, { ...baseOpts, channel: 'beta' });
    expect(h.map((e) => e.channel)).toEqual(['beta', 'stable']);
    expect(h.some((e) => e.channel === 'alpha')).toBe(false);
  });

  it('a stable user sees only stable', () => {
    const h = buildHistory(RELEASES, { ...baseOpts, channel: 'stable' });
    expect(h.map((e) => e.tag)).toEqual(['desktop-v0.0.5']);
  });

  it('normalizes version, carries notes, and marks the installed release', () => {
    const h = buildHistory(RELEASES, { ...baseOpts, channel: 'alpha', currentVersion: '0.0.6-beta' });
    const cur = h.find((e) => e.is_current);
    expect(cur?.tag).toBe('desktop-v0.0.6-beta');
    expect(cur?.version).toBe('0.0.6-beta');
    expect(h.find((e) => e.tag === 'desktop-v0.0.7-alpha')!.notes).toContain('notes for');
    // exactly one is_current
    expect(h.filter((e) => e.is_current).length).toBe(1);
  });

  it('installable reflects whether an asset matches this target/arch/product', () => {
    const h = buildHistory(RELEASES, { ...baseOpts, channel: 'alpha' });
    // 0.0.7 has a windows gui setup.exe → installable; the others have no assets.
    expect(h.find((e) => e.tag === 'desktop-v0.0.7-alpha')!.installable).toBe(true);
    expect(h.find((e) => e.tag === 'desktop-v0.0.6-beta')!.installable).toBe(false);
  });

  it('honors the limit (newest kept)', () => {
    const h = buildHistory(RELEASES, { ...baseOpts, channel: 'alpha', limit: 1 });
    expect(h).toHaveLength(1);
    expect(h[0].tag).toBe('desktop-v0.0.7-alpha');
  });
});

// ── The static release host: the source that actually has our releases in it.
describe('buildHistoryFromStatic — the local-only rail', () => {
  const history: StaticHistory = {
    generated_at: '2026-07-13T00:00:00Z',
    releases: [
      {
        tag: 'desktop-v0.0.9-alpha',
        version: '0.0.9',
        channel: 'alpha',
        notes: '## Highlights\n\nAuto-update works.',
        pub_date: '2026-07-13T00:00:00Z',
        prerelease: true,
        artifacts: [
          {
            product: 'gui',
            platform: 'linux-x86_64',
            name: 'gui.deb',
            url: 'desktop-v0.0.9-alpha/gui.deb',
            size: 1,
            sha256: 'a',
          },
          {
            product: 'gui',
            platform: 'darwin-universal',
            name: 'gui.dmg',
            url: 'desktop-v0.0.9-alpha/gui.dmg',
            size: 1,
            sha256: 'b',
          },
        ],
      },
      {
        tag: 'desktop-v0.0.8-alpha',
        version: '0.0.8',
        channel: 'alpha',
        notes: 'older',
        pub_date: '2026-07-12T00:00:00Z',
        prerelease: true,
        artifacts: [],
      },
    ],
  };

  const opts = {
    channel: 'alpha' as const,
    target: 'linux',
    arch: 'x86_64',
    product: 'gui' as const,
    currentVersion: '',
    limit: 20,
  };

  it('lists the releases newest-first and marks what this machine can install', () => {
    const h = buildHistoryFromStatic(history, opts);
    // Semver, prerelease tag included — the same normalization the updater compares
    // against, so the list and the update check can never disagree about a version.
    expect(h.map((r) => r.version)).toEqual(['0.0.9-alpha', '0.0.8-alpha']);
    expect(h[0].installable).toBe(true);
    // 0.0.8's installers were never uploaded — offering "Install" would 404.
    expect(h[1].installable).toBe(false);
  });

  it('marks the RUNNING version as current', () => {
    const h = buildHistoryFromStatic(history, { ...opts, currentVersion: '0.0.8-alpha' });
    expect(h.find((r) => r.version === '0.0.8-alpha')?.is_current).toBe(true);
  });

  it('a universal mac build IS installable on both mac arches', () => {
    // darwin-universal !== darwin-aarch64, so a naive equality check marks every mac
    // release un-installable on the one machine it certainly runs on.
    for (const arch of ['aarch64', 'x86_64']) {
      const h = buildHistoryFromStatic(history, { ...opts, target: 'darwin', arch });
      expect(h[0].installable, `darwin/${arch}`).toBe(true);
    }
  });

  it('does not offer the GUI build to someone asking for the Server product', () => {
    const h = buildHistoryFromStatic(history, { ...opts, product: 'server' });
    expect(h[0].installable).toBe(false);
  });

  it('respects the channel-visibility window', () => {
    const h = buildHistoryFromStatic(history, { ...opts, channel: 'stable' });
    expect(h).toEqual([]);
  });
});
