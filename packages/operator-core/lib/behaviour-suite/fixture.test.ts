import { describe, it, expect } from 'vitest';
import {
  buildFixturePlan,
  fixtureExpectedWorkItemIds,
  mintFixture,
  teardownFixture,
  FIXTURE_ITEMS,
  FIXTURE_SLUG_PREFIX,
  type FixtureIO,
  type FixturePlanSpec,
} from './fixture';

describe('behaviour-suite/fixture', () => {
  it('buildFixturePlan is deterministic and slug-stable for a date', () => {
    const a = buildFixturePlan('2026-07-03');
    const b = buildFixturePlan('2026-07-03');
    expect(a.slug).toBe(`${FIXTURE_SLUG_PREFIX}-2026-07-03`);
    expect(a).toEqual(b);
    expect(a.items.length).toBe(FIXTURE_ITEMS.length);
    expect(buildFixturePlan('2026-07-04').slug).not.toBe(a.slug);
  });

  it('fixtureExpectedWorkItemIds reflects the item ids (the scope boundary)', () => {
    const spec = buildFixturePlan('2026-07-03');
    expect(fixtureExpectedWorkItemIds(spec)).toEqual(['F-1', 'F-2']);
  });

  it('accepts a custom item set', () => {
    const spec = buildFixturePlan('2026-07-03', [{ id: 'X-1', title: 't', acceptance: 'a' }]);
    expect(fixtureExpectedWorkItemIds(spec)).toEqual(['X-1']);
  });

  it('mintFixture drives createPlan → addItems → startPlan in order; teardown archives + drains', async () => {
    const calls: string[] = [];
    let addedItems = 0;
    const io: FixtureIO = {
      createPlan: async (s: FixturePlanSpec) => { calls.push(`create:${s.slug}`); return s.slug; },
      addItems: async (_slug, items) => { calls.push('addItems'); addedItems = items.length; },
      startPlan: async (slug) => { calls.push(`start:${slug}`); },
      archivePlan: async (slug) => { calls.push(`archive:${slug}`); },
      teardownFleet: async (f) => { calls.push(`teardownFleet:${f}`); },
    };
    const res = await mintFixture('2026-07-03', io);
    expect(res.slug).toBe(`${FIXTURE_SLUG_PREFIX}-2026-07-03`);
    expect(res.expectedWorkItemIds).toEqual(['F-1', 'F-2']);
    expect(addedItems).toBe(2);
    expect(calls).toEqual([
      `create:${FIXTURE_SLUG_PREFIX}-2026-07-03`,
      'addItems',
      `start:${FIXTURE_SLUG_PREFIX}-2026-07-03`,
    ]);

    await teardownFixture(res.slug, io, 'behaviour-fleet');
    expect(calls).toContain('teardownFleet:behaviour-fleet');
    expect(calls).toContain(`archive:${FIXTURE_SLUG_PREFIX}-2026-07-03`);
    // fleet drain happens BEFORE the plan archive
    expect(calls.indexOf('teardownFleet:behaviour-fleet')).toBeLessThan(calls.indexOf(`archive:${FIXTURE_SLUG_PREFIX}-2026-07-03`));
  });

  it('teardownFixture without a fleet just archives', async () => {
    const calls: string[] = [];
    const io: FixtureIO = {
      createPlan: async (s) => s.slug,
      addItems: async () => {},
      startPlan: async () => {},
      archivePlan: async (slug) => { calls.push(`archive:${slug}`); },
    };
    await teardownFixture('behaviour-fixture-x', io);
    expect(calls).toEqual(['archive:behaviour-fixture-x']);
  });
});
