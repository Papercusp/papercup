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
import { findShellSyntaxError } from './shell-syntax';
import { findConflictMarker } from './conflict-markers';
import { findTsParseError } from './ts-parse';
import { findNulBytes, autoFixNulBytes, nulByteScopeMatches } from './nul-bytes';

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

/** Shared exclusions — retired trees, vendored code, build output (mirror the lint scripts).
 *  Exported so sibling git-sync checks (e.g. the deletion-import guard, EI-17) can reuse the
 *  SAME exclusion set instead of a drifting duplicate. */
export const isExcludedPath = (f: string): boolean =>
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
 * The TypeScript PARSE detector — tracked .ts/.tsx (WI-6683). The GENERAL form of
 * the hard-parse-failure class `smart-quotes` above catches one narrow instance
 * of: a curly quote in code position is only one way to stop a file parsing, and
 * the invariant worth enforcing at this seam is the general one — *a file that
 * does not parse must not reach the shared tree*.
 *
 * Earned by two live instances on 2026-08-01: sibling projection modules were
 * auto-committed with a backtick inside a SQL comment inside a `sql` template,
 * which closed the template and left the rest of each module unparseable. Unlike
 * a type error that is baselined and local, a PARSE error takes down every
 * consumer of the package — repairing one file moved operator-core's tsc count
 * 231 → 184, those ~47 being other agents' files that could no longer resolve
 * through it. A narrow lint for that exact spelling already existed and was green
 * throughout, because nothing ran it on the path where the damage happens.
 *
 * SYNTACTIC ONLY (see ts-parse.ts): a pure `createSourceFile` parse, so it can
 * never flag a type error, an unresolved import, or a missing dependency. Runs at
 * ~0.85ms/file with zero false positives over all 10,829 tracked .ts/.tsx files
 * in this repo. No `autoFix` — like shell-syntax and conflict-markers, a parse
 * break needs a human/LLM to decide the intended code; the goal here is
 * quarantine-before-commit, not guessing at someone's unfinished edit.
 */
export const tsParseDetector: ContentDetector = {
  key: 'ts-parse',
  glob: '**/*.{ts,tsx}',
  matches: (f) => /\.(ts|tsx)$/.test(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findTsParseError(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    return (
      `TypeScript parse error at ${at} (TS${hit.code}): ${hit.reason} — the file does not PARSE, ` +
      'so every consumer of this package hard-fails to typecheck, not just this file'
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The shell syntax detector — tracked `.sh` scripts (EI-13192). A real `bash -n`
 * parse, not a regex heuristic — catches a corrupted/truncated shell script (a
 * concurrent shared-tree edit interleave duplicated ~475 lines of one and
 * git-sync committed it before anyone ran `bash -n` by hand) BEFORE it ever
 * reaches `staging`, the same way the mdx/smart-quotes detectors already catch
 * their own hard-parse-failure classes. No deterministic `autoFix` — a
 * corrupted script needs a human/LLM to decide which duplicated block is
 * correct, so this always quarantines + dispatches the content-fixer.
 */
export const shellSyntaxDetector: ContentDetector = {
  key: 'shell-syntax',
  glob: '**/*.sh',
  matches: (f) => f.endsWith('.sh') && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findShellSyntaxError(text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}` : 'unknown position';
    return `bash -n syntax error at ${at}: ${hit.reason}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The committed-conflict-marker detector (EI-1836 / EI-18217568076594579) — a
 * COMMITTED git conflict marker (`<<<<<<<`, `>>>>>>>`, `|||||||` at line start)
 * is a hard, language-agnostic build breaker (a stray "Stashed" token froze the
 * whole fleet's SPA + desktop-sidecar + green-checkpoint builds for ~27min, twice).
 * Scoped to EVERY tracked file (mirrors check-conflict-markers.mjs's tree-wide
 * scan) rather than one extension, since a conflict marker can land in any file
 * type. No `autoFix` — like shell-syntax, a real conflict needs a human/LLM to
 * pick the correct side; the goal here is quarantine-before-commit, not silent
 * auto-resolution of someone's merge.
 */
export const conflictMarkersDetector: ContentDetector = {
  key: 'conflict-markers',
  glob: '**/*',
  matches: (f) => !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findConflictMarker(file, text);
    if (!hit) return null;
    return `committed git conflict marker at line ${hit.line} (${hit.marker.slice(0, 1)}×7): ${hit.text.slice(0, 80)}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The raw-NUL-byte detector (EI-19393386475030577) — tracked text sources
 * (check-no-nul-in-source.mjs + app/_lints/no-nul-bytes.test.ts).
 *
 * The check already existed and was already tree-wide; its only FIRING POINT was
 * the green-checkpoint suite, ~55min downstream, which converts one author's
 * typo into a fleet-wide gate red every time (measured 2026-08-03: ~1h of the
 * whole fleet blocked, six prior instances in the class header). Registering it
 * here moves detection onto the path every edit takes, ~3min after the write.
 *
 * ⚠ Deliberately does NOT apply `isExcludedPath`, unlike every sibling above.
 * Both the CI script and the gate lint scan `_retired/` (their scope is
 * `git ls-files --recurse-submodules` filtered by extension + fixture dirs, with
 * no retired-tree exclusion). Excluding it here would let a NUL under
 * `_retired/` slip past the guard and still red the shared gate — the exact
 * failure this entry exists to prevent. `matches` mirrors the lint's scope, and
 * that scope is the authority (D-003); node_modules/dist need no exclusion
 * because the guard only ever sees `git status` paths, which are gitignored.
 *
 * Carries an `autoFix` (unlike ts-parse/shell-syntax) because the repair is a
 * pure re-spelling with no semantic choice: `\x00` and a raw NUL are the
 * byte-identical runtime string. It must auto-repair, because this is the one
 * class the agent Edit tool cannot fix — Read renders a NUL as a space, so
 * `old_string` never matches and instances sit unrepaired.
 */
export const nulBytesDetector: ContentDetector = {
  key: 'nul-bytes',
  glob: '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,mdx,css,sql,sh,yml,yaml,toml}',
  matches: nulByteScopeMatches,
  detect: (file, text) => {
    const hit = findNulBytes(text);
    if (!hit) return null;
    const plural = hit.lines.length === 1 ? '' : 's';
    return (
      `literal NUL byte (0x00) ×${hit.count} at line${plural} ${hit.lines.join(', ')} — ` +
      'makes file(1) report this valid UTF-8 source as BINARY and makes grep refuse to search it, ' +
      'while tsc/esbuild still compile it (so it is invisible until the shared gate reds). ' +
      'Almost always a composite map key: write `${a}\\x00${b}` (escape) instead of a raw NUL byte.'
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
  autoFix: autoFixNulBytes,
};

/**
 * The default registry the git-sync content guard runs with. Extend by adding an
 * entry (a new `{ key, glob, matches, detect, fixerRole }`); the guard + escalation
 * + fixer dispatch pick it up with no further change.
 */
export const DEFAULT_CONTENT_DETECTORS: ContentDetector[] = [
  mdxDetector,
  smartQuotesDetector,
  nulBytesDetector,
  // Ordered AFTER smart-quotes deliberately: a curly-quote-as-code file trips both
  // (it is a parse error), and smart-quotes names the exact offending character —
  // the more actionable message, recorded first. Both offenders point at the same
  // file and `excludePaths` dedupes by path, so the file is quarantined once.
  tsParseDetector,
  shellSyntaxDetector,
  conflictMarkersDetector,
];
