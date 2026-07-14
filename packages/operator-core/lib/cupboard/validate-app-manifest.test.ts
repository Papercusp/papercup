/**
 * validate-app-manifest.test.ts — the publish-time gate that a STANDALONE app's
 * latest.json RESOLVES before a kind=app listing is published
 * (cupboard-app-distribution-2026-07-14 P-003).
 *
 * The gate fetches the manifest, shape-checks it parses as a tauri latest.json,
 * and 422s a publish that would list an app whose every download dead-ends —
 * deriving the available platform keys for the storefront card. These tests pin
 * the accept path (version + usable platforms), the https requirement, and every
 * refusal (unreachable, malformed, missing version/platforms, no usable entry).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assertAppManifestResolves,
  AppManifestError,
  type AppManifestCheckDeps,
} from './validate-app-manifest';

/** A fetchText that serves a fixed body with a 200, or a chosen status/throw. */
function fakeFetch(
  body: string,
  opts: { ok?: boolean; status?: number; throwErr?: Error } = {},
): AppManifestCheckDeps['fetchText'] {
  return vi.fn(async () => {
    if (opts.throwErr) throw opts.throwErr;
    return { ok: opts.ok ?? true, status: opts.status ?? 200, text: body };
  });
}

const GOOD = JSON.stringify({
  version: '1.4.0',
  platforms: {
    'darwin-aarch64': { signature: 'sig-a', url: 'https://gh/rel/mac.tar.gz' },
    'linux-x86_64': { signature: 'sig-l', url: 'https://gh/rel/linux.tar.gz' },
  },
});

const URL = 'https://github.com/acme/oddsmith/releases/latest/download/latest.json';

describe('assertAppManifestResolves', () => {
  it('accepts a valid manifest and returns version + platform keys', async () => {
    const res = await assertAppManifestResolves(URL, { fetchText: fakeFetch(GOOD) });
    expect(res.version).toBe('1.4.0');
    expect(res.platforms.sort()).toEqual(['darwin-aarch64', 'linux-x86_64']);
  });

  it('rejects a non-https url (400) without fetching', async () => {
    const fetchText = fakeFetch(GOOD);
    await expect(
      assertAppManifestResolves('http://insecure/latest.json', { fetchText }),
    ).rejects.toMatchObject({ status: 400, reason: 'latest_json_url_not_https' });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('maps a hard network failure to 422 latest_json_unreachable', async () => {
    await expect(
      assertAppManifestResolves(URL, {
        fetchText: fakeFetch('', { throwErr: new Error('ECONNREFUSED') }),
      }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_unreachable' });
  });

  it('maps a non-2xx to 422 latest_json_unreachable', async () => {
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch('not found', { ok: false, status: 404 }) }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_unreachable' });
  });

  it('rejects malformed JSON (422)', async () => {
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch('{ not json') }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_malformed' });
  });

  it('rejects a JSON array (not a manifest object) (422)', async () => {
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch('[]') }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_malformed' });
  });

  it('rejects a manifest with no version (422)', async () => {
    const body = JSON.stringify({ platforms: { 'linux-x86_64': { signature: 's', url: 'https://x' } } });
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch(body) }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_no_version' });
  });

  it('rejects a manifest with no platforms map (422)', async () => {
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch(JSON.stringify({ version: '1.0.0' })) }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_no_platforms' });
  });

  it('rejects a manifest whose only entry lacks a usable url+signature (422)', async () => {
    const body = JSON.stringify({
      version: '1.0.0',
      platforms: { 'linux-x86_64': { signature: 'sig-only' } },
    });
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch(body) }),
    ).rejects.toMatchObject({ status: 422, reason: 'latest_json_no_usable_platform' });
  });

  it('skips an unusable entry but keeps the usable ones', async () => {
    const body = JSON.stringify({
      version: '2.0.0',
      platforms: {
        'linux-x86_64': { signature: 'sig-l', url: 'https://gh/linux' },
        'windows-x86_64': { url: 'https://gh/win' }, // no signature ⇒ skipped
      },
    });
    const res = await assertAppManifestResolves(URL, { fetchText: fakeFetch(body) });
    expect(res.platforms).toEqual(['linux-x86_64']);
  });

  it('surfaces the AppManifestError type (not a plain Error)', async () => {
    await expect(
      assertAppManifestResolves(URL, { fetchText: fakeFetch('nope') }),
    ).rejects.toBeInstanceOf(AppManifestError);
  });
});
