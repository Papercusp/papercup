import { describe, expect, it } from 'vitest';
import { admissionIdentity } from '../../harness/improvements/digest';
import {
  PHASE_J_MAX_OUTAGE_MS,
  PHASE_J_WRITES,
  phaseJContentSha256,
  phaseJLag,
  phaseJWriteTitle,
  validatePhysicalPhaseJ,
  type PhysicalPhaseJInput,
} from './physical-drill-phase-j';
import {
  PHASE_J_FIXTURE_FEATURE_IDS as IDS,
  PHASE_J_FIXTURE_HELD_POSITION as HELD_AT,
  PHASE_J_FIXTURE_LOG_KEY_HEX as LOG,
  phaseJFixture,
} from './physical-drill-phase-j.fixture';

const RUN = 'p505-physical-20260930T010000Z-4242';
const TOWER = Buffer.alloc(32, 1).toString('base64');
const VM = Buffer.alloc(32, 2).toString('base64');
const T0 = Date.parse('2026-09-30T01:00:00.000Z');
const fixture = phaseJFixture({ runId: RUN, towerDeviceKey: TOWER, vmDeviceKey: VM, startMs: T0 });
const { at, row, heldCursor, obs } = fixture;

function valid(): PhysicalPhaseJInput {
  return fixture.build();
}

function rejects(mutate: (input: PhysicalPhaseJInput) => void, message: RegExp): void {
  const input = valid();
  mutate(input);
  const verdict = validatePhysicalPhaseJ(input);
  expect(verdict.ok).toBe(false);
  expect(verdict.errors.join('\n')).toMatch(message);
}

// WI-10003961 rig attempt 2: admissionIdentity() drops single-letter tokens, so titles
// differing only in "A"/"B" shared one titleKey and the tower's unique index refused write B.
describe('physical Phase J write titles are admission-distinct', () => {
  it('gives every write its own admission titleKey', () => {
    const keys = PHASE_J_WRITES.map((w) => admissionIdentity(phaseJWriteTitle(RUN, w)).titleKey);
    expect(keys.every((k) => k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(PHASE_J_WRITES.length);
  });
  it('the letter-only form collides (calibration: the guard can fail)', () => {
    const letter = (w: string) => admissionIdentity(`P-521 F4 apply outage write ${w} ${RUN}`).titleKey;
    expect(letter('A')).toBe(letter('B'));
  });
});

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
