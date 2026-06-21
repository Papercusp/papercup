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
]);

const LEGACY_NATIVE_CHECKBOX_FILES = new Set([
  // Shared implementation of the design-system wrapper.
  'operator/app/harness/Checkbox.tsx',
]);

const LEGACY_NATIVE_TABLE_FILES = new Set<string>();

const SHARED_CONFIRM_IMPLEMENTATION_FILES = new Set([
  'operator/app/harness/ConfirmModal.tsx',
  'operator/app/harness/useConfirmDialog.tsx',
]);

const LEGACY_BUTTON_TITLE_FILES = new Set<string>();
const LEGACY_LINK_TITLE_FILES = new Set<string>();
const LEGACY_TAB_TITLE_FILES = new Set<string>();

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

  it('keeps audited Vite surfaces on design-spec letter spacing', () => {
    expectNoUnexpected(
      'Nonzero letter-spacing in audited Vite surfaces',
      unexpectedNonzeroLetterSpacingUnderAny([
        join(APPS_ROOT, 'operator-vite/src/components/adv'),
        join(APPS_ROOT, 'operator-vite/src/components/admin'),
        join(APPS_ROOT, 'operator-vite/src/components/left-sidebar'),
        join(APPS_ROOT, 'operator-vite/src/components/dev-admin-rail'),
        join(APPS_ROOT, 'operator-vite/src/components/NotFound.tsx'),
        join(APPS_ROOT, 'operator-vite/src/routes/admin/dogfood-substrate.tsx'),
      ]),
    );
  });

  it('keeps audited operator app stylesheets on design-spec letter spacing', () => {
    expectNoUnexpected(
      'Nonzero letter-spacing in audited operator app stylesheets',
      unexpectedNonzeroLetterSpacingUnderAny([
        join(OPERATOR_ROOT, 'app/_components'),
        join(OPERATOR_ROOT, 'app/globals.css'),
        join(OPERATOR_ROOT, 'app/adv/harnesses'),
        join(OPERATOR_ROOT, 'app/adv/plans'),
        join(OPERATOR_ROOT, 'app/adv/sessions'),
        join(OPERATOR_ROOT, 'app/command-palette.css'),
        join(OPERATOR_ROOT, 'app/admin/_components/AdminShell.tsx'),
        join(OPERATOR_ROOT, 'app/admin/admin-ops.css'),
        join(OPERATOR_ROOT, 'app/admin/admin-tables.css'),
        join(OPERATOR_ROOT, 'app/admin/cupboard-moderation/CupboardModerationClient.tsx'),
        join(OPERATOR_ROOT, 'app/admin/dogfood-substrate/page.tsx'),
        join(OPERATOR_ROOT, 'app/admin/features/FeaturesAdmin.tsx'),
        join(OPERATOR_ROOT, 'app/admin/plans/NewPlanButton.tsx'),
        join(OPERATOR_ROOT, 'app/admin/plans/PlanDetail.tsx'),
        join(OPERATOR_ROOT, 'app/admin/plans/plans.css'),
        join(OPERATOR_ROOT, 'app/admin/testing/testing.css'),
        join(OPERATOR_ROOT, 'app/cupboard'),
        join(OPERATOR_ROOT, 'app/design/[slug]/RegressionPane.tsx'),
        join(OPERATOR_ROOT, 'app/design/[slug]/SketchPane.tsx'),
        join(OPERATOR_ROOT, 'app/dev/dev.css'),
        join(OPERATOR_ROOT, 'app/dev/operator-logo/logo-lab.module.css'),
        join(OPERATOR_ROOT, 'app/dev/swarm-identity/swarm-identity.module.css'),
        join(OPERATOR_ROOT, 'app/dev/swarm-logos/swarm-logos.module.css'),
        join(OPERATOR_ROOT, 'app/dev/tokens/page.tsx'),
        join(OPERATOR_ROOT, 'app/harness'),
        join(OPERATOR_ROOT, 'app/installed/kpis/page.tsx'),
        join(OPERATOR_ROOT, 'app/operator-mock'),
        join(OPERATOR_ROOT, 'app/project-docs/page.tsx'),
        join(OPERATOR_ROOT, 'app/settings/autonomy/page.tsx'),
        join(OPERATOR_ROOT, 'app/settings/personalization/ThemeEditor.tsx'),
        join(OPERATOR_ROOT, 'app/settings/plugins'),
        join(OPERATOR_ROOT, 'app/settings/user/memory/page.tsx'),
        join(OPERATOR_ROOT, 'app/users/github/[id]/UserProfile.tsx'),
        join(OPERATOR_ROOT, 'app/wiki/missing/page.tsx'),
      ]),
    );
  });
});
