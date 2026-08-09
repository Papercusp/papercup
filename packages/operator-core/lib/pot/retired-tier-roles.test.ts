/**
 * THE SPAWN GATE's role predicate — which roles belong to the retired tier
 * (retire-mug-kettle-su-only-2026-08-09 P-008, D-018).
 *
 * This is the shared half of BOTH spawn chokepoints (`fleet/operator-spawn.ts`
 * and the `/invoke` route), so a defect here is a defect in every spawn path at
 * once — and it fails OPEN, which is the direction nothing notices.
 *
 * The genuine risk is NOT "did someone list the wrong three words". It is the
 * ALIAS layer: the pot rename left `bee`/`queen`/`overwatch` live, the `/invoke`
 * route's own comment records `?role=queen` as the PRODUCTION convention for Mug
 * wakes, and a gate matching raw strings would look closed while leaving all
 * three roles reachable under their former names. Every alias below is therefore
 * asserted explicitly rather than trusted to the canonicaliser.
 *
 * The `scout` case is the mirror-image risk, and the more expensive one: `scout`
 * also travels that same rename table (→ `blender`), so a gate written against
 * the table rather than against the RETIREMENT would take out the subsystem
 * D-001 explicitly keeps.
 */
import { describe, it, expect } from 'vitest';
import { isRetiredTierRole, RETIRED_TIER_ROLES } from './retired-tier-roles';
import { canonicalCoordRole } from '../agent-tools/coordination/roles';

describe('P-008 spawn gate: isRetiredTierRole', () => {
  it.each(['mug', 'kettle', 'cup'])('retires the canonical role %s', (role) => {
    expect(isRetiredTierRole(role)).toBe(true);
  });

  // The load-bearing cases. Each pairing is a door that a raw-string gate leaves
  // open, under a name that real callers still use today.
  it.each([
    ['queen', 'mug'],
    ['bee', 'cup'],
    ['overwatch', 'kettle'],
  ])('retires the PRE-RENAME alias %s (→ %s)', (alias, canonical) => {
    // Pin the premise too: if the rename table ever stops mapping these, this
    // test should fail LOUDLY here rather than quietly stop testing an alias.
    expect(canonicalCoordRole(alias)).toBe(canonical);
    expect(isRetiredTierRole(alias)).toBe(true);
  });

  // CALIBRATION — without these, `isRetiredTierRole = () => true` passes every
  // assertion above while making the whole app unspawnable.
  it.each(['su', 'worker', 'operator', 'oracle', 'planner', 'orchestrator', 'auditor'])(
    'does NOT retire the unrelated role %s',
    (role) => {
      expect(isRetiredTierRole(role)).toBe(false);
    },
  );

  it('does NOT retire scout/blender — D-001 keeps that subsystem INTACT', () => {
    // scout travels the SAME pot-rename table as the retired three, so a gate
    // built from that table instead of from the retirement would catch it. That
    // would break the replacement system with the flag that retires the old one
    // (the "gate too strong" direction, D-003/D-017).
    expect(canonicalCoordRole('scout')).toBe('blender');
    expect(isRetiredTierRole('scout')).toBe(false);
    expect(isRetiredTierRole('blender')).toBe(false);
  });

  it('does NOT retire papercup — the owner-facing voice front door', () => {
    expect(isRetiredTierRole('sentinel')).toBe(false); // sentinel → papercup
    expect(isRetiredTierRole('papercup')).toBe(false);
  });

  it('is total on junk input rather than throwing', () => {
    // The predicate sits in front of a `fail()` on the spawn path, so a throw
    // here would surface as an opaque spawn crash rather than a clean refusal.
    for (const junk of ['', 'MUG', 'mug ', 'plugin:mug', 'unknown-role']) {
      expect(() => isRetiredTierRole(junk)).not.toThrow();
    }
    // Case/whitespace variants are NOT canonicalised by the rename table, so they
    // read as unknown roles. Asserted so the behaviour is recorded rather than
    // assumed: role ids arrive from a validated enum at both chokepoints, and
    // `plugin:mug` is a namespaced PLUGIN role, deliberately not this tier.
    expect(isRetiredTierRole('MUG')).toBe(false);
    expect(isRetiredTierRole('plugin:mug')).toBe(false);
  });

  it('the exported set holds CANONICAL spellings only', () => {
    // Aliases belong in the rename table, not duplicated here — otherwise the
    // set becomes a list of spellings to keep chasing, which is what the module
    // exists to avoid.
    for (const role of RETIRED_TIER_ROLES) {
      expect(canonicalCoordRole(role)).toBe(role);
    }
    expect([...RETIRED_TIER_ROLES].sort()).toEqual(['cup', 'kettle', 'mug']);
  });
});
