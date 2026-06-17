/**
 * hive-steering-tree.test — the pure model behind the Queen steering nested
 * picker (steering-nested-hive-plan-tree-2026-06-17, P-001 / P-004). Pins:
 *   - indexPlansByHive — plan→hive nesting + unassigned bucket
 *   - detectIllegalEligiblePlans / normalizeSteering — the dead-entry heal (D-2)
 *   - buildSteeringTree — planMode + checked derivation + self-heal on read
 *   - toggleHive / togglePlan / setHivePlans / setAllHives — every output legal
 *   - THE INVARIANT: no toggle sequence can make a plan eligible under an
 *     unchecked hive
 *   - round-trip stability: selection → tree → selection
 */
import { describe, expect, it } from 'vitest';
import {
  buildSteeringTree,
  detectIllegalEligiblePlans,
  indexPlansByHive,
  normalizeSteering,
  selectionFromTree,
  setAllHives,
  setHivePlans,
  toggleHive,
  togglePlan,
  type HiveOptionInput,
  type SteeringSelection,
  type TreePlanInput,
} from './hive-steering-tree';

const HIVES: HiveOptionInput[] = [
  { value: 'hive-a', label: 'hive-a' },
  { value: 'mem-a1', label: '  ↳ mem-a1' },
  { value: 'hive-b', label: 'hive-b' },
];

const PLANS: TreePlanInput[] = [
  { slug: 'a-plan-1', title: 'A1', status: 'active', startStatus: null, harness: 'hive-a', inActive: true },
  { slug: 'a-plan-2', title: 'A2', status: 'ready', startStatus: null, harness: 'hive-a', inActive: true },
  { slug: 'm-plan-1', title: 'M1', status: 'draft', startStatus: null, harness: 'mem-a1', inActive: true },
  { slug: 'b-plan-1', title: 'B1', status: 'active', startStatus: null, harness: 'hive-b', inActive: true },
  { slug: 'orphan', title: 'Orphan', status: 'draft', startStatus: null, harness: 'all', inActive: true },
];

function idx() {
  return indexPlansByHive(HIVES, PLANS);
}

describe('indexPlansByHive', () => {
  it('nests each plan under the hive option matching its harness; unmatched → unassigned', () => {
    const { hivePlans, planToHive, unassigned } = idx();
    expect(hivePlans.get('hive-a')).toEqual(['a-plan-1', 'a-plan-2']);
    expect(hivePlans.get('mem-a1')).toEqual(['m-plan-1']);
    expect(hivePlans.get('hive-b')).toEqual(['b-plan-1']);
    expect(unassigned).toEqual(['orphan']);
    expect(planToHive.get('a-plan-1')).toBe('hive-a');
    expect(planToHive.get('orphan')).toBeUndefined();
  });
});

describe('detectIllegalEligiblePlans (the dead no-ops)', () => {
  const { planToHive } = idx();
  it('flags an eligible plan whose known hive is excluded', () => {
    const sel: SteeringSelection = { eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1', 'b-plan-1'] };
    expect(detectIllegalEligiblePlans(sel, planToHive)).toEqual(['b-plan-1']); // b-plan-1's hive-b is excluded
  });
  it('returns none when eligibleHives is empty (no restriction)', () => {
    const sel: SteeringSelection = { eligibleHives: [], eligiblePlans: ['a-plan-1', 'b-plan-1'] };
    expect(detectIllegalEligiblePlans(sel, planToHive)).toEqual([]);
  });
  it('does not flag an unassigned (unknown-hive) eligible plan', () => {
    const sel: SteeringSelection = { eligibleHives: ['hive-a'], eligiblePlans: ['orphan'] };
    expect(detectIllegalEligiblePlans(sel, planToHive)).toEqual([]);
  });
});

describe('normalizeSteering', () => {
  const { planToHive } = idx();
  it('drops the dead entries (hive gate wins) and reports them', () => {
    const r = normalizeSteering({ eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1', 'b-plan-1'] }, planToHive);
    expect(r.droppedIllegal).toEqual(['b-plan-1']);
    expect(r.selection.eligiblePlans).toEqual(['a-plan-1']);
    expect(r.selection.eligibleHives).toEqual(['hive-a']);
  });
  it('adds the owning hive for a surviving plan (representability, behaviour-preserving)', () => {
    // legacy: a plan eligible with NO hive restriction → its hive becomes explicit.
    const r = normalizeSteering({ eligibleHives: [], eligiblePlans: ['a-plan-1'] }, planToHive);
    expect(r.selection.eligibleHives).toEqual(['hive-a']);
    expect(r.selection.eligiblePlans).toEqual(['a-plan-1']);
    expect(r.addedHives).toEqual(['hive-a']);
  });
  it('is idempotent', () => {
    const once = normalizeSteering({ eligibleHives: [], eligiblePlans: ['a-plan-1', 'b-plan-1'] }, planToHive).selection;
    const twice = normalizeSteering(once, planToHive).selection;
    expect(twice).toEqual(once);
  });
});

describe('buildSteeringTree', () => {
  it('hive unchecked → planMode none, no plans checked', () => {
    const tree = buildSteeringTree(HIVES, PLANS, { eligibleHives: [], eligiblePlans: [] });
    const a = tree.hives.find((h) => h.slug === 'hive-a')!;
    expect(a.checked).toBe(false);
    expect(a.planMode).toBe('none');
    expect(a.plans.every((p) => !p.checked)).toBe(true);
  });

  it('hive checked, no narrowing → planMode all, every plan checked', () => {
    const tree = buildSteeringTree(HIVES, PLANS, { eligibleHives: ['hive-a'], eligiblePlans: [] });
    const a = tree.hives.find((h) => h.slug === 'hive-a')!;
    expect(a.checked).toBe(true);
    expect(a.planMode).toBe('all');
    expect(a.plans.every((p) => p.checked)).toBe(true);
  });

  it('hive checked, narrowed subset → planMode some, only the listed plans checked', () => {
    const tree = buildSteeringTree(HIVES, PLANS, { eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1'] });
    const a = tree.hives.find((h) => h.slug === 'hive-a')!;
    expect(a.planMode).toBe('some');
    expect(a.plans.find((p) => p.slug === 'a-plan-1')!.checked).toBe(true);
    expect(a.plans.find((p) => p.slug === 'a-plan-2')!.checked).toBe(false);
  });

  it('surfaces unassigned plans (non-checkable)', () => {
    const tree = buildSteeringTree(HIVES, PLANS, { eligibleHives: [], eligiblePlans: [] });
    expect(tree.unassigned.map((p) => p.slug)).toEqual(['orphan']);
    expect(tree.unassigned.every((p) => !p.checked)).toBe(true);
  });

  it('self-heals a legacy illegal state on READ — the dead plan vanishes from the tree', () => {
    // hive-a checked, but b-plan-1 (hive-b, excluded) is eligible → dead.
    const tree = buildSteeringTree(HIVES, PLANS, { eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1', 'b-plan-1'] });
    const b = tree.hives.find((h) => h.slug === 'hive-b')!;
    expect(b.checked).toBe(false); // hive-b never silently appears
    expect(b.plans.find((p) => p.slug === 'b-plan-1')!.checked).toBe(false);
  });
});

describe('toggles produce only legal selections', () => {
  const { hivePlans, planToHive } = idx();

  it('toggleHive ON with no narrowing adds the hive, leaves eligiblePlans empty', () => {
    const next = toggleHive({ eligibleHives: [], eligiblePlans: [] }, 'hive-a', hivePlans, planToHive);
    expect(next.eligibleHives).toContain('hive-a');
    expect(next.eligiblePlans).toEqual([]); // "all of hive-a" — frontier kept, not expanded
  });

  it('toggleHive ON while narrowing cascades the new hive plans in explicitly', () => {
    const start: SteeringSelection = { eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1'] };
    const next = toggleHive(start, 'hive-b', hivePlans, planToHive);
    expect(next.eligibleHives).toEqual(expect.arrayContaining(['hive-a', 'hive-b']));
    expect(next.eligiblePlans).toEqual(expect.arrayContaining(['a-plan-1', 'b-plan-1']));
  });

  it('toggleHive OFF removes the hive and its plans', () => {
    const start: SteeringSelection = { eligibleHives: ['hive-a', 'hive-b'], eligiblePlans: ['a-plan-1', 'b-plan-1'] };
    const next = toggleHive(start, 'hive-a', hivePlans, planToHive);
    expect(next.eligibleHives).toEqual(['hive-b']);
    expect(next.eligiblePlans).toEqual(['b-plan-1']);
  });

  it('togglePlan from the "all" state expands to explicit-minus-one (narrows)', () => {
    const start: SteeringSelection = { eligibleHives: ['hive-a'], eligiblePlans: [] };
    const next = togglePlan(start, 'hive-a', 'a-plan-2', hivePlans, planToHive);
    expect(next.eligiblePlans).toEqual(['a-plan-1']); // all of hive-a minus a-plan-2
    expect(next.eligibleHives).toEqual(['hive-a']);
  });

  it('togglePlan unchecking the LAST plan of a hive also unchecks the hive', () => {
    const start: SteeringSelection = { eligibleHives: ['hive-a', 'hive-b'], eligiblePlans: ['a-plan-1', 'b-plan-1'] };
    const next = togglePlan(start, 'hive-b', 'b-plan-1', hivePlans, planToHive);
    expect(next.eligibleHives).toEqual(['hive-a']); // hive-b fell out of scope
    expect(next.eligiblePlans).toEqual(['a-plan-1']);
  });

  it('togglePlan is a NO-OP when the plan hive is not checked (the invariant guard)', () => {
    const start: SteeringSelection = { eligibleHives: ['hive-a'], eligiblePlans: [] };
    const next = togglePlan(start, 'hive-b', 'b-plan-1', hivePlans, planToHive);
    expect(next).toBe(start); // cannot make b-plan-1 eligible while hive-b is off
  });

  it('togglePlan can re-check a previously narrowed-out plan', () => {
    const start: SteeringSelection = { eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1'] };
    const next = togglePlan(start, 'hive-a', 'a-plan-2', hivePlans, planToHive);
    expect(next.eligiblePlans).toEqual(expect.arrayContaining(['a-plan-1', 'a-plan-2']));
  });

  it('setHivePlans(off) drops a hive and its plans; setHivePlans(on) adds them back', () => {
    const off = setHivePlans({ eligibleHives: ['hive-a'], eligiblePlans: [] }, 'hive-a', false, hivePlans, planToHive);
    expect(off.eligibleHives).toEqual([]);
    const on = setHivePlans(off, 'hive-a', true, hivePlans, planToHive);
    expect(on.eligibleHives).toEqual(['hive-a']);
  });

  it('setAllHives(true) scopes every hive with no narrowing; (false) clears both lists', () => {
    const all = setAllHives({ eligibleHives: [], eligiblePlans: ['a-plan-1'] }, true, HIVES, planToHive);
    expect(all.eligibleHives).toEqual(['hive-a', 'mem-a1', 'hive-b']);
    expect(all.eligiblePlans).toEqual([]);
    expect(setAllHives(all, false, HIVES, planToHive)).toEqual({ eligibleHives: [], eligiblePlans: [] });
  });
});

describe('THE INVARIANT — no toggle sequence yields an eligible plan under an excluded hive', () => {
  const { hivePlans, planToHive } = idx();
  it('holds across an exhaustive random-ish walk', () => {
    let sel: SteeringSelection = { eligibleHives: [], eligiblePlans: [] };
    const ops: Array<(s: SteeringSelection) => SteeringSelection> = [
      (s) => toggleHive(s, 'hive-a', hivePlans, planToHive),
      (s) => toggleHive(s, 'hive-b', hivePlans, planToHive),
      (s) => toggleHive(s, 'mem-a1', hivePlans, planToHive),
      (s) => togglePlan(s, 'hive-a', 'a-plan-1', hivePlans, planToHive),
      (s) => togglePlan(s, 'hive-a', 'a-plan-2', hivePlans, planToHive),
      (s) => togglePlan(s, 'hive-b', 'b-plan-1', hivePlans, planToHive),
      (s) => togglePlan(s, 'mem-a1', 'm-plan-1', hivePlans, planToHive),
      (s) => setHivePlans(s, 'hive-a', true, hivePlans, planToHive),
      (s) => setHivePlans(s, 'hive-b', false, hivePlans, planToHive),
    ];
    // Deterministic LCG so the walk is reproducible without Math.random.
    let seed = 12345;
    for (let i = 0; i < 600; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      sel = ops[seed % ops.length](sel);
      // No dead entries, EVER.
      expect(detectIllegalEligiblePlans(sel, planToHive)).toEqual([]);
      // And every eligible plan with a known hive sits under a checked hive.
      const allowed = new Set(sel.eligibleHives);
      for (const p of sel.eligiblePlans) {
        const hive = planToHive.get(p);
        if (hive != null) expect(allowed.has(hive)).toBe(true);
      }
    }
  });
});

describe('round-trip stability: selection → tree → selection', () => {
  const cases: SteeringSelection[] = [
    { eligibleHives: [], eligiblePlans: [] },
    { eligibleHives: ['hive-a'], eligiblePlans: [] },
    { eligibleHives: ['hive-a', 'hive-b'], eligiblePlans: [] },
    { eligibleHives: ['hive-a'], eligiblePlans: ['a-plan-1'] },
    { eligibleHives: ['hive-a', 'hive-b'], eligiblePlans: ['a-plan-1', 'b-plan-1'] },
  ];
  const { planToHive } = idx();
  for (const sel of cases) {
    it(`stable for ${JSON.stringify(sel)}`, () => {
      const normalized = normalizeSteering(sel, planToHive).selection;
      const tree = buildSteeringTree(HIVES, PLANS, normalized);
      const back = selectionFromTree(tree);
      // Order-insensitive equality on both lists.
      expect(new Set(back.eligibleHives)).toEqual(new Set(normalized.eligibleHives));
      expect(new Set(back.eligiblePlans)).toEqual(new Set(normalized.eligiblePlans));
      // And building again from the read-back is identical (true round-trip).
      const tree2 = buildSteeringTree(HIVES, PLANS, back);
      expect(selectionFromTree(tree2)).toEqual(back);
    });
  }
});
