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
  LAUNCH_PROFILE_OPTIONS,
} from '@papercusp/operator-core/lib/goal-launch-settings';
import {
  emptyRoleForm,
  formToSettings,
  isSettingsDirty,
  settingsSummary,
  settingsToForm,
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
      defaults: { model: 'sonnet', carry: 'cold' },
      roles: { engineer: { effort: 'high' } },
    });
    expect(f.maxAgents).toBe('3');
    expect(f.maxPerFleet).toBe('2');
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

  it('refuses a non-numeric ceiling', () => {
    const r = formToSettings(form({ maxAgents: 'three' }));
    expect(r.settings).toBeNull();
    expect(r.problems).toEqual(['Max agents must be a whole number.']);
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
    const r = formToSettings(form({ roles: [{ ...emptyRoleForm(), role: 'engineer' }] }));
    expect(r.problems[0]).toContain('pins no settings');
  });

  it('refuses duplicate role names instead of letting the later row overwrite the earlier', () => {
    const r = formToSettings(
      form({
        roles: [
          { ...emptyRoleForm(), role: 'engineer', model: 'a' },
          { ...emptyRoleForm(), role: 'engineer', model: 'b' },
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
        roles: [{ ...emptyRoleForm(), role: 'engineer', effort: 'high' }],
      }),
    );
    expect(r.settings).toEqual({ maxAgents: 4, roles: { engineer: { effort: 'high' } } });
  });

  it('round-trips a document unchanged', () => {
    const doc = {
      maxAgents: 5,
      maxPerFleet: 2,
      defaults: { agent: 'claude', model: 'sonnet' },
      roles: { engineer: { effort: 'high' } },
    };
    expect(formToSettings(settingsToForm(doc)).settings).toEqual(doc);
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
  it('states an unset ceiling as unlimited rather than omitting it', () => {
    // The absence of a limit is the thing most worth seeing.
    expect(settingsSummary(null)).toBe('No agent ceiling');
  });

  it('leads with the ceiling in force', () => {
    expect(settingsSummary({ maxAgents: 3 })).toBe('Max 3 agents');
    expect(settingsSummary({ maxAgents: 1 })).toBe('Max 1 agent');
  });

  it('counts what else is pinned', () => {
    expect(
      settingsSummary({ maxAgents: 3, maxPerFleet: 2, defaults: { model: 'x' }, roles: { e: { effort: 'high' } } }),
    ).toBe('Max 3 agents · 2/fleet · 1 default · 1 role profile');
  });
});
