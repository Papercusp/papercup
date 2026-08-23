/**
 * Plan gate-resilience-vs-torn-git-sync-sweeps..., P-003 final clause (D-002).
 *
 * `buildTornSweepAnnouncement` is pure, so these tests need no DB and no mocks — the same
 * reason `classifyGateStallStatus` / `gateStallRecordOnlyLogMessage` are exported from
 * release-actions.ts rather than living inside the writer.
 *
 * What is being pinned here is mostly what must NOT be announced. The streak-carry is the
 * correctness-bearing half and already ships; this announcement exists to make torn sweeps
 * OBSERVABLE, and an announcement that fires on the wrong tick is worse than none — it would
 * attribute a git-sync tear to a run that never proved one.
 */

import { describe, expect, it } from 'vitest';
import { buildTornSweepAnnouncement } from './release-actions';

const CANDIDATE = '1a9e8a1f0000000000000000000000000000abcd';
const TIP = '9f7c3d2e1111111111111111111111111111beef';

function stale(tip: string | null = TIP) {
  return { classification: 'stale-candidate' as const, tip };
}

describe('buildTornSweepAnnouncement — when it announces', () => {
  it('announces a proven torn sweep with the files and the healing sha range', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      failingTests: ['a/one.test.ts', 'b/two.test.ts'],
      retriage: stale(),
      runId: 'run-7',
    });

    expect(a).not.toBeNull();
    expect(a!.keys).toEqual([
      'green-checkpoint:torn-sweep',
      'green-checkpoint:torn-sweep:papercusp',
    ]);
    expect(a!.payload).toMatchObject({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      tip: TIP,
      shaRange: '1a9e8a1f0000..9f7c3d2e1111',
      fileCount: 2,
      classification: 'stale-candidate',
      streakAdvanced: false,
      runId: 'run-7',
    });
    expect(a!.payload.failingTests).toEqual(['a/one.test.ts', 'b/two.test.ts']);
  });

  it('names the files in the summary and says the streak was not advanced', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      failingTests: ['a/one.test.ts'],
      retriage: stale(),
    });
    expect(a!.summary).toMatch(/TORN SWEEP/);
    expect(a!.summary).toMatch(/a\/one\.test\.ts/);
    expect(a!.summary).toMatch(/streak was NOT advanced/);
    // The operator-facing point: do not go fix these files without re-verifying.
    expect(a!.summary).toMatch(/re-verifying at tip/);
  });

  it('caps the named files in the summary but keeps the full list in the payload', () => {
    const files = ['f1.test.ts', 'f2.test.ts', 'f3.test.ts', 'f4.test.ts', 'f5.test.ts'];
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      failingTests: files,
      retriage: stale(),
    });
    expect(a!.summary).toMatch(/\+2 more/);
    expect(a!.payload.failingTests).toEqual(files);
    expect(a!.payload.fileCount).toBe(5);
  });

  it('scopes the second key to the install so one harness cannot read another harness as news', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'sidestage',
      candidate: CANDIDATE,
      failingTests: ['x.test.ts'],
      retriage: stale(),
    });
    expect(a!.keys[1]).toBe('green-checkpoint:torn-sweep:sidestage');
    expect(a!.summary).toMatch(/^\[sidestage\]/);
  });
});

describe('buildTornSweepAnnouncement — when it stays silent', () => {
  it('does NOT announce a real red', () => {
    expect(
      buildTornSweepAnnouncement({
        installSlug: 'papercusp',
        candidate: CANDIDATE,
        failingTests: ['a.test.ts'],
        retriage: { classification: 'real-red', tip: TIP },
      }),
    ).toBeNull();
  });

  it('does NOT announce an unknown classification — an unmeasured red is not a torn sweep', () => {
    expect(
      buildTornSweepAnnouncement({
        installSlug: 'papercusp',
        candidate: CANDIDATE,
        failingTests: ['a.test.ts'],
        retriage: { classification: 'unknown', tip: TIP },
      }),
    ).toBeNull();
  });

  it('does NOT announce when there was no re-triage at all', () => {
    for (const retriage of [undefined, null, {}]) {
      expect(
        buildTornSweepAnnouncement({
          installSlug: 'papercusp',
          candidate: CANDIDATE,
          failingTests: ['a.test.ts'],
          retriage: retriage as never,
        }),
      ).toBeNull();
    }
  });
});

describe('buildTornSweepAnnouncement — an unknown bound is reported as unknown', () => {
  it('reports shaRange null rather than a half-range when the tip is missing', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      failingTests: ['a.test.ts'],
      retriage: stale(null),
    });
    // Still announced — the torn sweep IS the news — but the range it could not
    // measure must not be rendered as though it had been.
    expect(a).not.toBeNull();
    expect(a!.payload.shaRange).toBeNull();
    expect(a!.payload.tip).toBeNull();
    expect(a!.summary).toMatch(/tip unknown/);
    expect(a!.summary).not.toMatch(/healed within/);
  });

  it('reports shaRange null when the candidate is missing', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: null,
      failingTests: ['a.test.ts'],
      retriage: stale(),
    });
    expect(a!.payload.shaRange).toBeNull();
    expect(a!.summary).toMatch(/an unknown candidate/);
  });

  it('survives a torn sweep that named no files, without inventing any', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      failingTests: [],
      retriage: stale(),
    });
    expect(a).not.toBeNull();
    expect(a!.payload.fileCount).toBe(0);
    expect(a!.payload.failingTests).toEqual([]);
    expect(a!.summary).toMatch(/no named files/);
  });

  it('drops empty/non-string entries rather than emitting them as files', () => {
    const a = buildTornSweepAnnouncement({
      installSlug: 'papercusp',
      candidate: CANDIDATE,
      failingTests: ['real.test.ts', '', null as never, undefined as never],
      retriage: stale(),
    });
    expect(a!.payload.failingTests).toEqual(['real.test.ts']);
    expect(a!.payload.fileCount).toBe(1);
  });
});
