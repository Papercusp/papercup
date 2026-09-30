/**
 * The INVERTED block-3b guard (EI-19374654827980571).
 *
 * The sibling guard (`setup-release-checkout-runtime-assets.test.ts`) locks the
 * REGRESSION direction: block 3b must keep existing and keep provisioning
 * `apps/operator/public`. This file locks the EXTENSION direction: no test may
 * hard-require a gitignored path that 3b does NOT provision.
 *
 * Both directions are needed because the failure is asymmetric and expensive:
 * a gitignored asset that the gate's checkout never had produces a PERMANENT
 * red on `main` that presents as a flake, cannot be cleared by any re-fire, and
 * cannot be reproduced by its author on a machine where postinstall has run.
 *
 * The teeth check below is not ceremony. The first draft of the scanner matched
 * only `*Sync` fs calls and reported a clean, confident "0 violations" while
 * silently missing `porcupine-cdn.test.ts`, which uses `await readFile(...)` —
 * one of the two real instances that motivated this work.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractProvisionedRoots,
  listSubmodulePaths,
  makeGitIgnoreOracle,
  scanRequiredIgnoredAssets,
} from './gitignored-asset-coverage';
import { listIgnoredRuntimeEntryWorkspaces } from './runtime-workspace-build-coverage';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(REPO_ROOT, 'apps/operator/bin/release/setup-release-checkout.sh');

/**
 * Every test file in the tree — TRACKED and UNTRACKED-but-present.
 *
 * `git ls-files` alone lists only tracked files, which would make this guard
 * blind to a test file that has just been written and not yet committed. That
 * is the single most valuable moment to catch this mistake: the author is still
 * at the keyboard, and the alternative is discovering it as a fleet-wide red
 * pin hours later, from a machine that cannot reproduce it.
 *
 * `--others --exclude-standard` adds untracked files while still excluding
 * gitignored ones. On this shared checkout an untracked file may belong to a
 * PEER mid-edit rather than to you (the whole fleet works one tree, and edits
 * sit unstaged until the next git-sync tick), so the failure message says so
 * explicitly instead of asserting the file is yours.
 */
function repoTestFiles(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files', '--cached', '--others', '--exclude-standard',
      '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .trim()
    .split('\n')
    .filter((p) => p && !p.includes('node_modules'))
    // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
    .filter((p) => existsSync(resolve(REPO_ROOT, p)));
}

const SCRIPT_SRC = readFileSync(SCRIPT, 'utf8');
const RUNTIME_ENTRIES = listIgnoredRuntimeEntryWorkspaces(REPO_ROOT);
const PROVISIONED_ROOTS = extractProvisionedRoots(SCRIPT_SRC, RUNTIME_ENTRIES);
const TEST_FILES = repoTestFiles();
const ORACLE = makeGitIgnoreOracle(REPO_ROOT, listSubmodulePaths(REPO_ROOT));
const REPO_SCAN = scanRequiredIgnoredAssets({
  repoRoot: REPO_ROOT,
  testFiles: TEST_FILES,
  coveredRoots: PROVISIONED_ROOTS,
  isIgnored: ORACLE,
});

/** Build a synthetic corpus: fake file contents + a fake ignore oracle. */
function scanFixture(files: Record<string, string>, opts: {
  ignored: string[];
  coveredRoots: string[];
}) {
  return scanRequiredIgnoredAssets({
    repoRoot: '/fixture',
    testFiles: Object.keys(files),
    coveredRoots: opts.coveredRoots,
    isIgnored: (p) => opts.ignored.some((i) => p === i || p.startsWith(i + '/')),
    readFile: (abs) => {
      const rel = abs.replace('/fixture/', '');
      if (!(rel in files)) throw new Error('ENOENT');
      return files[rel];
    },
  });
}

describe('release setup coverage — no test may hard-require a gitignored path setup does not provision', () => {
  it('derives copied and pinned-build roots from the shipped script, not hardcoded copies', () => {
    // If this is empty the whole guard is vacuous: every path would count as
    // uncovered, or (worse) a narrowed block would go unnoticed.
    expect(
      PROVISIONED_ROOTS,
      'could not extract any *ASSET_REL root from setup-release-checkout.sh — block 3b may have been ' +
        'renamed or restructured. This guard derives its covered set from the script on purpose; ' +
        'update extractProvisionedRoots() to match the new shape.',
    ).not.toEqual([]);
    expect(PROVISIONED_ROOTS).toContain('apps/operator/public');
    expect(PROVISIONED_ROOTS).toContain('libs/generic/sse/dist');
  });

  it('finds a non-trivial corpus to scan (a green result here must not be vacuous)', () => {
    expect(TEST_FILES.length).toBeGreaterThan(100);
  });

  it('THE GUARD: every gitignored path a test hard-requires is provisioned by release setup', () => {
    const result = REPO_SCAN;

    expect(
      result.undecidable,
      'git could not decide whether these paths are ignored. They are reported rather than passed, ' +
        'because silently treating an undecidable path as "not ignored" is the exact false-negative ' +
        'this guard exists to prevent.',
    ).toEqual([]);

    const detail = result.violations
      .map((v) => `  ${v.path}\n      required by ${v.file}:${v.line} via ${v.fn}()`)
      .join('\n');

    expect(
      result.violations,
      result.violations.length === 0
        ? ''
        : `A test hard-requires ${result.violations.length} GITIGNORED path(s) that release setup does not provision:\n` +
          `${detail}\n\n` +
          `apps/operator/bin/release/setup-release-checkout.sh provisions only: ` +
          `${PROVISIONED_ROOTS.join(', ')}.\n` +
          `Everything else gitignored is wiped by step 1's \`clean -fdqx\` and never restored, so this ` +
          `test can NEVER pass in the gate's checkout — it red-pins main for the whole fleet, ` +
          `permanently, and no re-fire can clear it. You will not reproduce it locally: it passes on ` +
          `every machine where postinstall has run.\n\n` +
          `Fix it in ONE of these ways:\n` +
          `  1. provision it in release setup (copy static assets in 3b or register a pinned build in 3c-2), or\n` +
          `  2. make the test tolerate absence — skip when the artifact is missing ` +
          `(it.skipIf / an early return), which this guard deliberately does not flag, or\n` +
          `  3. commit the artifact, so it survives the clean.\n\n` +
          `If the file above is not one you edited: this checkout is shared by the whole fleet and ` +
          `untracked files are scanned too, so a peer may be mid-edit. The finding is still real — ` +
          `tell them rather than ignoring it; once git-sync commits it, it red-pins everyone.`,
    ).toEqual([]);
  });
});

describe('pinned runtime-build coverage — registration is the coverage authority', () => {
  const CONTROL_PATH = 'libs/generic/sse/dist/index.js';
  const CONTROL_FILE = 'apps/operator/lib/release/__runtime_build_control__.test.ts';
  const CONTROL_SRC = `
    import { readFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    const ENTRY = resolve(REPO_ROOT, 'libs/generic/sse/dist', 'index.js');
    it('requires the CommonJS boot entry', () => { readFileSync(ENTRY, 'utf8'); });
  `;

  function scanWith(coveredRoots: string[]) {
    return scanRequiredIgnoredAssets({
      repoRoot: REPO_ROOT,
      testFiles: [CONTROL_FILE],
      coveredRoots,
      isIgnored: ORACLE,
      readFile: (abs) => (abs.endsWith('__runtime_build_control__.test.ts')
        ? CONTROL_SRC
        : readFileSync(abs, 'utf8')),
    });
  }

  it('covers an ignored boot entry because its workspace is built from pinned source', () => {
    expect(ORACLE(CONTROL_PATH)).toBe(true);
    const result = scanWith(PROVISIONED_ROOTS);
    expect(result.stats.parsed).toBe(1);
    expect(result.violations).toEqual([]);
    expect(result.covered.map((site) => site.path)).toContain(CONTROL_PATH);
  });

  it('reds on the same ignored boot entry when its workspace is not registered', () => {
    const unregisteredScript = SCRIPT_SRC.replace('"@papercusp/sse"', '"@papercusp/not-sse"');
    const roots = extractProvisionedRoots(unregisteredScript, RUNTIME_ENTRIES);
    expect(roots).not.toContain('libs/generic/sse/dist');
    expect(scanWith(roots).violations.map((site) => site.path)).toContain(CONTROL_PATH);
  });
});

describe('real-fidelity control — the red path, using the REAL oracle and REAL provisioned roots', () => {
  /**
   * Every other negative control below substitutes a FAKE ignore oracle and
   * hand-written roots. This one changes nothing except the corpus: the real
   * `git check-ignore` oracle, the real roots parsed from the shipped script,
   * and a violating file whose SOURCE is injected through the scanner's
   * `readFile` seam. It is therefore the only in-suite proof that the exact
   * configuration THE GUARD runs in can still go red.
   *
   * The violating file is injected rather than written to disk on purpose.
   * During this guard's development the same control WAS done on disk, and
   * git-sync auto-committed the deliberately-broken file to shared staging
   * within 38 seconds (EI-19378575598384065) — briefly placing into history
   * exactly the permanent, fleet-wide red-pin this guard exists to prevent. A
   * cleanup trap does not help: git-sync's tick is independent of the process
   * that created the file. Never write a deliberately-broken file into this
   * tree, not even briefly.
   */
  const CONTROL_PATH = 'apps/operator-vite/dist/index.js';
  const CONTROL_FILE = 'apps/operator/lib/release/__injected_control__.test.ts';
  const CONTROL_SRC = `
    import { existsSync } from 'node:fs';
    import { resolve } from 'node:path';
    const BUNDLE = resolve(REPO_ROOT, 'apps/operator-vite/dist', 'index.js');
    it('requires the SPA bundle to exist', () => {
      expect(existsSync(BUNDLE)).toBe(true);
    });
  `;

  it('precondition: the control path is really gitignored and really outside the provisioned roots', () => {
    // Asserted explicitly so that if .gitignore or block 3b ever changes, this
    // control fails with a message that explains itself, instead of quietly
    // passing while proving nothing.
    expect(
      ORACLE(CONTROL_PATH),
      `${CONTROL_PATH} is no longer gitignored, so it can no longer stand in for a wiped runtime ` +
        'asset. Pick another gitignored path outside the provisioned roots for this control.',
    ).toBe(true);
    expect(
      PROVISIONED_ROOTS.some((r) => CONTROL_PATH.startsWith(r.replace(/\/+$/, '') + '/')),
      `release setup now provisions ${CONTROL_PATH}, so it is covered and cannot serve as a violation. ` +
        'Pick another gitignored path outside the provisioned roots for this control.',
    ).toBe(false);
  });

  it('reds on an injected violation without writing anything to the shared tree', () => {
    const result = scanRequiredIgnoredAssets({
      repoRoot: REPO_ROOT,
      testFiles: [CONTROL_FILE],
      coveredRoots: PROVISIONED_ROOTS,
      isIgnored: ORACLE,
      readFile: (abs) => (abs.endsWith('__injected_control__.test.ts')
        ? CONTROL_SRC
        : readFileSync(abs, 'utf8')),
    });

    expect(
      result.violations.map((v) => v.path),
      'THE GUARD can no longer detect a violation under its real production configuration. ' +
        'Every other control here uses a fake oracle, so this is the one that would catch the ' +
        'scanner losing its teeth while still reporting a confident green.',
    ).toContain(CONTROL_PATH);
    expect(result.violations[0].file).toBe(CONTROL_FILE);
  });

  it('and the same corpus is CLEAN once that root is provisioned (the green came from coverage)', () => {
    const result = scanRequiredIgnoredAssets({
      repoRoot: REPO_ROOT,
      testFiles: [CONTROL_FILE],
      coveredRoots: [...PROVISIONED_ROOTS, 'apps/operator-vite/dist'],
      isIgnored: ORACLE,
      readFile: (abs) => (abs.endsWith('__injected_control__.test.ts')
        ? CONTROL_SRC
        : readFileSync(abs, 'utf8')),
    });
    expect(result.violations).toEqual([]);
    // Still SEEN, just covered — proving the green is coverage, not blindness.
    expect(result.covered.map((v) => v.path)).toContain(CONTROL_PATH);
  });
});

describe('teeth — the scanner detects the real instances that motivated it', () => {
  // The required set is coverage-independent: with coverage removed every one
  // of these sites becomes a violation. Reuse the authoritative repo scan so
  // this suite does not repeat the expensive full-tree AST + git-ignore pass.
  const hitPaths = REPO_SCAN.required.map((v) => v.path);

  it('detects the vditor case (path split across resolve() arguments)', () => {
    expect(
      hitPaths.some((p) => p.includes('vditor')),
      'the scanner no longer sees the vditor requirement. That is the exact red that cost the fleet ' +
        '10 failures in 12h; a scanner that cannot detect it certifies nothing.',
    ).toBe(true);
  });

  it('detects the porcupine case (promise-based readFile, not readFileSync)', () => {
    expect(
      hitPaths.some((p) => p.includes('porcupine')),
      'the scanner no longer sees the porcupine requirement. It is expressed as `await readFile(...)`, ' +
        'so this fails the moment FS_REQUIRE_FNS loses its promise-API entries — which is how the ' +
        'first draft of this scanner reported a confident, wrong "0 violations".',
    ).toBe(true);
  });

  it('attributes each detection to the file and line that makes the requirement', () => {
    const vditor = REPO_SCAN.required.find((v) => v.path.includes('vditor'));
    expect(vditor?.file).toMatch(/\.test\.ts$/);
    expect(vditor?.line).toBeGreaterThan(0);
  });
});

describe('negative controls — the guard reds on a seeded violation', () => {
  const OUTSIDE = 'packages/some-pkg/generated-assets/model.bin';

  it('reds on a test hard-requiring a gitignored path OUTSIDE the provisioned roots', () => {
    const result = scanFixture(
      {
        'packages/some-pkg/thing.test.ts': `
          import { existsSync } from 'node:fs';
          import { resolve } from 'node:path';
          const ROOT = resolve(__dirname, '../..');
          const MODEL = resolve(ROOT, 'packages/some-pkg/generated-assets', 'model.bin');
          it('needs the model', () => { expect(existsSync(MODEL)).toBe(true); });
        `,
      },
      { ignored: ['packages/some-pkg/generated-assets'], coveredRoots: ['apps/operator/public'] },
    );

    expect(result.violations.map((v) => v.path)).toContain(OUTSIDE);
    expect(result.violations[0].file).toBe('packages/some-pkg/thing.test.ts');
  });

  it('reds on the promise-API spelling too (the porcupine shape)', () => {
    const result = scanFixture(
      {
        'packages/some-pkg/thing.test.ts': `
          import { readFile } from 'node:fs/promises';
          import { resolve } from 'node:path';
          const MODEL = resolve(REPO_ROOT, 'packages/some-pkg/generated-assets/model.bin');
          it('needs it', async () => { await readFile(MODEL); });
        `,
      },
      { ignored: ['packages/some-pkg/generated-assets'], coveredRoots: ['apps/operator/public'] },
    );
    expect(result.violations.map((v) => v.path)).toContain(OUTSIDE);
  });

  it('goes GREEN once block 3b is widened to provision that root (the actionable direction)', () => {
    const files = {
      'packages/some-pkg/thing.test.ts': `
        import { existsSync } from 'node:fs';
        const MODEL = resolve(ROOT, 'packages/some-pkg/generated-assets', 'model.bin');
        it('needs it', () => { expect(existsSync(MODEL)).toBe(true); });
      `,
    };
    const widened = scanFixture(files, {
      ignored: ['packages/some-pkg/generated-assets'],
      coveredRoots: ['apps/operator/public', 'packages/some-pkg/generated-assets'],
    });
    expect(widened.violations).toEqual([]);
    // ...and it is still SEEN as a required ignored asset, just a covered one —
    // proving the green came from coverage, not from the scanner going blind.
    expect(widened.covered.map((v) => v.path)).toContain(OUTSIDE);
  });

  it('reds when block 3b is NARROWED, using roots parsed from a script fixture', () => {
    const narrowed = extractProvisionedRoots('PUBLIC_ASSET_REL="apps/operator/public/vditor"\n');
    expect(narrowed).toEqual(['apps/operator/public/vditor']);
    const result = scanFixture(
      {
        'apps/operator/x.test.ts': `
          import { existsSync } from 'node:fs';
          const P = resolve(ROOT, 'apps/operator/public/excalidraw', 'asset.js');
          it('needs it', () => { expect(existsSync(P)).toBe(true); });
        `,
      },
      { ignored: ['apps/operator/public'], coveredRoots: narrowed },
    );
    expect(result.violations.map((v) => v.path)).toContain('apps/operator/public/excalidraw/asset.js');
  });
});

describe('false-positive controls — the noise that would get this guard disabled', () => {
  it('does NOT treat a repository-shaped path below mkdtempSync as a checkout requirement', () => {
    const result = scanFixture(
      {
        'packages/p/temp-fixture.test.ts': `
          import { mkdtempSync, readFileSync } from 'node:fs';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          const root = mkdtempSync(join(tmpdir(), 'release-fixture-'));
          const packageRoot = join(root, 'libs/generic/sse');
          it('checks its generated fixture', () => {
            readFileSync(join(packageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'utf8');
            readFileSync(join(packageRoot, 'dist/index.js'), 'utf8');
          });
        `,
      },
      { ignored: ['libs/generic/sse/node_modules', 'libs/generic/sse/dist'], coveredRoots: [] },
    );

    expect(result.violations).toEqual([]);
    expect(result.required).toEqual([]);
  });

  it('does NOT flag a test that tolerates absence via a skip guard', () => {
    const result = scanFixture(
      {
        'packages/p/a.test.ts': `
          import { existsSync } from 'node:fs';
          const MODEL = resolve(ROOT, 'packages/some-pkg/generated-assets', 'model.bin');
          it.skipIf(!existsSync(MODEL))('optional', () => {});
        `,
      },
      { ignored: ['packages/some-pkg/generated-assets'], coveredRoots: [] },
    );
    expect(result.violations).toEqual([]);
  });

  it('does NOT flag a test that guards with an if / early return', () => {
    const result = scanFixture(
      {
        'packages/p/b.test.ts': `
          import { existsSync } from 'node:fs';
          const MODEL = resolve(ROOT, 'packages/some-pkg/generated-assets', 'model.bin');
          it('optional', () => { if (!existsSync(MODEL)) return; expect(1).toBe(1); });
        `,
      },
      { ignored: ['packages/some-pkg/generated-assets'], coveredRoots: [] },
    );
    expect(result.violations).toEqual([]);
  });

  it('does NOT flag a path that is merely MENTIONED rather than required', () => {
    // The 13/15 false-positive class: `dist` / `.next` / `tsbuildinfo` paths that
    // appear as strings but never flow into an fs call.
    const result = scanFixture(
      {
        'packages/p/c.test.ts': `
          const EXPECTED_OUTPUT = 'packages/some-pkg/generated-assets/model.bin';
          it('names it', () => { expect(config.out).toBe(EXPECTED_OUTPUT); });
        `,
      },
      { ignored: ['packages/some-pkg/generated-assets'], coveredRoots: [] },
    );
    expect(result.violations).toEqual([]);
  });

  it('does NOT flag a TRACKED path, even under a directory that also holds ignored files', () => {
    const result = scanFixture(
      {
        'packages/p/d.test.ts': `
          import { readFileSync } from 'node:fs';
          const SRC = resolve(ROOT, 'apps/operator/bin/release/setup-release-checkout.sh');
          it('reads it', () => { readFileSync(SRC, 'utf8'); });
        `,
      },
      { ignored: ['apps/operator/public'], coveredRoots: [] },
    );
    expect(result.violations).toEqual([]);
  });
});

describe('the git ignore oracle', () => {
  it('reports a real gitignored runtime asset as ignored, even though it is not tracked', () => {
    expect(ORACLE('apps/operator/public/vditor/dist/js/lute/lute.min.js')).toBe(true);
  });

  it('reports a path that does NOT exist on disk, so the verdict is the same in the gate checkout', () => {
    // This is why check-ignore is used instead of `git status --ignored`: the
    // gate's tree has none of these assets, which is the condition being guarded.
    expect(ORACLE('apps/operator/public/vditor/definitely/not/here.bin')).toBe(true);
  });

  it('reports a tracked file as NOT ignored', () => {
    expect(ORACLE('apps/operator/bin/release/setup-release-checkout.sh')).toBe(false);
  });
});
