import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// EI-24100872054224181: a testing:run { evidence } refused by the mutation-probe fence used to
// register pending spec-evidence rows first and then FINISH them, leaving two never-settling
// rows per binding that remeasure skipped as run-in-flight until someone retracted them by hand.
const phases = vi.hoisted(() => ({
  fence: vi.fn(),
  prepare: vi.fn(),
  finish: vi.fn(),
  retract: vi.fn(),
}));
vi.mock('./mutation-probe-fence', () => ({ mutationProbeRefusal: phases.fence }));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  prepareTestEvidence: phases.prepare,
  finishTestEvidence: phases.finish,
  retractRefusedTestEvidence: phases.retract,
}));

import runTool from './run';

const refusal = { error: 'mutation_probe_active' as const, hint: 'active mutation probe on src/feature.ts' };
const roots: string[] = [];
afterEach(async () => {
  Object.values(phases).forEach((mock) => mock.mockReset());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke() {
  const root = await mkdtemp(join(tmpdir(), 'testing-run-evidence-refusal-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'feature.test.ts'), "import { it } from 'vitest';\nit('noop', () => {});\n");
  const evidence = { workItemId: 'WI-refusal', planSlug: 'refusal-plan', bindings: [{
    specId: 'SPEC-001', specRevision: 1, testPath: 'feature.test.ts', sourcePaths: ['feature.ts'], testLayer: 'unit' as const,
  }] };
  const ctx = { projectDir: root, workspaceId: 'refusal-workspace', uiClientId: 'su-refusal-test', isSuperuser: true } as const;
  const args = runTool.args.parse({ files: ['feature.test.ts'], harness: 'refusal-harness', evidence });
  const result = await runTool.handler(args, ctx as never) as { data: Record<string, unknown> };
  return { root, result: result.data };
}

it('refuses before registering any evidence when a mutation probe is active', async () => {
  phases.fence.mockResolvedValue(refusal);

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, root, error: 'mutation_probe_active', hint: refusal.hint });
  expect(result).not.toHaveProperty('evidenceBundle');
  expect(phases.fence).toHaveBeenCalledExactlyOnceWith(root, ['feature.test.ts']);
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('retracts, rather than finishes, evidence prepared for a run the core then refused', async () => {
  // The probe started between the handler preflight and the core's own check.
  phases.fence.mockResolvedValueOnce(null).mockResolvedValueOnce(refusal);
  const prepared = [{ input: { evidenceRef: 'test-run-group:x:0' } }];
  phases.prepare.mockResolvedValue(prepared);
  phases.retract.mockResolvedValue({ status: 'not-recorded', reason: 'mutation_probe_active', retiredCount: 1, bindingIds: [9] });

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active',
    evidenceBundle: { status: 'not-recorded', retiredCount: 1, bindingIds: [9] } });
  expect(phases.prepare).toHaveBeenCalledOnce();
  expect(phases.retract).toHaveBeenCalledExactlyOnceWith(prepared, result.runId,
    expect.objectContaining({ root, harnessSlug: 'refusal-harness', workspaceId: 'refusal-workspace' }), 'mutation_probe_active');
  expect(phases.finish).not.toHaveBeenCalled();
});
