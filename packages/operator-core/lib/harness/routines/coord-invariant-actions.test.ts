/**
 * coord-invariant-actions — unit tests for the Layer D watchers
 * (coord-system-e2e-testing-2026-06-10 P-012/P-013): the pure probe verdict,
 * the fake-driven probe cycle (happy path, contention violation, mid-cycle
 * failure leaves no held lock), the pure invariant evaluation (each check's
 * threshold + stable dedup titles), and registration.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  evaluateProbe,
  attributeBreach,
  classifyBreach,
  breachDisposition,
  runProbeCycle,
  evaluateInvariants,
  isBackupOrMaintenanceStatement,
  planStaleHandoffAccepts,
  planSharedHiveCapture,
  planClaimIntegrityAlarms,
  drainOperationalEscalationsBeforeMeasure,
  DEFAULT_THRESHOLDS,
  ESCALATION_RECONCILE_GRACE_MS,
  PROBE_A,
  PROBE_B,
  type ProbeDeps,
  type ProbeStep,
  type ProbeVerdict,
  type InvariantSnapshot,
  type ClaimIntegrityViolation,
} from './coord-invariant-actions';
import { OPERATIONAL_ESCALATION_TTL_MS } from '../../attention/reconcile-escalations';
import { getSystemAction } from './system-actions';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

const idA = { ownerId: PROBE_A, ownerLabel: PROBE_A, source: 'omp-hook-session', workspaceId: 'ws', userId: null } as AgentIdentity;
const idB = { ownerId: PROBE_B, ownerLabel: PROBE_B, source: 'omp-hook-session', workspaceId: 'ws', userId: null } as AgentIdentity;

/** A well-behaved in-memory coordination + lock fake. */
function fakeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps & { held: Map<string, string> } {
  const held = new Map<string, string>();
  let seq = 0;
  let clock = 0;
  const deps: ProbeDeps & { held: Map<string, string> } = {
    held,
    baseline: async () => ({ ok: true }),
    send: async () => ({ msg_id: `m-${++seq}`, ts: new Date(1_700_000_000_000 + seq).toISOString() }),
    inboxHas: async () => true,
    ack: async () => {},
    ackedHas: async () => true,
    acquire: async (owner) => {
      const cur = held.get('probe');
      if (cur && cur !== owner) return { ok: false, busyOwner: cur };
      held.set('probe', owner);
      return { ok: true };
    },
    release: async (owner) => {
      if (held.get('probe') === owner) held.delete('probe');
    },
    now: () => (clock += 10),
    ...over,
  };
  return deps;
}

describe('runProbeCycle + evaluateProbe', () => {
  it('happy path: all eight steps (baseline first) pass and the lock ends free', async () => {
    const deps = fakeDeps();
    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.map((s) => s.step)).toEqual([
      'baseline', 'ping', 'inbox', 'ack', 'lock-acquire', 'lock-contend', 'lock-release', 'lock-regrant',
    ]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(deps.held.size).toBe(0);
    const verdict = evaluateProbe(steps, 10_000);
    expect(verdict.ok).toBe(true);
    expect(verdict.sloBreached).toBe(false);
  });

  it('a contender GRANTED a held lock is a violation, and the holder still releases', async () => {
    const deps = fakeDeps({
      acquire: async () => ({ ok: true }), // mutual exclusion broken
    });
    const steps = await runProbeCycle(deps, idA, idB);
    const contend = steps.find((s) => s.step === 'lock-contend');
    expect(contend?.ok).toBe(false);
    expect(contend?.detail).toContain('GRANTED');
    const verdict = evaluateProbe(steps, 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStep).toBe('lock-contend');
  });

  it('a throwing step records the failure and stops the cycle', async () => {
    const deps = fakeDeps({ inboxHas: async () => Promise.reject(new Error('inbox query died')) });
    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.map((s) => s.step)).toEqual(['baseline', 'ping', 'inbox']);
    expect(steps[2].ok).toBe(false);
    expect(steps[2].detail).toContain('inbox query died');
  });

  it('a failed baseline (DB unreachable) aborts before any coord verb', async () => {
    const deps = fakeDeps({ baseline: async () => Promise.reject(new Error('SELECT 1 timed out')) });
    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.map((s) => s.step)).toEqual(['baseline']);
    expect(steps[0].ok).toBe(false);
    expect(steps[0].detail).toContain('SELECT 1 timed out');
  });

  it('a clean-but-slow cycle breaches the SLO', () => {
    const steps: ProbeStep[] = [
      { step: 'ping', ok: true, ms: 6_000 },
      { step: 'inbox', ok: true, ms: 6_000 },
    ];
    const verdict = evaluateProbe(steps, 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.sloBreached).toBe(true);
    expect(verdict.failedStep).toBeUndefined();
  });
});

describe('attributeBreach (EI-401 self-attribution)', () => {
  const step = (s: string, ms: number): ProbeStep => ({ step: s, ok: true, ms });

  it('blames DB-wide contention when the control baseline is itself slow', () => {
    const hint = attributeBreach([step('baseline', 9_000), step('ping', 12_000), step('ack', 9_000)]);
    expect(hint).toContain('DB-wide');
    expect(hint).toContain('9000ms');
    expect(hint).not.toContain('coord INSERT');
  });

  it('blames the coord write path when baseline is fast but ping/ack are slow', () => {
    const hint = attributeBreach([step('baseline', 5), step('ping', 12_000), step('ack', 9_000), step('inbox', 477)]);
    expect(hint).toContain('coord INSERT+commit+NOTIFY');
    expect(hint).toContain('ping 12000ms');
    expect(hint).not.toContain('DB-wide');
  });

  it('falls back to cumulative-load when nothing dominates', () => {
    const hint = attributeBreach([step('baseline', 5), step('ping', 100), step('ack', 80)]);
    expect(hint).toContain('no single step dominates');
  });
});

describe('classifyBreach', () => {
  const step = (s: string, ms: number): ProbeStep => ({ step: s, ok: true, ms });

  it('classifies a slow baseline as db-wide, fast-baseline-slow-write as coord', () => {
    expect(classifyBreach([step('baseline', 9_000), step('ping', 12_000), step('ack', 9_000)])).toBe('db-wide');
    expect(classifyBreach([step('baseline', 5), step('ping', 12_000), step('ack', 9_000)])).toBe('coord');
  });

  it('returns cumulative when nothing dominates, none when no baseline sampled', () => {
    expect(classifyBreach([step('baseline', 5), step('ping', 100), step('ack', 80)])).toBe('cumulative');
    expect(classifyBreach([step('ping', 12_000), step('ack', 9_000)])).toBe('none');
  });
});

describe('breachDisposition (EI-401 file-vs-note)', () => {
  const step = (s: string, ms: number): ProbeStep => ({ step: s, ok: true, ms });
  const verdict = (over: Partial<ProbeVerdict>): ProbeVerdict =>
    ({ ok: false, totalMs: 30_001, sloBreached: true, ...over });

  it('downgrades a pure SLO breach pinned on DB-wide contention to a NOTE', () => {
    const steps = [step('baseline', 9_000), step('ping', 12_000), step('ack', 9_000)];
    expect(breachDisposition(verdict({ sloBreached: true }), steps)).toBe('note');
  });

  it('FILES a coord-attributed breach (the real coord INSERT+NOTIFY cost)', () => {
    const steps = [step('baseline', 5), step('ping', 12_000), step('ack', 9_000), step('inbox', 477)];
    expect(breachDisposition(verdict({ sloBreached: true }), steps)).toBe('file');
  });

  it('FILES a cumulative breach and an unattributable one (fail open, never swallow)', () => {
    expect(breachDisposition(verdict({ sloBreached: true }), [step('baseline', 5), step('ping', 100), step('ack', 80)])).toBe('file');
    // no baseline sampled ⇒ classifyBreach 'none' ⇒ still files.
    expect(breachDisposition(verdict({ sloBreached: true }), [step('ping', 40_000)])).toBe('file');
  });

  it('always FILES a failed step regardless of latency attribution', () => {
    // A failed step is a correctness failure: evaluateProbe leaves sloBreached=false,
    // so even a slow baseline never downgrades it.
    const steps = [step('baseline', 9_000), { step: 'lock-contend', ok: false, ms: 5 }];
    expect(breachDisposition(verdict({ sloBreached: false, failedStep: 'lock-contend' }), steps)).toBe('file');
  });

  it('a clean cycle is ok (nothing filed or noted)', () => {
    expect(breachDisposition({ ok: true, totalMs: 200, sloBreached: false }, [step('baseline', 5)])).toBe('ok');
  });
});

describe('evaluateInvariants', () => {
  const NOW = Date.parse('2026-06-10T12:00:00Z');
  const cleanSnap: InvariantSnapshot = {
    openHandoffTs: [],
    openEscalations: [],
    longExpiredLocks: 0,
    presenceGhosts: 0,
    wakeQueueDepth: 0,
    wakeQueueOldestMs: null,
    coordLogFurnaces: [],
    coordLogActiveOffenders: [],
  };
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const TTL_H = OPERATIONAL_ESCALATION_TTL_MS / 3_600_000;
  // EI-7087: the invariant's effective threshold is TTL + a reconcile-cadence grace
  // (see ESCALATION_RECONCILE_GRACE_MS) — assert against the EFFECTIVE boundary, not
  // the bare TTL, so these tests track what the check actually fires on.
  const GRACE_H = ESCALATION_RECONCILE_GRACE_MS / 3_600_000;
  const EFFECTIVE_H = TTL_H + GRACE_H;
  /** An OPERATIONAL escalation (system/infra-emitter, option-less) opened `h` hours ago. */
  const opEsc = (h: number, from = 'system') => ({ ts: hoursAgo(h), from, hasOptions: false });

  it('a clean snapshot yields no violations', () => {
    expect(evaluateInvariants(cleanSnap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('each check fires past its threshold with a STABLE dedup title', () => {
    const snap: InvariantSnapshot = {
      openHandoffTs: [hoursAgo(13), hoursAgo(1)], // 1 stuck, 1 fresh
      openEscalations: [opEsc(EFFECTIVE_H + 1)], // operational, past TTL + reconcile grace
      longExpiredLocks: 2,
      presenceGhosts: 3,
      wakeQueueDepth: 251, // EI-10177: > wakeQueueDepthMax (250) — a genuine runaway
      wakeQueueOldestMs: NOW - 1_000,
      coordLogFurnaces: [
        { queryid: '123', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ...', calls: 285_000, rowsPerCall: 80_000, meanExecMs: 500 },
      ],
      coordLogActiveOffenders: [],
    };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations.map((v) => v.title)).toEqual([
      'coord invariant: handoffs stuck pending past 12h',
      'coord invariant: operational escalations undrained past reconcile TTL',
      'coord invariant: file locks held past TTL without sweep',
      'coord invariant: presence ghosts lingering past 72h',
      'coord invariant: wake-queue depth/age growth',
      'coord invariant: unbounded coord_event_log read pattern (furnace class)',
    ]);
    // Stability: re-evaluating yields the SAME titles (the dedup key).
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title)).toEqual(
      violations.map((v) => v.title),
    );
  });

  it('fresh handoffs + operational escalations under their windows do not fire', () => {
    const snap = {
      ...cleanSnap,
      openHandoffTs: [hoursAgo(11)], // under the 12h stuck-handoff window
      openEscalations: [opEsc(TTL_H - 1)], // operational, still within the reconcile TTL
    };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('EI-7087: an escalation past the bare TTL but still within the reconcile-cadence grace does not fire', () => {
    // This is the exact false-positive this fix closes: an operational escalation
    // that crossed the 48h TTL boundary between two hourly reconcile ticks is, by
    // construction, still "open" when the invariant checks — but the reconcile sweep
    // is working fine and will drain it at its very next tick. Only past TTL+grace
    // is a genuine drain-failure signal.
    const snap = { ...cleanSnap, openEscalations: [opEsc(TTL_H + GRACE_H / 2)] };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('EI-6910: the escalation invariant measures substrate DRAIN failure, not the human backlog', () => {
    // GENUINE human-decision escalations (real sender, and/or options) are the human's
    // attention queue — NEVER a substrate leak, however old: no violation.
    expect(
      evaluateInvariants(
        {
          ...cleanSnap,
          openEscalations: [
            { ts: hoursAgo(1000), from: 'operator', hasOptions: true }, // ancient blocker decision
            { ts: hoursAgo(500), from: 's-dead-agent-42', hasOptions: false }, // orphaned agent escalation
          ],
        },
        DEFAULT_THRESHOLDS,
        NOW,
      ),
    ).toEqual([]);

    // OPERATIONAL escalations within the reconcile TTL are being drained on cadence: no violation.
    expect(
      evaluateInvariants(
        { ...cleanSnap, openEscalations: [opEsc(TTL_H - 1, 'system:hive-placement-watchdog'), opEsc(6, 'steering-lease')] },
        DEFAULT_THRESHOLDS,
        NOW,
      ),
    ).toEqual([]);

    // OPERATIONAL escalations PAST the reconcile TTL (+ grace) = the reconcile sweep is
    // genuinely failing: ONE violation.
    const v = evaluateInvariants(
      { ...cleanSnap, openEscalations: [opEsc(EFFECTIVE_H + 1, 'steering-lease'), opEsc(EFFECTIVE_H + 5, 'system')] },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].title).toBe('coord invariant: operational escalations undrained past reconcile TTL');
    expect(v[0].detail).toContain('2 operational escalation(s)');
    expect(v[0].severity).toBe('minor');
  });

  it('wake-queue fires on AGE only past the auto-expiry deadline + grace (a genuine sweep failure)', () => {
    // pendingWakeStaleHours (24h) + WAKE_QUEUE_STALE_GRACE_MS (1h) = 25h. A wake surviving
    // past that means sweepStalePendingWakes (which runs in-pass just before the check and
    // reaps everything past 24h) genuinely failed — the only real substrate leak.
    const snap = { ...cleanSnap, wakeQueueDepth: 1, wakeQueueOldestMs: NOW - 26 * 3_600_000 };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe('coord invariant: wake-queue depth/age growth');
  });

  it('EI-8664: does NOT fire on a wake aging within the auto-expiry window (live-owner review backlog, not a leak)', () => {
    // The exact false positive this fixes: a staged wake aged 12.8h — past the OLD 6h
    // alert but well within the 24h auto-expiry sweep window. sweepStalePendingWakes reaps
    // it at 24h; until then it is expected live-owner review backlog, NOT a substrate leak.
    // Alarming on it is the EI-6910 anti-pattern (the human's normal backlog re-filed hourly).
    const snap = { ...cleanSnap, wakeQueueDepth: 16, wakeQueueOldestMs: NOW - 12.8 * 3_600_000 };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    // Even a wake right at the 24h deadline (just under it) is still within the grace: no fire.
    const atDeadline = { ...cleanSnap, wakeQueueDepth: 1, wakeQueueOldestMs: NOW - 24 * 3_600_000 };
    expect(evaluateInvariants(atDeadline, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('wake-queue still fires on DEPTH regardless of age (genuine-runaway bloat backstop)', () => {
    // EI-10177: the depth backstop fires only on a genuine runaway (> wakeQueueDepthMax=250),
    // regardless of age — young wakes count here (unlike the AGE leg), this is the storm signal.
    const snap = { ...cleanSnap, wakeQueueDepth: 251, wakeQueueOldestMs: NOW - 1_000 };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe('coord invariant: wake-queue depth/age growth');
  });

  it('EI-10177: does NOT fire on normal live-owner review backlog (depth under the runaway cap)', () => {
    // The exact false positive this fixes: 57 young staged wakes for LIVE owners (observed
    // live, one owner alone at 32) — 0 stale, all within the 24h auto-expiry window. The
    // in-pass sweeps can't/shouldn't reap them (they reap only dead-owner + >staleHours), so
    // the OLD flat cap of 50 re-filed a non-actionable EI every hour (recurred 5×) — the
    // EI-6910/EI-8664 anti-pattern (a count threshold measuring the human's normal review
    // backlog). A busy-fleet backlog under the runaway cap is expected, never a filed bug.
    const snap = { ...cleanSnap, wakeQueueDepth: 57, wakeQueueOldestMs: NOW - 9 * 3_600_000 };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('EI-10257 / EI-10248: the exact stale-re-file snapshot (depth 56, oldest ~10-11h) no longer alarms under the CURRENT thresholds', () => {
    // EI-10257 (auto-filed 2026-07-12 07:37) and its twin EI-10248 (auto-filed 06:37, 2.5min
    // BEFORE the fix committed) are stale re-files of the EI-10177/EI-8664 class: both fired
    // citing "depth=56 (max 50), oldest=~10-11h" — but that `max 50` is the OLD threshold.
    // EI-10177 raised wakeQueueDepthMax 50 → 250 (committed + green in main at 06:39), and the
    // AGE alarm already fires only past the 24h+1h auto-expiry deadline (EI-8664). The alarm
    // kept re-filing only because the deployed :3070 operator predated the raise; the fix is
    // in-tree and this pin proves it. With the CURRENT thresholds, 56 < 250 and 10-11h < 25h
    // ⇒ ZERO violations.
    const snap = { ...cleanSnap, wakeQueueDepth: 56, wakeQueueOldestMs: NOW - 11 * 3_600_000 };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    // EI-10248's exact snapshot: depth=56, oldest=10.0h — same class, same verdict.
    const ei10248 = { ...cleanSnap, wakeQueueDepth: 56, wakeQueueOldestMs: NOW - 10 * 3_600_000 };
    expect(evaluateInvariants(ei10248, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  describe('WI-3959: coord_event_log furnace-class recurrence guard', () => {
    it('does not fire under both thresholds', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: '1', queryPreview: 'SELECT ...', calls: 100, rowsPerCall: 200, meanExecMs: 5 }],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('fires on rows/call alone, even with a fast mean exec time', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          // The WI-3937 shape (readLines full-surface scan): huge rows/call, each
          // individual call still fast (sub-2s) — the aggregate is the furnace, not
          // any single slow call, which is exactly why a rows/call threshold (not
          // just a mean-exec-time one) is needed to catch this class.
          { queryid: 'wi3937', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ORDER BY id ASC', calls: 285_000, rowsPerCall: 80_000, meanExecMs: 500 },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
      expect(violations[0].severity).toBe('major');
      expect(violations[0].detail).toContain('wi3937');
      expect(violations[0].detail).toContain('80000');
    });

    it('fires on mean exec time alone, even under the rows/call threshold', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: 'slow', queryPreview: 'SELECT ... coord_event_log ...', calls: 10, rowsPerCall: 5, meanExecMs: 5_000 }],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
    });

    it('folds a currently-active offender pid/application_name into the detail when caught mid-scan', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: 'active-one', queryPreview: 'SELECT ... coord_event_log ...', calls: 1, rowsPerCall: 8_000_000_000, meanExecMs: 130_000 }],
        coordLogActiveOffenders: [{ pid: 4242, applicationName: 'bg-host-substrate', durationSeconds: 130.4 }],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain('pid=4242');
      expect(violations[0].detail).toContain('bg-host-substrate');
    });

    it('EI-9420: a mean-exec-time breach is SUPPRESSED when min_exec_time proves a fast path already exists', () => {
      // Live-verified shape (2026-07-11): a query fixed hours ago (a new index / an
      // added LIMIT) but whose pg_stat_statements lifetime mean is still dragged up by
      // historical pre-fix calls. min_exec_time in the low-hundreds-ms range proves the
      // CURRENT code already has a fast/bounded route — the alarming mean is stale
      // debris, not a live furnace.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          { queryid: 'fixed-hours-ago', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ...', calls: 3202, rowsPerCall: 772, meanExecMs: 7511, minExecMs: 2.3 },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-9420: a mean-exec-time breach STILL fires when min_exec_time shows no fast path ever existed', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          { queryid: 'genuinely-still-broken', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ...', calls: 500, rowsPerCall: 1000, meanExecMs: 3_000, minExecMs: 2_800 },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
      expect(violations[0].detail).toContain('min_exec_ms=2800');
    });

    it('EI-9420: an ABSENT min_exec_time never suppresses (unknown ⇒ still judged on mean alone)', () => {
      // Same shape as the pre-existing "fires on mean exec time alone" test but
      // explicit that omitting minExecMs (an older snapshot shape) is NOT treated as
      // "proven fast" — only a known, low value suppresses.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: 'no-min-data', queryPreview: 'SELECT ... coord_event_log ...', calls: 10, rowsPerCall: 5, meanExecMs: 5_000 }],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
    });

    it('EI-9420: the rows/call leg fires regardless of min_exec_time (never suppressed by a fast best-case)', () => {
      // The WI-3937 class: a habitually-huge row count IS the furnace even when every
      // individual call (including the best case) is fast — rows/call must stay an
      // unconditional trigger, independent of the mean-exec proven-fast-path guard.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          { queryid: 'wi3937-fast-min', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ORDER BY id ASC', calls: 285_000, rowsPerCall: 80_000, meanExecMs: 500, minExecMs: 1 },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
    });

    it('EI-9506: a backup/maintenance COPY dump is NOT judged a furnace (rows/call leg exempt)', () => {
      // Live-verified shape (2026-07-11, EI-9506): a pg_dump-style full-table
      // `COPY ... TO stdout` returns the WHOLE table (~102k rows/call) every time —
      // it is a backup, not an application read pattern, so there is nothing to
      // bound. It trips the rows/call leg (>50k) and, having no fast path, is NOT
      // rescued by EI-9420's min_exec suppression — so before this fix it fired the
      // furnace alarm forever with no fixable target.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: '-6142784371100098654',
            queryPreview:
              'COPY harness_shared.coord_event_log (id, surface, writer_key, msg_id, body, ts, workspace_id, harness_slug, origin, author_pubkey, fed_ts, fed_hlc) TO stdout',
            calls: 1,
            rowsPerCall: 102_306,
            meanExecMs: 2733,
            minExecMs: 2733,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-9506: a genuine application query with the SAME huge rows/call STILL fires (guard is COPY-specific)', () => {
      // The exemption must key on the backup STATEMENT KIND, never on "huge rows are
      // fine" — an app SELECT that habitually returns 100k rows is exactly the
      // WI-3937 furnace the rows/call leg exists to catch.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: 'app-full-scan',
            queryPreview: 'SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $2 ORDER BY id ASC',
            calls: 285_000,
            rowsPerCall: 102_306,
            meanExecMs: 500,
          },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
    });

    it('EI-9506: isBackupOrMaintenanceStatement matches COPY (any case / leading whitespace) but not a SELECT', () => {
      expect(isBackupOrMaintenanceStatement('COPY harness_shared.coord_event_log (...) TO stdout')).toBe(true);
      expect(isBackupOrMaintenanceStatement('  copy harness_shared.coord_event_log TO stdout')).toBe(true);
      expect(isBackupOrMaintenanceStatement('SELECT body FROM harness_shared.coord_event_log ORDER BY id ASC')).toBe(false);
      // Not a false-positive on a query that merely mentions COPY in a string/column.
      expect(isBackupOrMaintenanceStatement("SELECT body FROM harness_shared.coord_event_log WHERE body->>'kind' = 'copy'")).toBe(false);
    });

    it('EI-9533: a slow VACUUM/ANALYZE maintenance op on coord_event_log is NOT judged a furnace', () => {
      // Live-verified shape (2026-07-11, EI-9533): autovacuum/maintenance
      // `VACUUM ANALYZE` / `ANALYZE harness_shared.coord_event_log` runs multi-second
      // (2.4–3.4s observed) — it touches the whole table BY DESIGN, exactly like the
      // EI-9506 COPY dump, so it must never be judged an application furnace. It trips
      // the MEAN-exec leg (>2000ms) and has NO fast path (min_exec is high too, so
      // EI-9420's suppression cannot rescue it) — the only correct fix is to classify
      // it out by statement kind. (Before this it escaped only incidentally, via the
      // top-N-by-rows/call gather window that its rows/call=0 always ranked below.)
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: 'vacuum-analyze',
            queryPreview: 'VACUUM ANALYZE harness_shared.coord_event_log',
            calls: 1,
            rowsPerCall: 0,
            meanExecMs: 3432,
            minExecMs: 3432,
          },
          {
            queryid: 'analyze',
            queryPreview: 'ANALYZE harness_shared.coord_event_log',
            calls: 2,
            rowsPerCall: 0,
            meanExecMs: 2378,
            minExecMs: 2209,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-9533: isBackupOrMaintenanceStatement matches VACUUM/ANALYZE but not a SELECT that mentions them', () => {
      expect(isBackupOrMaintenanceStatement('VACUUM ANALYZE harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('vacuum harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('ANALYZE harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('  analyze (verbose) harness_shared.coord_event_log')).toBe(true);
      // Not a false-positive on a SELECT whose body merely mentions vacuum/analyze.
      expect(isBackupOrMaintenanceStatement("SELECT body FROM harness_shared.coord_event_log WHERE body->>'op' = 'vacuum'")).toBe(false);
      expect(isBackupOrMaintenanceStatement("SELECT 'analyze this' FROM harness_shared.coord_event_log")).toBe(false);
    });

    it('EI-9525/EI-9539/EI-9556/EI-9558: the exact 4-furnace snapshot those EIs filed no longer alarms under the CURRENT detector', () => {
      // Regression pin for EI-9525 (auto-filed 2026-07-11 01:38), its exact
      // duplicate EI-9539 (03:38), the third identical recurrence EI-9556
      // (06:38), AND the fourth EI-9558 (07:38) — the same 2h cadence, all minted
      // by a PRE-EI-9420 monitor whose snapshot carried no minExecMs, so nothing
      // could be proven fast, and all flagging the IDENTICAL four queryids below.
      // (The alarm keeps re-filing only because the deployed :3070 operator
      // predates the EI-9420/9506/9533 guards; the fix is in-tree and this pin
      // proves it — each recurrence gets auto-resolved, so the next stale-operator
      // fire 2h later sees no OPEN dup and mints a fresh EI. It stops when the
      // release gate carries these guards to :3070.) Every one of the four
      // statements they flagged is now closed by an EXISTING guard, re-verified
      // against LIVE pg_stat_statements (2026-07-11, EI-9558):
      //   (queryid min_exec_time live values: 7163…=68ms, -5934…=2ms, -1079…=0ms)
      //   1. the pg_dump COPY ... TO stdout (~102k rows/call) → excluded by
      //      isBackupOrMaintenanceStatement (EI-9506) — a backup, not an app read.
      //   2. readInbox's jsonb_exists membership scan (mean 2082ms) → LIMIT +
      //      ts-index (WI-3825); live min_exec_time 68ms proves the fast path.
      //   3. the conditions `(body ? .. OR body ? ..)` scan (mean 6755ms) → ts +
      //      LIMIT + partial index (migration 561); live min_exec_time 2ms.
      //   4. readEventsBounded's `body->>'kind' = ANY(..) LIMIT` (mean 4432ms) →
      //      already LIMIT-clamped + index; live min_exec_time 0ms.
      // With EI-9420's proven-fast-path suppression + EI-9506's COPY exemption both
      // in the deployed code, this snapshot must produce ZERO furnace violations —
      // the alarming means are lifetime debris from before those bounds landed.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: '-6142784371100098654',
            queryPreview:
              'COPY harness_shared.coord_event_log (id, surface, writer_key, msg_id, body, ts, workspace_id, harness_slug, origin, author_pubkey, fed_ts, fed_hlc) TO stdout',
            calls: 1,
            rowsPerCall: 102_306,
            meanExecMs: 2733,
            minExecMs: 2733,
          },
          {
            queryid: '7163057393307833526',
            queryPreview:
              'SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $3 AND jsonb_typeof(body->$4) = $5 AND (jsonb_exists(body->$6, $2) OR jsonb_exists(body->$7, $8)) ORDER BY id ASC',
            calls: 11_704,
            rowsPerCall: 12_444,
            meanExecMs: 2082,
            minExecMs: 68,
          },
          {
            queryid: '-5934058039784757788',
            queryPreview:
              'SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $2 AND (body ? $3 OR body ? $4) ORDER BY id ASC',
            calls: 3520,
            rowsPerCall: 780,
            meanExecMs: 6765,
            minExecMs: 2,
          },
          {
            queryid: '-1079103094344669412',
            queryPreview:
              "SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $2 AND body->>$5 = ANY($3::text[]) ORDER BY id DESC LIMIT $4",
            calls: 22_034,
            rowsPerCall: 497,
            meanExecMs: 4432,
            minExecMs: 0,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('is a stable dedup title across repeated evaluation (never floods the backlog)', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: '1', queryPreview: 'x', calls: 1, rowsPerCall: 100_000, meanExecMs: 100 }],
      };
      const first = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title);
      const second = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title);
      expect(first).toEqual(second);
    });
  });
});

describe('planStaleHandoffAccepts (F-FIX-037 stale-handoff auto-accept)', () => {
  const NOW = Date.parse('2026-06-20T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  it('returns the msg_ids of only the handoffs older than the threshold', () => {
    const open = [
      { msg_id: 'h-stale', ts: hoursAgo(13) },
      { msg_id: 'h-fresh', ts: hoursAgo(11) },
      { msg_id: 'h-ancient', ts: hoursAgo(48) },
    ];
    expect(planStaleHandoffAccepts(open, 12, NOW)).toEqual(['h-stale', 'h-ancient']);
  });

  it('is empty when nothing crosses the threshold (and on an empty list)', () => {
    expect(planStaleHandoffAccepts([{ msg_id: 'h1', ts: hoursAgo(1) }], 12, NOW)).toEqual([]);
    expect(planStaleHandoffAccepts([], 12, NOW)).toEqual([]);
  });

  it('uses a strict boundary — exactly-at-threshold is not yet stale, one ms past is', () => {
    expect(planStaleHandoffAccepts([{ msg_id: 'edge', ts: hoursAgo(12) }], 12, NOW)).toEqual([]);
    const justOver = new Date(NOW - 12 * 3_600_000 - 1).toISOString();
    expect(planStaleHandoffAccepts([{ msg_id: 'edge', ts: justOver }], 12, NOW)).toEqual(['edge']);
  });
});

describe('drainOperationalEscalationsBeforeMeasure (EI-8786 drain-before-measure)', () => {
  it('drains stale operational escalations via the reconcile sweep and returns the resolved count', async () => {
    // The fix: the invariant DRAINS in-pass before measuring (mirroring the handoff
    // auto-accept + wake-queue sweeps), so it no longer false-fires when the SEPARATE
    // hourly reconcile DBOS tick is late / shed / down. Here the in-pass reconcile
    // clears the operational backlog itself.
    const reconcile = vi.fn().mockResolvedValue({ resolved: 3 });
    expect(await drainOperationalEscalationsBeforeMeasure(reconcile)).toBe(3);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: a reconcile failure never aborts the invariant pass (returns 0)', async () => {
    // Fail-open: if the in-pass drain throws, the pass continues and the invariant
    // measures the un-drained state (filing a genuine violation) — it must NOT reject.
    const reconcile = vi.fn().mockRejectedValue(new Error('drain failed'));
    await expect(drainOperationalEscalationsBeforeMeasure(reconcile)).resolves.toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('registration', () => {
  it('all three system actions are registered by the module side-effect', () => {
    expect(getSystemAction('coord-probe-canary')).toBeTypeOf('function');
    expect(getSystemAction('coord-invariant-monitor')).toBeTypeOf('function');
    expect(getSystemAction('claim-integrity-sweep')).toBeTypeOf('function');
  });
});

describe('planClaimIntegrityAlarms (fleet-reliability-verification-2026-07-10 P-001 / EI-8999)', () => {
  const orphaned: ClaimIntegrityViolation = {
    kind: 'orphaned-wip',
    harnessSlug: 'papercusp',
    planSlug: 'some-plan',
    itemId: 'P-001',
    holderOwnerId: 'su-holder-1',
    holderOwnerLabel: 'su · holder-1',
    detail: 'orphaned wip detail',
  };
  const unbacked: ClaimIntegrityViolation = {
    kind: 'unbacked-assignment',
    harnessSlug: 'papercusp',
    planSlug: 'some-plan',
    itemId: 'P-002',
    holderOwnerId: 'su-holder-2',
    holderOwnerLabel: 'su-holder-2',
    detail: 'unbacked assignment detail',
  };

  it('alarms holder + fleet leader (deduped) when a leader is known and distinct', () => {
    const leaderByOwner = new Map([['su-holder-1', 'su-leader-9']]);
    const [alarm] = planClaimIntegrityAlarms([orphaned], leaderByOwner);
    expect(alarm.targets).toEqual(['su-holder-1', 'su-leader-9']);
    expect(alarm.summary).toContain('orphaned-wip');
    expect(alarm.summary).toContain('some-plan#P-001');
    expect(alarm.violation).toBe(orphaned);
  });

  it('alarms ONLY the holder when no leader is known (null)', () => {
    const leaderByOwner = new Map([['su-holder-1', null]]);
    const [alarm] = planClaimIntegrityAlarms([orphaned], leaderByOwner);
    expect(alarm.targets).toEqual(['su-holder-1']);
  });

  it('alarms ONLY the holder when no leader entry exists at all (map miss)', () => {
    const [alarm] = planClaimIntegrityAlarms([orphaned], new Map());
    expect(alarm.targets).toEqual(['su-holder-1']);
  });

  it('does not double-target when the holder IS the fleet leader', () => {
    const leaderByOwner = new Map([['su-holder-1', 'su-holder-1']]);
    const [alarm] = planClaimIntegrityAlarms([orphaned], leaderByOwner);
    expect(alarm.targets).toEqual(['su-holder-1']);
  });

  it('plans one alarm per violation, independently, for a mixed batch', () => {
    const leaderByOwner = new Map([
      ['su-holder-1', 'su-leader-9'],
      ['su-holder-2', null],
    ]);
    const planned = planClaimIntegrityAlarms([orphaned, unbacked], leaderByOwner);
    expect(planned).toHaveLength(2);
    expect(planned[0].targets).toEqual(['su-holder-1', 'su-leader-9']);
    expect(planned[0].summary).toContain('orphaned-wip');
    expect(planned[1].targets).toEqual(['su-holder-2']);
    expect(planned[1].summary).toContain('unbacked-assignment');
  });

  it('returns an empty plan for an empty violation list', () => {
    expect(planClaimIntegrityAlarms([], new Map())).toEqual([]);
  });
});

describe('planSharedHiveCapture (shared-hive-loop P-012/P-013 leg)', () => {
  it('maps every incident kind to a STABLE dedup title + severity', () => {
    const detail = { whatever: true };
    expect(planSharedHiveCapture({ kind: 'double-completion', title: 'noisy: F-123 by pk-abc…', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: cross-swarm double completion in h1',
      severity: 'major',
    });
    expect(planSharedHiveCapture({ kind: 'outbox-health', title: 'depth 12345 > 10000', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: substrate outbox depth/age breach',
      severity: 'major',
    });
    expect(planSharedHiveCapture({ kind: 'presence-ghost', title: 'ghost pk-xyz… holds 3', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: presence ghost anchoring live leases in h1',
      severity: 'minor',
    });
    expect(planSharedHiveCapture({ kind: 'orphaned-taken-by', title: '2 cleared', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: orphaned taken_by swept in h1',
      severity: 'minor',
    });
    // The volatile per-incident text never leaks into the dedup title.
    expect(planSharedHiveCapture({ kind: 'double-completion', title: 'F-999 other noise', detail }, 'h1').title).toBe(
      planSharedHiveCapture({ kind: 'double-completion', title: 'F-123 different noise', detail }, 'h1').title,
    );
  });
});
