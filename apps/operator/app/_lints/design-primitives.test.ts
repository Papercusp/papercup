/**
 * Design primitive lint — guards the enforceable parts of /internal/docs/design.
 *
 * Every rule scans CODE, never comments (see `stripComments`). A file that
 * *documents* a banned primitive — "no native <select>/<table> here", "replaced the
 * native <table> that redded this lint" — is not using one, and must not be flagged
 * for saying so. That false positive is not hypothetical: it seeded four of the
 * allowlist entries this file used to carry (ToolUsagePanel, AdvOverviewTab,
 * Select.tsx, Checkbox.tsx — none of which contained the primitive they were
 * allowlisted for) and it re-fires the moment an author explains their migration in
 * a comment. Blanking comments before matching kills the whole class
 * (design-simplification-2026-07-09 P-009).
 *
 * What remains are explicit allowlists for files that genuinely contain a native
 * primitive: the shared wrapper implementations. They shrink as the design-spec
 * compliance plan migrates each active surface; a NEW off-system primitive is
 * blocked immediately.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');
const APPS_ROOT = resolve(OPERATOR_ROOT, '..');

const SOURCE_DIRS = [
  join(OPERATOR_ROOT, 'app'),
  join(APPS_ROOT, 'operator-vite/src'),
];

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  'test-results',
  'operator-mock',
]);

const SOURCE_FILE_RE = /\.(?:tsx|ts|css)$/;
const TEST_FILE_RE = /(?:\.test|\.spec)\.tsx?$/;

// ── Allowlists ────────────────────────────────────────────────────────────────
// P-009 (design-simplification-2026-07-09) burned these down to the ONE file that
// genuinely contains a native primitive: the shared <table> wrapper. Of the six
// entries removed, three were never offenders at all — ToolUsagePanel, AdvOverviewTab
// and Select.tsx merely MENTION a native primitive in a doc comment (so did
// Checkbox.tsx) — and the rest were migrated onto the primitive here.
//
// Keep them empty. An allowlist entry is a promise to migrate, and a promise nobody
// tracks is just a permanently-disabled lint.

/** The Radix wrapper owns no native control, so no file may declare a native <select>. */
const NATIVE_SELECT_ALLOWED_FILES = new Set<string>();

/** Same: harness/Checkbox.tsx is a Radix wrapper, not a native <input type=checkbox>. */
const NATIVE_CHECKBOX_ALLOWED_FILES = new Set<string>();

const NATIVE_TABLE_ALLOWED_FILES = new Set<string>([
  // The one legitimate native <table>/<thead>/<tbody> (WI-3561, 2026-07-09): the shared
  // primitive wraps it ONCE so no app UI has to hand-roll one.
  'operator/app/harness/Table.tsx',
]);

/** The confirm primitive is a modal — no file, not even its own, calls native confirm(). */
const NATIVE_CONFIRM_ALLOWED_FILES = new Set<string>();

const BUTTON_TITLE_ALLOWED_FILES = new Set<string>();
const LINK_TITLE_ALLOWED_FILES = new Set<string>();
const TAB_TITLE_ALLOWED_FILES = new Set<string>();

const AUDITED_DIRECT_CYAN_FILES = [
  'operator-vite/src/components/left-sidebar/left-sidebar.styles.ts',
  'operator-vite/src/components/admin/AdminShell.tsx',
  'operator-vite/src/components/admin/RecipesClient.tsx',
  'operator-vite/src/components/adv/DemandPanel.tsx',
  'operator-vite/src/components/adv/ExperimentsPanel.tsx',
  'operator-vite/src/components/adv/LearningTab.tsx',
  'operator-vite/src/components/adv/AdvOverviewTab.tsx',
  'operator-vite/src/components/adv/AdvShell.tsx',
  'operator/app/adv/harnesses/AdvDocsTab.tsx',
  'operator/app/adv/harnesses/AdvGitGraphPanel.tsx',
  // Theme-contract sweep P-006 (design-simplification-2026-07-09): migrated to
  // rgb(from var(--accent-strong)…) / var(--accent…) forms — keep them clean.
  'operator/app/admin/features/FeaturesAdmin.tsx',
  'operator-vite/src/components/adv/AdvConversationsTab.tsx',
  'operator-vite/src/components/adv/FrameVncView.tsx',
  'operator/app/installed/plugins/page.tsx',
  'operator/app/harness/TrustBadge.tsx',
  'operator/app/harness/PrsTab.tsx',
  'operator/app/harness/theme.ts',
  'operator/app/eval-viz/MastBreakdown.tsx',
  'operator/app/eval-viz/arms.ts',
  'operator-vite/src/components/adv/AdvEvalsTab.tsx',
  'operator/app/_components/ChatwootWidget.tsx',
  // OracleDock retired 2026-07-09 → _retired/legacy-web-chats/ (P-003).
  'operator/app/globals.css',
  'operator/app/harness/harness.css',
  'operator/app/operator-mock/page.tsx',
  'operator/app/dev/dev.css',
  'operator/app/dev/swarm-identity/swarm-identity.module.css',
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_FILE_RE.test(full) && !TEST_FILE_RE.test(full)) {
      out.push(full);
    }
  }
}

/**
 * Blank the CONTENT of comments, preserving every newline and byte offset so the
 * `line = content.slice(0, index).split('\n').length` arithmetic below stays exact.
 *
 * Only blanks text that CANNOT be code: a block comment that opens at the start of a
 * line (optionally behind a JSX `{`), and a line whose first non-space characters are
 * `//`. That deliberately leaves trailing `code(); // comment` alone — the conservative
 * choice, since a mid-line `/*` may live inside a string (a glob like '**\/*.tsx') and
 * blanking from there would hide real code. An unterminated block comment is left
 * untouched rather than blanked to EOF.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let atLineStart = true;
  let seenBrace = false;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      atLineStart = true;
      seenBrace = false;
      i += 1;
      continue;
    }
    if (atLineStart && (c === ' ' || c === '\t' || c === '\r')) {
      i += 1;
      continue;
    }
    if (atLineStart && c === '{' && !seenBrace) {
      seenBrace = true; // JSX comment: {/* … */}
      i += 1;
      continue;
    }
    if (atLineStart && c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close === -1) break; // unterminated — leave the remainder alone
      for (let k = i; k < close + 2; k += 1) {
        if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
      }
      i = close + 2;
      atLineStart = false;
      continue;
    }
    if (atLineStart && c === '/' && src[i + 1] === '/') {
      let k = i;
      while (k < n && src[k] !== '\n') k += 1;
      for (let j = i; j < k; j += 1) out[j] = ' ';
      i = k;
      continue;
    }
    atLineStart = false;
    i += 1;
  }
  return out.join('');
}

let fileListCache: string[] | null = null;

function collectFiles(): string[] {
  if (fileListCache) return fileListCache;
  const files: string[] = [];
  for (const sourceDir of SOURCE_DIRS) {
    walk(sourceDir, files);
  }
  fileListCache = files.sort();
  return fileListCache;
}

/** Comment-stripped file contents, memoized — every rule re-walks the same tree. */
const codeCache = new Map<string, string>();

function readCode(file: string): string {
  let code = codeCache.get(file);
  if (code === undefined) {
    code = stripComments(readFileSync(file, 'utf-8'));
    codeCache.set(file, code);
  }
  return code;
}

function rel(file: string): string {
  return relative(APPS_ROOT, file);
}

/**
 * `.test()` on a /g regex is STATEFUL — it advances `lastIndex` on a match, so the
 * next call resumes mid-string and silently misses that file's offence. Six rules
 * route through here, so a single shared /g pattern under-reported roughly every
 * other offender. Always match against a fresh, non-global clone.
 */
export function matchesAnywhere(pattern: RegExp, content: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace(/g/g, '')).test(content);
}

function unexpectedFiles(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles()) {
    if (!matchesAnywhere(pattern, readCode(file))) continue;
    const path = rel(file);
    if (!allowed.has(path)) offenders.push(path);
  }
  return offenders;
}

function unexpectedNativeConfirmFiles(): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles()) {
    const content = readCode(file);
    const hasNativeConfirm =
      /window\.confirm\s*\(/.test(content) ||
      (/\bconfirm\s*\(/.test(content) && !/useConfirmDialog/.test(content));
    if (!hasNativeConfirm) continue;
    const path = rel(file);
    if (!NATIVE_CONFIRM_ALLOWED_FILES.has(path)) offenders.push(path);
  }
  return offenders;
}

function unexpectedNativeCheckboxFiles(): string[] {
  const offenders: string[] = [];
  const pattern = /<input\b[^>]*\btype=["']checkbox["'][^>]*>/gs;
  for (const file of collectFiles()) {
    const matches = [...readCode(file).matchAll(pattern)];
    const hasNativeCheckbox = matches.some((match) => !/\brole=["']switch["']/.test(match[0]));
    if (!hasNativeCheckbox) continue;
    const path = rel(file);
    if (!NATIVE_CHECKBOX_ALLOWED_FILES.has(path)) offenders.push(path);
  }
  return offenders;
}

function collectPatternMatches(pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles()) {
    const content = readCode(file);
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${rel(file)}:${line}: ${match[0].trim()}`);
    }
  }
  return offenders;
}

function unexpectedCoordUtilityClasses(): string[] {
  const offenders: string[] = [];
  const coordDir = join(OPERATOR_ROOT, 'app/coord');
  const files: string[] = [];
  walk(coordDir, files);
  const utilityClassRe =
    /className=\{?["'`](?=[^"'`]*(?:\b(?:mx-auto|max-w-|p-|px-|py-|mb-|mt-|space-y-|gap-|flex|grid|items-|justify-|rounded|border-|bg-|text-|font-|opacity-|overflow-|min-w-|w-|h-|shrink-|truncate|uppercase|tracking-)\b))[^"'`]+["'`]\}?/g;
  for (const file of files) {
    if (!file.endsWith('.tsx')) continue;
    const content = readCode(file);
    const matches = [...content.matchAll(utilityClassRe)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${rel(file)}:${line}: ${match[0].trim()}`);
    }
  }
  return offenders;
}

function unexpectedNonzeroLetterSpacingUnder(root: string): string[] {
  const offenders: string[] = [];
  const files: string[] = [];
  try {
    const st = statSync(root);
    if (st.isDirectory()) {
      walk(root, files);
    } else if (SOURCE_FILE_RE.test(root) && !TEST_FILE_RE.test(root)) {
      files.push(root);
    }
  } catch {
    return offenders;
  }
  const nonzeroLetterSpacingRe =
    /\b(?:letter-spacing|letterSpacing)\s*:\s*(?:['"])?(?!0(?:\s*(?:[;,'"}]|!important)|\s*$))[0-9.]+(?:em|px|rem)?(?:['"])?/gm;
  for (const file of files) {
    const content = readCode(file);
    const matches = [...content.matchAll(nonzeroLetterSpacingRe)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${rel(file)}:${line}: ${match[0].trim()}`);
    }
  }
  return offenders;
}

function unexpectedNonzeroLetterSpacingUnderAny(roots: string[]): string[] {
  return roots.flatMap((root) => unexpectedNonzeroLetterSpacingUnder(root));
}

function isGeneratedTokenStylesheet(path: string): boolean {
  return /^operator\/app\/_(?:brand-primitives|semantic(?:\.[^.]+)?)\.css$/.test(path);
}

function unexpectedSkyPrimitiveReferences(): string[] {
  const offenders: string[] = [];
  const skyPrimitiveRe = /var\(--sky-[^)]+\)/g;
  for (const file of collectFiles()) {
    const path = rel(file);
    if (isGeneratedTokenStylesheet(path)) continue;
    const content = readCode(file);
    const matches = [...content.matchAll(skyPrimitiveRe)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${path}:${line}: ${match[0]}`);
    }
  }
  return offenders;
}

// Central home for status/severity/kind color tables — the ONE place a
// STATUS_*/SEVERITY_*/KIND_* color/tone map may live (design-simplification
// P-005). Components extend theme.ts (TONE + statusToneColor, or the
// StatusMeta tables) instead of declaring a local map.
const STATUS_MAP_CENTRAL_FILES = new Set<string>([
  'operator/app/harness/theme.ts',
]);

function unexpectedLocalStatusColorMaps(): string[] {
  const offenders: string[] = [];
  const statusMapRe = /\bconst\s+[A-Z0-9_]*(?:STATUS|SEVERITY|KIND)_[A-Z0-9_]*(?:COLOR|TONE)S?\b/g;
  for (const file of collectFiles()) {
    const path = rel(file);
    if (STATUS_MAP_CENTRAL_FILES.has(path)) continue;
    const content = readCode(file);
    const matches = [...content.matchAll(statusMapRe)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${path}:${line}: ${match[0].trim()}`);
    }
  }
  return offenders;
}

function unexpectedDirectCyanLiteralsInAuditedFiles(): string[] {
  const offenders: string[] = [];
  // All six brand-adjacent cyan/sky shades (P-006f): cyan-400/300, sky-500/400/300/200
  // — hex and rgba-triplet forms. Lines carrying var( are skipped (token fallbacks).
  const cyanLiteralRe =
    /#(?:22d3ee|67e8f9|0ea5e9|38bdf8|7dd3fc|bae6fd)|rgba\(\s*(?:34\s*,\s*211\s*,\s*238|103\s*,\s*232\s*,\s*249|14\s*,\s*165\s*,\s*233|56\s*,\s*189\s*,\s*248|125\s*,\s*211\s*,\s*252|186\s*,\s*230\s*,\s*253)\s*,\s*[^)]+\)/g;
  for (const path of AUDITED_DIRECT_CYAN_FILES) {
    const file = join(APPS_ROOT, path);
    let content: string;
    try {
      content = stripComments(readFileSync(file, 'utf-8'));
    } catch {
      offenders.push(`${path}: missing audited file`);
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes('var(')) continue;
      const matches = [...line.matchAll(cyanLiteralRe)];
      for (const match of matches) {
        offenders.push(`${path}:${i + 1}: ${match[0]}`);
      }
    }
  }
  return offenders;
}

/**
 * Warn-first lint rollout (catch-test-lags-migration-at-the-author #4, Part B).
 *
 * Every design-lint check routes its offenders through this ONE enforcement decision
 * point. A NEW rule lands `enforce: false` first: it LOGS offenders loudly (so authors
 * see drift accumulate and seed the allowlist) but PASSES the suite — so introducing a
 * rule doesn't instantly red the whole fleet's green gate the moment one un-migrated
 * file exists. Once the allowlist is seeded, flip the rule to `enforce: true` and it
 * hard-fails on any new offender — exactly the behavior every rule below ships with
 * today (the currently-enforced rules are unchanged: they all pass `enforce: true`).
 *
 * The flip from warn → error is the FINAL step of landing a rule, not a "someday":
 * a rule left `enforce: false` forever is a lint that does nothing.
 */
function warnOrFail(
  label: string,
  offenders: string[],
  opts: { enforce: boolean; hint?: string },
): void {
  const hint =
    opts.hint ??
    'Use the shared Papercusp design primitive, or add a temporary allowlist entry with a plan item reference.';

  if (offenders.length === 0) {
    expect(offenders).toHaveLength(0);
    return;
  }

  if (!opts.enforce) {
    // WARN-ONLY: log loudly, do NOT fail. Lets a new rule's offenders surface and be
    // allowlisted before the rule is flipped to enforce:true. Writes to stdout directly:
    // the suite runs under vitest-fail-on-console, so a console.warn here would turn
    // the warn-only path into a hard failure — defeating warn-first entirely.
    process.stdout.write(
      `⚠️  [design-lint WARN-ONLY, not yet enforced] ${label} found in ${offenders.length} file(s):\n` +
        `${offenders.map((f) => `  ${f}`).join('\n')}\n` +
        `${hint}\n` +
        `(This rule is in warn-only mode — seed its allowlist, then flip enforce:true.)\n`,
    );
    return;
  }

  throw new Error(`${label} found in unapproved files:\n${offenders.map((f) => `  ${f}`).join('\n')}\n\n${hint}`);
}

/** Enforced wrapper — the default for every currently-active rule (enforce:true). */
function expectNoUnexpected(label: string, offenders: string[]): void {
  warnOrFail(label, offenders, { enforce: true });
}

describe('design primitive lint', () => {
  it('blocks new native <select> controls in app UI', () => {
    expectNoUnexpected('Native <select>', unexpectedFiles(/<select\b/g, NATIVE_SELECT_ALLOWED_FILES));
  });

  it('blocks new native <table> layouts in app UI', () => {
    expectNoUnexpected('Native <table>', unexpectedFiles(/<table\b/g, NATIVE_TABLE_ALLOWED_FILES));
  });

  it('blocks direct confirm usage outside the shared confirm primitive and legacy baseline', () => {
    expectNoUnexpected('Direct confirm', unexpectedNativeConfirmFiles());
  });

  it('blocks native radio inputs in app UI', () => {
    expectNoUnexpected('Native radio input', unexpectedFiles(/<input\b[^>]*\btype=["']radio["']/g, new Set()));
  });

  it('blocks native checkbox inputs outside the shared checkbox primitive', () => {
    expectNoUnexpected(
      'Native checkbox input',
      unexpectedNativeCheckboxFiles(),
    );
  });

  it('blocks title-only tooltips on buttons', () => {
    expectNoUnexpected(
      'Button title tooltip',
      unexpectedFiles(/<button\b(?:=>|[^>])*\btitle=/g, BUTTON_TITLE_ALLOWED_FILES),
    );
  });

  it('blocks title-only tooltips on links', () => {
    expectNoUnexpected(
      'Link title tooltip',
      unexpectedFiles(/<(?:a\b|RouteLink\b)(?:=>|[^>])*\btitle=/g, LINK_TITLE_ALLOWED_FILES),
    );
  });

  it('blocks title-only tooltips on tab controls', () => {
    expectNoUnexpected(
      'Tab title tooltip',
      unexpectedFiles(/\brole=["']tab["'](?:=>|[^>])*\btitle=/g, TAB_TITLE_ALLOWED_FILES),
    );
  });

  const TYPE_HINT = 'Follow /internal/docs/design: use stable type sizes and letter-spacing: 0.';

  it('blocks negative letter spacing in app UI', () => {
    warnOrFail(
      'Negative letter-spacing',
      collectPatternMatches(/\b(?:letter-spacing|letterSpacing)\s*:\s*(?:['"])?-[0-9.]+em(?:['"])?/g),
      { enforce: true, hint: TYPE_HINT },
    );
  });

  it('blocks viewport-relative font sizing in app UI', () => {
    warnOrFail(
      'Viewport-relative font size',
      collectPatternMatches(/\b(?:font-size|fontSize)\s*:\s*(?:['"])?[^;'",}]*(?:vw|vh|vmin|vmax)[^;'",}]*(?:['"])?/g),
      { enforce: true, hint: TYPE_HINT },
    );
  });

  it('keeps /coord on tokenized CSS classes instead of Tailwind utility strings', () => {
    expectNoUnexpected('Tailwind-style utility class strings in /coord', unexpectedCoordUtilityClasses());
  });

  it('blocks nonzero letter spacing in app UI', () => {
    expectNoUnexpected(
      'Nonzero letter-spacing',
      unexpectedNonzeroLetterSpacingUnderAny(SOURCE_DIRS),
    );
  });

  it('blocks direct sky brand primitives outside generated token stylesheets', () => {
    expectNoUnexpected('Sky brand primitive references', unexpectedSkyPrimitiveReferences());
  });

  it('keeps audited active surfaces free of direct cyan literals', () => {
    expectNoUnexpected('Direct cyan literals', unexpectedDirectCyanLiteralsInAuditedFiles());
  });

  it('keeps status/severity/kind color maps in the central theme tables', () => {
    warnOrFail(
      'Component-local status/kind color map',
      unexpectedLocalStatusColorMaps(),
      {
        enforce: true,
        hint:
          'Status/severity/kind colors single-source from operator/app/harness/theme.ts ' +
          '(TONE + statusToneColor for one-color lookups; STATUS/SEVERITY/ISSUE_STATUS/' +
          'WORK_ITEM_KIND/AGENT_KIND for pill sets) — extend the central table instead of ' +
          'declaring a local map. (design-simplification-2026-07-09 P-005)',
      },
    );
  });
});

// ── Warn-first lint rollout (catch-test-lags-migration-at-the-author #4, Part B) ───────
// Pins the contract a new design-lint rule relies on to land WITHOUT instantly redding
// the fleet's gate: enforce:false logs offenders but passes; enforce:true hard-fails.
describe('warnOrFail (warn-first lint rollout)', () => {
  const OFFENDERS = ['operator/app/foo.tsx:12: <select>', 'operator/app/bar.tsx:3: <select>'];

  it('passes (never throws) for an empty offender list, regardless of enforce', () => {
    expect(() => warnOrFail('Empty', [], { enforce: true })).not.toThrow();
    expect(() => warnOrFail('Empty', [], { enforce: false })).not.toThrow();
  });

  it('WARN-ONLY (enforce:false): logs offenders loudly but does NOT fail the suite', () => {
    // The warn path writes to stdout, NOT console.warn — the suite runs under
    // vitest-fail-on-console, where a console.warn would hard-fail the test and
    // silently defeat warn-first.
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(() => warnOrFail('New native select', OFFENDERS, { enforce: false })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    const logged = writes.join('\n');
    expect(logged).toMatch(/WARN-ONLY/);
    expect(logged).toMatch(/New native select/);
    // Every offender is surfaced so the author can seed the allowlist before flipping.
    for (const o of OFFENDERS) expect(logged).toContain(o);
  });

  it('ENFORCED (enforce:true): throws with the offenders listed', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(() => warnOrFail('New native select', OFFENDERS, { enforce: true })).toThrow(/New native select/);
      // Enforced mode must NOT route through the warn-only logger.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('uses a custom hint when supplied', () => {
    expect(() =>
      warnOrFail('Custom', ['x:1: y'], { enforce: true, hint: 'SEE THE DESIGN DOC.' }),
    ).toThrow(/SEE THE DESIGN DOC\./);
  });
});

// ── The two scanner bugs P-009 fixed (both silent, in opposite directions) ────────
describe('matchesAnywhere (the /g statefulness bug)', () => {
  it('does not carry lastIndex between calls, so a real offender is never skipped', () => {
    const shared = /<table\b/g;
    // The naive `shared.test(x)` this replaced returns false for the SECOND string,
    // because matching the first left lastIndex past the start of the second.
    expect(shared.test('a <table> in a comment')).toBe(true);
    expect(shared.test('<table className="real">')).toBe(false); // ← the old bug

    expect(matchesAnywhere(/<table\b/g, 'a <table> in a comment')).toBe(true);
    expect(matchesAnywhere(/<table\b/g, '<table className="real">')).toBe(true);
  });

  it('honours non-g flags (case sensitivity is load-bearing: <Select/> is not <select>)', () => {
    expect(matchesAnywhere(/<select\b/g, '<Select value={x} />')).toBe(false);
    expect(matchesAnywhere(/<select\b/gi, '<Select value={x} />')).toBe(true);
  });
});

describe('stripComments (the comment false-positive bug)', () => {
  const lines = (s: string) => s.split('\n');

  it('blanks a leading block comment but preserves line numbers and offsets', () => {
    const src = ['/**', ' * no native <select> here', ' */', 'const a = 1;'].join('\n');
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(lines(out)).toHaveLength(4);
    expect(out).not.toMatch(/<select/);
    expect(lines(out)[3]).toBe('const a = 1;');
  });

  it('blanks a JSX {/* … */} comment', () => {
    const src = ['<div>', '  {/* a <table> lives here */}', '</div>'].join('\n');
    expect(stripComments(src)).not.toMatch(/<table/);
  });

  it('blanks a whole-line // comment', () => {
    const src = ['// title= on a button is banned', 'const b = 2;'].join('\n');
    const out = stripComments(src);
    expect(out).not.toMatch(/title=/);
    expect(lines(out)[1]).toBe('const b = 2;');
  });

  it('KEEPS real code — a native primitive is still found', () => {
    const src = ['/** docs mentioning <table> */', '<table className="real">'].join('\n');
    const out = stripComments(src);
    expect(matchesAnywhere(/<table\b/g, out)).toBe(true);
    expect(out.indexOf('<table')).toBe(out.lastIndexOf('<table')); // exactly one survives
  });

  it('never blanks a mid-line /* — it may be a glob inside a string', () => {
    const src = "const g = 'apps/**/*.tsx'; // note\nconst t = <table/>;";
    const out = stripComments(src);
    // The glob's `/*` must not open a comment that swallows the <table> below it.
    expect(matchesAnywhere(/<table\b/g, out)).toBe(true);
  });

  it('leaves an unterminated block comment alone rather than blanking to EOF', () => {
    const src = ['/* never closed', 'const c = 3;'].join('\n');
    expect(stripComments(src)).toBe(src);
  });
});
