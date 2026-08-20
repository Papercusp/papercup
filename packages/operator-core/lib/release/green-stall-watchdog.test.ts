/**
 * EI-455 bug #2 — green-stall-watchdog verdict logic. The DB wiring (checkGreenStall)
 * is integration-covered by the live self-test; here we pin the pure decision +
 * escalation body that decide WHEN the silent-stall alarm fires.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// EI-9922: stub `execFileSync` itself so the stderr-suppression assertion below is
// deterministic regardless of what git checkout (or non-repo) the test runs inside —
// mirrors workspace-map.test.ts's EI-8794 approach.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from 'node:child_process';

// EI-10103: checkMainBehindStaging's DB writes are exercised with mocked sql/notify/broadcast
// surfaces (mirrors workspace-for-harness.test.ts's mock-the-dependency unit style) rather than
// a live PG — the regression is about which VALUE reaches the harness_escalations insert, not
// schema/constraint enforcement itself.
const resolveWorkspaceForHarnessMock = vi.fn();
vi.mock('../harness/workspace-for-harness', () => ({
  resolveWorkspaceForHarness: (...args: unknown[]) => resolveWorkspaceForHarnessMock(...args),
}));
const notifyAttentionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../attention-notify', () => ({
  notifyAttention: (...args: unknown[]) => notifyAttentionMock(...args),
}));
const broadcastSevereEventMock = vi.fn().mockResolvedValue(true);
const broadcastSevereEventResolvedMock = vi.fn().mockResolvedValue(true);
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: (...args: unknown[]) => broadcastSevereEventMock(...args),
  broadcastSevereEventResolved: (...args: unknown[]) => broadcastSevereEventResolvedMock(...args),
}));

// WI-4322: checkReleaseTriggerFreeze's DB wiring is exercised the same way — mock the
// pipeline-snapshot + status-computation seams it dynamically imports rather than hitting
// real git/PG (the regression under test is the DECISION logic, not those functions).
const gitPipelineSnapshotMock = vi.fn().mockResolvedValue({});
vi.mock('../git-pipeline-stats', () => ({
  gitPipelineSnapshot: (...args: unknown[]) => gitPipelineSnapshotMock(...args),
}));
const computeDeployStatusMock = vi.fn();
const integrationRootMock = vi.fn(() => '/DEFAULT');
vi.mock('../release-deploy-launch', () => ({
  computeDeployStatus: (...args: unknown[]) => computeDeployStatusMock(...args),
  integrationRoot: (...args: unknown[]) => integrationRootMock(...args),
}));

const resolveCheckpointRoutingMock = vi.fn();
vi.mock('../harness/routines/hive-release-env', () => ({
  resolveCheckpointRouting: (...args: unknown[]) => resolveCheckpointRoutingMock(...args),
}));
const isCheckpointRunLockHeldCheapMock = vi.fn();
const readCheckpointRunPhaseCheapMock = vi.fn();
vi.mock('../release-checkpoint-launch', () => ({
  isCheckpointRunLockHeldCheap: (...args: unknown[]) => isCheckpointRunLockHeldCheapMock(...args),
  readCheckpointRunPhaseCheap: (...args: unknown[]) => readCheckpointRunPhaseCheapMock(...args),
}));
const readRoutineEngineLivenessMock = vi.fn();
vi.mock('./routine-engine-liveness', () => ({
  readRoutineEngineLiveness: (...args: unknown[]) => readRoutineEngineLivenessMock(...args),
}));

import {
  evaluateGreenStall,
  checkGreenStall,
  greenStallEscalationBody,
  evaluateMainBehindStaging,
  mainBehindRecoverySummary,
  computeMainBehindStaging,
  checkMainBehindStaging,
  evaluateReleaseTriggerFreeze,
  checkReleaseTriggerFreeze,
  lastReleaseTriggerPauseOwner,
  evaluateReleaseTriggerFireStale,
  checkReleaseTriggerFireStale,
  attributeVerdictStale,
  readLastGateRunEvidence,
} from './green-stall-watchdog';

const H = 60 * 60 * 1000;
const NOW = 1_750_000_000_000; // fixed epoch ms

describe('evaluateGreenStall', () => {
  it('a fresh install (never fired, never green) does not alarm', () => {
    const v = evaluateGreenStall({ lastFiredMs: null, lastGreenAt: null, watchdogAlerted: false }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('a healthy routine (fired + greened within the hour) does not alarm', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 20 * 60 * 1000, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  /**
   * P-016 — "muted" and "healthy" are different answers.
   *
   * Both render `stalled: false`, and collapsing them is what made the watchdog
   * broadcast `green-checkpoint RECOVERED — the gate is producing verdicts
   * again` from the branch that deliberately declined to check. Engine staleness
   * flickers on a loaded box, so that false all-clear fired on every flicker —
   * the observed STALLED/RECOVERED alternation inside one window on oddsmith.
   */
  describe('suppressed is not healthy (P-016)', () => {
    /** A gate that IS genuinely stalled — 4h since a fire, 4h since a green. */
    const STALLED = { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 4 * H, watchdogAlerted: false };

    it('a stalled gate under a STALE root engine reports suppressed, not healthy', () => {
      const v = evaluateGreenStall({ ...STALLED, routineEngineStale: true }, NOW);
      expect(v.suppressed).toBe(true);
      expect(v.stalled).toBe(false); // muted — infra-liveness owns the root alarm
    });

    it('CONTROL: the SAME snapshot with a live engine is a real stall, not suppressed', () => {
      // The discriminator is the engine reading alone — proving `suppressed`
      // tracks "did we look", not "is the gate fine".
      const v = evaluateGreenStall({ ...STALLED, routineEngineStale: false }, NOW);
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(true);
    });

    it('CONTROL: a genuinely healthy gate is NOT suppressed — it was judged, and judged fine', () => {
      const v = evaluateGreenStall(
        { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 20 * 60 * 1000, watchdogAlerted: false },
        NOW,
      );
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(false);
      // Healthy and suppressed are now distinguishable from the verdict alone —
      // which is the property the recovery branch depends on.
      expect(v.stalled === false && v.suppressed === false).toBe(true);
    });

    it('unknown engine liveness fails OPEN (undefined is not stale) — a real stall still alarms', () => {
      const v = evaluateGreenStall({ ...STALLED }, NOW);
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(true);
    });
  });

  it('FIRE-STALE: an active routine that stopped firing (>3h) alarms — the EI-455 wedge signature', () => {
    // The in-routine detector is blind to this (it only runs when the routine fires).
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 4 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
  });

  it('VERDICT-STALE: firing fine but no green in >12h alarms (deep backstop)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('does NOT double-fire with the in-routine 6h alarm: a 7h-stale green while still firing is not yet watchdog-stalled', () => {
    // The in-routine STALL_AGE_MS=6h owns this window; the watchdog's 12h backstop
    // only trips if that path also failed. So 7h-stale-while-firing stays quiet here.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 7 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('BOTH stale: the wedge that also aged past the green backstop reports both clauses', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(true);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('honors custom thresholds', () => {
    const tight = { fireStaleMs: 30 * 60 * 1000, noGreenMs: H };
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 45 * 60 * 1000, lastGreenAt: NOW - 45 * 60 * 1000, watchdogAlerted: false },
      NOW,
      tight,
    );
    expect(v.fireStale).toBe(true);
  });

  it('boundary: exactly at the fire-stale threshold does not alarm (strict >)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 3 * H, lastGreenAt: NOW - 3 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('a routine that fired recently but has NEVER greened does not verdict-alarm (no lastGreenAt to age)', () => {
    // Fire-recency is healthy here; lastGreenAt null can't be aged. Caught only once
    // firing also goes stale (the wedge) — avoids false alarms on a never-green fresh start.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 10 * 60 * 1000, lastGreenAt: null, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('EI-2994: a stale root routine engine suppresses green-specific symptom alarms', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false, routineEngineStale: true },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  describe('active checkpoint delivery suppression (EI-20378004056924553)', () => {
    const STALLED = {
      lastFiredMs: NOW - 4 * H,
      lastGreenAt: NOW - 13 * H,
      watchdogAlerted: false,
    };

    it('suppresses only a live run in the exact delivering phase', () => {
      const v = evaluateGreenStall(
        { ...STALLED, checkpointRunActive: true, checkpointRunPhase: 'delivering' },
        NOW,
      );
      expect(v).toEqual({ stalled: false, fireStale: false, verdictStale: false, suppressed: true, reason: null });
    });

    it.each([
      ['missing phase', { checkpointRunActive: true, checkpointRunPhase: undefined }],
      ['unknown phase', { checkpointRunActive: true, checkpointRunPhase: null }],
      ['different phase', { checkpointRunActive: true, checkpointRunPhase: 'suite' }],
      ['no live lock', { checkpointRunActive: false, checkpointRunPhase: 'delivering' }],
      ['unknown lock', { checkpointRunActive: undefined, checkpointRunPhase: 'delivering' }],
    ])('%s fails open to the ordinary stall verdict', (_label, state) => {
      const v = evaluateGreenStall({ ...STALLED, ...state }, NOW);
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(true);
      expect(v.fireStale).toBe(true);
      expect(v.verdictStale).toBe(true);
    });
  });

  // EI-7505: the alarm reason previously never named WHICH test(s) are failing
  // the verdict, forcing a responder to hand-spelunk harness_shared.test_runs
  // (inconclusive — mixes every agent's local dev-test runs with the verdict
  // run) during a live deploy-freeze. gate_health.failingTests (persisted by
  // trackGateStall in release-actions.ts) is now threaded into the reason.
  it('EI-7505: a verdict-stale alarm names the failing test(s) when gate_health carries them', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: NOW - 20 * 60 * 1000,
        lastGreenAt: NOW - 13 * H,
        watchdogAlerted: false,
        failingTests: ['pkgA/foo.test.ts', 'pkgB/bar.test.ts'],
      },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
    expect(v.reason).toContain('Failing verdict test(s): pkgA/foo.test.ts, pkgB/bar.test.ts');
  });

  it('EI-7505: truncates the reason to the first 5 tests with a "+N more" tail', () => {
    const tests = Array.from({ length: 8 }, (_, i) => `pkg/file-${i}.test.ts`);
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false, failingTests: tests },
      NOW,
    );
    expect(v.reason).toContain('pkg/file-0.test.ts, pkg/file-1.test.ts, pkg/file-2.test.ts, pkg/file-3.test.ts, pkg/file-4.test.ts');
    expect(v.reason).toContain('(+3 more)');
  });

  it('EI-7505: no failing-test suffix when the list is absent/empty', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.reason).not.toContain('Failing verdict test(s)');
  });
});

describe('attributeVerdictStale — the alarm may not assert a cause it did not observe (WI-39704)', () => {
  /** oddsmith 2026-08-17: suite PASSED, run died in the publish step, no credential. */
  const ODDSMITH_CRASH = {
    crashed: true,
    green: null,
    firstLine:
      "green-checkpoint crashed before producing a normal verdict: Error: git -C /clones/oddsmith push origin 07220893:refs/heads/main exited 128: fatal: could not read Username for 'https://github.com': No such device or address",
    candidate: 'ad976f129ccb',
    observedAt: '2026-08-17T18:19:36.190Z',
  };

  it('THE REGRESSION: a crash with zero failing tests is never called a failing suite', () => {
    const a = attributeVerdictStale({ failingTests: [], last: ODDSMITH_CRASH });
    // The exact claim that cost WI-39671 a whole investigation, then re-minted as WI-39704.
    // Assert the AFFIRMATIVE form is absent — "(a failing suite)" is how the entitled
    // branch states it — while the explicit denial below is exactly what we DO want.
    expect(a.summary).not.toContain('(a failing suite)');
    expect(a.summary).toContain('NOT a failing suite');
    expect(a.cause).toContain('CRASHED before rendering a verdict');
    expect(a.cause).toContain('ZERO failing tests');
  });

  it('QUOTES the blocker verbatim rather than inferring from it', () => {
    const a = attributeVerdictStale({ failingTests: [], last: ODDSMITH_CRASH });
    expect(a.cause).toContain("could not read Username for 'https://github.com'");
    expect(a.cause).toContain('ad976f129ccb');
    expect(a.cause).toContain('2026-08-17T18:19:36.190Z');
  });

  it('the remedy does NOT tell the reader to re-fire the suite (~55min into the same wall)', () => {
    const a = attributeVerdictStale({ failingTests: [], last: ODDSMITH_CRASH });
    expect(a.remedy).toContain('Do NOT reflexively fire release:checkpoint-run');
    expect(a.remedy).toContain('PUBLISH step is blocked');
    // Points at the run's own promotion trailer, with the anchor WI-37636 requires
    // (a bare `GATE_PROMOTION.*` grep also matches vitest test names in the same log).
    expect(a.remedy).toContain("grep -o 'GATE_PROMOTION candidate=.*'");
  });

  it('named failing tests ARE a failing suite — the one branch entitled to say so', () => {
    const a = attributeVerdictStale({
      failingTests: ['a.test.ts', 'b.test.ts'],
      last: { crashed: false, green: false, firstLine: null, candidate: 'deadbeef1234', observedAt: null },
    });
    expect(a.summary).toContain('a failing suite');
    expect(a.cause).toContain('named 2 failing test(s)');
    expect(a.remedy).toContain('release:checkpoint-run');
  });

  it('named failing tests WIN over a crash record — the strongest evidence is reported', () => {
    const a = attributeVerdictStale({ failingTests: ['x.test.ts'], last: ODDSMITH_CRASH });
    expect(a.summary).toContain('a failing suite');
    expect(a.cause).not.toContain('CRASHED');
  });

  it('a RED verdict that named no test is reported as unattributable, not as a test list', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: { crashed: false, green: false, firstLine: null, candidate: null, observedAt: null },
    });
    expect(a.cause).toContain('unattributable red');
    expect(a.remedy).toContain('AFFECTED_TESTS_FAILING_FILES');
    expect(a.remedy).toContain('not attributable');
  });

  it('no run on record states the GAP instead of filling it with a guess', () => {
    const a = attributeVerdictStale({ failingTests: [], last: null });
    expect(a.cause).toContain('cannot be attributed from the ledger');
    expect(a.summary).toContain('no run on record');
    // Never invents a failing suite out of an absent ledger.
    expect(a.cause).not.toContain('failing suite');
  });

  it('a green-but-uncounted verdict is named as such (held / superseded / not promoted)', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: { crashed: false, green: true, firstLine: null, candidate: 'abc123abc123', observedAt: null },
    });
    expect(a.cause).toContain('green=true');
    expect(a.remedy).toContain('did not COUNT');
  });
});

describe('readLastGateRunEvidence (WI-39704)', () => {
  function makeFakeSql(rows: unknown[]) {
    return ((_s: TemplateStringsArray, ..._v: unknown[]) =>
      Promise.resolve(rows)) as unknown as import('postgres').Sql;
  }

  it('reads crashed + the FIRST line of the crash summary (the fault, not the stack)', async () => {
    const sql = makeFakeSql([
      {
        detail: {
          crashed: true,
          green: null,
          candidate: 'ad976f129ccb',
          summary:
            "green-checkpoint crashed before producing a normal verdict: Error: git push origin exited 128: fatal: could not read Username\n    at ChildProcess.<anonymous> (/x/green-checkpoint.ts:10206:11)\n    at ChildProcess.emit (node:events:509:20)",
        },
        created_at: '2026-08-17T18:19:36.190Z',
      },
    ]);
    const ev = await readLastGateRunEvidence(sql, 'oddsmith');
    expect(ev?.crashed).toBe(true);
    expect(ev?.green).toBeNull();
    expect(ev?.candidate).toBe('ad976f129ccb');
    expect(ev?.firstLine).toContain('could not read Username');
    expect(ev?.firstLine).not.toContain('at ChildProcess');
    expect(ev?.observedAt).toBe('2026-08-17T18:19:36.190Z');
  });

  it('a non-crash red row reads green:false with no crash line', async () => {
    const sql = makeFakeSql([{ detail: { green: false, candidate: '7c6e395f021b' }, created_at: null }]);
    const ev = await readLastGateRunEvidence(sql, 'oddsmith');
    expect(ev).toEqual({
      crashed: false,
      green: false,
      firstLine: null,
      candidate: '7c6e395f021b',
      observedAt: null,
    });
  });

  it('no rows ⇒ null (an absent ledger is not evidence of anything)', async () => {
    expect(await readLastGateRunEvidence(makeFakeSql([]), 'oddsmith')).toBeNull();
  });

  it('fails soft (null, never throws) when the query rejects — it only ENRICHES a live alarm', async () => {
    const sql = (() => Promise.reject(new Error('db blew up'))) as unknown as import('postgres').Sql;
    await expect(readLastGateRunEvidence(sql, 'oddsmith')).resolves.toBeNull();
  });
});

describe('greenStallEscalationBody', () => {
  it('serializes the watchdog escalation with the stall axes + iso timestamps', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-watchdog');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.fireStale).toBe(true);
    expect(body.verdictStale).toBe(true);
    expect(body.lastFiredAt).toBe(new Date(NOW - 4 * H).toISOString());
    expect(body.detail).toContain('silent stall');
  });

  it('EI-7505: includes failingTests (truncated to 20) in the escalation body when present', () => {
    const failingTests = Array.from({ length: 25 }, (_, i) => `pkg/file-${i}.test.ts`);
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false, failingTests },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 20 * 60 * 1000,
        lastGreenAt: NOW - 13 * H,
        nowMs: NOW,
        failingTests,
      }),
    );
    expect(body.failingTests).toHaveLength(20);
    expect(body.failingTests).toEqual(failingTests.slice(0, 20));
  });

  it('EI-7505: failingTests defaults to an empty array when omitted', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.failingTests).toEqual([]);
  });
});

describe('checkGreenStall checkpoint-run routing (EI-20378004056924553)', () => {
  const staleLastFiredMs = () => Date.now() - 4 * H;
  const recentLastGreenAt = () => Date.now() - 20 * 60 * 1000;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readRoutineEngineLivenessMock.mockResolvedValue({ stale: false });
    integrationRootMock.mockClear();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    readRoutineEngineLivenessMock.mockReset();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  function makeFakeSql(row: {
    install_slug: string;
    workspace_id: string;
    last_fired_ms: number;
    gh: { lastGreenAt?: number; watchdogAlerted?: boolean; failingTests?: string[] };
  }) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve([row]);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  it('routes lock and phase reads to the subject hive and suppresses active delivering salvage', async () => {
    resolveCheckpointRoutingMock.mockResolvedValue({
      root: '/DEFAULT',
      extraEnv: {
        PAPERCUSP_INTEGRATION_ROOT: '/hives/oddsmith',
        PAPERCUSP_CHECKPOINT_LOG_DIR: '/logs/oddsmith',
      },
      clearEnv: [],
    });
    isCheckpointRunLockHeldCheapMock.mockReturnValue({ held: true, pid: 1234, elapsedSec: 30 });
    readCheckpointRunPhaseCheapMock.mockReturnValue({ phase: 'delivering', at: new Date().toISOString() });
    const { sql, calls } = makeFakeSql({
      install_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: staleLastFiredMs(),
      gh: { lastGreenAt: Date.now() - 13 * H, watchdogAlerted: false },
    });

    await expect(checkGreenStall(sql)).resolves.toEqual({
      alarmed: [],
      recovered: [],
      suppressed: ['oddsmith'],
    });
    expect(resolveCheckpointRoutingMock).toHaveBeenCalledWith(
      { installSlug: 'oddsmith', workspaceId: 'papercusp-workspace' },
      '/DEFAULT',
    );
    expect(isCheckpointRunLockHeldCheapMock).toHaveBeenCalledWith(
      '/hives/oddsmith',
      undefined,
      undefined,
      undefined,
      '/logs/oddsmith',
    );
    expect(readCheckpointRunPhaseCheapMock).toHaveBeenCalledWith('/hives/oddsmith', '/logs/oddsmith');
    expect(calls.some((call) => String(call[0]).includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('fails open when the routed lock is not live even if a stale phase says delivering', async () => {
    resolveCheckpointRoutingMock.mockResolvedValue({
      root: '/DEFAULT',
      extraEnv: {
        PAPERCUSP_INTEGRATION_ROOT: '/hives/oddsmith',
        PAPERCUSP_CHECKPOINT_LOG_DIR: '/logs/oddsmith',
      },
      clearEnv: [],
    });
    isCheckpointRunLockHeldCheapMock.mockReturnValue({ held: false, elapsedSec: null });
    readCheckpointRunPhaseCheapMock.mockReturnValue({ phase: 'delivering' });
    const { sql } = makeFakeSql({
      install_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: staleLastFiredMs(),
      gh: { lastGreenAt: recentLastGreenAt(), watchdogAlerted: false },
    });

    await expect(checkGreenStall(sql)).resolves.toEqual({
      alarmed: ['oddsmith'],
      recovered: [],
      suppressed: [],
    });
  });

  it('fails open when routing is unknown instead of hiding a real stall', async () => {
    resolveCheckpointRoutingMock.mockRejectedValue(new Error('registry unavailable'));
    const { sql } = makeFakeSql({
      install_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: staleLastFiredMs(),
      gh: { lastGreenAt: recentLastGreenAt(), watchdogAlerted: false },
    });

    await expect(checkGreenStall(sql)).resolves.toEqual({
      alarmed: ['oddsmith'],
      recovered: [],
      suppressed: [],
    });
  });
});

describe('evaluateMainBehindStaging (EI-9762)', () => {
  it('does not alarm when main and staging are in sync (commitsBehind 0)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 0, behindMs: null });
    expect(v.stalled).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('does not alarm on a small/fresh lag (a handful of commits just landed)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 5, behindMs: 5 * 60 * 1000 });
    expect(v.stalled).toBe(false);
  });

  it('does not alarm on a small lag even if it sits for a while (low commit count alone is not the signal)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H });
    expect(v.stalled).toBe(false);
  });

  it('does not alarm on a big burst that has not aged yet (lots of commits, all fresh)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 40, behindMs: 2 * 60 * 1000 });
    expect(v.stalled).toBe(false);
  });

  it('ALARMS on the EI-9762 signature: many commits AND aged well past the threshold', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 56, behindMs: Math.round(4.8 * H) });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('56 commits');
    expect(v.reason).toContain('4.8h');
  });

  it('respects custom thresholds', () => {
    const v = evaluateMainBehindStaging(
      { commitsBehind: 10, behindMs: 30 * 60 * 1000 },
      { commitsThreshold: 5, msThreshold: 15 * 60 * 1000 },
    );
    expect(v.stalled).toBe(true);
  });

  it('fails open (never alarms) when the git read could not resolve a value', () => {
    expect(evaluateMainBehindStaging({ commitsBehind: null, behindMs: null }).stalled).toBe(false);
    expect(evaluateMainBehindStaging({ commitsBehind: 56, behindMs: null }).stalled).toBe(false);
  });
});

describe('evaluateMainBehindStaging gate-advance suppression (EI-10202)', () => {
  const MIN = 60 * 1000;

  it('THE FALSE ALARM: a deep+old backlog is NOT a stall when the gate greened within the last ~2 cycles', () => {
    // The 2026-07-12 incident: main fell "39/45 commits behind, >1h" while the
    // green-checkpoint routine was HEALTHY and advancing main every ~15-20 min.
    // The oldest un-promoted commit is >1h old (behindMs), yet the gate greened
    // ~35m ago — churn, not a wedge. Must NOT alarm.
    const v = evaluateMainBehindStaging({ commitsBehind: 45, behindMs: 70 * MIN, lastGreenAgeMs: 35 * MIN });
    expect(v.stalled).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('PRESERVES EI-9762: a deep+old backlog WITH no green advance in a long time is still a stall', () => {
    // Persistent-red / killed-runs: main 56 commits / ~4.8h behind AND the gate
    // has not produced a green advance in ~4.8h. This is the genuine wedge — alarm.
    const v = evaluateMainBehindStaging({
      commitsBehind: 56,
      behindMs: Math.round(4.8 * H),
      lastGreenAgeMs: Math.round(4.8 * H),
    });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('56 commits');
    // The reason now names the no-advance signal so it can't be mistaken for a depth-only cry.
    expect(v.reason).toContain('no green-checkpoint advance in ~4.8h');
  });

  it('an UNKNOWN gate signal (lastGreenAgeMs null) falls back to depth+age — never silently suppresses a possible stall', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 2 * H, lastGreenAgeMs: null });
    expect(v.stalled).toBe(true);
    // No advance-age clause when the signal is unknown.
    expect(v.reason).not.toContain('no green-checkpoint advance');
  });

  it('boundary: a green advance exactly at the recent-green window does NOT suppress (strict <=)', () => {
    // lastGreenAgeMs === recentGreenMs is treated as "recently advanced" (<=), so it suppresses.
    const atWindow = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 3 * H, lastGreenAgeMs: 2 * H });
    expect(atWindow.stalled).toBe(false);
    // Just past the window ⇒ genuinely stale ⇒ alarms.
    const pastWindow = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 3 * H, lastGreenAgeMs: 2 * H + 1 });
    expect(pastWindow.stalled).toBe(true);
  });

  it('honors a custom recentGreenMs', () => {
    // Tighten the window to 30m: a 45m-old green advance is now "stale" ⇒ alarms.
    const v = evaluateMainBehindStaging(
      { commitsBehind: 30, behindMs: 2 * H, lastGreenAgeMs: 45 * MIN },
      { recentGreenMs: 30 * MIN },
    );
    expect(v.stalled).toBe(true);
  });

  it('a recent green advance does not rescue a still-small backlog into an alarm (depth+age still required)', () => {
    // Suppression only ever REMOVES an alarm; it never manufactures one. A tiny
    // lag with a stale green is still healthy (depth/age not met).
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H, lastGreenAgeMs: 9 * H });
    expect(v.stalled).toBe(false);
  });
});

describe('evaluateMainBehindStaging: motion is not progress (WI-38340)', () => {
  const MIN = 60 * 1000;

  // THE INCIDENT, to scale. 2026-08-12T22:27Z: the partial-green salvage (WI-38218)
  // advanced main 8779b1c7 → e16f9529 — the longest green PREFIX, 3 commits — while
  // the tip stayed red and `main` sat 327 commits behind `staging`. That advance
  // reset `lastGreenAt`, EI-10202's `recentlyAdvanced` flipped true, `stalled` went
  // false, and the fleet was broadcast an all-clear.
  const salvage = { commitsBehind: 327, behindMs: 30 * H, lastGreenAgeMs: 4 * MIN };

  it('THE BUG: a fresh PREFIX advance against a deep old backlog no longer suppresses the alarm', () => {
    const v = evaluateMainBehindStaging(salvage);
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('327 commits');
  });

  it('the alarm does not misstate its own trigger — it says the gate DID advance, not that it stopped', () => {
    // An alarm claiming "no green-checkpoint advance in ~0.1h" about a gate that
    // just advanced sends the reader hunting a wedge that is not there.
    const reason = evaluateMainBehindStaging(salvage).reason ?? '';
    expect(reason).toContain('the gate DID advance main');
    expect(reason).toContain('advanced the tip end, not this backlog');
    expect(reason).not.toContain('no green-checkpoint advance');
  });

  it('RE-ARMING: repeated prefix advances cannot silence it forever — each pass still alarms', () => {
    // The compounding half of the bug: the suppression re-arms on EVERY partial
    // advance, so a persistently-red tip that keeps salvaging small green prefixes
    // would reset `lastGreenAgeMs` each cycle and the alarm would never fire again.
    for (const sinceAdvanceMin of [1, 20, 60, 119]) {
      const v = evaluateMainBehindStaging({ ...salvage, lastGreenAgeMs: sinceAdvanceMin * MIN });
      expect(v.stalled, `${sinceAdvanceMin}m after a prefix advance`).toBe(true);
    }
  });

  it('PRESERVES EI-10202: a real advance that DID consume the backlog still suppresses', () => {
    // The distinction is measured, not asserted. After a genuine full advance the
    // oldest un-promoted commit is young — `behindMs` collapses to about the
    // candidate's own age and then grows one-for-one with elapsed time. Here the
    // gate greened 35m ago and the oldest un-promoted commit is 70m old: consistent
    // with real consumption. Still churn, still no alarm.
    const v = evaluateMainBehindStaging({ commitsBehind: 45, behindMs: 70 * MIN, lastGreenAgeMs: 35 * MIN });
    expect(v.stalled).toBe(false);
  });

  it('the boundary is behindMs vs (lastGreenAgeMs + advanceHorizonMs), not depth', () => {
    // Depth is deliberately NOT the discriminator: a deep backlog being actively
    // consumed is healthy, and a shallow one that is stuck is not this alarm's job.
    const consuming = { commitsBehind: 500, behindMs: 2 * H, lastGreenAgeMs: 10 * MIN };
    expect(evaluateMainBehindStaging(consuming).stalled).toBe(false); // 2h <= 10m + 2h
    const stuck = { ...consuming, behindMs: 2 * H + 11 * MIN }; // just past 10m + 2h
    expect(evaluateMainBehindStaging(stuck).stalled).toBe(true);
  });

  it('honors a custom advanceHorizonMs', () => {
    const s = { commitsBehind: 40, behindMs: 90 * MIN, lastGreenAgeMs: 10 * MIN };
    expect(evaluateMainBehindStaging(s).stalled).toBe(false); // 90m <= 10m + 2h
    expect(evaluateMainBehindStaging(s, { advanceHorizonMs: 30 * MIN }).stalled).toBe(true); // 90m > 10m + 30m
  });

  it('an UNKNOWN advance signal still falls back to depth+age — never silently suppresses', () => {
    // Unchanged contract: the new condition can only ever REMOVE a suppression, so
    // a null gate signal behaves exactly as before.
    const v = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 2 * H, lastGreenAgeMs: null });
    expect(v.stalled).toBe(true);
  });

  it('still never manufactures an alarm: a shallow backlog stays quiet however unproductive the advance', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 30 * H, lastGreenAgeMs: 1 * MIN });
    expect(v.stalled).toBe(false);
  });
});

describe('mainBehindRecoverySummary — an all-clear may not claim what it did not measure (WI-38340)', () => {
  it('THE BROADCAST THAT WAS WRONG: still-deep behind is NOT reported as "recovered"', () => {
    // Verbatim shape of the 2026-08-12T23:03Z broadcast: `main RECOVERED on
    // papercusp — no longer meaningfully behind staging`, sent at 327 behind.
    const s = mainBehindRecoverySummary('papercusp', { commitsBehind: 327 });
    expect(s).toContain('STILL 327 commits behind');
    expect(s).not.toContain('RECOVERED');
    expect(s).not.toContain('no longer meaningfully behind');
  });

  it('a genuine catch-up IS reported as recovered, and states the number it measured', () => {
    const s = mainBehindRecoverySummary('papercusp', { commitsBehind: 4 });
    expect(s).toContain('RECOVERED');
    expect(s).toContain('4 commits behind');
  });

  it('the threshold is the boundary between the two arms, and is configurable', () => {
    expect(mainBehindRecoverySummary('h', { commitsBehind: 20 })).toContain('RECOVERED');
    expect(mainBehindRecoverySummary('h', { commitsBehind: 21 })).toContain('STILL 21 commits');
    expect(mainBehindRecoverySummary('h', { commitsBehind: 21 }, { commitsThreshold: 50 })).toContain('RECOVERED');
  });

  it('an UNMEASURABLE distance is its own arm — never dressed up as a recovery', () => {
    // A missing branch / git error clears the alarm because the signal went
    // unreadable, which is not evidence main caught up.
    const s = mainBehindRecoverySummary('papercusp', { commitsBehind: null });
    expect(s).toContain('could NOT be measured');
    expect(s).not.toContain('RECOVERED');
  });

  it('every arm names the harness', () => {
    for (const commitsBehind of [4, 327, null]) {
      expect(mainBehindRecoverySummary('oddsmith', { commitsBehind })).toContain('oddsmith');
    }
  });
});

describe('evaluateMainBehindStaging in-flight-aware remedy (EI-19459452257836856)', () => {
  // THE DEFECT: this alarm is broadcast hive-wide as a severe-event, and its remedy
  // used to end with an UNCONDITIONAL "Fire a fresh gate run (release:checkpoint-run)"
  // — the one action the repo guide flags in bold as never-do-while-a-run-is-live
  // (firing inside a run's re-triage window discards an in-progress rescue and costs
  // a full ~55min suite). On 2026-08-03 an agent did exactly that during a stall and
  // conceded it was premature. The remedy must now branch on whether a run is live.
  //
  // BOTH ARMS ARE ASSERTED ON PURPOSE. A single-arm test is always-true here: the
  // fire-phrase is either present or absent in one fixed string, so asserting only
  // "the live-run arm omits it" passes just as happily against a function that never
  // emits it at all — which would silently destroy the real remedy.
  const FIRE = 'Fire a fresh gate run (release:checkpoint-run)';
  const deep = { commitsBehind: 56, behindMs: Math.round(4.8 * H), lastGreenAgeMs: Math.round(4.8 * H) };

  it('THE BUG: a run IS in flight ⇒ the remedy must NOT tell the hive to fire another', () => {
    const v = evaluateMainBehindStaging({ ...deep, runInFlight: true, runInFlightElapsedSec: 1980 });
    expect(v.stalled).toBe(true);
    expect(v.reason).not.toContain(FIRE);
    expect(v.reason).toContain('IN FLIGHT');
    expect(v.reason).toContain('do NOT launch another');
    // Says WHY, so the reader can't mistake it for timidity, and names the wait lever.
    expect(v.reason).toContain('re-triage');
    expect(v.reason).toContain('checkpoint:await');
    // Elapsed is rendered in minutes when known (1980s ⇒ ~33m).
    expect(v.reason).toContain('~33m ago');
  });

  it('THE OTHER ARM: no run in flight ⇒ the fire remedy IS still emitted (not neutered)', () => {
    const v = evaluateMainBehindStaging({ ...deep, runInFlight: false });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain(FIRE);
  });

  it('UNKNOWN in-flight state is its OWN arm — neither the blind instruction nor silence', () => {
    // Treating unknown as "no run" is exactly the original bug; treating it as "a run
    // is live" would suppress the remedy on a genuine stall. So: alarm, and make the
    // check the first step.
    const v = evaluateMainBehindStaging(deep); // field omitted entirely
    expect(v.stalled).toBe(true);
    expect(v.reason).not.toContain(FIRE);
    expect(v.reason).toContain('CHECK FIRST');
    expect(v.reason).toContain('gate.checkpointRunInFlight');
    // An explicit null is the same unknown, not a `false`.
    expect(evaluateMainBehindStaging({ ...deep, runInFlight: null }).reason).toContain('CHECK FIRST');
  });

  it('the three arms are genuinely DISTINCT strings (a future refactor must not collapse them)', () => {
    const live = evaluateMainBehindStaging({ ...deep, runInFlight: true }).reason;
    const none = evaluateMainBehindStaging({ ...deep, runInFlight: false }).reason;
    const unknown = evaluateMainBehindStaging(deep).reason;
    expect(new Set([live, none, unknown]).size).toBe(3);
  });

  it('the in-flight signal gates the REMEDY ONLY — it must never suppress the alarm itself', () => {
    // A run being in flight does not mean the gate is healthy: it may be the 12th
    // consecutive red. Suppressing on it would hide a real wedge. Gate-is-advancing
    // suppression is lastGreenAgeMs's job (EI-10202), not this field's.
    for (const runInFlight of [true, false, null, undefined]) {
      expect(evaluateMainBehindStaging({ ...deep, runInFlight }).stalled).toBe(true);
    }
    // ...and it must not manufacture one either: a healthy shallow lag stays quiet
    // no matter what the run-lock says.
    for (const runInFlight of [true, false, null, undefined]) {
      expect(evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H, runInFlight }).stalled).toBe(false);
    }
  });

  it('the field is OPTIONAL — existing snapshot literals that omit it still evaluate', () => {
    // The required-field-strand trap: every other call site in this file builds the
    // snapshot as an object literal with only the fields it needs. Making the new
    // field required would strand all of them at once.
    expect(evaluateMainBehindStaging({ commitsBehind: 56, behindMs: Math.round(4.8 * H) }).stalled).toBe(true);
  });

  it('omits the elapsed clause when the run age is not measurable', () => {
    const v = evaluateMainBehindStaging({ ...deep, runInFlight: true, runInFlightElapsedSec: null });
    expect(v.reason).toContain('IN FLIGHT');
    expect(v.reason).not.toContain('ago');
  });

  it('every arm points at the authoritative break-set line, not the old undirected "find whatever is failing"', () => {
    // The agent who mis-fired during the 2026-08-03 stall verified ONE red and never
    // the failing SET. The break set has an authoritative source; name it.
    for (const runInFlight of [true, false, undefined]) {
      const r = evaluateMainBehindStaging({ ...deep, runInFlight }).reason;
      expect(r).toContain('AFFECTED_TESTS_FAILING_FILES');
      expect(r).toContain('coverage');
      expect(r).not.toContain('find + fix whatever is actually failing');
    }
  });
});

describe('computeMainBehindStaging git shell-out (EI-9922 no-stderr-leak)', () => {
  // On a PACKAGED install this watchdog's boot pass shells git in a NON-repo dir.
  // `execFileSync`'s default stdio inherits the child's stderr, so it spammed
  // 'fatal: not a git repository' onto serve.log every boot + interval. gitOut must
  // pin stdio to ['ignore','pipe','ignore'] so stderr is discarded.
  it('EI-9922: shells git with stderr suppressed (stdio ["ignore","pipe","ignore"])', () => {
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce('0\n');
    computeMainBehindStaging('/some/packaged/install');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['rev-list']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    vi.mocked(execFileSync).mockReset();
  });

  it('EI-9922: fails open (all-null) without throwing when git rejects (non-repo)', () => {
    (vi.mocked(execFileSync) as unknown as { mockImplementationOnce: (fn: () => never) => void }).mockImplementationOnce(
      () => {
        throw new Error('fatal: not a git repository (or any parent up to mount point /)');
      },
    );
    expect(computeMainBehindStaging('/some/packaged/install')).toEqual({
      commitsBehind: null,
      behindMs: null,
    });
    vi.mocked(execFileSync).mockReset();
  });
});

// EI-10103: main-behind-staging-watchdog crashes every pass — the escalation INSERT
// explicitly wrote `workspace_id: NULL` (opts.workspaceId ?? null), violating the
// column's NOT NULL constraint on every real stall (the promotion-stall detector
// could never actually escalate). A tagged-template fake `sql` records every call so
// we can assert on the exact value threaded into the INSERT.
function makeFakeSql(existingRows: { escalation: unknown }[] = []) {
  const calls: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push([text, ...values]);
    if (text.includes('SELECT escalation')) return Promise.resolve(existingRows);
    // INSERT / UPDATE — postgres-js resolves a write to a result-like array with `.count`.
    return Promise.resolve(Object.assign([], { count: 1 }));
  }) as unknown as import('postgres').Sql;
  return { sql, calls };
}

function findInsertCall(calls: unknown[][]) {
  return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
}

describe('checkMainBehindStaging DB wiring (EI-10103: workspace_id NOT NULL)', () => {
  // This path legitimately console.warn's on a real ALARM (and on a caught resolution
  // failure) — expected, vitest-fail-on-console guarded behavior, not noise to silence
  // elsewhere. Spy + restore locally so it doesn't mask unrelated warnings in other suites.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resolveWorkspaceForHarnessMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
    vi.mocked(execFileSync).mockReset();
    warnSpy.mockRestore();
  });

  // Force a stalled verdict deterministically: commitsBehind (30) > DEFAULT_MAIN_BEHIND_COMMITS (20)
  // AND behindMs (2h) > DEFAULT_MAIN_BEHIND_MS (1h). opts.root is passed explicitly so
  // computeMainBehindStaging's two git calls (rev-list --count, then log --format=%ct --reverse)
  // are the only ones made.
  function mockStalledGit() {
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => { mockReturnValueOnce: (v: string) => void } })
      .mockReturnValueOnce('30\n')
      .mockReturnValueOnce(`${Math.floor((Date.now() - 2 * H) / 1000)}\n`);
  }

  it('threads a resolved, non-null workspace_id into the escalation insert (previously always NULL)', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    mockStalledGit();
    const { sql, calls } = makeFakeSql([]);
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(resolveWorkspaceForHarnessMock).toHaveBeenCalledWith('papercusp');
    const insertCall = findInsertCall(calls);
    expect(insertCall).toBeDefined();
    // template values are [harnessSlug, phase, escalationJson, mtimeMs, workspaceId]
    expect(insertCall![5]).toBe('papercusp-workspace');
    expect(insertCall![5]).not.toBeNull();
  });

  it('falls back to the column default ("") instead of NULL when workspace resolution fails — the escalation write must never be blocked', async () => {
    resolveWorkspaceForHarnessMock.mockRejectedValueOnce(new Error('harness not registered in any workspace'));
    mockStalledGit();
    const { sql, calls } = makeFakeSql([]);
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    // The whole point of the fix: a resolution failure must not re-create the original
    // "the escalation never gets written" bug via a different code path.
    expect(result.alarmed).toBe(true);
    const insertCall = findInsertCall(calls);
    expect(insertCall).toBeDefined();
    expect(insertCall![5]).toBe('');
    expect(insertCall![5]).not.toBeNull();
  });

  it('honors an explicit opts.workspaceId verbatim, skipping resolution entirely', async () => {
    mockStalledGit();
    const { sql, calls } = makeFakeSql([]);
    await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp', workspaceId: 'explicit-ws' });
    expect(resolveWorkspaceForHarnessMock).not.toHaveBeenCalled();
    const insertCall = findInsertCall(calls);
    expect(insertCall![5]).toBe('explicit-ws');
  });

  it('does not insert at all when nothing is stalled (no regression to the happy path)', async () => {
    // in-sync (0 commits behind) — evaluateMainBehindStaging never alarms.
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce('0\n');
    const { sql, calls } = makeFakeSql([]);
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(findInsertCall(calls)).toBeUndefined();
    expect(resolveWorkspaceForHarnessMock).not.toHaveBeenCalled();
  });
});

describe('checkMainBehindStaging gate-advance suppression wiring (EI-10202)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resolveWorkspaceForHarnessMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    vi.mocked(execFileSync).mockReset();
    warnSpy.mockRestore();
  });

  // git: 30 commits / 2h behind (over both DEFAULT thresholds) — the same stalled
  // git snapshot the EI-10103 suite uses.
  function mockStalledGit() {
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => { mockReturnValueOnce: (v: string) => void } })
      .mockReturnValueOnce('30\n')
      .mockReturnValueOnce(`${Math.floor((Date.now() - 2 * H) / 1000)}\n`);
  }

  /** A fake sql that ALSO answers the gate_health lastGreenAt read this path now
   *  issues (a recent value ⇒ the gate is advancing ⇒ suppress). */
  function makeGateFakeSql(lastGreenAtMs: number | null) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes("gate_health'->>'lastGreenAt")) {
        return Promise.resolve(lastGreenAtMs != null ? [{ last_green_at: lastGreenAtMs }] : []);
      }
      if (text.includes('SELECT escalation')) return Promise.resolve([]);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function findInsert(calls: unknown[][]) {
    return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
  }

  it('SUPPRESSES the alarm when the gate greened recently, even with a deep+old git backlog', async () => {
    mockStalledGit();
    const { sql, calls } = makeGateFakeSql(Date.now() - 20 * 60 * 1000); // greened 20m ago
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(findInsert(calls)).toBeUndefined();
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    // It DID consult the gate-advance signal (the whole point of the fix).
    expect(calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes("gate_health'->>'lastGreenAt"))).toBe(true);
  });

  it('still ALARMS on a deep+old git backlog when the gate has NOT greened in a long time', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    mockStalledGit();
    const { sql, calls } = makeGateFakeSql(Date.now() - 5 * H); // last green 5h ago ⇒ stale
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(findInsert(calls)).toBeDefined();
  });

  it('still ALARMS when the gate signal is unreadable (no green-checkpoint row) — fail-open, never hide a real stall', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    mockStalledGit();
    const { sql, calls } = makeGateFakeSql(null); // no gate_health row
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(findInsert(calls)).toBeDefined();
  });
});

describe('evaluateReleaseTriggerFreeze (WI-4322)', () => {
  it('a fresh/active routine never alarms, however much green code is stranded', () => {
    const v = evaluateReleaseTriggerFreeze({ active: true, updatedAtMs: NOW - 24 * H, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('no routine row (active: null — no deploy target declared) never alarms', () => {
    const v = evaluateReleaseTriggerFreeze({ active: null, updatedAtMs: null, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused but nothing green is stranded — harmless, never alarms', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 2 * H, deployedBehindGreenPin: 0 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused with null deployedBehindGreenPin never alarms (unknown ≠ pending)', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 2 * H, deployedBehindGreenPin: null }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused + green stranded, but only just (< 30m threshold) — a normal short manual pause, not yet a freeze', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 10 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('THE SIGNATURE: paused > 30m + green code stranded ⇒ frozen, with an actionable reason', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 45 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(true);
    expect(v.reason).toContain('PAUSED');
    expect(v.reason).toContain('44 green commit');
    expect(v.reason).toContain("routines:set");
    expect(v.reason).toContain('release-trigger');
  });

  it('boundary: exactly at the threshold does not alarm (strict >)', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 30 * 60_000, deployedBehindGreenPin: 5 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('an unresolvable updated_at (null) while paused + green-ahead is treated as maximally stale, not healthy', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: null, deployedBehindGreenPin: 3 }, NOW);
    expect(v.frozen).toBe(true);
    expect(v.reason).toContain('pause duration unknown');
  });

  it('kill switch: thresholdMs <= 0 never alarms', () => {
    const v = evaluateReleaseTriggerFreeze(
      { active: false, updatedAtMs: NOW - 99 * H, deployedBehindGreenPin: 44 },
      NOW,
      { thresholdMs: 0 },
    );
    expect(v.frozen).toBe(false);
  });

  it('honors a custom (tighter) threshold', () => {
    const v = evaluateReleaseTriggerFreeze(
      { active: false, updatedAtMs: NOW - 6 * 60_000, deployedBehindGreenPin: 1 },
      NOW,
      { thresholdMs: 5 * 60_000 },
    );
    expect(v.frozen).toBe(true);
  });
});

describe('lastReleaseTriggerPauseOwner (WI-4329)', () => {
  function makeFakeSql(row: { coord_owner_id: string | null; invoked_at_ms: number | null } | null) {
    return ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(row ? [row] : [])) as unknown as import('postgres').Sql;
  }

  it('returns the owner + timestamp when a matching row exists', async () => {
    const sql = makeFakeSql({ coord_owner_id: 'su-d1425c47-dbac-4640-93c1-d708e3dcff03', invoked_at_ms: NOW });
    const result = await lastReleaseTriggerPauseOwner(sql);
    expect(result).toEqual({ ownerId: 'su-d1425c47-dbac-4640-93c1-d708e3dcff03', invokedAtMs: NOW });
  });

  it('returns null when no matching row exists', async () => {
    const sql = makeFakeSql(null);
    expect(await lastReleaseTriggerPauseOwner(sql)).toBeNull();
  });

  it('returns null when the row has no coord_owner_id (a non-agent/system caller)', async () => {
    const sql = makeFakeSql({ coord_owner_id: null, invoked_at_ms: NOW });
    expect(await lastReleaseTriggerPauseOwner(sql)).toBeNull();
  });

  it('fails soft (returns null, never throws) when the query rejects', async () => {
    const sql = (() => Promise.reject(new Error('db blew up'))) as unknown as import('postgres').Sql;
    await expect(lastReleaseTriggerPauseOwner(sql)).resolves.toBeNull();
  });
});

describe('checkReleaseTriggerFreeze DB wiring (WI-4322)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
    gitPipelineSnapshotMock.mockClear();
    computeDeployStatusMock.mockReset();
    warnSpy.mockRestore();
  });

  /** A fake sql tag that dispatches on query shape: the routines-row read, the
   *  escalation-dedup read, and everything else (INSERT/UPDATE) falls through
   *  to a write-ack — mirrors makeFakeSql's dispatch style but supports the
   *  extra routines-row SELECT this check issues first. */
  function makeRTFakeSql(opts: {
    routineRow?: { active: boolean; updated_at_ms: number | null; workspace_id: string } | null;
    existingEscalation?: { escalation: unknown }[];
    pauseOwnerRow?: { coord_owner_id: string | null; invoked_at_ms: number | null } | null;
  }) {
    const calls: unknown[][] = [];
    const routineRows = opts.routineRow ? [opts.routineRow] : [];
    const existing = opts.existingEscalation ?? [];
    const pauseOwnerRows = opts.pauseOwnerRow ? [opts.pauseOwnerRow] : [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve(routineRows);
      if (text.includes('SELECT escalation')) return Promise.resolve(existing);
      if (text.includes('FROM harness_shared.tool_invocations')) return Promise.resolve(pauseOwnerRows);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function findRTInsertCall(calls: unknown[][]) {
    return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
  }

  it('no routine row (no deploy target for this hive) is a complete no-op', async () => {
    const { sql, calls } = makeRTFakeSql({ routineRow: null });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(gitPipelineSnapshotMock).not.toHaveBeenCalled();
    expect(findRTInsertCall(calls)).toBeUndefined();
  });

  it('ALARMS on the exact WI-4322 signature: active:false, stale updated_at, green ahead', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql, calls } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(gitPipelineSnapshotMock).toHaveBeenCalledWith('papercusp');
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    const insertCall = findRTInsertCall(calls);
    expect(insertCall).toBeDefined();
    // template values are [installSlug, phase, escalationJson, mtimeMs, workspaceId]
    expect(insertCall![1]).toBe('papercusp');
    expect(insertCall![5]).toBe('papercusp-workspace');
  });

  it('WI-4329: attributes the pause to its actual owner when tool_invocations has a matching row', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
      pauseOwnerRow: { coord_owner_id: 'su-d1425c47-dbac-4640-93c1-d708e3dcff03', invoked_at_ms: NOW - 45 * 60_000 },
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    const notifyBody = notifyAttentionMock.mock.calls[0]![0].body as string;
    expect(notifyBody).toContain('su-d1425c47-dbac-4640-93c1-d708e3dcff03');
    expect(notifyBody).toContain('Coordinate with them');
    expect(notifyAttentionMock.mock.calls[0]![0].data.pausedBy).toBe('su-d1425c47-dbac-4640-93c1-d708e3dcff03');
    const broadcastBody = broadcastSevereEventMock.mock.calls[0]![0].body as string;
    expect(broadcastBody).toContain('su-d1425c47-dbac-4640-93c1-d708e3dcff03');
  });

  it('WI-4329: no matching tool_invocations row (attribution unavailable) still alarms, just without a "last paused by" line', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
      pauseOwnerRow: null,
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    const notifyBody = notifyAttentionMock.mock.calls[0]![0].body as string;
    expect(notifyBody).not.toContain('Coordinate with them');
    expect(notifyAttentionMock.mock.calls[0]![0].data.pausedBy).toBeNull();
  });

  it('does NOT re-alarm when already alarmed (one-shot until recovery)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql, calls } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-freeze-watchdog' } }],
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(findRTInsertCall(calls)).toBeUndefined();
  });

  it('clears + broadcasts recovery once the routine is active again (or nothing is stranded)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 0 } });
    const { sql } = makeRTFakeSql({
      routineRow: { active: true, updated_at_ms: NOW, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-freeze-watchdog' } }],
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.recovered).toBe(true);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledWith(
      expect.objectContaining({ conditionKey: 'release-trigger-freeze:papercusp' }),
    );
  });

  it('healthy + never-alarmed is a complete no-op (no writes, no broadcasts)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 0 } });
    const { sql, calls } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(findRTInsertCall(calls)).toBeUndefined();
    expect(broadcastSevereEventResolvedMock).not.toHaveBeenCalled();
  });

  it('a thrown gitPipelineSnapshot never propagates — fail-soft', async () => {
    gitPipelineSnapshotMock.mockRejectedValueOnce(new Error('git blew up'));
    const { sql } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    await expect(checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' })).resolves.toEqual({
      alarmed: false,
      recovered: false,
    });
  });
});

describe('evaluateReleaseTriggerFireStale (EI-14003)', () => {
  it('active + firing within cadence never alarms, however much green code is stranded', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 5 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('no routine row (active: null) never alarms', () => {
    const v = evaluateReleaseTriggerFireStale({ active: null, lastFiredMs: null, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('PAUSED (active:false) never alarms here — checkReleaseTriggerFreeze owns that case', () => {
    const v = evaluateReleaseTriggerFireStale({ active: false, lastFiredMs: NOW - 3 * H, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('stale-fired but nothing green is stranded — harmless, never alarms', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 3 * H, deployedBehindGreenPin: 0 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('stale-fired with null deployedBehindGreenPin never alarms (unknown ≠ pending)', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 3 * H, deployedBehindGreenPin: null }, NOW);
    expect(v.stale).toBe(false);
  });

  it('not fired long enough yet (< 30m threshold) — normal cadence jitter, not a stall', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 20 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('THE EI-14003 SIGNATURE: active, not fired in 65m (the real repro gap), green stranded ⇒ stale', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 65 * 60_000, deployedBehindGreenPin: 8 }, NOW);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('ACTIVE');
    expect(v.reason).toContain('not FIRED');
    expect(v.reason).toContain('8 green commit');
    expect(v.reason).toContain('release-trigger');
  });

  it('boundary: exactly at the threshold does not alarm (strict >)', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 30 * 60_000, deployedBehindGreenPin: 5 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('an unresolvable last_fired_at (null) while active + green-ahead is treated as maximally stale', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: null, deployedBehindGreenPin: 3 }, NOW);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('never fired');
  });

  it('kill switch: thresholdMs <= 0 never alarms', () => {
    const v = evaluateReleaseTriggerFireStale(
      { active: true, lastFiredMs: NOW - 99 * H, deployedBehindGreenPin: 44 },
      NOW,
      { thresholdMs: 0 },
    );
    expect(v.stale).toBe(false);
  });

  it('honors a custom (tighter) threshold', () => {
    const v = evaluateReleaseTriggerFireStale(
      { active: true, lastFiredMs: NOW - 6 * 60_000, deployedBehindGreenPin: 1 },
      NOW,
      { thresholdMs: 5 * 60_000 },
    );
    expect(v.stale).toBe(true);
  });
});

describe('checkReleaseTriggerFireStale DB wiring (EI-14003)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
    gitPipelineSnapshotMock.mockClear();
    computeDeployStatusMock.mockReset();
    warnSpy.mockRestore();
  });

  function makeFireStaleFakeSql(opts: {
    routineRow?: { active: boolean; last_fired_ms: number | null; workspace_id: string } | null;
    existingEscalation?: { escalation: unknown }[];
  }) {
    const calls: unknown[][] = [];
    const routineRows = opts.routineRow ? [opts.routineRow] : [];
    const existing = opts.existingEscalation ?? [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve(routineRows);
      if (text.includes('SELECT escalation')) return Promise.resolve(existing);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function findFSInsertCall(calls: unknown[][]) {
    return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
  }

  it('no routine row (no deploy target for this hive) is a complete no-op', async () => {
    const { sql, calls } = makeFireStaleFakeSql({ routineRow: null });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(gitPipelineSnapshotMock).not.toHaveBeenCalled();
    expect(findFSInsertCall(calls)).toBeUndefined();
  });

  it('ALARMS on the exact EI-14003 signature: active:true, stale last_fired_at, green ahead', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 8 } });
    const { sql, calls } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW - 65 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(gitPipelineSnapshotMock).toHaveBeenCalledWith('papercusp');
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    const insertCall = findFSInsertCall(calls);
    expect(insertCall).toBeDefined();
    // template values are [installSlug, phase, escalationJson, mtimeMs, workspaceId]
    expect(insertCall![1]).toBe('papercusp');
    expect(insertCall![5]).toBe('papercusp-workspace');
  });

  it('does NOT re-alarm when already alarmed (one-shot until recovery)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 8 } });
    const { sql, calls } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW - 65 * 60_000, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-fire-stale-watchdog' } }],
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(findFSInsertCall(calls)).toBeUndefined();
  });

  it('clears + broadcasts recovery once firing on cadence again (or nothing is stranded)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 0 } });
    const { sql } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-fire-stale-watchdog' } }],
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.recovered).toBe(true);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledWith(
      expect.objectContaining({ conditionKey: 'release-trigger-fire-stale:papercusp' }),
    );
  });

  it('does NOT alarm when PAUSED (active:false) — that failure mode belongs to checkReleaseTriggerFreeze', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql } = makeFireStaleFakeSql({
      routineRow: { active: false, last_fired_ms: NOW - 3 * H, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
  });

  it('a thrown gitPipelineSnapshot never propagates — fail-soft', async () => {
    gitPipelineSnapshotMock.mockRejectedValueOnce(new Error('git blew up'));
    const { sql } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW - 65 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    await expect(checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' })).resolves.toEqual({
      alarmed: false,
      recovered: false,
    });
  });
});
