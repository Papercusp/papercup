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

const SOURCE_DIRS = ['app'];

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  'test-results',
  'operator-mock',
]);

const TEST_FILE_RE = /(?:\.test|\.spec)\.tsx$/;

const LEGACY_NATIVE_SELECT_FILES = new Set([
  // Shared implementation of the design-system wrapper.
  'app/harness/Select.tsx',
]);

const LEGACY_NATIVE_TABLE_FILES = new Set<string>();

const SHARED_CONFIRM_IMPLEMENTATION_FILES = new Set([
  'app/harness/ConfirmModal.tsx',
  'app/harness/useConfirmDialog.tsx',
]);

const LEGACY_BUTTON_TITLE_FILES = new Set([
  // P-003 baseline: migrate remaining action tooltips to Tooltip.
  'app/_components/ConsoleLauncherButton.tsx',
  'app/_components/GlobalFindInPage.tsx',
  'app/_components/OperatorActiveToggle.tsx',
  'app/_components/OperatorChatSidebar.tsx',
  'app/_components/OracleDock.tsx',
  'app/_components/PuiLauncherButton.tsx',
  'app/_components/SetupWizard/StepGit.tsx',
  'app/_components/UpdateChip.tsx',
  'app/_components/voice/VoiceButton.tsx',
  'app/admin/plans/AssignDialog.tsx',
  'app/admin/plans/PlanActions.tsx',
  'app/admin/plans/PlanDetail.tsx',
  'app/admin/plans/PlanItemsList.tsx',
  'app/admin/plans/PlanOtherList.tsx',
  'app/admin/plans/PlanRail.tsx',
  'app/admin/plans/PlansClient.tsx',
  'app/admin/plans/RunDetailPanel.tsx',
  'app/adv/create/PlansListPanel.tsx',
  'app/adv/harnesses/AdvContributorsPanel.tsx',
  'app/adv/harnesses/HiveHeaderStrip.tsx',
  'app/adv/harnesses/HiveWorkspaceCards.tsx',
  'app/adv/sessions/SessionsRosterView.tsx',
  'app/cupboard/CupboardClient.tsx',
  'app/cupboard/ToolsSection.tsx',
  'app/dev/_components/ProcessesTab.tsx',
  'app/dev/_components/SessionsTab.tsx',
  'app/dev/_components/TelemetryTab.tsx',
  'app/editor-demo/panes/LexicalPane.tsx',
  'app/editor-demo/panes/PlatePane.tsx',
  'app/harness/ShareHiveDialog.tsx',
  'app/harness/brainstorm/MapView.tsx',
  'app/harness/dock/DockNavChevrons.tsx',
  'app/harness/dock/DockOnboarding.tsx',
  'app/harness/dock/NavChevrons.tsx',
  'app/settings/autonomy/CeilingSlider.tsx',
  'app/settings/omp/page.tsx',
  'app/settings/plugin-runtime/RuntimeView.tsx',
  'app/settings/user/memory/page.tsx',
]);

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
    } else if (full.endsWith('.tsx') && !TEST_FILE_RE.test(full)) {
      out.push(full);
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const sourceDir of SOURCE_DIRS) {
    walk(join(OPERATOR_ROOT, sourceDir), files);
  }
  return files.sort();
}

function rel(file: string): string {
  return relative(OPERATOR_ROOT, file);
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

  it('blocks title-only tooltips on buttons', () => {
    expectNoUnexpected('Button title tooltip', unexpectedFiles(/<button\b[^>]*\btitle=/g, LEGACY_BUTTON_TITLE_FILES));
  });
});
