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
import type { PipelineEventRow } from './harness/git-sync/pipeline-events';

/** Minimal snapshot fixture — computeDeployStatus only reads gate + deploy (+ recent, EI-10902). */
function mkSnap(
  gate: Partial<GitPipelineSnapshot['gate']>,
  deploy: Partial<GitPipelineSnapshot['deploy']>,
  recent: PipelineEventRow[] = [],
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
      verdictObservedAtMs: null,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerAtMs: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      ...gate,
    },
    deploy: {
      integrationRoot: '/x',
      releaseRoot: '/x-release',
      releaseRef: 'main',
      integrationBranch: 'staging',
      stagingHead: { sha: 'staging00head', shortSha: 'staging0', committedAtMs: 0, subject: 's' },
      ready: { sha: 'greenpin0sha', shortSha: 'greenpin', committedAtMs: 0, subject: 'g' },
      deployed: { sha: 'deployed0sha', shortSha: 'deployed', committedAtMs: 0, subject: 'd' },
      deployedAtMs: 1,
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      errors: [],
      ...deploy,
    },
    recent,
  } as unknown as GitPipelineSnapshot;
}

describe('computeDeployStatus — decision tree', () => {
  it('green-deployable: green gate + green code ahead of the live deploy → canTriggerGreen', () => {
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindGreenPin: 2 }));
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
    expect(s.recommendation).toMatch(/trigger/i);
  });

  it('gate-red: reds present → NOT triggerable, recommendation says fix the reds', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 2, lastFixerStatus: 'spawned' }, { deployedBehindGreenPin: 0 }),
    );
    expect(s.state).toBe('gate-red');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/FIX the reds/);
    expect(s.recommendation).toMatch(/owner/i); // force only with owner sign-off
  });

  it('a green PIN ahead is triggerable even when the gate is currently RED (the pin is green by construction)', () => {
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 1 }, { deployedBehindGreenPin: 3 }));
    // A later red must NOT strand an already-green pin: hasGreenAhead → green-deployable AND
    // canTriggerGreen, decoupled from the current gate color (auto-serve ships "green main ahead"
    // regardless). Previously canTriggerGreen also required gateGreen, which wedged op:trigger in
    // exactly the state whose recommendation told you to run it.
    expect(s.gate.green).toBe(false);
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
    expect(s.recommendation).toMatch(/trigger/i);
  });

  it('gate-wedged: 0 reds but the checkpoint is not firing → surface to an operator', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: true, fireStaleReason: 'no fire in 9h' }, { deployedBehindGreenPin: 0 }),
    );
    expect(s.state).toBe('gate-wedged');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/WEDGED|no fire in 9h/);
  });

  it('staging-buffered: green gate, nothing deployable yet, staging awaiting the next checkpoint', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 0, greenPinBehindStaging: 4 }));
    expect(s.state).toBe('staging-buffered');
    expect(s.canTriggerGreen).toBe(false);
  });

  it('up-to-date: live :3070 is at the green pin', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 0, greenPinBehindStaging: 0 }));
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

/**
 * WI-4489 — a STALE red must not masquerade as the gate's current colour.
 *
 * The live incident (2026-07-12): `gate_health` froze on 4 reds from the pnpm-hijack window while
 * the routine kept firing and skipping on the run-lock. `op:status` reported `gate-red` + "FIX the
 * reds" for ~3.5h. All 8 named tests passed; the gate was green on every real run. That
 * recommendation is what dispatched the fixer whose manual runs held the lock that kept the routine
 * skipping — the stale red sustained itself.
 */
describe('WI-4489: gate verdict staleness', () => {
  it('⭐ a STALE red does NOT report gate-red, and does NOT send anyone to fix the tests it names', () => {
    const s = computeDeployStatus(
      mkSnap(
        { consecutiveReds: 4, verdictStale: true, verdictStaleReason: 'the release pin has advanced' },
        { deployedBehindGreenPin: 0 },
      ),
    );
    expect(s.state).toBe('gate-verdict-stale');
    expect(s.state).not.toBe('gate-red');
    expect(s.recommendation).toMatch(/STALE/);
    expect(s.recommendation).toMatch(/Do NOT chase the failing tests/);
    expect(s.recommendation).toMatch(/release:checkpoint-run/);
    // …and it must NOT claim the gate is green either. The honest state is "unknown".
    expect(s.gate.green).toBe(false);
    expect(s.gate.verdictStale).toBe(true);
  });

  it('⭐ a LIVE red still reports gate-red — the fix must not blind the gate (the EI-10609 lesson)', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 4, verdictStale: false }, { deployedBehindGreenPin: 0 }),
    );
    expect(s.state).toBe('gate-red');
    expect(s.recommendation).toMatch(/FIX the reds/);
  });

  it('a stale red never strands a deployable green pin — green-deployable still wins', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 4, verdictStale: true }, { deployedBehindGreenPin: 146 }),
    );
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true); // decoupled from gate colour by design (line ~118)
  });
});

/**
 * EI-18646778682511611 — a partial ('advanced-prefix', P-016/D-010) advance resets
 * `consecutiveReds` to 0 by design (the stall streak means "is main frozen", and a
 * partial advance proves it isn't) — but `tryLongestGreenPrefix` returns `green: false`
 * for that same tick on purpose: the candidate/tip is a CONFIRMED, reproducing red, only
 * the longest green prefix behind it shipped. Reusing the reset stall counter as "the
 * gate is green" reported gate.green=true for a tick with real, non-flaky test failures —
 * the live incident: three genuine regressions (a migration-atomicity lint + two design-
 * token lints) reproduced identically across the retry, yet op:status read green=true.
 */
describe('EI-18646778682511611: an advanced-prefix tick must not report gate.green=true', () => {
  const advancedPrefixEvent: PipelineEventRow = {
    id: '1',
    kind: 'green_checkpoint',
    status: 'advanced-prefix',
    detail: { green: false, candidate: 'redtip0000000', from: 'lastready00000', logPath: '/tmp/x-run.log' },
    createdAtMs: 1_720_000_000_000,
  };

  it('⭐ gate.green is false right after an advanced-prefix tick, even though consecutiveReds was reset to 0', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false }, {}, [advancedPrefixEvent]),
    );
    expect(s.gate.lastVerdict?.status).toBe('advanced-prefix');
    expect(s.gate.green).toBe(false);
  });

  it('a genuine full advance (status "advanced") still reports gate.green=true — the fix is scoped to advanced-prefix only', () => {
    const advancedEvent: PipelineEventRow = { ...advancedPrefixEvent, status: 'advanced', detail: { green: true } };
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 0, fireStale: false }, {}, [advancedEvent]));
    expect(s.gate.green).toBe(true);
  });

  it('the green pin still ships behind an advanced-prefix tip — canTriggerGreen decoupled from gate.green', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindGreenPin: 1 }, [advancedPrefixEvent]),
    );
    expect(s.gate.green).toBe(false);
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true); // deploying the CONFIRMED-green prefix is still safe
  });
});

/**
 * EI-10902: "what did the last gate tick decide, and on what code?" — previously answerable
 * only by grepping ANSI-coloured log files + cross-referencing a checkout's git log. The
 * candidate sha / failing tests / log path were ALREADY persisted (WI-4494's recordCheckpointVerdict
 * writes them into harness_shared.pipeline_events; WI-4533 already threaded failingTests into
 * GitPipelineSnapshot.gate) — this just threads BOTH through to the existing agent-facing
 * release:deploy{op:status} surface instead of leaving them stranded in the snapshot.
 */
describe('EI-10902: lastVerdict + failingTests surfaced on DeployStatus.gate', () => {
  const greenEvent: PipelineEventRow = {
    id: '1',
    kind: 'green_checkpoint',
    status: 'advanced',
    detail: { green: true, candidate: 'deadbeefcafe', from: '28a3a3d50258', logPath: '/tmp/x-run.log' },
    createdAtMs: 1_720_000_000_000,
  };

  it('lastVerdict is null when no green_checkpoint event has ever been recorded', () => {
    const s = computeDeployStatus(mkSnap({}, {}, []));
    expect(s.gate.lastVerdict).toBeNull();
    expect(s.gate.failingTests).toEqual([]);
  });

  it('lastVerdict surfaces the newest green_checkpoint event candidate/from/status/logPath', () => {
    const s = computeDeployStatus(mkSnap({}, {}, [greenEvent]));
    expect(s.gate.lastVerdict).toEqual({
      tickAtMs: 1_720_000_000_000,
      candidate: 'deadbeefcafe',
      from: '28a3a3d50258',
      status: 'advanced',
      logPath: '/tmp/x-run.log',
    });
  });

  it('picks the FIRST (newest) green_checkpoint event, skipping other pipeline-event kinds ahead of it', () => {
    const newer: PipelineEventRow = { id: '2', kind: 'git_sync', status: 'synced', detail: {}, createdAtMs: 2 };
    const s = computeDeployStatus(mkSnap({}, {}, [newer, greenEvent]));
    expect(s.gate.lastVerdict?.candidate).toBe('deadbeefcafe');
  });

  it('a RED tick with no candidate/logPath recorded (old-CLI skew) degrades to nulls, not a throw', () => {
    const bareRed: PipelineEventRow = { id: '3', kind: 'green_checkpoint', status: 'not-green', detail: {}, createdAtMs: 5 };
    const s = computeDeployStatus(mkSnap({}, {}, [bareRed]));
    expect(s.gate.lastVerdict).toEqual({ tickAtMs: 5, candidate: null, from: null, status: 'not-green', logPath: null });
  });

  it('gate_health.failingTests (WI-4533) is threaded through unchanged', () => {
    const s = computeDeployStatus(mkSnap({ failingTests: ['lib/a.test.ts', 'lib/b.test.ts'] }, {}, []));
    expect(s.gate.failingTests).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
  });
});
