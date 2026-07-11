/**
 * GET /api/updates/rollback — resolve a SPECIFIC release tag into a Tauri-updater
 * install manifest, so the desktop app's `revert_to(tag)` command (desktop-update-
 * center-and-release-tooling P-4) can download, minisign-verify, and swap to an
 * OLDER release exactly the way `install_update` installs the newest one.
 *
 * Where /updates/manifest answers the Tauri updater's "is there a NEWER release for
 * my channel?" (and 204s when you're already up to date), this answers the Update
 * Center "Revert" button's question: "give me the install manifest for THIS exact
 * tag." It reuses the manifest route's SAME asset / signature / channel resolution
 * (imported, not re-derived) so a rollback and a forward update can never disagree
 * about what a release's installable artifact — or its trusted signature — is.
 *
 * `auth: 'public'` — same loopback posture as the manifest / history / download
 * routes; the private release repo is reached with a server-resolved GitHub token.
 *
 * Query:
 *   - `tag` (required) — the release to roll back to, either the full git tag
 *     (`desktop-v0.0.6-alpha`) or its normalized version (`0.0.6-alpha`).
 *   - `target?` / `arch?` — default `linux` / `x86_64`; the GUI passes the running
 *     platform so the resolved asset matches THIS machine.
 *   - `product?` — `gui` | `server` (default `gui`).
 *   - `channel?` — else the saved `update_channel`, else `stable`. Bounds the
 *     rollback to the channel window (a stable user cannot silently revert onto an
 *     alpha build) — the same visibility the history list already applies.
 *
 * Response (200): the newer-update manifest shape plus flat convenience fields, so a
 * client can either reuse its `install_update` manifest parser or read `url` +
 * `signature` directly:
 *   { ok, tag, version, channel, target, arch, product, platform, url, signature,
 *     notes, pub_date, manifest: { version, notes, pub_date, platforms } }
 * Refusals carry a machine-readable `reason`:
 *   400 missing_tag · 404 unknown_tag | channel_hidden | unknown_platform | no_asset
 *   · 409 no_signature (asset found but no verifiable .sig — surfaced, never served,
 *   because revert_to's minisign check would fail) · 503 no_token | fetch_failed.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readOperatorState } from '../../../operator-state-pg';
import { fetchAssetText, resolveGithubToken, releaseHostBase } from './updates-github';
import {
  classifyChannel,
  fetchReleases,
  findLatestJsonAsset,
  findSigAsset,
  normalizeTagVersion,
  pickAsset,
  platformKeyFor,
  resolveChannel,
  visibleChannels,
  type Channel,
  type GhRelease,
} from './updates-manifest';

type Product = 'gui' | 'server';

/** Why a requested tag is not a serviceable rollback target for this caller. */
export type RollbackRefusal = 'unknown_tag' | 'channel_hidden';

export type RollbackSelection =
  | { ok: true; release: GhRelease }
  | { ok: false; reason: RollbackRefusal };

/**
 * Select the release a rollback request targets — the pure, network-free core:
 * match the tag (full `desktop-vX` tag OR the normalized version), exclude drafts,
 * and enforce the channel-visibility window (an `alpha` caller may revert to any
 * channel; a `stable` caller only to `stable`). The asset / signature assembly is
 * the caller's concern (it needs the network) — this is what's directly unit-tested.
 */
export function selectRollbackRelease(
  releases: GhRelease[],
  opts: { tag: string; channel: Channel },
): RollbackSelection {
  const wanted = opts.tag.trim();
  const wantedVersion = normalizeTagVersion(wanted);
  const release = releases
    .filter((r) => !r.draft)
    .find(
      (r) =>
        r.tag_name === wanted ||
        r.tag_name.toLowerCase() === wanted.toLowerCase() ||
        normalizeTagVersion(r.tag_name) === wantedVersion,
    );
  if (!release) return { ok: false, reason: 'unknown_tag' };
  if (!visibleChannels(opts.channel).has(classifyChannel(release))) {
    return { ok: false, reason: 'channel_hidden' };
  }
  return { ok: true, release };
}

const REFUSAL_STATUS: Record<RollbackRefusal | 'unknown_platform' | 'no_asset', number> = {
  unknown_tag: 404,
  channel_hidden: 404,
  unknown_platform: 404,
  no_asset: 404,
};

function refusal(reason: RollbackRefusal | 'unknown_platform' | 'no_asset', extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, reason, ...extra }, { status: REFUSAL_STATUS[reason] });
}

export default defineTool({
  method: 'GET',
  path: '/updates/rollback',
  auth: 'public',
  async handler(req) {
    const reqUrl = new URL(req.url);
    const params = reqUrl.searchParams;

    const tag = (params.get('tag') ?? '').trim();
    if (!tag) {
      return Response.json({ ok: false, reason: 'missing_tag', error: 'tag query param is required' }, { status: 400 });
    }
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const product: Product = params.get('product') === 'server' ? 'server' : 'gui';

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    const token = await resolveGithubToken();
    if (!token) {
      console.warn('[updates/rollback] no GitHub token — cannot resolve rollback target');
      return Response.json({ ok: false, reason: 'no_token' }, { status: 503 });
    }

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases(token);
    } catch (e: unknown) {
      console.warn(`[updates/rollback] releases fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return Response.json({ ok: false, reason: 'fetch_failed' }, { status: 503 });
    }
    if (!releases) return Response.json({ ok: false, reason: 'fetch_failed' }, { status: 503 });

    const selected = selectRollbackRelease(releases, { tag, channel });
    if (!selected.ok) return refusal(selected.reason);
    const { release } = selected;

    const version = normalizeTagVersion(release.tag_name);
    const platformKey = platformKeyFor(target, arch);
    if (!platformKey) return refusal('unknown_platform', { error: `unknown platform ${target}/${arch}` });

    const proxyBase = `${reqUrl.origin}/api/updates/download`;

    const respond = (signature: string, url: string) =>
      Response.json({
        ok: true,
        tag: release.tag_name,
        version,
        channel: classifyChannel(release),
        target,
        arch,
        product,
        platform: platformKey,
        url,
        signature,
        notes: release.body ?? '',
        pub_date: release.published_at,
        // Tauri-updater manifest shape — a client may reuse its install_update parser.
        manifest: {
          version,
          notes: release.body ?? '',
          pub_date: release.published_at,
          platforms: { [platformKey]: { signature, url } },
        },
      });

    // Primary path: a GitHub asset for this platform/product, signed with its .sig.
    const asset = pickAsset(release, target, arch, product);
    if (asset) {
      const sigAsset = findSigAsset(release, asset.name);
      const signature = sigAsset ? ((await fetchAssetText(sigAsset.id, token)) ?? '').trim() : '';
      if (!signature) {
        console.warn(`[updates/rollback] no signature for ${asset.name} in ${release.tag_name}`);
        return Response.json(
          { ok: false, reason: 'no_signature', tag: release.tag_name, version, asset: asset.name },
          { status: 409 },
        );
      }
      return respond(signature, `${proxyBase}?asset_id=${asset.id}&name=${encodeURIComponent(asset.name)}`);
    }

    // Fallback: the artifact is over GitHub's 2 GiB cap (Linux) — its filename +
    // inline minisign signature live in the release's papercusp-latest-<tag>.json,
    // served via the proxy's static release-host base (mirrors the manifest route).
    const latestAsset = findLatestJsonAsset(release);
    if (latestAsset && releaseHostBase() && product === 'gui') {
      try {
        const latest = JSON.parse((await fetchAssetText(latestAsset.id, token)) ?? 'null') as {
          platforms?: Record<string, { signature?: string; url?: string }>;
        } | null;
        const entry = latest?.platforms?.[platformKey];
        if (entry?.signature && entry.url) {
          const file = entry.url.split('/').pop() ?? '';
          return respond(
            entry.signature,
            `${proxyBase}?tag=${encodeURIComponent(release.tag_name)}&name=${encodeURIComponent(file)}`,
          );
        }
      } catch (e: unknown) {
        console.warn(
          `[updates/rollback] latest.json fallback failed for ${release.tag_name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return refusal('no_asset', { tag: release.tag_name, version, target, arch, product });
  },
});
