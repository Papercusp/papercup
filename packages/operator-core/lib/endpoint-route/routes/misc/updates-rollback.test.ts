import { describe, expect, it } from 'vitest';
import {
  pickStaticRollbackArtifact,
  selectRollbackRelease,
  selectStaticRollbackRelease,
} from './updates-rollback';
import type { GhRelease } from './updates-manifest';
import type { StaticHistoryRelease } from './updates-history';

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

// ── The static release host: the ONLY source that has post-2026-07-08 releases
// (WI-5008 — GitHub stops at 0.0.7, so a GitHub-only rollback could never
// resolve the releases the Update Center was offering Revert buttons for).
function staticRel(
  tag: string,
  version: string,
  channel: string,
  artifacts: Array<{ product: 'gui' | 'server' | string; platform: string; name: string }> = [],
): StaticHistoryRelease {
  return {
    tag,
    version,
    channel,
    notes: `notes for ${tag}`,
    pub_date: '2026-07-14T00:00:00Z',
    prerelease: channel !== 'stable',
    artifacts: artifacts.map((a, i) => ({
      product: a.product as 'gui' | 'server',
      platform: a.platform,
      name: a.name,
      url: `${tag}/${a.name}`,
      size: i + 1,
      sha256: `hash${i}`,
    })),
  };
}

const STATIC_RELEASES: StaticHistoryRelease[] = [
  staticRel('desktop-v0.0.10-alpha', '0.0.10', 'alpha', [
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp GUI_0.0.10_amd64.deb' },
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp_GUI_0.0.10_amd64.AppImage' },
    { product: 'server', platform: 'linux-x86_64', name: 'Papercusp Server_0.0.10_amd64.deb' },
  ]),
  // The REAL 0.0.9 shape: .deb/.dmg only — nothing the updater can swap.
  staticRel('desktop-v0.0.9-alpha', '0.0.9', 'alpha', [
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp GUI_0.0.9_amd64.deb' },
    { product: 'gui', platform: 'darwin-universal', name: 'Papercusp GUI_0.0.9_universal-apple-darwin.dmg' },
  ]),
  staticRel('desktop-v0.0.8-alpha', '0.0.8', 'alpha', [
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp_GUI_0.0.8_amd64.AppImage' },
  ]),
];

describe('selectStaticRollbackRelease — static-host rollback selection (pure)', () => {
  it('matches by full tag, normalized tag-version, and the feed version the app reports', () => {
    for (const tag of ['desktop-v0.0.8-alpha', '0.0.8-alpha', '0.0.8', 'DESKTOP-V0.0.8-ALPHA']) {
      const r = selectStaticRollbackRelease(STATIC_RELEASES, { tag, channel: 'alpha' });
      expect(r.ok, tag).toBe(true);
      expect(r.ok && r.release.tag).toBe('desktop-v0.0.8-alpha');
    }
  });

  it('reports unknown_tag for a tag not on the host', () => {
    expect(selectStaticRollbackRelease(STATIC_RELEASES, { tag: 'desktop-v9.9.9', channel: 'alpha' })).toEqual({
      ok: false,
      reason: 'unknown_tag',
    });
  });

  it('refuses a cross-channel rollback: a stable user cannot revert onto an alpha build', () => {
    expect(selectStaticRollbackRelease(STATIC_RELEASES, { tag: 'desktop-v0.0.8-alpha', channel: 'stable' })).toEqual({
      ok: false,
      reason: 'channel_hidden',
    });
  });
});

describe('pickStaticRollbackArtifact — what revert_to can actually swap (pure)', () => {
  it('picks the updater-installable artifact, never the .deb next to it', () => {
    const a = pickStaticRollbackArtifact(STATIC_RELEASES[0], 'linux-x86_64', 'gui');
    expect(a?.name).toBe('Papercusp_GUI_0.0.10_amd64.AppImage');
  });

  it('returns null for the .deb/.dmg-only 0.0.9 cut — resolvable but not swappable', () => {
    expect(pickStaticRollbackArtifact(STATIC_RELEASES[1], 'linux-x86_64', 'gui')).toBeNull();
    expect(pickStaticRollbackArtifact(STATIC_RELEASES[1], 'darwin-aarch64', 'gui')).toBeNull();
  });

  it('scopes by product — the Server never receives the GUI bundle', () => {
    expect(pickStaticRollbackArtifact(STATIC_RELEASES[2], 'linux-x86_64', 'server')).toBeNull();
  });
});
