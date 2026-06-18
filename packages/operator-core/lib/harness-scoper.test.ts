/**
 * harness-scoper.test.ts — the background scoper now routes through the ONE
 * chokepoint (`spawnInvokeOnce`) instead of a private buildInvokeOnce + raw
 * detached child_process.spawn (unify-agent-spawn-chokepoint P-008 / D-013
 * residual 1). These tests lock:
 *   1. it calls spawnInvokeOnce with the scoper role + extras + resultPath +
 *      the generous background timeout (governed by the chokepoint), and
 *      returns immediately (fire-and-forget) with an invocationId;
 *   2. on a PRE-spawn bail (non-zero exit, child never wrote the sentinel) it
 *      appends the __INVOCATION_DONE__ sentinel itself so the caller's
 *      file-poll ends (the old governed-background-spawn permit-bail behavior);
 *   3. on success it does NOT double-write the sentinel (the child wrote it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
// vi.mock factories are hoisted above module-top consts, so the spies must be
// declared via vi.hoisted to be initialized when the factories run.
const { spawnInvokeOnceMock, appendFileSyncMock } = vi.hoisted(() => ({
  // `...args` so the `.mock.calls[0]` destructures below (5- and 2-element) type-check.
  spawnInvokeOnceMock: vi.fn(async (..._a: unknown[]) => ({ output: '', exitCode: 0, stderr: '' })),
  appendFileSyncMock: vi.fn<(...a: unknown[]) => void>(),
}));

vi.mock('./dbos/orchestrator-runner', () => ({ spawnInvokeOnce: spawnInvokeOnceMock }));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), appendFileSync: appendFileSyncMock }));
vi.mock('@papercusp/orchestrator', () => ({
  loadHarnessKnobs: () => ({ scoper: { outputMode: 'proposal' } }),
}));
vi.mock('./harness-core', () => ({ harnessDir: () => '/tmp/papercusp-scoper-test/.papercusp' }));
vi.mock('./harness-paths', () => ({ harnessPackageDir: () => '/tmp/harness-pkg' }));
vi.mock('./deployment/instance-config', () => ({
  instanceConfigEnv: vi.fn(async () => ({ HARNESS_CONFIG_JSON: '{"x":1}' })),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { invokeScoperBackground } from './harness-scoper';

const project = { path: '/tmp/papercusp-scoper-test', slug: 'test-harness' } as never;

// Let the void'd .then/.catch handler run after invokeScoperBackground returns.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  spawnInvokeOnceMock.mockReset();
  spawnInvokeOnceMock.mockResolvedValue({ output: '', exitCode: 0, stderr: '' });
  appendFileSyncMock.mockReset();
});

describe('invokeScoperBackground → chokepoint (P-008 / D-013 residual 1)', () => {
  it('routes through spawnInvokeOnce with role=scoper, extras, resultPath + bg timeout', async () => {
    const { invocationId } = await invokeScoperBackground(project, 'proposal');
    expect(invocationId).toBeTruthy();
    expect(spawnInvokeOnceMock).toHaveBeenCalledTimes(1);

    const [projectDir, role, extras, extraEnv, opts] = spawnInvokeOnceMock.mock.calls[0];
    expect(projectDir).toBe('/tmp/papercusp-scoper-test');
    expect(role).toBe('scoper');
    expect(extras).toEqual(['MODE=proposal', 'OUTPUT_MODE=proposal']);
    // The instance config rides the env (so the chokepoint's own resolve is a no-op).
    expect(extraEnv).toMatchObject({
      SCOPER_INVOCATION_ID: invocationId,
      SCOPER_OUTPUT_MODE: 'proposal',
      HARNESS_CONFIG_JSON: '{"x":1}',
    });
    // Routed as a BACKGROUND file-poll spawn: resultPath set + the generous
    // 30-min bound (not the 10-min pipeline default).
    expect(opts.resultPath).toMatch(/scoper-results\/proposal-.*\.log$/);
    expect(opts.timeoutMs).toBe(30 * 60_000);
  });

  it('replan/cleanup pass MODE through and force OUTPUT_MODE=proposal', async () => {
    await invokeScoperBackground(project, 'replan');
    const [, , extras] = spawnInvokeOnceMock.mock.calls[0];
    expect(extras).toEqual(['MODE=replan', 'OUTPUT_MODE=proposal']);
  });

  it('appends the __INVOCATION_DONE__ sentinel itself on a pre-spawn bail (non-zero exit)', async () => {
    spawnInvokeOnceMock.mockResolvedValue({
      output: '',
      exitCode: 1,
      stderr: 'agent governor: rate-limit pause exceeded max wait',
    });
    await invokeScoperBackground(project, 'proposal');
    await flush();
    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, contents] = appendFileSyncMock.mock.calls[0];
    expect(path).toMatch(/scoper-results\/proposal-.*\.log$/);
    expect(contents).toContain('__INVOCATION_DONE__');
    expect(contents).toContain('rate-limit pause exceeded');
  });

  it('does NOT double-write the sentinel on success (the child wrote it)', async () => {
    spawnInvokeOnceMock.mockResolvedValue({ output: 'ok', exitCode: 0, stderr: '' });
    await invokeScoperBackground(project, 'proposal');
    await flush();
    expect(appendFileSyncMock).not.toHaveBeenCalled();
  });

  it('ends the poll on a thrown spawn error too', async () => {
    spawnInvokeOnceMock.mockRejectedValue(new Error('boom'));
    await invokeScoperBackground(project, 'cleanup');
    await flush();
    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const [, contents] = appendFileSyncMock.mock.calls[0];
    expect(contents).toContain('__INVOCATION_DONE__');
    expect(contents).toContain('boom');
  });
});
