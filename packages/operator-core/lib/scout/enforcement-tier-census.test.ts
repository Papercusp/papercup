/**
 * enforcement-tier-census.test.ts — plan coordination-spec-adoption-2026-08-03, P-002.
 *
 * The properties worth pinning are not "does it add up" but the two directions in
 * which this census can silently stop being true:
 *   - a NEW coordination verb must surface as tier debt without anyone listing it;
 *   - a declaration for a RENAMED/DELETED verb must be caught, because it keeps
 *     asserting enforcement that no longer exists and nothing else would notice.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEnforcementTierCensus,
  selectCoordBehaviours,
  findStaleDeclarations,
  DECLARED_COORD_TIERS,
  ENFORCEMENT_TIER_RANK,
  UNDECLARED,
  type BehaviourAdoption,
  type TierDeclaration,
} from './enforcement-tier-census';
import { buildBuiltinToolCatalog } from '../static-tool-catalog';

const adoption = (m: Record<string, BehaviourAdoption>): ReadonlyMap<string, BehaviourAdoption> =>
  new Map(Object.entries(m));

const declared = (m: Record<string, TierDeclaration>): ReadonlyMap<string, TierDeclaration> =>
  new Map(Object.entries(m));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('buildEnforcementTierCensus', () => {
  it('reports an unlisted behaviour as tier DEBT rather than omitting it', () => {
    // The core anti-drift property: the behaviour list comes from the scan, so a
    // verb nobody declared still gets a row — it cannot vanish by being forgotten.
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:brand-new-verb'],
      adoption: adoption({ 'coord:send': { calls: 1611, callers: 149 } }),
      windowDays: 7,
      declared: declared({
        'coord:send': { tier: 'schema-refusal', evidence: 'envelope validated at the tool boundary' },
      }),
    });

    const fresh = c.rows.find((r) => r.id === 'coord:brand-new-verb');
    expect(fresh).toBeDefined();
    expect(fresh?.tier).toBe(UNDECLARED);
    expect(fresh?.tierDebt).toBe(true);
    expect(fresh?.tierRank).toBeNull();
    expect(fresh?.evidence).toBeNull();
    expect(c.totals.undeclared).toBe(1);
    expect(c.totals.declared).toBe(1);
  });

  it('treats a behaviour absent from adoption as ZERO calls, not unknown', () => {
    // Absence from tool_invocations over the window IS the measurement — the zero
    // is the finding. Modelling it as "unknown" would let a dead verb hide.
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:vote'],
      adoption: adoption({}),
      windowDays: 7,
    });
    expect(c.rows[0].calls).toBe(0);
    expect(c.rows[0].callers).toBe(0);
    expect(c.totals.zeroCall).toBe(1);
  });

  it('flags a zero-call unenforced behaviour as a retirement CANDIDATE', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:vote'],
      adoption: adoption({}),
      windowDays: 7,
      declared: declared({ 'coord:vote': { tier: 'prompt-only', evidence: 'the playbook mentions it' } }),
    });
    expect(c.rows[0].retirementCandidate).toBe(true);
    expect(c.totals.retirementCandidates).toBe(1);
  });

  it('does NOT flag a zero-call behaviour that carries real enforcement', () => {
    // A tier-1–3 behaviour at zero calls is a DIFFERENT finding (built but
    // unreached), and D-001's retirement rule is explicitly about the ones that
    // cannot be given a tier. Conflating them would propose retiring working
    // machinery.
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:emit'],
      adoption: adoption({}),
      windowDays: 7,
      declared: declared({ 'coord:emit': { tier: 'auto-stamp', evidence: 'stamped at the emit chokepoint' } }),
    });
    expect(c.rows[0].calls).toBe(0);
    expect(c.rows[0].retirementCandidate).toBe(false);
    expect(c.totals.zeroCall).toBe(1);
    expect(c.totals.retirementCandidates).toBe(0);
  });

  it('leaves prompt-only UNRANKED and out of the enforced count (D-016: a prompt is not a tier)', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:walls'],
      adoption: adoption({ 'coord:walls': { calls: 3, callers: 2 } }),
      windowDays: 7,
      declared: declared({ 'coord:walls': { tier: 'prompt-only', evidence: 'prose only' } }),
    });
    expect(c.rows[0].tierRank).toBeNull();
    expect(c.totals.promptOnly).toBe(1);
    expect(c.totals.enforced).toBe(0);
    // Still "declared" — we know what enforces it (nothing). That is not the same
    // as the D-016/D-047 debt of never having been assessed.
    expect(c.totals.declared).toBe(1);
    expect(c.rows[0].tierDebt).toBe(false);
  });

  it('names a denominator for every ratio a reader could compute (D-003)', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:read', 'coord:vote'],
      adoption: adoption({ 'coord:send': { calls: 1611, callers: 149 }, 'coord:read': { calls: 15, callers: 6 } }),
      windowDays: 7,
      declared: declared({
        'coord:send': { tier: 'schema-refusal', evidence: 'envelope validated at the boundary' },
      }),
    });
    expect(c.totals.behaviours).toBe(3);
    expect(c.totals.declared + c.totals.undeclared).toBe(c.totals.behaviours);
    expect(c.windowDays).toBe(7);
  });

  it('sorts strongest-first so the undeclared debt lands together at the bottom', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:zeta', 'coord:send', 'coord:alpha'],
      adoption: adoption({}),
      windowDays: 7,
      declared: declared({
        'coord:send': { tier: 'schema-refusal', evidence: 'boundary' },
      }),
    });
    expect(c.rows.map((r) => r.id)).toEqual(['coord:send', 'coord:alpha', 'coord:zeta']);
  });

  it('de-duplicates a name the scan sees twice', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:send'],
      adoption: adoption({ 'coord:send': { calls: 5, callers: 1 } }),
      windowDays: 7,
    });
    expect(c.rows).toHaveLength(1);
    expect(c.totals.behaviours).toBe(1);
  });
});

describe('selectCoordBehaviours', () => {
  it('keeps only the coord namespace and sorts', () => {
    expect(selectCoordBehaviours(['work_items:get', 'coord:send', 'plans:get', 'coord:ack'])).toEqual([
      'coord:ack',
      'coord:send',
    ]);
  });
});

describe('findStaleDeclarations', () => {
  it('catches a declaration whose verb no longer exists', () => {
    expect(
      findStaleDeclarations(
        ['coord:send'],
        declared({
          'coord:send': { tier: 'schema-refusal', evidence: 'boundary' },
          'coord:renamed-away': { tier: 'auto-stamp', evidence: 'stale' },
        }),
      ),
    ).toEqual(['coord:renamed-away']);
  });

  /**
   * THE GUARD THAT ACTUALLY BINDS. Runs against the REAL repo scan, so a rename
   * or deletion of a declared coordination verb fails here instead of leaving the
   * census quietly asserting enforcement for a name that no longer exists.
   */
  it('has no stale declarations against the real tool catalog', () => {
    const catalog = buildBuiltinToolCatalog(REPO_ROOT);
    // Guard the guard: if the scan ever returns nothing the assertion below would
    // pass vacuously while proving the opposite of what it claims.
    expect(selectCoordBehaviours(catalog).length).toBeGreaterThan(20);
    expect(findStaleDeclarations(catalog)).toEqual([]);
  });

  it('every declaration carries concrete non-empty evidence', () => {
    // A declaration without a stated mechanism reads as covered while asserting
    // nothing falsifiable — worse than leaving it undeclared, which at least
    // counts as debt.
    for (const [id, d] of DECLARED_COORD_TIERS) {
      expect(d.evidence.trim().length, `${id} must state what enforces it`).toBeGreaterThan(20);
      expect(ENFORCEMENT_TIER_RANK).toHaveProperty(d.tier);
    }
  });
});
