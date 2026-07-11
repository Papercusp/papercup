/**
 * GET /api/updates/manifest — channel-aware release manifest for the
 * Tauri updater (alpha/beta/stable; 204 = no update).
 *
 * `auth: 'public'` — the Tauri updater polls this unauthenticated on
 * loopback. The release repo is PRIVATE, so this route resolves a GitHub
 * token server-side (gh CLI → credentials store → env; see
 * updates-github.ts) and rewrites every artifact URL to the local
 * `/api/updates/download` proxy, which streams the token-gated asset.
 *
 * Contract with tauri-plugin-updater (verified against 2.10.1 source,
 * desktop-auto-update-operational-2026-07-09 P-001/P-002):
 *   - `version` MUST parse as semver after trimming ONE leading "v" —
 *     tags here are `desktop-vX.Y.Z[-chan[.N]]`, so we normalize.
 *   - `signature` MUST be the minisign .sig CONTENT inline, not a URL.
 *   - Both the GUI and Server products poll this route; assets are
 *     product-named (`Papercusp GUI_…` / `Papercusp Server_…`, GitHub
 *     dot-renames spaces), so the `product` query param scopes matching.
 *   - Artifacts over GitHub's 2 GiB cap (Linux) are absent from the
 *     release; their filenames + inline sigs come from the release's
 *     `papercusp-latest-<tag>.json` and are served via the proxy's
 *     PAPERCUSP_RELEASE_HOST fallback.
 */
import { readOperatorState } from '../../../operator-state-pg';
import { defineTool } from '@papercusp/agent-mcp';
import {
  GITHUB_DESKTOP_REPO,
  fetchAssetText,
  githubApiHeaders,
  releaseHostBase,
  resolveGithubToken,
} from './updates-github';

export type Channel = 'alpha' | 'beta' | 'stable';
const CHANNELS = new Set<Channel>(['alpha', 'beta', 'stable']);

type Product = 'gui' | 'server';

export interface GhAsset {
  id: number;
  name: string;
  browser_download_url: string;
}
export interface GhRelease {
  tag_name: string;
  name?: string;
  body?: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: GhAsset[];
}
interface TauriManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}
/** Shape of the pipeline-generated `papercusp-latest-<tag>.json` asset. */
interface LatestJson {
  version?: string;
  notes?: string;
  pub_date?: string;
  platforms?: Record<string, { signature: string; url: string }>;
}

/**
 * `desktop-v0.0.4-alpha` → `0.0.4-alpha` (valid semver). The Tauri
 * plugin only trims a single leading `v`, so serving the raw tag makes
 * every check fail with a version-parse error.
 */
export function normalizeTagVersion(tag: string): string {
  return tag.replace(/^desktop-v/i, '').replace(/^v/i, '');
}

export function classifyChannel(release: GhRelease): Channel {
  const tag = release.tag_name.toLowerCase();
  if (tag.includes('-alpha')) return 'alpha';
  if (tag.includes('-beta') || tag.includes('-rc')) return 'beta';
  if (release.prerelease) return 'beta';
  return 'stable';
}

export function visibleChannels(target: Channel): ReadonlySet<Channel> {
  if (target === 'alpha') return new Set(['alpha', 'beta', 'stable']);
  if (target === 'beta') return new Set(['beta', 'stable']);
  return new Set(['stable']);
}

export function platformKeyFor(target: string, arch: string): string | null {
  const t = target.toLowerCase();
  const a = arch.toLowerCase().replace(/-/g, '_');
  if (!['darwin', 'linux', 'windows'].includes(t)) return null;
  if (!['x86_64', 'aarch64', 'i686'].includes(a)) return null;
  return `${t}-${a}`;
}

/**
 * Which product an asset belongs to. Names look like
 * `Papercusp GUI_0.0.3_x64-setup.exe` / `Papercusp.Server.app.tar.gz`
 * (GitHub renames spaces to dots). Assets with neither token (the
 * pre-split era, e.g. `Papercusp_universal.app.tar.gz`) match either
 * product.
 */
function assetProduct(name: string): Product | 'any' {
  const n = name.toLowerCase();
  if (/(^|[\s._-])server([\s._-]|$)/.test(n)) return 'server';
  if (/(^|[\s._-])gui([\s._-]|$)/.test(n)) return 'gui';
  return 'any';
}

export function pickAsset(
  release: GhRelease,
  target: string,
  arch: string,
  product: Product = 'gui',
): GhAsset | null {
  const platform = platformKeyFor(target, arch);
  if (!platform) return null;
  const candidates = release.assets.filter((a) => {
    const name = a.name.toLowerCase();
    const p = assetProduct(a.name);
    if (p !== 'any' && p !== product) return false;
    // Tauri v2's Windows updater artifact is the bare NSIS `-setup.exe`
    // (or `.msi`) — v1's `.msi.zip`/`.exe.tar.gz` wrappers no longer
    // exist. Without this the endpoint 404'd on every real Windows
    // release (windows-desktop-release-readiness-2026-06-11 P-013).
    const winV2 = name.endsWith('-setup.exe') || name.endsWith('.msi');
    // Same v1→v2 shape on Linux (EI-333): the updater artifact is the bare
    // `.AppImage` (+ .sig) — the `.appimage.tar.gz` wrapper no longer exists.
    const linuxV2 = name.endsWith('.appimage');
    if (
      !name.endsWith('.tar.gz') &&
      !name.endsWith('.zip') &&
      !(target === 'windows' && winV2) &&
      !(target === 'linux' && linuxV2)
    )
      return false;
    if (target === 'darwin' && !name.includes('darwin') && !name.endsWith('.app.tar.gz')) return false;
    if (target === 'linux' && !name.includes('linux') && !name.endsWith('.appimage.tar.gz') && !linuxV2)
      return false;
    if (
      target === 'windows' &&
      !name.includes('windows') &&
      !name.endsWith('.msi.zip') &&
      !name.endsWith('.exe.tar.gz') &&
      !winV2
    )
      return false;
    // A macOS universal bundle (Papercusp_universal.app.tar.gz) serves every
    // darwin arch — without this the updater 404s on universal-only releases.
    if (target === 'darwin' && name.includes('universal')) return true;
    return (
      (arch === 'x86_64' && (name.includes('x86_64') || name.includes('x64') || name.includes('amd64'))) ||
      (arch === 'aarch64' && (name.includes('aarch64') || name.includes('arm64'))) ||
      (arch === 'i686' && (name.includes('i686') || name.includes('x86')))
    );
  });
  return candidates[0] ?? null;
}

/** Back-compat helper (tests + older callers). */
export function pickAssetUrl(
  release: GhRelease,
  target: string,
  arch: string,
  product: Product = 'gui',
): string | null {
  return pickAsset(release, target, arch, product)?.browser_download_url ?? null;
}

/**
 * Asset-name equality across GitHub's space→dot rename
 * ("Papercusp GUI.app.tar.gz" is stored as "Papercusp.GUI.app.tar.gz").
 */
function sameAssetName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[ .]/g, '.');
  return norm(a) === norm(b);
}

export function findSigAsset(release: GhRelease, assetName: string): GhAsset | null {
  return release.assets.find((a) => sameAssetName(a.name, `${assetName}.sig`)) ?? null;
}

export function findLatestJsonAsset(release: GhRelease): GhAsset | null {
  return (
    release.assets.find((a) => /^papercusp-latest-.*\.json$/i.test(a.name)) ??
    release.assets.find((a) => a.name.toLowerCase() === 'latest.json') ??
    null
  );
}

export async function fetchReleases(token: string | null): Promise<GhRelease[] | null> {
  const url = `https://api.github.com/repos/${GITHUB_DESKTOP_REPO}/releases?per_page=30`;
  const res = await fetch(url, {
    headers: githubApiHeaders(token),
    next: { revalidate: 60 },
  } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github releases: ${res.status}`);
  return (await res.json()) as GhRelease[];
}

export function resolveChannel(params: URLSearchParams, override?: string): Channel {
  const fromQuery = params.get('channel');
  if (fromQuery && CHANNELS.has(fromQuery as Channel)) return fromQuery as Channel;
  if (override && CHANNELS.has(override as Channel)) return override as Channel;
  return 'stable';
}

/**
 * WI-3697: the tauri-plugin-updater protocol only distinguishes "update
 * available" (200 + manifest JSON) from "no update" (204) — it has no slot
 * for WHY there's no update, so this route historically returned a bare 204
 * for four genuinely different conditions: no GitHub token resolvable, the
 * GitHub fetch failing, no release matching the channel, and a genuine
 * version-equal match. A caller reading only the HTTP status (a preflight
 * script, an ops dashboard, or a future UI affordance) cannot tell "up to
 * date" from "couldn't check" — which cost a full diagnostic detour when a
 * no-token 204 was misread as "VM is up to date" (P-006/P-007).
 *
 * Fix: keep the WIRE PROTOCOL unchanged (204, empty body — the real Tauri
 * updater plugin parses neither headers nor a body on a 204, so this is
 * 100% back-compat) but stamp two extra response headers a caller CAN read
 * via a plain `fetch()`:
 *   - `X-Update-Check: up_to_date` for the genuine no-update case, or
 *     `X-Update-Check: cannot_check` for the four degrade-to-204 paths.
 *   - `X-Update-Reason: no_token|fetch_failed|no_candidate` on the
 *     cannot_check paths only (omitted on a genuine up_to_date 204).
 */
type UpdateCannotCheckReason = 'no_token' | 'fetch_failed' | 'no_candidate';

function upToDateResponse(): Response {
  return new Response(null, { status: 204, headers: { 'X-Update-Check': 'up_to_date' } });
}

function cannotCheckResponse(reason: UpdateCannotCheckReason): Response {
  return new Response(null, {
    status: 204,
    headers: { 'X-Update-Check': 'cannot_check', 'X-Update-Reason': reason },
  });
}

export default defineTool({
  method: 'GET',
  path: '/updates/manifest',
  auth: 'public',
  async handler(req) {
    const reqUrl = new URL(req.url);
    const params = reqUrl.searchParams;
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const currentVersion = params.get('current_version') ?? '';
    const product: Product = params.get('product') === 'server' ? 'server' : 'gui';

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    const token = await resolveGithubToken();
    if (!token) {
      // The repo is private: without a token the listing 404s and every
      // asset is unreachable. Stay quiet toward the updater (204 = up to
      // date) but keep the failure visible to ops.
      console.warn(
        '[updates/manifest] no GitHub token available (gh auth / github_pat / GITHUB_TOKEN) — serving 204 (no update offered)',
      );
      return cannotCheckResponse('no_token');
    }

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases(token);
    } catch (e: unknown) {
      // A TRANSIENT inability to reach GitHub — rate-limit, 5xx, or a
      // network error — is NOT a client error. Returning 502 here made the
      // Tauri updater log a hard error on every poll. Degrade to 204 like
      // the 404 / no-candidate cases — the updater treats 204 as "up to
      // date" and stays quiet — while warning server-side.
      console.warn(
        `[updates/manifest] releases fetch failed — serving 204 (no update offered): ${e instanceof Error ? e.message : String(e)}`,
      );
      return cannotCheckResponse('fetch_failed');
    }
    if (!releases) return cannotCheckResponse('fetch_failed');

    const visible = visibleChannels(channel);
    const candidate = releases
      .filter((r) => !r.draft)
      .filter((r) => visible.has(classifyChannel(r)))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];

    if (!candidate) return cannotCheckResponse('no_candidate');
    const candidateVersion = normalizeTagVersion(candidate.tag_name);
    if (currentVersion && candidateVersion === currentVersion) {
      return upToDateResponse();
    }

    const platformKey = platformKeyFor(target, arch);
    if (!platformKey) {
      return Response.json({ error: `unknown platform ${target}/${arch}` }, { status: 404 });
    }
    const proxyBase = `${reqUrl.origin}/api/updates/download`;

    const asset = pickAsset(candidate, target, arch, product);
    if (asset) {
      const sigAsset = findSigAsset(candidate, asset.name);
      const signature = sigAsset ? ((await fetchAssetText(sigAsset.id, token)) ?? '').trim() : '';
      if (!signature) {
        console.warn(
          `[updates/manifest] no signature for ${asset.name} in ${candidate.tag_name} — install will fail verification`,
        );
      }
      const manifest: TauriManifest = {
        version: candidateVersion,
        notes: candidate.body ?? '',
        pub_date: candidate.published_at,
        platforms: {
          [platformKey]: {
            signature,
            url: `${proxyBase}?asset_id=${asset.id}&name=${encodeURIComponent(asset.name)}`,
          },
        },
      };
      return Response.json(manifest);
    }

    // No GitHub asset for this platform/product — the artifact may be over
    // GitHub's 2 GiB cap (Linux). The pipeline's latest.json still lists it
    // (filename + INLINE minisign signature); serve it via the proxy's
    // static release-host fallback when one is configured.
    const latestAsset = findLatestJsonAsset(candidate);
    if (latestAsset && releaseHostBase()) {
      try {
        const latest = JSON.parse(
          (await fetchAssetText(latestAsset.id, token)) ?? 'null',
        ) as LatestJson | null;
        const entry = latest?.platforms?.[platformKey];
        // latest.json is currently generated for the GUI product only.
        if (entry?.signature && entry.url && product === 'gui') {
          const file = entry.url.split('/').pop() ?? '';
          return Response.json({
            version: latest?.version ?? candidateVersion,
            notes: latest?.notes ?? candidate.body ?? '',
            pub_date: latest?.pub_date ?? candidate.published_at,
            platforms: {
              [platformKey]: {
                signature: entry.signature,
                url: `${proxyBase}?tag=${encodeURIComponent(candidate.tag_name)}&name=${encodeURIComponent(file)}`,
              },
            },
          } satisfies TauriManifest);
        }
      } catch (e: unknown) {
        console.warn(
          `[updates/manifest] latest.json fallback failed for ${candidate.tag_name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return Response.json(
      { error: `no asset for ${target}/${arch} (${product}) in ${candidate.tag_name}` },
      { status: 404 },
    );
  },
});
