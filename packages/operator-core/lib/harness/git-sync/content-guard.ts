/**
 * The git-sync CONTENT GUARD (git-sync-content-guard-2026-06-13 P-001).
 *
 * Before git-sync's `git add -A && commit`, this enumerates the dirty
 * content-bearing files and runs each registered content detector whose scope
 * matches. Offenders ({ file, detectorKey, error }) are returned so the commit
 * path can EXCLUDE them (D-001: quarantine-don't-stall) and the action layer can
 * escalate + dispatch a content-fixer — instead of git-sync auto-committing a
 * file that hard-fails a downstream build (EI-438: a bare `<date>` broke every
 * agent's docs build for hours).
 *
 * PURE + seam-injected (runGit, readText, detectors) so it unit-tests without a
 * real repo. FAILS OPEN by design: a detector — or a file read — that THROWS is
 * logged and skipped (the file commits normally), so a content-check bug can
 * never wedge the whole fleet's commit. Only a clean "this file is broken"
 * verdict excludes a file.
 */
import type { RunGit } from './run-git-sync';
import type { ContentDetector } from '../../content-lint/registry';

/** One dirty file that failed a content detector — excluded from the commit + handed to the fixer. */
export interface ContentOffender {
  /** Repo-relative path within the (sub)repo. */
  file: string;
  /** Which detector flagged it (e.g. 'mdx', 'smart-quotes'). */
  detectorKey: string;
  /** Human-readable error — fed to the escalation body + the content-fixer prompt. */
  error: string;
  /** The role git-sync dispatches to fix this offender (the detector's fixerRole). */
  fixerRole: string;
}

export interface ContentGuardDeps {
  runGit: RunGit;
  /** Absolute path of the (sub)repo being guarded. */
  repoPath: string;
  /** Read a repo-relative file's working-tree text; null when unreadable/gone. */
  readText: (relPath: string) => Promise<string | null>;
  /** The registered content detectors to run (default registry in production). */
  detectors: ContentDetector[];
  log?: (m: string) => void;
}

/**
 * Parse `git status --porcelain -z -uall` into the dirty, content-bearing
 * repo-relative paths. Skips DELETIONS (no content to check) and resolves the
 * `-z` rename/copy pair encoding ("XY new\0old") — the SAME parse
 * findOversizedDirtyFiles uses, kept independent so neither well-tested path
 * perturbs the other.
 */
export function parseDirtyPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletion — no working-tree blob to check
    out.push(path);
  }
  return out;
}

/** Bounded-concurrency map (avoid a serial fs loop — CLAUDE.md perf anti-patterns). */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const MAX_READ_CONCURRENCY = 16;

/**
 * Run every registered detector whose `matches` is true over the dirty files,
 * collecting offenders. Only reads files at least one detector targets (no fs
 * cost for the rest). FAILS OPEN — a throwing detector/read is skipped, never an
 * offender.
 */
export async function detectContentOffenders(deps: ContentGuardDeps): Promise<ContentOffender[]> {
  const { runGit, repoPath, readText, detectors, log } = deps;
  if (detectors.length === 0) return [];
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return []; // can't list — fail open (the commit proceeds as today)

  // Pair each dirty path with the detectors that target it; drop paths no detector wants.
  const targets: Array<{ file: string; dets: ContentDetector[] }> = [];
  for (const file of parseDirtyPaths(r.stdout)) {
    const dets = detectors.filter((d) => {
      try {
        return d.matches(file);
      } catch (e) {
        log?.(`[content-guard] detector "${d.key}" match() threw on ${file} — skipping: ${errMsg(e)}`);
        return false;
      }
    });
    if (dets.length > 0) targets.push({ file, dets });
  }

  const offenders: ContentOffender[] = [];
  await mapPool(targets, MAX_READ_CONCURRENCY, async ({ file, dets }) => {
    let text: string | null;
    try {
      text = await readText(file);
    } catch (e) {
      log?.(`[content-guard] could not read ${file} — skipping (not blocking): ${errMsg(e)}`);
      return;
    }
    if (text == null) return; // gone/unreadable — nothing to check
    for (const d of dets) {
      try {
        const error = await d.detect(file, text);
        if (error) offenders.push({ file, detectorKey: d.key, error, fixerRole: d.fixerRole });
      } catch (e) {
        // FAIL OPEN — a content-check bug must never block the whole tree's commit.
        log?.(`[content-guard] detector "${d.key}" threw on ${file} — skipping (not blocking): ${errMsg(e)}`);
      }
    }
  });
  return offenders;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
