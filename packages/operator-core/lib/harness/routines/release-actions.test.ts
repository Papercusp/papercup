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
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';
import { describeGateRedOwnership } from '../../release/gate-red-ownership';
import { resolveIntegrationRoot, integrationRootEvidence } from './release-actions';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// --- mocks (hoisted) ---------------------------------------------------------
const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...a) };
});

const appendPipelineEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../git-sync/pipeline-events', () => ({
  appendPipelineEvent: (...a: unknown[]) => appendPipelineEvent(...a),
}));

// EI-10158: the green-checkpoint action's fail-safe stall-tracking + flake-history
// (trackGateStall / trackFlakeHistory) and release-trigger's back-off read reach
// @papercusp/db-org DIRECTLY (getOrgPg().sql.unsafe) — not through appendPipelineEvent.
// Left unmocked, this UNIT test reaches out to real Postgres: it happens to pass when the
// dev box's native :5432 is up, but in CI / embedded-PG / during an operator restart the
// connection is REFUSED, the fail-safe `.catch` logs `console.warn(...ECONNREFUSED...)`, and
// vitest-fail-on-console reds the test (the "failed 4× in 6h" env-dependent flake). Stub the
// SQL boundary so the suite is deterministic regardless of PG reachability. The fake returns
// an empty result with a numeric `.count` (postgres.js Result shape) so every caller —
// rows[0]?.gh (→ {}), cleared.count (→ 0, no stall-clear warn), shouldBackOff(null) (→ false,
// same as the fail-open path) — behaves as the no-prior-state happy path.
const fakeSql = { unsafe: vi.fn(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 })) };
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

// EI-13723: dispatchReleaseFixer's actual fire step (dynamic-imported, so it's invisible to a
// plain function-level mock) — stubbed so the EI-13723 dispatch-convergence tests below can
// assert the fire was ATTEMPTED without touching the real blueprint-launch machinery.
const fireLaunchBlueprintForEvent = vi.fn(async (..._a: unknown[]) => null);
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprintForEvent: (...a: unknown[]) => fireLaunchBlueprintForEvent(...a),
}));
// EI-13723: dispatchReleaseFixer's best-effort flake annotation (testFlakeRollup) reaches
// @papercusp/db-org's `sql` template-tag directly (not sql.unsafe) — the fakeSql stub above only
// implements `.unsafe`, so left unmocked this throws (non-fatally, caught) but still trips
// vitest-fail-on-console via its own warn. Stub it out to an empty rollup for a clean fire test.
vi.mock('../../dev-data', async (orig) => ({
  ...(await orig<typeof import('../../dev-data')>()),
  testFlakeRollup: async () => ({ entries: [] }),
}));
// EI-13723: dispatchReleaseFixer's notify step (notifyAttention) reaches the real SSE
// invalidation bus (notifySyncInvalidate → pg-adapter's `sql` template-tag), which the fakeSql
// stub above doesn't implement — left unmocked this throws, and the bus's own onError handler
// logs via a raw `console.error` (not caught by notifyAttention's try/catch before it fires),
// tripping vitest-fail-on-console. Stub the module boundary like every other test that exercises
// a dispatch path (deploy.test.ts, green-stall-watchdog.test.ts, ...).
const notifyAttention = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../attention-notify', () => ({
  notifyAttention: (...a: unknown[]) => notifyAttention(...a),
}));

// per-hive-git-and-release-gate P-010: the handlers now resolve the operator-home slug to
// route per-hive (green-checkpoint) / guard leg-3 (release-trigger). Make the fixture's
// `my-harness` BE the operator-home so these tests exercise the home (default) path; other
// exports are preserved.
vi.mock('../operator-home-harness', async (orig) => ({
  ...(await orig<typeof import('../operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'my-harness',
}));

// importing register-system-actions runs every side-effect import (git-sync,
// blueprint, release-actions) so the registry is populated as in production.
import '../git-sync/git-sync-action';
import '../../blueprint/blueprint-run-action';
import './release-actions';
import {
  buildIsolatedScopeArgv,
  shouldAutoServe,
  shouldBackOff,
  gateStallEscalationBody,
  decideReleaseFixerDispatch,
  shouldDispatchReleaseFixer,
  isStaleReleaseFixerCandidate,
  checkReleaseFixerCandidateStale,
  classifyGateStallStatus,
  gateStallNoopLogMessage,
  shouldWarnOnStallClearMiss,
  annotateFailingTestsWithFlakeStats,
  releaseToolingStatus,
  DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX,
  resolveGreenCheckpointDbPoolMax,
  RELEASE_FIXER_DEDUP_MS,
  recordCheckpointVerdict,
  buildCheckpointDetail,
  type AutoServePlan,
  type DeployEventRow,
  type ReleaseFixerRecord,
  type GitCheckRunner,
} from './release-actions';
import { getSystemAction, listSystemActions, type SystemActionCtx } from './system-actions';
import type { FlakeSuspect } from '../../dev-data';

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

  /**
   * EI-18672078222841101 — the escalation must say WHO owns the red, because three agents
   * each read a red alert with no ownership field and each correctly-but-redundantly took
   * the gate. Ownership is optional here so an unwired caller renders exactly as before.
   */
  it('carries the ownership verdict, so a responder can tell "covered" from "yours to take"', () => {
    const owned = JSON.parse(
      gateStallEscalationBody({
        installSlug: 'x',
        consecutiveReds: 3,
        heldHrs: 2,
        nowMs: 1,
        ownership: describeGateRedOwnership({
          ownerSignature: 'a.test.ts',
          currentSignature: 'a.test.ts',
          spawnId: 'spawn-9',
          dispatchedAtMs: 1_000,
          fixerAlive: true,
          nowMs: 61_000,
        }),
      }),
    );
    expect(owned.ownership).toMatchObject({ state: 'owned-live', covered: true, spawnId: 'spawn-9' });
    expect(owned.detail).toContain('OWNED');
    expect(owned.detail).toContain('Do NOT start a parallel diagnosis');

    const gone = JSON.parse(
      gateStallEscalationBody({
        installSlug: 'x',
        consecutiveReds: 3,
        heldHrs: 2,
        nowMs: 1,
        ownership: describeGateRedOwnership({
          ownerSignature: 'a.test.ts',
          currentSignature: 'a.test.ts',
          spawnId: 'spawn-dead',
          dispatchedAtMs: 1_000,
          fixerAlive: false,
          nowMs: 61_000,
        }),
      }),
    );
    // The specific regression: the old body asserted "A release-fixer is on it"
    // unconditionally, which is FALSE here and leaves the gate unowned.
    expect(gone.ownership).toMatchObject({ state: 'owner-gone', covered: false });
    expect(gone.detail).toContain('UNOWNED');
    expect(gone.detail).toContain('CONFIRMED GONE');
  });

  it('renders ownership as null (and identically to before) when no owner was resolved', () => {
    const body = JSON.parse(
      gateStallEscalationBody({ installSlug: 'x', consecutiveReds: 3, heldHrs: null, nowMs: 1 }),
    );
    expect(body.ownership).toBeNull();
    expect(body.detail).not.toContain('OWNED');
    expect(body.detail).not.toContain('UNOWNED');
  });
});

describe('shouldWarnOnStallClearMiss (WI-2825: harden the silent 0-row clear no-op)', () => {
  it('warns when an escalation was believed active but the clear matched nothing', () => {
    expect(shouldWarnOnStallClearMiss(true, 0)).toBe(true);
  });

  it('stays silent on the everyday case: no prior escalation, nothing to clear', () => {
    expect(shouldWarnOnStallClearMiss(false, 0)).toBe(false);
  });

  it('stays silent when the clear genuinely matched a row (the expected happy path)', () => {
    expect(shouldWarnOnStallClearMiss(true, 1)).toBe(false);
  });

  it('stays silent for a stallAlerted=false clear that unexpectedly matched a row (nothing suspicious about a stray match)', () => {
    expect(shouldWarnOnStallClearMiss(false, 1)).toBe(false);
  });
});

describe('classifyGateStallStatus (EI-2615: skipped-locked must not fake a red streak)', () => {
  it('a real green verdict resets', () => {
    expect(classifyGateStallStatus('advanced', false)).toBe('reset');
    expect(classifyGateStallStatus('up-to-date', false)).toBe('reset');
    expect(classifyGateStallStatus('advanced-prefix', false)).toBe('reset');
  });

  it('a moved pin resets even on a non-green status (green-checkpoint-lock-starvation-2026-07-02)', () => {
    expect(classifyGateStallStatus('skipped-locked', true)).toBe('reset');
    expect(classifyGateStallStatus('not-green', true)).toBe('reset');
  });

  it('skipped-locked with NO pin movement is a no-op, not a red — the EI-2615 fix', () => {
    // Before the fix this counted as a red, so a healthy tick colliding with a
    // still-in-flight green run could clobber the eventual green reset with a
    // stale/incremented consecutiveReds — exactly the "gate shows RED ~25h after
    // main just went green" symptom EI-2615 reported. The wedge case this was also
    // trying to catch is covered separately by `fireStale` (last-fire/last-green age).
    expect(classifyGateStallStatus('skipped-locked', false)).toBe('noop');
  });

  it('EI-18757975681519069: migrations-pending is a NON-VERDICT, not a red', () => {
    // The gate aborted BEFORE running the suite because the dev PG is known to be
    // behind the candidate, so this tick said nothing about the code. Counting a
    // non-verdict toward the red streak is the identical false-increment bug
    // EI-2615 fixed for lock contention — and it would be self-reinforcing here:
    // a stale schema would inflate consecutiveReds, which escalates as a broken
    // build, sending agents after test failures that are really a missing column.
    // The genuine "migration never applies" case is covered by a backstop — but
    // NOT `fireStale`, as this comment used to say (EI-19321275470651356):
    // `fireStale` keys on last_fired_at, which a noop tick still refreshes, so it
    // reads FRESH. The detector that actually fires is `checkMainBehindStaging`
    // (>20 commits + >1h + no advance in 2h), with `verdictStale` (no green in 12h)
    // as the deep backstop — both in release/green-stall-watchdog.ts.
    expect(classifyGateStallStatus('migrations-pending', false)).toBe('noop');
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus('migrations-pending', true)).toBe('reset');
  });

  it('every other non-green verdict still counts as a red (crash / not-green / etc.)', () => {
    for (const status of ['not-green', 'error', 'create-failed', 'not-fast-forward']) {
      expect(classifyGateStallStatus(status, false)).toBe('red');
    }
  });
});

describe('gateStallNoopLogMessage (EI-19321275470651356: one class, two opposite operator advices)', () => {
  // Both statuses classify as 'noop' and both leave gate_health untouched — that part
  // is correct and deliberate. What differs is what the READER should do next, and the
  // single shared message used to give the wrong answer for one of them.

  it('skipped-locked keeps the peer-lock wording — a peer run IS in flight', () => {
    const msg = gateStallNoopLogMessage('skipped-locked');
    expect(msg).toContain('an active peer run holds the lock');
    expect(msg).toContain('skipped-locked');
  });

  it('migrations-pending must NOT claim a peer run holds the lock — nobody is coming', () => {
    // The regression: this message is one of the first things read when `main` stops
    // advancing. "an active peer run holds the lock" tells the reader to WAIT, which is
    // correct for a lock collision and actively wrong here — the run aborted at the
    // migration preflight and no verdict is coming until the migration applies.
    const msg = gateStallNoopLogMessage('migrations-pending');
    expect(msg).not.toContain('an active peer run holds the lock');
    expect(msg).toContain('migration preflight');
    expect(msg).toContain('NO peer run is in flight');
  });

  it('names the detector that DOES cover the freeze, so the reader is not left thinking nothing watches it', () => {
    // Leaving gate_health untouched reads like "unmonitored" unless the message says
    // otherwise; the freeze is caught by checkMainBehindStaging, not by this counter.
    expect(gateStallNoopLogMessage('migrations-pending')).toContain('checkMainBehindStaging');
  });

  it('an unknown noop-class status falls back to the peer-lock wording rather than throwing', () => {
    expect(gateStallNoopLogMessage('some-future-status')).toContain('some-future-status');
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

// EI-8397: the scope-isolation tests below exercise runScript's DEFAULT root
// resolution (integrationRoot() in release-actions.ts), which falls back to
// `path.resolve(process.cwd(), '..', '..')` when PAPERCUSP_INTEGRATION_ROOT is
// unset — an ambient-cwd-dependent path that only happens to land on the repo
// root (where node_modules/.bin/tsx actually exists) when vitest is invoked
// with cwd 2 levels below the repo root (e.g. from packages/operator-core, as
// `npm run test:affected` does per-workspace). Invoking vitest directly from
// the repo root itself (cwd = repo root) instead resolves 2 levels ABOVE the
// repo — landing outside it entirely ("missing_tsx at /home/…") — a real,
// repeatable false-red (the watchdog's 3x-in-6h signal), not a code defect.
// Fix the TEST, not the ambient-cwd-dependent resolution: pin
// PAPERCUSP_INTEGRATION_ROOT explicitly to the real repo root, computed from
// THIS file's own location (import.meta.url), independent of process.cwd().
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

beforeAll(() => {
  process.env.PAPERCUSP_INTEGRATION_ROOT = REPO_ROOT;
});

afterAll(() => {
  delete process.env.PAPERCUSP_INTEGRATION_ROOT;
});

beforeEach(() => {
  spawnMock.mockReset();
  appendPipelineEvent.mockClear();
  fakeSql.unsafe.mockClear();
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

describe('releaseToolingStatus — packaged sidecar guard', () => {
  it('rejects a packaged .app Contents root that has no dev tsx binary', () => {
    const root = '/Applications/Papercusp Server.app/Contents';
    const script = 'apps/operator/lib/release/green-checkpoint.ts';
    const exists = (p: string) => p.endsWith(script);

    expect(releaseToolingStatus(root, script, exists)).toEqual({
      ok: false,
      reason: 'missing_tsx',
      root,
      tsx: `${root}/node_modules/.bin/tsx`,
      script: `${root}/${script}`,
    });
  });
});

describe('release-trigger — noop gating + detached auto-deploy', () => {
  it('skips without spawning when the packaged host has no release tooling', async () => {
    const oldRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/Applications/Papercusp Server.app/Contents';
    const action = getSystemAction('release-trigger')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await action(ctx);
    } finally {
      if (oldRoot == null) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = oldRoot;
      warn.mockRestore();
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        installSlug: 'my-harness',
        kind: 'deploy',
        status: 'skipped-no-tooling',
        detail: expect.objectContaining({ reason: 'missing_tsx' }),
      }),
    );
  });

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

describe('annotateFailingTestsWithFlakeStats (EI-7443)', () => {
  function suspect(over: Partial<FlakeSuspect> & { file_path: string }): FlakeSuspect {
    return {
      file_path: over.file_path,
      fails: over.fails ?? 10,
      passes: over.passes ?? 50,
      both_status_shas: over.both_status_shas ?? 3,
      flake_rate: over.flake_rate ?? 0.167,
      last_fail: over.last_fail ?? null,
      last_pass: over.last_pass ?? null,
      reason: over.reason ?? 'flake-shaped',
    };
  }

  it('returns undefined when there are no failing tests', () => {
    expect(annotateFailingTestsWithFlakeStats(undefined, [suspect({ file_path: 'a.test.ts' })])).toBeUndefined();
    expect(annotateFailingTestsWithFlakeStats([], [suspect({ file_path: 'a.test.ts' })])).toBeUndefined();
  });

  it('returns undefined when there are no flagged suspects at all', () => {
    expect(annotateFailingTestsWithFlakeStats(['a.test.ts'], [])).toBeUndefined();
  });

  it('returns undefined when the failing files do not overlap any flagged suspect (a real regression)', () => {
    expect(
      annotateFailingTestsWithFlakeStats(['regression.test.ts'], [suspect({ file_path: 'unrelated.test.ts' })]),
    ).toBeUndefined();
  });

  it('annotates ONLY the failing files that match a flagged suspect, ignoring the rest', () => {
    const out = annotateFailingTestsWithFlakeStats(
      ['flaky.test.ts', 'regression.test.ts'],
      [suspect({ file_path: 'flaky.test.ts', fails: 12, passes: 53, both_status_shas: 4, flake_rate: 0.185 })],
    );
    expect(out).toContain('EI-7443');
    expect(out).toContain('flaky.test.ts: 12F/53P over 7d, 4 commit(s)');
    expect(out).toContain('flake_rate=0.185');
    expect(out).not.toContain('regression.test.ts');
  });
});

describe('shouldDispatchReleaseFixer (EI-8740: no fixer for a held gate with nothing to fix)', () => {
  it('dispatches on not-green with real failing tests', () => {
    expect(shouldDispatchReleaseFixer('not-green', 'cafe1234', ['a.test.ts'])).toBe(true);
  });

  it('dispatches on advanced-prefix with real failing tests (P-016 red-tip case)', () => {
    expect(shouldDispatchReleaseFixer('advanced-prefix', 'cafe1234', ['@papercusp/operator-vite'])).toBe(true);
  });

  it('does NOT dispatch on not-green with EMPTY failingTests (the EI-8740 no-op-churn case)', () => {
    expect(shouldDispatchReleaseFixer('not-green', 'cafe1234', [])).toBe(false);
  });

  it('does NOT dispatch when failingTests is undefined', () => {
    expect(shouldDispatchReleaseFixer('not-green', 'cafe1234', undefined)).toBe(false);
  });

  it('does NOT dispatch without a candidate', () => {
    expect(shouldDispatchReleaseFixer('not-green', undefined, ['a.test.ts'])).toBe(false);
  });

  it('does NOT dispatch on other statuses (advanced, up-to-date, error, ...) even with failing tests', () => {
    for (const status of ['advanced', 'up-to-date', 'error', 'create-failed', 'not-fast-forward', 'skipped-locked']) {
      expect(shouldDispatchReleaseFixer(status, 'cafe1234', ['a.test.ts'])).toBe(false);
    }
  });
});

describe('decideReleaseFixerDispatch — liveness-aware dedup (P-014 / D-009)', () => {
  const now = 1_700_000_000_000;
  const SIG = 'a.test.ts,b.test.ts';
  const rec = (over: Partial<ReleaseFixerRecord> = {}): ReleaseFixerRecord => ({
    signature: SIG,
    candidate: 'cafe',
    at: now - 30 * 60_000, // 30 min ago (inside the 2h window)
    spawnId: 's-fixer-1',
    ...over,
  });

  it('FRESH: no prior record → dispatch + notify', () => {
    const d = decideReleaseFixerDispatch({ lf: null, signature: SIG, now, fixerAlive: null });
    expect(d).toEqual({ dispatch: true, notify: true, reason: 'fresh' });
  });

  it('FRESH: a DIFFERENT signature within the window → dispatch + notify (a new red)', () => {
    const d = decideReleaseFixerDispatch({ lf: rec({ signature: 'other.test.ts' }), signature: SIG, now, fixerAlive: true });
    expect(d).toMatchObject({ dispatch: true, reason: 'fresh' });
  });

  it('FRESH: same signature but the record AGED OUT past the window → dispatch + notify', () => {
    const d = decideReleaseFixerDispatch({ lf: rec({ at: now - 3 * 60 * 60_000 }), signature: SIG, now, fixerAlive: false });
    expect(d).toMatchObject({ dispatch: true, reason: 'fresh' });
  });

  it('COVERED: same signature, fixer ALIVE → skip (the good dedup — do not pile on)', () => {
    const d = decideReleaseFixerDispatch({ lf: rec(), signature: SIG, now, fixerAlive: true });
    expect(d).toEqual({ dispatch: false, notify: false, reason: 'covered' });
  });

  it('COVERED: same signature, liveness UNKNOWN (null — durable/legacy record) → skip, no regression', () => {
    const d = decideReleaseFixerDispatch({ lf: rec({ spawnId: null }), signature: SIG, now, fixerAlive: null });
    expect(d).toEqual({ dispatch: false, notify: false, reason: 'covered' });
  });

  it('SELF-HEAL: same signature, fixer DEAD → re-dispatch (the incident fix — was a 2h gap)', () => {
    const d = decideReleaseFixerDispatch({ lf: rec({ notifiedAt: now - 30 * 60_000 }), signature: SIG, now, fixerAlive: false });
    expect(d.dispatch).toBe(true);
    expect(d.reason).toBe('self-heal');
  });

  it('SELF-HEAL: re-dispatch NOTIFY is rate-limited — notified recently → re-dispatch but suppress notify', () => {
    const d = decideReleaseFixerDispatch({ lf: rec({ notifiedAt: now - 10 * 60_000 }), signature: SIG, now, fixerAlive: false });
    expect(d.dispatch).toBe(true);
    expect(d.notify).toBe(false); // last notify 10 min ago < 2h cooldown
  });

  it('SELF-HEAL: re-dispatch DOES notify once the notify cooldown elapses', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ at: now - 30 * 60_000, notifiedAt: now - 3 * 60 * 60_000 }),
      signature: SIG,
      now,
      fixerAlive: false,
      notifyCooldownMs: 2 * 60 * 60_000,
    });
    expect(d).toMatchObject({ dispatch: true, notify: true, reason: 'self-heal' });
  });

  it('the 2h dedup window is the documented default', () => {
    expect(RELEASE_FIXER_DEDUP_MS).toBe(2 * 60 * 60_000);
  });
});

describe('isStaleReleaseFixerCandidate (EI-8718: no fixer for a superseded/self-healed candidate)', () => {
  it('a valid, not-yet-promoted candidate is NOT stale — the legitimate-dispatch case', () => {
    expect(isStaleReleaseFixerCandidate({ candidateExists: true, candidatePromoted: false })).toBe(false);
  });

  it('a candidate whose object no longer exists (superseded + GC\'d) IS stale', () => {
    expect(isStaleReleaseFixerCandidate({ candidateExists: false, candidatePromoted: false })).toBe(true);
  });

  it('a candidate already reachable from origin/main (self-healed to green) IS stale', () => {
    expect(isStaleReleaseFixerCandidate({ candidateExists: true, candidatePromoted: true })).toBe(true);
  });
});

describe('checkReleaseFixerCandidateStale — live re-verify (EI-8718)', () => {
  const fakeRunner = (impl: (args: string[]) => { ok: boolean; stdout: string }): GitCheckRunner => {
    return async (_root: string, args: string[]) => impl(args);
  };

  it('object missing → candidateExists:false, candidatePromoted:false, and skips the ancestor check', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((args) => {
      calls.push(args);
      return { ok: false, stdout: '' }; // cat-file -e fails
    });
    const r = await checkReleaseFixerCandidateStale('/repo', 'deadbeef', runner);
    expect(r).toEqual({ candidateExists: false, candidatePromoted: false });
    expect(calls).toHaveLength(1); // never ran the rev-list check
  });

  it('object exists, origin/main does NOT yet contain it → not promoted (genuinely red)', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: true, stdout: '3' },
    );
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner);
    expect(r).toEqual({ candidateExists: true, candidatePromoted: false });
  });

  it('object exists, origin/main ALREADY contains it (count 0) → promoted (self-healed to green)', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: true, stdout: '0' },
    );
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner);
    expect(r).toEqual({ candidateExists: true, candidatePromoted: true });
  });

  it('a transient git error on the ancestor check fails CLOSED to not-promoted, not stale', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: false, stdout: '' },
    );
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner);
    expect(r).toEqual({ candidateExists: true, candidatePromoted: false });
  });
});

describe('green-checkpoint scope isolation (2026-07-01 bg-host OOM blast-radius)', () => {
  const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';
  const okStdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'up-to-date', green: true })}\n`;

  /** fakeSpawn with stderr + configurable exit code (scope-launch-failure shape). */
  function fakeSpawnFail(stderr: string, code = 1): ReturnType<typeof fakeSpawn> {
    const child = new EventEmitter() as ReturnType<typeof fakeSpawn>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  }

  const savedScopeEnv = process.env.PAPERCUSP_CHECKPOINT_SCOPE;
  afterEach(() => {
    if (savedScopeEnv === undefined) delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    else process.env.PAPERCUSP_CHECKPOINT_SCOPE = savedScopeEnv;
  });

  it('EI-10158: a green tick tracks the stall streak through the MOCKED sql — no real PG, no ECONNREFUSED console.warn', async () => {
    // Regression guard for the env-dependent flake: trackGateStall reaches
    // @papercusp/db-org directly. With the db-org mock in place the green-checkpoint
    // action must query gate_health via the fake sql (never a real :5432 connect) and
    // its fail-safe .catch must NOT fire a stall-tracking warn. Before the mock this
    // console.warn'd ECONNREFUSED whenever PG was unreachable (CI / operator restart),
    // which vitest-fail-on-console turns red.
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getSystemAction('green-checkpoint')!(ctx);
    // The stall-tracking SELECT ran against the fake sql, scoped to the install slug.
    expect(fakeSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('gate_health'), ['my-harness']);
    // …so the fail-safe catch never logged a stall-tracking failure (the flake's warn).
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('stall tracking failed'));
    warn.mockRestore();
  });

  it('buildIsolatedScopeArgv wraps the payload in a memory-capped transient user SCOPE', () => {
    const argv = buildIsolatedScopeArgv(['/x/tsx', '/x/suite.ts'], 16);
    expect(argv[0]).toBe('systemd-run');
    expect(argv).toContain('--user');
    expect(argv).toContain('--scope'); // scope (child stays OURS: stdio/env/pgid) — never --unit
    expect(argv).toContain('--collect');
    expect(argv).toContain('--property=MemoryMax=16G');
    expect(argv).toContain('--property=MemorySwapMax=0'); // mirror the bg-host swap policy
    // Payload appended verbatim, in order, at the end.
    expect(argv.slice(-2)).toEqual(['/x/tsx', '/x/suite.ts']);
  });

  it('the PERIODIC gate launches the suite under systemd-run --scope (own cgroup, stdout marker still parsed)', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--scope');
    expect(args.some((a) => /^--property=MemoryMax=\d+G$/.test(a))).toBe(true);
    expect(args.join(' ')).toContain('green-checkpoint.ts');
    // The verdict still lands as a pipeline event (stdout was piped through the scope).
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'green_checkpoint', status: 'up-to-date' }),
    );
  });

  it('WI-4310: checkpoint child receives a bounded dedicated DB pool override', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    const opts = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env?.PAPERCUSP_DB_POOL_MAX).toBe(String(DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX));
  });

  it('WI-4310: checkpoint pool cap is hot-tunable and clamped to one connection', () => {
    process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '3.9';
    expect(resolveGreenCheckpointDbPoolMax()).toBe(3);
    process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '0';
    expect(resolveGreenCheckpointDbPoolMax()).toBe(DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX);
    process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '-2';
    expect(resolveGreenCheckpointDbPoolMax()).toBe(DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX);
    delete process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
  });

  it('falls back to a DIRECT spawn when the scope cannot launch (no user bus) — the gate never red-pins on infra', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    spawnMock
      .mockImplementationOnce(() => fakeSpawnFail('Failed to connect to bus: No such file or directory', 1))
      .mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd2, args2] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd2).not.toBe('systemd-run'); // direct tsx payload
    expect(cmd2).toContain('tsx');
    expect(args2.join(' ')).toContain('green-checkpoint.ts');
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'green_checkpoint', status: 'up-to-date' }),
    );
  });

  it('a PAYLOAD failure inside a healthy scope does NOT retry (one suite run per tick)', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    // Non-zero exit but no scope-launch-shaped stderr → the suite itself failed; no fallback.
    spawnMock.mockImplementationOnce(() => fakeSpawnFail('vitest: 3 tests failed', 1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getSystemAction('green-checkpoint')!(ctx);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exited 1'));
    warn.mockRestore();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'green_checkpoint', status: 'error' }),
    );
  });

  it('PAPERCUSP_CHECKPOINT_SCOPE=0 kill-switch runs the pre-isolation direct spawn', async () => {
    process.env.PAPERCUSP_CHECKPOINT_SCOPE = '0';
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).not.toBe('systemd-run');
    expect(cmd).toContain('tsx');
  });
});

/**
 * WI-4494 — THE RUN THAT PRODUCES A VERDICT IS THE RUN THAT RECORDS IT.
 *
 * Before this, `gate_health` + the pipeline event were written ONLY by the routine that parsed the
 * CLI's stdout. A detached manual run (`release:checkpoint-run`) therefore ran the full suite,
 * computed a real green/red — and threw it away, while HOLDING the run-lock that forced the hourly
 * routine (the only recorder) to log `skipped-locked` and record nothing either. Live 2026-07-12:
 * three consecutive fires skipped, gate_health frozen on a stale red, release pin unmoved ~10h, and
 * the WI-4486 memory-blackout fix unable to ship on a green pin. Our own code had named the root
 * cause ten days earlier — "only ROUTINE-invoked runs write pipeline events / gate_health" — and
 * both prior attempts reconciled the wrong value instead of removing the wrongness.
 */
describe('WI-4494: recordCheckpointVerdict — the producer records', () => {
  beforeEach(() => {
    appendPipelineEvent.mockClear();
    fakeSql.unsafe.mockClear();
  });

  it('⭐ a lock collision records NOTHING — the run holding the lock has the real verdict', () => {
    // This is the fix's load-bearing asymmetry. A colliding run must stay silent (it observed
    // nothing), while the run that WON the lock records. If a `skipped-locked` could record, it
    // would clobber a real verdict with a non-observation — the same bug, mirrored.
    return recordCheckpointVerdict({ workspaceId: 'ws-42', installSlug: 'my-harness' }, { reason: 'skipped-locked' }).then(
      (recorded) => {
        expect(recorded).toBe(false);
        expect(appendPipelineEvent).not.toHaveBeenCalled();
        expect(fakeSql.unsafe).not.toHaveBeenCalled(); // gate_health untouched
      },
    );
  });

  it('⭐ a RED from ANY runner lands in gate_health + the pipeline history', async () => {
    const recorded = await recordCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      { reason: 'not-green', green: false, candidate: 'abc123def456789', from: '28a3a3d50258', failingTests: ['lib/x.test.ts'] },
    );
    expect(recorded).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-42',
        installSlug: 'my-harness',
        kind: 'green_checkpoint',
        status: 'not-green',
        detail: expect.objectContaining({ green: false, candidate: 'abc123def456', failingTests: ['lib/x.test.ts'] }),
      }),
    );
    // …and the gate_health blob was read + written for that harness (the streak now moves).
    expect(fakeSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('gate_health'), ['my-harness']);
  });

  it('a GREEN from any runner records too — that is what resets a frozen streak', async () => {
    expect(
      await recordCheckpointVerdict({ workspaceId: 'ws-42', installSlug: 'my-harness' }, { reason: 'advanced', green: true, candidate: 'deadbeefcafe' }),
    ).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'advanced' }));
  });

  it('buildCheckpointDetail truncates shas to 12 and caps the lists (parity with the routine it replaced)', () => {
    const d = buildCheckpointDetail({
      reason: 'advanced-prefix',
      green: false,
      candidate: 'a'.repeat(40),
      from: 'b'.repeat(40),
      advancedTo: 'c'.repeat(40),
      failingTests: Array.from({ length: 30 }, (_, i) => `t${i}.test.ts`),
    });
    expect(d.candidate).toBe('a'.repeat(12));
    expect(d.from).toBe('b'.repeat(12));
    expect(d.advancedTo).toBe('c'.repeat(12));
    expect((d.failingTests as string[]).length).toBe(20);
  });

  it('EI-15849: buildCheckpointDetail persists isolationNote even when the gate is NOT absorbed (red) — the absorber\'s reasoning must survive past the truncated console log', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      isolationNote: 'isolation: 1 file(s) STILL FAILED in isolation — real break, gate stays red: @p/core::a.test.ts',
    });
    expect(d.isolationNote).toBe(
      'isolation: 1 file(s) STILL FAILED in isolation — real break, gate stays red: @p/core::a.test.ts',
    );
  });

  it('EI-15849: buildCheckpointDetail caps an oversized isolationNote at 2000 chars', () => {
    const d = buildCheckpointDetail({ reason: 'not-green', green: false, isolationNote: 'x'.repeat(5000) });
    expect((d.isolationNote as string).length).toBe(2000);
  });

  it('EI-18685041726970077: buildCheckpointDetail persists the gate lineage (candidate/tip truncated to 12, list capped)', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        commitsBehind: 5,
        failingFilesChangedInRange: Array.from({ length: 30 }, (_, i) => `t${i}.test.ts`),
      },
    });
    expect(d.lineage).toEqual({
      candidate: 'a'.repeat(12),
      tip: 'b'.repeat(12),
      commitsBehind: 5,
      failingFilesChangedInRange: Array.from({ length: 20 }, (_, i) => `t${i}.test.ts`),
    });
  });

  it('EI-20215068298600724: buildCheckpointDetail persists unmatched failing files (capped)', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        commitsBehind: 5,
        failingFilesChangedInRange: ['packages/operator-core/lib/a.test.ts'],
        failingFilesUnchangedInRange: Array.from({ length: 30 }, (_, i) => `lib/u${i}.test.ts`),
      },
    });
    expect((d.lineage as Record<string, unknown>).failingFilesUnchangedInRange).toEqual(
      Array.from({ length: 20 }, (_, i) => `lib/u${i}.test.ts`),
    );
  });

  it('buildCheckpointDetail omits lineage entirely when absent (no lineage read this run)', () => {
    const d = buildCheckpointDetail({ reason: 'not-green', green: false, candidate: 'a'.repeat(40) });
    expect(d.lineage).toBeUndefined();
  });

  /*
   * EI-20063423357086565. Every OTHER leg of this record is derived from commits, so a
   * durable row can show "candidate IS the tip, 0 behind, nothing changed in range" — three
   * true commit-based facts that together read as a confirmed real red — while the fix sat
   * uncommitted on disk the whole time. That is the row a later reader does archaeology
   * against, so the non-commit leg has to survive into it.
   */
  it('EI-20063423357086565: buildCheckpointDetail persists failingFilesDirtyUncommitted (capped), so the durable row cannot re-state the false confidence', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'a'.repeat(40), // candidate IS the tip — the confident, and here WRONG, shape
        commitsBehind: 0,
        failingFilesChangedInRange: [],
        failingFilesDirtyUncommitted: Array.from({ length: 30 }, (_, i) => `d${i}.test.ts`),
      },
    });
    expect((d.lineage as Record<string, unknown>).failingFilesDirtyUncommitted).toEqual(
      Array.from({ length: 20 }, (_, i) => `d${i}.test.ts`),
    );
  });

  it('EI-20063423357086565: an EMPTY dirty list is omitted rather than written as a measured []', () => {
    // CONTROL for the test above — proves that assertion is driven by the field's value and
    // not by the key being written unconditionally. An empty array persisted here would read
    // as "we checked and the tree was clean", a claim this leg is not entitled to make.
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        commitsBehind: 2,
        failingFilesChangedInRange: [],
        failingFilesDirtyUncommitted: [],
      },
    });
    expect((d.lineage as Record<string, unknown>).failingFilesDirtyUncommitted).toBeUndefined();
  });

  /**
   * WI-7290. The durable record carried the WEAK proxy (lineage: "a failing file was modified
   * somewhere in the range") but not the DIRECT measurement (retriage: "we re-ran those exact
   * files at tip"). Three filings in one night each re-derived the latter from raw logs because
   * an absent field reads identically to "the gate never checked".
   */
  describe('WI-7290: the re-triage verdict reaches the DURABLE record, not just gate_health', () => {
    it('⭐ persists a real-red-at-tip re-triage — the finding gate_health deliberately drops', () => {
      // gate_health keeps only the stale-candidate case (retriageStaleTip/retriageDetail are
      // paired + cleared so a stale note cannot outlive its verdict). That is correct there, and
      // it is exactly why THIS verdict — "we re-ran them at tip and they still fail" — has to
      // survive here instead: it is the single most decision-relevant fact about a red.
      const d = buildCheckpointDetail({
        reason: 'not-green',
        green: false,
        candidate: 'a'.repeat(40),
        retriage: {
          classification: 'real-red',
          tip: 'b'.repeat(40),
          detail: '6 failing file(s) REPRODUCE at tip bbbbbbbb',
        },
      });
      expect(d.retriage).toEqual({
        classification: 'real-red',
        tip: 'b'.repeat(12),
        detail: '6 failing file(s) REPRODUCE at tip bbbbbbbb',
      });
    });

    it('⭐ persists an `unknown` re-triage WITH its skip reason — "never measured" must not read as "measured and real"', () => {
      const d = buildCheckpointDetail({
        reason: 'not-green',
        green: false,
        candidate: 'a'.repeat(40),
        retriage: {
          classification: 'unknown',
          tip: 'b'.repeat(40),
          detail: 'tip re-run SKIPPED: none of the 2 failing entries could be turned into something re-runnable',
        },
      });
      expect((d.retriage as { classification: string }).classification).toBe('unknown');
      expect((d.retriage as { detail: string }).detail).toContain('SKIPPED');
    });

    it('caps an oversized detail at 500 chars and tolerates a null tip', () => {
      const d = buildCheckpointDetail({
        reason: 'not-green',
        green: false,
        retriage: { classification: 'unknown', tip: null, detail: 'x'.repeat(2000) },
      });
      expect((d.retriage as { detail: string }).detail).toHaveLength(500);
      expect((d.retriage as { tip: string | null }).tip).toBeNull();
    });

    it('omits retriage entirely when the run produced none (a green tick records no verdict about staleness)', () => {
      const d = buildCheckpointDetail({ reason: 'advanced', green: true, candidate: 'a'.repeat(40) });
      expect(d.retriage).toBeUndefined();
    });
  });
});

describe('WI-4494: the routine defers to a run that already recorded (no double-counted reds)', () => {
  const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';

  beforeEach(() => {
    appendPipelineEvent.mockClear();
    fakeSql.unsafe.mockClear();
  });

  it('⭐ recorded:true ⇒ the routine records NOTHING — a second trackGateStall would count one red twice', async () => {
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'not-green', green: false, candidate: 'abc123', recorded: true })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    // The decisive one: no gate_health read-modify-write, so the streak moves exactly once per
    // verdict — by the run that produced it.
    expect(fakeSql.unsafe).not.toHaveBeenCalledWith(expect.stringContaining('gate_health'), expect.anything());
  });

  it('⭐ no `recorded` flag (an OLD CLI — the deployed routine drives the integration tree) ⇒ the routine STILL records', async () => {
    // The version-skew safety valve. This is why the change cannot blind the gate: absent the flag
    // we fall straight back to pre-WI-4494 behaviour.
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'not-green', green: false, candidate: 'abc123' })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'not-green' }));
    expect(fakeSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('gate_health'), ['my-harness']);
  });

  it('⭐ hands the CLI the record target — without this env the run cannot know whose gate it judges', async () => {
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'up-to-date', green: true, recorded: true })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    const opts = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env?.PAPERCUSP_GATE_VERDICT_WORKSPACE).toBe('ws-42');
    expect(opts.env?.PAPERCUSP_GATE_VERDICT_HARNESS).toBe('my-harness');
  });
});

describe('EI-13723: recordCheckpointVerdict also dispatches the release-fixer (not just the routine)', () => {
  beforeEach(() => {
    appendPipelineEvent.mockClear();
    fakeSql.unsafe.mockClear();
    fireLaunchBlueprintForEvent.mockClear();
    fireLaunchBlueprintForEvent.mockResolvedValue(null);
  });

  it('⭐ a manual run (release:checkpoint-run) — which self-records via recordCheckpointVerdict and never touches the routine handler — still fires the release-fixer for a fresh red', async () => {
    // The candidate must survive isStaleReleaseFixerCandidate's live re-verify: exists (cat-file -e
    // exit 0) and NOT yet promoted onto origin/main (rev-list --count > 0 ⇒ not an ancestor).
    //
    // Dispatch on ARGS, not call ORDER. Other git reads share this same `spawn` seam — since
    // EI-19329732364513693, trackGateStall measures candidate staleness (`log -1 --format=%cI`
    // and `rev-list --count <candidate>..staging`) on the same recordCheckpointVerdict path, and
    // it runs FIRST. A positional mockImplementationOnce chain therefore hands this check
    // someone else's response: cat-file silently reads as exit≠0, the candidate looks GC'd, the
    // fixer dispatch is skipped, and this test fails for a reason that has nothing to do with
    // the behaviour it guards. Matching on args is immune to any future added git call.
    spawnMock.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args.includes('cat-file')) return fakeSpawn('', 0); // <candidate>^{commit} → exists
      if (args.some((a) => typeof a === 'string' && a.startsWith('origin/main..'))) {
        return fakeSpawn('3', 0); // rev-list --count origin/main..<candidate> → not promoted
      }
      return fakeSpawn('', 0); // any other git read (staleness measurement) — value irrelevant here
    });

    const recorded = await recordCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      { reason: 'not-green', green: false, candidate: 'deadbeefcafe0123', failingTests: ['lib/y.test.ts'] },
    );

    expect(recorded).toBe(true);
    // The bug: before EI-13723 this fire NEVER happened for a verdict recorded outside the
    // routine handler — exactly the shape a manual release:checkpoint-run self-records through.
    expect(fireLaunchBlueprintForEvent).toHaveBeenCalledWith(
      'green-checkpoint:red',
      expect.objectContaining({ installSlug: 'my-harness', workspaceId: 'ws-42' }),
    );
  });

  it('does NOT double-dispatch when the routine ALSO sees a recorded:true verdict — recordCheckpointVerdict already covered it', async () => {
    const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';
    // Modern CLI: self-records (recorded:true) — the routine's OWN post-processing must defer
    // entirely rather than re-run (now-redundant) dispatch logic for the same verdict.
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'not-green', green: false, candidate: 'deadbeefcafe0123', failingTests: ['lib/y.test.ts'], recorded: true })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(fireLaunchBlueprintForEvent).not.toHaveBeenCalled();
  });
});

/**
 * EI-20263854732193595 — the integration root must FAIL CLOSED.
 *
 * The old fallback was `process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(cwd,'..','..')`,
 * which is CORRECT for a normal operator and CATASTROPHIC for one running out of the
 * release checkout — and returned both without complaint. A wrong-tree gate run does not
 * error; it produces a well-formed verdict about the wrong commits, which is why this was
 * only noticed when two agents independently concluded the gate was executing the release
 * copy of green-checkpoint.ts during a 22h freeze.
 *
 * These cases are written so the guard is FALSIFIABLE in both directions: the refusals
 * must fire, AND the paths that legitimately worked before must keep working (a guard
 * that refuses everything would pass a refusal-only suite while breaking the operator).
 */
describe('EI-20263854732193595: resolveIntegrationRoot fails closed on release/checkpoint checkouts', () => {
  const WS = '/home/dev/papercupai-workspace';

  it('REFUSES the release checkout when the env var is unset (the silent-wrong-tree case)', () => {
    expect(() => resolveIntegrationRoot({}, `${WS}/papercup-release/apps/operator`)).toThrow(
      /refusing to gate .*papercup-release/,
    );
  });

  it('REFUSES the gate\'s own checkpoint test tree', () => {
    expect(() => resolveIntegrationRoot({}, `${WS}/papercusp-checkpoint/apps/operator`)).toThrow(
      /refusing to gate .*papercusp-checkpoint/,
    );
  });

  it('names the offending path AND the remedy — a refusal nobody can act on just moves the confusion', () => {
    let msg = '';
    try {
      resolveIntegrationRoot({}, `${WS}/papercusp-release/apps/operator`);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain(`${WS}/papercusp-release`); // the resolved path, not just the basename
    expect(msg).toContain('PAPERCUSP_INTEGRATION_ROOT'); // how to fix it
  });

  it('STILL resolves the normal staging operator via the cwd fallback (guard must not break the working path)', () => {
    expect(resolveIntegrationRoot({}, `${WS}/papercusp/apps/operator`)).toBe(`${WS}/papercusp`);
  });

  it('an EXPLICIT env root always wins — even when cwd sits inside the release checkout', () => {
    expect(
      resolveIntegrationRoot(
        { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` },
        `${WS}/papercup-release/apps/operator`,
      ),
    ).toBe(`${WS}/papercusp`);
  });

  /* ---- root-in-log evidence -------------------------------------------------
   * The guard above only refuses the KNOWN-BAD checkouts. An explicit env root
   * pointing somewhere unexpected is still silently wrong, and no guard can catch
   * that — only a human reading the log can. So the run has to SAY which tree it
   * judged, and say how it decided. */

  it('states the resolved root AND how it was decided (cwd fallback)', () => {
    const line = integrationRootEvidence({}, `${WS}/papercusp/apps/operator`);
    expect(line).toContain(`${WS}/papercusp`);
    expect(line).toContain('source=cwd-fallback');
  });

  it('distinguishes an EXPLICIT env root from the fallback — the two failure modes differ', () => {
    const line = integrationRootEvidence(
      { PAPERCUSP_INTEGRATION_ROOT: `${WS}/somewhere-else` },
      `${WS}/papercusp/apps/operator`,
    );
    expect(line).toContain(`${WS}/somewhere-else`);
    expect(line).toContain('source=PAPERCUSP_INTEGRATION_ROOT');
    // ...and must NOT claim the fallback produced it — that mislabel would send a
    // reader hunting a cwd bug when the real cause is an env var.
    expect(line).not.toContain('cwd-fallback');
  });

  it('propagates the refusal rather than logging a well-formed line about a bad tree', () => {
    expect(() => integrationRootEvidence({}, `${WS}/papercup-release/apps/operator`)).toThrow(
      /refusing to gate/,
    );
  });

  /* A builder nobody calls emits no evidence, which is indistinguishable from the bug
   * this closes. Pin the CALL SITE in the checkpoint action, not just the function. */
  it('is actually invoked by the green-checkpoint action (evidence must reach the run log)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      fileURLToPath(new URL('./release-actions.ts', import.meta.url)),
      'utf8',
    );
    const callSite = /integrationRootEvidence\(\)/.test(src);
    expect(callSite, 'integrationRootEvidence() must be called, not merely exported').toBe(true);
    // it must be logged BEFORE routing/verdict work, or it is missing from exactly the
    // runs that go wrong early
    const evidenceIdx = src.indexOf('integrationRootEvidence()');
    const routingIdx = src.indexOf('await resolveCheckpointRouting(ctx');
    expect(evidenceIdx).toBeGreaterThan(-1);
    expect(routingIdx).toBeGreaterThan(-1);
    expect(evidenceIdx).toBeLessThan(routingIdx);
  });
});
