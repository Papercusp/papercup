import { describe, expect, it } from 'vitest';
import { AUTOMATIC_PARK_RECOVERY_POLICY, createParkRecoveryReceipt, expireParkRecovery,
  parkRecoveryCertificate, renewParkRecovery, validateParkRecoveryPolicy,
  selectParkRecoveryOwner, type ParkProgressEvidence, type ParkRecoveryPolicy } from './durable-park-recovery';

const MINUTE = 60_000;
const START = 1_000_000;
const admission = (policy?: ParkRecoveryPolicy) => createParkRecoveryReceipt({
  workspaceId: 'fixture-workspace', harness: 'fixture-harness', workItemId: 'WI-obligation',
  condition: { condition: 'All retained inputs qualified', trigger: 'fixture:inputs-ready', owner: 'su-custodian' },
  generation: 42, dependencyRefs: ['WI-dependency'], admittedAtMs: START, policy,
  baseline: [{ kind: 'checkpoint', subjectRef: 'WI-dependency', sequence: 10,
    persistedAtMs: START - 1, evidenceRef: 'checkpoint:10' }],
});

describe('accountable recovery-action election (PARK-RECOVERY / PARK-SAFETY)', () => {
  it('prefers the current live custodian, retains a live successor and excludes dead/unknown targets', () => {
    const states = new Map([['custodian', 'live' as const], ['incumbent', 'parked' as const],
      ['dead', 'ended' as const], ['successor', 'live' as const], ['recorded', 'recorded' as const]]);
    const facts = { states, successors: ['dead', 'recorded', 'unknown', 'successor'] };
    expect(selectParkRecoveryOwner('custodian', 'incumbent', facts)).toBe('custodian');
    expect(selectParkRecoveryOwner('dead', 'incumbent', facts)).toBe('incumbent');
    expect(selectParkRecoveryOwner('dead', 'dead', facts)).toBe('successor');
    expect(selectParkRecoveryOwner('dead', null, { states, successors: ['unknown', 'recorded'] })).toBeNull();
  });
});
const progress = (overrides: Partial<ParkProgressEvidence> = {}): ParkProgressEvidence => ({
  kind: 'checkpoint', subjectRef: 'WI-dependency', sequence: 11,
  persistedAtMs: START + MINUTE, evidenceRef: 'checkpoint:11', ...overrides,
});

describe('automatic park recovery policy prerequisite (PARK-PROGRESS)', () => {
  it('persists server-owned 30m / two 30m extensions / absolute 90m policy and scoped identity', () => {
    const receipt = admission();
    expect(receipt).toMatchObject({ state: 'waiting', extensions: 0,
      deadlineMs: START + 30 * MINUTE, absoluteDeadlineMs: START + 90 * MINUTE,
      policy: { initialMs: 30 * MINUTE, extensionMs: 30 * MINUTE, maxExtensions: 2, maxAgeMs: 90 * MINUTE } });
    expect(receipt.policy).not.toBe(AUTOMATIC_PARK_RECOVERY_POLICY);
    expect(admission().id).toBe(receipt.id);
    const { producer, details, verificationDeadlineMs } = parkRecoveryCertificate(receipt);
    expect(producer).toEqual({ kind: 'durable-park-recovery', id: receipt.id });
    expect(details?.parkRecovery).toBe(receipt);
    expect(verificationDeadlineMs).toBe(receipt.deadlineMs);
    expect(details?.nextCheckAtMs).toBe(START + MINUTE);
    expect(parkRecoveryCertificate(receipt, receipt.deadlineMs - 1).details?.nextCheckAtMs).toBe(receipt.deadlineMs);
  });

  it('preserves the canonical empty physical harness for operator-scoped obligations', () => {
    const receipt = admission();
    expect(createParkRecoveryReceipt({ ...receipt, harness: '', admittedAtMs: START }).harness).toBe('');
  });

  it.each([
    ['heartbeat', { kind: 'heartbeat' }],
    ['same producer, different obligation', { subjectRef: 'WI-other-task' }],
    ['pre-admission', { persistedAtMs: START - 1 }],
    ['at admission', { persistedAtMs: START }],
    ['future timestamp', { persistedAtMs: START + 2 * MINUTE }],
    ['replayed revision', { sequence: 10 }],
    ['regressing revision', { sequence: 9 }],
    ['non-numeric revision', { sequence: NaN }],
    ['missing evidence', { evidenceRef: '' }],
  ])('rejects %s without changing the admission', (_name, changes) => {
    const receipt = admission();
    const before = structuredClone(receipt);
    const result = renewParkRecovery(receipt, progress(changes as Partial<ParkProgressEvidence>), START + MINUTE);
    expect(result).toEqual({ accepted: false, receipt: before });
    expect(result.receipt).toBe(receipt);
    expect(receipt).toEqual(before);
  });

  it.each(['checkpoint', 'task', 'test', 'artifact', 'publication'] as const)(
    'accepts fresh durable %s evidence for the exact obligation or dependency', kind => {
      for (const subjectRef of ['WI-obligation', 'WI-dependency']) {
        const receipt = admission();
        const result = renewParkRecovery(receipt, progress({ kind, subjectRef }), START + MINUTE);
        expect(result.accepted).toBe(true);
        expect(result.receipt).toMatchObject({ id: receipt.id, deadlineMs: START + 60 * MINUTE, extensions: 1 });
        expect(receipt.extensions).toBe(0);
        expect(result.receipt.condition).toEqual(receipt.condition);
      }
    });

  it('consumes each revision once and rejects replay or nonmonotonic time', () => {
    const first = renewParkRecovery(admission(), progress(), START + MINUTE).receipt;
    for (const evidence of [progress(), progress({ sequence: 12 }),
      progress({ sequence: 12, persistedAtMs: START + 2 * MINUTE }),
      progress({ sequence: 10, persistedAtMs: START + 2 * MINUTE, evidenceRef: 'checkpoint:12' })]) {
      expect(renewParkRecovery(first, evidence, START + 2 * MINUTE)).toEqual({ accepted: false, receipt: first });
    }
    expect(renewParkRecovery(first, progress({ sequence: 12, persistedAtMs: START + 2 * MINUTE,
      evidenceRef: 'checkpoint:12' }), START + 2 * MINUTE).accepted).toBe(true);
  });

  it('allows exactly two extensions then expires even if useful work continues', () => {
    const first = renewParkRecovery(admission(), progress(), START + MINUTE).receipt;
    const second = renewParkRecovery(first, progress({ sequence: 12, persistedAtMs: START + 2 * MINUTE,
      evidenceRef: 'checkpoint:12' }), START + 2 * MINUTE).receipt;
    expect(second).toMatchObject({ extensions: 2, deadlineMs: START + 90 * MINUTE });
    expect(renewParkRecovery(second, progress({ sequence: 13, persistedAtMs: START + 3 * MINUTE,
      evidenceRef: 'checkpoint:13' }), START + 3 * MINUTE)).toEqual({ accepted: false, receipt: second });
    expect(expireParkRecovery(second, START + 90 * MINUTE)).toMatchObject({ state: 'recovery', id: second.id });
  });

  it.each([-1, 0, 1])('gives expiry inclusive precedence at current deadline %+dms', offset => {
    const receipt = admission();
    const now = receipt.deadlineMs + offset;
    const evidence = progress({ persistedAtMs: now });
    const renewalFirst = renewParkRecovery(receipt, evidence, now);
    expect(renewalFirst.accepted).toBe(offset < 0);
    expect(expireParkRecovery(renewalFirst.receipt, now).state).toBe(offset < 0 ? 'waiting' : 'recovery');
    const timeoutFirst = expireParkRecovery(receipt, now);
    expect(renewParkRecovery(timeoutFirst, evidence, now).accepted).toBe(offset < 0);
    expect(renewParkRecovery(expireParkRecovery(receipt, receipt.deadlineMs), evidence, now).accepted).toBe(false);
  });

  it('caps a permitted extension at the absolute boundary and never consumes a third or replay count', () => {
    const receipt = admission({ initialMs: 40 * MINUTE, extensionMs: 40 * MINUTE,
      maxExtensions: 10, maxAgeMs: 90 * MINUTE });
    const first = renewParkRecovery(receipt, progress(), START + MINUTE).receipt;
    const evidence = progress({ sequence: 12, persistedAtMs: START + 79 * MINUTE, evidenceRef: 'checkpoint:12' });
    const second = renewParkRecovery(first, evidence, START + 79 * MINUTE).receipt;
    expect(second).toMatchObject({ deadlineMs: START + 90 * MINUTE, extensions: 2 });
    expect(renewParkRecovery(second, evidence, START + 79 * MINUTE)).toEqual({ accepted: false, receipt: second });
    for (const offset of [-1, 0, 1]) {
      const now = second.absoluteDeadlineMs + offset;
      expect(renewParkRecovery(second, progress({ sequence: 13, persistedAtMs: now,
        evidenceRef: 'checkpoint:13' }), now)).toEqual({ accepted: false, receipt: second });
      expect(expireParkRecovery(second, now).state).toBe(offset < 0 ? 'waiting' : 'recovery');
    }
  });

  it('retains the same terminal decision and identity across serialized replay', () => {
    const receipt = expireParkRecovery(admission(), START + 30 * MINUTE);
    const reopened = JSON.parse(JSON.stringify(receipt));
    expect(expireParkRecovery(reopened, START + 31 * MINUTE)).toEqual(receipt);
    expect(renewParkRecovery(reopened, progress({ sequence: 15, persistedAtMs: START + 31 * MINUTE,
      evidenceRef: 'checkpoint:15' }), START + 31 * MINUTE)).toEqual({ accepted: false, receipt });
    const retired = { ...receipt, state: 'retired' as const };
    expect(expireParkRecovery(retired, START + 90 * MINUTE)).toBe(retired);
  });

  it.each([NaN, Infinity, 0, -1, 0.5])('refuses invalid persisted policy interval %s', initialMs => {
    expect(() => validateParkRecoveryPolicy({ ...AUTOMATIC_PARK_RECOVERY_POLICY, initialMs })).toThrow();
  });

  it('rejects unbounded counts, impossible intervals, timestamps and incomplete identities', () => {
    expect(() => admission({ ...AUTOMATIC_PARK_RECOVERY_POLICY, maxExtensions: Infinity })).toThrow();
    expect(() => admission({ ...AUTOMATIC_PARK_RECOVERY_POLICY, maxAgeMs: MINUTE })).toThrow();
    expect(() => createParkRecoveryReceipt({ ...admission(), admittedAtMs: NaN })).toThrow();
    expect(() => createParkRecoveryReceipt({ ...admission(), workspaceId: '' })).toThrow();
  });
});
