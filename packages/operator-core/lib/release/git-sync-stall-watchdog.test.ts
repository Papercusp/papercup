/**
 * git-sync-stall-watchdog — the PURE stall verdict (evaluateGitSyncStall). The DB wiring +
 * head-movement tracking (checkGitSyncStall / flag-flip / broadcast) is integration-covered.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/git-sync-stall-watchdog.test.ts
 */
import { describe, it, expect } from 'vitest';
import { evaluateGitSyncStall, gitSyncStallEscalationBody, type GitSyncStallSnapshot } from './git-sync-stall-watchdog';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const M = 60_000;

const base: GitSyncStallSnapshot = {
  lastFiredMs: NOW - 2 * M, // fired 2 min ago (healthy cadence)
  headUnchangedMs: 5 * M, // head advanced 5 min ago (committing)
  lastError: null,
  watchdogAlerted: false,
};

describe('evaluateGitSyncStall', () => {
  it('healthy: firing + head advancing + no error ⇒ NOT stalled', () => {
    const v = evaluateGitSyncStall(base, NOW);
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.errorStall).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('EI-7531 commit-staleness (PRIMARY): HEAD frozen >30m while firing ⇒ stalled — stranded dirty work detector', () => {
    const v = evaluateGitSyncStall({ ...base, headUnchangedMs: 31 * M }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.commitStale).toBe(true);
    expect(v.fireStale).toBe(false);
    expect(v.reason).toMatch(/HEAD has not advanced/);
  });

  it('commit-staleness is robust to a NULL last_error (the noisy secondary signal)', () => {
    // The live stall had last_error momentarily null — commitStale must still catch it.
    const v = evaluateGitSyncStall({ ...base, headUnchangedMs: 4 * H, lastError: null }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.commitStale).toBe(true);
    expect(v.errorStall).toBe(false);
  });

  it('just moved / first observation (headUnchangedMs 0 or null) ⇒ not commit-stale', () => {
    expect(evaluateGitSyncStall({ ...base, headUnchangedMs: 0 }, NOW).commitStale).toBe(false);
    expect(evaluateGitSyncStall({ ...base, headUnchangedMs: null }, NOW).commitStale).toBe(false);
  });

  it('error/reap (secondary): a fault persisting across >=2 consecutive sweeps ⇒ stalled', () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        lastError: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire',
        errorSweeps: 2,
      },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.errorStall).toBe(true);
    expect(v.reason).toMatch(/FAULT|reaper/i);
    expect(v.reason).toMatch(/2 consecutive watchdog sweeps/);
  });

  it('fire-staleness: active routine that has not fired in >3h ⇒ stalled', () => {
    const v = evaluateGitSyncStall({ ...base, lastFiredMs: NOW - 4 * H }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(true);
    expect(v.reason).toMatch(/not FIRED/);
  });

  it('never-fired (fresh seed) ⇒ never alarms on fire-staleness', () => {
    const v = evaluateGitSyncStall({ ...base, lastFiredMs: null, headUnchangedMs: null, lastError: null }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
  });

  it('blank/whitespace last_error is treated as no error', () => {
    expect(evaluateGitSyncStall({ ...base, lastError: '   ', errorSweeps: 5 }, NOW).errorStall).toBe(false);
    expect(evaluateGitSyncStall({ ...base, lastError: '', errorSweeps: 5 }, NOW).errorStall).toBe(false);
  });

  describe('fault-persistence gate (false-alarm fix, 2026-07-02)', () => {
    const fault = { ...base, lastError: 'libs/generic/sse: push failed: git push origin HEAD:main timed out after 240000ms' };

    it('a fault observed on a SINGLE sweep is transient ⇒ NOT stalled (the 06:54 papercusp false alarm)', () => {
      // The live incident: one 240s submodule push timeout, self-recovered in 6 min —
      // yet it urgently paged the owner + broadcast "code is stranding" fleet-wide.
      const v = evaluateGitSyncStall({ ...fault, errorSweeps: 1 }, NOW);
      expect(v.errorStall).toBe(false);
      expect(v.stalled).toBe(false);
    });

    it('errorSweeps absent with a present fault reads as a first observation ⇒ NOT stalled', () => {
      const v = evaluateGitSyncStall(fault, NOW);
      expect(v.errorStall).toBe(false);
      expect(v.stalled).toBe(false);
    });

    it('the threshold is overridable (errorStallMinSweeps)', () => {
      expect(evaluateGitSyncStall({ ...fault, errorSweeps: 1 }, NOW, { errorStallMinSweeps: 1 }).errorStall).toBe(true);
      expect(evaluateGitSyncStall({ ...fault, errorSweeps: 2 }, NOW, { errorStallMinSweeps: 3 }).errorStall).toBe(false);
    });

    it('a persistent fault does NOT mask the primary signals: frozen HEAD still alarms at sweep 1 (2026-07-02 hiveloop)', () => {
      const v = evaluateGitSyncStall(
        { ...fault, errorSweeps: 1, headUnchangedMs: 3 * H, lastStatus: 'error' },
        NOW,
      );
      expect(v.errorStall).toBe(false);
      expect(v.commitStale).toBe(true);
      expect(v.stalled).toBe(true);
    });
  });

  it('thresholds are overridable (headStaleMs / fireStaleMs)', () => {
    const s = { ...base, headUnchangedMs: 20 * M, lastFiredMs: NOW - 30 * M };
    expect(evaluateGitSyncStall(s, NOW).commitStale).toBe(false); // 20m < default 30m
    expect(evaluateGitSyncStall(s, NOW, { headStaleMs: 10 * M }).commitStale).toBe(true);
    expect(evaluateGitSyncStall(s, NOW, { fireStaleMs: 10 * M }).fireStale).toBe(true);
  });

  it('WI-1416 persistent reap: >=3 consecutive executor-reaper cancels ⇒ stalled (the synthetic reap-loop alarm)', () => {
    // Synthetic persistent-reap: fires keep starting (lastFired fresh, so NOT fire-stale;
    // last_error null — the reaper marker can flip null between reaps) but the reaper has
    // cancelled 3 consecutive fires. reaped_count is the durable signal that survives the
    // noisy last_error, so the watchdog must alarm on it alone.
    const v = evaluateGitSyncStall({ ...base, reapedCount: 3 }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.persistentReap).toBe(true);
    expect(v.commitStale).toBe(false);
    expect(v.errorStall).toBe(false);
    expect(v.reason).toMatch(/reaper has cancelled 3 consecutive/i);
  });

  it('WI-1416 persistent reap: below the threshold (or absent) ⇒ not stalled; threshold overridable', () => {
    expect(evaluateGitSyncStall({ ...base, reapedCount: 2 }, NOW).persistentReap).toBe(false);
    expect(evaluateGitSyncStall(base, NOW).persistentReap).toBe(false); // reapedCount absent → 0
    expect(evaluateGitSyncStall({ ...base, reapedCount: 2 }, NOW, { persistentReapMin: 2 }).persistentReap).toBe(true);
  });

  it('WI-1416 persistent reap: a completed fire resets the counter (recordOutcome writes 0) ⇒ recovery clears the verdict', () => {
    const v = evaluateGitSyncStall({ ...base, reapedCount: 0 }, NOW);
    expect(v.persistentReap).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('WI-1416: the escalation body carries the persistentReap flag', () => {
    const v = evaluateGitSyncStall({ ...base, reapedCount: 4 }, NOW);
    const body = JSON.parse(
      gitSyncStallEscalationBody({ installSlug: 'papercusp', verdict: v, lastFiredMs: base.lastFiredMs, headUnchangedMs: null, lastStatus: 'nothing', nowMs: NOW }),
    );
    expect(body.persistentReap).toBe(true);
  });

  it('escalation body captures the commit-stall + is valid JSON', () => {
    const v = evaluateGitSyncStall({ ...base, headUnchangedMs: 6 * H }, NOW);
    const body = JSON.parse(
      gitSyncStallEscalationBody({ installSlug: 'papercusp', verdict: v, lastFiredMs: base.lastFiredMs, headUnchangedMs: 6 * H, lastStatus: 'nothing', nowMs: NOW }),
    );
    expect(body.kind).toBe('git-sync-watchdog');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.commitStale).toBe(true);
    expect(body.headUnchangedHrs).toBe(6);
    expect(String(body.detail)).toMatch(/deploy ships only committed HEAD|strand/i);
  });
});

describe('clean-idle exemption (false-alarm fix, 2026-07-02)', () => {
  it("lastStatus 'nothing' (clean tree) never head-stalls — idle hives stop crying wolf", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 48 * 3_600_000, lastError: null, lastStatus: 'nothing', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it("a 'synced'-status hive with a frozen HEAD still stalls (real commit failures alarm)", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 48 * 3_600_000, lastError: null, lastStatus: 'synced', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(true);
  });

  it("lastStatus 'skipped' (eligibility-gated fire) never head-stalls — a vanished checkout is not stranding code (2026-07-03 lane-rig incident)", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 61 * 3_600_000, lastError: null, lastStatus: 'skipped', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
  });

  it("fire-stale / reap stalls still alarm on a 'skipped' routine (status-independent signals)", () => {
    const fireStale = evaluateGitSyncStall(
      { lastFiredMs: NOW - 48 * 3_600_000, headUnchangedMs: 0, lastError: null, lastStatus: 'skipped', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(fireStale.stalled).toBe(true);
    const reaped = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 0, lastError: null, lastStatus: 'skipped', watchdogAlerted: false, reapedCount: 3 },
      NOW,
    );
    expect(reaped.stalled).toBe(true);
  });

  it('fire-stale and error stalls are status-independent (a dead engine reports nothing)', () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 48 * 3_600_000, headUnchangedMs: 0, lastError: null, lastStatus: 'nothing', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(true);
  });

  it('EI-2994: a stale root routine engine suppresses git-sync symptom alarms', () => {
    const v = evaluateGitSyncStall(
      {
        lastFiredMs: NOW - 48 * 3_600_000,
        headUnchangedMs: 48 * 3_600_000,
        lastError: 'push failed',
        errorSweeps: 5,
        lastStatus: 'error',
        watchdogAlerted: false,
        reapedCount: 5,
        routineEngineStale: true,
      },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.errorStall).toBe(false);
    expect(v.persistentReap).toBe(false);
    expect(v.reason).toBeNull();
  });
});
