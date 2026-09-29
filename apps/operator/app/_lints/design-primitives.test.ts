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

// The banned-letter-spacing matcher lives in a plain .mjs so the edit-time nudge hook
// (which runs under bare `node`, detached from any TS loader) can import the SAME
// definition instead of forking the regex. See letter-spacing-pattern.mjs for why that
// mattered: hud.css red-pinned the fleet 3x on this one rule, and prose comments in the
// file failed to prevent the 3rd.
import { nonzeroLetterSpacingRe as makeNonzeroLetterSpacingRe } from './letter-spacing-pattern.mjs';
import { buttonTitleTooltipRe as makeButtonTitleTooltipRe } from './title-only-tooltip-pattern.mjs';

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
const NATIVE_CHECKBOX_ALLOWED_FILES = new Set<string>([
  // Owner-approved native accent checkbox (owner-hit 2026-07-11 r3 — see the
  // in-file comment at AgentsRunningPill's roster row): the shared Radix
  // primitive's <button>+svg restyle never matched the approved native mockup;
  // a native <input type=checkbox> with accent-color IS the native accent look,
  // drawn by the Tauri/WebKitGTK webview itself. Deliberate, not unmigrated.
  'operator-vite/src/components/adv/AgentsRunningPill.tsx',
]);

const NATIVE_TABLE_ALLOWED_FILES = new Set<string>([
  // The one legitimate native <table>/<thead>/<tbody> (WI-3561, 2026-07-09): the shared
  // primitive wraps it ONCE so no app UI has to hand-roll one.
  'operator/app/harness/Table.tsx',
  // TEMPORARY (learning-tab-visibility-2026-07-18 P-003/P-004): the frontier
  // lane-status grid shipped with a hand-rolled <table>; migrate it to the shared
  // Table primitive as part of that plan's cleanup, then remove this entry.
  'operator-vite/src/components/adv/FrontierPanel.tsx',
]);

/** The confirm primitive is a modal — no file, not even its own, calls native confirm(). */
const NATIVE_CONFIRM_ALLOWED_FILES = new Set<string>();

const BUTTON_TITLE_ALLOWED_FILES = new Set<string>([
  // WI-4059 / EI-9449: native title= on resume-terminal-btn is deliberate, not an
  // unmigrated tooltip. A Radix <Tooltip label={...}> whose label toggles
  // falsy<->truthy AFTER MOUNT (undefined -> resumeErr once a launch POST fails)
  // swaps Tooltip's own render tree to a different element TYPE at that JSX
  // position, so React unmounts+remounts the whole subtree INCLUDING this button
  // -- any DOM ref held across the transition (getByTestId/focus) goes stale. A
  // native title attribute carries the same "server reason as tooltip" intent
  // without ever changing the element's type, so the button node never remounts.
  // See the in-file comment at AgentInspectorModal.tsx's resume-terminal-btn.
  'operator/app/harness/AgentInspectorModal.tsx',
]);
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
    // WI-5924: the bare `confirm(` branch used to be a plain `\bconfirm\s*\(`
    // with no receiver check, so it matched ANY `<anything>.confirm(...)` call
    // — including a config object's own `confirm` callback property (e.g.
    // `action.confirm(ctx)`), which has nothing to do with the native
    // `window.confirm()` blocking dialog this rule exists to ban. A `\b`
    // boundary alone doesn't exclude a dot-prefixed call (`.` is a non-word
    // char, so the boundary still matches right after it) — the `(?<!\.)`
    // negative lookbehind is what actually rules out property access, so
    // only a bare/global `confirm(` (no receiver at all) trips this branch.
    const hasNativeConfirm =
      /window\.confirm\s*\(/.test(content) ||
      (/(?<!\.)\bconfirm\s*\(/.test(content) && !/useConfirmDialog/.test(content));
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
  // ONE definition, shared with the edit-time nudge hook (EI-20023819609804890). The
  // pattern is NOT inlined here any more: posttooluse-css-design-primitives-nudge.mjs
  // needs the identical matcher, and a hand-copied second regex would drift — the
  // negative lookahead below is exactly what separates a banned `0.04em` from the
  // required `letter-spacing: 0`. Fresh instance per call: `/g` is stateful.
  const nonzeroLetterSpacingRe = makeNonzeroLetterSpacingRe();
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

/**
 * Class names ever seen applied via a static `className="..."` (or a static
 * template literal) directly on a `<button>` JSX element — used by the
 * flex/grid-on-button hazard check below to catch component-scoped classes,
 * not just a bare `button` type selector.
 */
let buttonClassNamesCache: ReadonlySet<string> | null = null;

function collectButtonClassNames(): ReadonlySet<string> {
  if (buttonClassNamesCache) return buttonClassNamesCache;
  const classes = new Set<string>();
  const buttonTagRe = /<button\b[^>]*>/gs;
  const classNameRe = /className\s*=\s*(?:\{)?\s*["'`]([^"'`{}]*)["'`]/;
  for (const file of collectFiles()) {
    if (!file.endsWith('.tsx')) continue;
    const tags = readCode(file).match(buttonTagRe) ?? [];
    for (const tag of tags) {
      const m = classNameRe.exec(tag);
      if (!m) continue;
      for (const cls of m[1].split(/\s+/).filter(Boolean)) classes.add(cls);
    }
  }
  buttonClassNamesCache = classes;
  return classes;
}

/**
 * Return whether a selector's terminal compound targets the button element
 * itself. A descendant or pseudo-element can have small dimensions without
 * inheriting the button baseline's `min-height`, so treating any `button`
 * token anywhere in the selector as a button rule creates false positives.
 */
function selectorTargetsButtonElement(sel: string, buttonClasses: ReadonlySet<string>): boolean {
  const lastCompound = sel.split(/[\s>+~]+/).pop()?.trim() ?? '';
  if (!lastCompound) return false;

  // Support both modern `::before` and legacy `:before` pseudo-element forms.
  if (/(::|:(?:before|after|first-letter|first-line|selection|backdrop|placeholder|marker|file-selector-button|cue|part|slotted|grammar-error|spelling-error)\b)/i.test(lastCompound)) {
    return false;
  }

  const hasBareButton = /^button(?=[.:#[>+~,]|$)/.test(lastCompound);
  const lastClasses = (lastCompound.match(/\.[A-Za-z0-9_-]+/g) ?? []).map((c) => c.slice(1));
  return hasBareButton || lastClasses.some((c) => buttonClasses.has(c));
}

/**
 * WebKitGTK (the Tauri desktop webview's engine) renders a `<button>`'s
 * contents through an internal anonymous box (RenderButton) that IGNORES
 * `display: flex`/`grid` set on the button element itself — Chromium honors
 * it, so this diffs invisibly in jsdom/Chromium-run tests while shipping
 * broken layout in the actual desktop app (diagnosed live 2026-07-20,
 * EI-18135716653974462 / WI-5581 — a progress bar rendered 0×0 with
 * overflowing children). The safe pattern: reset the `<button>` to a plain
 * block (`display: block`) and move ALL flex/grid layout onto an inner
 * `<span>`/`<div>` that carries the row.
 *
 * Flags any CSS ruleset (styled-jsx `<style jsx>` blocks or a plain .css
 * file) whose selector list contains either a bare `button` type selector,
 * or a class known (via collectButtonClassNames) to be applied directly on a
 * `<button>` element as that selector's own last compound — while its
 * declarations set `display: (inline-)flex` or `display: (inline-)grid`.
 */
function unexpectedFlexOrGridOnButtonSelectors(): string[] {
  const offenders: string[] = [];
  const buttonClasses = collectButtonClassNames();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const displayRe = /display\s*:\s*(?:inline-)?(?:flex|grid)\b/;

  for (const file of collectFiles()) {
    const content = readCode(file);
    const matches = [...content.matchAll(ruleRe)];
    for (const match of matches) {
      const [whole, selectorList, decls] = match;
      if (!displayRe.test(decls)) continue;
      // Conservative CSS-ruleset shape guard: a real selector list never
      // contains `;` or a bare `(` (template-literal/JS interpolation does) —
      // except inside a pseudo-class like :not(...)/:hover — and stays short.
      if (selectorList.length > 200) continue;
      if (/[;]/.test(selectorList)) continue;
      if (/\(/.test(selectorList) && !/:(?:not|is|where|hover|focus(?:-visible)?|active|disabled)\s*\(/.test(selectorList)) {
        continue;
      }
      const selectors = selectorList.split(',').map((s) => s.trim()).filter(Boolean);
      for (const sel of selectors) {
        if (!selectorTargetsButtonElement(sel, buttonClasses)) continue;
        const before = content.slice(0, match.index! + whole.indexOf(selectorList));
        const line = before.split('\n').length;
        offenders.push(`${rel(file)}:${line}: ${sel}`);
      }
    }
  }
  return offenders;
}

/**
 * `apps/operator/app/globals.css` declares the button baseline with
 * `:where(button, .pc-btn) { ...; min-height: 26px; ... }`. `:where()` has
 * ZERO specificity, so every property a later rule DOES declare overrides
 * it — the only thing that survives is a property the author never thought
 * to declare. A rule that sets both `width` and `height` to <=26px on a
 * button selector but never declares `min-height` silently gets the
 * baseline's `min-height: 26px`, growing a same-declared-width square/circle
 * into an off-by-a-few-px "egg" (EI-18690913356156250, caught only because
 * WI-5989 measured getBoundingClientRect() in a live WebKitGTK webview —
 * nothing else fails: typecheck, unit tests, and the other design-primitive
 * lints above all stay green, because the defect exists only in computed
 * layout).
 *
 * Flags any CSS ruleset (styled-jsx `<style jsx>` blocks or a plain .css
 * file) whose selector list contains a bare `button` type selector, or a
 * class known (via collectButtonClassNames) to be applied directly on a
 * `<button>` element — while its declarations set both `width` and `height`
 * to <=26px WITHOUT also declaring `min-height` (any min-height, any value —
 * once an author states one explicitly they've made a deliberate choice,
 * even if that choice happens to match the floor).
 */
function unexpectedSmallButtonWithoutMinHeight(): string[] {
  const offenders: string[] = [];
  const buttonClasses = collectButtonClassNames();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  // Negative lookbehind excludes `min-width`/`max-width` (etc.) from matching
  // as a bare `width` declaration — Node's regex engine supports this fine.
  const dimRe = (prop: 'width' | 'height') =>
    new RegExp(`(?<![a-z-])${prop}\\s*:\\s*([0-9.]+)px\\b`, 'g');
  const minHeightRe = /(?<![a-z-])min-height\s*:/;

  for (const file of collectFiles()) {
    const content = readCode(file);
    const matches = [...content.matchAll(ruleRe)];
    for (const match of matches) {
      const [whole, selectorList, decls] = match;
      if (selectorList.length > 200) continue;
      if (/[;]/.test(selectorList)) continue;
      if (/\(/.test(selectorList) && !/:(?:not|is|where|hover|focus(?:-visible)?|active|disabled)\s*\(/.test(selectorList)) {
        continue;
      }
      if (minHeightRe.test(decls)) continue;

      const width = [...decls.matchAll(dimRe('width'))][0];
      const height = [...decls.matchAll(dimRe('height'))][0];
      if (!width || !height) continue;
      // The hazard is specifically `height < 26px`: the zero-specificity
      // `min-height: 26px` baseline only ever GROWS a shorter declared
      // height. A height of exactly 26px collides harmlessly (min-height is
      // a no-op — this is the WI-5989 workaround: 26x26 with no min-height,
      // deliberately matching the floor instead of fighting it), and a
      // height above 26px is never touched by the baseline at all.
      if (Number(width[1]) > 26 || Number(height[1]) >= 26) continue;

      const selectors = selectorList.split(',').map((s) => s.trim()).filter(Boolean);
      for (const sel of selectors) {
        if (!selectorTargetsButtonElement(sel, buttonClasses)) continue;
        const before = content.slice(0, match.index! + whole.indexOf(selectorList));
        const line = before.split('\n').length;
        offenders.push(`${rel(file)}:${line}: ${sel} (width:${width[1]}px height:${height[1]}px, no min-height)`);
      }
    }
  }
  return offenders;
}

/**
 * The invisible-overlay hit target (WI-10003857). A custom switch/checkbox
 * paints its own track + thumb and stacks a transparent native `<input>` over
 * them — `position:absolute; inset:0; opacity:0` — so the input catches the
 * click. But `inset:0` does NOT size a checkbox/radio: it is a REPLACED element,
 * and an absolutely positioned replaced element keeps its intrinsic box (~12px
 * in WebKitGTK) whatever its offsets say (CSS 2.1 §10.3.8). The input then
 * covers one corner of the control and every click elsewhere lands on an inert
 * span. On a two-state switch that corner is where the thumb sits when OFF, so
 * switching ON works and switching OFF silently does nothing — the owner's
 * "I can't deselect the top pot" in the Learning tab's pot dropdown. Nothing
 * else catches it: typecheck, jsdom tests (no layout) and a synthetic
 * `.click()` on the input all pass; only a real pointer at the thumb fails.
 *
 * True when a rule targets an `input`, makes it a transparent absolute overlay,
 * and does not declare BOTH `width` and `height` (any value — `100%` is the fix).
 */
export function overlayInputMissingSize(selectorList: string, decls: string): boolean {
  const targetsInput = selectorList
    .split(',')
    .map((s) => s.trim().split(/[\s>+~]+/).pop() ?? '')
    .some((compound) => /^input(?=[.:#[]|$)/.test(compound));
  if (!targetsInput) return false;
  if (!/(?<![a-z-])position\s*:\s*(?:absolute|fixed)\b/.test(decls)) return false;
  if (!/(?<![a-z-])opacity\s*:\s*0(?:\.0*)?\s*(?:[;!]|$)/.test(decls)) return false;
  const stretched = /(?<![a-z-])inset\s*:\s*0(?:px)?\s*(?:[;!]|$)/.test(decls) ||
    (/(?<![a-z-])left\s*:\s*0/.test(decls) && /(?<![a-z-])right\s*:\s*0/.test(decls)) ||
    (/(?<![a-z-])top\s*:\s*0/.test(decls) && /(?<![a-z-])bottom\s*:\s*0/.test(decls));
  if (!stretched) return false;
  const hasWidth = /(?<![a-z-])width\s*:/.test(decls);
  const hasHeight = /(?<![a-z-])height\s*:/.test(decls);
  return !(hasWidth && hasHeight);
}

function unexpectedOverlayInputWithoutSize(): string[] {
  const offenders: string[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const file of collectFiles()) {
    const content = readCode(file);
    for (const match of content.matchAll(ruleRe)) {
      const [whole, rawSelectors, decls] = match;
      // Trim first: a blanked comment above the rule (stripComments keeps its
      // bytes as spaces) would otherwise inflate the selector past the guard.
      const selectorList = rawSelectors.trim();
      if (selectorList.length === 0 || selectorList.length > 200 || /[;]/.test(selectorList)) continue;
      if (!overlayInputMissingSize(selectorList, decls)) continue;
      const before = content.slice(0, match.index! + whole.indexOf(selectorList));
      offenders.push(`${rel(file)}:${before.split('\n').length}: ${selectorList}`);
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
      unexpectedFiles(makeButtonTitleTooltipRe(), BUTTON_TITLE_ALLOWED_FILES),
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

  // NEW rule (EI-18135716653974462, 2026-07-20) — WARN-ONLY per this file's own
  // warn-first rollout convention: ~130 pre-existing sites already set
  // display:(inline-)flex/grid directly on a <button> (most a harmless
  // icon+text row that happens to still read fine under WebKitGTK's block
  // fallback), so flipping straight to enforce:true would red the whole
  // fleet's gate over unaudited debt. This surfaces every offender loudly —
  // seed an allowlist for the audited-safe ones, migrate any genuinely broken
  // ones to the inner-span pattern (see AdvOverviewTab.tsx), then flip
  // enforce:true so a NEW instance of the class can never ship silently
  // again.
  it('flags display:flex/grid set directly on a <button> selector (WebKitGTK ignores it)', () => {
    warnOrFail(
      'display:flex/grid on a <button> selector',
      unexpectedFlexOrGridOnButtonSelectors(),
      {
        enforce: false,
        hint:
          'WebKitGTK (the Tauri desktop webview) ignores flex/grid set on the <button> ' +
          'element itself — move the layout onto an inner <span>/<div> and reset the ' +
          '<button> to display:block (see AdvOverviewTab.tsx / WI-5581 / EI-18135716653974462).',
      },
    );
  });

  // ENFORCED SUBSET (gui-chat-session-controls-2026-07-25 P-001, WI-5874): the
  // rule above stays warn-only fleet-wide for ~130 pre-existing sites, but the
  // HUD board (/adv/HUD) was JUST migrated off flex-on-<button> — a plain
  // `<button>` displaying its rail+body on top of each other in the real
  // Tauri/WebKitGTK webview (owner-screenshotted regression, chromium-only
  // "verified" the first time it shipped). Nothing stops enforcing the rule on
  // files we've just cleaned, so this specific class of bug can never re-ship
  // here silently again — a new offender in this folder hard-fails instead of
  // only logging.
  const HUD_ENFORCED_PATH_PREFIX = 'operator/app/adv/hud/';

  it('ENFORCES no display:flex/grid on a <button> selector in the HUD board (just migrated off it)', () => {
    const hudOffenders = unexpectedFlexOrGridOnButtonSelectors().filter((offender) =>
      offender.startsWith(HUD_ENFORCED_PATH_PREFIX),
    );
    expectNoUnexpected(
      'display:flex/grid on a <button> selector (HUD, enforced subset)',
      hudOffenders,
    );
  });

  // ENFORCED rule (EI-18690913356156250, 2026-07-26): globals.css's
  // zero-specificity `:where(button, .pc-btn) { min-height: 26px; ... }`
  // baseline silently wins over a declared height<26px, turning an intended
  // NxN icon button into an off-by-a-few-px "egg". Direct button controls have
  // been migrated to state their intended min-height; descendant and
  // pseudo-element selectors are deliberately excluded because the button
  // baseline does not apply to those targets. Keep this enforced so a new
  // instance can never ship silently again.
  it('blocks a small button/.pc-btn rule that declares height<26px without also declaring min-height', () => {
    warnOrFail(
      'Small button rule missing min-height (globals.css baseline egg hazard)',
      unexpectedSmallButtonWithoutMinHeight(),
      {
        enforce: true,
        hint:
          'globals.css\'s `:where(button, .pc-btn) { min-height: 26px }` baseline silently ' +
          'wins over a declared height<26px (EI-18690913356156250) — either state ' +
          'min-height explicitly (matching your intended height is fine, see WI-5989\'s ' +
          'fix), or raise the declared height to >=26px.',
      },
    );
  });

  // ENFORCED rule (WI-10003857): a transparent overlay <input> with no explicit
  // size keeps its intrinsic ~12px box, so the switch only toggles from one
  // corner — "switch on works, switch off does nothing".
  it('blocks a transparent absolute overlay <input> that does not declare width and height', () => {
    warnOrFail('Overlay <input> hit target without width/height', unexpectedOverlayInputWithoutSize(), {
      enforce: true,
      hint:
        'An absolutely positioned checkbox/radio ignores inset:0 for sizing (replaced element), ' +
        'so it covers only a corner of the control (WI-10003857). Add width: 100%; height: 100%; ' +
        'appearance: none; to the overlay input rule.',
    });
  });
});

describe('overlay input hit-target matching', () => {
  it('flags the pre-fix switch rule and passes the fixed one', () => {
    // Calibration pair: the exact rule that shipped the bug, and its fix.
    const broken = 'position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer;';
    const fixed =
      'position: absolute; inset: 0; width: 100%; height: 100%; appearance: none; opacity: 0; margin: 0;';
    expect(overlayInputMissingSize('.pc-lloop__sw input', broken)).toBe(true);
    expect(overlayInputMissingSize('.pc-lloop__sw input', fixed)).toBe(false);
    expect(overlayInputMissingSize('.x input[type=checkbox]', 'position:absolute;left:0;right:0;top:0;bottom:0;opacity:0')).toBe(true);
  });

  it('ignores rules that are not a transparent stretched overlay on an input', () => {
    const broken = 'position: absolute; inset: 0; opacity: 0;';
    expect(overlayInputMissingSize('.pc-lloop__swtrack', broken)).toBe(false);
    expect(overlayInputMissingSize('.x input + span', broken)).toBe(false);
    expect(overlayInputMissingSize('.x input', 'position: absolute; inset: 0; opacity: .5;')).toBe(false);
    expect(overlayInputMissingSize('.x input', 'position: relative; opacity: 0;')).toBe(false);
    expect(overlayInputMissingSize('.x input:disabled', 'cursor: default;')).toBe(false);
  });
});

describe('button selector target matching', () => {
  it('ignores descendant and pseudo-element geometry rules', () => {
    const classes = new Set(['known-button']);
    expect(selectorTargetsButtonElement('.parent button', classes)).toBe(true);
    expect(selectorTargetsButtonElement('.parent button > i', classes)).toBe(false);
    expect(selectorTargetsButtonElement('button::before', classes)).toBe(false);
    expect(selectorTargetsButtonElement('.known-button:hover', classes)).toBe(true);
    expect(selectorTargetsButtonElement('.known-button:after', classes)).toBe(false);
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
