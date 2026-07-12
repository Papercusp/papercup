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
vi.mock('../release-deploy-launch', () => ({
  computeDeployStatus: (...args: unknown[]) => computeDeployStatusMock(...args),
}));

import {
  evaluateGreenStall,
  greenStallEscalationBody,
  evaluateMainBehindStaging,
  computeMainBehindStaging,
  checkMainBehindStaging,
  evaluateReleaseTriggerFreeze,
  checkReleaseTriggerFreeze,
  lastReleaseTriggerPauseOwner,
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
    const v = evaluateReleaseTriggerFreeze({ active: true, updatedAtMs: NOW - 24 * H, deployedBehindReady: 44 }, NOW);
    expect(v.frozen).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('no routine row (active: null — no deploy target declared) never alarms', () => {
    const v = evaluateReleaseTriggerFreeze({ active: null, updatedAtMs: null, deployedBehindReady: 44 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused but nothing green is stranded — harmless, never alarms', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 2 * H, deployedBehindReady: 0 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused with null deployedBehindReady never alarms (unknown ≠ pending)', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 2 * H, deployedBehindReady: null }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused + green stranded, but only just (< 30m threshold) — a normal short manual pause, not yet a freeze', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 10 * 60_000, deployedBehindReady: 44 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('THE SIGNATURE: paused > 30m + green code stranded ⇒ frozen, with an actionable reason', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 45 * 60_000, deployedBehindReady: 44 }, NOW);
    expect(v.frozen).toBe(true);
    expect(v.reason).toContain('PAUSED');
    expect(v.reason).toContain('44 green commit');
    expect(v.reason).toContain("routines:set");
    expect(v.reason).toContain('release-trigger');
  });

  it('boundary: exactly at the threshold does not alarm (strict >)', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: NOW - 30 * 60_000, deployedBehindReady: 5 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('an unresolvable updated_at (null) while paused + green-ahead is treated as maximally stale, not healthy', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, updatedAtMs: null, deployedBehindReady: 3 }, NOW);
    expect(v.frozen).toBe(true);
    expect(v.reason).toContain('pause duration unknown');
  });

  it('kill switch: thresholdMs <= 0 never alarms', () => {
    const v = evaluateReleaseTriggerFreeze(
      { active: false, updatedAtMs: NOW - 99 * H, deployedBehindReady: 44 },
      NOW,
      { thresholdMs: 0 },
    );
    expect(v.frozen).toBe(false);
  });

  it('honors a custom (tighter) threshold', () => {
    const v = evaluateReleaseTriggerFreeze(
      { active: false, updatedAtMs: NOW - 6 * 60_000, deployedBehindReady: 1 },
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
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindReady: 44 } });
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
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindReady: 44 } });
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
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindReady: 44 } });
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
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindReady: 44 } });
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
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindReady: 0 } });
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
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindReady: 0 } });
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
