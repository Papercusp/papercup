/**
 * Guard: no RETIRED agent role may keep a config row on /settings/agent
 * (WI-39539).
 *
 * The bug this exists to prevent: `retire-mug-kettle-su-only-2026-08-09`
 * shipped a hard spawn refusal for the Mug/Kettle/Cup tier, but the AI
 * backend tab kept rendering Backend / model / tier-ceiling controls for
 * `mug` and `kettle`. They looked live, they saved without error, and they
 * could never take effect — the owner reported it, three days later.
 *
 * ⚠ THIS ASSERTS THROUGH THE CANONICAL PREDICATE, NOT A WORD LIST. Copying
 * ['mug','kettle'] here would re-create the drift it is meant to catch: the
 * next retirement would pass a guard that never heard about it. Importing
 * `isRetiredTierRole` means retiring a role in operator-core turns THIS test
 * red until its settings row is deleted too.
 *
 * ⚠ And it canonicalizes: the pot rename left live aliases (queen→mug,
 * overwatch→kettle, bee→cup), so a row spelled `queen` names a retired role
 * while matching no literal in any hand-kept list. `isRetiredTierRole`
 * resolves the alias; a string compare against 'mug' would not.
 */
import { describe, expect, it } from 'vitest';
import { isRetiredTierRole, RETIRED_TIER_ROLES } from '@papercusp/operator-core/lib/pot/retired-tier-roles';
import { ROLE_ROUTING_ROWS } from './role-routing-rows';

describe('settings/agent role-routing rows', () => {
  it('offers no role belonging to the retired Mug/Kettle/Cup tier', () => {
    const retired = ROLE_ROUTING_ROWS.filter((row) => isRetiredTierRole(row.role));
    expect(
      retired.map((r) => `${r.label} (role="${r.role}")`),
      'a settings row exists for a role fleet/operator-spawn.ts refuses to spawn — delete the row',
    ).toEqual([]);
  });

  it('still offers Blender/scanner, which the retirement deliberately kept', () => {
    // Calibration: proves the assertion above is not passing merely because
    // the list is empty or the predicate matches everything.
    expect(ROLE_ROUTING_ROWS.some((row) => row.role === 'scanner')).toBe(true);
    expect(isRetiredTierRole('scanner')).toBe(false);
  });

  it('would REJECT a retired role if one were re-added (falsifiability control)', () => {
    // A permanently-wrong control kept in the test file rather than mutating
    // the real module — the guard must actually fire on the shape it polices.
    const withRetired = [...ROLE_ROUTING_ROWS, { label: 'Mug', role: 'mug', description: '' }];
    expect(withRetired.filter((row) => isRetiredTierRole(row.role))).toHaveLength(1);
    // ...and through an ALIAS spelling too, which a literal list would miss.
    const withAlias = [...ROLE_ROUTING_ROWS, { label: 'Queen', role: 'queen', description: '' }];
    expect(withAlias.filter((row) => isRetiredTierRole(row.role))).toHaveLength(1);
  });

  it('has a unique role id per row', () => {
    const ids = ROLE_ROUTING_ROWS.map((r) => r.role);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names the retired tier the spawn gate actually enforces', () => {
    // Pins the shared vocabulary: if the tier's membership changes, this
    // reads as a deliberate edit rather than a silent redefinition.
    expect([...RETIRED_TIER_ROLES].sort()).toEqual(['cup', 'kettle', 'mug']);
  });
});
