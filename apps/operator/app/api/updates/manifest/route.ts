/**
 * GET /api/updates/manifest?channel=alpha&target={{target}}&arch={{arch}}&current_version={{current_version}}
 *
 * Channel-aware release manifest for the Tauri updater. Returns the
 * shape the tauri-plugin-updater expects:
 *
 *   {
 *     version: "0.1.2",
 *     notes: "...",
 *     pub_date: "2026-05-12T17:00:00Z",
 *     platforms: {
 *       "darwin-aarch64": { signature: "...", url: "https://.../foo.app.tar.gz" },
 *       "linux-x86_64":   { signature: "...", url: "https://.../foo.AppImage.tar.gz" },
 *       "windows-x86_64": { signature: "...", url: "https://.../foo-setup.exe.tar.gz" }
 *     }
 *   }
 *
 * Tauri also accepts a 204 to mean "no update available" — we return
 * 204 when the channel's latest release equals current_version, so the
 * updater's "check" call resolves with no update.
 *
 * Resolution strategy:
 *   - alpha   → newest release tagged v*-alpha   (or first prerelease)
 *   - beta    → newest release tagged v*-beta    (or first prerelease)
 *   - stable  → newest non-prerelease release
 *
 * Source of truth is GitHub releases for the desktop repo:
 *   GITHUB_DESKTOP_REPO env var (default 'papercupai/papercusp-desktop')
 *
 * To wire this into the Tauri shell, change
 *   src-tauri/tauri.conf.json `bundle.updater.endpoints` to
 *   "http://127.0.0.1:3055/api/updates/manifest?channel={{?}}&target={{target}}&arch={{arch}}&current_version={{current_version}}"
 * (and add a `set_update_channel` Tauri command so the operator can
 * inject the chosen channel into the URL — one-line follow-up on the
 * desktop side).
 */
import { NextRequest, NextResponse } from 'next/server';
import { readOperatorState } from '@/lib/operator-state-pg';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
  // Subscribers to a less-stable channel also see more-stable releases.
  // alpha sees: alpha + beta + stable. beta sees: beta + stable. stable: stable.
  if (target === 'alpha') return new Set(['alpha', 'beta', 'stable']);
  if (target === 'beta') return new Set(['beta', 'stable']);
  return new Set(['stable']);
}

function platformKeyFor(target: string, arch: string): string | null {
  // Tauri uses "{os}-{arch}" with os ∈ {darwin, linux, windows} and
  // arch ∈ {x86_64, aarch64, i686}. The `target` param it sends matches
  // those os names. We accept arch with or without underscore.
  const t = target.toLowerCase();
  const a = arch.toLowerCase().replace(/-/g, '_');
  if (!['darwin', 'linux', 'windows'].includes(t)) return null;
  if (!['x86_64', 'aarch64', 'i686'].includes(a)) return null;
  return `${t}-${a}`;
}

function pickAssetUrl(release: GhRelease, target: string, arch: string): string | null {
  const platform = platformKeyFor(target, arch);
  if (!platform) return null;
  // Prefer assets whose name encodes the platform. Tauri's bundle output
  // contains the target triple, e.g. `papercusp_0.1.2_aarch64.dmg.tar.gz`.
  const candidates = release.assets.filter((a) => {
    const name = a.name.toLowerCase();
    if (!name.endsWith('.tar.gz') && !name.endsWith('.zip')) return false;
    if (target === 'darwin' && !name.includes('darwin') && !name.endsWith('.app.tar.gz')) return false;
    if (target === 'linux' && !name.includes('linux') && !name.endsWith('.appimage.tar.gz')) return false;
    if (target === 'windows' && !name.includes('windows') && !name.endsWith('.msi.zip') && !name.endsWith('.exe.tar.gz')) return false;
    const archMatch =
      (arch === 'x86_64' && (name.includes('x86_64') || name.includes('x64'))) ||
      (arch === 'aarch64' && (name.includes('aarch64') || name.includes('arm64'))) ||
      (arch === 'i686' && (name.includes('i686') || name.includes('x86')));
    return archMatch;
  });
  return candidates[0]?.browser_download_url ?? null;
}

function findSignature(release: GhRelease, assetUrl: string): string {
  const file = assetUrl.split('/').pop() ?? '';
  const sig = release.assets.find((a) => a.name === `${file}.sig`);
  return sig?.browser_download_url ?? '';
}

async function fetchReleases(): Promise<GhRelease[]> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`github releases: ${res.status}`);
  return (await res.json()) as GhRelease[];
}

function resolveChannel(req: NextRequest, override?: string): Channel {
  const fromQuery = req.nextUrl.searchParams.get('channel');
  if (fromQuery && CHANNELS.has(fromQuery as Channel)) return fromQuery as Channel;
  if (override && CHANNELS.has(override as Channel)) return override as Channel;
  return 'stable';
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('target') ?? 'linux';
  const arch = req.nextUrl.searchParams.get('arch') ?? 'x86_64';
  const currentVersion = req.nextUrl.searchParams.get('current_version') ?? '';

  // If no explicit channel, fall back to the user's stored preference.
  const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
  const channel = resolveChannel(req, stored?.update_channel);

  let releases: GhRelease[];
  try {
    releases = await fetchReleases();
  } catch (e: any) {
    return NextResponse.json({ error: `releases fetch: ${e?.message}` }, { status: 502 });
  }

  const visible = visibleChannels(channel);
  const candidate = releases
    .filter((r) => !r.draft)
    .filter((r) => visible.has(classifyChannel(r)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];

  if (!candidate) {
    return new NextResponse(null, { status: 204 });
  }
  if (currentVersion && candidate.tag_name.replace(/^v/, '') === currentVersion) {
    return new NextResponse(null, { status: 204 });
  }

  const assetUrl = pickAssetUrl(candidate, target, arch);
  if (!assetUrl) {
    return NextResponse.json(
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
  return NextResponse.json(manifest);
}
