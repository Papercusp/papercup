import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';

const admission = vi.hoisted(() => ({
  rewrite: vi.fn(), liveTasks: vi.fn(), sandbox: vi.fn(), restriction: vi.fn(),
  sourceHold: vi.fn(), provenance: vi.fn(), lineage: vi.fn(), loop: vi.fn(),
  start: vi.fn(),
}));

vi.mock('./rtk-rewrite', async (original) => ({
  ...(await original<typeof import('./rtk-rewrite')>()), rtkCommandForCapabilityBash: admission.rewrite,
}));
vi.mock('../../task-manager/store', async (original) => ({
  ...(await original<typeof import('../../task-manager/store')>()), listLiveTasks: admission.liveTasks,
}));
vi.mock('./exec-sandbox', async (original) => ({
  ...(await original<typeof import('./exec-sandbox')>()), capabilityExecSandboxPolicy: admission.sandbox,
}));
vi.mock('../../personal-vault/binding-enforcement', async (original) => ({
  ...(await original<typeof import('../../personal-vault/binding-enforcement')>()), readSessionRestriction: admission.restriction,
}));
vi.mock('../../personal-vault/git-sync-hold', async (original) => ({
  ...(await original<typeof import('../../personal-vault/git-sync-hold')>()), readRestrictedSourceHoldState: admission.sourceHold,
}));
vi.mock('./bash-task-provenance', async (original) => ({
  ...(await original<typeof import('./bash-task-provenance')>()), resolveCapabilityBashTaskProvenance: admission.provenance,
}));
vi.mock('./base-dir', async (original) => ({
  ...(await original<typeof import('./base-dir')>()), resolveCapabilityIntegrationRoot: () => '/tmp',
}));
vi.mock('../../release/frozen-lineage-execution-policy', async (original) => ({
  ...(await original<typeof import('../../release/frozen-lineage-execution-policy')>()),
  evaluateFrozenLineageShellCommand: admission.lineage,
  frozenLineageShellCommandViolationPayload: (value: unknown) => value,
}));
vi.mock('../../verification-attempts/loop-gate', async (original) => ({
  ...(await original<typeof import('../../verification-attempts/loop-gate')>()), loopLaunchRefusal: admission.loop,
}));
vi.mock('./bash-jobs', async (original) => ({
  ...(await original<typeof import('./bash-jobs')>()), startBackground: admission.start,
}));

import bashTool from './bash';

const bash = bashTool as unknown as {
  handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

beforeEach(() => {
  vi.resetAllMocks();
  admission.rewrite.mockResolvedValue({ command: 'printf diagnostic', outcome: { kind: 'skipped' } });
  admission.liveTasks.mockResolvedValue([]);
  admission.sandbox.mockResolvedValue({ enabled: false, required: false });
  admission.restriction.mockResolvedValue(false);
  admission.sourceHold.mockResolvedValue('clear');
  admission.provenance.mockResolvedValue({ launchedBy: 'phase-test', workItemId: 'WI-phase-test' });
  admission.lineage.mockResolvedValue(null);
  admission.loop.mockResolvedValue(null);
});

describe('managed shell admission timing (EI-28786728209475086)', () => {
  it.each([
    ['rewrite', 'handler:command-rewrite'],
    ['liveTasks', 'handler:live-task-census'],
    ['sandbox', 'handler:sandbox-policy'],
    ['restriction', 'handler:session-restriction'],
    ['sourceHold', 'handler:restricted-source-hold'],
    ['provenance', 'handler:task-provenance'],
    ['lineage', 'handler:frozen-lineage-policy'],
    ['loop', 'handler:verification-loop-gate'],
  ] as const)('names an unresolved %s read and retains its timing when it rejects', async (dependency, phase) => {
    let now = 0;
    const phases = createPhaseTracker({ now: () => now });
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let reject!: (error: Error) => void;
    const blocked = new Promise<never>((_, fail) => { reject = fail; });
    admission[dependency].mockImplementationOnce(() => { reached(); return blocked; });
    const context = {
      projectDir: '/tmp', stateDir: '/tmp', workspaceId: 'phase-workspace', harnessSlug: 'papercusp',
      signal: new AbortController().signal, emit: () => {}, role: 'operator', phases,
    };
    const operation = bash.handler({ command: 'printf diagnostic', cwd: '/tmp', run_in_background: true }, context);
    const failure = expect(operation).rejects.toThrow('admission dependency failed');
    await entered;
    now = 5_000;
    expect(phases.toMetadata()).toMatchObject({
      elapsedMs: 5_000, attributedMs: 5_000,
      pending: [{ phase, elapsedMs: 5_000 }],
    });
    expect(admission.start).not.toHaveBeenCalled();
    reject(new Error('admission dependency failed'));
    await failure;
    expect(phases.toMetadata()).toMatchObject({ pending: [] });
    expect(phases.intervals()).toContainEqual({ phase, startMs: 0, durationMs: 5_000 });
    expect(admission.start).not.toHaveBeenCalled();
  });
});
