/**
 * GET /api/updates/history — the release HISTORY for a channel (the Update
 * Center, desktop-update-center-and-release-tooling-2026-07-10 P-3).
 *
 * Where /updates/manifest answers the Tauri updater's ONE question ("is there a
 * newer release for my channel?"), this answers the GUI's: "show me every
 * release I could be on for this channel, which one I'm on, and which I can move
 * to." It reuses the SAME channel-visibility + classification + version
 * normalization as the manifest route (imported, not re-derived) so the list and
 * the updater can never disagree about what "on the beta channel" means.
 *
 * `auth: 'public'` — same loopback posture as the manifest/download routes; the
 * private release repo is reached with a server-resolved GitHub token.
 *
 * Query: channel? (else the saved update_channel, else stable) · product? (gui|
 * server, default gui) · target?/arch? (default linux/x86_64 — the GUI passes the
 * running platform so `installable` reflects THIS machine) · current_version? (to
 * mark the installed release) · limit? (1..50, default 20).
 *
 * Response: { channel, product, current_version, releases: UpdateHistoryEntry[],
 * reason? } — `reason` ('no_token'|'fetch_failed') accompanies an empty list when
 * the listing couldn't be fetched, mirroring the manifest route's X-Update-Reason
 * so the GUI can say "couldn't reach releases" instead of "no history".
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readOperatorState } from '../../../operator-state-pg';
import { resolveGithubToken } from './updates-github';
import {
  classifyChannel,
  fetchReleases,
  normalizeTagVersion,
  pickAsset,
  resolveChannel,
  visibleChannels,
  type Channel,
  type GhRelease,
} from './updates-manifest';

type Product = 'gui' | 'server';

export interface UpdateHistoryEntry {
  /** The full git tag, e.g. `desktop-v0.0.7-alpha` (what a rollback targets). */
  tag: string;
  /** Semver-normalized version, e.g. `0.0.7-alpha` (what the updater compares). */
  version: string;
  /** The channel this release classifies into. */
  channel: Channel;
  /** Release notes (GitHub release body). */
  notes: string;
  /** ISO publish date. */
  pub_date: string;
  prerelease: boolean;
  /** True when this is the running version (per `current_version`). */
  is_current: boolean;
  /** True when a matching asset exists for the requested target/arch/product —
   *  i.e. the GUI can offer "Install"/"Revert to" for THIS machine. */
  installable: boolean;
}

/**
 * Build the history list from raw GitHub releases (pure — the network is the
 * caller's concern, so this is directly unit-tested). Applies the same
 * channel-visibility window as the manifest (a `beta` user sees beta+stable; an
 * `alpha` user sees everything), newest-first, capped at `limit`.
 */
export function buildHistory(
  releases: GhRelease[],
  opts: {
    channel: Channel;
    target: string;
    arch: string;
    product: Product;
    currentVersion: string;
    limit: number;
  },
): UpdateHistoryEntry[] {
  const visible = visibleChannels(opts.channel);
  return releases
    .filter((r) => !r.draft)
    .filter((r) => visible.has(classifyChannel(r)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, opts.limit)
    .map((r) => {
      const version = normalizeTagVersion(r.tag_name);
      return {
        tag: r.tag_name,
        version,
        channel: classifyChannel(r),
        notes: r.body ?? '',
        pub_date: r.published_at,
        prerelease: r.prerelease,
        is_current: Boolean(opts.currentVersion) && version === opts.currentVersion,
        installable: pickAsset(r, opts.target, opts.arch, opts.product) != null,
      } satisfies UpdateHistoryEntry;
    });
}

export default defineTool({
  method: 'GET',
  path: '/updates/history',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const params = url.searchParams;
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const product: Product = params.get('product') === 'server' ? 'server' : 'gui';
    const currentVersion = params.get('current_version') ?? '';
    const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    const base = { channel, product, current_version: currentVersion };

    const token = await resolveGithubToken();
    if (!token) {
      console.warn('[updates/history] no GitHub token — returning empty history');
      return Response.json({ ...base, releases: [], reason: 'no_token' });
    }

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases(token);
    } catch (e: unknown) {
      console.warn(
        `[updates/history] releases fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return Response.json({ ...base, releases: [], reason: 'fetch_failed' });
    }
    if (!releases) return Response.json({ ...base, releases: [], reason: 'fetch_failed' });

    const history = buildHistory(releases, { channel, target, arch, product, currentVersion, limit });
    return Response.json({ ...base, releases: history });
  },
});
