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
  const signals: WatchdogSignal[] = [];
  for (const insight of insights) {
    if (signals.length >= maxSignals) break;
    const status = (insight.status || 'active').toLowerCase();
    if (status === 'retired' || status === 'superseded') continue;
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
