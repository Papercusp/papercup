/**
 * goal-launch-settings-model — the form → document conversion (P-005).
 *
 * These assert the rules whose failure mode is SILENT: a setting that looks
 * saved and pins nothing, a role row that vanishes, a ceiling that reads as
 * deliberate when it is a typo. The server schema is the authority on what is
 * valid; what is tested here is that this form only ever hands it documents that
 * mean what the owner typed.
 */

import { describe, it, expect } from 'vitest';
import {
  launchProfileSchema,
  GOAL_LAUNCH_ROLES,
  LAUNCH_PROFILE_OPTIONS,
} from '@papercusp/operator-core/lib/goal-launch-settings';
import {
  emptyRoleForm,
  formToSettings,
  isSettingsDirty,
  settingsSummary,
  settingsToForm,
  COMPACTION_LIMIT_MAX,
  COMPACTION_LIMIT_MIN,
  GOAL_LAUNCH_ROLE_OPTIONS,
  PROFILE_CHOICE_FIELDS,
  PROFILE_FIELDS,
  PROFILE_FIELD_LABEL,
  type LaunchSettingsForm,
} from './goal-launch-settings-model';

function form(over: Partial<LaunchSettingsForm> = {}): LaunchSettingsForm {
  return { ...settingsToForm(null), ...over };
}

/**
 * D-011 — "a mode list is DERIVED from the registry or GUARDED against it, never
 * hand-spelled", binding on P-005. The closed SETS are derived (the resolver
 * ships them from the schema's constants), but the FIELD LIST is spelled here
 * because each field needs a label and an input kind. So it is guarded: a
 * seventh knob added to `launchProfileSchema` fails HERE rather than shipping a
 * form that silently cannot set it.
 *
 * This is the measured pattern the decision is about — three hand-spelled mode
 * lists, every one already behind the registry before anyone looked.
 */
describe('the form covers exactly what the schema accepts', () => {
  it('offers every profile field the schema defines, and no field it does not', () => {
    expect([...PROFILE_FIELDS].sort()).toEqual(Object.keys(launchProfileSchema.shape).sort());
  });

  it('would FAIL if the form fell behind the schema', () => {
    // The guard above has never failed, which is exactly when a guard is worth
    // nothing. Falsified in-test rather than by mutating the source: this tree
    // is swept into a commit every few minutes, so a probe that edits a file
    // can be committed even when nothing goes wrong (see CLAUDE.md).
    const schemaKeys = Object.keys(launchProfileSchema.shape).sort();
    expect([...PROFILE_FIELDS, 'seventhKnob'].sort()).not.toEqual(schemaKeys);
    expect([...PROFILE_FIELDS].filter((f) => f !== 'model').sort()).not.toEqual(schemaKeys);
  });

  it('labels every field it renders', () => {
    for (const f of PROFILE_FIELDS) expect(PROFILE_FIELD_LABEL[f]).toBeTruthy();
  });

  it('renders a select for exactly the fields the server ships options for', () => {
    // A closed-set field with no select would take free text the write refuses;
    // a free-text field rendered as a select would offer no way to type a model.
    expect([...PROFILE_CHOICE_FIELDS].sort()).toEqual(Object.keys(LAUNCH_PROFILE_OPTIONS).sort());
  });
});

describe('settingsToForm', () => {
  it('renders an absent document as an empty form', () => {
    const f = settingsToForm(null);
    expect(f.maxAgents).toBe('');
    expect(f.maxPerFleet).toBe('');
    expect(f.intendedParallelPlanFleets).toBe('');
    expect(f.defaults.model).toBe('');
    expect(f.roles).toEqual([]);
  });

  it('renders a null ceiling as blank, not as the string "null"', () => {
    // The column is nullable AND optional, so both spellings reach the client.
    expect(settingsToForm({ maxAgents: null }).maxAgents).toBe('');
  });

  it('carries ceilings, defaults and roles in', () => {
    const f = settingsToForm({
      maxAgents: 3,
      maxPerFleet: 2,
      intendedParallelPlanFleets: 4,
      defaults: { model: 'sonnet', carry: 'cold' },
      roles: { engineer: { effort: 'high' } },
    });
    expect(f.maxAgents).toBe('3');
    expect(f.maxPerFleet).toBe('2');
    expect(f.intendedParallelPlanFleets).toBe('4');
    expect(f.defaults.model).toBe('sonnet');
    expect(f.defaults.carry).toBe('cold');
    expect(f.roles).toHaveLength(1);
    expect(f.roles[0]!.role).toBe('engineer');
    expect(f.roles[0]!.effort).toBe('high');
  });

  it('gives each role row a distinct key so renaming one does not remount another', () => {
    const f = settingsToForm({ roles: { a: { model: 'x' }, b: { model: 'y' } } });
    expect(new Set(f.roles.map((r) => r.key)).size).toBe(2);
  });
});

describe('formToSettings', () => {
  it('stores intended concurrent plan fleets as a distinct positive integer', () => {
    const result = formToSettings(form({ intendedParallelPlanFleets: ' 2 ', maxAgents: '12' }));
    expect(result.settings).toMatchObject({ intendedParallelPlanFleets: 2, maxAgents: 12 });
    for (const bad of ['0', '101', '1.5', 'unlimited']) {
      expect(formToSettings(form({ intendedParallelPlanFleets: bad })).problems).toEqual([
        expect.stringContaining('Concurrent plan fleets'),
      ]);
    }
  });
  it('clears the document when nothing is pinned', () => {
    // Not `{}` — "no settings" must be ONE state in the database.
    expect(formToSettings(form()).settings).toBeNull();
  });

  it('omits blank profile fields rather than pinning an empty string', () => {
    // `{ model: '' }` would read back into the form as a value the owner set,
    // while pinning nothing at launch time.
    const r = formToSettings(form({ defaults: { ...form().defaults, model: 'sonnet' } }));
    expect(r.settings).toEqual({ defaults: { model: 'sonnet' } });
  });

  it('trims values', () => {
    const r = formToSettings(form({ defaults: { ...form().defaults, account: '  pool-a  ' } }));
    expect(r.settings).toEqual({ defaults: { account: 'pool-a' } });
  });

  it('parses ceilings as numbers', () => {
    const r = formToSettings(form({ maxAgents: '3', maxPerFleet: '2' }));
    expect(r.settings).toEqual({ maxAgents: 3, maxPerFleet: 2 });
  });

  it('stores the compaction ceiling as a number and reads it back as a string (WI-2140338)', () => {
    // The second non-string profile key: an integer in the document, a string
    // in the form. Both directions, so a one-sided conversion cannot pass.
    const r = formToSettings(form({ defaults: { ...form().defaults, compactionLimit: ' 1000000 ' } }));
    expect(r.problems).toEqual([]);
    expect(r.settings).toEqual({ defaults: { compactionLimit: 1_000_000 } });
    expect(settingsToForm(r.settings).defaults.compactionLimit).toBe('1000000');
    expect(settingsToForm({ roles: { goal: { compactionLimit: 400_000 } } }).roles[0]!.compactionLimit).toBe(
      '400000',
    );
  });

  it('refuses a compaction ceiling the schema would refuse, naming the field and the bounds', () => {
    for (const bad of ['lots', '1.5', String(COMPACTION_LIMIT_MIN - 1), String(COMPACTION_LIMIT_MAX + 1)]) {
      const r = formToSettings(form({ defaults: { ...form().defaults, compactionLimit: bad } }));
      expect(r.settings, bad).toBeNull();
      expect(r.problems, bad).toHaveLength(1);
      expect(r.problems[0], bad).toMatch(/token ceiling/i);
    }
    const role = formToSettings(form({ roles: [{ ...emptyRoleForm(), role: 'goal', compactionLimit: '1' }] }));
    expect(role.problems).toHaveLength(1);
    expect(role.problems[0]).toContain('goal');
  });

  it('pins the client bounds to what launchProfileSchema actually accepts', () => {
    // The bounds are restated on the client so the refusal above can be a
    // sentence; this is the guard that keeps the restatement honest.
    const accepts = (compactionLimit: number) => launchProfileSchema.safeParse({ compactionLimit }).success;
    expect(accepts(COMPACTION_LIMIT_MIN)).toBe(true);
    expect(accepts(COMPACTION_LIMIT_MAX)).toBe(true);
    expect(accepts(COMPACTION_LIMIT_MIN - 1)).toBe(false);
    expect(accepts(COMPACTION_LIMIT_MAX + 1)).toBe(false);
  });

  it('refuses a non-numeric ceiling, and names the one word that IS allowed', () => {
    const r = formToSettings(form({ maxAgents: 'three' }));
    expect(r.settings).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('whole number');
    // The message has to mention the opt-out, or an owner who wants no ceiling
    // has no way to discover the word from the error they just triggered.
    expect(r.problems[0]).toContain('unlimited');
  });

  it('accepts the unlimited literal as a ceiling value (D-015)', () => {
    const r = formToSettings(form({ maxAgents: 'unlimited' }));
    expect(r.problems).toEqual([]);
    expect(r.settings).toEqual({ maxAgents: 'unlimited' });
  });

  it('emits NOTHING for a blank ceiling — blank is "defaulted", never "unlimited"', () => {
    // The two states meet in this one field, so this pins the half that would
    // otherwise regress silently: a blank field must not serialize as an
    // opt-out, or every unedited goal would save itself ungoverned.
    const r = formToSettings(form({ maxAgents: '', maxPerFleet: '' }));
    expect(r.settings).toBeNull();
  });

  it('refuses a zero ceiling, naming what it would do', () => {
    // The one wrong value that looks deliberate: it forbids every launch.
    const r = formToSettings(form({ maxAgents: '0' }));
    expect(r.problems[0]).toContain('at least 1');
  });

  it('refuses a ceiling over the schema maximum', () => {
    expect(formToSettings(form({ maxAgents: '1001' })).problems).toHaveLength(1);
  });

  it('drops a role row the owner started and abandoned', () => {
    const r = formToSettings(form({ roles: [emptyRoleForm()] }));
    expect(r.problems).toEqual([]);
    expect(r.settings).toBeNull();
  });

  it('refuses a profile with no role name', () => {
    const r = formToSettings(form({ roles: [{ ...emptyRoleForm(), model: 'sonnet' }] }));
    expect(r.problems).toEqual(['A role profile has no role name.']);
  });

  it('refuses a named role that pins nothing, rather than silently dropping it', () => {
    const r = formToSettings(form({ roles: [{ ...emptyRoleForm(), role: 'grading' }] }));
    expect(r.problems[0]).toContain('pins no settings');
  });

  it('refuses duplicate role names instead of letting the later row overwrite the earlier', () => {
    const r = formToSettings(
      form({
        roles: [
          { ...emptyRoleForm(), role: 'grading', model: 'a' },
          { ...emptyRoleForm(), role: 'grading', model: 'b' },
        ],
      }),
    );
    expect(r.problems[0]).toContain('twice');
    expect(r.settings).toBeNull();
  });

  it('builds the roles map from named rows', () => {
    const r = formToSettings(
      form({
        maxAgents: '4',
        roles: [{ ...emptyRoleForm(), role: 'grading', effort: 'high' }],
      }),
    );
    expect(r.settings).toEqual({ maxAgents: 4, roles: { grading: { effort: 'high' } } });
  });

  it('round-trips a document unchanged', () => {
    const doc = {
      maxAgents: 5,
      maxPerFleet: 2,
      defaults: { agent: 'claude', model: 'sonnet' },
      roles: { 'plan-fleet-member': { effort: 'high' } },
    };
    expect(formToSettings(settingsToForm(doc)).settings).toEqual(doc);
  });
});

/**
 * D-016 (WI-38048): the form may only emit keys the server can BIND.
 *
 * The bug this closes was not a rejected save — it was an ACCEPTED one. A
 * profile keyed by a psu persona (`engineer`, `su`) stored fine, read back into
 * the panel as configured, and bound nothing at launch. Narrowing the server
 * schema turns that silence into a refusal, and these tests pin the two halves
 * that make the refusal usable: it happens HERE, in terms the owner can act on,
 * and it names the legal vocabulary.
 */
describe('D-016 — role keys are launch slots, not psu personas', () => {
  it('refuses a psu persona as a role key, naming the legal slots', () => {
    const r = formToSettings(
      form({ roles: [{ ...emptyRoleForm(), role: 'engineer', effort: 'high' }] }),
    );
    expect(r.settings).toBeNull();
    expect(r.problems[0]).toContain('is not a launch slot');
    // The message must carry the vocabulary: the field is the owner's only
    // route to it, so a refusal that does not list the slots is a dead end.
    expect(r.problems[0]).toContain('plan-fleet-member');
  });

  it.each(GOAL_LAUNCH_ROLES)('accepts the launch slot %s', (slot) => {
    const r = formToSettings(form({ roles: [{ ...emptyRoleForm(), role: slot, effort: 'high' }] }));
    expect(r.problems).toEqual([]);
    expect(r.settings).toEqual({ roles: { [slot]: { effort: 'high' } } });
  });

  it('offers every slot in the picker, so none is unreachable from the panel', () => {
    // The guard against the real regression: closing the vocabulary server-side
    // while the picker offers a subset would leave a slot bindable in principle
    // and unauthorable in practice.
    expect(GOAL_LAUNCH_ROLE_OPTIONS.map((o) => o.value)).toEqual([...GOAL_LAUNCH_ROLES]);
    for (const o of GOAL_LAUNCH_ROLE_OPTIONS) expect(o.label.trim()).not.toBe('');
  });

  it('still LOADS a legacy free-text key so the owner can see and fix it', () => {
    // Reading is deliberately tolerant: a document written before the
    // vocabulary closed must render, or the owner faces a panel that silently
    // omits the row they need to correct.
    const f = settingsToForm({ roles: { engineer: { effort: 'high' } } });
    expect(f.roles[0]!.role).toBe('engineer');
    // ...and saving it unchanged is what surfaces the problem.
    expect(formToSettings(f).problems[0]).toContain('is not a launch slot');
  });
});

describe('isSettingsDirty', () => {
  it('is false for an untouched form', () => {
    const doc = { maxAgents: 3, defaults: { model: 'sonnet' } };
    expect(isSettingsDirty(settingsToForm(doc), doc)).toBe(false);
  });

  it('is false when a value is retyped identically', () => {
    // Keystrokes are not changes — a Save lit by typing invites a pointless
    // write on every visit.
    const doc = { maxAgents: 3 };
    expect(isSettingsDirty(form({ maxAgents: ' 3 ' }), doc)).toBe(false);
  });

  it('is true when a ceiling changes', () => {
    expect(isSettingsDirty(form({ maxAgents: '4' }), { maxAgents: 3 })).toBe(true);
  });

  it('is true when the form is invalid, so Save can explain why', () => {
    expect(isSettingsDirty(form({ maxAgents: 'x' }), null)).toBe(true);
  });

  it('ignores key order', () => {
    const stored = { maxPerFleet: 2, maxAgents: 3 } as const;
    expect(isSettingsDirty(form({ maxAgents: '3', maxPerFleet: '2' }), stored)).toBe(false);
  });

  it('is true when clearing the last setting', () => {
    expect(isSettingsDirty(form(), { maxAgents: 3 })).toBe(true);
  });
});

describe('settingsSummary', () => {
  const DEFAULTS = { maxAgents: 12, maxPerFleet: 5 };

  it('states the DEFAULT an unset ceiling resolves to, and marks it as a default', () => {
    // Before D-015 this line read "No agent ceiling", which was true then and is
    // a lie now: an unpinned goal is governed. The summary is the only line most
    // visits read, so a stale reading here is the one that would keep an owner
    // believing their goal is unbounded when it is not (or vice versa).
    const s = settingsSummary(null, DEFAULTS);
    expect(s).toContain('Max 12 agents');
    expect(s).toContain('default');
  });

  it('reserves "No agent ceiling" for a DELIBERATE opt-out', () => {
    expect(settingsSummary({ maxAgents: 'unlimited' }, DEFAULTS)).toContain('No agent ceiling');
  });

  it('never renders unset and unlimited as the same sentence', () => {
    expect(settingsSummary(null, DEFAULTS)).not.toBe(settingsSummary({ maxAgents: 'unlimited' }, DEFAULTS));
  });

  it('says the ceiling is unset — not that it is 12 — when no defaults were shipped', () => {
    // A pre-D-015 payload carries no defaults. Printing a number here would be
    // the editor inventing the very value D-011 says it must be told.
    expect(settingsSummary(null)).toBe('Agent ceiling unset · Plan fleet width undecided');
  });

  it('leads with the ceiling in force', () => {
    expect(settingsSummary({ maxAgents: 3 })).toBe('Max 3 agents · Plan fleet width undecided');
    expect(settingsSummary({ maxAgents: 1 })).toBe('Max 1 agent · Plan fleet width undecided');
  });

  it('counts what else is pinned', () => {
    expect(
      settingsSummary({ maxAgents: 3, maxPerFleet: 2, defaults: { model: 'x' }, roles: { e: { effort: 'high' } } }),
    ).toBe('Max 3 agents · 2/fleet · Plan fleet width undecided · 1 default · 1 role profile');
  });
});
