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
 * Hash the file in CHUNKS, never with readFileSync.
 *
 * Node's readFileSync throws ERR_FS_FILE_TOO_LARGE above 2 GiB — and EVERY real
 * artifact here is 3-4 GB, so the naive version worked on test fixtures and blew
 * up on the first genuine release. Hash the stream instead: constant memory,
 * no size ceiling.
 */
function sha256File(file: string): string {
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
  return hash.digest('hex');
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

    const prev = await previousCutAt(sql, opts.scope.workspaceId, opts.channel, opts.cutAt);
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

    const artifacts = scanArtifacts(opts.bundleDirs, opts.version, tag);

    // A release that records only SOME platforms must never look like a complete
    // one. 0.0.8 went out advertising itself to every beta tester while carrying
    // linux artifacts alone — a Mac or Windows tester had nothing to download, and
    // nothing anywhere said so. Name the platforms that are missing a GUI installer,
    // loudly, every time. (Not fatal: a deliberate single-platform cut is legal —
    // but it has to be a CHOICE, made in the open, not a silent omission.)
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
      console.log(`      ${a.platform.padEnd(18)} ${a.name}  (${(a.size / 1e9).toFixed(2)} GB)`);
    }
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
    return 2;
  }
  const channel = arg(argv, '--channel') ?? 'alpha';
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
  const outDir = arg(argv, '--out') ?? path.join(bundleDir, 'release-history');
  const scope: Scope = {
    workspaceId: arg(argv, '--workspace') ?? 'papercusp-workspace',
    harnessSlug: arg(argv, '--harness') ?? 'papercusp',
  };

  if (regenerate) return regenerateOnly(scope, outDir);

  return run({
    version: version as string,
    channel,
    gitSha: arg(argv, '--git-sha'),
    cutAt: cutAtRaw ? new Date(cutAtRaw) : new Date(),
    since: sinceRaw ? new Date(sinceRaw) : null,
    changelogMd,
    bundleDirs,
    outDir,
    scope,
    cutBy: arg(argv, '--cut-by') ?? process.env.PAPERCUSP_SESSION_ID ?? null,
    dryRun: argv.includes('--dry-run'),
    genChangelog: argv.includes('--generate-changelog'),
    forceChangelog: argv.includes('--force-changelog'),
  });
}

if (isCliEntry(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[record-release] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(1);
    });
}
