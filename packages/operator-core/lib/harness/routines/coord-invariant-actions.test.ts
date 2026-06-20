/**
 * coord-invariant-actions — unit tests for the Layer D watchers
 * (coord-system-e2e-testing-2026-06-10 P-012/P-013): the pure probe verdict,
 * the fake-driven probe cycle (happy path, contention violation, mid-cycle
 * failure leaves no held lock), the pure invariant evaluation (each check's
 * threshold + stable dedup titles), and registration.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateProbe,
  attributeBreach,
  classifyBreach,
  breachDisposition,
  runProbeCycle,
  evaluateInvariants,
  planStaleHandoffAccepts,
  planSharedHiveCapture,
  DEFAULT_THRESHOLDS,
  PROBE_A,
  PROBE_B,
  type ProbeDeps,
  type ProbeStep,
  type ProbeVerdict,
  type InvariantSnapshot,
} from './coord-invariant-actions';
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
    openEscalationTs: [],
    longExpiredLocks: 0,
    presenceGhosts: 0,
    wakeQueueDepth: 0,
    wakeQueueOldestMs: null,
  };
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  it('a clean snapshot yields no violations', () => {
    expect(evaluateInvariants(cleanSnap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('each check fires past its threshold with a STABLE dedup title', () => {
    const snap: InvariantSnapshot = {
      openHandoffTs: [hoursAgo(13), hoursAgo(1)], // 1 stuck, 1 fresh
      openEscalationTs: [hoursAgo(7)],
      longExpiredLocks: 2,
      presenceGhosts: 3,
      wakeQueueDepth: 51,
      wakeQueueOldestMs: NOW - 1_000,
    };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations.map((v) => v.title)).toEqual([
      'coord invariant: handoffs stuck pending past 12h',
      'coord invariant: escalations unacked past 6h',
      'coord invariant: file locks held past TTL without sweep',
      'coord invariant: presence ghosts lingering past 72h',
      'coord invariant: wake-queue depth/age growth',
    ]);
    // Stability: re-evaluating yields the SAME titles (the dedup key).
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title)).toEqual(
      violations.map((v) => v.title),
    );
  });

  it('fresh handoffs/escalations under the window do not fire', () => {
    const snap = { ...cleanSnap, openHandoffTs: [hoursAgo(11)], openEscalationTs: [hoursAgo(5)] };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('wake-queue fires on AGE even when depth is small', () => {
    const snap = { ...cleanSnap, wakeQueueDepth: 1, wakeQueueOldestMs: NOW - 7 * 3_600_000 };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe('coord invariant: wake-queue depth/age growth');
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

describe('registration', () => {
  it('both system actions are registered by the module side-effect', () => {
    expect(getSystemAction('coord-probe-canary')).toBeTypeOf('function');
    expect(getSystemAction('coord-invariant-monitor')).toBeTypeOf('function');
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
