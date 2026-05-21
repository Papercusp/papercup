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

export const PLANS_DIR_REL = 'apps/operator/docs/plans';
export const ARCHIVE_DIR_REL = 'apps/operator/docs/plans/archive';

export interface PlanSourceOpts {
  repoRoot?: string;
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
 * set — `/`, `..`, URL-decoded escapes, NULs, whitespace — is rejected
 * before the slug is joined with the plans dir. Closes A-1 from the
 * agent-coordination-architecture-v2 audit: without this check,
 * `readPlanBySlug` would happily read `../../../etc/passwd.md` via
 * `path.join`'s `..` normalisation. Loopback-only + markdown-only
 * bounds the impact, but the right fix is a guarded slug at the
 * lowest layer so every caller (`/api/coord/plans/:slug` route,
 * `plans:*` MCP tools, list/lint/items helpers) inherits it.
 */
const VALID_PLAN_SLUG = /^[A-Za-z0-9._-]+$/;

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
