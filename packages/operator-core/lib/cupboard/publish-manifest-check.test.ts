/**
 * publish-manifest-check.test.ts — the publish-time installability gate for
 * kind=plugin listings (EI-387 / cupboard-full-dogfood-2026-07-10 P-005).
 *
 * The gate reads the backing repo's papercusp.json in the SAME location order
 * the installer uses (install-plugin-core `locatePlugin`: listing_ref subdir
 * first, then repo root; first valid {name, version} wins) and 422s a publish
 * that would list an un-installable repo. These tests pin that it is never
 * stricter than the installer (malformed/absent at one path falls through) and
 * that an unsafe subdir ref is skipped exactly as the installer skips it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assertPluginManifestPublishable,
  PublishManifestError,
  type PublishManifestCheckDeps,
} from './publish-manifest-check';

/** A fetchRepoFile that serves a fixed `<path> → content` map (missing ⇒ null). */
function fakeRepo(files: Record<string, string>): PublishManifestCheckDeps['fetchRepoFile'] {
  return vi.fn(async (_owner: string, _repo: string, path: string) => files[path] ?? null);
}

const VALID = JSON.stringify({ name: 'markdown-tools', version: '0.1.0' });

describe('assertPluginManifestPublishable', () => {
  it('accepts a valid root papercusp.json', async () => {
    const res = await assertPluginManifestPublishable(
      { owner: 'acme', repo: 'plugins' },
      { fetchRepoFile: fakeRepo({ 'papercusp.json': VALID }) },
    );
    expect(res).toEqual({ name: 'markdown-tools', version: '0.1.0', path: 'papercusp.json' });
  });

  it('prefers the listing_ref subdir manifest over the root (installer order)', async () => {
    const fetchRepoFile = fakeRepo({
      'sub/papercusp.json': JSON.stringify({ name: 'sub-plugin', version: '2.0.0' }),
      'papercusp.json': JSON.stringify({ name: 'root-plugin', version: '9.9.9' }),
    });
    const res = await assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins', listingRef: 'sub' }, { fetchRepoFile });
    expect(res).toMatchObject({ name: 'sub-plugin', version: '2.0.0', path: 'sub/papercusp.json' });
  });

  it('falls through a missing subdir manifest to the root (never stricter than install)', async () => {
    const res = await assertPluginManifestPublishable(
      { owner: 'acme', repo: 'plugins', listingRef: 'sub' },
      { fetchRepoFile: fakeRepo({ 'papercusp.json': VALID }) },
    );
    expect(res.path).toBe('papercusp.json');
  });

  it('falls through a malformed subdir manifest to a valid root (matches readManifest → null)', async () => {
    const fetchRepoFile = fakeRepo({ 'sub/papercusp.json': '{ not json', 'papercusp.json': VALID });
    const res = await assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins', listingRef: 'sub' }, { fetchRepoFile });
    expect(res.path).toBe('papercusp.json');
  });

  it('skips an unsafe listing_ref subdir (@scope/name) and probes only the root', async () => {
    const fetchRepoFile = fakeRepo({ 'papercusp.json': JSON.stringify({ name: '@sc/x', version: '1.0.0' }) });
    await assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins', listingRef: '@papercupai/repomix' }, { fetchRepoFile });
    // Only the root was fetched — the unsafe subdir path was never attempted.
    expect(fetchRepoFile).toHaveBeenCalledTimes(1);
    expect(fetchRepoFile).toHaveBeenCalledWith('acme', 'plugins', 'papercusp.json');
  });

  it('422s when no papercusp.json exists anywhere', async () => {
    await expect(
      assertPluginManifestPublishable({ owner: 'acme', repo: 'empty' }, { fetchRepoFile: fakeRepo({}) }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('422s (PublishManifestError) when the manifest lacks a version', async () => {
    const fetchRepoFile = fakeRepo({ 'papercusp.json': JSON.stringify({ name: 'x' }) });
    await expect(
      assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins' }, { fetchRepoFile }),
    ).rejects.toBeInstanceOf(PublishManifestError);
  });

  it('422s when the manifest name is blank / non-string', async () => {
    for (const bad of [JSON.stringify({ name: '   ', version: '1.0.0' }), JSON.stringify({ name: 3, version: '1.0.0' })]) {
      await expect(
        assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins' }, { fetchRepoFile: fakeRepo({ 'papercusp.json': bad }) }),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it('treats a fetch that throws as "not readable here" and 422s (no valid manifest)', async () => {
    const fetchRepoFile = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins' }, { fetchRepoFile }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
