import { describe, expect, it } from 'vitest';
import {
  appendCanaryObservation,
  canarySoakStartRefusals,
  capturePostGoCanaryObservation,
  validatePostGoCanaryEvidence,
  type CanarySamplerDeps,
  type PostGoCanaryEvidence,
  type PostGoCanaryObservation,
} from './post-go-canary-observations';

const HIVE = 'hello-world-3-pot';
const HEAD = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const START = '2026-08-10T20:00:00.000Z';
const FINISH = '2026-08-13T20:00:00.000Z';
const EVALUATED = '2026-08-13T21:01:00.000Z';
const WINDOW = { startedAt: START, finishedAt: FINISH };

function sample(hour: number, over: Partial<PostGoCanaryObservation> = {}): PostGoCanaryObservation {
  const at = new Date(Date.parse(START) + hour * 3_600_000).toISOString();
  return {
    at,
    hive: HIVE,
    active: true,
    lastFiredAt: at,
    lastStatus: 'ok',
    watchdogAlerted: false,
    eligibilityAlerted: false,
    bridgeRan: true,
    bridgeSkipped: null,
    divergence: 'clear',
    needsOwner: false,
    bridgeErrors: [],
    egressTarget: 'fork',
    egressHead: HEAD,
    forkHead: HEAD,
    openEscalations: 0,
    ...over,
  };
}

function evidence(): PostGoCanaryEvidence {
  return {
    hive: HIVE,
    routineIntervalSec: 300,
    observations: Array.from({ length: 73 }, (_, hour) => sample(hour)),
    alarms: [],
    alarmRail: {
      divergenceNotifiesUrgent: true,
      stallWatchdogNotifiesUrgent: true,
      deliveredPageAt: '2026-08-12T09:00:00.000Z',
      deliveredPageRef: 'attention_notifications:real-page',
    },
  };
}

function errorsWith(mutate: (e: PostGoCanaryEvidence) => void, evaluatedAt = EVALUATED): string[] {
  const e = evidence();
  mutate(e);
  return validatePostGoCanaryEvidence(e, WINDOW, evaluatedAt);
}

describe('P-501 canary evidence predicates (WI-10002545)', () => {
  it('accepts a quiet, hourly, fully covered soak', () => {
    expect(validatePostGoCanaryEvidence(evidence(), WINDOW, EVALUATED)).toEqual([]);
  });

  it('rejects missing evidence outright', () => {
    expect(validatePostGoCanaryEvidence(undefined, WINDOW, EVALUATED)).toHaveLength(1);
  });

  describe('coverage', () => {
    it('rejects a gap longer than one hour', () => {
      const errors = errorsWith((e) => e.observations.splice(30, 2));
      expect(errors.some((m) => m.includes('gap over 1 hour'))).toBe(true);
    });

    it('rejects a soak whose sampling starts late or stops early', () => {
      const late = errorsWith((e) => e.observations.splice(0, 2));
      expect(late).toContain('the first observation must be taken within 1 hour of the canary start');
      const early = errorsWith((e) => e.observations.splice(71, 2));
      expect(early).toContain('the last observation must be taken within 1 hour of the canary finish');
    });

    it('rejects a sample outside the window or from another hive', () => {
      const errors = errorsWith((e) => {
        e.observations[5] = { ...e.observations[5]!, hive: 'hive-canary' };
        e.observations.push(sample(80));
      });
      expect(errors.some((m) => m.includes('observes hive-canary'))).toBe(true);
      expect(errors.some((m) => m.includes('outside the canary window'))).toBe(true);
    });
  });

  it('C1: rejects divergence, a needs-owner bridge and bridge errors', () => {
    const errors = errorsWith((e) => {
      e.observations[10] = sample(10, { divergence: 'diverged' });
      e.observations[11] = sample(11, { needsOwner: true });
      e.observations[12] = sample(12, { bridgeErrors: ['push rejected'] });
    });
    expect(errors.filter((m) => m.startsWith('C1:'))).toHaveLength(3);
  });

  it('C2: rejects any open escalation on the canary hive', () => {
    const errors = errorsWith((e) => { e.observations[20] = sample(20, { openEscalations: 2 }); });
    expect(errors).toEqual([expect.stringMatching(/^C2: .* 2 open escalation/)]);
  });

  it('C3: rejects a false alarm and an un-adjudicated page in the window, ignores pages outside it', () => {
    const errors = errorsWith((e) => {
      e.alarms = [
        { createdAt: '2026-08-11T03:00:00.000Z', title: 'git-sync STALLED', adjudication: 'false-alarm', ref: 'x' },
        { createdAt: '2026-08-11T04:00:00.000Z', title: 'bridge divergence' },
        { createdAt: '2026-08-01T04:00:00.000Z', title: 'git-sync STALLED', adjudication: 'false-alarm' },
      ];
    });
    expect(errors.filter((m) => m.startsWith('C3:'))).toHaveLength(2);
  });

  describe('C4 commit loop health', () => {
    it('rejects a true-positive page, an alerted watchdog and an inactive routine', () => {
      const errors = errorsWith((e) => {
        e.alarms = [{ createdAt: '2026-08-11T03:00:00.000Z', title: 'git-sync STALLED', adjudication: 'true-positive' }];
        e.observations[3] = sample(3, { watchdogAlerted: true });
        e.observations[4] = sample(4, { active: false });
      });
      expect(errors.filter((m) => m.startsWith('C4:'))).toHaveLength(3);
    });

    it('rejects a last fire older than 3x the routine interval', () => {
      const errors = errorsWith((e) => {
        e.observations[7] = sample(7, { lastFiredAt: new Date(Date.parse(START) + 7 * 3_600_000 - 16 * 60_000).toISOString() });
      });
      expect(errors).toEqual([expect.stringMatching(/^C4: .* older than 3x/)]);
    });

    it('tolerates one error status but rejects two consecutive', () => {
      expect(errorsWith((e) => { e.observations[9] = sample(9, { lastStatus: 'error' }); })).toEqual([]);
      const errors = errorsWith((e) => {
        e.observations[9] = sample(9, { lastStatus: 'error' });
        e.observations[10] = sample(10, { lastStatus: 'quarantined' });
      });
      expect(errors).toEqual([expect.stringMatching(/^C4: .* two consecutive/)]);
    });
  });

  describe('C5 fork current via real egress', () => {
    it('rejects a sample whose egress regressed to a skip (D-044)', () => {
      const errors = errorsWith((e) => {
        e.observations[15] = sample(15, { bridgeRan: false, bridgeSkipped: 'no_github_remote', egressTarget: 'skipped', egressHead: null });
      });
      expect(errors).toEqual([expect.stringMatching(/^C5: .* egress is not real/)]);
    });

    it('allows the fork to lag for one sample but not two in a row, nor at the final sample', () => {
      expect(errorsWith((e) => { e.observations[20] = sample(20, { forkHead: OTHER }); })).toEqual([]);
      const twice = errorsWith((e) => {
        e.observations[20] = sample(20, { forkHead: OTHER });
        e.observations[21] = sample(21, { forkHead: OTHER });
      });
      expect(twice).toEqual([expect.stringMatching(/^C5: .* a sample later/)]);
      const last = errorsWith((e) => { e.observations[72] = sample(72, { forkHead: OTHER }); });
      expect(last).toEqual(['C5: the fork head differs from the egress head at the final observation']);
    });
  });

  it('C6: rejects an un-wired alarm source and a stale or missing delivered page', () => {
    const errors = errorsWith((e) => {
      e.alarmRail = { ...e.alarmRail, stallWatchdogNotifiesUrgent: false, deliveredPageAt: '2026-07-01T00:00:00.000Z', deliveredPageRef: '' };
    });
    expect(errors.filter((m) => m.startsWith('C6:'))).toHaveLength(3);
  });
});

describe('P-501 soak start (D-044)', () => {
  it('refuses to start on a hive whose bridge egress is skipped', () => {
    const skipped = sample(0, { bridgeRan: false, bridgeSkipped: 'no_github_remote', egressTarget: 'skipped', egressHead: null });
    expect(canarySoakStartRefusals(skipped).length).toBeGreaterThan(0);
    expect(() => appendCanaryObservation([], skipped)).toThrow(/cannot start: bridge did not run \(skipped: no_github_remote\)/);
  });

  it('starts on a real egress, then keeps appending even through a bad hour (the verifier judges it)', () => {
    const first = appendCanaryObservation([], sample(0));
    const next = appendCanaryObservation(first, sample(1, { divergence: 'diverged' }));
    expect(next).toHaveLength(2);
  });

  it('refuses to mix hives in one soak', () => {
    expect(() => appendCanaryObservation([sample(0)], sample(1, { hive: 'hive-canary' }))).toThrow(/cannot join/);
  });
});

describe('capturePostGoCanaryObservation', () => {
  function fakeSql(results: unknown[][]): NonNullable<CanarySamplerDeps['sql']> {
    const queue = [...results];
    return ((..._args: unknown[]) => Promise.resolve(queue.shift() ?? [])) as unknown as NonNullable<CanarySamplerDeps['sql']>;
  }

  it('reads the routine, bridge, escalations and the fork head from ls-remote', async () => {
    const gitCalls: string[][] = [];
    const observation = await capturePostGoCanaryObservation(HIVE, {
      sql: fakeSql([
        [{
          active: true,
          last_fired_at: '2026-09-23T02:40:00.000Z',
          metadata: {
            last_status: 'ok',
            watchdog_alerted: false,
            github_bridge: { ran: true, divergence: 'clear', needs_owner: 'false', errors: [], egress_target: 'fork', egress_head: HEAD },
          },
        }],
        [{ open: '0' }],
      ]),
      loadRegistry: async () => ({ projects: [{ slug: HIVE, fork_remote: 'https://github.com/example/fork.git' }] }),
      runGit: async (args) => {
        gitCalls.push(args);
        return { code: 0, stdout: `${HEAD}\trefs/heads/staging\n`, stderr: '' };
      },
      now: () => new Date('2026-09-23T02:44:00.000Z'),
    });
    expect(gitCalls).toEqual([['ls-remote', '--refs', 'https://github.com/example/fork.git', 'refs/heads/staging']]);
    expect(observation).toMatchObject({
      at: '2026-09-23T02:44:00.000Z',
      hive: HIVE,
      bridgeRan: true,
      needsOwner: false,
      egressTarget: 'fork',
      egressHead: HEAD,
      forkHead: HEAD,
      openEscalations: 0,
    });
    expect(canarySoakStartRefusals(observation)).toEqual([]);
  });

  it('records a skipped bridge without touching any remote', async () => {
    let gitCalled = false;
    const observation = await capturePostGoCanaryObservation('hive-canary', {
      sql: fakeSql([
        [{ active: true, last_fired_at: null, metadata: { github_bridge: { ran: false, skipped: 'no_github_remote', egress_target: 'skipped' } } }],
        [{ open: 0 }],
      ]),
      runGit: async () => { gitCalled = true; return { code: 0, stdout: '', stderr: '' }; },
    });
    expect(gitCalled).toBe(false);
    expect(observation).toMatchObject({ bridgeRan: false, bridgeSkipped: 'no_github_remote', forkHead: null });
  });

  it('fails closed when the hive has no git-sync routine', async () => {
    await expect(capturePostGoCanaryObservation('nope', { sql: fakeSql([[]]) })).rejects.toThrow(/no git-sync routine/);
  });
});
