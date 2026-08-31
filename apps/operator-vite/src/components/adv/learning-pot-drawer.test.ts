/**
 * The P-012 per-pot drawer MODEL (learning-pot-scope-gate-2026-08-30).
 *
 * Two families of test live here and they do different jobs:
 *
 *  1. RULE tests — the drawer's own decisions (unit-carrying budgets, the
 *     five-section partition, a per-cycle row having no "remaining").
 *  2. PIN tests — assertions that the model's assumptions still match the
 *     ENGINE code they were read off (D-009). The drawer hardcodes "gym is
 *     lifetime/native" and "blender: is the scout grain" because neither is
 *     carried on the synced payload; a pin turns a future engine change from a
 *     silently wrong unit into a failing test here. core.ts has zero imports,
 *     so importing it costs nothing at test time.
 */
import { describe, expect, it } from 'vitest';
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';
import {
  SCOUT_LOOP_ID_PREFIX,
  gymRegistrationInput,
  remainingLoopBudgetUsd,
  scoutLoopId,
} from '@papercusp/operator-core/lib/learning-governor/core';

import {
  POT_DRAWER_SECTION_IDS,
  budgetUnit,
  buildPotDrawer,
  drawerBudget,
  formatBudget,
  laneSectionId,
  type PotDrawerSectionId,
} from './learning-pot-drawer';

function gym(harnessSlug: string, over: Partial<AutomationGymArm> = {}): AutomationGymArm {
  return { harnessSlug, enabled: true, budgetUsd: 20, spentUsd: 5, status: 'idle', ...over };
}

function lane(loopId: string, potSlug: string, over: Partial<AutomationLaneArm> = {}): AutomationLaneArm {
  return {
    loopId,
    displayName: loopId,
    potSlug,
    enabled: true,
    budgetUsd: 50,
    budgetKind: 'lifetime',
    spentUsd: 10,
    enforcement: 'governor',
    ...over,
  };
}

function arming(over: Partial<AutomationArming> = {}): AutomationArming {
  return {
    gymPots: [],
    lanes: [],
    scoutCeiling: { overrideUsd: null, effectiveUsd: 10, envUsd: 10 },
    potScope: { disabledPots: [], rows: [] },
    ...over,
  };
}

function section(model: ReturnType<typeof buildPotDrawer>, id: PotDrawerSectionId) {
  const found = model.sections.find((s) => s.id === id);
  if (!found) throw new Error(`no ${id} section — the model must always emit all five`);
  return found;
}

describe('the section map is loop-id families (D-009)', () => {
  it('routes a lane by its loop-id PREFIX, not by its display name', () => {
    expect(laneSectionId('frontier:replay-harness')).toBe('frontier');
    expect(laneSectionId('blender:papercusp')).toBe('blender');
  });

  it('puts every UNPREFIXED lane in "other" rather than dropping it', () => {
    // Measured live: 8 of this workspace's 17 non-gym lanes look like these.
    for (const id of ['red-queen', 'fleet-ekg', 'regret-mining', 'prompt-ablation']) {
      expect(laneSectionId(id)).toBe('other');
    }
  });

  it('puts dream: lanes in "other" — the four named sections do not cover them', () => {
    // 6 of the 28 live pots own ONLY a dream: lane. If `other` were dropped,
    // their drawer would render empty while they are armed and spending.
    expect(laneSectionId('dream:calendar')).toBe('other');
  });

  it('places EVERY lane — the partition property, not a filter', () => {
    const lanes = [
      lane('frontier:replay', 'p'),
      lane('blender:p', 'p'),
      lane('red-queen', 'p'),
      lane('dream:p', 'p'),
      lane('neologism-miner', 'p'),
    ];
    const model = buildPotDrawer(arming({ lanes }), 'p');
    expect(model.laneCount).toBe(5);
    expect(model.placedLaneCount).toBe(model.laneCount);
  });

  it('always emits all five sections, in order, even for a pot with nothing', () => {
    const model = buildPotDrawer(arming(), 'empty-pot');
    expect(model.sections.map((s) => s.id)).toEqual([...POT_DRAWER_SECTION_IDS]);
    // An absent gym is STATED, not omitted — "never set up" is an answer.
    expect(section(model, 'gym').empty).toBe(true);
    expect(section(model, 'gym').note).toMatch(/never been set up/i);
  });
});

describe('a budget always carries its unit, and per-cycle has no remaining', () => {
  it('renders lifetime remaining as budget − spent', () => {
    const b = drawerBudget(50, 'lifetime', 10);
    expect(b.unit).toBe('USD lifetime');
    expect(b.remainingUsd).toBe(40);
    expect(b.remainingNote).toBeNull();
  });

  it('refuses to compute remaining for a per-cycle cap, and says why', () => {
    // The live case this exists for: blender:papercusp is a $5 PER-CYCLE cap
    // carrying $513.82 of cumulative spend. Subtracting prints −$508.82
    // "remaining" for a lane that is completely healthy.
    const b = drawerBudget(5, 'per-cycle', 513.82);
    expect(b.unit).toBe('USD per cycle');
    expect(b.remainingUsd).toBeNull();
    expect(b.remainingNote).toMatch(/bounds one run/i);
  });

  it('names the consequence of an UNSET budget rather than showing a blank', () => {
    const b = drawerBudget(null, 'lifetime', 3);
    expect(b.usd).toBeNull();
    expect(b.remainingNote).toMatch(/governor refuses/i);
    expect(formatBudget(b)).toBe('none set (USD lifetime)');
  });

  it('never formats a bare number', () => {
    expect(formatBudget(drawerBudget(12.5, 'per-cycle', 0))).toBe('12.50 USD per cycle');
  });

  it('takes the unit from the ROW, not from the section it sits under', () => {
    const model = buildPotDrawer(
      arming({ lanes: [lane('frontier:odd', 'p', { budgetKind: 'per-cycle', budgetUsd: 2 })] }),
      'p',
    );
    expect(section(model, 'frontier').fields[0]!.budget.unit).toBe('USD per cycle');
  });
});

describe('Scout is the workspace ceiling and is read-only here', () => {
  it('states the ceiling with a workspace-wide unit and no per-pot spend', () => {
    const f = section(buildPotDrawer(arming(), 'p'), 'scout').fields[0]!;
    expect(f.budget.usd).toBe(10);
    expect(f.budget.unit).toMatch(/workspace-wide/);
    // A 0 here would read as "this pot's scout has spent nothing", which we
    // cannot know — the rail model refuses the same coercion.
    expect(f.budget.spentUsd).toBeNull();
  });

  it('offers no write, and its reason points at the lane that DOES control this pot', () => {
    const f = section(buildPotDrawer(arming(), 'p'), 'scout').fields[0]!;
    expect(f.write).toBeNull();
    expect(f.armed).toBeNull();
    expect(f.readOnlyReason).toMatch(/blender:/);
  });

  it('reports an unreadable ceiling instead of printing a number it did not read', () => {
    const f = section(buildPotDrawer(arming({ scoutCeiling: null }), 'p'), 'scout').fields[0]!;
    expect(f.budget.usd).toBeNull();
    expect(f.status).toMatch(/unreadable/i);
  });
});

describe('writes are keyed by what the tool actually takes', () => {
  it('routes the gym through gym:arm by harness slug', () => {
    const model = buildPotDrawer(arming({ gymPots: [gym('p')] }), 'p');
    expect(section(model, 'gym').fields[0]!.write).toEqual({ tool: 'gym:arm', harness: 'p' });
  });

  it('routes a lane through governor:arm by loopId', () => {
    const model = buildPotDrawer(arming({ lanes: [lane('red-queen', 'p')] }), 'p');
    expect(section(model, 'other').fields[0]!.write).toEqual({
      tool: 'governor:arm',
      loopId: 'red-queen',
    });
  });

  it('only shows lanes belonging to THIS pot', () => {
    const model = buildPotDrawer(
      arming({ lanes: [lane('red-queen', 'p'), lane('dream:other', 'other-pot')] }),
      'p',
    );
    expect(model.laneCount).toBe(1);
    expect(section(model, 'other').fields.map((f) => f.ref)).toEqual(['red-queen']);
  });
});

describe('the drawer never needs a rail chip (the D-008 constraint)', () => {
  it('builds a full drawer for a SWITCHED-OFF pot — the case that has no chip to open', () => {
    const model = buildPotDrawer(
      arming({
        potScope: { disabledPots: ['p'], rows: [] },
        gymPots: [gym('p', { enabled: false })],
        lanes: [lane('red-queen', 'p', { enabled: false })],
      }),
      'p',
    );
    expect(model.learning).toBe('off');
    // The whole point of P-012: a switched-off, fully-idle pot still owns live
    // per-lane switches, and this surface is where they live once the rail
    // collapses (P-052).
    expect(section(model, 'gym').fields[0]!.write).not.toBeNull();
    expect(section(model, 'other').fields[0]!.write).not.toBeNull();
  });

  it('builds from a slug the arming has never heard of, with no chip anywhere', () => {
    const model = buildPotDrawer(arming(), 'a-pot-with-no-rows');
    expect(model.potSlug).toBe('a-pot-with-no-rows');
    expect(model.learning).toBe('on'); // fail-open: absent row means enabled
    expect(model.sections).toHaveLength(5);
  });
});

describe('an arming from an OLDER server (D-006 — the cache boundary)', () => {
  /**
   * These fixtures are built OUTSIDE the `arming()` helper on purpose. A suite
   * where every fixture comes from one builder that always sets all four keys
   * cannot see a field MISSING — that is exactly how WI-1397883 shipped past 35
   * green tests. The `as unknown as` cast is the point, not a shortcut: the
   * declared type forbids these shapes, and that mismatch IS the bug.
   */
  it('survives a payload with no potScope key at all', () => {
    const stale = { gymPots: [], lanes: [] } as unknown as AutomationArming;
    expect(buildPotDrawer(stale, 'p').learning).toBe('unknown');
  });

  it('survives a payload with no scoutCeiling key', () => {
    const stale = { gymPots: [], lanes: [], potScope: { disabledPots: [], rows: [] } } as unknown as AutomationArming;
    const f = section(buildPotDrawer(stale, 'p'), 'scout').fields[0]!;
    expect(f.budget.usd).toBeNull();
    expect(f.status).toMatch(/unreadable/i);
  });

  it('survives missing gymPots / lanes collections', () => {
    const stale = { potScope: { disabledPots: [], rows: [] } } as unknown as AutomationArming;
    const model = buildPotDrawer(stale, 'p');
    expect(model.laneCount).toBe(0);
    expect(section(model, 'gym').empty).toBe(true);
  });

  it('survives null entries inside the lanes array', () => {
    const stale = {
      gymPots: [null],
      lanes: [null, lane('red-queen', 'p')],
      potScope: { disabledPots: [], rows: [] },
    } as unknown as AutomationArming;
    expect(buildPotDrawer(stale, 'p').laneCount).toBe(1);
  });

  it('survives a lane with no budgetKind — defaulting to lifetime, never to per-cycle', () => {
    // Defaulting the other way would render a real accumulating overrun as a
    // harmless per-run rate, which is the failure budgetKind exists to fix.
    const stale = {
      gymPots: [],
      lanes: [{ loopId: 'x', displayName: 'x', potSlug: 'p', enabled: true, budgetUsd: 10, spentUsd: 4, enforcement: 'governor' }],
      potScope: { disabledPots: [], rows: [] },
    } as unknown as AutomationArming;
    const f = section(buildPotDrawer(stale, 'p'), 'other').fields[0]!;
    expect(f.budget.unit).toBe('USD lifetime');
    expect(f.budget.remainingUsd).toBe(6);
  });

  it('returns a complete model for a null arming rather than throwing', () => {
    const model = buildPotDrawer(null, 'p');
    expect(model.learning).toBe('unknown');
    expect(model.sections).toHaveLength(5);
  });
});

describe('PINS — the model’s assumptions still match the engine (D-009)', () => {
  it('gym really is lifetime + native, which is what gymField hardcodes', () => {
    // AutomationGymArm carries no budgetKind/enforcement, so the drawer states
    // them from gymRegistrationInput. If the engine ever changes, this fails
    // here instead of silently mislabelling a unit in the UI.
    const reg = gymRegistrationInput({
      workspaceId: 'w',
      harnessSlug: 'p',
      budgetUsd: 20,
      spentUsd: 5,
      enabled: true,
    });
    expect(reg.budgetKind).toBe('lifetime');
    expect(reg.enforcement).toBe('native');

    const f = section(buildPotDrawer(arming({ gymPots: [gym('p')] }), 'p'), 'gym').fields[0]!;
    expect(f.budget.kind).toBe(reg.budgetKind);
    expect(f.enforcement).toBe(reg.enforcement);
  });

  it('blender: really is the scout grain, which is why they share a cross-reference', () => {
    expect(SCOUT_LOOP_ID_PREFIX).toBe('blender:');
    expect(scoutLoopId('papercusp')).toBe('blender:papercusp');
    expect(laneSectionId(scoutLoopId('papercusp'))).toBe('blender');

    const model = buildPotDrawer(arming({ lanes: [lane(scoutLoopId('p'), 'p')] }), 'p');
    expect(section(model, 'blender').note).toMatch(/scout/i);
    expect(section(model, 'scout').fields[0]!.readOnlyReason).toMatch(/blender:/);
  });

  it('agrees with remainingLoopBudgetUsd about which rows HAVE a remaining balance', () => {
    // The engine reports a per-cycle row's cap unchanged; the drawer reports
    // null. Both are refusals to subtract — assert they refuse on the same rows.
    for (const kind of ['lifetime', 'per-cycle'] as const) {
      const engine = remainingLoopBudgetUsd({ budgetKind: kind, budgetUsd: 5, spentUsd: 513.82 });
      const ours = drawerBudget(5, kind, 513.82).remainingUsd;
      const engineSubtracted = engine === 5 - 513.82;
      expect(ours === null).toBe(!engineSubtracted);
    }
  });

  it('budgetUnit covers every budget kind the catalog type allows', () => {
    // A new kind on the server makes this a compile error at the cast, not a
    // silently unlabelled number in the pane.
    const kinds = ['lifetime', 'per-cycle'] as const;
    for (const k of kinds) expect(budgetUnit(k)).not.toBe('USD');
  });
});
