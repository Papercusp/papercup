import { describe, expect, it } from 'vitest';
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';
import {
  buildLearningPotRail,
  isPotChipDormant,
  learningPotSlugs,
  partitionLearningPotRail,
} from './learning-pot-rail';

function gym(harnessSlug: string, enabled: boolean, spentUsd = 0): AutomationGymArm {
  return { harnessSlug, enabled, budgetUsd: null, spentUsd, status: 'idle' };
}

function lane(loopId: string, potSlug: string | null, enabled: boolean, spentUsd = 0): AutomationLaneArm {
  return {
    loopId,
    displayName: loopId,
    potSlug,
    enabled,
    budgetUsd: null,
    budgetKind: 'lifetime',
    spentUsd,
    enforcement: 'governor',
  };
}

function arming(over: Partial<AutomationArming> = {}): AutomationArming {
  return { gymPots: [], lanes: [], scoutCeiling: null, potScope: null, ...over };
}

const scope = (disabledPots: string[]): AutomationArming['potScope'] => ({ disabledPots, rows: [] });

describe('the fail-open rule (R-5) — an ABSENT row means ENABLED', () => {
  it('reports a pot with no scope row as learning, not as switched off', () => {
    const [chip] = buildLearningPotRail(
      arming({ gymPots: [gym('alpha', true)], potScope: scope([]) }),
    );
    expect(chip.learning).toBe('on');
  });

  it('reports only the pots named in disabledPots as off', () => {
    const rail = buildLearningPotRail(
      arming({ gymPots: [gym('alpha', true), gym('beta', true)], potScope: scope(['beta']) }),
    );
    const byPot = Object.fromEntries(rail.map((c) => [c.potSlug, c.learning]));
    expect(byPot).toEqual({ alpha: 'on', beta: 'off' });
  });

  /**
   * CONTROL for the inversion. If the module ever asked "is it in an ENABLED
   * list?" instead of "is it absent from disabledPots?", an empty scope would
   * turn every pot off — the exact catastrophe the catalog comment warns about.
   */
  it('an EMPTY scope means every pot is learning, never every pot off', () => {
    const rail = buildLearningPotRail(
      arming({ gymPots: [gym('a', true), gym('b', true), gym('c', true)], potScope: scope([]) }),
    );
    expect(rail.map((c) => c.learning)).toEqual(['on', 'on', 'on']);
  });
});

describe('null potScope is UNREADABLE, not an empty scope', () => {
  it('maps a null scope to unknown rather than on', () => {
    const [chip] = buildLearningPotRail(arming({ gymPots: [gym('alpha', true)], potScope: null }));
    expect(chip.learning).toBe('unknown');
    expect(chip.learning).not.toBe('on');
  });

  it('distinguishes null from an empty scope — the two must not agree', () => {
    const unread = buildLearningPotRail(arming({ gymPots: [gym('a', true)], potScope: null }))[0];
    const empty = buildLearningPotRail(arming({ gymPots: [gym('a', true)], potScope: scope([]) }))[0];
    expect(unread.learning).not.toBe(empty.learning);
  });

  it('propagates unknown into the scout segment instead of guessing', () => {
    const [chip] = buildLearningPotRail(arming({ gymPots: [gym('a', true)], potScope: null }));
    expect(chip.scout.state).toBe('unknown');
  });
});

describe("a segment reports its OWN arming, so switching the pot back on restores it", () => {
  it('keeps gym armed in the model even while the pot master switch is off', () => {
    const [chip] = buildLearningPotRail(
      arming({ gymPots: [gym('alpha', true, 5)], potScope: scope(['alpha']) }),
    );
    expect(chip.learning).toBe('off');
    // The lane's own arming is untouched — this is what makes re-enabling restore it.
    expect(chip.gym.state).toBe('on');
  });

  it('keeps lane arm counts while the pot is switched off', () => {
    const [chip] = buildLearningPotRail(
      arming({
        lanes: [lane('dream:alpha', 'alpha', true), lane('frontier:x', 'alpha', false)],
        potScope: scope(['alpha']),
      }),
    );
    expect(chip.learning).toBe('off');
    expect(chip.lanes).toMatchObject({ armed: 1, total: 2, state: 'on' });
  });
});

describe('absent is not off', () => {
  it('marks a pot with lanes but no gym row as gym-absent', () => {
    const [chip] = buildLearningPotRail(
      arming({ lanes: [lane('dream:alpha', 'alpha', true)], potScope: scope([]) }),
    );
    expect(chip.gym.state).toBe('absent');
    expect(chip.gym.state).not.toBe('off');
    expect(chip.gym.spentUsd).toBeNull();
  });

  it('marks a pot with a gym row but no lanes as lanes-absent', () => {
    const [chip] = buildLearningPotRail(arming({ gymPots: [gym('alpha', true)], potScope: scope([]) }));
    expect(chip.lanes).toMatchObject({ state: 'absent', total: 0, armed: 0 });
  });
});

describe('scout spend is unknown, never a fabricated zero', () => {
  it('reports null scout spend even for a fully armed pot', () => {
    const [chip] = buildLearningPotRail(
      arming({ gymPots: [gym('alpha', true, 12)], potScope: scope([]) }),
    );
    expect(chip.scout.spentUsd).toBeNull();
    expect(chip.scout.spentUsd).not.toBe(0);
  });

  it('marks the chip total as incomplete because scout is excluded', () => {
    const [chip] = buildLearningPotRail(
      arming({ gymPots: [gym('alpha', true, 12)], potScope: scope([]) }),
    );
    expect(chip.spendComplete).toBe(false);
  });
});

describe('spend attribution', () => {
  it('sums gym and lane spend for the pot and ignores other pots lanes', () => {
    const [chip] = buildLearningPotRail(
      arming({
        gymPots: [gym('alpha', true, 10)],
        lanes: [
          lane('dream:alpha', 'alpha', true, 2.5),
          lane('dream:beta', 'beta', true, 99),
          lane('orphan', null, true, 99),
        ],
        potScope: scope([]),
      }),
    ).filter((c) => c.potSlug === 'alpha');
    expect(chip.spentUsd).toBeCloseTo(12.5, 5);
  });
});

describe('population and ordering', () => {
  it('includes only pots with a learning presence, and ignores null-pot lanes', () => {
    const slugs = learningPotSlugs(
      arming({ gymPots: [gym('alpha', true)], lanes: [lane('orphan', null, true)] }),
    );
    expect(slugs).toEqual(['alpha']);
  });

  it('orders switched-off pots last, then by spend, then by slug', () => {
    const rail = buildLearningPotRail(
      arming({
        gymPots: [gym('low', true, 1), gym('high', true, 50), gym('zoff', true, 999)],
        potScope: scope(['zoff']),
      }),
    );
    expect(rail.map((c) => c.potSlug)).toEqual(['high', 'low', 'zoff']);
  });

  it('returns an empty rail for missing arming rather than throwing', () => {
    expect(buildLearningPotRail(null)).toEqual([]);
    expect(buildLearningPotRail(undefined)).toEqual([]);
  });
});

/**
 * The DORMANT split. Presence alone is not "learning": measured on the live
 * workspace 2026-08-30, 54 pots have a setup and 7 have anything armed, with
 * learning_pot_scope empty — so a presence rail renders 54 chips that all read
 * 'on'. These assert the narrowing WITHOUT letting it hide a pot someone has
 * actually decided about, which is the way this rule fails dangerously.
 */
describe('the dormant split — a setup is not the same as learning', () => {
  const potsOf = (chips: ReturnType<typeof buildLearningPotRail>) => chips.map((c) => c.potSlug);

  it('treats a configured-but-disarmed pot as dormant', () => {
    const [chip] = buildLearningPotRail(
      arming({ gymPots: [gym('idle', false)], potScope: scope([]) }),
    );
    expect(isPotChipDormant(chip)).toBe(true);
  });

  it('treats a pot with any armed lane as active, even with no gym at all', () => {
    const [chip] = buildLearningPotRail(
      arming({ lanes: [lane('l1', 'busy', true)], potScope: scope([]) }),
    );
    expect(chip.gym.state).toBe('absent');
    expect(isPotChipDormant(chip)).toBe(false);
  });

  it('NEVER hides a switched-off pot — the rail chip is what switches it back on', () => {
    const [chip] = buildLearningPotRail(
      // Nothing armed AND switched off: dormant by arming, but a recorded decision.
      arming({ gymPots: [gym('paused', false)], potScope: scope(['paused']) }),
    );
    expect(chip.learning).toBe('off');
    expect(isPotChipDormant(chip)).toBe(false);
  });

  it('NEVER hides a pot whose scope could not be read', () => {
    const [chip] = buildLearningPotRail(arming({ gymPots: [gym('mystery', false)], potScope: null }));
    expect(chip.learning).toBe('unknown');
    expect(isPotChipDormant(chip)).toBe(false);
  });

  it('partitions without dropping anything, preserving rail order', () => {
    const rail = buildLearningPotRail(
      arming({
        gymPots: [gym('armed', true, 5), gym('idle-a', false), gym('idle-b', false)],
        potScope: scope([]),
      }),
    );
    const { active, dormant } = partitionLearningPotRail(rail);
    expect(potsOf(active)).toEqual(['armed']);
    expect(potsOf(dormant)).toEqual(['idle-a', 'idle-b']);
    expect(active.length + dormant.length).toBe(rail.length);
  });
});
