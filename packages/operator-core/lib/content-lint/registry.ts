/**
 * The content-detector REGISTRY (git-sync-content-guard-2026-06-13 P-003).
 *
 * One list of `{ key, glob, matches, detect, fixerRole }` consumed by the
 * git-sync content guard (run-git-sync.ts) — and extensible: a future content
 * check rides this same mechanism by adding one entry, no guard change.
 *
 * Each detector wraps a PURE detector function (the same one the CI lint scripts
 * call — D-003) and normalises its result to a single human-readable error
 * string (fed to the escalation + the content-fixer agent) or null when valid.
 * The `matches` predicate mirrors each CI lint's EXACT scope so the guard never
 * quarantines a file the lint wouldn't flag (and vice-versa).
 */
import { findMdxCompileError, autoFixMdxAngles } from './mdx';
import { findCodePositionCurlyQuotes, curlyLabel } from './smart-quotes';

/** A registered content check. */
export interface ContentDetector {
  /** Stable key — recorded on offender records + escalation bodies (e.g. 'mdx'). */
  key: string;
  /** The glob the detector targets, for registry display / docs (the authoritative
   *  scope is `matches`, which also encodes the lint's prefix + exclusions). */
  glob: string;
  /** Whether this detector applies to a repo-relative path — mirrors the CI lint's
   *  EXACT scope so the guard + CI never disagree (D-003). */
  matches: (file: string) => boolean;
  /** Run the check on the file's text. Returns a human-readable error string when
   *  the file is broken, or null when it is valid. May be async (MDX compiles). */
  detect: (file: string, text: string) => Promise<string | null> | string | null;
  /** The agent role git-sync dispatches to fix this class of content error. */
  fixerRole: string;
  /**
   * Optional DETERMINISTIC repair (WI-276), applied by the git-sync content guard
   * as a pre-pass BEFORE quarantining + dispatching the LLM `fixerRole`. The guard
   * invokes it ONLY on a file that already failed `detect`, then RE-RUNS `detect`
   * on the result: if the repair makes the file clean it is written back so it
   * commits on this tick (no LLM, no human, no 5-tick build block); if it does not
   * fully resolve the error the file is quarantined for the LLM fixer exactly as
   * before. Must be PURE + idempotent (given the same text twice it returns the
   * same fix). Omit for detectors with no safe deterministic repair (smart-quotes).
   */
  autoFix?: (text: string) => { fixed: string; changed: boolean };
}

/** Shared exclusions — retired trees, vendored code, build output (mirror the lint scripts). */
const isExcludedPath = (f: string): boolean =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/');

/** The astro-built docs set — exactly what `astro build` compiles (mirror check-mdx.mjs). */
const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

export const CONTENT_FIXER_ROLE = 'content-fixer';

/** The MDX compile detector — scoped to the astro-built docs set (check-mdx.mjs). */
export const mdxDetector: ContentDetector = {
  key: 'mdx',
  glob: `${DOCS_PREFIX}**/*.mdx`,
  matches: (f) => f.endsWith('.mdx') && f.startsWith(DOCS_PREFIX) && !isExcludedPath(f),
  detect: async (file, text) => {
    const hit = await findMdxCompileError(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    return `MDX compile error at ${at}: ${hit.reason}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
  // WI-276: the deterministic pre-pass — escape a bare `<`+digit / `<word>` placeholder
  // (the single most common MDX offender) so the guard auto-repairs + commits it this tick
  // instead of quarantining it for 5 ticks. Applied only to an already-failing file, then
  // the guard re-runs `detect`; anything still broken falls through to the LLM fixer.
  autoFix: autoFixMdxAngles,
};

/** The curly-quote-as-code detector — tracked .ts/.tsx (check-smart-quotes.mjs). */
export const smartQuotesDetector: ContentDetector = {
  key: 'smart-quotes',
  glob: '**/*.{ts,tsx}',
  matches: (f) => /\.(ts|tsx)$/.test(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hits = findCodePositionCurlyQuotes(file, text);
    if (hits.length === 0) return null;
    return (
      'curly/smart quote used as code (hard esbuild/tsc parse failure): ' +
      hits.map((h) => `${h.line}:${h.col} [${curlyLabel(h.ch)}]`).join('; ')
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The default registry the git-sync content guard runs with. Extend by adding an
 * entry (a new `{ key, glob, matches, detect, fixerRole }`); the guard + escalation
 * + fixer dispatch pick it up with no further change.
 */
export const DEFAULT_CONTENT_DETECTORS: ContentDetector[] = [mdxDetector, smartQuotesDetector];
