import { describe, expect, it } from 'vitest';
import { classifyExternalConditionReachability, readEventConditionReachability } from './external-condition-reachability';

const NOW = '2026-08-27T12:00:00.000Z';

describe('external condition reachability', () => {
  it('treats a fire latch as authoritative satisfaction', () => {
    expect(classifyExternalConditionReachability({ firedAt: '2026-08-27T11:00:00.000Z' }, NOW)).toMatchObject({
      verdict: 'reachable',
      basis: 'fired',
      authoritative: true,
    });
  });

  it('treats a live resolver as reachable', () => {
    expect(classifyExternalConditionReachability({ liveResolver: true }, NOW)).toMatchObject({
      verdict: 'reachable',
      basis: 'live-resolver',
      authoritative: true,
    });
  });

  it.each([
    ['cancelled', 'cancelled-registration'],
    ['expired', 'expired-registration'],
  ] as const)('uses authoritative %s producer registration evidence', (registration, basis) => {
    expect(classifyExternalConditionReachability({ registration }, NOW)).toMatchObject({
      verdict: 'impossible',
      basis,
      authoritative: true,
    });
  });

  it('keeps missing registration unknown regardless of condition age', () => {
    const recent = classifyExternalConditionReachability({ registration: 'missing' }, NOW);
    const muchLater = classifyExternalConditionReachability({ registration: 'missing' }, '2036-08-27T12:00:00.000Z');
    expect(recent).toMatchObject({ verdict: 'unknown', basis: 'missing-registration', authoritative: false });
    expect(muchLater.verdict).toBe('unknown');
  });

  it('uses an announcement fire when the unconditional latch is unavailable', async () => {
    const reachability = await readEventConditionReachability('fleet:test:gate', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [{ firedAt: '2026-08-27T11:30:00.000Z', supersededAt: null }] as never,
        waiters: [],
        deliveries: [],
        fireLatch: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'fired', authoritative: true });
  });

  it('does not treat a cancelled consumer await as a cancelled producer registration', async () => {
    const reachability = await readEventConditionReachability('invented:key', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [],
        waiters: [{ cancelledAt: '2026-08-27T11:30:00.000Z' }] as never,
        deliveries: [],
        fireLatch: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration' });
  });
});
