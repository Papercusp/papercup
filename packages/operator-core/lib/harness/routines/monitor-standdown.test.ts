/**
 * P-004 (anti-babysitting-monitor-enforcement-2026-08-25) — the SETTLEMENT half.
 *
 * These are the pure decisions the reconciler runs between "a monitor's wake settled"
 * and "re-arm it". Every case here is a behaviour the plan's D-002 §3/§4 names, and the
 * cheap ones to get subtly wrong: the default budget meaning EXACTLY one quiet wake,
 * a delta RESETTING rather than incrementing, authority outranking a healthy budget,
 * and an unreadable authority failing OPEN rather than killing a legitimate watch.
 */
import { describe, expect, it } from 'vitest';
import type { PersistedMonitorConfig } from './monitor-policy';
import {
  decideMonitorSettlement,
  monitorDeltaObservedForFire,
  readMonitorStanddownRecord,
  readPersistedMonitorConfig,
  readIdentifiedWaitForRoutine,
  type MonitorAuthorityRecheck,
} from './monitor-standdown';

const HELD: MonitorAuthorityRecheck = { ok: true };

describe('identified work and monitor waits', () => {
  it.each(['work', 'monitor'])('identifies the same dependency under the %s label', mode => {
    expect(readIdentifiedWaitForRoutine({ mode, workItem: 'WI-driver', blockedOn: { event: 'source:qualified' } }))
      .toEqual({ drivingWorkItemId: 'WI-driver', eventKey: 'source:qualified' });
  });
  it('keeps productive work, ambient inbox waits and prose out of the budget', () => {
    for (const payload of [{ workItem: 'WI-driver' }, { blockedOn: { event: 'source:qualified' } },
      { workItem: 'WI-driver', blockedOn: { reason: 'waiting for someone' } }]) {
      expect(readIdentifiedWaitForRoutine(payload)).toBeNull();
    }
  });
});

function config(overrides: Partial<PersistedMonitorConfig> = {}): PersistedMonitorConfig {
  return {
    predicateKey: 'release:green:papercusp',
    stopCondition: 'the exact green verdict is recorded',
    noDeltaBudget: 1,
    remainingNoDeltaBudget: 1,
    authority: { kind: 'work-item', workItem: 'WI-42' },
    ...overrides,
  };
}

describe('decideMonitorSettlement — no-delta budget', () => {
  it('DEFAULT budget 1 means exactly ONE quiet wake, then standdown', () => {
    const verdict = decideMonitorSettlement({ config: config(), deltaObserved: false, authority: HELD });
    expect(verdict).toMatchObject({
      action: 'standdown',
      code: 'no_delta_budget_exhausted',
      remainingNoDeltaBudget: 0,
    });
    // The reason must name the predicate AND the stop condition: an operator reading a
    // deactivated loop needs to know what it was watching and what would have ended it.
    expect(verdict.action === 'standdown' && verdict.reason).toContain('release:green:papercusp');
    expect(verdict.action === 'standdown' && verdict.reason).toContain('the exact green verdict is recorded');
  });

  it('an explicit budget decrements ONCE per quiet settled fire and ends at zero', () => {
    const budget = 3;
    let remaining = budget;
    const seen: Array<'rearm' | 'standdown'> = [];
    for (let i = 0; i < 3; i += 1) {
      const verdict = decideMonitorSettlement({
        config: config({ noDeltaBudget: budget, remainingNoDeltaBudget: remaining }),
        deltaObserved: false,
        authority: HELD,
      });
      seen.push(verdict.action);
      remaining = verdict.remainingNoDeltaBudget;
    }
    // Three quiet wakes on a budget of three: two survive, the third ends it.
    expect(seen).toEqual(['rearm', 'rearm', 'standdown']);
    expect(remaining).toBe(0);
  });

  it('a reported delta RESETS the budget to its configured value, not merely +1', () => {
    const verdict = decideMonitorSettlement({
      config: config({ noDeltaBudget: 5, remainingNoDeltaBudget: 1 }),
      deltaObserved: true,
      authority: HELD,
    });
    expect(verdict).toEqual({ action: 'rearm', remainingNoDeltaBudget: 5, deltaObserved: true });
  });

  it('a delta never grows the budget beyond its configured ceiling', () => {
    const verdict = decideMonitorSettlement({
      config: config({ noDeltaBudget: 2, remainingNoDeltaBudget: 2 }),
      deltaObserved: true,
      authority: HELD,
    });
    expect(verdict.remainingNoDeltaBudget).toBe(2);
  });
});

describe('decideMonitorSettlement — authority', () => {
  it('a lost authority stands the monitor down EVEN ON A WAKE THAT REPORTED A DELTA', () => {
    // The delta is exactly why this matters: work was observed, but it was duplicated
    // supervision of a live peer's item. A budget-first ordering would keep it alive
    // forever precisely while it is most wasteful.
    const verdict = decideMonitorSettlement({
      config: config({ noDeltaBudget: 10, remainingNoDeltaBudget: 10 }),
      deltaObserved: true,
      authority: {
        ok: false,
        code: 'monitor_peer_owned_progress',
        message: 'WI-42 is already owned and progressing under live peer su-peer.',
      },
    });
    expect(verdict).toMatchObject({
      action: 'standdown',
      code: 'authority_lost',
      authorityCode: 'monitor_peer_owned_progress',
    });
    expect(verdict.action === 'standdown' && verdict.reason).toContain('su-peer');
  });

  it('an UNREADABLE authority fails OPEN — the monitor survives and its budget still moves', () => {
    const verdict = decideMonitorSettlement({
      config: config({ noDeltaBudget: 3, remainingNoDeltaBudget: 3 }),
      deltaObserved: false,
      authority: { ok: 'unknown', message: 'connection terminated' },
    });
    // Not a standdown: a transient read failure must never manufacture one. The quiet
    // wake still costs a budget unit, so an unreadable authority cannot buy immortality.
    expect(verdict).toEqual({ action: 'rearm', remainingNoDeltaBudget: 2, deltaObserved: false });
  });

  it('an unreadable authority on the LAST budget unit still stands down on the budget', () => {
    const verdict = decideMonitorSettlement({
      config: config({ noDeltaBudget: 1, remainingNoDeltaBudget: 1 }),
      deltaObserved: false,
      authority: { ok: 'unknown', message: 'connection terminated' },
    });
    expect(verdict).toMatchObject({ action: 'standdown', code: 'no_delta_budget_exhausted' });
  });
});

/**
 * FALSIFIABILITY CONTROLS (repo rule: prove the guard CAN fail, without mutating the
 * shared tree). `monitor-standdown.ts` is an imported MODULE, so the sanctioned tier is a
 * deliberately-wrong implementation kept PERMANENTLY beside the real one — plus a
 * calibration the real subject must pass, or the controls would also "fail" when the
 * property itself is broken.
 *
 * The two controls are the two plausible wrong implementations, not arbitrary damage:
 * every reasonable author writes one of them.
 */
type Settle = typeof decideMonitorSettlement;

/** WRONG #1 — BUDGET-FIRST: evaluates the budget before the authority. */
const budgetFirst: Settle = ({ config: cfg, deltaObserved, authority }) => {
  if (deltaObserved) return { action: 'rearm', remainingNoDeltaBudget: cfg.noDeltaBudget, deltaObserved: true };
  const remaining = cfg.remainingNoDeltaBudget - 1;
  if (remaining <= 0) {
    return {
      action: 'standdown',
      code: 'no_delta_budget_exhausted',
      reason: 'budget',
      remainingNoDeltaBudget: 0,
    };
  }
  if (authority.ok === false) {
    return { action: 'standdown', code: 'authority_lost', reason: 'authority', remainingNoDeltaBudget: remaining };
  }
  return { action: 'rearm', remainingNoDeltaBudget: remaining, deltaObserved: false };
};

/** WRONG #2 — FAIL-CLOSED: treats an UNREADABLE authority as a lost one. */
const failClosed: Settle = (input) =>
  input.authority.ok === 'unknown'
    ? {
        action: 'standdown',
        code: 'authority_lost',
        reason: 'unreadable',
        remainingNoDeltaBudget: input.config.remainingNoDeltaBudget,
      }
    : decideMonitorSettlement(input);

describe('falsifiability controls — these cases must FAIL against a wrong implementation', () => {
  const authorityLostWithDelta = {
    config: config({ noDeltaBudget: 10, remainingNoDeltaBudget: 10 }),
    deltaObserved: true,
    authority: {
      ok: false as const,
      code: 'monitor_peer_owned_progress',
      message: 'WI-42 is already owned and progressing under live peer su-peer.',
    },
  };
  const unreadableAuthority = {
    config: config({ noDeltaBudget: 3, remainingNoDeltaBudget: 3 }),
    deltaObserved: false,
    authority: { ok: 'unknown' as const, message: 'connection terminated' },
  };

  it('CALIBRATION: the real implementation passes both discriminating cases', () => {
    expect(decideMonitorSettlement(authorityLostWithDelta).action).toBe('standdown');
    expect(decideMonitorSettlement(unreadableAuthority).action).toBe('rearm');
  });

  it('CAUGHT: budget-first ordering re-arms a monitor whose authority was lost', () => {
    // The exact regression this ordering exists to prevent — and the assertion above
    // genuinely discriminates it, rather than passing for both implementations.
    expect(budgetFirst(authorityLostWithDelta).action).toBe('rearm');
    expect(budgetFirst(authorityLostWithDelta).action).not.toBe(
      decideMonitorSettlement(authorityLostWithDelta).action,
    );
  });

  it('CAUGHT: a fail-CLOSED authority read kills a legitimate monitor on a transient error', () => {
    expect(failClosed(unreadableAuthority).action).toBe('standdown');
    expect(failClosed(unreadableAuthority).action).not.toBe(decideMonitorSettlement(unreadableAuthority).action);
  });

  it('the controls remain otherwise faithful, so a difference above is the DEFECT, not noise', () => {
    const ordinaryQuiet = {
      config: config({ noDeltaBudget: 3, remainingNoDeltaBudget: 3 }),
      deltaObserved: false,
      authority: HELD,
    };
    expect(budgetFirst(ordinaryQuiet)).toEqual(decideMonitorSettlement(ordinaryQuiet));
    expect(failClosed(ordinaryQuiet)).toEqual(decideMonitorSettlement(ordinaryQuiet));
  });
});

describe('monitorDeltaObservedForFire', () => {
  const FIRE = '2026-08-25T04:00:00.000Z';

  it('counts a delta stamped AFTER the fire being settled', () => {
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: '2026-08-25T04:00:01.000Z', lastFiredAt: FIRE })).toBe(true);
  });

  it('IGNORES a delta stamped before the fire — a stale marker cannot keep an idle monitor alive', () => {
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: '2026-08-25T03:59:59.000Z', lastFiredAt: FIRE })).toBe(false);
  });

  it('treats a missing marker as NO delta (omission and false are the same verdict)', () => {
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: null, lastFiredAt: FIRE })).toBe(false);
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: undefined, lastFiredAt: FIRE })).toBe(false);
  });

  it('treats an unparseable marker as NO delta rather than a truthy string', () => {
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: 'not-a-time', lastFiredAt: FIRE })).toBe(false);
  });

  it('accepts a Date as well as a string (the pooled connection returns either — EI-2549)', () => {
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: new Date(Date.parse(FIRE) + 1000), lastFiredAt: FIRE })).toBe(
      true,
    );
    expect(
      monitorDeltaObservedForFire({ monitorDeltaAt: new Date(Date.parse(FIRE) - 1000), lastFiredAt: new Date(FIRE) }),
    ).toBe(false);
  });

  it('a never-fired loop treats any delta as current', () => {
    expect(monitorDeltaObservedForFire({ monitorDeltaAt: FIRE, lastFiredAt: null })).toBe(true);
  });
});

describe('readPersistedMonitorConfig', () => {
  const valid = {
    predicateKey: 'release:green:papercusp',
    stopCondition: 'green recorded',
    noDeltaBudget: 2,
    remainingNoDeltaBudget: 2,
    authority: { kind: 'work-item', workItem: 'WI-42' },
  };

  it('parses a monitor loop payload', () => {
    expect(readPersistedMonitorConfig({ mode: 'monitor', monitor: valid })).toEqual(valid);
  });

  it('returns null for a WORK loop even when a stray monitor object is present', () => {
    // The mode is the gate: a work loop must take the unchanged re-arm path, so a
    // leftover monitor blob can never silently start enforcing a budget on it.
    expect(readPersistedMonitorConfig({ mode: 'work', monitor: valid })).toBeNull();
    expect(readPersistedMonitorConfig({ monitor: valid })).toBeNull();
  });

  it('returns null for a monitor loop armed before the policy existed', () => {
    expect(readPersistedMonitorConfig({ mode: 'monitor' })).toBeNull();
  });

  it('returns null for a malformed payload rather than throwing', () => {
    expect(readPersistedMonitorConfig(null)).toBeNull();
    expect(readPersistedMonitorConfig('monitor')).toBeNull();
    expect(readPersistedMonitorConfig([{ mode: 'monitor' }])).toBeNull();
    expect(readPersistedMonitorConfig({ mode: 'monitor', monitor: { predicateKey: 'x' } })).toBeNull();
  });
});

describe('readMonitorStanddownRecord', () => {
  it('parses the record the standdown write stores', () => {
    expect(
      readMonitorStanddownRecord({
        monitor_standdown: {
          code: 'no_delta_budget_exhausted',
          authorityCode: null,
          reason: 'one quiet wake',
          atMs: 1_756_000_000_000,
        },
      }),
    ).toEqual({
      code: 'no_delta_budget_exhausted',
      authorityCode: null,
      reason: 'one quiet wake',
      atMs: 1_756_000_000_000,
    });
  });

  it('keeps the authority code when the standdown was an authority loss', () => {
    expect(
      readMonitorStanddownRecord({
        monitor_standdown: { code: 'authority_lost', authorityCode: 'monitor_fleet_not_led', reason: 'r', atMs: 1 },
      })?.authorityCode,
    ).toBe('monitor_fleet_not_led');
  });

  it('returns null when the monitor never stood down, and for malformed records', () => {
    expect(readMonitorStanddownRecord({})).toBeNull();
    expect(readMonitorStanddownRecord(null)).toBeNull();
    expect(readMonitorStanddownRecord({ monitor_standdown: 'stood down' })).toBeNull();
    // A record without the two load-bearing strings is not a usable explanation, and
    // reporting a half-record would make `active:false` look explained when it is not.
    expect(readMonitorStanddownRecord({ monitor_standdown: { code: 'authority_lost' } })).toBeNull();
    expect(readMonitorStanddownRecord({ monitor_standdown: { reason: 'r' } })).toBeNull();
  });

  it('reports a non-numeric atMs as null rather than passing a string through', () => {
    expect(
      readMonitorStanddownRecord({ monitor_standdown: { code: 'c', reason: 'r', atMs: '1756000000000' } })?.atMs,
    ).toBeNull();
  });
});
