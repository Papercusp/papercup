import { describe, expect, it } from 'vitest';
import { buildHistory } from './updates-history';
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
