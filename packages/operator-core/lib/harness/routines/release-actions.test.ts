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
 * runScript shells out via node:child_process.spawn — mocked with a small
 * EventEmitter spawn-fake. pipeline-events is mocked so no PG is touched. No
 * subprocess, no network.
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
import {
  shouldAutoServe,
  shouldBackOff,
  gateStallEscalationBody,
  type AutoServePlan,
  type DeployEventRow,
} from './release-actions';
import { getSystemAction, listSystemActions, type SystemActionCtx } from './system-actions';

describe('gateStallEscalationBody (P-003 silent-stall escalation)', () => {
  it('builds a green-checkpoint-stall body with streak, age, capped candidate + failing tests', () => {
    const body = JSON.parse(
      gateStallEscalationBody({
        installSlug: 'papercup',
        consecutiveReds: 4,
        heldHrs: 7,
        candidate: 'abcdef1234567890',
        failingTests: Array.from({ length: 25 }, (_, i) => `t${i}`),
        nowMs: 1_700_000_000_000,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-stall');
    expect(body.harness_slug).toBe('papercup');
    expect(body.consecutiveReds).toBe(4);
    expect(body.heldHrs).toBe(7);
    expect(body.candidate).toBe('abcdef123456'); // 12-char cap
    expect(body.failingTests).toHaveLength(20); // capped at 20
    expect(body.emitted_at).toBe(1_700_000_000_000);
    expect(body.detail).toContain('4 checkpoint(s)');
    expect(body.detail).toContain('~7h');
    expect(body.detail).toContain('Failing: t0, t1, t2, t3, t4 (+15 more)');
  });

  it('omits the age + failing-test clauses when there is no green history / no tests', () => {
    const body = JSON.parse(
      gateStallEscalationBody({ installSlug: 'x', consecutiveReds: 3, heldHrs: null, nowMs: 1 }),
    );
    expect(body.heldHrs).toBeNull();
    expect(body.candidate).toBeNull();
    expect(body.failingTests).toEqual([]);
    expect(body.detail).not.toContain('since the last green');
    expect(body.detail).not.toContain('Failing:');
  });
});

/** Must match DEPLOY_PLAN_MARKER in deploy-cli.ts / release-actions.ts (P-008). */
const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

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
  // shape: { mode, config, plan } — release-trigger reads the plan through
  // shouldAutoServe (forward-only). noop:false here models a REAL forward
  // fast-forward (release behind green main with new commits); noop:true models
  // the checkout already at green main.
  const plan: AutoServePlan = noop
    ? { targetSha: 'deadbeef', currentReleaseSha: 'deadbeef', isFastForward: true, commits: [], noop: true }
    : { targetSha: 'deadbeef', currentReleaseSha: 'cafef00d', isFastForward: true, commits: ['c1', 'c2'], noop: false };
  // The CLI prints the pretty block AND the P-008 marker line; release-trigger parses the
  // marker. Emit both so the fake mirrors the real deploy-cli output.
  return (
    JSON.stringify({ mode: 'plan', config: { releaseRef: 'main' }, plan }, null, 2) +
    `\n${DEPLOY_PLAN_MARKER} ${JSON.stringify({ mode: 'plan', plan })}\n`
  );
}

/** A plan in the redeploy-storm shape: the detached release checkout sits AHEAD
 *  of green main — SHAs differ (noop:false) but there are ZERO new commits and
 *  it is not a fast-forward. The forward-only gate must NOT deploy this. */
function aheadOfMainPlanJson(): string {
  const plan: AutoServePlan = {
    targetSha: 'deadbeef',
    currentReleaseSha: 'ahead123', // a git-sync auto-commit ahead of main
    isFastForward: false,
    commits: [],
    noop: false,
  };
  return (
    JSON.stringify({ mode: 'plan', config: { releaseRef: 'main' }, plan }, null, 2) +
    `\n${DEPLOY_PLAN_MARKER} ${JSON.stringify({ mode: 'plan', plan })}\n`
  );
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

describe('release-trigger — noop gating + detached auto-deploy', () => {
  it('does NOT deploy when the deploy plan is noop:true', async () => {
    spawnMock.mockImplementation(() => fakeSpawn(planJson(true), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    // the plan was gathered (one spawn for deploy-cli) but --execute never ran
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
  });

  it('does NOT deploy when the release checkout is AHEAD of main (0 new commits) — the redeploy-storm regression', async () => {
    // The 2026-06-07 storm: noop:false (SHAs differ) but commits:[] + not-FF, so
    // deploying would revert the checkout backward and git-sync re-advances it →
    // an infinite redeploy loop that hard-restarts :3070. Forward-only gate skips it.
    spawnMock.mockImplementation(() => fakeSpawn(aheadOfMainPlanJson(), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    // plan gathered (1 spawn) but --execute / systemd-run NEVER ran (no 2nd spawn)
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

  it('launches the deploy as a DETACHED systemd-run unit when the plan is noop:false', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false), 0)) // plan gather (tsx)
      .mockImplementationOnce(() => fakeSpawn('', 0)); // systemd-run launch
    const action = getSystemAction('release-trigger')!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // The second spawn must be the DETACHED transient unit (the deploy restarts
    // this host — a child deploy-cli dies at its own restart step), not a
    // direct tsx child.
    const [cmd, args] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--user');
    expect(args).toContain('--unit=papercup-auto-deploy');
    const sh = args[args.length - 1];
    expect(sh).toContain('deploy-cli.ts --execute');
    expect(sh).toContain('PAPERCUSP_ALLOW_DEV_RESTART=1');

    // The deploy outcome event is recorded by deploy.ts (the surviving
    // process), never by this routine.
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('warns (does not throw) when the detached unit cannot launch — e.g. a deploy already running', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false), 0))
      .mockImplementationOnce(() => fakeSpawn('', 1)); // systemd-run refuses (unit exists)
    const action = getSystemAction('release-trigger')!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deploy already running'));
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });
});

describe('shouldAutoServe — forward-only auto-serve policy', () => {
  const base: AutoServePlan = {
    targetSha: 't',
    currentReleaseSha: 'r',
    isFastForward: true,
    commits: ['c1'],
    noop: false,
  };

  it('deploys a genuine forward fast-forward bringing ≥1 new commit', () => {
    expect(shouldAutoServe({ ...base, isFastForward: true, commits: ['c1', 'c2'] })).toBe(true);
  });

  it('deploys the first deploy (release checkout not set up: currentReleaseSha=null)', () => {
    expect(shouldAutoServe({ ...base, currentReleaseSha: null, commits: ['c1'] })).toBe(true);
  });

  it('SKIPS a true noop (release checkout already at green main)', () => {
    expect(shouldAutoServe({ ...base, noop: true, commits: [] })).toBe(false);
  });

  it('SKIPS when the checkout is AHEAD of main: SHAs differ, 0 commits, not a FF (the storm)', () => {
    expect(shouldAutoServe({ ...base, noop: false, isFastForward: false, commits: [] })).toBe(false);
  });

  it('SKIPS a non-fast-forward even with new commits (diverged → needs review, not auto-serve)', () => {
    expect(shouldAutoServe({ ...base, isFastForward: false, commits: ['c1'] })).toBe(false);
  });

  it('SKIPS a fast-forward that somehow carries 0 commits (nothing to apply)', () => {
    expect(shouldAutoServe({ ...base, isFastForward: true, commits: [] })).toBe(false);
  });

  it('SKIPS a malformed plan missing currentReleaseSha (conservative)', () => {
    expect(shouldAutoServe({ targetSha: 't', isFastForward: true, commits: ['c1'], noop: false })).toBe(false);
  });

  it('SKIPS a desktop-only pointer bump (papercusp-desktop gitlink only — D-003)', () => {
    // A green FF bringing ≥1 new commit that would otherwise deploy, but the only
    // changed path is the desktop submodule → must NOT bounce the :3070 operator.
    expect(shouldAutoServe({ ...base, desktopOnly: true })).toBe(false);
  });

  it('still deploys when desktopOnly is false or absent (real operator change)', () => {
    expect(shouldAutoServe({ ...base, desktopOnly: false })).toBe(true);
    expect(shouldAutoServe({ ...base })).toBe(true); // absent → not skipped
  });
});

describe('shouldBackOff — P-013 deploy-failure back-off', () => {
  const now = 1_700_000_000_000;
  // deploy events store targetSha sliced(0,12); the plan's targetSha is the full sha.
  const stored = 'deadbeefcafe';
  const full = 'deadbeefcafe1234567890abcdef000011112222';
  const evt = (status: string, targetSha: string, agoMs: number, detailAsString = false): DeployEventRow => {
    const detail = { targetSha };
    return { status, detail: detailAsString ? JSON.stringify(detail) : detail, created_at: new Date(now - agoMs) };
  };

  it('backs off a rolled-back deploy of the SAME target within the window', () => {
    expect(shouldBackOff(evt('rolled-back', stored, 5 * 60_000), full, now)).toBe(true);
  });
  it('backs off a failed deploy of the same target within the window', () => {
    expect(shouldBackOff(evt('failed', stored, 5 * 60_000), full, now)).toBe(true);
  });
  it('does NOT back off when the latest deploy SUCCEEDED', () => {
    expect(shouldBackOff(evt('ok', stored, 5 * 60_000), full, now)).toBe(false);
  });
  it('does NOT back off when there is no prior deploy event', () => {
    expect(shouldBackOff(null, full, now)).toBe(false);
  });
  it('does NOT back off a failure of a DIFFERENT target (a new green is free to deploy)', () => {
    expect(shouldBackOff(evt('rolled-back', '0000beefcafe', 5 * 60_000), full, now)).toBe(false);
  });
  it('does NOT back off once the window has elapsed (retry after cooldown)', () => {
    expect(shouldBackOff(evt('rolled-back', stored, 90 * 60_000), full, now)).toBe(false);
  });
  it('tolerates a double-encoded JSON detail string', () => {
    expect(shouldBackOff(evt('failed', stored, 5 * 60_000, true), full, now)).toBe(true);
  });
});
