/**
 * release-deploy-launch.test.ts — the pure status/recommendation decision-tree + the detached
 * deploy launch (release-pipeline-resilience P-015). No PG, no real deploy — the spawn seam is
 * injected so launch is asserted by its systemd-run argv + close-code outcome.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-deploy-launch.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  computeDeployStatus,
  buildDeployCliArgs,
  buildSystemdRunArgv,
  launchDetachedDeploy,
  DEPLOY_UNIT,
} from './release-deploy-launch';
import type { GitPipelineSnapshot } from './git-pipeline-stats';

/** Minimal snapshot fixture — computeDeployStatus only reads gate + deploy. */
function mkSnap(
  gate: Partial<GitPipelineSnapshot['gate']>,
  deploy: Partial<GitPipelineSnapshot['deploy']>,
): GitPipelineSnapshot {
  return {
    gate: {
      consecutiveReds: 0,
      lastGreenAtMs: null,
      firstRedAtMs: null,
      stalled: false,
      lastFiredAtMs: null,
      fireStale: false,
      fireStaleReason: null,
      lastFixerStatus: null,
      lastFixerAtMs: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      ...gate,
    },
    deploy: {
      integrationRoot: '/x',
      releaseRoot: '/x-release',
      releaseRef: 'main',
      integrationBranch: 'staging',
      mainHead: { sha: 'staging00head', shortSha: 'staging0', committedAtMs: 0, subject: 's' },
      ready: { sha: 'greenpin0sha', shortSha: 'greenpin', committedAtMs: 0, subject: 'g' },
      deployed: { sha: 'deployed0sha', shortSha: 'deployed', committedAtMs: 0, subject: 'd' },
      deployedAtMs: 1,
      deployedBehindMain: 0,
      readyBehindMain: 0,
      deployedBehindReady: 0,
      readyAtMainHead: true,
      errors: [],
      ...deploy,
    },
  } as unknown as GitPipelineSnapshot;
}

describe('computeDeployStatus — decision tree', () => {
  it('green-deployable: green gate + green code ahead of the live deploy → canTriggerGreen', () => {
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindReady: 2 }));
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
    expect(s.recommendation).toMatch(/trigger/i);
  });

  it('gate-red: reds present → NOT triggerable, recommendation says fix the reds', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 2, lastFixerStatus: 'spawned' }, { deployedBehindReady: 0 }),
    );
    expect(s.state).toBe('gate-red');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/FIX the reds/);
    expect(s.recommendation).toMatch(/owner/i); // force only with owner sign-off
  });

  it('a red gate is never triggerable even if green code is technically ahead', () => {
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 1 }, { deployedBehindReady: 3 }));
    // hasGreenAhead routes to green-deployable, but canTriggerGreen also requires gateGreen.
    expect(s.gate.green).toBe(false);
    expect(s.canTriggerGreen).toBe(false);
  });

  it('gate-wedged: 0 reds but the checkpoint is not firing → surface to an operator', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: true, fireStaleReason: 'no fire in 9h' }, { deployedBehindReady: 0 }),
    );
    expect(s.state).toBe('gate-wedged');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/WEDGED|no fire in 9h/);
  });

  it('staging-buffered: green gate, nothing deployable yet, staging awaiting the next checkpoint', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindReady: 0, readyBehindMain: 4 }));
    expect(s.state).toBe('staging-buffered');
    expect(s.canTriggerGreen).toBe(false);
  });

  it('up-to-date: live :3070 is at the green pin', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindReady: 0, readyBehindMain: 0 }));
    expect(s.state).toBe('up-to-date');
    expect(s.nothingToDeploy).toBe(true);
  });
});

describe('buildDeployCliArgs', () => {
  it('trigger → plain --execute (green pin)', () => {
    expect(buildDeployCliArgs({})).toEqual(['--execute']);
  });
  it('force → --deploy-commit <sha> --force --execute', () => {
    expect(buildDeployCliArgs({ force: true, commit: 'abc1234' })).toEqual([
      '--deploy-commit',
      'abc1234',
      '--force',
      '--execute',
    ]);
  });
  it('force without a valid sha throws (no blind un-green deploy)', () => {
    expect(() => buildDeployCliArgs({ force: true })).toThrow(/commit sha/i);
    expect(() => buildDeployCliArgs({ force: true, commit: 'not-a-sha!' })).toThrow(/commit sha/i);
  });
});

describe('buildSystemdRunArgv', () => {
  it('runs the deploy as the shared transient unit, self-authorizing the restart', () => {
    const argv = buildSystemdRunArgv('/repo', ['--execute'], '/tmp/x.log', '/usr/bin');
    expect(argv).toContain(`--unit=${DEPLOY_UNIT}`);
    expect(argv).toContain('--working-directory=/repo');
    expect(argv).toContain('--setenv=PATH=/usr/bin');
    const inner = argv[argv.length - 1]!;
    expect(inner).toMatch(/PAPERCUSP_ALLOW_DEV_RESTART=1/);
    expect(inner).toMatch(/deploy-cli\.ts --execute/);
    expect(inner).toMatch(/> \/tmp\/x\.log 2>&1/);
  });
});

/** A fake child_process: emits the given close code (+ optional stderr) on the next tick. */
function fakeSpawn(closeCode: number, stderr = '') {
  const calls: { cmd: string; argv: string[] }[] = [];
  const fn = ((cmd: string, argv: string[]) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', closeCode);
    });
    return child as unknown;
  }) as unknown as typeof import('node:child_process').spawn & { calls: typeof calls };
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

describe('launchDetachedDeploy', () => {
  it('launches systemd-run and reports launched on exit 0 — never fires a real deploy', async () => {
    const fn = fakeSpawn(0);
    const r = await launchDetachedDeploy({ root: '/repo' }, fn);
    expect(r.launched).toBe(true);
    expect(r.mode).toBe('trigger');
    expect(r.unit).toBe(DEPLOY_UNIT);
    const call = (fn as unknown as { calls: { cmd: string; argv: string[] }[] }).calls[0]!;
    expect(call.cmd).toBe('systemd-run');
    expect(call.argv).toContain(`--unit=${DEPLOY_UNIT}`);
  });

  it('a non-zero exit (unit already exists ⇒ deploy in flight) reports NOT launched + a reason', async () => {
    const fn = fakeSpawn(1, 'Unit papercup-auto-deploy.service already exists.');
    const r = await launchDetachedDeploy({ root: '/repo' }, fn);
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/already.*exist|in flight/i);
  });

  it('force mode shells the --force --deploy-commit flags', async () => {
    const fn = fakeSpawn(0);
    const r = await launchDetachedDeploy({ root: '/repo', force: true, commit: 'deadbeef' }, fn);
    expect(r.mode).toBe('force');
    const inner = r.argv[r.argv.length - 1]!;
    expect(inner).toMatch(/--deploy-commit deadbeef --force --execute/);
  });
});
