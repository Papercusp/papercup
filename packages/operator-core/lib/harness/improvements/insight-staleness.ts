/**
 * insight-staleness.ts — the agent-insights staleness collector
 * (learning-system-audit-improvements-2026-06-09 P-051).
 *
 * Insights (the procedural runbooks under agent-insights/) only go stale
 * MANUALLY today — someone must notice a runbook cites code that no longer
 * exists and flip its frontmatter `status`. Nothing sweeps for it, so wrong
 * runbooks keep being injected into agent preludes.
 *
 * This collector closes that edge as just-another-objective-signal: an ACTIVE
 * insight whose body cites repo files that no longer exist files a
 * `kind=change` minor improvement ("review for superseded") through the
 * normal watchdog capture path — search-first dedup, per-tick caps, the
 * triage routine then routes it. Queue-as-memory applies: rejecting the
 * capture records the decidedReason for the next sweep.
 *
 * Pure core (`scanInsightStaleness`) + thin fs glue (`collectInsightStalenessSignals`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WatchdogSignal } from './watchdog';

/** A loaded insight file: slug + frontmatter status + the raw body. */
export interface InsightFileForScan {
  slug: string;
  status: string;
  raw: string;
  /** Frontmatter `discovered:` date (YYYY-MM-DD), if present — drives the recency guard. */
  discovered?: string;
}

/**
 * Backticked tokens that look like specific repo files: anchored at a known
 * top-level dir, no globs/placeholders, and a real file extension. Deliberately
 * conservative — a missed citation is fine, a false "stale" capture is noise.
 */
const REPO_PATH_RE = /^(?:apps|packages|libs|scripts|bin)\/[\w@./-]+\.[a-z]{1,5}$/;

export function extractCitedPaths(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (token.includes('*') || token.includes('<') || token.includes(' ')) continue;
    if (REPO_PATH_RE.test(token)) out.add(token);
  }
  return [...out];
}

/**
 * Build a suffix-aware existence check from the repo's tracked-file list. A cited
 * path resolves when it exists EXACTLY or is a path-suffix of a real file — the
 * DROPPED-PREFIX shorthand authors use (`bin/hono-host.ts` for the real
 * `apps/operator/bin/hono-host.ts`), the dominant insight-staleness false positive
 * (EI-510 "stale path prefixes"; relight-self-learning-edges P-011). A genuinely
 * deleted/moved file has no suffix match and is still flagged. Strongly biased
 * toward NOT flagging — the module's stated posture ("a false 'stale' capture is
 * noise"). Matching is on whole path components (the `/`-anchored suffix), so
 * `core/loopback-fetch.ts` does NOT match `.../lib/loopback-fetch.ts`.
 */
export function makeRepoPathResolver(
  trackedFiles: readonly string[],
): (repoRelPath: string) => boolean {
  const exact = new Set(trackedFiles);
  const byBasename = new Map<string, string[]>();
  for (const f of trackedFiles) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const list = byBasename.get(base);
    if (list) list.push(f);
    else byBasename.set(base, [f]);
  }
  return (p) => {
    if (exact.has(p)) return true;
    const base = p.slice(p.lastIndexOf('/') + 1);
    const candidates = byBasename.get(base);
    if (!candidates) return false;
    const suffix = `/${p}`;
    return candidates.some((f) => f.endsWith(suffix));
  };
}

/**
 * Resolution cooldown for insight-staleness signals (EI-441 / EI-427). After an
 * insight-staleness item is resolved, the fix lands on the source-of-truth tree
 * (staging) but the live operator scans the release/green checkout, which lags
 * by the deploy window — so the same citation still reads as missing and the
 * signal re-files under a new id (the EI-413→EI-430 loop). Suppressing re-files
 * for this window after a resolution lets the fix propagate. 7 days comfortably
 * covers a normal deploy (and the abnormal green-checkpoint stalls seen during
 * alpha) while still re-surfacing a fix that genuinely never deployed.
 */
export const DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScanOpts {
  /** Cap signals per sweep (the watchdog has its own per-tick cap on top). */
  maxSignals?: number;
  /** Cooldown (ms) stamped on each signal. Default DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS. */
  resolutionCooldownMs?: number;
  /** "Now" for the recency guard. Default Date.now(). */
  nowMs?: number;
  /**
   * Skip insights discovered within this window — a freshly-written insight may
   * cite files that exist on the source tree (staging) but not yet on the scanned
   * green/release tree (deploy lag), the new-insight analog of the post-resolution
   * cooldown. Default DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS (EI-510 / P-011).
   */
  recencyGuardMs?: number;
}

/**
 * Pure: which active insights cite files that no longer exist?
 * `existsFn` takes a repo-relative path.
 */
export function scanInsightStaleness(
  insights: InsightFileForScan[],
  existsFn: (repoRelPath: string) => boolean,
  opts: ScanOpts = {},
): WatchdogSignal[] {
  const maxSignals = opts.maxSignals ?? 5;
  const resolutionCooldownMs = opts.resolutionCooldownMs ?? DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const recencyGuardMs = opts.recencyGuardMs ?? DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS;
  const signals: WatchdogSignal[] = [];
  for (const insight of insights) {
    if (signals.length >= maxSignals) break;
    const status = (insight.status || 'active').toLowerCase();
    if (status === 'retired' || status === 'superseded') continue;
    // Recency guard (EI-510 / P-011): a newly-written insight's citations may not
    // have deployed to the scanned (green/release) tree yet — the new-insight
    // analog of the post-resolution deploy-lag cooldown. Skip until the window passes.
    if (insight.discovered) {
      const d = Date.parse(insight.discovered);
      if (!Number.isNaN(d) && nowMs - d < recencyGuardMs) continue;
    }
    const cited = extractCitedPaths(insight.raw);
    if (cited.length === 0) continue;
    const missing = cited.filter((p) => !existsFn(p));
    if (missing.length === 0) continue;
    // Apoptosis (EI-441): EVERY cited file is gone → the runbook's whole evidence
    // base has evaporated, so the guidance is almost certainly obsolete. Surface
    // it as a clean "supersede" (not "repoint") so the resolver retires it rather
    // than hunting for moved files. Partial loss stays a repoint-or-supersede review.
    const apoptotic = missing.length === cited.length;
    signals.push({
      source: 'insight-staleness',
      key: insight.slug,
      // STABLE title (no counts) — the cross-tick search-first dedup matches on it.
      title: apoptotic
        ? `Agent insight '${insight.slug}' is obsolete — all cited files are gone (supersede)`
        : `Agent insight '${insight.slug}' cites files that no longer exist — review for superseded`,
      body: apoptotic
        ? `The active agent-insight runbook \`${insight.slug}\` cites repo file(s) that are ALL missing:\n` +
          missing.map((p) => `  - \`${p}\``).join('\n') +
          `\n\n(${missing.length} of ${cited.length} cited paths missing — every citation is gone.)\n` +
          `Its entire evidence base has been deleted or moved, so the guidance is almost certainly ` +
          `obsolete. Set frontmatter \`status: superseded\` (do NOT hunt for moved files) so it stops ` +
          `being injected into agent preludes.`
        : `The active agent-insight runbook \`${insight.slug}\` cites repo file(s) that are missing:\n` +
          missing.map((p) => `  - \`${p}\``).join('\n') +
          `\n\n(${missing.length} of ${cited.length} cited paths missing.)\n` +
          `Review the runbook: update the paths if the code moved, or set frontmatter ` +
          `\`status: superseded\` if the guidance no longer applies — a wrong runbook keeps ` +
          `being injected into agent preludes until this is done.`,
      severity: 'minor',
      kind: 'change',
      paths: [`apps/operator-docs/src/content/docs/agent-insights/${insight.slug}.mdx`],
      latestAt: new Date().toISOString(),
      // EI-427: suppress re-files for the deploy-propagation window after a
      // resolution (the scanned release tree lags the staging fix).
      resolutionCooldownMs,
    });
  }
  return signals;
}

/**
 * Tracked files at `root` incl. submodules, via `git ls-files` (cheap — git's
 * index is cached — and it excludes node_modules/.gitignore). Returns null when
 * git is unavailable (a packaged build) so the caller falls back to exact existsSync.
 */
async function listTrackedFiles(root: string): Promise<string[] | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['-C', root, 'ls-files', '--recurse-submodules'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = stdout.split('\n').filter(Boolean);
    return files.length ? files : null;
  } catch {
    return null;
  }
}

/** Thin fs glue — reads the agent-insights dir + checks cited paths against the repo tree. */
export async function collectInsightStalenessSignals(): Promise<WatchdogSignal[]> {
  // Lazy-import so the pure scan stays import-cheap for tests.
  const { DOCS_CONTENT_ROOT, REPO_ROOT } = await import('../../agent-tools/docs/_repo-paths');
  const dir = path.join(DOCS_CONTENT_ROOT, 'agent-insights');
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.mdx') || n.endsWith('.md'));
  } catch {
    return []; // docs tree absent (packaged build) → nothing to scan
  }
  const insights: InsightFileForScan[] = [];
  for (const name of names) {
    try {
      const raw = await fs.promises.readFile(path.join(dir, name), 'utf8');
      const statusMatch = raw.match(/^status:\s*["']?([\w-]+)["']?\s*$/m);
      const discoveredMatch = raw.match(/^discovered:\s*["']?([\d-]+)["']?\s*$/m);
      insights.push({
        slug: name.replace(/\.mdx?$/, ''),
        status: statusMatch?.[1] ?? 'active',
        discovered: discoveredMatch?.[1],
        raw,
      });
    } catch {
      /* unreadable file → skip */
    }
  }
  // Suffix-aware existence (EI-510): resolve a cited path against the repo's tracked
  // files so a dropped-prefix shorthand isn't a false "stale". Fall back to an exact
  // existsSync at REPO_ROOT when git is unavailable (packaged build).
  const tracked = await listTrackedFiles(REPO_ROOT);
  const existsFn = tracked
    ? makeRepoPathResolver(tracked)
    : (p: string) => fs.existsSync(path.join(REPO_ROOT, p));
  return scanInsightStaleness(insights, existsFn);
}
