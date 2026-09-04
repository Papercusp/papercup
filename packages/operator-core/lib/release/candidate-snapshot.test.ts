import { describe, expect, it } from 'vitest';
import {
  buildCandidateSnapshot,
  candidateSnapshotFailureSignature,
  candidateSnapshotMatchesDispatch,
  isCandidateSnapshotFresh,
  parseCandidateSnapshot,
} from './candidate-snapshot';

describe('candidate snapshot', () => {
  const candidate = 'A'.repeat(40);
  const base = 'B'.repeat(40);

  it('builds and round-trips one bounded producer record', () => {
    const snapshot = buildCandidateSnapshot(
      {
        candidate,
        base,
        runId: 'checkpoint-run-1',
        source: 'pinned',
        selectedAtMs: 900,
        candidateCommittedAt: '2026-09-04T20:00:00.000Z',
        commitsBehindTip: 3,
        failingTests: ['b.test.ts', 'a.test.ts', 'a.test.ts'],
        failingTestsMeasured: true,
        postSuiteMeasured: true,
        postSuiteLegs: [
          { id: 'lint:tsc', status: 'passed', durationMs: 12.8 },
          { id: 'lint:deps', status: 'skipped', skipReason: 'not applicable' },
        ],
        repairQueue: {
          candidate,
          repairHead: 'C'.repeat(40),
          phase: 'awaiting-fixer',
          fixerSpawnId: 'fixer-1',
        },
        retriage: {
          classification: 'real-red',
          tip: 'D'.repeat(40),
        },
      },
      1_000,
    );

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      candidate,
      base,
      runId: 'checkpoint-run-1',
      source: 'pinned',
      observedAtMs: 1_000,
      selectedAtMs: 900,
      commitsBehindTip: 3,
      failureSignature: 'a.test.ts,b.test.ts',
      failingTests: ['b.test.ts', 'a.test.ts'],
      ownership: {
        kind: 'frozen-repair',
        frozenCandidate: candidate,
        repairHead: 'C'.repeat(40),
        phase: 'awaiting-fixer',
        fixerSpawnId: 'fixer-1',
      },
      supersession: {
        classification: 'real-red',
        tip: 'D'.repeat(40),
        repairHead: 'C'.repeat(40),
      },
    });
    expect(snapshot?.identity).toEqual(expect.any(String));
    expect(parseCandidateSnapshot(snapshot)).toEqual(snapshot);
  });

  it('fails closed when the persisted identity or schema is tampered', () => {
    const snapshot = buildCandidateSnapshot({ candidate }, 1_000);
    expect(snapshot).not.toBeNull();

    expect(parseCandidateSnapshot({ ...snapshot!, candidate: 'other' })).toBeNull();
    expect(parseCandidateSnapshot({ ...snapshot!, schemaVersion: 2 })).toBeNull();
    expect(parseCandidateSnapshot({ ...snapshot!, identity: '' })).toBeNull();
  });

  it('requires a fresh, candidate-and-failure matching snapshot for dispatch', () => {
    const snapshot = buildCandidateSnapshot(
      { candidate, failingTests: ['b.test.ts', 'a.test.ts'] },
      1_000,
    );
    expect(snapshot).not.toBeNull();

    expect(candidateSnapshotFailureSignature(['b.test.ts', 'a.test.ts'], candidate)).toBe('a.test.ts,b.test.ts');
    expect(isCandidateSnapshotFresh(snapshot, 1_050, 100)).toBe(true);
    expect(
      candidateSnapshotMatchesDispatch(snapshot, {
        candidate: candidate.slice(0, 12),
        failingTests: ['a.test.ts', 'b.test.ts'],
        nowMs: 1_050,
        maxAgeMs: 100,
      }),
    ).toBe(true);

    expect(
      candidateSnapshotMatchesDispatch(snapshot, {
        candidate,
        failingTests: ['a.test.ts', 'different.test.ts'],
        nowMs: 1_050,
        maxAgeMs: 100,
      }),
    ).toBe(false);
    expect(
      candidateSnapshotMatchesDispatch(snapshot, {
        candidate,
        failingTests: ['a.test.ts', 'b.test.ts'],
        nowMs: 1_101,
        maxAgeMs: 100,
      }),
    ).toBe(false);
  });
});
