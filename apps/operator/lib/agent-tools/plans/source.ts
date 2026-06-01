/**
 * Filesystem source for plans.
 *
 * Canonical directory: <repoRoot>/apps/operator/docs/plans/
 * Archive subdirectory: <repoRoot>/apps/operator/docs/plans/archive/
 *
 * Pure FS read + parse. No PG, no caching above what node's fs gives us.
 * Cheap enough at ~50 files; per D-002 of the plan, parse cost is not
 * the substrate justification.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parsePlan, type ParsedPlan } from './parser';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { resolveProject } from '@/lib/harness-core';
import { detectPapercupRoot, PAPERCUP_HARNESS_SLUG } from '@/lib/harness/register-papercup';

export const PLANS_DIR_REL = 'apps/operator/docs/plans';
export const ARCHIVE_DIR_REL = 'apps/operator/docs/plans/archive';

/**
 * Per-harness plans directory convention. The papercup harness is the
 * legacy case: its plans live at `apps/operator/docs/plans/` (inside
 * the operator app). All other harnesses use `docs/plans/` at their
 * harness root — that's the convention going forward (D-002R of
 * per-harness-plans-and-docs-2026-05-23).
 *
 * TODO(per-harness-plans-and-docs-2026-05-23): extract to a registry
 * `plans_dir` field when a third config is needed. For now, two paths
 * = one if-clause.
 */
const PAPERCUP_PLANS_REL = 'apps/operator/docs/plans';
const DEFAULT_HARNESS_PLANS_REL = 'docs/plans';

/**
 * Pick the plans-dir relative path for a harness. Path-based detection
 * — not slug-based — so the legacy `apps/operator/docs/plans/` location
 * is used whenever the harness lives at the detected papercup repo
 * root, regardless of what slug it's registered under (dogfood Phase 4
 * may rename `papercup` to `papercup-org` etc.).
 */
function plansRelFor(harnessPath: string): string {
  const detected = detectPapercupRoot();
  if (detected && path.resolve(harnessPath) === path.resolve(detected)) {
    return PAPERCUP_PLANS_REL;
  }
  return DEFAULT_HARNESS_PLANS_REL;
}

/**
 * Resolve the per-harness plans directory + its archive subdir.
 *
 * D-002R: per-harness plans live at `<harness.path>/<plansRelFor(slug)>/`.
 * D-004R: no harness in context → fall through to the workspace's primary
 * harness (today: `papercup`, the harness whose path == REPO_ROOT).
 *
 * Throws if the resolved harness isn't registered.
 *
 * NOTE: this is the *async* per-harness resolver. The legacy sync
 * `getPlansDir`/`getArchiveDir` still exist for callers that haven't
 * yet been migrated to per-harness resolution — they default to the
 * papercup location via cwd-walk, preserving today's behavior. New
 * code should call this resolver instead. (Migration scheduled as
 * P-012 of per-harness-plans-and-docs-2026-05-23.)
 */
export async function resolveHarnessPlansDir(
  harnessSlug?: string,
  opts: { workspaceId?: string } = {},
): Promise<{ harnessSlug: string; plans: string; archive: string }> {
  // SU mode passes harnessSlug='*' as a wildcard sentinel meaning "no
  // specific harness in scope". Treat it (and any empty/whitespace
  // value) as a no-harness ctx and fall back per D-004R to the
  // workspace's primary harness — identified by `path === REPO_ROOT`,
  // not by slug. The primary slug used to be `papercup` but the
  // papercusp-dogfood Phase 4 restructure can rename it (e.g. to
  // `papercup-org`), so path-match is the resilient resolver.
  const raw = harnessSlug?.trim();
  const reg = await loadHarnessRegistry(opts.workspaceId);

  let project: typeof reg.projects[number] | undefined;
  let resolved: string;

  if (!raw || raw === '*') {
    // No harness in ctx: find the project whose path is the detected repo root.
    const detected = detectPapercupRoot();
    if (detected) {
      project = reg.projects.find((p) => path.resolve(p.path) === path.resolve(detected));
    }
    // Fallback chain: path-matched → legacy hardcoded papercup slug → first project.
    project = project ?? reg.projects.find((p) => p.slug === PAPERCUP_HARNESS_SLUG);
    if (!project) {
      throw new Error(
        `resolveHarnessPlansDir: no harness in ctx and no primary harness ` +
          `findable (no path-match for repo root '${detected}', no '${PAPERCUP_HARNESS_SLUG}' slug). ` +
          `Available: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
    resolved = project.slug;
  } else {
    resolved = raw;
    // Cross-workspace fallback (mirrors every other harness route): a harness
    // is registered in ONE workspace, but the active workspace flaps (multiple
    // SU agents + the desktop switch it). resolveProject scans the other
    // workspaces by slug when not pinned — so cross_harness:plans_* can reach a
    // harness in any workspace instead of hard-failing on whichever happens to
    // be active. A pinned workspace (opts.workspaceId) stays in it.
    project = await resolveProject(resolved, opts.workspaceId);
    if (!project) {
      // 'papercusp' (the product/umbrella name) is the classic typo for the
      // 'papercup' harness — a recurring agent error in the failed-tool-call
      // data worth a targeted hint.
      const didYouMean = resolved === 'papercusp' ? ` Did you mean '${PAPERCUP_HARNESS_SLUG}'?` : '';
      throw new Error(
        `resolveHarnessPlansDir: harness '${resolved}' not registered in any workspace.${didYouMean} ` +
          `Active-workspace harnesses: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
  }
  // P-014: runtime guard. For papercup, verify the registered path
  // still matches the detected repo root. Catches a registry-corruption
  // case where papercup was re-registered against a stale path; without
  // this, every plans:* call would silently read from the wrong dir.
  // Skip when detection returns null (packaged install — papercup repo
  // not on disk, the whole code path is a no-op anyway).
  if (resolved === PAPERCUP_HARNESS_SLUG) {
    const detected = detectPapercupRoot();
    if (detected && path.resolve(project.path) !== path.resolve(detected)) {
      throw new Error(
        `P-014 runtime guard: papercup harness path '${project.path}' ` +
          `does not match detected repo root '${detected}'. ` +
          `The registry is out of sync — re-run registerPapercupHarness() ` +
          `with pathOverride to fix.`,
      );
    }
  }
  const plans = path.join(project.path, plansRelFor(project.path));
  return { harnessSlug: resolved, plans, archive: path.join(plans, 'archive') };
}

export interface PlanSourceOpts {
  repoRoot?: string;
  /**
   * Direct override of the plans directory. When provided, bypasses
   * the cwd-walk that locates the papercup-default location. Used by
   * cross_harness:plans_* to target a specific harness's plans dir
   * (resolved via resolveHarnessPlansDir).
   */
  plansDir?: string;
  /** Direct override of the archive directory. Paired with `plansDir`. */
  archiveDir?: string;
}

/**
 * Resolve plans directory robustly. Tools may run from either the repo
 * root (tests with explicit repoRoot, CLI) or from apps/operator/ (Next
 * dev server). We try both layouts and pick whichever exists.
 *
 * If neither matches, fall back to <cwd>/apps/operator/docs/plans for
 * symmetry with the previous behavior — the caller will get an ENOENT
 * on first read with a clear path.
 */
function resolveCanonicalRoots(opts: PlanSourceOpts): { plans: string; archive: string } {
  // Direct override wins — no cwd-walk needed. Used by
  // cross_harness:plans_* and by tests that pass an explicit dir.
  if (opts.plansDir) {
    return {
      plans: opts.plansDir,
      archive: opts.archiveDir ?? path.join(opts.plansDir, 'archive'),
    };
  }
  const candidates: string[] = [];
  if (opts.repoRoot) {
    candidates.push(opts.repoRoot);
  } else {
    const cwd = process.cwd();
    candidates.push(cwd);
    if (cwd.endsWith(path.sep + 'apps' + path.sep + 'operator')) {
      candidates.push(path.dirname(path.dirname(cwd)));
    } else if (cwd.endsWith('/apps/operator')) {
      candidates.push(path.resolve(cwd, '..', '..'));
    }
  }

  for (const root of candidates) {
    const direct = path.join(root, PLANS_DIR_REL);
    try {
      // statSync would be cleaner but this module is async; existsSync is
      // fine here as it's bootstrap-only on the first call.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exists = require('node:fs').existsSync(direct);
      if (exists) return { plans: direct, archive: path.join(root, ARCHIVE_DIR_REL) };
    } catch {
      // fall through
    }
  }

  const root = candidates[0] ?? process.cwd();
  return {
    plans: path.join(root, PLANS_DIR_REL),
    archive: path.join(root, ARCHIVE_DIR_REL),
  };
}

export function getPlansDir(opts: PlanSourceOpts = {}): string {
  return resolveCanonicalRoots(opts).plans;
}

export function getArchiveDir(opts: PlanSourceOpts = {}): string {
  return resolveCanonicalRoots(opts).archive;
}

/**
 * The repo root — the directory that contains `apps/operator/docs/plans`.
 * `getPlansDir()` is `<root>/apps/operator/docs/plans` (PLANS_DIR_REL,
 * four path segments); strip them back off. A launched plan agent
 * (plan-agent-launch-2026-05-21, P-012) starts its process here.
 */
export function getRepoRoot(opts: PlanSourceOpts = {}): string {
  return path.resolve(getPlansDir(opts), '..', '..', '..', '..');
}

export interface ListEntry {
  slug: string;
  filePath: string;
  archived: boolean;
}

export async function listPlanFiles(opts: PlanSourceOpts = {}): Promise<ListEntry[]> {
  const plansDir = getPlansDir(opts);
  const archiveDir = getArchiveDir(opts);

  const entries: ListEntry[] = [];

  await collect(plansDir, false, entries);
  await collect(archiveDir, true, entries);

  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function collect(dir: string, archived: boolean, out: ListEntry[]): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith('.md') && !name.endsWith('.mdx')) continue;
    if (name.startsWith('.')) continue;
    const filePath = path.join(dir, name);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    out.push({
      slug: name.replace(/\.mdx?$/, ''),
      filePath,
      archived,
    });
  }
}

/**
 * Whitelist of characters legal in a plan slug. Anything outside this
 * set — `/`, URL-decoded escapes, NULs, whitespace — is rejected
 * before the slug is joined with the plans dir. Closes A-1 from the
 * agent-coordination-architecture-v2 audit: without this check,
 * `readPlanBySlug` would happily read `../../../etc/passwd.md` via
 * `path.join`'s `..` normalisation. Rejecting `/` is what stops
 * traversal — a `..` segment cannot escape a directory without a `/`.
 *
 * The read path guards here; the write path guards in
 * `withPlanLock` (with-plan-lock.ts), which imports this same regex —
 * so every caller, read or write, inherits one slug definition.
 */
export const VALID_PLAN_SLUG = /^[A-Za-z0-9._-]+$/;

export async function readPlanBySlug(
  slug: string,
  opts: PlanSourceOpts = {},
): Promise<{ parsed: ParsedPlan; archived: boolean } | null> {
  if (typeof slug !== 'string' || !VALID_PLAN_SLUG.test(slug)) return null;
  const plansDir = getPlansDir(opts);
  const archiveDir = getArchiveDir(opts);

  for (const [dir, archived] of [
    [plansDir, false],
    [archiveDir, true],
  ] as const) {
    for (const ext of ['.md', '.mdx']) {
      const fp = path.join(dir, slug + ext);
      try {
        const buf = await fs.readFile(fp, 'utf8');
        return { parsed: parsePlan(buf, { filePath: fp }), archived };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

export async function readAllPlans(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<Array<{ parsed: ParsedPlan; archived: boolean }>> {
  const entries = await listPlanFiles(opts);
  const filtered = opts.includeArchived ? entries : entries.filter((e) => !e.archived);
  const out: Array<{ parsed: ParsedPlan; archived: boolean }> = [];
  for (const e of filtered) {
    const buf = await fs.readFile(e.filePath, 'utf8');
    out.push({
      parsed: parsePlan(buf, { filePath: e.filePath }),
      archived: e.archived,
    });
  }
  return out;
}
