/**
 * P-007 of goal-launch-headless-and-fleet-type-2026-08-26.
 *
 * VERIFY BY BINDING, NOT BY WRITING (D-003, inherited from WI-38048's closing
 * instruction). Every assertion here is about what a launch RECEIVES — the
 * option object handed to `resolveLaunchOptions`, and the `members[]` entries
 * `expandPairedMembers` produces from it. A test asserting the goal document
 * saved would have passed throughout the entire WI-38048 bug, and would pass
 * today even if the mapper were deleted.
 *
 * The headline case is the last describe block: a paired goal that pins a
 * different model per role must produce two DIFFERENT per-seat models. That is
 * the exact failure `pair-launch-options.ts` exists to refuse, checked here one
 * layer up where the goal is the thing doing the configuring.
 */
import { describe, it, expect } from 'vitest';
import {
  applyGoalLaunchOverlay,
  goalFleetLeaderProfile,
  goalFleetLaunchOverlay,
  goalFleetWideFoldSlot,
  goalPairedTypeNote,
  resolveGoalFleetLeadership,
} from './goal-fleet-launch-options';
import {
  expandPairedMembers,
  resolveLaunchOptions,
  PAIR_ROLE_DIRECTOR,
  PAIR_ROLE_IMPLEMENTER,
} from './pair-launch-options';
import type { GoalLaunchSettings } from '../../goal-launch-settings';

const FLEET = 'plan-fleet-alpha';
const DRAIN = 'drain-fleet-alpha';

describe('resolveGoalFleetLeadership — GOAL holders delegate by construction', () => {
  it("defaults a GOAL launch to leader:'spawn' while preserving the generic caller default", () => {
    expect(
      resolveGoalFleetLeadership({ goalId: 'g-1', callerOwnerId: 'su-goal' }),
    ).toEqual({ ok: true, leader: 'spawn', defaultedToSpawn: true });
    expect(
      resolveGoalFleetLeadership({ goalId: null, callerOwnerId: 'su-generic' }),
    ).toEqual({ ok: true, leader: 'caller', defaultedToSpawn: false });
  });

  it('refuses an explicit caller-led GOAL launch', () => {
    const r = resolveGoalFleetLeadership({
      goalId: 'g-1',
      requested: 'caller',
      callerOwnerId: 'su-goal',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain("leader:'spawn'");
  });

  it('refuses to top up a fleet the GOAL holder already leads', () => {
    const r = resolveGoalFleetLeadership({
      goalId: 'g-1',
      requested: 'spawn',
      callerOwnerId: 'su-goal',
      existingLeaderOwnerId: 'su-goal',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('already leads');
  });
});

describe('goalFleetLeaderProfile — leader and member slots stay distinct', () => {
  const settings = {
    defaults: { account: 'auto', model: 'sonnet' },
    roles: {
      'plan-fleet-leader': { model: 'opus', effort: 'max' },
      'plan-fleet-member': { model: 'haiku', effort: 'high' },
    },
  } as GoalLaunchSettings;

  it('binds the plan-fleet leader profile without leaking the member profile', () => {
    expect(goalFleetLeaderProfile({ settings, family: 'plan' })).toEqual({
      account: 'auto',
      model: 'opus',
      effort: 'max',
    });
  });

  it('lets the GOAL holder make an explicit contextual model choice', () => {
    expect(
      goalFleetLeaderProfile({ settings, family: 'plan', requested: { model: 'gpt-5.6-sol' } }),
    ).toMatchObject({ model: 'gpt-5.6-sol', effort: 'max', account: 'auto' });
  });
});

/** The mapper's inputs, with only the bits a case cares about spelled out. */
const overlayFor = (
  settings: GoalLaunchSettings | null,
  opts: { goalId?: string | null; fleetSlug?: string; drainFleetSlug?: string | null; callerType?: 'single' | 'paired' } = {},
) =>
  goalFleetLaunchOverlay({
    goalId: opts.goalId === undefined ? 'g-1' : opts.goalId,
    settings,
    fleetSlug: opts.fleetSlug ?? FLEET,
    drainFleetSlug: opts.drainFleetSlug ?? DRAIN,
    callerType: opts.callerType,
  });

describe('goalFleetLaunchOverlay — fleet shape and who chose it (D-006)', () => {
  it('defaults to single and reports the default as the source when nobody chose', () => {
    const o = overlayFor(null);
    expect(o.type).toBe('single');
    expect(o.typeSource).toBe('default');
  });

  it("takes the goal's pinned fleetType when the caller passed none", () => {
    const o = overlayFor({ fleetType: 'paired' } as GoalLaunchSettings);
    expect(o.type).toBe('paired');
    expect(o.typeSource).toBe('goal');
  });

  it('lets an EXPLICIT caller type outrank the goal — including a downgrade to single', () => {
    // The settings are the goal's standing policy, not an override of a decision
    // the caller just made deliberately. Same precedence foldLaunchProfile uses.
    const o = overlayFor({ fleetType: 'paired' } as GoalLaunchSettings, { callerType: 'single' });
    expect(o.type).toBe('single');
    expect(o.typeSource).toBe('caller');
  });

  it('reports the caller as the source even when they agree with the goal', () => {
    const o = overlayFor({ fleetType: 'paired' } as GoalLaunchSettings, { callerType: 'paired' });
    expect(o.typeSource).toBe('caller');
  });
});

describe('goalFleetLaunchOverlay — slot family (mirrors EI-20219409083169975)', () => {
  it('resolves the DRAIN family when this fleet IS the goal-declared drain fleet', () => {
    const o = overlayFor(null, { fleetSlug: DRAIN });
    expect(o.family).toBe('drain');
    expect(o.slots).toEqual({ type: 'single', member: 'drain-fleet-member' });
  });

  it('resolves the PLAN family for every other fleet on the goal', () => {
    const o = overlayFor(null, { fleetSlug: FLEET });
    expect(o.family).toBe('plan');
    expect(o.slots).toEqual({ type: 'single', member: 'plan-fleet-member' });
  });

  it('names the paired slots of the right family', () => {
    const o = overlayFor({ fleetType: 'paired' } as GoalLaunchSettings, { fleetSlug: DRAIN });
    expect(o.slots).toEqual({
      type: 'paired',
      director: 'drain-fleet-director',
      implementer: 'drain-fleet-implementer',
    });
  });

  it('treats a goal with no drain declaration as all-plan (null never matches a slug)', () => {
    const o = overlayFor(null, { drainFleetSlug: null });
    expect(o.family).toBe('plan');
  });
});

describe('goalFleetLaunchOverlay — profile folding', () => {
  it('folds the goal defaults under the role layer, role winning', () => {
    const o = overlayFor({
      defaults: { account: 'acct-shared', model: 'sonnet' },
      roles: { 'plan-fleet-member': { model: 'opus' } },
    } as GoalLaunchSettings);
    expect(o.flat).toEqual({ account: 'acct-shared', model: 'opus' });
    expect(o.pinned).toBe(true);
  });

  it('is UNPINNED and empty when the goal declares nothing — the byte-identical-to-today case', () => {
    const o = overlayFor({ maxAgents: 3 } as GoalLaunchSettings);
    expect(o.pinned).toBe(false);
    expect(o.flat).toEqual({});
    expect(o.directors).toEqual({});
    expect(o.implementers).toEqual({});
  });

  it('consults NO profile at all when there is no goal in context', () => {
    const o = overlayFor({ roles: { 'plan-fleet-member': { model: 'opus' } } } as GoalLaunchSettings, {
      goalId: null,
    });
    expect(o.goalId).toBeNull();
    expect(o.flat).toEqual({});
    expect(o.pinned).toBe(false);
  });

  it('drops a blank string as UNSET rather than pinning an empty value', () => {
    const o = overlayFor({ roles: { 'plan-fleet-member': { model: '' } } } as unknown as GoalLaunchSettings);
    expect(o.flat).toEqual({});
    expect(o.pinned).toBe(false);
  });
});

describe('goalFleetLaunchOverlay — knobs this shape cannot bind are NAMED, not dropped', () => {
  // "Reads as configured while binding nothing" is the WI-38048 complaint. A
  // knob the mapper cannot deliver has to come back out somewhere.
  it('reports a per-role contextSize on a PAIRED fleet as unbindable', () => {
    const o = overlayFor({
      fleetType: 'paired',
      roles: { 'plan-fleet-director': { model: 'opus', contextSize: 'trimmed' } },
    } as GoalLaunchSettings);
    expect(o.unbindable).toEqual([
      expect.objectContaining({ slot: 'plan-fleet-director', knob: 'contextSize' }),
    ]);
    // …and the knobs it CAN bind still bind.
    expect(o.directors.model).toBe('opus');
  });

  it('does NOT report contextSize on a SINGLE fleet — the fleet-wide fold still delivers it', () => {
    const o = overlayFor({
      roles: { 'plan-fleet-member': { contextSize: 'trimmed' } },
    } as GoalLaunchSettings);
    expect(o.unbindable).toEqual([]);
  });
});

describe('applyGoalLaunchOverlay — the single arm must not write an INERT copy', () => {
  // REGRESSION GUARD for the P-006 design correction. `resolveLaunchOptions`'s
  // `flat` is read by nothing in launch-on-plan (verified: the handler consumes
  // only .ok/.message/.type/.pairs). A single fleet's goal profile binds through
  // the goal fold at the launch door instead. Pushing it in here would look like
  // configuration and reach no member — the exact bug this plan removes.
  it('passes ONLY type on a single fleet, never the goal flat knobs', () => {
    const o = overlayFor({ roles: { 'plan-fleet-member': { model: 'opus' } } } as GoalLaunchSettings);
    const applied = applyGoalLaunchOverlay({ count: 2 }, o);
    expect(applied.type).toBe('single');
    expect(applied.model).toBeUndefined();
    expect(applied.agent).toBeUndefined();
    expect(applied.count).toBe(2);
  });

  it('leaves the caller flat knobs exactly as passed on a single fleet', () => {
    const o = overlayFor({ roles: { 'plan-fleet-member': { model: 'opus' } } } as GoalLaunchSettings);
    const applied = applyGoalLaunchOverlay({ model: 'haiku' }, o);
    expect(applied.model).toBe('haiku');
  });
});

describe('applyGoalLaunchOverlay — the paired arm is the load-bearing one', () => {
  const paired = {
    fleetType: 'paired',
    roles: {
      'plan-fleet-director': { model: 'opus', effort: 'xhigh' },
      'plan-fleet-implementer': { model: 'haiku' },
    },
  } as GoalLaunchSettings;

  it("carries the goal's role profiles into the directors/implementers groups", () => {
    const applied = applyGoalLaunchOverlay({}, overlayFor(paired));
    expect(applied.type).toBe('paired');
    expect(applied.directors).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(applied.implementers).toEqual({ model: 'haiku' });
  });

  it('lets a caller group override the goal knob by knob, keeping the rest', () => {
    const applied = applyGoalLaunchOverlay({ directors: { model: 'sonnet' } }, overlayFor(paired));
    expect(applied.directors).toEqual({ model: 'sonnet', effort: 'xhigh' });
    expect(applied.implementers).toEqual({ model: 'haiku' });
  });

  it('emits BOTH groups when the goal pins only one, so the launch is not refused as half-finished', () => {
    // pair-launch-options reads PRESENCE, not emptiness: `directors:{}` is a
    // deliberate "this role runs on the defaults", whereas omitting both earns
    // the no_roles_configured refusal.
    const onlyImplementers = {
      fleetType: 'paired',
      roles: { 'plan-fleet-implementer': { model: 'haiku' } },
    } as GoalLaunchSettings;
    const applied = applyGoalLaunchOverlay({}, overlayFor(onlyImplementers));
    expect(applied.directors).toEqual({});
    expect(applied.implementers).toEqual({ model: 'haiku' });
    expect(resolveLaunchOptions(applied).ok).toBe(true);
  });

  it('PRESERVES the flat-knobs-on-paired refusal instead of coercing it away', () => {
    // Coercion is what broadcasts one model to both roles. The overlay must not
    // silently strip the caller's flat knob to make the launch legal.
    const applied = applyGoalLaunchOverlay({ model: 'opus' }, overlayFor(paired));
    const resolved = resolveLaunchOptions(applied);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.reason).toBe('flat_knobs_on_paired_fleet');
  });
});

describe('goalFleetWideFoldSlot — the fleet-wide fold must not broadcast a role (D-005)', () => {
  // This fold feeds fleetDefaults, which EVERY member inherits.
  it('binds NO role layer on a paired fleet', () => {
    expect(goalFleetWideFoldSlot('plan', 'paired')).toBeNull();
    expect(goalFleetWideFoldSlot('drain', 'paired')).toBeNull();
  });

  it('never returns a director or implementer slot for ANY input', () => {
    // The falsifier for the whole decision: if this fold ever returned a paired
    // slot, one role's model/account/carry would become every member's default.
    const every = (['plan', 'drain'] as const).flatMap((f) =>
      (['single', 'paired'] as const).map((t) => goalFleetWideFoldSlot(f, t)),
    );
    // null (the paired arm) is the SAFE outcome here, so it counts as passing;
    // what must never appear is a paired slot name.
    const pairedSlots = every.filter((s) => s !== null && /-(director|implementer)$/.test(s));
    expect(pairedSlots).toEqual([]);
    // Calibration: the sweep really did evaluate every combination, so an empty
    // result means "none were paired slots" and not "nothing was checked".
    expect(every).toHaveLength(4);
  });

  it('binds the right family member slot on a single fleet', () => {
    expect(goalFleetWideFoldSlot('plan', 'single')).toBe('plan-fleet-member');
    expect(goalFleetWideFoldSlot('drain', 'single')).toBe('drain-fleet-member');
  });

  it('keys off the AUTHORITATIVE type, so a paired top-up of a single fleet still folds the member slot', () => {
    // A top-up joins an existing fleet whose STORED type wins. Passing the
    // authoritative type is what makes that ordering hold here.
    expect(goalFleetWideFoldSlot('plan', 'single')).toBe('plan-fleet-member');
  });
});

describe('goalPairedTypeNote — a refusal must name whoever chose the shape (D-006)', () => {
  const paired = { fleetType: 'paired' } as GoalLaunchSettings;

  it('names the goal when the GOAL made the launch paired', () => {
    const note = goalPairedTypeNote(overlayFor(paired));
    expect(note).toContain('g-1');
    expect(note).toContain('you did not pass');
  });

  it('says nothing when the CALLER declared paired themselves', () => {
    expect(goalPairedTypeNote(overlayFor(paired, { callerType: 'paired' }))).toBe('');
  });

  it('says nothing on a single fleet', () => {
    expect(goalPairedTypeNote(overlayFor(null))).toBe('');
  });
});

describe('THE HEADLINE: a paired goal cannot broadcast one model to both roles', () => {
  // The whole point of the paired shape (D-009): the director wants the top
  // tier, the implementer can be cheaper. This walks the REAL path a launch
  // takes — overlay → resolveLaunchOptions → expandPairedMembers — and asserts
  // on the per-seat overrides that actually reach members.
  const settings = {
    fleetType: 'paired',
    defaults: { account: 'acct-shared' },
    roles: {
      'plan-fleet-director': { model: 'opus', effort: 'xhigh' },
      'plan-fleet-implementer': { model: 'haiku', effort: 'low' },
    },
  } as GoalLaunchSettings;

  it('gives each seat its OWN role model, interleaved director↔implementer', () => {
    const resolved = resolveLaunchOptions(applyGoalLaunchOverlay({ count: 2 }, overlayFor(settings)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.type !== 'paired') throw new Error('expected a paired launch');

    const members = expandPairedMembers(resolved, 4);
    expect(members).toHaveLength(4);

    // Seat 2k is the director of pair k, seat 2k+1 its implementer (D-014).
    expect(members[0]).toEqual({ role: PAIR_ROLE_DIRECTOR, model: 'opus', effort: 'xhigh', account: 'acct-shared' });
    expect(members[1]).toEqual({ role: PAIR_ROLE_IMPLEMENTER, model: 'haiku', effort: 'low', account: 'acct-shared' });
    expect(members[2]).toEqual(members[0]);
    expect(members[3]).toEqual(members[1]);

    // The falsifier, stated directly: if the mapper ever broadcast one flat
    // model, every seat would carry the same one and this would fail.
    const models = new Set(members.map((m) => m.model));
    expect(models).toEqual(new Set(['opus', 'haiku']));
  });

  it("applies the goal's shared defaults to BOTH roles without merging their role layers", () => {
    const resolved = resolveLaunchOptions(applyGoalLaunchOverlay({ count: 1 }, overlayFor(settings)));
    if (!resolved.ok || resolved.type !== 'paired') throw new Error('expected a paired launch');
    // Shared: both. Role-specific: neither leaks into the other.
    expect(resolved.directors.account).toBe('acct-shared');
    expect(resolved.implementers.account).toBe('acct-shared');
    expect(resolved.directors.effort).toBe('xhigh');
    expect(resolved.implementers.effort).toBe('low');
  });

  it('CONTROL: the same falsifier CATCHES a mapper that broadcasts one model to both roles', () => {
    // A guard that has never failed is a guard nobody has tested. This is the
    // permanent deliberately-wrong control the repo's falsifiability rule asks
    // for on a module subject: it reproduces the exact bug — one role's profile
    // applied to BOTH groups — and proves the assertion above would catch it.
    // Kept in the test file rather than mutating the shared tree, because a
    // copy-out/in-tree mutation can be committed by the git-sync sweep.
    const broadcasting = (o: ReturnType<typeof overlayFor>) => ({
      type: 'paired' as const,
      count: 2,
      directors: o.directors,
      implementers: o.directors, // ← the bug: the director profile, twice.
    });

    const resolved = resolveLaunchOptions(broadcasting(overlayFor(settings)));
    if (!resolved.ok || resolved.type !== 'paired') throw new Error('expected a paired launch');
    const members = expandPairedMembers(resolved, 4);
    const models = new Set(members.map((m) => m.model));

    // The falsifier fires: one model across every seat, not two.
    expect(models).toEqual(new Set(['opus']));
    expect(models).not.toEqual(new Set(['opus', 'haiku']));

    // CALIBRATION — the same expression against the REAL mapper must still pass,
    // or this control would also "pass" whenever the assertion itself is broken.
    const real = resolveLaunchOptions(applyGoalLaunchOverlay({ count: 2 }, overlayFor(settings)));
    if (!real.ok || real.type !== 'paired') throw new Error('expected a paired launch');
    expect(new Set(expandPairedMembers(real, 4).map((m) => m.model))).toEqual(
      new Set(['opus', 'haiku']),
    );
  });

  it('keeps the roles independent even when only ONE of them is pinned', () => {
    const onlyDirector = {
      fleetType: 'paired',
      roles: { 'plan-fleet-director': { model: 'opus' } },
    } as GoalLaunchSettings;
    const resolved = resolveLaunchOptions(
      applyGoalLaunchOverlay({ count: 1 }, overlayFor(onlyDirector)),
    );
    if (!resolved.ok || resolved.type !== 'paired') throw new Error('expected a paired launch');
    expect(resolved.directors.model).toBe('opus');
    // The implementer must NOT inherit it — an unpinned role falls through to
    // the fleet/system default, it does not copy its partner.
    expect(resolved.implementers.model).toBeUndefined();
  });
});
