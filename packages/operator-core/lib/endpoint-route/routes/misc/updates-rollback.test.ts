import { describe, expect, it } from 'vitest';
import { selectRollbackRelease } from './updates-rollback';
import type { GhRelease } from './updates-manifest';

/** Minimal GitHub release fixture (mirrors updates-history.test.ts). */
function rel(
  tag: string,
  published_at: string,
  opts: { prerelease?: boolean; draft?: boolean; assets?: string[] } = {},
): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    body: `notes for ${tag}`,
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
  rel('desktop-v0.0.7-alpha', '2026-07-10T00:00:00Z'),
  rel('desktop-v0.0.6-beta', '2026-07-08T00:00:00Z'),
  rel('desktop-v0.0.5', '2026-07-05T00:00:00Z', { prerelease: false }), // stable
  rel('desktop-v0.0.4-draft', '2026-07-09T00:00:00Z', { draft: true }), // never selectable
];

describe('selectRollbackRelease — rollback target selection (pure)', () => {
  it('matches by the full git tag', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.5', channel: 'stable' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.release.tag_name).toBe('desktop-v0.0.5');
  });

  it('matches by the normalized version too (what the updater compares)', () => {
    const r = selectRollbackRelease(RELEASES, { tag: '0.0.5', channel: 'stable' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.release.tag_name).toBe('desktop-v0.0.5');
  });

  it('matches case-insensitively on the tag', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'DESKTOP-V0.0.7-ALPHA', channel: 'alpha' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.release.tag_name).toBe('desktop-v0.0.7-alpha');
  });

  it('reports unknown_tag for a tag that is not present', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v9.9.9', channel: 'alpha' });
    expect(r).toEqual({ ok: false, reason: 'unknown_tag' });
  });

  it('never selects a draft release (even by exact tag)', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.4-draft', channel: 'alpha' });
    expect(r).toEqual({ ok: false, reason: 'unknown_tag' });
  });

  it('refuses a cross-channel rollback: a stable user cannot revert onto an alpha build', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.7-alpha', channel: 'stable' });
    expect(r).toEqual({ ok: false, reason: 'channel_hidden' });
  });

  it('a beta user may revert to beta or stable but NOT alpha', () => {
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.6-beta', channel: 'beta' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.5', channel: 'beta' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.7-alpha', channel: 'beta' })).toEqual({
      ok: false,
      reason: 'channel_hidden',
    });
  });

  it('an alpha user may revert to any channel', () => {
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.7-alpha', channel: 'alpha' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.6-beta', channel: 'alpha' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.5', channel: 'alpha' }).ok).toBe(true);
  });
});
