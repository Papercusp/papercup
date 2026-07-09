/**
 * Design primitive lint — guards the enforceable parts of /internal/docs/design.
 *
 * This test deliberately starts with explicit legacy allowlists. The point is to
 * prevent new off-system primitives immediately, then shrink the allowlists as
 * the design-spec compliance plan migrates each active surface.
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

const LEGACY_NATIVE_SELECT_FILES = new Set([
  // Shared implementation of the design-system wrapper.
  'operator/app/harness/Select.tsx',
  // TEMPORARY (gate-unblock, su-2255d, EI-2699) — a dev-admin-rail internal-tooling
  // panel. Allowlisted so a new internal panel doesn't red the whole fleet's gate;
  // migrate to the shared Select primitive as a follow-up.
  'operator-vite/src/components/dev-admin-rail/panels/ToolUsagePanel.tsx',
  // TEMPORARY (gate-unblock 2026-06-23, model-override-sidebar-2026-06-23) — the new
  // left-rail per-agent session model-override control. The shared Select primitive
  // (operator/app/harness/Select.tsx) lives in the apps/operator Next app and isn't
  // yet available to the operator-vite app (same constraint as ToolUsagePanel above).
  // Allowlisted so a new control doesn't red the whole fleet's gate; migrate to a
  // Vite-available Select primitive as a follow-up.
  'operator-vite/src/components/left-sidebar/ModelOverride.tsx',
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
  // TEMPORARY (gate-unblock 2026-06-23) — the ADV overview tab, un-migrated by the
  // in-flight design-primitives migration and holding the whole fleet's green gate red
  // (~3h). No shared table primitive exists yet (see note above), so allowlisting is the
  // only option here; migrate to the shared table primitive when it lands.
  'operator-vite/src/components/adv/AdvOverviewTab.tsx',
  // TEMPORARY (gate-unblock 2026-07-02, WI-1686) — the new /settings/p2p owner surface's
  // Audit table (p2p-work-distribution-2026-07-02). No shared table primitive exists yet
  // (see note above); allowlisted so a newly-landed page doesn't hold main's green gate red.
  // Migrate to the shared table primitive when it lands.
  'operator/app/settings/p2p/page.tsx',
  // TEMPORARY (gate-unblock 2026-07-09, agents-pill-inactive-search-2026-07-09) — FleetStatusPanel
  // landed with a native table while no shared table primitive exists yet (see note above);
  // allowlisted so the fleet's green gate isn't held red. Author (su-ba914) owns the migration
  // to the shared table primitive when it lands.
  'operator/app/_components/FleetStatusPanel.tsx',
]);

const SHARED_CONFIRM_IMPLEMENTATION_FILES = new Set([
  'operator/app/harness/ConfirmModal.tsx',
  'operator/app/harness/useConfirmDialog.tsx',
]);

// TEMPORARY (gate-unblock 2026-06-23) — un-migrated `title=` tooltips in two
// operator-vite chrome components, surfaced by the in-flight design-primitives
// migration and holding the fleet's green gate red (~3h). Allowlisted so a peer's
// mid-migration WIP doesn't block every deploy; migrate to the shared tooltip
// primitive as a follow-up (owned by the design-primitives migration).
const LEGACY_BUTTON_TITLE_FILES = new Set<string>([
  'operator-vite/src/components/left-sidebar/LeftSidebar.tsx',
  'operator-vite/src/components/voice-bar/SentinelVoiceBar.tsx',
]);
const LEGACY_LINK_TITLE_FILES = new Set<string>();
const LEGACY_TAB_TITLE_FILES = new Set<string>([
  'operator-vite/src/components/left-sidebar/LeftSidebar.tsx',
]);

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

function collectPatternMatches(pattern: RegExp): string[] {
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
    // allowlisted before the rule is flipped to enforce:true.
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  [design-lint WARN-ONLY, not yet enforced] ${label} found in ${offenders.length} file(s):\n` +
        `${offenders.map((f) => `  ${f}`).join('\n')}\n` +
        `${hint}\n` +
        `(This rule is in warn-only mode — seed its allowlist, then flip enforce:true.)`,
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
    expectNoUnexpected(
      'Button title tooltip',
      unexpectedFiles(/<button\b(?:=>|[^>])*\btitle=/g, LEGACY_BUTTON_TITLE_FILES),
    );
  });

  it('blocks title-only tooltips on links', () => {
    expectNoUnexpected(
      'Link title tooltip',
      unexpectedFiles(/<(?:a\b|RouteLink\b)(?:=>|[^>])*\btitle=/g, LEGACY_LINK_TITLE_FILES),
    );
  });

  it('blocks title-only tooltips on tab controls', () => {
    expectNoUnexpected(
      'Tab title tooltip',
      unexpectedFiles(/\brole=["']tab["'](?:=>|[^>])*\btitle=/g, LEGACY_TAB_TITLE_FILES),
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
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      expect(() => warnOrFail('New native select', OFFENDERS, { enforce: false })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    const logged = warnings.join('\n');
    expect(logged).toMatch(/WARN-ONLY/);
    expect(logged).toMatch(/New native select/);
    // Every offender is surfaced so the author can seed the allowlist before flipping.
    for (const o of OFFENDERS) expect(logged).toContain(o);
  });

  it('ENFORCED (enforce:true): throws with the offenders listed', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
