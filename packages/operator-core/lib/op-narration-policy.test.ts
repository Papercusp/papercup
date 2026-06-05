import { describe, it, expect } from 'vitest';
import {
  kickoffText,
  midText,
  completionText,
  midSchedule,
  OP_POLICIES,
} from './op-narration-policy';

describe('kickoffText', () => {
  it('replan with slug', () => {
    expect(kickoffText('replan', { slug: 'sheets' })).toBe('Replanning sheets.');
  });
  it('replan without slug', () => {
    expect(kickoffText('replan')).toBe('Replanning.');
  });
  it('supervisor is silent on slug (template ignores it)', () => {
    expect(kickoffText('supervisor', { slug: 'sheets' })).toBe('Running supervisor.');
  });
  it('cleanup', () => {
    expect(kickoffText('cleanup')).toBe('Cleaning up.');
  });
  it('provision', () => {
    expect(kickoffText('provision', { slug: 'demo' })).toBe('Provisioning demo.');
  });
  it('smokeTest is silent on kickoff', () => {
    expect(kickoffText('smokeTest')).toBeNull();
  });
  it('scan is silent on kickoff', () => {
    expect(kickoffText('scan')).toBeNull();
  });
});

describe('midText', () => {
  it('replan', () => expect(midText('replan', 0)).toBe('Still scoping.'));
  it('supervisor', () => expect(midText('supervisor', 0)).toBe('Still reviewing.'));
  it('cleanup', () => expect(midText('cleanup', 0)).toBe('Still pruning.'));
  it('provision first', () => expect(midText('provision', 0)).toBe('Still working.'));
  it('provision later', () => expect(midText('provision', 1)).toBe('Still going.'));
  it('smokeTest never fires mid', () => expect(midText('smokeTest', 0)).toBeNull());
});

describe('completionText — success', () => {
  it('replan with counts', () => {
    expect(completionText('replan', { outcome: 'ok', counts: { added: 3, deprecated: 2 } }))
      .toEqual({ text: 'Replan done — 3 added, 2 deprecated.', mode: 'default' });
  });
  it('replan without counts', () => {
    expect(completionText('replan', { outcome: 'ok' }))
      .toEqual({ text: 'Replan done.', mode: 'default' });
  });
  it('supervisor with reason as outcome', () => {
    expect(completionText('supervisor', { outcome: 'ok', reason: 'no findings' }))
      .toEqual({ text: 'Supervisor: no findings.', mode: 'default' });
  });
  it('cleanup with counts', () => {
    expect(completionText('cleanup', { outcome: 'ok', counts: { deprecated: 4 } }))
      .toEqual({ text: 'Cleanup done — 4 deprecated.', mode: 'default' });
  });
  it('provision', () => {
    expect(completionText('provision', { outcome: 'ok' }))
      .toEqual({ text: 'Provisioning complete.', mode: 'default' });
  });
  it('smokeTest', () => {
    expect(completionText('smokeTest', { outcome: 'ok' }))
      .toEqual({ text: 'Smoke test passed.', mode: 'default' });
  });
});

describe('completionText — failure', () => {
  it('uses sober mode + concrete reason', () => {
    expect(completionText('provision', { outcome: 'fail', reason: 'DNS timeout' }))
      .toEqual({ text: 'Provisioning failed: DNS timeout.', mode: 'sober' });
  });
  it('falls back to plain "failed." when no reason given', () => {
    expect(completionText('replan', { outcome: 'fail' }))
      .toEqual({ text: 'Replan failed.', mode: 'sober' });
  });
  it('smokeTest failure', () => {
    expect(completionText('smokeTest', { outcome: 'fail', reason: 'schema check' }))
      .toEqual({ text: 'Smoke test failed: schema check.', mode: 'sober' });
  });
});

describe('midSchedule', () => {
  it('replan: one mid update at +30s', () => {
    expect(midSchedule('replan', 0)).toEqual([30_000]);
  });
  it('provision: 4 mid updates at +60s, +120s, +180s, +240s', () => {
    expect(midSchedule('provision', 0)).toEqual([60_000, 120_000, 180_000, 240_000]);
  });
  it('smokeTest: no mid updates', () => {
    expect(midSchedule('smokeTest', 0)).toEqual([]);
  });
});

describe('cadence shapes from the §6b table', () => {
  it('7s op: kickoff fires + completion fires + no mid', () => {
    // Sim: op finishes before midFirstAt (30s for replan).
    const elapsed = 7_000;
    expect(elapsed < OP_POLICIES.replan.midFirstAt).toBe(true);
  });
  it('30s op: 1 mid would fire if op outlived midFirstAt', () => {
    const elapsed = 30_001;
    expect(elapsed >= OP_POLICIES.replan.midFirstAt).toBe(true);
  });
  it('120s op: still ≤ 1 mid for replan (cadence is 0)', () => {
    expect(OP_POLICIES.replan.midMaxFires).toBe(1);
    expect(OP_POLICIES.replan.midCadenceMs).toBe(0);
  });
  it('provision can fire up to 4 mid updates', () => {
    expect(OP_POLICIES.provision.midMaxFires).toBe(4);
    expect(OP_POLICIES.provision.midCadenceMs).toBe(60_000);
  });
});
