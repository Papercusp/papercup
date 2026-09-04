/**
 * check-vimock-export-strands.test.ts — WI-37445 / EI-19462958615807409.
 *
 * TWO HALVES, deliberately, mirroring check-lint-guard-reachability.test.ts:
 *
 *   1. PURE LOGIC with permanent CONTROLS. The controls are the point. This detector's
 *      only real risk is over-firing: an implementation that flags every vi.mock, or that
 *      counts `export type`, would satisfy any naive "does it detect the bad case?" test
 *      while being useless in practice. So each SAFE form stays here forever as a case the
 *      real implementation must stay silent on, next to a calibration case proving the
 *      detector still fires — otherwise the controls could go green by the property itself
 *      breaking.
 *
 *   2. A REAL-TREE assertion that EXECUTES the guard over this repository. Without one,
 *      this file would be exactly what `lint:guard-reachability` classifies as a
 *      `logic-test`: proof the detector works, and no enforcement at all — which is how a
 *      guard rots while looking thoroughly covered.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeExports,
  diffAddedRuntimeExports,
  collectRuntimeImports,
  diffAddedRuntimeImports,
  findEnumeratingMockers,
  isWorkspacePackageSpecifier,
  moduleKeyFor,
  formatNoFindings,
  formatFindings,
  // @ts-expect-error — untyped .mjs guard script, imported for its pure helpers.
} from '../../../../scripts/check-vimock-export-strands.mjs';
import { EXIT_NOT_CHECKED } from '../../../../scripts/lib/not-checked.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-vimock-export-strands.mjs');

const TEST_PATH = 'packages/x/lib/__tests__/a.test.ts';
const SUBJECT = 'packages/x/lib/subject';
const mockersFor = (source: string) =>
  findEnumeratingMockers({ modulePath: SUBJECT, testFiles: [TEST_PATH], read: () => source }) as unknown[];

describe('collectRuntimeExports — runtime values only', () => {
  it('collects every runtime-valued export shape', () => {
    const names = collectRuntimeExports(
      [
        'export function fn() {}',
        'export async function afn() {}',
        'export const CONST = 1;',
        'export let mutable = 2;',
        'export class Klass {}',
        'export enum E { a }',
        'export const { destructured } = obj;',
        'export const [tupled] = arr;',
        "export { reExported } from './x';",
        'export default thing;',
      ].join('\n'),
    ) as Set<string>;
    for (const n of ['fn', 'afn', 'CONST', 'mutable', 'Klass', 'E', 'destructured', 'tupled', 'reExported', 'default']) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it('CONTROL — excludes type-only exports, which can never be missing from a mock', () => {
    // Counting these was measured to inflate the candidate population ~14× (43,431 sites)
    // while pointing at nothing actionable: they are erased at runtime, so they belong in
    // no factory. An implementation that counts them passes the test above and is useless.
    const names = collectRuntimeExports(
      [
        'export type Alias = string;',
        'export interface Iface { a: string }',
        "export type { OnlyType } from './x';",
        "export { type InlineType } from './y';",
      ].join('\n'),
    ) as Set<string>;
    expect([...names]).toEqual([]);
  });

  it('does not treat a non-exported declaration as exported', () => {
    expect([...(collectRuntimeExports('const privateThing = 1;\nfunction hidden() {}') as Set<string>)]).toEqual([]);
  });
});

describe('diffAddedRuntimeExports — only what is NEW', () => {
  it('names an added runtime export', () => {
    expect(diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport const b = 2;')).toEqual(['b']);
  });

  it('CONTROL — silent when the addition is type-only', () => {
    expect(diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport type T = string;')).toEqual([]);
  });

  it('CONTROL — silent when nothing changed, so an unrelated edit cannot fire it', () => {
    const same = 'export const a = 1;\nconst internal = 2;';
    expect(diffAddedRuntimeExports(same, `${same}\n// a comment only`)).toEqual([]);
  });
});

describe('diffAddedRuntimeImports — bare package strands', () => {
  it('collects runtime imports and excludes type-only bindings', () => {
    const imports = collectRuntimeImports(
      "import { old, type SyncBusEvent } from '@papercusp/sync';\nimport type { FlagKey } from '@papercusp/flags';",
    ) as Map<string, Set<string>>;
    expect([...imports.get('@papercusp/sync')!]).toEqual(['old']);
    expect(imports.has('@papercusp/flags')).toBe(false);
  });

  it('names a newly imported runtime value from a workspace package', () => {
    expect(
      diffAddedRuntimeImports(
        "import { old } from '@papercusp/sync';",
        "import { old, onSyncBusEvent, type SyncBusEvent } from '@papercusp/sync';",
      ),
    ).toEqual([{ specifier: '@papercusp/sync', names: ['onSyncBusEvent'] }]);
  });

  it('recognizes workspace packages and rejects external/built-in specifiers', () => {
    const packages = new Set(['@papercusp/sync', '@papercusp/operator-core']);
    expect(isWorkspacePackageSpecifier('@papercusp/sync', packages)).toBe(true);
    expect(isWorkspacePackageSpecifier('@papercusp/operator-core/lib/flag-bus', packages)).toBe(true);
    expect(isWorkspacePackageSpecifier('@testing-library/react', packages)).toBe(false);
    expect(isWorkspacePackageSpecifier('node:fs', packages)).toBe(false);
  });
});

describe('findEnumeratingMockers — the selection gap, precisely', () => {
  it('CALIBRATION — fires on a bare enumerating factory targeting the changed module', () => {
    // Pins that the detector still works, so the controls below cannot pass by the
    // property being broken rather than by the forms being genuinely safe.
    expect(mockersFor("vi.mock('../subject', () => ({ old: 1 }));")).toHaveLength(1);
  });

  it('CONTROL — silent for the import-actual spread (the prescribed fix)', () => {
    expect(mockersFor("vi.mock('../subject', async (io) => ({ ...(await io()), old: 1 }));")).toHaveLength(0);
  });

  it('CONTROL — silent for an automock, where vitest synthesises the whole surface', () => {
    expect(mockersFor("vi.mock('../subject');")).toHaveLength(0);
  });

  it('CONTROL — silent for the same bad shape on a DIFFERENT module (precision, not zeal)', () => {
    expect(mockersFor("vi.mock('../other-subject', () => ({ old: 1 }));")).toHaveLength(0);
  });

  it('reports the mocking file with the line and the specifier, so it is actionable', () => {
    const [hit] = mockersFor("\nvi.mock('../subject', () => ({ old: 1 }));") as {
      path: string;
      line: number;
      spec: string;
    }[];
    expect(hit).toMatchObject({ path: TEST_PATH, line: 2, spec: '../subject' });
  });

  it('CALIBRATION — fires on a bare workspace package specifier', () => {
    const hits = findEnumeratingMockers({
      moduleSpecifiers: ['@papercusp/sync'],
      testFiles: [TEST_PATH],
      read: () => "vi.mock('@papercusp/sync', () => ({ useSyncQuery: vi.fn() }));",
    }) as unknown[];
    expect(hits).toHaveLength(1);
  });
});

describe('moduleKeyFor / formatNoFindings', () => {
  it('makes a changed source path comparable to a resolved mock specifier', () => {
    expect(moduleKeyFor('packages/x/lib/subject.ts')).toBe('packages/x/lib/subject');
    expect(moduleKeyFor('packages/x/lib/subject.tsx')).toBe('packages/x/lib/subject');
  });

  it('CONTROL — ZERO examined files is NOT reported as a clean bill', () => {
    // The measured false-green class on this tree: git-sync commits the working tree on a
    // schedule, so minutes after an edit the default `--base HEAD` diff is EMPTY. Rendering
    // that identically to a real pass is how `tsc -p .` came to read as green.
    expect(formatNoFindings([], 'HEAD')).toMatch(/NOT CHECKED/);
  });

  it('reports a genuine pass when files were actually compared', () => {
    expect(formatNoFindings(['a.ts'], 'HEAD')).toMatch(/^✓/);
  });
});

describe('formatFindings — the advice an agent actually acts on', () => {
  const FINDINGS = [
    {
      file: 'packages/operator-core/lib/pot/started.ts',
      added: ['mugKettleSystemEnabled'],
      mockers: [
        { path: 'packages/operator-core/lib/pot/watchdog-paused-recovery.test.ts', line: 16, spec: './started' },
      ],
    },
  ];

  it('names the changed module, the mocking file and the command to run it', () => {
    const out = formatFindings(FINDINGS) as string;
    expect(out).toMatch(/mugKettleSystemEnabled/);
    expect(out).toMatch(/watchdog-paused-recovery\.test\.ts/);
    expect(out).toMatch(/npm run test:file --/);
  });

  it('labels importer-triggered bare-package findings distinctly', () => {
    const out = formatFindings([
      {
        file: 'apps/operator/lib/flag-hooks.tsx',
        added: ['onSyncBusEvent'],
        specifier: '@papercusp/sync',
        trigger: 'import',
        mockers: [{ path: 'apps/operator-vite/src/routes/workbench.test.tsx', line: 53, spec: '@papercusp/sync' }],
      },
    ]) as string;
    expect(out).toMatch(/new runtime import from '@papercusp\/sync'/);
    expect(out).toMatch(/onSyncBusEvent/);
  });

  it('warns that a GREEN run is NOT proof — the quiet fail-soft shape (EI-20017608270017874)', () => {
    // The whole point of this guard is "you would not have known to run these". But RUNNING
    // them is only decisive for the LOUD shape (fails to collect). When the module under test
    // swallows its own errors, the missing-export error is caught, the function returns an
    // empty accumulator, and a `expect(x).toEqual([])` "should not act" case PASSES while
    // asserting nothing — measured on watchdog-paused-recovery.test.ts, 2026-08-09.
    //
    // This assertion exists because that caveat is the first line a tidy-up would delete as
    // noise: it is the only part of the output that says a PASS can still be wrong.
    const out = formatFindings(FINDINGS) as string;
    expect(out).toMatch(/GREEN run of these is NOT proof/);
    expect(out).toMatch(/fail-soft try\/catch/);
    expect(out).toMatch(/non-vacuous/);
  });

  it('CONTROL — the caveat is unconditional, not attached to any particular module', () => {
    // A caveat that only fires for the one module it was discovered on would be worse than
    // none: it would read as "this module is special" when the property is about fail-soft
    // consumers generally.
    const other = formatFindings([
      { file: 'packages/x/lib/other.ts', added: ['someExport'], mockers: [{ path: 'packages/x/lib/o.test.ts', line: 1, spec: './other' }] },
    ]) as string;
    expect(other).toMatch(/GREEN run of these is NOT proof/);
  });
});

describe('REAL TREE — the guard executes over this repository', () => {
  it("the guard's own self-test passes against the real implementation", () => {
    const run = spawnSync('node', [SCRIPT, '--self-test'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(`${run.stdout ?? ''}${run.stderr ?? ''}`).toMatch(/all cases passed/);
    expect(run.status).toBe(0);
  });

  it('scans the real tree and reports whether JSON mode actually examined anything', () => {
    // Adding an export is normal and usually harmless, so this guard must never gate a
    // commit. A clean tree still has to return NOT_CHECKED rather than a false JSON green.
    // This run parses whatever the working tree currently differs by.
    const run = spawnSync('node', [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    const parsed = JSON.parse(String(run.stdout));
    expect(parsed).toHaveProperty('base');
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(run.status).toBe(parsed.examined.length > 0 ? 0 : EXIT_NOT_CHECKED);
  });
});

describe('declared additions absent at the comparison base', () => {
  it('examines a present file that did not exist at base instead of returning NOT_CHECKED', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'vimock-export-strands-added-file-'));
    const file = 'packages/operator-core/lib/newly-added.ts';
    try {
      cpSync(path.join(REPO_ROOT, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
      symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
      mkdirSync(path.join(tmp, 'packages/operator-core/lib'), { recursive: true });

      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: tmp,
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        });
      writeFileSync(path.join(tmp, 'README.md'), 'base\n');
      git('init', '-q', '.');
      git('config', 'user.email', 'vimock-export-strands@test.invalid');
      git('config', 'user.name', 'vimock-export-strands');
      git('add', 'scripts', 'README.md');
      git('commit', '-qm', 'base');

      // The declared file is present now but has no before-image at HEAD. The guard must
      // compare it with an empty before-image so JSON reports a checked addition.
      writeFileSync(path.join(tmp, file), 'export const freshRuntime = 1;\n');
      const result = spawnSync(
        'node',
        ['scripts/check-vimock-export-strands.mjs', '--base', 'HEAD', `--files=${file}`, '--json'],
        { cwd: tmp, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      const report = JSON.parse(result.stdout);

      expect(result.error, `guard failed to spawn: ${result.error?.message}`).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('fatal: path');
      expect(report.examined).toEqual([file]);
      expect(report.findings).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
