/**
 * subject-scope.test — EI-19299170840541307.
 *
 * `events:catalog` told you a family EXISTS and what its key template is. It did not
 * tell you the thing a subscriber most needs before parking: CAN I USE THIS KEY IF I
 * DON'T ALREADY KNOW THE SUBJECT? Three populations were silently mixed (id-scoped /
 * scope-keyed / global), so NAME-MATCHING READ AS CAPABILITY-MATCHING — which is how
 * P-009 of `fleet-leadership-continuity-and-actuation-2026-08-01` was surveyed as
 * "~60% already built" when the real figure was one of five.
 *
 * These tests pin the two halves of the fix:
 *   1. the DERIVATION agrees with the key templates it describes, and reports
 *      `'unknown'` rather than a confident default when it cannot classify;
 *   2. the CATALOG-vs-ITSELF invariants (prefix shadowing, redundant overrides).
 *
 * ⚠ EVERY GUARD HERE CARRIES A PERMANENT NEGATIVE CONTROL — a deliberately-wrong
 * fixture asserted to be CAUGHT. A guard that has only ever been run against correct
 * input is a guard nobody has tested, and the repo's mutation-probe rule forbids
 * proving that by mutating the shared tree. The controls live here instead, so they
 * cannot be raced by git-sync and cannot be left behind by a failed restore.
 */

import { describe, it, expect } from 'vitest';
import {
  EVENT_CATALOG,
  SUBJECT_SCOPE_GLOSS,
  deriveSubjectScope,
  subjectScopeOf,
  findUnknownSubjectScopes,
  findFamilyPrefixShadowing,
  findRedundantSubjectScopeOverrides,
  renderCatalog,
  type EventCatalogEntry,
  type SubjectScope,
} from './catalog';

/** A minimal well-formed entry; each test overrides only what it is probing. */
function entry(over: Partial<EventCatalogEntry> = {}): EventCatalogEntry {
  return {
    family: 'probe',
    keyTemplate: 'probe:fired',
    params: [],
    describe: 'probe',
    emitter: 'probe',
    exists: true,
    ...over,
  };
}

const param = (name: string, required = true) => ({ name, required, describe: name });

describe('deriveSubjectScope', () => {
  it('classifies a family with no required params as global', () => {
    expect(deriveSubjectScope(entry({ params: [] }))).toBe('global');
    expect(deriveSubjectScope(entry({ params: [param('sha', false)] }))).toBe('global');
  });

  it('classifies a required id-shaped param as id-scoped', () => {
    expect(deriveSubjectScope(entry({ params: [param('id')] }))).toBe('id');
    expect(deriveSubjectScope(entry({ params: [param('runId')] }))).toBe('id');
    expect(deriveSubjectScope(entry({ params: [param('rubricRef')] }))).toBe('scope');
  });

  it('classifies a required scope-shaped param as scope-keyed', () => {
    expect(deriveSubjectScope(entry({ params: [param('slug')] }))).toBe('scope');
    expect(deriveSubjectScope(entry({ params: [param('workspace')] }))).toBe('scope');
  });

  it('treats a required ENUM discriminator as globally reachable', () => {
    // `governor:transition:<kind>` requires a param, but you can enumerate the kinds
    // without holding any subject — so the family is reachable by anyone.
    expect(deriveSubjectScope(entry({ params: [param('kind')] }))).toBe('global');
    expect(deriveSubjectScope(entry({ params: [param('status')] }))).toBe('global');
  });

  it('lets a required ID outrank a required SCOPE — the id is the binding constraint', () => {
    // `plan-item:done:<slug>:<id>`: knowing the plan does not help; you still need the id.
    expect(deriveSubjectScope(entry({ params: [param('slug'), param('id')] }))).toBe('id');
  });

  it('NEGATIVE CONTROL — an unrecognised required param derives `unknown`, never `id`', () => {
    // The whole point: a confident default would reproduce this item's bug one level
    // down, giving a value that reads as a capability statement while actually meaning
    // "nobody classified this".
    expect(deriveSubjectScope(entry({ params: [param('wibbleBucket')] }))).toBe('unknown');
    expect(deriveSubjectScope(entry({ params: [param('slug'), param('wibbleBucket')] }))).toBe('unknown');
  });
});

describe('the builtin catalog', () => {
  it('classifies EVERY family — zero unknowns', () => {
    // The population-reporting half: a green catalog must never mean "we did not look".
    expect(findUnknownSubjectScopes(EVENT_CATALOG)).toEqual([]);
  });

  it('NEGATIVE CONTROL — an unclassifiable family IS reported, with its offending params', () => {
    const rows = findUnknownSubjectScopes([
      ...EVENT_CATALOG,
      entry({ family: 'probe-unknown', keyTemplate: 'probe:x:<wibbleBucket>', params: [param('wibbleBucket')] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ family: 'probe-unknown', unclassifiedParams: ['wibbleBucket'] });
  });

  it('keeps the three populations non-empty and accounted for', () => {
    const census = EVENT_CATALOG.reduce<Record<string, number>>((acc, e) => {
      const s = subjectScopeOf(e);
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    // Stated as a partition over the whole registry rather than as pinned magic
    // numbers, so adding a family does not fail this test for the wrong reason.
    expect((census.id ?? 0) + (census.scope ?? 0) + (census.global ?? 0)).toBe(EVENT_CATALOG.length);
    expect(census.id).toBeGreaterThan(0);
    expect(census.scope).toBeGreaterThan(0);
    expect(census.global).toBeGreaterThan(0);
  });

  it('classifies the exact families whose misreading cost the P-009 survey', () => {
    const scopeOf = (family: string) => {
      const e = EVENT_CATALOG.find((x) => x.family === family);
      if (!e) throw new Error(`no such family: ${family}`);
      return subjectScopeOf(e);
    };
    // The two that a fleet LEADER cannot use — it does not know which item moves next.
    expect(scopeOf('claim-released')).toBe('id');
    expect(scopeOf('work-item-done')).toBe('id');
    // The one that genuinely was usable, and the fleet-scoped counterparts built since.
    expect(scopeOf('work-item-claimable')).toBe('global');
    expect(scopeOf('fleet-claim-released')).toBe('scope');
    expect(scopeOf('fleet-item-completed')).toBe('scope');
  });

  it('carries no redundant subjectScope override', () => {
    // An override that merely restates the derivation is a second copy of a truth the
    // template already owns — the drift the derived field exists to prevent.
    expect(findRedundantSubjectScopeOverrides(EVENT_CATALOG)).toEqual([]);
  });

  it('NEGATIVE CONTROL — a redundant override IS reported', () => {
    const rows = findRedundantSubjectScopeOverrides([
      entry({ family: 'probe-redundant', params: [param('id')], subjectScope: 'id' }),
    ]);
    expect(rows).toEqual([{ family: 'probe-redundant', declared: 'id', derived: 'id' }]);
  });

  it('honours a NON-redundant override without reporting it', () => {
    const e = entry({ family: 'probe-override', params: [param('id')], subjectScope: 'global' });
    expect(deriveSubjectScope(e)).toBe('id');
    expect(subjectScopeOf(e)).toBe('global');
    expect(findRedundantSubjectScopeOverrides([e])).toEqual([]);
  });
});

describe('findFamilyPrefixShadowing', () => {
  /**
   * `familyKeyPrefix` truncates a template at its FIRST placeholder, so a
   * placeholder-first template registers only its bare namespace and
   * `keyMatchesCatalog` then answers true for every key under it — including typos —
   * silently disarming the EI-10870 orphan guard for that whole namespace.
   *
   * ⚠ This is the KNOWN-LIVE set, not an aspiration. `plan-event`
   * (`plan:<slug>:<gate>`) shadows `plan-draft-ready` today. Pinning it means a NEW
   * shadowing family fails the build while this one stays visible rather than being
   * quietly normalised into the background.
   */
  it('reports exactly the known shadowing pair in the builtin catalog', () => {
    expect(findFamilyPrefixShadowing(EVENT_CATALOG)).toEqual([
      { shadower: 'plan-event', shadowerPrefix: 'plan', shadowed: 'plan-draft-ready', shadowedPrefix: 'plan:draft-ready' },
    ]);
  });

  it('NEGATIVE CONTROL — a newly-added placeholder-first family that swallows a sibling IS caught', () => {
    const rows = findFamilyPrefixShadowing([
      entry({ family: 'probe-wide', keyTemplate: 'probe:<slug>:<gate>', params: [param('slug'), param('gate')] }),
      entry({ family: 'probe-narrow', keyTemplate: 'probe:specific:<slug>', params: [param('slug')] }),
    ]);
    expect(rows).toContainEqual({
      shadower: 'probe-wide',
      shadowerPrefix: 'probe',
      shadowed: 'probe-narrow',
      shadowedPrefix: 'probe:specific',
    });
  });

  it('does NOT flag sibling namespaces that merely share a textual prefix', () => {
    // `plan` must shadow `plan:x` but NOT the unrelated top-level family `plan-item:…`.
    const rows = findFamilyPrefixShadowing([
      entry({ family: 'a', keyTemplate: 'plan:<slug>:<gate>', params: [param('slug'), param('gate')] }),
      entry({ family: 'b', keyTemplate: 'plan-item:done:<id>', params: [param('id')] }),
    ]);
    expect(rows).toEqual([]);
  });
});

describe('renderCatalog', () => {
  it('emits subject_scope and its gloss on EVERY row, unconditionally', () => {
    const rows = renderCatalog();
    expect(rows.length).toBe(EVENT_CATALOG.length);
    for (const r of rows) {
      expect(['id', 'global', 'scope', 'unknown']).toContain(r.subject_scope);
      expect(typeof r.subject_scope_gloss).toBe('string');
      expect(r.subject_scope_gloss.length).toBeGreaterThan(0);
    }
  });

  it('renders the gloss that matches each value', () => {
    for (const r of renderCatalog()) {
      expect(r.subject_scope_gloss).toBe(SUBJECT_SCOPE_GLOSS[r.subject_scope as SubjectScope]);
    }
  });

  it('renders an unclassifiable INSTALLED family as `unknown`, not as a confident guess', () => {
    const rows = renderCatalog([
      {
        unit: 'probe-pack',
        events: [
          {
            family: 'probe-pack-family',
            keyTemplate: 'probe-pack:x:<wibbleBucket>',
            params: [param('wibbleBucket')],
            describe: 'probe',
          },
        ],
      },
    ]);
    const row = rows.find((r) => r.family === 'probe-pack-family');
    expect(row).toBeDefined();
    expect(row!.subject_scope).toBe('unknown');
    // The gloss must say it is UNMEASURED — never silently read as global.
    expect(row!.subject_scope_gloss).toMatch(/NOT CLASSIFIABLE/);
  });
});
