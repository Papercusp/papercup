/** P-044 (RSR-P-044-A): deriving a proof binding from a recorded test run — pure derivation + scope rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveBindingFromTestRun,
  deriveSubjectSourcePaths,
  expandTestRunBinding,
  FROM_TEST_RUN_MAX_SOURCE_PATHS,
  isTestInfrastructurePath,
  repoRelativeTestPath,
  recordedTestPath,
  testRunBindingSchema,
  type TestRunBindingDeps,
  type TestRunEvidenceRow,
} from './bind-from-test-run';

let root = '';
const SCOPE = { workspaceId: 'ws-1', harnessSlug: 'web' };
const TEST = 'pkg/lib/thing.test.ts';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bind-from-test-run-'));
  await mkdir(path.join(root, 'pkg/lib/__fixtures__'), { recursive: true });
  await mkdir(path.join(root, 'pkg/lib/wide'), { recursive: true });
  await writeFile(path.join(root, 'pkg/lib/thing.ts'), 'export const thing = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/other.ts'), 'export const other = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/lazy.ts'), 'export const lazy = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/types.ts'), 'export type T = number;\n');
  await writeFile(path.join(root, 'pkg/lib/__fixtures__/seed.ts'), 'export const seed = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/sibling.test.ts'), 'export const x = 1;\n');
  await writeFile(
    path.join(root, TEST),
    [
      "import { describe } from 'vitest';",
      "import type { T } from './types';",
      "import { thing } from './thing';",
      "import { other } from './other.js';",
      "import { seed } from './__fixtures__/seed';",
      "import './sibling.test';",
      "// import { ghost } from './ghost';",
      "const { lazy } = await import('./lazy');",
      '',
    ].join('\n'),
  );
  const wide = Array.from({ length: FROM_TEST_RUN_MAX_SOURCE_PATHS + 1 }, (_, i) => `m${i}`);
  await Promise.all(wide.map((m) => writeFile(path.join(root, `pkg/lib/wide/${m}.ts`), 'export const v = 1;\n')));
  await writeFile(
    path.join(root, 'pkg/lib/wide.test.ts'),
    wide.map((m) => `import './wide/${m}';`).join('\n') + '\n',
  );
  await writeFile(path.join(root, 'pkg/lib/bare.test.ts'), "import { describe } from 'vitest';\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(over: Partial<TestRunEvidenceRow> = {}): TestRunEvidenceRow {
  return {
    id: 42,
    file_path: TEST,
    status: 'pass',
    source: 'local',
    harness_slug: 'web',
    workspace_id: 'ws-1',
    commit_sha: 'abcdef0123456789',
    worktree_dirty: false,
    execution_details: { collectionFailed: false },
    finished_at: '2026-09-23T15:00:00Z',
    ...over,
  };
}

const input = (over: Record<string, unknown> = {}) =>
  testRunBindingSchema.parse({ workItemId: 'WI-1', specId: 'SPEC-1', fromTestRun: 42, ...over });

describe('subject files are the first ring of relative runtime imports', () => {
  it('keeps static, .js-spelled and literal dynamic imports; drops type-only, commented, fixture and test imports', () => {
    expect(deriveSubjectSourcePaths(root, TEST)).toEqual(['pkg/lib/lazy.ts', 'pkg/lib/other.ts', 'pkg/lib/thing.ts']);
  });

  it('classifies test infrastructure by file suffix and directory segment', () => {
    expect(isTestInfrastructurePath('a/b.test.ts')).toBe(true);
    expect(isTestInfrastructurePath('a/__fixtures__/x.ts')).toBe(true);
    expect(isTestInfrastructurePath('a/test/helpers.ts')).toBe(true);
    expect(isTestInfrastructurePath('a/testing/helpers.ts')).toBe(false);
    expect(isTestInfrastructurePath('a/b.ts')).toBe(false);
  });

  it('normalizes absolute run paths into the checkout and rejects paths outside it', () => {
    expect(repoRelativeTestPath(root, path.join(root, TEST))).toBe(TEST);
    expect(repoRelativeTestPath(root, `./${TEST}`)).toBe(TEST);
    expect(repoRelativeTestPath(root, '/elsewhere/x.test.ts')).toBeNull();
  });
});

describe('deriveBindingFromTestRun', () => {
  it('derives a test binding whose evidenceRef is the test path and whose adequacy facts come from the run', () => {
    const out = deriveBindingFromTestRun(input(), run(), root, 'run');
    expect(out).toMatchObject({
      ok: true,
      binding: {
        evidenceKind: 'test',
        evidenceRef: TEST,
        testRunId: 42,
        measurement: {
          schemaVersion: 1,
          kind: 'repo-files',
          sourcePaths: ['pkg/lib/lazy.ts', 'pkg/lib/other.ts', 'pkg/lib/thing.ts'],
          testPaths: [TEST],
        },
        details: {
          adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed' },
          testRun: { id: 42, commitSha: 'abcdef0123456789', worktreeDirty: false, harnessAttribution: 'run' },
        },
      },
    });
  });

  it('derives a MUTATION binding from a mutation-probe mutant row: a failed mutant is caught, a passing one survived', () => {
    const mutant = (status: string) =>
      run({ status, source: 'mutation-probe', execution_details: JSON.stringify({ mutationPhase: 'mutant' }) });
    const caught = deriveBindingFromTestRun(input(), mutant('fail'), root, 'run');
    expect(caught).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'mutation', details: { adequacy: { executed: true, outcome: 'caught' } } },
    });
    expect(caught.ok && caught.binding.evidenceRef).toMatch(/^test-run 42 mutation-probe mutant fail pkg\/lib\/thing\.test\.ts @abcdef012345$/);
    expect(deriveBindingFromTestRun(input(), mutant('pass'), root, 'run')).toMatchObject({
      ok: true,
      binding: { details: { adequacy: { outcome: 'survived' } } },
    });
    // The BASELINE half of a probe is ordinary passing test evidence.
    const baseline = run({ source: 'mutation-probe', execution_details: { mutationPhase: 'baseline' } });
    expect(deriveBindingFromTestRun(input(), baseline, root, 'run')).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'test' },
    });
  });

  it('keeps the caller judgment (targeted, layer) and fills only the observable facts', () => {
    const out = deriveBindingFromTestRun(
      input({ details: { adequacy: { targeted: true, testLayer: 'unit', executed: true }, note: 'x' } }),
      run(),
      root,
      'run',
    );
    expect(out).toMatchObject({
      ok: true,
      binding: { details: { note: 'x', adequacy: { targeted: true, testLayer: 'unit', executed: true, outcome: 'passed' } } },
    });
  });

  it('refuses adequacy the run contradicts, naming both values', () => {
    const out = deriveBindingFromTestRun(input({ details: { adequacy: { outcome: 'passed' } } }), run({ status: 'fail' }), root, 'run');
    expect(out).toMatchObject({ ok: false, error: 'run_contradicts_declared_adequacy' });
    expect(!out.ok && out.message).toContain('outcome="failed"');
  });

  it('reports a collection failure as not collected and a skip as skipped', () => {
    expect(
      deriveBindingFromTestRun(input(), run({ status: 'fail', execution_details: { collectionFailed: true } }), root, 'run'),
    ).toMatchObject({ ok: true, binding: { details: { adequacy: { collected: false, executed: true } } } });
    expect(deriveBindingFromTestRun(input(), run({ status: 'skip' }), root, 'run')).toMatchObject({
      ok: true,
      binding: { details: { adequacy: { skipped: true, executed: false, outcome: 'skipped' } } },
    });
  });

  it('refuses an unfinished run, an out-of-checkout file, and an underivable subject set', () => {
    expect(deriveBindingFromTestRun(input(), run({ status: 'running' }), root, 'run')).toMatchObject({
      ok: false,
      error: 'test_run_unfinished',
    });
    expect(deriveBindingFromTestRun(input(), run({ file_path: '/elsewhere/x.test.ts' }), root, 'run')).toMatchObject({
      ok: false,
      error: 'test_run_file_outside_root',
    });
    expect(deriveBindingFromTestRun(input(), run({ file_path: 'pkg/lib/bare.test.ts' }), root, 'run')).toMatchObject({
      ok: false,
      error: 'source_paths_underivable',
    });
    const wide = deriveBindingFromTestRun(input(), run({ file_path: 'pkg/lib/wide.test.ts' }), root, 'run');
    expect(wide).toMatchObject({ ok: false, error: 'source_paths_underivable' });
    expect(!wide.ok && wide.message).toContain(`${FROM_TEST_RUN_MAX_SOURCE_PATHS}-path measurement cap`);
  });

  it('lets an explicit sourcePaths override the derivation (and covers the underivable cases)', () => {
    expect(
      deriveBindingFromTestRun(input({ sourcePaths: ['pkg/lib/wide/m1.ts'] }), run({ file_path: 'pkg/lib/wide.test.ts' }), root, 'run'),
    ).toMatchObject({ ok: true, binding: { measurement: { sourcePaths: ['pkg/lib/wide/m1.ts'] } } });
  });
});

describe('expandTestRunBinding: harness attribution', () => {
  function deps(row: TestRunEvidenceRow | null, adopt = true) {
    const calls = { adopt: 0 };
    const d: TestRunBindingDeps = {
      loadRun: async () => row,
      adoptRun: async () => {
        calls.adopt += 1;
        return adopt;
      },
      resolveRoot: async () => root,
    };
    return { d, calls };
  }

  it('adopts a harness-NULL local run into the caller scope', async () => {
    const { d, calls } = deps(run({ harness_slug: null, workspace_id: null }));
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({ ok: true, attribution: 'adopted-caller-harness' });
    expect(calls.adopt).toBe(1);
  });

  it('uses the recorded nested workspace before a same-named root file and derives its actual imports', async () => {
    const nested = path.join(root, 'libs/child');
    await mkdir(path.join(nested, 'pkg/lib'), { recursive: true });
    await writeFile(path.join(nested, TEST), "import './nested-subject';\n");
    await writeFile(path.join(nested, 'pkg/lib/nested-subject.ts'), 'export const nested = true;\n');
    const { d } = deps(run({ root: nested }));
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({
      ok: true,
      binding: {
        evidenceRef: `libs/child/${TEST}`,
        measurement: { testPaths: [`libs/child/${TEST}`], sourcePaths: ['libs/child/pkg/lib/nested-subject.ts'] },
        details: { testRun: { recordedRoot: nested, recordedFilePath: TEST } },
      },
    });
  });

  it.each(['ci', 'admin-ui'])('never adopts a %s row (harness-NULL by design)', async (source) => {
    const { d, calls } = deps(run({ harness_slug: null, workspace_id: null, source }));
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({ ok: false, error: 'test_run_not_adoptable' });
    expect(calls.adopt).toBe(0);
  });

  it('refuses when a racer adopted the run elsewhere', async () => {
    const { d } = deps(run({ harness_slug: null }), false);
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({ ok: false, error: 'test_run_not_adoptable' });
  });

  it('refuses a run attributed to another harness or workspace, and a missing run', async () => {
    expect(await expandTestRunBinding(input(), SCOPE, deps(run({ harness_slug: 'api' })).d)).toMatchObject({
      ok: false,
      error: 'test_run_out_of_scope',
    });
    expect(await expandTestRunBinding(input(), SCOPE, deps(run({ workspace_id: 'ws-2' })).d)).toMatchObject({
      ok: false,
      error: 'test_run_out_of_scope',
    });
    expect(await expandTestRunBinding(input(), SCOPE, deps(null).d)).toMatchObject({ ok: false, error: 'test_run_not_found' });
  });
});

describe('recorded test paths across worktrees', () => {
  const canonical = '/repos/main';
  const checkpoint = '/repos/checkpoint';
  const nested = `${checkpoint}/libs/child`;
  const git = async (cwd: string, args: readonly string[]) => {
    const command = args.join(' ');
    if (command === 'rev-parse --path-format=absolute --git-common-dir') {
      return cwd === nested ? `${canonical}/.git/modules/child` : `${canonical}/.git`;
    }
    if (cwd === nested && command === 'rev-parse --show-superproject-working-tree') return checkpoint;
    if (cwd === checkpoint && command === 'rev-parse --show-toplevel') return checkpoint;
    throw new Error(`unexpected git probe: ${cwd} ${command}`);
  };

  it('preserves the nested prefix when a recorded worktree shares the harness superproject', async () => {
    expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, git)).toBe(`libs/child/${TEST}`);
    expect(await recordedTestPath(canonical, { root: nested, file_path: `${nested}/${TEST}` }, git)).toBe(`libs/child/${TEST}`);
  });

  it('rejects unrelated repositories, missing checkout identity and workspace escapes', async () => {
    const foreignGit = async (_cwd: string, args: readonly string[]) =>
      args.includes('--git-common-dir') ? `/unrelated/${_cwd === canonical ? 'a' : 'b'}/.git` : '';
    expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, foreignGit)).toBeNull();
    expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, async () => { throw new Error('missing'); })).toBeNull();
    expect(await recordedTestPath(canonical, { root: nested, file_path: `../${TEST}` }, git)).toBeNull();
    expect(await recordedTestPath(canonical, { root: nested, file_path: `${canonical}/${TEST}` }, git)).toBeNull();
  });
});

describe('testRunBindingSchema', () => {
  it('is strict: a hand-built field alongside fromTestRun is rejected rather than silently dropped', () => {
    expect(testRunBindingSchema.safeParse({ workItemId: 'WI-1', specId: 'S', fromTestRun: 1, evidenceRef: 'x' }).success).toBe(false);
    expect(testRunBindingSchema.safeParse({ workItemId: 'WI-1', fromTestRun: 1 }).success).toBe(false);
  });
});
