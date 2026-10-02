/** P-044 (RSR-P-044-A): deriving a proof binding from a recorded test run — pure derivation + scope rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  asCommittedTestPath,
  deriveBindingFromTestRun,
  deriveSubjectSourcePaths,
  expandTestRunBinding,
  FROM_TEST_RUN_MAX_SOURCE_PATHS,
  isTestInfrastructurePath,
  measuredFileModifiedAfterRun,
  measurementLowerBound,
  repoRelativeTestPath,
  recordedTestPath,
  testRunBindingSchema,
  withRepoIdentityMemo,
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
  it('rejects integration testimony for an observed unit run, including JSON-string ledger details', () => {
    const row = run({ execution_details: JSON.stringify({ schemaVersion: 1, testLayer: 'unit' }) });
    expect(deriveBindingFromTestRun(input({ details: { adequacy: { testLayer: 'integration' } } }), row, root, 'run'))
      .toMatchObject({ ok: false, error: 'run_contradicts_declared_adequacy' });
    expect(deriveBindingFromTestRun(input(), row, root, 'run'))
      .toMatchObject({ ok: true, binding: { details: { adequacy: { testLayer: 'unit' } } } });
  });

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
    // WI-10004591: a caller-declared mutation binding over a row that is NOT a raw mutant run
    // (a testing:record-run operational record of a whole probe invocation) carries the probe's
    // VERDICT — a passing record is a CAUGHT mutant, never `survived`.
    const verdict = (status: string) => run({ status, source: 'local', execution_details: { framework: 'shell' } });
    expect(deriveBindingFromTestRun(input({ evidenceKind: 'mutation' }), verdict('pass'), root, 'run')).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'mutation', details: { adequacy: { executed: true, outcome: 'caught' } } },
    });
    const failedVerdict = deriveBindingFromTestRun(input({ evidenceKind: 'mutation' }), verdict('fail'), root, 'run');
    expect(failedVerdict.ok && failedVerdict.binding.details.adequacy).toMatchObject({ outcome: 'fail' });
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

  it('reports a local run source restriction instead of claiming its matching canonical path mismatches', async () => {
    const { d } = deps(run({ root, file_path: path.join(root, TEST) }));
    const out = await expandTestRunBinding(input({ canonicalTestPath: TEST }), SCOPE, d);
    expect(out).toMatchObject({ ok: false, error: 'test_run_canonical_path_source_unsupported' });
    if (!out.ok) {
      expect(out.message).toContain('only supported for mutation-probe copy-out runs');
      expect(out.message).toContain('source "local"');
      expect(out.message).toContain('Omit canonicalTestPath');
      expect(out.message).not.toContain('does not match');
    }
  });

  it('binds a copy-out mutation row through an explicit canonical test path after its mirror is removed', async () => {
    const mirror = path.join(tmpdir(), 'mutation-probe-removed', 'mirror');
    const canonical = `libs/generic/tooldef/${TEST}`;
    await mkdir(path.join(root, 'libs/generic/tooldef/pkg/lib'), { recursive: true });
    await writeFile(path.join(root, canonical), "import './subject';\n");
    await writeFile(path.join(root, 'libs/generic/tooldef/pkg/lib/subject.ts'), 'export const subject = true;\n');
    const { d } = deps(run({ root: mirror, source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } }));
    expect(await expandTestRunBinding(input({ canonicalTestPath: canonical }), SCOPE, d)).toMatchObject({
      ok: true,
      binding: {
        evidenceKind: 'mutation',
        evidenceRef: expect.stringContaining(canonical),
        testRunId: 42,
        measurement: {
          testPaths: [canonical],
          sourcePaths: ['libs/generic/tooldef/pkg/lib/subject.ts'],
        },
        details: { testRun: { recordedRoot: mirror, recordedFilePath: TEST, canonicalTestPathOverride: canonical } },
      },
    });
  });

  // EI-24826121815486916: the store pins the checkout's bytes at bind time, so a run whose
  // measured files changed after it started would bind `current` for code it never executed.
  describe('measured files modified after the run started', () => {
    const GUARD_TEST = 'pkg/guard/guard.test.ts';
    const GUARD_SUBJECT = 'pkg/guard/subject.ts';
    const STARTED = '2026-09-23T15:00:00.000Z';
    const before = new Date('2026-09-23T14:00:00Z');
    const after = new Date('2026-09-23T16:00:00Z');

    beforeAll(async () => {
      await mkdir(path.join(root, 'pkg/guard'), { recursive: true });
      await writeFile(path.join(root, GUARD_SUBJECT), 'export const subject = 1;\n');
      await writeFile(path.join(root, GUARD_TEST), "import { subject } from './subject';\n");
    });

    async function stamp(subjectAt: Date, testAt = before) {
      await utimes(path.join(root, GUARD_SUBJECT), subjectAt, subjectAt);
      await utimes(path.join(root, GUARD_TEST), testAt, testAt);
    }

    const dirtyMutant = () =>
      run({
        file_path: GUARD_TEST,
        source: 'mutation-probe',
        worktree_dirty: true,
        started_at: STARTED,
        execution_details: { mutationPhase: 'mutant' },
      });

    it('refuses a dirty mutant run whose subject was edited after it started, naming the path and both times', async () => {
      await stamp(after);
      const out = await expandTestRunBinding(input(), SCOPE, deps(dirtyMutant()).d);
      expect(out).toMatchObject({ ok: false, error: 'test_run_source_modified_after_run', testRunId: 42 });
      if (!out.ok) {
        expect(out.message).toContain(GUARD_SUBJECT);
        expect(out.message).toContain(STARTED);
        expect(out.message).toContain(after.toISOString());
        expect(out.message).toContain('Re-run the test');
      }
    });

    it('binds the same run when every measured file predates its start (positive control)', async () => {
      await stamp(before);
      expect(await expandTestRunBinding(input(), SCOPE, deps(dirtyMutant()).d)).toMatchObject({
        ok: true,
        binding: { evidenceKind: 'mutation', measurement: { testPaths: [GUARD_TEST], sourcePaths: [GUARD_SUBJECT] } },
      });
    });

    it('also guards the test file itself, and clean runs in this checkout', async () => {
      await stamp(before, after);
      const clean = run({ file_path: GUARD_TEST, started_at: STARTED });
      expect(await expandTestRunBinding(input(), SCOPE, deps(clean).d)).toMatchObject({
        ok: false,
        error: 'test_run_source_modified_after_run',
        message: expect.stringContaining(GUARD_TEST),
      });
    });

    // EI-24827834166866368: started_at is finished_at - duration, so it postdates collection.
    // An edit after vitest read the subject but before the file's tests started sits between
    // the run-wide start and started_at, and only the run-wide start can see it.
    describe('an edit during collection (between the run start and started_at)', () => {
      const RUN_STARTED = '2026-09-23T14:30:00.000Z';
      const duringCollection = new Date('2026-09-23T14:45:00Z');

      it('is refused when the row records the run-wide start, judged against that start', async () => {
        await stamp(duringCollection);
        const row = run({
          file_path: GUARD_TEST,
          source: 'mutation-probe',
          worktree_dirty: true,
          started_at: STARTED,
          execution_details: { mutationPhase: 'mutant', runStartedAt: RUN_STARTED },
        });
        const out = await expandTestRunBinding(input(), SCOPE, deps(row).d);
        expect(out).toMatchObject({ ok: false, error: 'test_run_source_modified_after_run', testRunId: 42 });
        if (!out.ok) {
          expect(out.message).toContain(GUARD_SUBJECT);
          expect(out.message).toContain(RUN_STARTED);
          expect(out.message).toContain(duringCollection.toISOString());
        }
      });

      it('still passes on a legacy row without the run-wide start (the known blind spot, pinned)', async () => {
        await stamp(duringCollection);
        expect(await expandTestRunBinding(input(), SCOPE, deps(dirtyMutant()).d)).toMatchObject({ ok: true });
      });
    });

    it('measurementLowerBound takes the earlier readable instant and ignores unreadable ones', () => {
      expect(measurementLowerBound(STARTED, { runStartedAt: '2026-09-23T14:30:00.000Z' })?.toISOString()).toBe(
        '2026-09-23T14:30:00.000Z',
      );
      // A run start LATER than started_at is never allowed to narrow the window.
      expect(measurementLowerBound(STARTED, { runStartedAt: '2026-09-23T16:00:00.000Z' })?.toISOString()).toBe(STARTED);
      // The jsonb-string storage shape is read too.
      expect(
        measurementLowerBound(STARTED, JSON.stringify({ runStartedAt: '2026-09-23T14:30:00.000Z' }))?.toISOString(),
      ).toBe('2026-09-23T14:30:00.000Z');
      expect(measurementLowerBound(STARTED, { runStartedAt: 'garbage' })?.toISOString()).toBe(STARTED);
      expect(measurementLowerBound(new Date(STARTED), null)?.toISOString()).toBe(STARTED);
      expect(measurementLowerBound(null, { runStartedAt: '2026-09-23T14:30:00.000Z' })?.toISOString()).toBe(
        '2026-09-23T14:30:00.000Z',
      );
      expect(measurementLowerBound(undefined, { runStartedAt: 42 })).toBeNull();
      expect(measurementLowerBound('not-a-date', undefined)).toBeNull();
    });

    it('cannot judge without a start time, and leaves a missing file to the store', async () => {
      await stamp(after);
      expect(await measuredFileModifiedAfterRun(root, [GUARD_SUBJECT], undefined)).toBeNull();
      expect(await measuredFileModifiedAfterRun(root, ['pkg/guard/missing.ts'], STARTED)).toBeNull();
      expect(await measuredFileModifiedAfterRun(root, ['pkg/guard/missing.ts', GUARD_SUBJECT], STARTED)).toMatchObject({
        path: GUARD_SUBJECT,
        startedAt: STARTED,
      });
    });
  });

  it('rejects a copy-out override that changes the recorded relative test or names a missing file', async () => {
    const { d } = deps(run({ root: '/tmp/mutation-probe-removed/mirror', source: 'mutation-probe' }));
    expect(await expandTestRunBinding(input({ canonicalTestPath: 'pkg/lib/other.test.ts' }), SCOPE, d))
      .toMatchObject({ ok: false, error: 'test_run_canonical_path_mismatch' });
    expect(await expandTestRunBinding(input({ canonicalTestPath: `missing/${TEST}` }), SCOPE, d))
      .toMatchObject({ ok: false, error: 'test_run_file_outside_root' });
    expect(await expandTestRunBinding(input({ canonicalTestPath: TEST }), SCOPE, deps(run({ root: '/tmp/other/mirror' })).d))
      .toMatchObject({ ok: false, error: 'test_run_canonical_path_source_unsupported' });
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

  it('WI-10005436: a binding loop forks each repository-identity read once, not once per row', async () => {
    const calls: string[] = [];
    const counting = async (cwd: string, args: readonly string[]) => {
      calls.push(`${cwd} ${args.join(' ')}`);
      return git(cwd, args);
    };
    for (let row = 0; row < 5; row += 1) {
      expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, counting)).toBe(`libs/child/${TEST}`);
    }
    // One pass is 4 identity reads (canonical common dir, nested common dir, nested superproject,
    // checkpoint common dir) + 1 top level; five rows must not cost five passes.
    expect(calls).toHaveLength(5);
    expect(new Set(calls).size).toBe(5);
  });

  it('WI-10005436: identity answers expire, failures are never reused, and other reads pass through', async () => {
    let t = 0;
    let fail = true;
    const calls: string[] = [];
    const base = async (cwd: string, args: readonly string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'cat-file') return '';
      if (fail) throw new Error('not a repository');
      return cwd;
    };
    const memo = withRepoIdentityMemo(base, { ttlMs: 1_000, now: () => t });
    const top = ['rev-parse', '--show-toplevel'];
    await expect(memo('/r', top)).rejects.toThrow('not a repository');
    fail = false;
    expect(await memo('/r', top)).toBe('/r'); // the failure was not cached
    expect(await memo('/r', top)).toBe('/r'); // the success was
    expect(calls.filter((c) => c === top.join(' '))).toHaveLength(2);
    t = 1_000;
    expect(await memo('/r', top)).toBe('/r'); // expired: asked again
    expect(calls.filter((c) => c === top.join(' '))).toHaveLength(3);
    await memo('/r', ['cat-file', '-e', `${'a'.repeat(40)}:x`]);
    await memo('/r', ['cat-file', '-e', `${'a'.repeat(40)}:x`]);
    expect(calls.filter((c) => c.startsWith('cat-file'))).toHaveLength(2); // content reads are not memoized here
    expect(await withRepoIdentityMemo(base, { ttlMs: 1_000, now: () => t })('/other', top)).toBe('/other'); // keyed by cwd
  });
});

describe('WI-10004898: a clean run in a deleted disposable clone binds by commit content', () => {
  // Real git, because the whole claim is about repository identity: the clone the run
  // executed in is gone by bind time, so only the harness repo's own objects can vouch.
  let harness = '';
  let superCommit = '';
  let subCommit = '';
  const SUB = 'libs/generic/search';
  const g = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const goneClone = (sha: string) => `/tmp/papercusp-lint-as-committed-${sha.slice(0, 10)}-gone${process.pid}`;
  const cleanRow = (over: Partial<TestRunEvidenceRow> = {}) =>
    run({ file_path: 'pkg/lib/x.test.ts', commit_sha: superCommit, worktree_dirty: false, root: goneClone(superCommit), ...over });
  const binder = (row: TestRunEvidenceRow): TestRunBindingDeps => ({
    loadRun: async () => row,
    adoptRun: async () => true,
    resolveRoot: async () => harness,
  });

  beforeAll(async () => {
    harness = await mkdtemp(path.join(tmpdir(), 'bind-as-committed-'));
    const sub = path.join(harness, SUB);
    await mkdir(path.join(sub, 'src'), { recursive: true });
    await writeFile(path.join(sub, 'src/s.ts'), 'export const s = 1;\n');
    await writeFile(path.join(sub, 'src/s.test.ts'), "import { s } from './s';\nvoid s;\n");
    g(sub, 'init', '-q');
    g(sub, 'add', '-A');
    g(sub, 'commit', '-qm', 'sub');
    subCommit = g(sub, 'rev-parse', 'HEAD');
    await mkdir(path.join(harness, 'pkg/lib'), { recursive: true });
    await writeFile(path.join(harness, 'pkg/lib/x.ts'), 'export const x = 1;\n');
    await writeFile(path.join(harness, 'pkg/lib/x.test.ts'), "import { x } from './x';\nvoid x;\n");
    g(harness, 'init', '-q');
    // `add` of an embedded repository records a 160000 gitlink pinned at subCommit.
    g(harness, 'add', 'pkg', SUB);
    g(harness, 'commit', '-qm', 'super');
    superCommit = g(harness, 'rev-parse', 'HEAD');
  });

  afterAll(async () => {
    await rm(harness, { recursive: true, force: true });
  });

  it('maps a superproject clone run, and a submodule clone run under its submodule prefix', async () => {
    expect(await asCommittedTestPath(harness, cleanRow())).toEqual({
      testPath: 'pkg/lib/x.test.ts', repoPrefix: '', commitSha: superCommit,
    });
    const subRow = cleanRow({ root: `${goneClone(subCommit)}/${SUB}`, file_path: 'src/s.test.ts', commit_sha: subCommit });
    expect(await asCommittedTestPath(harness, subRow)).toEqual({
      testPath: `${SUB}/src/s.test.ts`, repoPrefix: SUB, commitSha: subCommit,
    });
  });

  it('never maps a dirty, commit-less, foreign-commit, absent-file or plain-directory run', async () => {
    expect(await asCommittedTestPath(harness, cleanRow({ worktree_dirty: true }))).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ worktree_dirty: null }))).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ commit_sha: null }))).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ commit_sha: 'f'.repeat(40) }))).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ file_path: 'pkg/lib/missing.test.ts' }))).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ file_path: '../escape.test.ts' }))).toBeNull();
    // `pkg` is a plain directory of the superproject, not a repository root: re-anchoring
    // `lib/x.test.ts` under it would invent a path the run never named.
    expect(await asCommittedTestPath(harness, cleanRow({ root: `${goneClone(superCommit)}/pkg`, file_path: 'lib/x.test.ts' }))).toBeNull();
  });

  it('binds through expandTestRunBinding, records the mapping, and verifies content across a pinned gitlink', async () => {
    const row = cleanRow();
    const bound = await expandTestRunBinding(input({ sourcePaths: ['pkg/lib/x.ts', `${SUB}/src/s.ts`] }), SCOPE, binder(row));
    expect(bound).toMatchObject({ ok: true });
    if (!bound.ok) return;
    expect(bound.binding.evidenceRef).toBe('pkg/lib/x.test.ts');
    expect(bound.binding.details.testRun).toMatchObject({
      recordedRoot: row.root,
      asCommitted: { commitSha: superCommit, repoPrefix: '', contentVerified: true },
    });
    const subRow = cleanRow({ root: `${goneClone(subCommit)}/${SUB}`, file_path: 'src/s.test.ts', commit_sha: subCommit });
    expect(await expandTestRunBinding(input(), SCOPE, binder(subRow))).toMatchObject({
      ok: true,
      binding: { evidenceRef: `${SUB}/src/s.test.ts`, measurement: { sourcePaths: [`${SUB}/src/s.ts`] } },
    });
  });

  it('refuses when a measured file here no longer matches the commit the clone ran', async () => {
    const file = path.join(harness, 'pkg/lib/x.ts');
    await writeFile(file, 'export const x = 2;\n');
    try {
      const refused = await expandTestRunBinding(input(), SCOPE, binder(cleanRow()));
      expect(refused).toMatchObject({ ok: false, error: 'test_run_as_committed_content_mismatch' });
      expect(refused.ok ? '' : refused.message).toContain('pkg/lib/x.ts differs from its content at');
      const outside = await expandTestRunBinding(
        input({ sourcePaths: ['pkg/lib/x.ts'] }),
        SCOPE,
        binder(cleanRow({ root: `${goneClone(subCommit)}/${SUB}`, file_path: 'src/s.test.ts', commit_sha: subCommit })),
      );
      expect(outside).toMatchObject({ ok: false, error: 'test_run_as_committed_content_mismatch' });
      expect(outside.ok ? '' : outside.message).toContain(`lies outside the run's repository ${SUB}`);
    } finally {
      await writeFile(file, 'export const x = 1;\n');
    }
    expect(await expandTestRunBinding(input(), SCOPE, binder(cleanRow()))).toMatchObject({ ok: true });
  });

  it('still refuses an unmappable clean run, naming the commit it checked', async () => {
    const refused = await expandTestRunBinding(input(), SCOPE, binder(cleanRow({ commit_sha: 'e'.repeat(40) })));
    expect(refused).toMatchObject({ ok: false, error: 'test_run_file_outside_root' });
    expect(refused.ok ? '' : refused.message).toContain(`Its clean commit ${'e'.repeat(12)} does not contain that file`);
  });

  describe('a CLEAN copy-out mutation row bound by canonicalTestPath is verified against its commit', () => {
    const mirrorRow = (over: Partial<TestRunEvidenceRow> = {}) =>
      cleanRow({
        root: path.join(tmpdir(), `mutation-probe-gone${process.pid}`, 'mirror', 'pkg'),
        file_path: 'lib/x.test.ts',
        source: 'mutation-probe',
        execution_details: { mutationPhase: 'mutant' },
        ...over,
      });
    const canonical = input({ canonicalTestPath: 'pkg/lib/x.test.ts', sourcePaths: ['pkg/lib/x.ts'] });

    it('binds with contentVerified when this checkout still holds the commit content', async () => {
      const bound = await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow()));
      expect(bound).toMatchObject({ ok: true, binding: { evidenceKind: 'mutation', evidenceRef: expect.stringContaining('pkg/lib/x.test.ts') } });
      if (!bound.ok) return;
      expect(bound.binding.details.testRun).toMatchObject({
        canonicalTestPathOverride: 'pkg/lib/x.test.ts',
        asCommitted: { commitSha: superCommit, repoPrefix: '', contentVerified: true },
      });
    });

    it('THE BUG: refuses when the subject here differs from what the mutant ran (a peer edited it since)', async () => {
      const file = path.join(harness, 'pkg/lib/x.ts');
      await writeFile(file, 'export const x = 2;\n');
      try {
        const refused = await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow()));
        expect(refused).toMatchObject({ ok: false, error: 'test_run_as_committed_content_mismatch' });
        expect(refused.ok ? '' : refused.message).toContain('pkg/lib/x.ts differs from its content at');
        // A dirty or commit-less row proves no commit, so it keeps the checkout pin (and stays dirty evidence).
        expect(await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow({ worktree_dirty: true })))).toMatchObject({ ok: true });
        expect(await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow({ commit_sha: null })))).toMatchObject({ ok: true });
      } finally {
        await writeFile(file, 'export const x = 1;\n');
      }
    });

    describe('WI-10004978: a copy-out probe of a SUBMODULE file carries the submodule commit', () => {
      const subMirrorRow = (over: Partial<TestRunEvidenceRow> = {}) =>
        mirrorRow({
          root: path.join(tmpdir(), `mutation-probe-gone${process.pid}`, 'mirror', SUB),
          file_path: 'src/s.test.ts',
          commit_sha: subCommit,
          ...over,
        });
      const subCanonical = () =>
        input({ canonicalTestPath: `${SUB}/src/s.test.ts`, sourcePaths: [`${SUB}/src/s.ts`] });

      it('resolves the commit in the submodule checkout, not the superproject', async () => {
        const bound = await expandTestRunBinding(subCanonical(), SCOPE, binder(subMirrorRow()));
        expect(bound).toMatchObject({ ok: true, binding: { evidenceKind: 'mutation' } });
        if (!bound.ok) return;
        expect(bound.binding.details.testRun).toMatchObject({
          canonicalTestPathOverride: `${SUB}/src/s.test.ts`,
          asCommitted: { commitSha: subCommit, repoPrefix: SUB, contentVerified: true },
        });
      });

      it('still refuses when the submodule subject drifted from the commit the mutant ran', async () => {
        const file = path.join(harness, SUB, 'src/s.ts');
        await writeFile(file, 'export const s = 2;\n');
        try {
          const refused = await expandTestRunBinding(subCanonical(), SCOPE, binder(subMirrorRow()));
          expect(refused).toMatchObject({ ok: false, error: 'test_run_as_committed_content_mismatch' });
          expect(refused.ok ? '' : refused.message).toContain(`${SUB}/src/s.ts differs from its content at`);
        } finally {
          await writeFile(file, 'export const s = 1;\n');
        }
      });

      it('a superproject commit still resolves through the gitlink it pins', async () => {
        const bound = await expandTestRunBinding(subCanonical(), SCOPE, binder(subMirrorRow({ commit_sha: superCommit })));
        expect(bound).toMatchObject({ ok: true });
        if (!bound.ok) return;
        expect(bound.binding.details.testRun).toMatchObject({
          asCommitted: { commitSha: superCommit, repoPrefix: '', contentVerified: true },
        });
      });
    });
  });
});

describe('testRunBindingSchema', () => {
  it('is strict: a hand-built field alongside fromTestRun is rejected rather than silently dropped', () => {
    expect(testRunBindingSchema.safeParse({ workItemId: 'WI-1', specId: 'S', fromTestRun: 1, evidenceRef: 'x' }).success).toBe(false);
    expect(testRunBindingSchema.safeParse({ workItemId: 'WI-1', fromTestRun: 1 }).success).toBe(false);
  });
});
