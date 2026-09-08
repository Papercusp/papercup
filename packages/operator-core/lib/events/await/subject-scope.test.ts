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
  buildKey,
  deriveSubjectScope,
  subjectScopeOf,
  familyKeyArity,
  familyAdmitsKey,
  keyMatchesCatalog,
  findRequiredParamPrefixMatch,
  findZeroParamSuffixMismatch,
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

describe('WI-1611805 — the derived ARITY bound on keyMatchesCatalog', () => {
  /**
   * `familyKeyPrefix` truncates at the FIRST placeholder, so `plan:<slug>:<gate>`
   * registered the bare namespace `plan` and `keyMatchesCatalog` answered true for
   * everything under it. The EI-10870 orphan guard consumes that `true` as PROOF AN
   * EMITTER EXISTS, so it was silently OFF across all of `plan:` and `ext:` — the
   * namespaces whose keys are hand-typed from chat, i.e. the case it was built for.
   */
  it('REJECTS a key with too few segments for a placeholder-first family (the bug)', () => {
    // Before this bound every one of these answered `true`, and the orphan guard
    // consumed that as "an emitter exists".
    for (const key of ['plan:typo', 'plan:draft-redy', 'ext:gmail']) {
      expect(keyMatchesCatalog(key), key).toBe(false);
    }
  });

  it('the BARE namespace stays delegated to EI-13089, which words it better', () => {
    // `ext` is exactly a family prefix, so familyAdmitsKey keeps matching it on
    // purpose: findRequiredParamPrefixMatch then names the dropped param instead of
    // the vaguer "nothing emits this key". Asserting the delegation, not just the
    // `true`, is what stops a future "tighten this too" from going silent.
    expect(keyMatchesCatalog('ext')).toBe(true);
    expect(findRequiredParamPrefixMatch('ext')).toBeTruthy();
    // `plan` left this set with the `plan-event` family (WI-1632193). No family
    // has the bare prefix `plan` any more, so the bare key is simply unknown — the
    // orphan guard's own message is now the correct one to get.
    expect(keyMatchesCatalog('plan')).toBe(false);
  });

  it('still admits every real key a free-first-placeholder family produces', () => {
    // 2026-08-31, harness_shared.event_awaits: 1 `ext:` await at 3 segments, ZERO
    // below the bound — which is why the arity tightening stranded no live await.
    expect(keyMatchesCatalog('ext:gmail:message-received')).toBe(true);
  });

  it('WI-1632193 — announced PLAN gates are outside the catalog now, and that strands nothing', () => {
    // These are real live announced-gate keys (816 `plan:` awaits, 15 in flight at
    // 2026-08-31T16:29Z). They stopped matching the catalog when `plan-event` was
    // removed, and NOTHING regressed: an announced gate never reached the EI-10870
    // orphan guard in the first place — await.ts gates it on `!announcedGate` — and
    // is surfaced by the ANNOUNCED section of events:catalog instead.
    //
    // The load-bearing proof that this is the right shape is `fleet:`, which mints
    // the same `<kind>:<ref>:<gate>` keys from buildAnnouncedKey, carries EIGHT
    // literal-prefix families plus thousands of live announced awaits, and has
    // never had a family for the announced shape.
    for (const key of [
      'plan:byoc-cloud-workspaces-gcp-aws-azure-2026-08-22:p026-ownership-repaired',
      'plan:coord-hook-fold-load-repair-2026-08-30:fleet:non-p2p-feature-drain-2026-08-29:wi36147',
    ]) {
      expect(keyMatchesCatalog(key), key).toBe(false);
    }
    // POSITIVE CONTROL — the sibling fleet/harness announced shapes answer the same
    // way, so the `false` above is the uniform rule and not a plan-only quirk.
    expect(keyMatchesCatalog('fleet:my-fleet:phase3-open')).toBe(false);
    expect(keyMatchesCatalog('harness:papercusp:some-gate')).toBe(false);
  });

  it('WI-1632193 — the same-arity typo that used to be IRREDUCIBLE residue is now REJECTED', () => {
    // While `plan-event` (`plan:<slug>:<gate>`) existed, `<slug>` was free, so
    // `plan:draft-redy:x` was a well-formed instance of it and keyMatchesCatalog
    // answered TRUE — silently disarming the orphan guard for a typo of the sibling
    // family `plan-draft-ready`. No arity bound could fix that (no catalog knows
    // that no plan is named `draft-redy`); removing the family is what fixed it.
    expect(keyMatchesCatalog('plan:draft-redy:x')).toBe(false);
    expect(keyMatchesCatalog('plan:total:garbage')).toBe(false);
    // CALIBRATION — the correctly-spelled sibling still matches, so the rejections
    // above are the typo being caught, not the whole namespace going dark.
    expect(keyMatchesCatalog('plan:draft-ready:my-slug')).toBe(true);
  });

  it('leaves both DELEGATED cases permissive, so their better-worded guards still own them', () => {
    // EI-13089 owns the bare-prefix-with-required-param message…
    expect(keyMatchesCatalog('work-item:done')).toBe(true);
    expect(findRequiredParamPrefixMatch('work-item:done')).toBeTruthy();
    // …and P-004/D-002 owns the zero-param-family-with-a-suffix message.
    expect(keyMatchesCatalog('work-item:claimable:papercusp:backlog-drain')).toBe(true);
    expect(findZeroParamSuffixMismatch('work-item:claimable:papercusp:backlog-drain')).toBeTruthy();
    // An optional trailing param still collapses to a real global key (buildKey rule).
    expect(keyMatchesCatalog('release:deployed')).toBe(true);
  });

  it('NEGATIVE CONTROL — the bound is derived from REQUIRED params, not from segment count', () => {
    // Same template, same three segments; only the `required` flags differ. An
    // arity bound that counted placeholders instead would reject the second key,
    // stranding every family whose trailing param legitimately collapses.
    const required = entry({ family: 'r', keyTemplate: 'r:<a>:<b>', params: [param('a'), param('b')] });
    const optional = entry({ family: 'o', keyTemplate: 'o:<a>:<b>', params: [param('a'), param('b', false)] });
    expect(familyKeyArity(required)).toMatchObject({ prefix: 'r', requiredTailSegments: 2, decidable: true });
    expect(familyKeyArity(optional)).toMatchObject({ prefix: 'o', requiredTailSegments: 1, decidable: true });
    expect(keyMatchesCatalog('r:one', [required])).toBe(false);
    expect(keyMatchesCatalog('o:one', [optional])).toBe(true);
  });

  it('NEGATIVE CONTROL — an undecidable template stays PERMISSIVE, never confidently orphaned', () => {
    // A literal after the first placeholder, and a placeholder with no declared
    // param, are both outside what this bound can read. Answering "nothing emits
    // this" there would be the exact failure EI-10870 warns about, so it must not.
    const literalTail = entry({ family: 'lt', keyTemplate: 'lt:<a>:done', params: [param('a')] });
    const undeclared = entry({ family: 'ud', keyTemplate: 'ud:<a>:<b>', params: [param('a')] });
    expect(familyKeyArity(literalTail).decidable).toBe(false);
    expect(familyKeyArity(undeclared).decidable).toBe(false);
    expect(keyMatchesCatalog('lt:anything', [literalTail])).toBe(true);
    expect(keyMatchesCatalog('ud:anything', [undeclared])).toBe(true);
  });

  it('every builtin family still matches its own fully-interpolated key', () => {
    for (const e of EVENT_CATALOG) {
      // An `announcedShape` row documents a runtime-minted key and deliberately
      // matches nothing (WI-1632193) — asserted in its own test below rather than
      // silently skipped, so the exemption cannot hide a real family going dark.
      if (e.announcedShape) continue;
      const params = Object.fromEntries(e.params.map((p) => [p.name, 'x']));
      expect(keyMatchesCatalog(buildKey(e.family, params)), e.family).toBe(true);
    }
  });

  it('WI-1632193 — an announcedShape row is DISCOVERABLE but never MATCHES', () => {
    // The two halves are independent, and both are load-bearing: dropping the first
    // re-opens EI-21666331086562886 (a declared gate nobody could find in the
    // catalog); dropping the second re-opens the `plan:draft-redy:x` typo hole.
    const shapes = EVENT_CATALOG.filter((e) => e.announcedShape);
    expect(shapes.map((e) => e.family)).toEqual(['plan-event', 'fleet-event']);
    for (const e of shapes) {
      // DISCOVERABLE: it is a real catalog row with a real buildable key…
      const params = Object.fromEntries(e.params.map((p) => [p.name, 'x']));
      expect(buildKey(e.family, params), e.family).toContain('x');
      // …but NEVER a membership answer, for its own key or any other under it.
      expect(familyAdmitsKey(e, buildKey(e.family, params)), e.family).toBe(false);
      expect(keyMatchesCatalog(buildKey(e.family, params)), e.family).toBe(false);
    }
  });
});

describe('findFamilyPrefixShadowing', () => {
  /**
   * `familyKeyPrefix` truncates a template at its FIRST placeholder, so a
   * placeholder-first template registers only its bare namespace and
   * `keyMatchesCatalog` then answers true for every key under it — including typos —
   * silently disarming the EI-10870 orphan guard for that whole namespace.
   *
   * ⚠ The builtin set is EMPTY, and that is a fixed state rather than an untested
   * one. `plan-event` (`plan:<slug>:<gate>`) shadowed `plan-draft-ready` until
   * WI-1632193 removed it; the negative control below is SYNTHETIC and permanent,
   * so this detector still fails the build on a newly-added shadowing family even
   * though it now has nothing real to report. Read an empty result here as "the
   * defect is fixed", never as "the detector was switched off".
   */
  it('reports NO shadowing pair in the builtin catalog — the plan-event pair is gone', () => {
    expect(findFamilyPrefixShadowing(EVENT_CATALOG)).toEqual([]);
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
