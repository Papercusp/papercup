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
import {
  planPagePath,
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
  bundleDir: string;
  outDir: string;
  scope: Scope;
  cutBy: string | null;
  dryRun: boolean;
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
 * Find this version's artifacts on disk and describe them. The URL is RELATIVE —
 * see the module header.
 */
export function scanArtifacts(bundleDir: string, version: string, tag: string): ReleaseArtifact[] {
  const subdirs = ['deb', 'appimage', 'dmg', 'macos', 'nsis', 'msi'];
  const found: ReleaseArtifact[] = [];
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
    const artifacts = scanArtifacts(opts.bundleDir, opts.version, tag);

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = arg(argv, '--version');
  if (!version) {
    console.error('usage: record-release-cli --version <x.y.z> [--channel alpha] [--git-sha <sha>]');
    console.error('       [--changelog-file <path>] [--cut-at <iso>] [--since <iso>]');
    console.error('       [--bundle <dir>] [--out <dir>] [--dry-run]');
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
  const outDir = arg(argv, '--out') ?? path.join(bundleDir, 'release-history');

  return run({
    version,
    channel,
    gitSha: arg(argv, '--git-sha'),
    cutAt: cutAtRaw ? new Date(cutAtRaw) : new Date(),
    since: sinceRaw ? new Date(sinceRaw) : null,
    changelogMd,
    bundleDir,
    outDir,
    scope: {
      workspaceId: arg(argv, '--workspace') ?? 'papercusp-workspace',
      harnessSlug: arg(argv, '--harness') ?? 'papercusp',
    },
    cutBy: arg(argv, '--cut-by') ?? process.env.PAPERCUSP_SESSION_ID ?? null,
    dryRun: argv.includes('--dry-run'),
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
