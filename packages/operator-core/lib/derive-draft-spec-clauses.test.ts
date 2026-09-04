/**
 * Tests for the P-019 draft-clause deriver (design-to-code-coverage-seam-2026-09-02).
 *
 * These exist because of D-008 on the same plan: *a check that does not gate is
 * decoration*. An untested, uncalled pure function is the same defect one step earlier —
 * it cannot be wired with any confidence about what it would write, and a derivation pass
 * over ~825 live mappings is precisely the kind of bulk write nobody wants to discover is
 * wrong after the fact.
 *
 * The assertions below are deliberately split into two kinds, and the distinction matters
 * when one of them fails:
 *
 *   • BEHAVIOUR — what the function computes for a given input. A failure means the
 *     derivation changed.
 *   • PINS — choices D-047 and the module header argue for at length, where the *obvious*
 *     alternative is wrong in a way that is invisible at the call site: `happy-path` and
 *     not `non-automated`; `expectedRevision: 0` always; `falsifier` absent rather than
 *     invented. A failure there is not "the test is stale", it is a load-bearing choice
 *     being reverted, and the comment on each pin says what breaks.
 */
import { describe, expect, it } from 'vitest';

import type { ActivationAuditMapping, PlanItemStatus } from './plan-audits';
import type { SpecClauseWrite } from './agent-tools/plans/spec-clauses-store';
import { REALIZING_DISPOSITIONS } from './plan-requirement-realization';
import {
  DERIVED_DRAFT_BEHAVIOR_CLASS,
  DERIVED_SPEC_ID_PREFIX,
  derivedSpecId,
  deriveDraftSpecClauses,
  describeDerivedDraftClause,
  persistDerivedDraftClauses,
} from './derive-draft-spec-clauses';

const ACTOR = 'su-test';
const PLAN = 'design-to-code-coverage-seam-2026-09-02';

function mapping(over: Partial<ActivationAuditMapping> = {}): ActivationAuditMapping {
  return {
    id: 'M-001',
    sourceRefs: ['session_turn:user:sess-1:12'],
    requirement: 'Completion evidence must resolve against the live tree.',
    planTargets: ['P-001'],
    disposition: 'covered',
    ...over,
  };
}

function item(itemId: string, status: string): PlanItemStatus {
  return { itemId, status, itemText: `text for ${itemId}` };
}

function derive(
  mappings: ActivationAuditMapping[],
  planItems?: PlanItemStatus[],
  over: { harnessSlug?: string } = {},
) {
  return deriveDraftSpecClauses({
    planSlug: PLAN,
    mappings,
    ...(planItems ? { planItems } : {}),
    ...over,
    actorId: ACTOR,
  });
}

describe('deriveDraftSpecClauses — the derivable path', () => {
  it('derives one draft clause per live plan-item target', () => {
    const result = derive([mapping({ planTargets: ['P-001', 'P-002'] })], [item('P-001', 'done'), item('P-002', 'todo')]);

    expect(result.skipped).toEqual([]);
    expect(result.clauses.map((c) => c.planTarget)).toEqual(['P-001', 'P-002']);
    expect(result.clauses[0]?.write.planSlug).toBe(PLAN);
    expect(result.clauses[0]?.write.planItemId).toBe('P-001');
    expect(result.clauses[0]?.write.behavior).toBe(
      'Completion evidence must resolve against the live tree.',
    );
    expect(result.clauses[0]?.write.actorId).toBe(ACTOR);
    expect(result.clauses[0]?.write.lifecycleStatus).toBe('draft');
  });

  it('trims the requirement into `behavior` rather than storing the raw span', () => {
    const [clause] = derive([mapping({ requirement: '  padded requirement  ' })], [item('P-001', 'todo')]).clauses;
    expect(clause?.write.behavior).toBe('padded requirement');
  });

  it('passes `harnessSlug` through when given and OMITS the key entirely when not', () => {
    const withHarness = derive([mapping()], [item('P-001', 'todo')], { harnessSlug: 'papercusp' });
    expect(withHarness.clauses[0]?.write.harnessSlug).toBe('papercusp');

    const without = derive([mapping()], [item('P-001', 'todo')]);
    // `in` rather than a value check: an explicit `harnessSlug: undefined` and an absent
    // key serialize differently once this write reaches the store.
    expect('harnessSlug' in (without.clauses[0]?.write ?? {})).toBe(false);
  });

  it('derives for every realizing disposition, and only those', () => {
    const dispositions: ActivationAuditMapping['disposition'][] = [
      'covered',
      'repaired',
      'rejected',
      'open',
    ];
    for (const disposition of dispositions) {
      const result = derive([mapping({ disposition })], [item('P-001', 'todo')]);
      const derived = result.clauses.length === 1;
      // The set is the single definition of "realizing" (it is exported from
      // plan-requirement-realization precisely so this module cannot hold a second copy).
      // Asserting against the SET rather than a literal list is what keeps this test from
      // becoming the drifting second copy it exists to prevent.
      expect(derived).toBe(REALIZING_DISPOSITIONS.has(disposition));
    }
  });
});

describe('deriveDraftSpecClauses — every skip is reported, never silent', () => {
  it('not-realizing: a rejected/open mapping claims no absorption, so it owes no contract', () => {
    const result = derive([mapping({ disposition: 'rejected' })], [item('P-001', 'todo')]);
    expect(result.clauses).toEqual([]);
    expect(result.skipped).toEqual([{ mappingId: 'M-001', reason: 'not-realizing' }]);
  });

  it('no-plan-item-target: D-NNN / section: targets yield nothing, and that is the honesty filter', () => {
    const result = derive(
      [mapping({ planTargets: ['D-004', 'section:Requirements'] })],
      [item('P-001', 'todo')],
    );
    expect(result.clauses).toEqual([]);
    expect(result.skipped).toEqual([{ mappingId: 'M-001', reason: 'no-plan-item-target' }]);
    // No `planTarget` on this skip: the mapping named none, so reporting one would be an
    // invention of exactly the sort the filter exists to prevent.
    expect(result.skipped[0]).not.toHaveProperty('planTarget');
  });

  it('target-not-in-plan: a P-NNN the plan no longer contains is skipped WITH its target', () => {
    const result = derive([mapping({ planTargets: ['P-999'] })], [item('P-001', 'todo')]);
    expect(result.clauses).toEqual([]);
    expect(result.skipped).toEqual([
      { mappingId: 'M-001', planTarget: 'P-999', reason: 'target-not-in-plan' },
    ]);
  });

  it('target-dropped: a consciously abandoned item is moot, not missing', () => {
    const result = derive([mapping({ planTargets: ['P-001'] })], [item('P-001', 'dropped')]);
    expect(result.clauses).toEqual([]);
    expect(result.skipped).toEqual([
      { mappingId: 'M-001', planTarget: 'P-001', reason: 'target-dropped' },
    ]);
  });

  it('empty-requirement: a blank requirement is reported here, not dropped by the DB check', () => {
    const result = derive([mapping({ requirement: '   ' })], [item('P-001', 'todo')]);
    expect(result.clauses).toEqual([]);
    expect(result.skipped).toEqual([
      { mappingId: 'M-001', planTarget: 'P-001', reason: 'empty-requirement' },
    ]);
  });

  it('reports one skip PER TARGET, so a partly-derivable mapping is not all-or-nothing', () => {
    const result = derive(
      [mapping({ planTargets: ['P-001', 'P-002', 'P-999'] })],
      [item('P-001', 'todo'), item('P-002', 'dropped')],
    );
    expect(result.clauses.map((c) => c.planTarget)).toEqual(['P-001']);
    expect(result.skipped).toEqual([
      { mappingId: 'M-001', planTarget: 'P-002', reason: 'target-dropped' },
      { mappingId: 'M-001', planTarget: 'P-999', reason: 'target-not-in-plan' },
    ]);
  });
});

describe('deriveDraftSpecClauses — liveness is fail-OPEN, and the store is the backstop', () => {
  // D-040's rule: `getPlanItemStatuses` fails toward `[]`, so an empty list means UNKNOWN,
  // not "this plan has no items". Skipping every mapping on an unknown list would silently
  // derive nothing for a whole plan whenever that read failed — the failure would look
  // exactly like a plan with no realizing mappings.
  it('an ABSENT planItems list disables the liveness filters rather than skipping everything', () => {
    const result = derive([mapping({ planTargets: ['P-999'] })]);
    expect(result.skipped).toEqual([]);
    expect(result.clauses.map((c) => c.planTarget)).toEqual(['P-999']);
  });

  it('an EMPTY planItems list is treated as unknown, identically to absent', () => {
    const result = derive([mapping({ planTargets: ['P-999'] })], []);
    expect(result.skipped).toEqual([]);
    expect(result.clauses).toHaveLength(1);
  });

  it('still refuses a blank requirement when liveness is unknown', () => {
    // The fail-open covers LIVENESS only. `behavior` has a non-empty DB check, so failing
    // open on it would push a guaranteed rejection down to the write.
    const result = derive([mapping({ requirement: '' })]);
    expect(result.clauses).toEqual([]);
    expect(result.skipped).toEqual([
      { mappingId: 'M-001', planTarget: 'P-001', reason: 'empty-requirement' },
    ]);
  });
});

describe('derivedSpecId — deterministic identity', () => {
  it('is stable across calls, which is what makes re-derivation idempotent', () => {
    expect(derivedSpecId('M-001', 'P-001')).toBe(derivedSpecId('M-001', 'P-001'));
  });

  it('is distinct per (mapping, target) pair', () => {
    const ids = new Set([
      derivedSpecId('M-001', 'P-001'),
      derivedSpecId('M-001', 'P-002'),
      derivedSpecId('M-002', 'P-001'),
    ]);
    expect(ids.size).toBe(3);
  });

  it('carries the AUTO-REQ prefix so a derived clause is distinguishable from a hand-authored one', () => {
    expect(derivedSpecId('M-001', 'P-001').startsWith(`${DERIVED_SPEC_ID_PREFIX}-`)).toBe(true);
  });

  it('collapses non-identifier characters and never emits leading/trailing separators', () => {
    const id = derivedSpecId('  mapping #1 / draft  ', 'P-001');
    expect(id).toBe('AUTO-REQ-mapping-1-draft-P-001');
    expect(id).not.toMatch(/--/);
  });

  it('falls back to UNKNOWN rather than producing an empty identity segment', () => {
    expect(derivedSpecId('///', 'P-001')).toBe('AUTO-REQ-UNKNOWN-P-001');
    expect(derivedSpecId('', 'P-001')).toBe('AUTO-REQ-UNKNOWN-P-001');
  });

  it('the clause it derives uses that same id as its specId', () => {
    const [clause] = derive([mapping({ id: 'M-042' })], [item('P-001', 'todo')]).clauses;
    expect(clause?.specId).toBe(derivedSpecId('M-042', 'P-001'));
    expect(clause?.write.specId).toBe(clause?.specId);
  });
});

describe('deriveDraftSpecClauses — the pins (reverting one of these is a behaviour change, not a test staleness)', () => {
  it('PIN: behaviorClass is `happy-path`, NOT `non-automated`', () => {
    // `non-automated` reads like a natural "unclassified" bucket and is the wrong default:
    // in this codebase it ASSERTS the behaviour genuinely cannot be automatically tested
    // (spec-quality pairs it with lifecycleStatus 'exempt'). Defaulting to it would make
    // ~825 derived drafts quietly claim un-automatability, which is a claim nobody made.
    expect(DERIVED_DRAFT_BEHAVIOR_CLASS).toBe('happy-path');
    const [clause] = derive([mapping()], [item('P-001', 'todo')]).clauses;
    expect(clause?.write.behaviorClass).toBe('happy-path');
    expect(clause?.write.behaviorClass).not.toBe('non-automated');
  });

  it('PIN: `falsifier` is absent, never invented from the requirement sentence', () => {
    // A falsifier's whole point is that none can be written for a vacuous promise.
    // Generating one from a requirement would manufacture exactly the vacuity the field
    // filters — the fabricated traceability D-035 rejected.
    const [clause] = derive([mapping()], [item('P-001', 'todo')]).clauses;
    expect('falsifier' in (clause?.write ?? {})).toBe(false);
  });

  it('PIN: every write carries `expectedRevision: 0`, so a refined clause is never clobbered', () => {
    // 0 means "this only ever CREATES". If someone already revised the clause at this id,
    // setSpecClause answers `conflict` and the derived write is discarded. Losing a derived
    // draft costs nothing; overwriting a human's refinement costs the thing this creates.
    const result = derive(
      [mapping({ planTargets: ['P-001', 'P-002'] })],
      [item('P-001', 'todo'), item('P-002', 'todo')],
    );
    expect(result.clauses).toHaveLength(2);
    for (const clause of result.clauses) {
      expect(clause.write.expectedRevision).toBe(0);
    }
  });

  it('PIN: every derived clause is `draft`, which is what makes bulk derivation unable to gate', () => {
    // plan-spec-coverage-gate enforces only {accepted, active}. If this ever emitted an
    // enforceable lifecycle, a derivation pass could refuse other plans' ships.
    const result = derive(
      [mapping({ planTargets: ['P-001', 'P-002'] })],
      [item('P-001', 'todo'), item('P-002', 'todo')],
    );
    for (const clause of result.clauses) {
      expect(clause.write.lifecycleStatus).toBe('draft');
    }
  });

  it('is PURE — the same input derives the same result twice, and inputs are not mutated', () => {
    const mappings = [mapping({ planTargets: ['P-001'] })];
    const items = [item('P-001', 'todo')];
    const frozen = JSON.stringify({ mappings, items });

    const first = derive(mappings, items);
    const second = derive(mappings, items);

    expect(second).toEqual(first);
    expect(JSON.stringify({ mappings, items })).toBe(frozen);
  });
});

describe('persistDerivedDraftClauses — counts every disposition, throws on none', () => {
  function writer(statuses: string[]) {
    const seen: SpecClauseWrite[] = [];
    let i = 0;
    return {
      seen,
      write: async (clause: SpecClauseWrite) => {
        seen.push(clause);
        return { status: statuses[i++] ?? 'created' };
      },
    };
  }

  const twoTargets = [mapping({ planTargets: ['P-001', 'P-002'] })];
  const twoItems = [item('P-001', 'todo'), item('P-002', 'todo')];

  it('counts created writes and carries the derivation skips through', async () => {
    const w = writer(['created', 'created']);
    const outcome = await persistDerivedDraftClauses(
      { planSlug: PLAN, mappings: [...twoTargets, mapping({ id: 'M-002', disposition: 'open' })], planItems: twoItems, actorId: ACTOR },
      w.write,
    );

    expect(outcome).toMatchObject({ attempted: 2, created: 2, unchanged: 0, conflicted: 0, refused: [] });
    expect(outcome.skipped).toEqual([{ mappingId: 'M-002', reason: 'not-realizing' }]);
    expect(w.seen.map((c) => c.planItemId)).toEqual(['P-001', 'P-002']);
  });

  it('counts `unchanged` separately — the idempotent steady state on re-audit', async () => {
    const w = writer(['unchanged', 'unchanged']);
    const outcome = await persistDerivedDraftClauses(
      { planSlug: PLAN, mappings: twoTargets, planItems: twoItems, actorId: ACTOR },
      w.write,
    );
    expect(outcome).toMatchObject({ attempted: 2, created: 0, unchanged: 2 });
  });

  it('counts `conflict` as the design working: a refined clause is NOT clobbered', async () => {
    // This is the whole point of expectedRevision: 0. A conflict means a human already
    // revised that clause, so the derived draft is discarded — it must not read as an
    // error, or the next reader will "fix" it by bumping the revision and overwriting.
    const w = writer(['conflict', 'created']);
    const outcome = await persistDerivedDraftClauses(
      { planSlug: PLAN, mappings: twoTargets, planItems: twoItems, actorId: ACTOR },
      w.write,
    );
    expect(outcome).toMatchObject({ attempted: 2, conflicted: 1, created: 1, refused: [] });
  });

  it('reports any other store refusal WITH its status rather than swallowing it', async () => {
    const w = writer(['plan_item_not_found', 'created']);
    const outcome = await persistDerivedDraftClauses(
      { planSlug: PLAN, mappings: twoTargets, planItems: twoItems, actorId: ACTOR },
      w.write,
    );
    expect(outcome.refused).toEqual([
      { specId: derivedSpecId('M-001', 'P-001'), status: 'plan_item_not_found' },
    ]);
    expect(outcome.created).toBe(1);
  });

  it('writes nothing at all when every mapping was skipped', async () => {
    const w = writer([]);
    const outcome = await persistDerivedDraftClauses(
      { planSlug: PLAN, mappings: [mapping({ disposition: 'rejected' })], planItems: twoItems, actorId: ACTOR },
      w.write,
    );
    expect(w.seen).toEqual([]);
    expect(outcome).toMatchObject({ attempted: 0, created: 0 });
    expect(outcome.skipped).toHaveLength(1);
  });
});

describe('describeDerivedDraftClause', () => {
  it('renders the identity, target, source mapping and behaviour on one line', () => {
    const [clause] = derive([mapping({ id: 'M-007' })], [item('P-001', 'todo')]).clauses;
    const line = describeDerivedDraftClause(clause!);
    expect(line).toContain(clause!.specId);
    expect(line).toContain('P-001');
    expect(line).toContain('M-007');
    expect(line).toContain('draft');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('elides a long behaviour so a bulk report stays one line per entry', () => {
    const long = 'x'.repeat(200);
    const [clause] = derive([mapping({ requirement: long })], [item('P-001', 'todo')]).clauses;
    const line = describeDerivedDraftClause(clause!);
    expect(line).toContain(`${'x'.repeat(77)}...`);
    expect(line).not.toContain('x'.repeat(81));
  });

  it('leaves a short behaviour intact', () => {
    const [clause] = derive([mapping({ requirement: 'short' })], [item('P-001', 'todo')]).clauses;
    expect(describeDerivedDraftClause(clause!)).toContain('"short"');
  });
});
