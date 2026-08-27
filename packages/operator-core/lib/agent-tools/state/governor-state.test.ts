import { describe, expect, it } from 'vitest';
import { buildGovernorStatePayload, unavailableGovernorStatePayload } from './governor-state';
import { buildGovernorStateSnapshot } from '../../resource-governor/state-snapshot';

describe('governor state resolver lens', () => {
  it('returns explicit unknowns on a missing/stale snapshot', async () => {
    await expect(buildGovernorStatePayload('ws', async () => null)).resolves.toEqual(unavailableGovernorStatePayload());
  });

  it('projects every detailed lens from the exact same canonical snapshot', async () => {
    const snapshot = buildGovernorStateSnapshot({
      observedAtMs: 1_000,
      validUntilMs: 2_000,
      queueByClass: [],
      recovery: { state: 'stable', completed: 0, total: 0, confidence: 1 },
    });
    const payload = await buildGovernorStatePayload('ws', async () => ({ payload: snapshot, computedAt: 1_000, ageMs: 5 }));
    expect(payload).toMatchObject({
      snapshot,
      health: snapshot.health,
      admission: snapshot.admission,
      queue: snapshot.queue,
      resources: snapshot.resources,
      recovery: snapshot.recovery,
      freshness: { ageMs: 5 },
    });
  });
});
