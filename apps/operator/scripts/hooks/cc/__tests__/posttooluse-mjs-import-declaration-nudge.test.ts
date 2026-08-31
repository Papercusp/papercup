/**
 * posttooluse-mjs-import-declaration-nudge — the recurrence guard for the
 * unenrolled-`.mjs`-import / mis-positioned-ts-directive CLASS
 * (EI-20043039577586381; 3rd occurrence EI-19389216343173748,
 * EI-18817201237512691, WI-37657 — the last held `main` and burned a gate suite).
 *
 * Mirrors posttooluse-migration-fixture-drift-nudge.test.ts's shape: the point of
 * this file is not "the hook is well-formed" but that it fires against the REAL
 * `offendersIn` / `isSuppressed` / `baselineKey` from
 * scripts/check-unenrolled-mjs-imports.mjs, exercised on realistic MULTI-LINE
 * import syntax — not a stand-in. The hook's own `--self-test` drives a marker-based
 * fake detector (OFFEND_A / SUPPRESSED_HERE), which proves the hook's plumbing but
 * says nothing about whether it agrees with the ratchet on real syntax. That
 * agreement is the whole reason the hook reuses the detector, so it is what this
 * file measures.
 *
 * WHY A REAL TEMP TREE RATHER THAN A STUBBED `exists`
 *   The real `offendersIn` calls `existsSync` itself, on the resolved target and
 *   on its `.d.mts` sibling — those are module-internal and not injectable. A
 *   fixture tree on disk is therefore the only way to drive it truthfully; a
 *   blanket `exists: () => true` would also collapse `findRepoRoot` onto the
 *   edited file's own directory and silently weaken every path-keyed assertion.
 *   Only the two boundaries that genuinely cannot exist here are injected:
 *   `showHead` (the fixture tree is not a git repo) and `loadDetector` (the
 *   detector is resolved off the REAL repo, not the fixture root).
 *
 * ⚠ The fixture specifier strings below are deliberately chosen so that this
 *   file's own text cannot become a finding of the tree-wide ratchet:
 *   `findMjsSpecifiers` is a line regex with no parser, so it matches inside
 *   string literals too. `../../scripts/fixture-helper.mjs` resolves, from THIS
 *   file's directory, to apps/operator/scripts/hooks/scripts/fixture-helper.mjs
 *   — a directory that does not exist — so `offendersIn` skips it as
 *   unresolvable. Keep any new fixture specifier unresolvable from here.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-mjs-import-declaration-nudge.mjs');

type Offender = { file: string; line: number; spec: string; target: string };

type Detector = {
  offendersIn: (file: string, text: string, enrolled: Set<string>, root: string) => Offender[];
  isSuppressed: (lines: string[], lineIdx: number) => boolean;
  enrolledModules: (root: string) => Set<string>;
  baselineKey: (o: { file: string; target: string }) => string;
  BASELINE: Set<string>;
};

async function realDetector(): Promise<Detector> {
  return (await import(
    `file://${resolve(ROOT, 'scripts/check-unenrolled-mjs-imports.mjs')}`
  )) as Detector;
}

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
    isCandidateFile: (p: string) => boolean;
    hasMisplacedDirective: (
      lines: string[],
      specifierLineIdx: number,
      isSuppressed?: unknown,
    ) => boolean;
  };
}

const madeRoots: string[] = [];
afterAll(() => {
  for (const dir of madeRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal but REAL repo-shaped fixture tree:
 *   scripts/check-unenrolled-mjs-imports.mjs  — the marker `findRepoRoot` walks up to
 *   scripts/fixture-helper.mjs                — the import target: real, and with
 *                                               no sibling .d.mts, which is the trap
 *   tsconfig.declarations.json                — read by the REAL `enrolledModules`
 */
function makeRepo(opts: { enrolled?: string[]; withDeclaration?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mjs-import-nudge-'));
  madeRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages', 'x'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'check-unenrolled-mjs-imports.mjs'), '// root marker\n');
  writeFileSync(join(root, 'scripts', 'fixture-helper.mjs'), 'export const helper = 1;\n');
  if (opts.withDeclaration) {
    writeFileSync(join(root, 'scripts', 'fixture-helper.d.mts'), 'export declare const helper: number;\n');
  }
  writeFileSync(
    join(root, 'tsconfig.declarations.json'),
    JSON.stringify({ files: opts.enrolled ?? [] }, null, 2),
  );
  return root;
}

/** Write the edited TypeScript file into the fixture tree; returns its absolute path. */
function writeSource(root: string, text: string) {
  const abs = join(root, 'packages', 'x', 'foo.test.ts');
  writeFileSync(abs, text);
  return abs;
}

/**
 * Production deps except the two that cannot exist for a fixture tree:
 * `showHead` (not a git repo — null means "brand-new file", the shape-1 case)
 * and `loadDetector` (the REAL detector, resolved off the real repo).
 */
async function deps(overrides: Record<string, unknown> = {}) {
  const detector = await realDetector();
  return { showHead: () => null, loadDetector: async () => detector, ...overrides };
}

/** Shape 2: the directive sits above the `import` keyword — it suppresses NOTHING. */
const MISPLACED_DIRECTIVE = `// @ts-expect-error - fixture-helper.mjs ships no type declarations
import {
  helper,
} from '../../scripts/fixture-helper.mjs';

export const value = helper;
`;

/** The same import, with the directive correctly placed above the specifier line. */
const CORRECTLY_PLACED_DIRECTIVE = `import {
  helper,
  // @ts-expect-error - fixture-helper.mjs ships no type declarations
} from '../../scripts/fixture-helper.mjs';

export const value = helper;
`;

/** Shape 1: a brand-new import with no directive at all. */
const NO_DIRECTIVE = `import { helper } from '../../scripts/fixture-helper.mjs';

export const value = helper;
`;

describe('mjs-import-declaration nudge — fires on the real trap', () => {
  it('FIRES on the mis-positioned-directive shape and says the directive is the problem', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const out = await hook.nudgeFor(writeSource(root, MISPLACED_DIRECTIVE), await deps());

    expect(out).not.toBeNull();
    expect(out).toContain('scripts/fixture-helper.mjs');
    // The refinement that distinguishes shape 2 from a plain missing declaration.
    expect(out).toContain('does NOT suppress');
    expect(out).toContain('module SPECIFIER');
    // It must cite the recurrence class, which is why the hook exists at all.
    expect(out).toContain('WI-37657');
  });

  it('reports the SPECIFIER line, not the `import` keyword line (tsc reports TS7016 there)', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const out = await hook.nudgeFor(writeSource(root, MISPLACED_DIRECTIVE), await deps());

    // MISPLACED_DIRECTIVE: line 1 is the directive, 2 `import {`, 3 `helper,`, 4 the specifier.
    expect(out).toContain('line 4:');
    expect(out).not.toContain('line 2:');
  });

  it('FIRES on a brand-new file importing an undeclared .mjs, with no mis-positioning claim', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const out = await hook.nudgeFor(writeSource(root, NO_DIRECTIVE), await deps());

    expect(out).not.toBeNull();
    expect(out).toContain('packages/x/foo.test.ts');
    expect(out).toContain('scripts/fixture-helper.mjs');
    // No directive exists, so the shape-2 refinement must NOT be asserted.
    expect(out).not.toContain('does NOT suppress');
    // Both sanctioned fixes, and the confirm command that actually works.
    expect(out).toContain('gen:declarations');
    expect(out).toContain('node scripts/check-unenrolled-mjs-imports.mjs');
    // gen:declarations reports success for this case, so the advisory must say so.
    expect(out).toContain('gen:declarations` reports SUCCESS');
  });

  it('FIRES on a dynamic import() specifier, which the real detector also scans', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const src = `export async function load() {
  return await import('../../scripts/fixture-helper.mjs');
}
`;
    const out = await hook.nudgeFor(writeSource(root, src), await deps());
    expect(out).not.toBeNull();
    expect(out).toContain('scripts/fixture-helper.mjs');
  });

  it('fires for the NEWLY added import only, leaving a pre-existing one unreported', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'other-helper.mjs'), 'export const other = 2;\n');

    const before = `import { helper } from '../../scripts/fixture-helper.mjs';\n`;
    const after =
      `import { helper } from '../../scripts/fixture-helper.mjs';\n` +
      `import { other } from '../../scripts/other-helper.mjs';\n`;

    const out = await hook.nudgeFor(
      writeSource(root, after),
      await deps({ showHead: () => before }),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('scripts/other-helper.mjs');
    expect(out).not.toContain('scripts/fixture-helper.mjs');
  });
});

describe('mjs-import-declaration nudge — stays silent when it should', () => {
  // The calibration case: byte-for-byte the same import as the firing case above,
  // with ONLY the directive moved. Without it, the firing cases prove nothing more
  // than that the hook always fires.
  it('is SILENT when the directive is correctly placed above the specifier line', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const out = await hook.nudgeFor(
      writeSource(root, CORRECTLY_PLACED_DIRECTIVE),
      await deps(),
    );
    expect(out).toBeNull();
  });

  it('is SILENT for a directive separated from a SINGLE-line import by comment lines', async () => {
    // tsc treats comment/blank lines as trivia, so this compiles clean. Reporting
    // it was a real false positive that red-pinned the gate; the detector's own
    // truth table records it, and the hook must inherit that behaviour exactly.
    const hook = await loadHook();
    const root = makeRepo();
    const src = `// @ts-expect-error - fixture-helper.mjs ships no type declarations
// The module is a plain .mjs used by a build script, and enrolling it would
// pull the whole script tree into declaration generation. Suppression is the
// sanctioned fix here.
import { helper } from '../../scripts/fixture-helper.mjs';

export const value = helper;
`;
    const out = await hook.nudgeFor(writeSource(root, src), await deps());
    expect(out).toBeNull();
  });

  it('is SILENT when the module is enrolled in tsconfig.declarations.json', async () => {
    const hook = await loadHook();
    const root = makeRepo({ enrolled: ['scripts/fixture-helper.mjs'] });
    const out = await hook.nudgeFor(writeSource(root, NO_DIRECTIVE), await deps());
    expect(out).toBeNull();
  });

  it('is SILENT when a sibling .d.mts already declares the module', async () => {
    const hook = await loadHook();
    const root = makeRepo({ withDeclaration: true });
    const out = await hook.nudgeFor(writeSource(root, NO_DIRECTIVE), await deps());
    expect(out).toBeNull();
  });

  it('is SILENT for an unresolvable specifier (that is TS2307, a different bug)', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const src = `import { nope } from '../../scripts/does-not-exist.mjs';\n`;
    const out = await hook.nudgeFor(writeSource(root, src), await deps());
    expect(out).toBeNull();
  });

  it('is SILENT on a re-edit that introduces no NEW offending import', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const before = NO_DIRECTIVE;
    const after = `${NO_DIRECTIVE}\n// an unrelated comment added by this edit\n`;
    const out = await hook.nudgeFor(
      writeSource(root, after),
      await deps({ showHead: () => before }),
    );
    expect(out).toBeNull();
  });

  it('is SILENT for a baselined offender, keyed by the REAL baselineKey', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    const detector = await realDetector();
    // Real key function, test-controlled population: the shipped BASELINE is
    // documented shrink-only, so pinning to its current contents would make this
    // test fail the day someone legitimately fixes that entry.
    const BASELINE = new Set([
      detector.baselineKey({
        file: 'packages/x/foo.test.ts',
        target: 'scripts/fixture-helper.mjs',
      }),
    ]);
    const out = await hook.nudgeFor(
      writeSource(root, NO_DIRECTIVE),
      await deps({ loadDetector: async () => ({ ...detector, BASELINE }) }),
    );
    expect(out).toBeNull();
  });

  it('does not treat non-TypeScript or excluded paths as candidates', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/x.test.ts')).toBe(true);
    expect(hook.isCandidateFile('apps/operator/app/page.tsx')).toBe(true);
    expect(hook.isCandidateFile('scripts/check-unenrolled-mjs-imports.mjs')).toBe(false);
    expect(hook.isCandidateFile('packages/operator-core/lib/x.d.ts')).toBe(false);
    expect(hook.isCandidateFile('/repo/node_modules/pkg/index.ts')).toBe(false);
    expect(hook.isCandidateFile('/repo/apps/_retired/old.ts')).toBe(false);
  });

  it('skips a non-candidate path without consulting git or the detector at all', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    writeSource(root, NO_DIRECTIVE);
    const out = await hook.nudgeFor(join(root, 'scripts', 'fixture-helper.mjs'), {
      showHead: () => {
        throw new Error('git must not be consulted for a non-candidate path');
      },
      loadDetector: async () => {
        throw new Error('the detector must not be loaded for a non-candidate path');
      },
    });
    expect(out).toBeNull();
  });
});

describe('mjs-import-declaration nudge — agrees with the real isSuppressed', () => {
  it('hasMisplacedDirective is TRUE only for the multi-line mis-positioned shape', async () => {
    const hook = await loadHook();
    const { isSuppressed } = await realDetector();

    const misplaced = MISPLACED_DIRECTIVE.split('\n');
    const correct = CORRECTLY_PLACED_DIRECTIVE.split('\n');
    // 0-based index of the `} from '...'` specifier line in each fixture.
    expect(hook.hasMisplacedDirective(misplaced, 3, isSuppressed)).toBe(true);
    expect(hook.hasMisplacedDirective(correct, 3, isSuppressed)).toBe(false);
  });

  it('the real isSuppressed disagrees between the two placements (the whole trap)', async () => {
    const { isSuppressed } = await realDetector();
    const misplaced = MISPLACED_DIRECTIVE.split('\n');
    const correct = CORRECTLY_PLACED_DIRECTIVE.split('\n');
    // Specifier line: unsuppressed when the directive sits above `import`...
    expect(isSuppressed(misplaced, 3)).toBe(false);
    // ...and suppressed only when it sits directly above the specifier.
    expect(isSuppressed(correct, 3)).toBe(true);
  });

  it('returns false when isSuppressed is unavailable (a missing refinement never suppresses the advisory)', async () => {
    const hook = await loadHook();
    expect(hook.hasMisplacedDirective(MISPLACED_DIRECTIVE.split('\n'), 3, undefined)).toBe(false);
  });
});

describe('mjs-import-declaration nudge — fails open, never disturbs an edit', () => {
  it('returns null (never throws) when the detector cannot be resolved', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    await expect(
      hook.nudgeFor(
        writeSource(root, NO_DIRECTIVE),
        await deps({ loadDetector: async () => null }),
      ),
    ).resolves.toBeNull();
  });

  it('returns null when tsconfig.declarations.json is missing or unreadable', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    rmSync(join(root, 'tsconfig.declarations.json'));
    // The REAL enrolledModules throws ENOENT here; the hook must swallow it.
    await expect(
      hook.nudgeFor(writeSource(root, NO_DIRECTIVE), await deps()),
    ).resolves.toBeNull();
  });

  it('returns null when the edited file does not exist on disk', async () => {
    const hook = await loadHook();
    const root = makeRepo();
    await expect(
      hook.nudgeFor(join(root, 'packages', 'x', 'never-written.test.ts'), await deps()),
    ).resolves.toBeNull();
  });

  it('the shipped --self-test passes (the hook is executable and self-consistent)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });
});
