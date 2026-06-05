/**
 * Release-gating system actions — the wiring half of the release gate
 * (release-gate-ready-branch-2026-06-04 Phase 1 + D-010). Covers:
 *   - register-system-actions side-effect import populates the registry with
 *     BOTH `green-checkpoint` and `release-trigger`.
 *   - release-trigger's noop-gating: a deploy plan with noop:true (or unparseable
 *     stdout) must NOT dispatch the release-manager; only a real noop:false plan
 *     POSTs the `?role=release-manager` invoke URL.
 *
 * runScript shells out via node:child_process.spawn and the dispatch goes through
 * loopbackFetch — both are mocked (mirrors governed-background-spawn.test.ts's
 * spawn-fake + autoloop.test.ts's loopback-fetch stub). No subprocess, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// --- mocks (hoisted) ---------------------------------------------------------
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

const loopbackFetch = vi.fn();
vi.mock('../../loopback-fetch', () => ({ loopbackFetch: (...a: unknown[]) => loopbackFetch(...a) }));

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
  loopbackFetch.mockReset();
  loopbackFetch.mockResolvedValue({ ok: true });
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

describe('release-trigger — noop gating', () => {
  it('does NOT dispatch the release-manager when the deploy plan is noop:true', async () => {
    spawnMock.mockImplementation(() => fakeSpawn(planJson(true), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    // the plan was gathered (one spawn for deploy-cli) but NO invoke was POSTed
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(loopbackFetch).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when the deploy plan stdout is unparseable (safe skip)', async () => {
    spawnMock.mockImplementation(() => fakeSpawn('not json at all — gibberish', 0));
    const action = getSystemAction('release-trigger')!;
    // the safe-skip path logs a warn — expected; mock it out and assert it fired
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(loopbackFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not parse deploy plan'));
    warn.mockRestore();
  });

  it('POSTs the ?role=release-manager invoke when the plan is noop:false', async () => {
    spawnMock.mockImplementation(() => fakeSpawn(planJson(false), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1); // deploy-cli plan gather
    expect(loopbackFetch).toHaveBeenCalledTimes(1);
    const [url, init] = loopbackFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/harness/');
    expect(url).toContain('role=release-manager');
    expect(url).toContain(encodeURIComponent('my-harness'));
    expect(url).toContain('ws=' + encodeURIComponent('ws-42'));
    expect(init.method).toBe('POST');
    // the kickoff prompt is sent so the release-manager knows to gather+review+deploy
    expect(String(init.body)).toContain('go/no-go');
  });
});
