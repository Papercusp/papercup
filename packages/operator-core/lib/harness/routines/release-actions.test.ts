/**
 * Release-gating system actions — the wiring half of the release gate
 * (release-gate-ready-branch-2026-06-04 Phase 1; AUTO-SERVE since
 * staging-branch-pipeline-2026-06-06). Covers:
 *   - register-system-actions side-effect import populates the registry with
 *     BOTH `green-checkpoint` and `release-trigger`.
 *   - release-trigger's noop-gating + scripted auto-deploy: a deploy plan with
 *     noop:true (or unparseable stdout) must NOT deploy; a real noop:false plan
 *     runs `deploy-cli --execute` directly and logs a `deploy` pipeline event.
 *
 * runScript shells out via node:child_process.spawn — mocked (mirrors
 * governed-background-spawn.test.ts's spawn-fake). pipeline-events is mocked so
 * no PG is touched. No subprocess, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// --- mocks (hoisted) ---------------------------------------------------------
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

const appendPipelineEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../git-sync/pipeline-events', () => ({
  appendPipelineEvent: (...a: unknown[]) => appendPipelineEvent(...a),
}));

// importing register-system-actions runs every side-effect import (git-sync,
// blueprint, release-actions) so the registry is populated as in production.
import '../git-sync/git-sync-action';
import '../../blueprint/blueprint-run-action';
import './release-actions';
import { getSystemAction, listSystemActions, type SystemActionCtx } from './system-actions';

/**
 * A spawn() fake: returns a child whose stdout emits `stdout`, then closes with
 * `code`. The release-actions runScript subscribes to stdout/stderr 'data' and the
 * 'close' event; emit on the next tick so the subscriptions are in place first.
 */
function fakeSpawn(stdout: string, code = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

const ctx: SystemActionCtx = {
  installSlug: 'my-harness',
  workspaceId: 'ws-42',
  triggerConfig: {},
  payloadTemplate: null,
};

function planJson(noop: boolean): string {
  // shape: { mode, config, plan: { ..., noop } } — release-trigger reads plan.noop
  return JSON.stringify({ mode: 'plan', config: { releaseRef: 'ready' }, plan: { targetSha: 'deadbeef', noop } }, null, 2);
}

beforeEach(() => {
  spawnMock.mockReset();
  appendPipelineEvent.mockClear();
});

describe('register-system-actions — registry population', () => {
  it('registers BOTH green-checkpoint and release-trigger', () => {
    const names = listSystemActions();
    expect(names).toContain('green-checkpoint');
    expect(names).toContain('release-trigger');
    expect(getSystemAction('green-checkpoint')).toBeTypeOf('function');
    expect(getSystemAction('release-trigger')).toBeTypeOf('function');
  });
});

/** deploy-cli --execute stdout: the plan JSON then the result JSON (both top-level). */
function executeStdout(result: Record<string, unknown>): string {
  return `${planJson(false)}\n${JSON.stringify(result, null, 2)}`;
}

describe('release-trigger — noop gating + scripted auto-deploy', () => {
  it('does NOT deploy when the deploy plan is noop:true', async () => {
    spawnMock.mockImplementation(() => fakeSpawn(planJson(true), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    // the plan was gathered (one spawn for deploy-cli) but --execute never ran
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
  });

  it('does NOT deploy when the deploy plan stdout is unparseable (safe skip)', async () => {
    spawnMock.mockImplementation(() => fakeSpawn('not json at all — gibberish', 0));
    const action = getSystemAction('release-trigger')!;
    // the safe-skip path logs a warn — expected; mock it out and assert it fired
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not parse deploy plan'));
    warn.mockRestore();
  });

  it('runs deploy-cli --execute when the plan is noop:false and logs an ok deploy event', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false), 0)) // plan gather
      .mockImplementationOnce(() => fakeSpawn(executeStdout({ ok: true, rolledBack: false, steps: [] }), 0));
    const action = getSystemAction('release-trigger')!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // the second spawn is the scripted deploy: tsx deploy-cli.ts --execute
    const execArgs = (spawnMock.mock.calls[1] as unknown[])[1] as string[];
    expect(execArgs.some((a) => a.endsWith('deploy-cli.ts'))).toBe(true);
    expect(execArgs).toContain('--execute');

    expect(appendPipelineEvent).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deploy',
        status: 'ok',
        installSlug: 'my-harness',
        workspaceId: 'ws-42',
        detail: expect.objectContaining({ targetSha: 'deadbeef', exitCode: 0 }),
      }),
    );
    log.mockRestore();
  });

  it('logs a rolled-back deploy event when --execute fails and rolls back', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false), 0))
      .mockImplementationOnce(() =>
        fakeSpawn(executeStdout({ ok: false, rolledBack: true, error: 'health probe failed', steps: [] }), 1),
      );
    const action = getSystemAction('release-trigger')!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deploy',
        status: 'rolled-back',
        detail: expect.objectContaining({ exitCode: 1, error: expect.stringContaining('health probe failed') }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-deploy rolled-back'));
    warn.mockRestore();
    log.mockRestore();
  });
});
