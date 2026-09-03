/**
 * dependency-invariants.test.ts — the registry's own guard rails.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-001).
 *
 * A registry of invariants is only useful if it cannot rot silently. The risks
 * are specific: an id gets renumbered and every citation to it becomes a lie; an
 * entry loses its provenance and the next reader relaxes it; a typo'd `@covers`
 * citation reads as coverage when it proves nothing.
 *
 * Pure data + pure functions, no PG, no process spawning — this file must stay
 * runnable in the unit tier. The ONE exception is the `binds` existence check
 * below, which does synchronous local `existsSync` calls against the repo. That
 * is deliberate: a `binds` entry naming a file that does not exist is precisely
 * the rot this suite is for, and it is not detectable without touching the
 * filesystem. No PG, no network, no subprocess — the unit-tier contract holds.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/dependency-invariants.test.ts
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_INVARIANTS,
  DEPENDENCY_INVARIANT_COUNT,
  DEPENDENCY_POLICY_RULES,
  DEPENDENCY_POLICY_RULE_COUNT,
  DEPENDENCY_POLICY_SURFACES,
  coveredInvariants,
  dependencyPoliciesByClassification,
  getDependencyPolicy,
  getInvariant,
  invariantsBindingPath,
  invariantsByArea,
  uncoveredInvariantIds,
  unknownCoveredIds,
} from './dependency-invariants';

describe('dependency invariant registry — shape', () => {
  it('has unique, well-formed, densely-numbered ids', () => {
    const ids = DEPENDENCY_INVARIANTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^INV-\d{2}$/);
    // Dense numbering: a gap means an invariant was DELETED rather than superseded.
    // Deleting one silently invalidates every test that cited it, so make it loud.
    const nums = ids.map((i) => Number(i.slice(4))).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, k) => k + 1));
  });

  it('states every invariant as a proposition with a concrete violation and real provenance', () => {
    for (const inv of DEPENDENCY_INVARIANTS) {
      // A one-word "statement" is how a registry decays into a checklist.
      expect(inv.statement.length, `${inv.id} statement`).toBeGreaterThan(40);
      expect(inv.violationLooksLike.length, `${inv.id} violationLooksLike`).toBeGreaterThan(40);
      expect(inv.binds.length, `${inv.id} binds`).toBeGreaterThan(0);
      // Provenance is what stops a future reader relaxing an invariant they find
      // inconvenient: every one here cost a real incident.
      expect(inv.provenance.length, `${inv.id} provenance`).toBeGreaterThan(0);
      for (const b of inv.binds) expect(b, `${inv.id} binds entry`).not.toMatch(/[*?]/); // no globs
    }
  });

  it('binds only paths that EXIST — a dangling pointer is worse than no pointer', () => {
    // Earned, 2026-08-02: INV-03 bound `lib/repoint-qualified-refs-on-rehome.ts`, which has
    // never existed — the seam is a SQL trigger (migration 734). Nothing checked, so the
    // registry confidently handed a later reader a path to a file that was not there, and the
    // reader went looking for it. That is the failure mode a `binds` list exists to prevent,
    // reproduced by the list itself.
    //
    // A dangling bind is strictly worse than an absent one: absent invites a search, dangling
    // asserts an answer. It also rots on its own schedule — the invariant stays true while the
    // file it names is renamed or removed by someone who never reads this registry.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    for (const inv of DEPENDENCY_INVARIANTS) {
      for (const entry of inv.binds) {
        // Entries may carry a trailing parenthetical naming the symbol inside the path,
        // e.g. 'libs/.../sql (work_item_is_blocked)'. The path is the part before it.
        const path = entry.replace(/\s*\([^)]*\)\s*$/, '').trim();
        expect(existsSync(join(repoRoot, path)), `${inv.id} binds a missing path: ${path}`).toBe(true);
      }
    }
  });

  it('covers all six areas — a missing area means a blind spot nobody named', () => {
    const areas = new Set(DEPENDENCY_INVARIANTS.map((i) => i.area));
    expect([...areas].sort()).toEqual([
      'claim-doors',
      'effectiveness',
      'graph-shape',
      'observability',
      'ref-vocabulary',
      'tenancy',
    ]);
  });

  it('keeps the four escape-backed invariants, by id and by substance', () => {
    // INV-01..INV-04 each have a documented production escape behind them. This
    // pins them so a future edit must be a deliberate design change, not a drive-by.
    for (const id of ['INV-01', 'INV-02', 'INV-03', 'INV-04']) {
      expect(getInvariant(id), `${id} must exist`).toBeDefined();
    }
    expect(getInvariant('INV-04')!.area).toBe('effectiveness');
    expect(getInvariant('INV-11')!.statement).toMatch(/workspace/i);
  });

  it('names prevention, batch atomicity, global typed scope, transition safety, and alert honesty explicitly', () => {
    expect(getInvariant('INV-16')!.statement).toMatch(/post-state.*stranded/i);
    expect(getInvariant('INV-17')!.statement).toMatch(/atomic.*graph or plan/i);
    expect(getInvariant('INV-18')!.statement).toMatch(/families and harnesses/i);
    expect(getInvariant('INV-19')!.statement).toMatch(/lifecycle transition.*same transaction/i);
    expect(getInvariant('INV-20')!.statement).toMatch(/one policy row/i);
  });

  it('keeps acyclicity and batch atomicity as separate coverage claims', () => {
    expect(getInvariant('INV-08')!.statement).not.toMatch(/edge granularity/i);
    expect(getInvariant('INV-08')!.note).toMatch(/INV-17/);
    expect(getInvariant('INV-17')!.statement).toMatch(/every requested edge.*commits together/i);
  });

  it('exports a count that tracks the array', () => {
    expect(DEPENDENCY_INVARIANT_COUNT).toBe(DEPENDENCY_INVARIANTS.length);
    expect(DEPENDENCY_INVARIANT_COUNT).toBeGreaterThanOrEqual(20);
  });
});

describe('dependency policy registry — one classification contract for every surface', () => {
  it('has unique stable codes and exports a tracking count', () => {
    const codes = DEPENDENCY_POLICY_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    expect(DEPENDENCY_POLICY_RULE_COUNT).toBe(DEPENDENCY_POLICY_RULES.length);
    expect(DEPENDENCY_POLICY_RULE_COUNT).toBeGreaterThanOrEqual(30);
  });

  it('declares the shared admission/lint/monitor/tool/UI consumers once', () => {
    expect(DEPENDENCY_POLICY_SURFACES).toEqual(['admission', 'lint', 'monitor', 'tool', 'ui']);
  });

  it('makes class behavior structural instead of relying on prose conventions', () => {
    const invariantIds = new Set(DEPENDENCY_INVARIANTS.map((inv) => inv.id));
    for (const rule of DEPENDENCY_POLICY_RULES) {
      expect(rule.summary.length, `${rule.code} summary`).toBeGreaterThan(40);
      expect(rule.evidence.length, `${rule.code} evidence`).toBeGreaterThan(0);
      expect(rule.provenance.length, `${rule.code} provenance`).toBeGreaterThan(0);
      expect(rule.invariantIds.length, `${rule.code} invariantIds`).toBeGreaterThan(0);
      for (const id of rule.invariantIds) expect(invariantIds.has(id), `${rule.code} → ${id}`).toBe(true);

      if (rule.classification === 'hard-block') {
        expect(rule.action, rule.code).toBe('reject');
        expect(rule.confidence, rule.code).toBe('deterministic');
        expect(rule.suppression, rule.code).toBe('never');
        expect(rule.suggestedAction?.length ?? 0, rule.code).toBeGreaterThan(20);
      } else if (rule.classification === 'advisory') {
        expect(rule.action, rule.code).toBe('alert');
        expect(rule.suppression, rule.code).toBe('structured-rationale');
        expect(rule.suggestedAction?.length ?? 0, rule.code).toBeGreaterThan(20);
      } else {
        expect(rule.action, rule.code).toBe('suppress');
        expect(rule.suppression, rule.code).toBe('automatic');
        expect(rule.suggestedAction, rule.code).toBeNull();
      }
    }
  });

  it('pins the hard-block, advisory, and healthy taxonomy by stable result code', () => {
    expect(dependencyPoliciesByClassification('hard-block').map((rule) => rule.code)).toEqual([
      'cycle',
      'executable-endpoint-missing',
      'endpoint-identity-mismatch',
      'cross-workspace-inert-edge',
      'stranded-set-increase',
      'dangling-identity-transition',
      'active-dependant-unreconciled',
      'reopened-blocker-unreconciled',
      'partial-dependency-batch',
      'executable-plan-invalid',
      'promotion-edge-divergence',
      'required-outcome-impossible',
      'typed-blocked-without-resolver',
    ]);
    expect(dependencyPoliciesByClassification('advisory').map((rule) => rule.code)).toEqual([
      'satisfied-edge-retained',
      'terminal-dependant-live-blocker',
      'legacy-blocked-without-resolver',
      'promoted-graph-extra-edge',
      'phase-inversion',
      'gate-foundation-inversion',
      'gate-without-dependency',
      'transitive-redundancy',
      'narrow-or-deep-topology',
      'high-degree-node',
      'cross-harness-without-provenance',
      'dependency-added-after-wip',
      'external-condition-uncertain',
      'duplicate-plan-coverage',
    ]);
    expect(dependencyPoliciesByClassification('healthy').map((rule) => rule.code)).toEqual([
      'isolated-or-wide-roots',
      'diamond-or-multiple-blockers',
      'intentional-serialization',
      'cross-harness-with-provenance',
      'settled-terminal-blocker',
      'retained-history-edge',
    ]);
  });

  it('looks up the exact row tools and UI will share', () => {
    expect(getDependencyPolicy('cycle')).toMatchObject({
      classification: 'hard-block',
      action: 'reject',
      suppression: 'never',
    });
    expect(getDependencyPolicy('phase-inversion')).toMatchObject({
      classification: 'advisory',
      action: 'alert',
    });
    expect(getDependencyPolicy('diamond-or-multiple-blockers')).toMatchObject({
      classification: 'healthy',
      action: 'suppress',
    });
    expect(getDependencyPolicy('not-a-real-policy')).toBeUndefined();
  });
});

describe('dependency invariant registry — lookup', () => {
  it('finds by id and returns undefined for an unknown one', () => {
    expect(getInvariant('INV-01')?.area).toBe('ref-vocabulary');
    expect(getInvariant('INV-99')).toBeUndefined();
  });

  it('groups by area', () => {
    const eff = invariantsByArea('effectiveness');
    expect(eff.length).toBeGreaterThanOrEqual(2);
    expect(eff.every((i) => i.area === 'effectiveness')).toBe(true);
  });

  it('binds the SQL oracle even though its binds entry carries a parenthetical', () => {
    // The oracle is named 'libs/.../sql (work_item_is_blocked)'. An exact-match
    // lookup would return nothing here — for the single most important path in
    // the subsystem — which is why the match is substring-based.
    const bound = invariantsBindingPath('work_item_is_blocked');
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.map((i) => i.id)).toContain('INV-11');
  });

  it('binds a plain source path', () => {
    const bound = invariantsBindingPath('packages/operator-core/lib/scheduler/work-item-deps-integrity.ts');
    expect(bound.map((i) => i.id)).toEqual(expect.arrayContaining(['INV-12', 'INV-13']));
  });
});

describe('@covers citation extraction', () => {
  it('reads one, comma-separated, and space-separated citations', () => {
    expect(coveredInvariants('// @covers INV-04')).toEqual(['INV-04']);
    expect(coveredInvariants('describe("x", ... @covers INV-01, INV-02')).toEqual(['INV-01', 'INV-02']);
    expect(coveredInvariants('@covers INV-06 INV-07')).toEqual(['INV-06', 'INV-07']);
  });

  it('dedupes and sorts across a whole file', () => {
    const src = `
      // @covers INV-04
      it('a', () => {});
      // @covers INV-04, INV-01
    `;
    expect(coveredInvariants(src)).toEqual(['INV-01', 'INV-04']);
  });

  it('finds nothing in a file that cites nothing', () => {
    expect(coveredInvariants('it("unrelated", () => {});')).toEqual([]);
  });

  // NEGATIVE CONTROL. Without this, a typo'd citation would be indistinguishable
  // from a real one and would read as coverage — the exact failure mode this whole
  // plan exists to prevent, reproduced in the coverage tool itself.
  it('reports an unknown cited id rather than counting it as coverage', () => {
    expect(unknownCoveredIds('@covers INV-01, INV-77')).toEqual(['INV-77']);
    expect(unknownCoveredIds('@covers INV-01')).toEqual([]);
  });

  it('names uncovered invariants across a set of sources', () => {
    const all = DEPENDENCY_INVARIANTS.map((i) => `@covers ${i.id}`);
    expect(uncoveredInvariantIds(all)).toEqual([]);
    const missingOne = DEPENDENCY_INVARIANTS.slice(1).map((i) => `@covers ${i.id}`);
    expect(uncoveredInvariantIds(missingOne)).toEqual(['INV-01']);
  });

  it('treats an empty source set as covering nothing', () => {
    expect(uncoveredInvariantIds([]).length).toBe(DEPENDENCY_INVARIANT_COUNT);
  });
});
