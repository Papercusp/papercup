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

export interface ScanOpts {
  /** Cap signals per sweep (the watchdog has its own per-tick cap on top). */
  maxSignals?: number;
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
  const signals: WatchdogSignal[] = [];
  for (const insight of insights) {
    if (signals.length >= maxSignals) break;
    const status = (insight.status || 'active').toLowerCase();
    if (status === 'retired' || status === 'superseded') continue;
    const cited = extractCitedPaths(insight.raw);
    if (cited.length === 0) continue;
    const missing = cited.filter((p) => !existsFn(p));
    if (missing.length === 0) continue;
    signals.push({
      source: 'insight-staleness',
      key: insight.slug,
      // STABLE title (no counts) — the cross-tick search-first dedup matches on it.
      title: `Agent insight '${insight.slug}' cites files that no longer exist — review for superseded`,
      body:
        `The active agent-insight runbook \`${insight.slug}\` cites repo file(s) that are missing:\n` +
        missing.map((p) => `  - \`${p}\``).join('\n') +
        `\n\n(${missing.length} of ${cited.length} cited paths missing.)\n` +
        `Review the runbook: update the paths if the code moved, or set frontmatter ` +
        `\`status: superseded\` if the guidance no longer applies — a wrong runbook keeps ` +
        `being injected into agent preludes until this is done.`,
      severity: 'minor',
      kind: 'change',
      paths: [`apps/operator-docs/src/content/docs/agent-insights/${insight.slug}.mdx`],
      latestAt: new Date().toISOString(),
    });
  }
  return signals;
}

/** Thin fs glue — reads the agent-insights dir + checks cited paths at REPO_ROOT. */
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
      insights.push({
        slug: name.replace(/\.mdx?$/, ''),
        status: statusMatch?.[1] ?? 'active',
        raw,
      });
    } catch {
      /* unreadable file → skip */
    }
  }
  return scanInsightStaleness(insights, (p) => fs.existsSync(path.join(REPO_ROOT, p)));
}
