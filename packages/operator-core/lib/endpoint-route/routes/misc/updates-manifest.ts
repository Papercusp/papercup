/**
 * GET /api/updates/manifest — channel-aware release manifest for the
 * Tauri updater (alpha/beta/stable; 204 = no update).
 *
 * Ported from app/api/updates/manifest/route.ts. `auth: 'public'` — the
 * Tauri updater polls this unauthenticated. NextRequest.nextUrl →
 * new URL(req.url); NextResponse(null,{status:204}) → Response.
 */
import { readOperatorState } from '../../../operator-state-pg';
import { defineTool } from '@papercusp/agent-mcp';

const GITHUB_REPO = process.env.GITHUB_DESKTOP_REPO ?? 'papercupai/papercusp-desktop';

type Channel = 'alpha' | 'beta' | 'stable';
const CHANNELS = new Set<Channel>(['alpha', 'beta', 'stable']);

interface GhAsset {
  name: string;
  browser_download_url: string;
}
interface GhRelease {
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

function classifyChannel(release: GhRelease): Channel {
  const tag = release.tag_name.toLowerCase();
  if (tag.includes('-alpha')) return 'alpha';
  if (tag.includes('-beta') || tag.includes('-rc')) return 'beta';
  if (release.prerelease) return 'beta';
  return 'stable';
}

function visibleChannels(target: Channel): ReadonlySet<Channel> {
  if (target === 'alpha') return new Set(['alpha', 'beta', 'stable']);
  if (target === 'beta') return new Set(['beta', 'stable']);
  return new Set(['stable']);
}

function platformKeyFor(target: string, arch: string): string | null {
  const t = target.toLowerCase();
  const a = arch.toLowerCase().replace(/-/g, '_');
  if (!['darwin', 'linux', 'windows'].includes(t)) return null;
  if (!['x86_64', 'aarch64', 'i686'].includes(a)) return null;
  return `${t}-${a}`;
}

function pickAssetUrl(release: GhRelease, target: string, arch: string): string | null {
  const platform = platformKeyFor(target, arch);
  if (!platform) return null;
  const candidates = release.assets.filter((a) => {
    const name = a.name.toLowerCase();
    if (!name.endsWith('.tar.gz') && !name.endsWith('.zip')) return false;
    if (target === 'darwin' && !name.includes('darwin') && !name.endsWith('.app.tar.gz')) return false;
    if (target === 'linux' && !name.includes('linux') && !name.endsWith('.appimage.tar.gz')) return false;
    if (
      target === 'windows' &&
      !name.includes('windows') &&
      !name.endsWith('.msi.zip') &&
      !name.endsWith('.exe.tar.gz')
    )
      return false;
    return (
      (arch === 'x86_64' && (name.includes('x86_64') || name.includes('x64'))) ||
      (arch === 'aarch64' && (name.includes('aarch64') || name.includes('arm64'))) ||
      (arch === 'i686' && (name.includes('i686') || name.includes('x86')))
    );
  });
  return candidates[0]?.browser_download_url ?? null;
}

function findSignature(release: GhRelease, assetUrl: string): string {
  const file = assetUrl.split('/').pop() ?? '';
  return release.assets.find((a) => a.name === `${file}.sig`)?.browser_download_url ?? '';
}

async function fetchReleases(): Promise<GhRelease[] | null> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, next: { revalidate: 60 } } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github releases: ${res.status}`);
  return (await res.json()) as GhRelease[];
}

function resolveChannel(params: URLSearchParams, override?: string): Channel {
  const fromQuery = params.get('channel');
  if (fromQuery && CHANNELS.has(fromQuery as Channel)) return fromQuery as Channel;
  if (override && CHANNELS.has(override as Channel)) return override as Channel;
  return 'stable';
}

export default defineTool({
  method: 'GET',
  path: '/updates/manifest',
  auth: 'public',
  async handler(req) {
    const params = new URL(req.url).searchParams;
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const currentVersion = params.get('current_version') ?? '';

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases();
    } catch (e: unknown) {
      return Response.json(
        { error: `releases fetch: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      );
    }
    if (!releases) return new Response(null, { status: 204 });

    const visible = visibleChannels(channel);
    const candidate = releases
      .filter((r) => !r.draft)
      .filter((r) => visible.has(classifyChannel(r)))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];

    if (!candidate) return new Response(null, { status: 204 });
    if (currentVersion && candidate.tag_name.replace(/^v/, '') === currentVersion) {
      return new Response(null, { status: 204 });
    }

    const assetUrl = pickAssetUrl(candidate, target, arch);
    if (!assetUrl) {
      return Response.json(
        { error: `no asset for ${target}/${arch} in ${candidate.tag_name}` },
        { status: 404 },
      );
    }

    const manifest: TauriManifest = {
      version: candidate.tag_name.replace(/^v/, ''),
      notes: candidate.body ?? '',
      pub_date: candidate.published_at,
      platforms: {
        [platformKeyFor(target, arch) as string]: {
          signature: findSignature(candidate, assetUrl),
          url: assetUrl,
        },
      },
    };
    return Response.json(manifest);
  },
});
