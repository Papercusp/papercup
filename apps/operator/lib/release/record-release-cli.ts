/**
 * record-release-cli — write a cut into the release registry, and regenerate the
 * static beta release-history site from it. (WI-4446.)
 *
 *   tsx apps/operator/lib/release/record-release-cli.ts \
 *       --version 0.0.9 --channel alpha --git-sha <sha> \
 *       --changelog-file /path/to/changelog.md
 *
 *   ... --dry-run            # print what it WOULD record + write; touch nothing
 *   ... --since 2026-07-05   # explicit window start (only needed for the first release)
 *   ... --out <dir>          # where the generated site lands (default: <bundle>/release-history)
 *
 * Runs AFTER the cut (release-local.sh builds + signs + writes latest.json and
 * stops). Publishing the generated site is a separate step —
 * `papercusp-desktop/bin/publish-release-history.sh` — for the same reason the
 * artifact upload is separate: writing bytes and publishing them are different
 * decisions with different blast radii.
 *
 * ⛔ THE SECRET NEVER ENTERS POSTGRES. Artifact urls are stored RELATIVE
 * (`desktop-v0.0.9-alpha/Papercusp_GUI_0.0.9_amd64.AppImage`), never absolute.
 * The base is the secret path segment; putting it in a row would copy it into
 * every backup, replica, sync projection and pg_dump we own — and this table is
 * read by surfaces that render to a UI. Each consumer resolves the relative url
 * against the base it already holds: the static page does it with plain relative
 * links (it IS at the base), and /api/updates/history prefixes releaseHostBase().
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import postgres from 'postgres';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';
import { POSTHOG_PUBLIC_DEFAULTS } from '@papercusp/operator-core/lib/posthog-public-defaults';
import {
  hydrateRelease,
  listReleases,
  previousCutAt,
  recordRelease,
  snapshotWindow,
  type ReleaseArtifact,
  type ReleaseRow,
  type Scope,
} from './release-registry';
import { generateChangelog } from './changelog-generate';
import {
  planPagePath,
  renderHistoryJson,
  renderIndexHtml,
  renderPlanPageHtml,
  type HydratedRelease,
} from './release-history-page';

/** The window we snapshot when there is NO previous release to bound it. Bounded
 *  on purpose: an unbounded lower bound would sweep the entire history of the
 *  project into the first release's "what shipped" list. */
const FIRST_RELEASE_LOOKBACK_DAYS = 14;

export interface RecordOpts {
  version: string;
  channel: string;
  gitSha: string | null;
  cutAt: Date;
  since: Date | null;
  changelogMd: string | null;
  /** EVERY platform's bundle root — see `releaseBundleRoots`. Not just linux. */
  bundleDirs: string[];
  /** The papercup-rust-mobile repo root (Android/iOS artifacts); null to skip mobile. */
  mobileRoot: string | null;
  outDir: string;
  scope: Scope;
  cutBy: string | null;
  dryRun: boolean;
  /** Generate a changelog DRAFT for the window and stop — do not record. The draft
   *  is reviewed, then recorded via `--changelog-file`. (owner ask #4.) */
  genChangelog: boolean;
  /** Re-roll the draft even if one already exists on disk. */
  forceChangelog: boolean;
}

/**
 * What platform/product is this artifact? Pure, so the mapping is tested rather
 * than discovered in production. Returns null for things that are not a
 * user-installable artifact (signatures, checksums, stray files).
 */
export function classifyArtifact(name: string): Pick<ReleaseArtifact, 'product' | 'platform'> | null {
  if (name.endsWith('.sig') || name.endsWith('.sha256')) return null;
  // Mobile products FIRST — a phone app is its own `product`, independent of the
  // gui/server split (it is neither a desktop GUI nor a headless server). Keeping
  // them a distinct product is what lets the page give them their own "Mobile
  // apps" section and keeps them out of the desktop auto-update manifest.
  if (/\.(apk|aab)$/i.test(name)) return { product: 'mobile', platform: 'android-universal' };
  if (/\.ipa$/i.test(name)) return { product: 'mobile', platform: 'ios-arm64' };
  const product: 'gui' | 'server' = /server/i.test(name) ? 'server' : 'gui';
  if (/\.(deb|AppImage)$/.test(name)) return { product, platform: 'linux-x86_64' };
  if (/\.(dmg)$/.test(name) || /\.app\.tar\.gz$/.test(name)) return { product, platform: 'darwin-universal' };
  if (/\.(exe|msi)$/.test(name)) return { product, platform: 'windows-x86_64' };
  return null;
}

/** `desktop-v0.0.9-alpha` — the object-key directory a cut's artifacts live under. */
export function releaseTag(version: string, channel: string): string {
  return channel === 'stable' ? `desktop-v${version}` : `desktop-v${version}-${channel}`;
}

/**
 * Persistent SHA-256 cache keyed by (absolute path, size, mtimeMs).
 *
 * A tri-platform cut is ~18 GB of artifacts (two ~4 GB debs, a 4 GB AppImage,
 * plus ~2 GB each for the dmg / app.tar.gz / setup.exe), and record-release-cli
 * re-hashed ALL of it on EVERY run. So a re-publish that only ADDED one platform
 * (e.g. dropping mac onto an already-published linux+windows cut) still spent
 * tens of seconds re-SHA-256-ing the UNCHANGED linux+windows bytes — which is why
 * "regenerating the simple index.html" was never actually fast. Caching the
 * digest by content-identity (size+mtime) means an unchanged artifact is hashed
 * exactly ONCE, ever: an incremental re-publish hashes only the genuinely-new
 * files, and a no-op re-run is instant. The cache is advisory — a miss (or an
 * absent/corrupt cache file) simply re-hashes, so it can never ship a wrong sum.
 */
const SHA_CACHE_PATH = path.join(os.homedir(), '.papercusp', 'release-sha256-cache.json');
type ShaCacheEntry = { size: number; mtimeMs: number; sha256: string };
let shaCache: Record<string, ShaCacheEntry> | null = null;
function loadShaCache(): Record<string, ShaCacheEntry> {
  if (!shaCache) {
    try {
      shaCache = JSON.parse(fs.readFileSync(SHA_CACHE_PATH, 'utf8')) as Record<string, ShaCacheEntry>;
    } catch {
      shaCache = {};
    }
  }
  return shaCache;
}
function saveShaCache(): void {
  if (!shaCache) return;
  try {
    fs.mkdirSync(path.dirname(SHA_CACHE_PATH), { recursive: true });
    const tmp = `${SHA_CACHE_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(shaCache));
    fs.renameSync(tmp, SHA_CACHE_PATH); // atomic swap — safe under concurrent cuts
  } catch {
    /* advisory cache: a write failure just means the next run re-hashes */
  }
}

/**
 * Hash the file in CHUNKS, never with readFileSync — cached by (path,size,mtime).
 *
 * Node's readFileSync throws ERR_FS_FILE_TOO_LARGE above 2 GiB — and EVERY real
 * artifact here is 3-4 GB, so the naive version worked on test fixtures and blew
 * up on the first genuine release. Hash the stream instead: constant memory,
 * no size ceiling. The cache (above) skips the multi-GB read entirely when the
 * artifact is unchanged since a prior run.
 */
function sha256File(file: string): string {
  const st = fs.statSync(file);
  const key = path.resolve(file);
  const cache = loadShaCache();
  const hit = cache[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20); // 1 MiB
    let read: number;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest('hex');
  cache[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digest };
  saveShaCache();
  return digest;
}

/**
 * The bundle ROOTS a tri-platform cut writes to — ONE PER LEG, in three different
 * trees. This is the whole reason 0.0.8 shipped a Linux-only release page.
 *
 * Each leg of release-local.sh drops its bundle somewhere different:
 *   - linux   → $CARGO_TARGET_DIR/release/bundle          (deb/, appimage/)
 *   - mac     → src-tauri/target/universal-apple-darwin/… (dmg/, macos/)   [rsync'd back from the mac VM]
 *   - windows → src-tauri/target/windows-vm/bundle        (inno/)          [rsync'd back from the win VM]
 *
 * scanArtifacts used to take a SINGLE dir defaulting to the linux one, so the mac
 * and windows bytes — which were built, signed, and sitting on disk the whole time
 * — were never even looked at. `classifyArtifact` already knew how to label a .dmg
 * and a .exe; nothing ever handed it one. The page then advertised "0.0.8" to every
 * beta tester while offering a Mac or Windows user nothing to download, and the
 * same history.json drives the in-app Update Center, so those platforms had no
 * update path either. A recorder that silently records a THIRD of a release is
 * worse than one that fails: the output looks complete.
 */
/**
 * Locate `papercusp-desktop/` — the tree the mac + windows legs bundle into.
 *
 * Walks up from cwd rather than assuming the repo root, so the CLI still finds the
 * mac/windows artifacts when it is invoked from a subdirectory. `--desktop-root` /
 * PAPERCUSP_DESKTOP_ROOT override it. Returning a path that does not exist is fine:
 * scanArtifacts skips absent roots, and the missing-platform warning then fires —
 * which is the loud failure we want, not a silent linux-only record.
 */
export function resolveDesktopRoot(startDir: string = process.cwd()): string {
  const env = process.env.PAPERCUSP_DESKTOP_ROOT;
  if (env) return env;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'papercusp-desktop');
    if (fs.existsSync(path.join(cand, 'src-tauri'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(startDir), 'papercusp-desktop');
}

/**
 * Locate `papercup-rust-mobile` — the SEPARATE repo (a sibling of the papercup
 * checkout, NOT a submodule) that holds the Android/iOS sources + build outputs.
 *
 * Returns null when it can't be found: mobile is OPTIONAL, and a null root makes
 * scanMobileArtifacts a no-op, so a desktop-only cut stays legal and silent.
 * `--mobile-root` / PAPERCUSP_MOBILE_ROOT override.
 */
export function resolveMobileRoot(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    for (const cand of [
      path.join(dir, 'papercup-rust-mobile'),
      path.join(path.dirname(dir), 'papercup-rust-mobile'),
    ]) {
      if (fs.existsSync(path.join(cand, 'crates')) || fs.existsSync(path.join(cand, 'Makefile'))) {
        return cand;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Is this `.exe` an Inno SPANNED installer — a small bootstrap whose real payload
 * lives in sibling `-1.bin`, `-2.bin`, … disks?
 *
 * Detected structurally (do the companion disks exist?) rather than by a size
 * threshold, because "how big is too small for an installer" is a guess that goes
 * stale, while the `-N.bin` siblings are exactly what Inno writes when it spans.
 * Exported so the rule is unit-testable rather than discovered by a beta tester
 * whose install failed.
 */
export function isSpannedInstaller(dir: string, name: string): boolean {
  if (!/\.exe$/i.test(name)) return false;
  const base = name.replace(/\.exe$/i, '');
  return fs
    .readdirSync(dir)
    .some((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.bin$`, 'i').test(f));
}

export function releaseBundleRoots(linuxBundleDir: string, desktopRoot: string): string[] {
  return [
    linuxBundleDir,
    path.join(desktopRoot, 'src-tauri', 'target', 'universal-apple-darwin', 'release', 'bundle'),
    path.join(desktopRoot, 'src-tauri', 'target', 'windows-vm', 'bundle'),
  ];
}

/**
 * Find this version's artifacts on disk and describe them. The URL is RELATIVE —
 * see the module header.
 *
 * Scans EVERY bundle root (see `releaseBundleRoots`). A missing root is not an
 * error — a linux-only cut simply has no mac/windows tree — but it IS the caller's
 * job to notice a leg went missing; see the per-platform report in `run()`.
 */
export function scanArtifacts(
  bundleDirs: string[],
  version: string,
  tag: string,
): ReleaseArtifact[] {
  // `inno` is the Windows one, and its absence here is precisely why no Windows
  // installer has ever been recorded: tauri builds the Windows setup with Inno
  // Setup, which writes to inno/ — never to the nsis/ or msi/ dirs this list used
  // to stop at.
  const subdirs = ['deb', 'appimage', 'dmg', 'macos', 'nsis', 'msi', 'inno'];
  const found: ReleaseArtifact[] = [];
  const seen = new Set<string>();
  for (const bundleDir of bundleDirs) {
    for (const sub of subdirs) {
      const dir = path.join(bundleDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.includes(version)) continue;
        const kind = classifyArtifact(name);
        if (!kind) continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        // NEVER record an installer we KNOW is incomplete. Inno Setup emits a
        // SPANNED installer when the payload is large: `foo-setup.exe` becomes a
        // ~3 MB bootstrap that reads `foo-setup-1.bin`, `-2.bin`, … from beside it.
        // Recorded alone, that stub downloads perfectly and then fails at install —
        // and the release page would show it with a confident size and sha256. An
        // artifact that cannot install is worse than an absent one: the absent one
        // is honest. Skip it (loudly) until the companions are published too.
        if (isSpannedInstaller(dir, name)) {
          console.warn(
            `  ⚠ SKIPPING ${name} — spanned Inno installer (payload is in its *-N.bin disks, which are not published). ` +
              `Recording the stub alone would offer a download that cannot install.`,
          );
          continue;
        }
        // The same artifact can be reachable from two roots (a salvage/reuse path
        // rsyncs bytes into a second tree). Record it once — a duplicated row would
        // show the tester the same download twice.
        if (seen.has(name)) continue;
        seen.add(name);
        found.push({
          ...kind,
          name,
          // Relative to the release base. Never absolute — the base is the secret.
          url: `${tag}/${name}`,
          size: stat.size,
          sha256: sha256File(full),
        });
      }
    }
  }
  return found.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

/** Bounded recursive file walk (depth-limited so a deep build tree can't wedge the scan). */
function walkFiles(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, maxDepth, depth + 1));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Find the mobile app artifacts (Android APK/AAB, iOS IPA) and describe them.
 *
 * Mobile is DIFFERENT from the desktop tauri artifacts in two ways that this
 * function exists to bridge:
 *
 *   1. They live in the SEPARATE `papercup-rust-mobile` repo, not in any tauri
 *      bundle root — so they take their own root (`mobileRoot`), not a
 *      `releaseBundleRoots` entry.
 *   2. Their built filenames carry NO version (`app-debug.apk`, not
 *      `Papercusp_0.0.9_…`). So — unlike `scanArtifacts`, which filters by a
 *      version substring — we record each under a SYNTHESIZED version+platform
 *      name (`Papercusp_${version}_android.apk`), url relative to the release tag
 *      like every other artifact. The publisher copies the real bytes to that
 *      name under the tag dir.
 *
 * iOS is DORMANT until Apple Developer enrollment: with no signing identity there
 * is no distributable `.ipa`, so the scan simply finds nothing for iOS until a
 * signed `.ipa` exists — an HONEST omission (no fake iOS row on the page), and the
 * `.ipa` branch is ready the day enrollment lands. Release preferred over debug.
 */
export function scanMobileArtifacts(
  mobileRoot: string | null,
  version: string,
  tag: string,
): ReleaseArtifact[] {
  const found: ReleaseArtifact[] = [];
  for (const { src, outName } of scanMobileArtifactSources(mobileRoot, version)) {
    const kind = classifyArtifact(outName);
    if (!kind) continue;
    found.push({
      ...kind,
      name: outName,
      url: `${tag}/${outName}`,
      size: fs.statSync(src).size,
      sha256: sha256File(src),
    });
  }
  return found.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

/**
 * The source-path ↔ published-name pairs behind `scanMobileArtifacts` — exported
 * separately because the UPLOADER needs it too: mobile artifacts are recorded
 * under synthesized versioned names (`Papercusp_0.0.9_android.apk`) that do NOT
 * exist on disk, so whoever pushes bytes must know which real file maps to which
 * object key. `bin/upload-mobile-release.sh` consumes this via `--scan-mobile`
 * (TSV: src TAB outName) so the candidate list lives in exactly one place.
 */
export function scanMobileArtifactSources(
  mobileRoot: string | null,
  version: string,
): Array<{ src: string; outName: string }> {
  if (!mobileRoot || !fs.existsSync(mobileRoot)) return [];
  // Ordered: release preferred over debug. First hit per synthesized name wins.
  const candidates: Array<{ dir: string; ext: RegExp; recurse?: boolean; outName: string }> = [
    { dir: 'android/app/build/outputs/apk/release', ext: /\.apk$/i, outName: `Papercusp_${version}_android.apk` },
    { dir: 'android/app/build/outputs/apk/debug', ext: /\.apk$/i, outName: `Papercusp_${version}_android.apk` },
    { dir: 'android/app/build/outputs/bundle/release', ext: /\.aab$/i, outName: `Papercusp_${version}_android.aab` },
    { dir: 'ios/build', ext: /\.ipa$/i, recurse: true, outName: `Papercusp_${version}_ios.ipa` },
  ];
  const found: Array<{ src: string; outName: string }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const dir = path.join(mobileRoot, c.dir);
    if (!fs.existsSync(dir)) continue;
    if (seen.has(c.outName)) continue; // release already claimed this name → skip debug
    const files = (c.recurse ? walkFiles(dir, 5) : fs.readdirSync(dir).map((n) => path.join(dir, n))).filter(
      (f) => c.ext.test(f),
    );
    for (const full of files) {
      if (!fs.statSync(full).isFile()) continue;
      seen.add(c.outName);
      found.push({ src: full, outName: c.outName });
      break; // one artifact per candidate dir
    }
  }
  return found;
}

/** Regenerate the whole static site from the registry (every release, newest first). */
export async function generateSite(
  sql: postgres.Sql,
  scope: Scope,
  outDir: string,
): Promise<{ pages: number }> {
  const rows = await listReleases(sql, scope.workspaceId);
  const hydratedAll: HydratedRelease[] = [];
  for (const row of rows) {
    const { items, plans, internalCount } = await hydrateRelease(sql, scope, row);
    hydratedAll.push({ row, items, plans, internalCount });
  }

  const opts = { generatedAt: new Date(), analytics: POSTHOG_PUBLIC_DEFAULTS };
  fs.mkdirSync(path.join(outDir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), renderIndexHtml(hydratedAll, opts), 'utf8');
  // The machine-readable twin of the page — what the in-app Update Center reads.
  // Same registry, same scrub, published to the same host as latest.json.
  fs.writeFileSync(path.join(outDir, 'history.json'), renderHistoryJson(hydratedAll, opts), 'utf8');
  let pages = 1;

  // One page per plan, newest release wins when a plan spans several (it carries
  // the most recent status).
  const seen = new Set<string>();
  for (const rel of hydratedAll) {
    for (const plan of rel.plans) {
      if (seen.has(plan.slug)) continue;
      seen.add(plan.slug);
      const html = renderPlanPageHtml(plan, { ...opts, version: rel.row.version });
      fs.writeFileSync(path.join(outDir, planPagePath(plan.slug)), html, 'utf8');
      pages++;
    }
  }
  return { pages };
}

export async function run(opts: RecordOpts): Promise<number> {
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    const tag = releaseTag(opts.version, opts.channel);

    const prev = await previousCutAt(
      sql,
      opts.scope.workspaceId,
      opts.channel,
      opts.cutAt,
      opts.version,
    );
    const from =
      opts.since ??
      prev ??
      new Date(opts.cutAt.getTime() - FIRST_RELEASE_LOOKBACK_DAYS * 86_400_000);
    if (!opts.since && !prev) {
      console.log(
        `[record-release] no previous ${opts.channel} release on record — bounding the window at ` +
          `${FIRST_RELEASE_LOOKBACK_DAYS}d before the cut (${from.toISOString()}). Pass --since to override.`,
      );
    }

    const snap = await snapshotWindow(sql, opts.scope, from.getTime(), opts.cutAt.getTime());

    // ── Changelog draft (owner ask #4) — generate, then STOP. ────────────────
    // Generation and recording are separate decisions on purpose: the draft is a
    // model's paraphrase of work-item titles, and a model handed "the work is done"
    // will happily write "it works now" for something that was never verified on the
    // user's platform (exactly the lie 0.0.9 nearly shipped for Windows auto-update).
    // So we write a DRAFT a human/agent reviews, then record THAT file via
    // --changelog-file. See changelog-generate.ts's header.
    if (opts.genChangelog) {
      const prevRows = await listReleases(sql, opts.scope.workspaceId, opts.channel);
      const previousVersion =
        prevRows.find((r) => r.cutAt < opts.cutAt)?.version ?? null;
      const draftPath = path.join(
        path.dirname(opts.outDir),
        `changelog-draft-${opts.version}-${opts.channel}.md`,
      );
      const res = await generateChangelog(
        {
          version: opts.version,
          channel: opts.channel,
          previousVersion,
          items: snap.items,
          plans: snap.plans,
          internalCount: snap.internalIds.length,
        },
        draftPath,
        { force: opts.forceChangelog },
      );
      console.log(`[record-release] changelog draft (${res.source}) → ${res.draftPath}`);
      if (res.warnings.length > 0) {
        console.log(`\n⚠ ${res.warnings.length} thing(s) to review before recording — fix these in the draft:`);
        for (const w of res.warnings) console.log(w);
      }
      console.log('\n  Review + edit the claims it cannot stand behind, then record with:');
      console.log(
        `    tsx apps/operator/lib/release/record-release-cli.ts --version ${opts.version} ` +
          `--channel ${opts.channel} --git-sha <sha> --changelog-file ${res.draftPath}`,
      );
      console.log('\n──────── draft ────────');
      console.log(res.md);
      console.log('───────────────────────');
      return 0;
    }

    const desktopArtifacts = scanArtifacts(opts.bundleDirs, opts.version, tag);
    // Mobile artifacts live in a separate repo + are not version-named — see
    // scanMobileArtifacts. Merged into the same record; the page + history.json
    // give `product:'mobile'` its own section, and the desktop auto-update
    // manifest (latest.json) never sees them (it is desktop-platform-only).
    const mobileArtifacts = scanMobileArtifacts(opts.mobileRoot, opts.version, tag);
    const artifacts = [...desktopArtifacts, ...mobileArtifacts];

    // A release that records only SOME platforms must never look like a complete
    // one. 0.0.8 went out advertising itself to every beta tester while carrying
    // linux artifacts alone — a Mac or Windows tester had nothing to download, and
    // nothing anywhere said so. Name the platforms that are missing a GUI installer,
    // loudly, every time. (Not fatal: a deliberate single-platform cut is legal —
    // but it has to be a CHOICE, made in the open, not a silent omission.)
    // NB: mobile is NOT in this required set — a desktop cut with no phone build is
    // legal and must not warn; the mobile summary below reports mobile separately.
    const guiPlatforms = new Set(
      artifacts.filter((a) => a.product === 'gui').map((a) => a.platform),
    );
    const missing = (['linux-x86_64', 'darwin-universal', 'windows-x86_64'] as const).filter(
      (p) => !guiPlatforms.has(p),
    );
    if (missing.length > 0) {
      console.warn(
        `  ⚠ NO GUI INSTALLER for: ${missing.join(', ')} — a tester on ${
          missing.length === 1 ? 'that platform' : 'those platforms'
        } will have nothing to download, and the in-app Update Center will offer them no update.`,
      );
      console.warn(`    Scanned roots:\n${opts.bundleDirs.map((d) => `      ${d}`).join('\n')}`);
    }

    const row: ReleaseRow = {
      version: opts.version,
      channel: opts.channel,
      cutAt: opts.cutAt,
      publishedAt: null,
      changelogMd: opts.changelogMd,
      // The record states the fact — everything that went terminal in the window.
      // The PAGE decides what to show (it counts EI-* rather than listing them).
      workItemIds: [...snap.items.map((i) => i.id), ...snap.internalIds],
      planSlugs: snap.plans.map((p) => p.slug),
      artifacts,
      gitSha: opts.gitSha,
      cutBy: opts.cutBy,
      notes: null,
    };

    console.log(`[record-release] ${opts.version} (${opts.channel})`);
    console.log(`  window     : ${from.toISOString()} → ${opts.cutAt.toISOString()}`);
    console.log(`  work items : ${snap.items.length} user-facing, ${snap.internalIds.length} internal`);
    console.log(`  plans      : ${snap.plans.length}`);
    console.log(`  artifacts  : ${artifacts.length}${artifacts.length === 0 ? '  ⚠ none found on disk' : ''}`);
    for (const a of artifacts) {
      const sz = a.size >= 1e9 ? `${(a.size / 1e9).toFixed(2)} GB` : `${(a.size / 1e6).toFixed(1)} MB`;
      console.log(`      ${a.platform.padEnd(18)} ${a.name}  (${sz})`);
    }
    const mobilePlatforms = new Set(
      artifacts.filter((a) => a.product === 'mobile').map((a) => a.platform),
    );
    console.log(
      `  mobile     : android ${mobilePlatforms.has('android-universal') ? '✓' : '—'}  ·  ios ${
        mobilePlatforms.has('ios-arm64')
          ? '✓'
          : '— (dormant: needs Apple Developer enrollment for a signed .ipa)'
      }`,
    );
    console.log(`  changelog  : ${opts.changelogMd ? `${opts.changelogMd.length} chars` : '⚠ NONE'}`);

    if (opts.dryRun) {
      console.log('[record-release] --dry-run — nothing written.');
      return 0;
    }

    await recordRelease(sql, opts.scope.workspaceId, row);
    console.log('[record-release] recorded.');

    const { pages } = await generateSite(sql, opts.scope, opts.outDir);
    console.log(`[record-release] generated ${pages} page(s) → ${opts.outDir}`);
    console.log('[record-release] publish with: papercusp-desktop/bin/publish-release-history.sh');
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Rebuild every page from the registry WITHOUT recording anything.
 *
 * The pages are a projection, so a fix to the RENDERER (a leak in the markup, a
 * wording change) must be re-publishable on its own. Without this, the only way to
 * regenerate is to re-record a release — which would silently re-snapshot the work
 * window against a NEW `now`, quietly rewriting which items a past release shipped.
 * A rendering fix must never be able to change history.
 */
export async function regenerateOnly(scope: Scope, outDir: string): Promise<number> {
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    const { pages } = await generateSite(sql, scope, outDir);
    console.log(`[record-release] regenerated ${pages} page(s) → ${outDir}  (registry untouched)`);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = arg(argv, '--version');
  const regenerate = argv.includes('--regenerate');
  if (!version && !regenerate) {
    console.error('usage: record-release-cli --version <x.y.z> [--channel alpha] [--git-sha <sha>]');
    console.error('       [--changelog-file <path>] [--cut-at <iso>] [--since <iso>]');
    console.error('       [--bundle <dir>] [--out <dir>] [--dry-run]');
    console.error('   changelog: record-release-cli --version <x.y.z> --generate-changelog [--force-changelog]');
    console.error('              # writes a reviewable draft from the window and STOPS (records nothing)');
    console.error('   or: record-release-cli --regenerate [--out <dir>]   # re-render pages only');
    console.error('   or: record-release-cli --scan-mobile --version <x.y.z>   # print mobile src↔name TSV for the uploader');
    return 2;
  }
  const opts = buildRunOpts(argv);
  // --scan-mobile: print the mobile source-path ↔ published-name pairs (TSV) and
  // stop. The uploader's door into the ONE candidate list (scanMobileArtifactSources).
  if (argv.includes('--scan-mobile')) {
    if (!opts.version) {
      console.error('usage: record-release-cli --scan-mobile --version <x.y.z> [--mobile-root <dir>]');
      return 2;
    }
    for (const { src, outName } of scanMobileArtifactSources(opts.mobileRoot, opts.version)) {
      console.log(`${src}\t${outName}`);
    }
    return 0;
  }
  if (regenerate) return regenerateOnly(opts.scope, opts.outDir);
  return run(opts);
}

/**
 * Assemble the full RecordOpts from argv/env. PURE (no DB) so it is unit-testable
 * — and extracted from main() specifically to GUARD the opts wiring. main() used
 * to compute `mobileRoot` locally and then forget to include it in the run({...})
 * object, so `scanMobileArtifacts` was handed `undefined` and silently recorded
 * NO mobile artifact on every real cut. Every unit test passed; only an
 * end-to-end dry-run caught it. Building one object here (and asserting its fields
 * in the buildRunOpts test) makes that class of drop impossible to reintroduce
 * without a red test.
 */
export function buildRunOpts(argv: string[]): RecordOpts {
  const changelogFile = arg(argv, '--changelog-file');
  const changelogMd = changelogFile ? fs.readFileSync(changelogFile, 'utf8') : null;
  const cutAtRaw = arg(argv, '--cut-at');
  const sinceRaw = arg(argv, '--since');
  const bundleDir =
    arg(argv, '--bundle') ??
    process.env.PAPERCUSP_BUNDLE_DIR ??
    path.join(process.env.CARGO_TARGET_DIR ?? `${process.env.HOME}/.cargo-target`, 'release/bundle');
  // The mac + windows legs land in the desktop app's own target tree, NOT in
  // CARGO_TARGET_DIR — so they need their own roots (see `releaseBundleRoots`).
  const desktopRoot = arg(argv, '--desktop-root') ?? resolveDesktopRoot();
  const bundleDirs = releaseBundleRoots(bundleDir, desktopRoot);
  // Mobile (Android/iOS) artifacts live in the separate papercup-rust-mobile repo.
  // Optional: null root → no mobile artifacts recorded (a legal desktop-only cut).
  const mobileRoot =
    arg(argv, '--mobile-root') ?? process.env.PAPERCUSP_MOBILE_ROOT ?? resolveMobileRoot();
  const outDir = arg(argv, '--out') ?? path.join(bundleDir, 'release-history');
  const scope: Scope = {
    workspaceId: arg(argv, '--workspace') ?? 'papercusp-workspace',
    harnessSlug: arg(argv, '--harness') ?? 'papercusp',
  };
  return {
    version: (arg(argv, '--version') ?? '') as string,
    channel: arg(argv, '--channel') ?? 'alpha',
    gitSha: arg(argv, '--git-sha'),
    cutAt: cutAtRaw ? new Date(cutAtRaw) : new Date(),
    since: sinceRaw ? new Date(sinceRaw) : null,
    changelogMd,
    bundleDirs,
    mobileRoot,
    outDir,
    scope,
    cutBy: arg(argv, '--cut-by') ?? process.env.PAPERCUSP_SESSION_ID ?? null,
    dryRun: argv.includes('--dry-run'),
    genChangelog: argv.includes('--generate-changelog'),
    forceChangelog: argv.includes('--force-changelog'),
  };
}

if (isCliEntry(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[record-release] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(1);
    });
}
