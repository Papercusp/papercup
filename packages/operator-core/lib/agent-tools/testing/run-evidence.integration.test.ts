import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BindSpecEvidenceInput } from '../plans/spec-evidence-store';
import { REPO_ROOT } from '../docs/_repo-paths';

const phases = vi.hoisted(() => ({ prepare: vi.fn(), finish: vi.fn() }));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  prepareTestEvidence: phases.prepare,
  finishTestEvidence: phases.finish,
}));
vi.mock('../../testing-run-store', async (original) => ({
  ...(await original<typeof import('../../testing-run-store')>()),
  findHarnessTestRunIds: vi.fn().mockResolvedValue([77]),
}));

import runTool from './run';

const roots: string[] = [];
afterEach(async () => {
  phases.prepare.mockReset();
  phases.finish.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('the public run handler prepares mappings before real execution and returns the persisted completion bundle', async () => {
  const parent = join(REPO_ROOT, '.papercusp', 'tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'testing-run-evidence-handler-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'feature.ts'), 'export const answer = 42;\n');
  const declarationPath = join(root, 'declared.json');
  // This fresh child fixture fails if the public handler starts execution before
  // recording the mapping. It does not rerun an unrelated repository test suite.
  await writeFile(join(root, 'feature.test.ts'), [
    "import { expect, it } from 'vitest';",
    "import { readFileSync } from 'node:fs';",
    "import { answer } from './feature';",
    "it('observes the declaration before executing the feature', () => {",
    `  const declared = JSON.parse(readFileSync(${JSON.stringify(declarationPath)}, 'utf8'));`,
    "  expect(declared).toEqual({ specId: 'SPEC-001', causalPairId: 'original-failure' });",
    '  expect(answer).toBe(42);',
    '});',
  ].join('\n'));

  const actual = await vi.importActual<typeof import('./evidence')>('./evidence');
  const { measureRepoFilesEvidenceAtRoot } = await import('../plans/spec-evidence-store');
  const stored: BindSpecEvidenceInput[] = [];
  const deps = {
    bind: vi.fn(async (input: BindSpecEvidenceInput) => {
      stored.push(input);
      if (stored.length === 1) {
        await writeFile(declarationPath, JSON.stringify({ specId: input.specId, causalPairId: 'original-failure' }));
      }
      return { status: 'created' as const, id: stored.length, workItemId: input.workItemId,
        planSlug: input.planSlug!, specId: input.specId!, sourceValId: null, specRevision: input.specRevision!,
        specFingerprint: 'fixture-spec', bindingFingerprint: `fixture-binding-${stored.length}` };
    }),
    measure: measureRepoFilesEvidenceAtRoot,
    ledger: vi.fn().mockResolvedValue([
      { id: 77, file_path: 'feature.test.ts', status: 'pass', finished_at: '2026-09-09T00:00:00Z' },
    ]),
    list: vi.fn().mockResolvedValue([]),
    unattributed: vi.fn().mockResolvedValue(0),
    // A settled row retires its pending twin; with no retract dependency that step
    // reports `retraction_unavailable` and the bundle can never be `recorded`.
    retract: vi.fn(),
  };
  phases.prepare.mockImplementation((request, runId, files, scope) =>
    actual.prepareTestEvidence(request, runId, files, scope, deps));
  phases.finish.mockImplementation((prepared, originRunId, runId, scope, result) =>
    actual.finishTestEvidence(prepared, originRunId, runId, scope, result, deps));
  const evidence = { workItemId: 'WI-handler', planSlug: 'handler-plan', bindings: [{
    specId: 'SPEC-001', specRevision: 1, testPath: 'feature.test.ts', sourcePaths: ['feature.ts'],
    testLayer: 'integration' as const, causalPairId: 'original-failure',
  }] };
  const ctx = { projectDir: root, workspaceId: 'handler-workspace', uiClientId: 'su-handler-test',
    isSuperuser: true } as const;
  // A real execution without declaration is the negative control. It fails for
  // the missing declaration, not because the feature or test runner is absent.
  const undeclared = await runTool.handler(runTool.args.parse({ files: ['feature.test.ts'], harness: 'handler-harness' }),
    ctx as never) as { data: Record<string, any> };
  expect(undeclared.data).toMatchObject({ ok: false, failed: 1 });
  expect(undeclared.data.failures).toContainEqual(expect.objectContaining({
    test: 'observes the declaration before executing the feature', message: expect.stringContaining('declared.json'),
  }));
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(stored).toHaveLength(0);
  const args = runTool.args.parse({ files: ['feature.test.ts'], harness: 'handler-harness', evidence });
  const result = await runTool.handler(args, ctx as never) as { data: Record<string, any> };

  expect(result.data).toMatchObject({ ok: true, passed: 1, failed: 0, files: 1 });
  expect(phases.prepare).toHaveBeenCalledExactlyOnceWith(evidence, result.data.runId, ['feature.test.ts'],
    expect.objectContaining({ root, workspaceId: 'handler-workspace', harnessSlug: 'handler-harness' }));
  expect(phases.finish).toHaveBeenCalledExactlyOnceWith(expect.any(Array), result.data.runId, result.data.runId,
    expect.objectContaining({ root, workspaceId: 'handler-workspace', harnessSlug: 'handler-harness' }),
    expect.objectContaining({ ok: true, passed: 1, failed: 0 }));
  expect(stored).toHaveLength(2);
  expect(stored[0]).toMatchObject({ workItemId: 'WI-handler', specId: 'SPEC-001',
    details: { adequacy: { outcome: 'pending', executed: false, causalPairIds: ['original-failure'] } } });
  expect(stored[1]).toMatchObject({ workItemId: 'WI-handler', specId: 'SPEC-001', testRunId: 77,
    details: { adequacy: { outcome: 'pass', executed: true, causalPairIds: ['original-failure'] } } });
  expect(result.data.evidenceBundle).toMatchObject({ status: 'recorded', acceptance: 'requires-review',
    total: 1, rows: [{ specId: 'SPEC-001', specRevision: 1, testRunId: 77, phase: 'settled', outcome: 'pass' }] });
  expect(result.data.evidenceBundle.rows[0].evidenceRef).toBe(stored[1]!.evidenceRef);
  expect(JSON.parse(await readFile(declarationPath, 'utf8'))).toHaveProperty('specId', 'SPEC-001');
}, 90_000);
