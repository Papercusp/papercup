import { describe, expect, it } from 'vitest';
import {
  PHASE_J_FAULT_SCHEMA,
  PHASE_J_FAULT_SQLSTATE,
  PHASE_J_FAULT_TABLE,
  PHASE_J_INPUT_SCHEMA,
  PHASE_J_MAX_OUTAGE_MS,
  PHASE_J_OBSERVATION_SCHEMA,
  phaseJContentSha256,
  phaseJFaultMessage,
  phaseJFaultName,
  phaseJLag,
  phaseJWriteSummary,
  phaseJWriteTitle,
  validatePhysicalPhaseJ,
  type PhaseJCursorRow,
  type PhaseJRow,
  type PhysicalPhaseJFault,
  type PhysicalPhaseJInput,
  type PhysicalPhaseJObservation,
  type PhysicalPhaseJStep,
  type PhysicalPhaseJWrite,
} from './physical-drill-phase-j';

const RUN = 'p505-physical-20260930T010000Z-4242';
const TOWER = Buffer.alloc(32, 1).toString('base64');
const VM = Buffer.alloc(32, 2).toString('base64');
const LOG = 'ab'.repeat(32);
const HELD_AT = 57;
const T0 = Date.parse('2026-09-30T01:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const IDS: Record<PhysicalPhaseJWrite, string> = { A: 'EI-101', B: 'EI-102' };

function row(write: PhysicalPhaseJWrite, author = TOWER): PhaseJRow {
  const base = { featureId: IDS[write], harnessSlug: 'hello-world-3-pot', kind: 'task', title: phaseJWriteTitle(RUN, write), summary: phaseJWriteSummary(RUN, write) };
  return { ...base, authorPubkey: author, origin: author === TOWER ? 'remote' : 'local', contentSha256: phaseJContentSha256(base) };
}

function heldCursor(attempts: number, overrides: Partial<PhaseJCursorRow> = {}): PhaseJCursorRow {
  return {
    harnessSlug: 'hello-world-3-pot', logKeyHex: LOG, position: HELD_AT, peerDevicePubkey: TOWER, updatedAt: at(60),
    applyFailure: {
      position: HELD_AT, kind: 'retryable', groupKey: `engineer-issues::hello-world-3-pot/${IDS.A}`,
      reason: phaseJFaultMessage(RUN), errorCode: PHASE_J_FAULT_SQLSTATE, attempts, firstSeenAt: T0 + 10_000, lastSeenAt: T0 + 70_000,
    },
    ...overrides,
  };
}

function obs(host: 'tower' | 'vm', step: PhysicalPhaseJStep, s: number, parts: Partial<PhysicalPhaseJObservation> = {}): PhysicalPhaseJObservation {
  return {
    schemaVersion: PHASE_J_OBSERVATION_SCHEMA, hostId: host, step, runId: RUN, observedAt: at(s), observerPid: 900,
    writes: { A: { count: 0, row: null }, B: { count: 0, row: null } }, cursors: [], faultPresent: false, ...parts,
  };
}

function fault(action: 'install' | 'remove', s: number): PhysicalPhaseJFault {
  return {
    schemaVersion: PHASE_J_FAULT_SCHEMA, hostId: 'vm', runId: RUN, action, name: phaseJFaultName(RUN),
    table: PHASE_J_FAULT_TABLE, sqlstate: PHASE_J_FAULT_SQLSTATE, matchTitle: phaseJWriteTitle(RUN, 'A'),
    at: at(s), presentAfter: action === 'install', presentBefore: action === 'remove',
  };
}

function valid(): PhysicalPhaseJInput {
  const both = (author?: string) => ({ A: { count: 1, row: row('A', author) }, B: { count: 1, row: row('B', author) } });
  return {
    schemaVersion: PHASE_J_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: at(0), finishedAt: at(300) },
    identities: { towerDeviceKey: TOWER, vmDeviceKey: VM },
    baseline: { tower: obs('tower', 'baseline', 1), vm: obs('vm', 'baseline', 1) },
    fault: { install: fault('install', 2), remove: fault('remove', 160) },
    authored: obs('tower', 'authored', 5, { writes: both(TOWER) }),
    held: [
      obs('vm', 'held', 40, { cursors: [heldCursor(3)], faultPresent: true }),
      obs('vm', 'held', 80, { cursors: [heldCursor(7)], faultPresent: true }),
    ],
    vmOwner: { before: { pid: 100, build: 'version:0.0.25', launcher: 'serve' }, after: { pid: 200, build: 'version:0.0.25', launcher: 'serve' } },
    heldAfterRestart: obs('vm', 'held-after-restart', 150, { cursors: [heldCursor(2)], faultPresent: true }),
    replayed: obs('vm', 'replayed', 200, { writes: both(TOWER), cursors: [{ ...heldCursor(0), position: 60, applyFailure: null }] }),
  };
}

function rejects(mutate: (input: PhysicalPhaseJInput) => void, message: RegExp): void {
  const input = valid();
  mutate(input);
  const verdict = validatePhysicalPhaseJ(input);
  expect(verdict.ok).toBe(false);
  expect(verdict.errors.join('\n')).toMatch(message);
}

describe('physical Phase J (P-521 F4) verifier', () => {
  it('accepts a complete outage, hold, restart and exact replay', () => {
    const verdict = validatePhysicalPhaseJ(valid());
    expect(verdict.errors).toEqual([]);
    expect(verdict.result?.identities).toEqual({
      logKeyHex: LOG, heldPosition: HELD_AT, attemptsBeforeRestart: 7, outageMs: 158_000,
      featureIds: IDS, writeBMaterializedDuringHold: false,
    });
  });

  it('rejects a cursor that advanced past the missing write in any held sample', () => {
    rejects((i) => { i.held[0]!.cursors[0]!.position = HELD_AT + 1; }, /advanced past the missing write/);
  });
  it('rejects a hold that never exceeded the retired retry budget', () => {
    rejects((i) => { i.held[1]!.cursors[0]!.applyFailure!.attempts = 5; }, /retired retry budget of 5/);
  });
  it('rejects a hold shorter than the minimum', () => {
    rejects((i) => { i.held[1]!.cursors[0]!.applyFailure!.firstSeenAt = T0 + 50_000; }, /hold lasted/);
  });
  it('rejects write A materializing under the fault', () => {
    rejects((i) => { i.held[0]!.writes.A = { count: 1, row: row('A') }; }, /materialized on the VM during the outage/);
  });
  it('rejects a failure that was not retryable, or not the fault', () => {
    rejects((i) => { i.held[1]!.cursors[0]!.applyFailure!.kind = 'rejected'; }, /not retryable/);
    rejects((i) => { i.held[1]!.cursors[0]!.applyFailure!.errorCode = '23503'; }, /not the fault's 57P03/);
  });
  it('rejects a sample taken without the fault in place', () => {
    rejects((i) => { i.held[0]!.faultPresent = false; }, /fault was not in place/);
  });
  it('rejects a restart that lost the durable failure, advanced the cursor, or never happened', () => {
    rejects((i) => { i.heldAfterRestart.cursors[0]!.applyFailure = null; }, /held-after-restart: durable apply_failure does not name write A/);
    rejects((i) => { i.heldAfterRestart.cursors[0]!.position = HELD_AT + 3; }, /held-after-restart: cursor .* advanced past/);
    rejects((i) => { i.vmOwner.after.pid = i.vmOwner.before.pid; }, /not restarted on the same artifact/);
    rejects((i) => { i.vmOwner.after.build = 'version:0.0.26'; }, /not restarted on the same artifact/);
  });
  it('rejects a replay that is not the exact tower write', () => {
    rejects((i) => {
      const r = i.replayed.writes.A.row!;
      r.summary = `${r.summary} (edited)`;
      r.contentSha256 = phaseJContentSha256(r);
    }, /write A is not the tower's exact write/);
    rejects((i) => { i.replayed.writes.B = { count: 0, row: null }; }, /write B did not arrive/);
    rejects((i) => { i.replayed.writes.A.row!.authorPubkey = VM; }, /no remote author provenance/);
  });
  it('rejects a cursor that did not advance, or a failure that was not cleared, after replay', () => {
    rejects((i) => { i.replayed.cursors[0]!.position = HELD_AT; }, /did not advance past the replayed write/);
    rejects((i) => { i.replayed.cursors[0]!.applyFailure = heldCursor(9).applyFailure; }, /was not cleared/);
    rejects((i) => { i.replayed.faultPresent = true; }, /still installed/);
  });
  it('rejects an unbounded outage and out-of-order evidence', () => {
    rejects((i) => {
      i.fault.remove.at = new Date(Date.parse(i.fault.install.at) + PHASE_J_MAX_OUTAGE_MS + 1).toISOString();
      i.replayed.observedAt = at(2000);
      i.window.finishedAt = at(3000);
    }, /is not bounded/);
    rejects((i) => { i.fault.remove.at = at(120); }, /causal order/);
    rejects((i) => { i.fault.install.at = at(6); }, /causal order/);
  });
  it('rejects a baseline that already had a write or a fault, and a foreign fault identity', () => {
    rejects((i) => { i.baseline.vm.writes.A = { count: 1, row: row('A') }; }, /baseline vm: write A already exists/);
    rejects((i) => { i.baseline.vm.faultPresent = true; }, /already installed/);
    rejects((i) => { i.fault.install.matchTitle = phaseJWriteTitle(RUN, 'B'); }, /not this run's write-A outage/);
    rejects((i) => { i.fault.remove.presentAfter = true; }, /absent after/);
  });
  it('rejects authored rows that do not carry the run content or live outside the test hive', () => {
    rejects((i) => { i.authored.writes.A.row!.title = 'other'; }, /deterministic content/);
    rejects((i) => { i.authored.writes.B.row!.harnessSlug = 'papercusp'; }, /not in the test hive/);
    rejects((i) => { i.authored.writes.A.count = 2; }, /matched 2 rows/);
  });
  it('rejects a held log that belongs to a peer other than the tower', () => {
    rejects((i) => { i.held[1]!.cursors[0]!.peerDevicePubkey = VM; }, /not the tower/);
  });
});

describe('physical Phase J lag contract', () => {
  it('waits for attempts and hold time, and never waits on an impossible state', () => {
    const early = obs('vm', 'held', 40, { cursors: [heldCursor(3)], faultPresent: true });
    expect(phaseJLag(early, { featureIdA: IDS.A })).toEqual([
      'attempts 3 < 6', `held ${30_000}ms < 60000ms`,
    ]);
    expect(phaseJLag(obs('vm', 'held', 80, { cursors: [heldCursor(7)], faultPresent: true }), { featureIdA: IDS.A })).toEqual([]);
    expect(phaseJLag(obs('vm', 'held', 20), { featureIdA: IDS.A })).toEqual(['no durable apply_failure names write A yet']);
    // A materialized under the fault is not a lag: the verifier must see it.
    expect(phaseJLag(obs('vm', 'held', 20, { writes: { A: { count: 1, row: row('A') }, B: { count: 0, row: null } } }), { featureIdA: IDS.A })).toEqual([]);
  });
  it('waits for both writes, the cursor and the cleared failure after replay', () => {
    const replayed = valid().replayed;
    expect(phaseJLag(replayed, { featureIdA: IDS.A, logKeyHex: LOG, heldPosition: HELD_AT })).toEqual([]);
    const pending = obs('vm', 'replayed', 190, { cursors: [heldCursor(9)] });
    expect(phaseJLag(pending, { featureIdA: IDS.A, logKeyHex: LOG, heldPosition: HELD_AT })).toEqual([
      'write A has not arrived', 'write B has not arrived', `cursor ${HELD_AT} has not passed ${HELD_AT}`,
      'apply_failure for write A is not cleared',
    ]);
  });
});
