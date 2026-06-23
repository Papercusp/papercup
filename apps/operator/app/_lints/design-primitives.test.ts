/**
 * Design primitive lint — guards the enforceable parts of /internal/docs/design.
 *
 * This test deliberately starts with explicit legacy allowlists. The point is to
 * prevent new off-system primitives immediately, then shrink the allowlists as
 * the design-spec compliance plan migrates each active surface.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const LEGACY_NATIVE_SELECT_FILES = new Set([
  // Shared implementation of the design-system wrapper.
  'operator/app/harness/Select.tsx',
  // TEMPORARY (gate-unblock, su-2255d, EI-2699) — a dev-admin-rail internal-tooling
  // panel. Allowlisted so a new internal panel doesn't red the whole fleet's gate;
  // migrate to the shared Select primitive as a follow-up.
  'operator-vite/src/components/dev-admin-rail/panels/ToolUsagePanel.tsx',
]);

const LEGACY_NATIVE_CHECKBOX_FILES = new Set([
  // Shared implementation of the design-system wrapper.
  'operator/app/harness/Checkbox.tsx',
]);

const LEGACY_NATIVE_TABLE_FILES = new Set<string>([
  // TEMPORARY (gate-unblock, su-2255d, EI-2699) — a dev-admin-rail internal-tooling
  // panel; no shared table primitive exists yet. Allowlisted to keep an internal panel
  // from redding the fleet's gate; migrate when a table primitive lands.
  'operator-vite/src/components/dev-admin-rail/panels/ToolUsagePanel.tsx',
]);

const SHARED_CONFIRM_IMPLEMENTATION_FILES = new Set([
  'operator/app/harness/ConfirmModal.tsx',
  'operator/app/harness/useConfirmDialog.tsx',
]);

const LEGACY_BUTTON_TITLE_FILES = new Set<string>();
const LEGACY_LINK_TITLE_FILES = new Set<string>();
const LEGACY_TAB_TITLE_FILES = new Set<string>();

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
  'operator/app/harness/TrustBadge.tsx',
  'operator/app/harness/PrsTab.tsx',
  'operator/app/harness/theme.ts',
  'operator/app/eval-viz/MastBreakdown.tsx',
  'operator/app/eval-viz/arms.ts',
  'operator-vite/src/components/adv/AdvEvalsTab.tsx',
  'operator/app/_components/ChatwootWidget.tsx',
  'operator/app/_components/OracleDock.tsx',
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

function collectFiles(): string[] {
  const files: string[] = [];
  for (const sourceDir of SOURCE_DIRS) {
    walk(sourceDir, files);
  }
  return files.sort();
}

function rel(file: string): string {
  return relative(APPS_ROOT, file);
}

function unexpectedFiles(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles()) {
    const content = readFileSync(file, 'utf-8');
    if (!pattern.test(content)) continue;
    const path = rel(file);
    if (!allowed.has(path)) offenders.push(path);
  }
  return offenders;
}

function unexpectedNativeConfirmFiles(): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles()) {
    const content = readFileSync(file, 'utf-8');
    const hasNativeConfirm =
      /window\.confirm\s*\(/.test(content) ||
      (/\bconfirm\s*\(/.test(content) && !/useConfirmDialog/.test(content));
    if (!hasNativeConfirm) continue;
    const path = rel(file);
    if (!SHARED_CONFIRM_IMPLEMENTATION_FILES.has(path)) offenders.push(path);
  }
  return offenders;
}

function unexpectedNativeCheckboxFiles(): string[] {
  const offenders: string[] = [];
  const pattern = /<input\b[^>]*\btype=["']checkbox["'][^>]*>/gs;
  for (const file of collectFiles()) {
    const content = readFileSync(file, 'utf-8');
    const matches = [...content.matchAll(pattern)];
    const hasNativeCheckbox = matches.some((match) => !/\brole=["']switch["']/.test(match[0]));
    if (!hasNativeCheckbox) continue;
    const path = rel(file);
    if (!LEGACY_NATIVE_CHECKBOX_FILES.has(path)) offenders.push(path);
  }
  return offenders;
}

function unexpectedPatternMatches(label: string, pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles()) {
    const content = readFileSync(file, 'utf-8');
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${rel(file)}:${line}: ${match[0].trim()}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `${label} found in app UI:\n${offenders.map((f) => `  ${f}`).join('\n')}\n\n` +
        'Follow /internal/docs/design: use stable type sizes and letter-spacing: 0.',
    );
  }
  expect(offenders).toHaveLength(0);
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
    const content = readFileSync(file, 'utf-8');
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
    const content = readFileSync(file, 'utf-8');
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
    const content = readFileSync(file, 'utf-8');
    const matches = [...content.matchAll(skyPrimitiveRe)];
    for (const match of matches) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${path}:${line}: ${match[0]}`);
    }
  }
  return offenders;
}

function unexpectedDirectCyanLiteralsInAuditedFiles(): string[] {
  const offenders: string[] = [];
  const cyanLiteralRe =
    /#(?:22d3ee|38bdf8|7dd3fc)|rgba\(\s*(?:34\s*,\s*211\s*,\s*238|56\s*,\s*189\s*,\s*248|125\s*,\s*211\s*,\s*252)\s*,\s*[^)]+\)/g;
  for (const path of AUDITED_DIRECT_CYAN_FILES) {
    const file = join(APPS_ROOT, path);
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
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

function expectNoUnexpected(label: string, offenders: string[]): void {
  if (offenders.length > 0) {
    throw new Error(
      `${label} found in unapproved files:\n${offenders.map((f) => `  ${f}`).join('\n')}\n\n` +
        'Use the shared Papercusp design primitive, or add a temporary allowlist entry with a plan item reference.',
    );
  }
  expect(offenders).toHaveLength(0);
}

describe('design primitive lint', () => {
  it('blocks new native <select> controls in app UI', () => {
    expectNoUnexpected('Native <select>', unexpectedFiles(/<select\b/g, LEGACY_NATIVE_SELECT_FILES));
  });

  it('blocks new native <table> layouts in app UI', () => {
    expectNoUnexpected('Native <table>', unexpectedFiles(/<table\b/g, LEGACY_NATIVE_TABLE_FILES));
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
    expectNoUnexpected('Button title tooltip', unexpectedFiles(/<button\b[^>]*\btitle=/g, LEGACY_BUTTON_TITLE_FILES));
  });

  it('blocks title-only tooltips on links', () => {
    expectNoUnexpected(
      'Link title tooltip',
      unexpectedFiles(/<(?:a\b|RouteLink\b)[^>]*\btitle=/g, LEGACY_LINK_TITLE_FILES),
    );
  });

  it('blocks title-only tooltips on tab controls', () => {
    expectNoUnexpected(
      'Tab title tooltip',
      unexpectedFiles(/\brole=["']tab["'][^>]*\btitle=/g, LEGACY_TAB_TITLE_FILES),
    );
  });

  it('blocks negative letter spacing in app UI', () => {
    unexpectedPatternMatches(
      'Negative letter-spacing',
      /\b(?:letter-spacing|letterSpacing)\s*:\s*(?:['"])?-[0-9.]+em(?:['"])?/g,
    );
  });

  it('blocks viewport-relative font sizing in app UI', () => {
    unexpectedPatternMatches(
      'Viewport-relative font size',
      /\b(?:font-size|fontSize)\s*:\s*(?:['"])?[^;'",}]*(?:vw|vh|vmin|vmax)[^;'",}]*(?:['"])?/g,
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
});
