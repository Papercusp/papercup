import { describe, expect, it } from 'vitest';
import { createFrozenCandidateRepairQueue, type FrozenCandidateRepairQueue, type FrozenRepairAdmission } from './frozen-candidate-repair-queue';
import {
  DEFAULT_GATE_INVARIANT_THRESHOLDS as T,
  evaluateGateLiveInvariants,
  foldGateInvariants,
  GATE_INVARIANT_HEARTBEAT_MS,
  overallGateInvariantStatus,
  parseGateInvariantsState,
  resolveGateExecutorDrift,
  type GateInvariantName,
  type GateInvariantSnapshot,
} from './gate-live-invariants';

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const C2 = '3333333333333333333333333333333333333333';
const BASE = '4444444444444444444444444444444444444444';
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const TICK = 4 * MIN;

function queue(over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return { ...createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests: ['lib/a.test.ts'], nowMs: T0 }), ...over };
}

function snap(over: Partial<GateInvariantSnapshot> = {}): GateInvariantSnapshot {
  return {
    nowMs: T0 + 10 * MIN,
    queueReadable: true,
    queue: null,
    fixerAlive: null,
    fireIntervalsMs: [TICK, TICK, TICK],
    checkpointStatuses: ['unchanged-since-verdict', 'advanced'],
    executor: { treeSha: 'abc1234567', driftPaths: [], oldestDriftCommitMs: null },
    ...over,
  };
}

const status = (s: GateInvariantSnapshot, name: GateInvariantName) =>
  evaluateGateLiveInvariants(s).find((r) => r.name === name)!;

function admission(over: Partial<FrozenRepairAdmission> = {}): FrozenRepairAdmission {
  return {
    atMs: T0 + MIN,
    actor: 'su-door',
    source: { ref: 'staging', sha: C1 },
    fromRepairHead: C,
    toRepairHead: C2,
    paths: ['lib/a.test.ts'],
    unchanged: [],
    blobs: { 'lib/a.test.ts': C1 },
    ...over,
  };
}

describe('healthy gate: every invariant that has evidence passes', () => {
  it('no open queue, verdicts flowing, executor current', () => {
    const results = evaluateGateLiveInvariants(snap());
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['fixer-spawn-latency', 'pass'],
      ['targeted-radius', 'pass'],
      ['admission-precheck', 'pass'],
      ['no-verdict-rate', 'pass'],
      ['round-idle-time', 'pass'],
      ['executor-freshness', 'pass'],
    ]);
    expect(overallGateInvariantStatus(results)).toBe('pass');
  });
});

describe('fixer-spawn-latency', () => {
  it('breaches when a red has waited longer than one measured tick plus grace with no fixer (the 2026-10-07/08 ~20h wait)', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: null });
    const r = status(snap({ queue: q, nowMs: T0 + 20 * 60 * MIN }), 'fixer-spawn-latency');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/no fixer dispatched/);
  });

  it('passes inside one tick plus grace', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: null });
    expect(status(snap({ queue: q, nowMs: T0 + TICK }), 'fixer-spawn-latency').status).toBe('pass');
  });

  it('uses the MEASURED tick, not the 60m default, when fires are recorded', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: null });
    const s = snap({ queue: q, nowMs: T0 + 30 * MIN });
    expect(status(s, 'fixer-spawn-latency').status).toBe('breach');
    expect(status({ ...s, fireIntervalsMs: [] }, 'fixer-spawn-latency').status).toBe('pass');
  });

  it('breaches when the assigned fixer is dead, and is unknown when liveness cannot be read', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: 'spawn-1', fixerSpawnedAtMs: T0 + MIN });
    expect(status(snap({ queue: q, fixerAlive: false }), 'fixer-spawn-latency').status).toBe('breach');
    expect(status(snap({ queue: q, fixerAlive: null }), 'fixer-spawn-latency').status).toBe('unknown');
    expect(status(snap({ queue: q, fixerAlive: true }), 'fixer-spawn-latency').status).toBe('pass');
  });

  it('breaches a live fixer that was dispatched too late after its red', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: 'spawn-1', fixerSpawnedAtMs: T0 + 3 * 60 * MIN });
    const r = status(snap({ queue: q, fixerAlive: true, nowMs: T0 + 4 * 60 * MIN }), 'fixer-spawn-latency');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/dispatched 180m after the red/);
  });
});

describe('admission-precheck', () => {
  it('breaches when the newest admission on the lineage carries no pre-check record (the live 0/25 shape)', () => {
    const q = queue({ phase: 'ready-to-verify', admissions: [admission()] });
    const r = status(snap({ queue: q }), 'admission-precheck');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/no pre-check record/);
  });

  it('judges only the NEWEST admission, and ignores ones from before the queue opened', () => {
    const old = admission({ atMs: T0 - 5 * MIN });
    const bad = admission({ atMs: T0 + MIN, precheck: { ran: true, failing: ['lib/a.test.ts'], passing: [] } });
    const good = admission({ atMs: T0 + 2 * MIN, precheck: { ran: true, failing: [], passing: ['lib/a.test.ts'] } });
    expect(status(snap({ queue: queue({ admissions: [bad, good] }) }), 'admission-precheck').status).toBe('pass');
    expect(status(snap({ queue: queue({ admissions: [good, bad].reverse() }) }), 'admission-precheck').status).toBe('pass');
    expect(status(snap({ queue: queue({ admissions: [old] }) }), 'admission-precheck').status).toBe('pass');
    expect(status(snap({ queue: queue({ admissions: [good, admission({ atMs: T0 + 3 * MIN, precheck: bad.precheck })] }) }), 'admission-precheck').status).toBe('breach');
  });

  it('a skipped pre-check is a breach; nothing-to-run is a pass', () => {
    const skipped = admission({ precheck: { ran: false, reason: 'skipped', precheckReason: 'trust me' } });
    const nothing = admission({ precheck: { ran: false, reason: 'nothing-to-run' } });
    expect(status(snap({ queue: queue({ admissions: [skipped] }) }), 'admission-precheck').observed).toMatch(/skipped: trust me/);
    expect(status(snap({ queue: queue({ admissions: [skipped] }) }), 'admission-precheck').status).toBe('breach');
    expect(status(snap({ queue: queue({ admissions: [nothing] }) }), 'admission-precheck').status).toBe('pass');
  });
});

describe('no-verdict-rate', () => {
  it('breaches on the measured 2026-10-01..08 mix (memory-budget, qualification-conflict, error dominate)', () => {
    const statuses = [
      ...Array(51).fill('skipped-memory-budget'),
      ...Array(46).fill('skipped-qualification-conflict'),
      ...Array(18).fill('error'),
      ...Array(12).fill('repair-in-progress'),
      ...Array(8).fill('unchanged-since-verdict'),
      'advanced',
      'not-green',
      'not-green',
    ];
    const r = status(snap({ checkpointStatuses: statuses }), 'no-verdict-rate');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/^115\/138 /);
    expect(r.observed).toMatch(/skipped-memory-budget×51/);
  });

  it('counts an UNRECOGNISED status as a failure, so a new failure mode cannot pass by being unknown', () => {
    const r = status(snap({ checkpointStatuses: ['brand-new-refusal', 'brand-new-refusal', 'brand-new-refusal'] }), 'no-verdict-rate');
    expect(r.status).toBe('breach');
  });

  it('a quiet healthy gate passes; an empty or unreadable window is unknown, not pass', () => {
    expect(status(snap({ checkpointStatuses: ['up-to-date', 'unchanged-since-verdict', 'error'] }), 'no-verdict-rate').status).toBe('pass');
    expect(status(snap({ checkpointStatuses: [] }), 'no-verdict-rate').status).toBe('unknown');
    expect(status(snap({ checkpointStatuses: null }), 'no-verdict-rate').status).toBe('unknown');
  });
});

describe('round-idle-time', () => {
  it('breaches when an admitted head waits past one tick for its verification run', () => {
    const q = queue({ phase: 'ready-to-verify', lastAdmittedAtMs: T0 + MIN });
    expect(status(snap({ queue: q, nowMs: T0 + 30 * MIN }), 'round-idle-time').status).toBe('breach');
    const started = queue({ phase: 'ready-to-verify', lastAdmittedAtMs: T0 + MIN, lastResumeRunStartedAtMs: T0 + 2 * MIN });
    expect(status(snap({ queue: started, nowMs: T0 + 30 * MIN }), 'round-idle-time').status).toBe('pass');
  });

  it('breaches a queue left ready-to-test past one tick', () => {
    const q = queue({ phase: 'ready-to-test', updatedAtMs: T0 });
    expect(status(snap({ queue: q, nowMs: T0 + 30 * MIN }), 'round-idle-time').status).toBe('breach');
  });
});

describe('executor-freshness', () => {
  it('breaches when committed gate code has waited past the grace for the executor to load it', () => {
    const s = snap({ executor: { treeSha: 'abc1234567', driftPaths: ['packages/operator-core/lib/release/x.ts'], oldestDriftCommitMs: T0 - 60 * MIN } });
    expect(status(s, 'executor-freshness').status).toBe('breach');
  });

  it('passes inside the grace; unresolvable drift is unknown, never pass', () => {
    const fresh = snap({ executor: { treeSha: 'abc1234567', driftPaths: ['packages/operator-core/lib/release/x.ts'], oldestDriftCommitMs: T0 } });
    expect(status(fresh, 'executor-freshness').status).toBe('pass');
    expect(status(snap({ executor: { treeSha: 'abc1234567', driftPaths: null, oldestDriftCommitMs: null } }), 'executor-freshness').status).toBe('unknown');
    expect(status(snap({ executor: null }), 'executor-freshness').status).toBe('unknown');
  });

  it('resolveGateExecutorDrift drops test files and degrades every git failure to null', async () => {
    const boot = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const git = async (args: string[]) => {
      if (args[0] === 'rev-parse') return args[2]?.startsWith('HEAD') ? head : boot;
      if (args[0] === 'diff') return 'packages/operator-core/lib/release/x.ts\npackages/operator-core/lib/release/x.test.ts\n';
      if (args[0] === 'log') return '1800000000\n1799990000\n';
      throw new Error('unexpected');
    };
    expect(await resolveGateExecutorDrift('abc1234567', git)).toEqual({
      driftPaths: ['packages/operator-core/lib/release/x.ts'],
      oldestDriftCommitMs: 1_799_990_000_000,
    });
    expect(await resolveGateExecutorDrift('abc1234567', async () => { throw new Error('no git'); })).toEqual({ driftPaths: null, oldestDriftCommitMs: null });
    expect(await resolveGateExecutorDrift('not a sha;rm', git)).toEqual({ driftPaths: null, oldestDriftCommitMs: null });
  });
});

describe('targeted-radius has no ledger yet, so it reports unknown while a queue is open', () => {
  it('unknown with a reason, never a fabricated pass', () => {
    const r = status(snap({ queue: queue() }), 'targeted-radius');
    expect(r.status).toBe('unknown');
    expect(r.observed).toMatch(/no per-round executed radius/);
  });
});

describe('fold: transitions, counters, heartbeat', () => {
  const pass = evaluateGateLiveInvariants(snap());
  const breachSnap = snap({ checkpointStatuses: ['error', 'error', 'error'] });
  const breach = evaluateGateLiveInvariants(breachSnap);

  it('the first evaluation is all transitions and emits', () => {
    const out = foldGateInvariants(null, pass, T0);
    expect(out.transitions).toHaveLength(6);
    expect(out.emit).toBe(true);
    expect(out.next.invariants['no-verdict-rate']).toMatchObject({ status: 'pass', sinceMs: T0, passes: 1, evaluations: 1 });
  });

  it('an unchanged evaluation inside the heartbeat neither transitions nor emits, and keeps sinceMs', () => {
    const first = foldGateInvariants(null, pass, T0).next;
    const out = foldGateInvariants(first, pass, T0 + 15 * MIN);
    expect(out.transitions).toEqual([]);
    expect(out.emit).toBe(false);
    expect(out.next.invariants['no-verdict-rate']).toMatchObject({ sinceMs: T0, passes: 2, evaluations: 2 });
    expect(out.next.lastEmittedAtMs).toBe(T0);
    expect(foldGateInvariants(out.next, pass, T0 + GATE_INVARIANT_HEARTBEAT_MS).emit).toBe(true);
  });

  it('a pass -> breach change is one transition and the breach keeps its last pass time', () => {
    const first = foldGateInvariants(null, pass, T0).next;
    const out = foldGateInvariants(first, breach, T0 + 15 * MIN);
    expect(out.transitions).toEqual([{ name: 'no-verdict-rate', from: 'pass', to: 'breach' }]);
    expect(out.next.invariants['no-verdict-rate']).toMatchObject({ status: 'breach', sinceMs: T0 + 15 * MIN, lastPassAtMs: T0 });
  });

  it('state survives the jsonb round trip, including when the driver hands back a string', () => {
    const next = foldGateInvariants(null, breach, T0).next;
    next.invariants['no-verdict-rate']!.filedItemId = 'WI-1';
    expect(parseGateInvariantsState(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(parseGateInvariantsState(JSON.stringify(next))).toEqual(next);
    expect(parseGateInvariantsState('{nope')).toBeNull();
  });
});
