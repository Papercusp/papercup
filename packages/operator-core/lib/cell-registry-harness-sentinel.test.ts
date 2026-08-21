import { describe, it, expect } from 'vitest';
import { isAllHarnessSentinel, HARNESS_ALL } from './agent-tools/_harness-scope';
import { canReadCell, type CellSpec } from './cell-registry';

/**
 * cell-registry-harness-sentinel.test.ts — THE DUPLICATION PIN (P-005).
 *
 * WHY A DUPLICATE EXISTS AT ALL. `canReadCell` must recognise the "all harnesses /
 * operator scope" sentinel. The canonical predicate for that is
 * `isAllHarnessSentinel()` in `agent-tools/_harness-scope.ts` — but `cell-registry.ts`
 * is dependency-free on purpose (zero imports), and `_harness-scope.ts` reaches
 * `@papercusp/agent-mcp`. Importing it would run an edge from the access primitive
 * into the MCP layer that loads it, which is a cycle waiting to happen. So the
 * registry carries a local `isOperatorScopeSentinel()`.
 *
 * WHAT THIS FILE IS FOR. A duplicated predicate is only safe while the copies agree,
 * and the dangerous direction is silent: if someone widens the canonical sentinel
 * (a new alias, trimming rules, a case change) the access check simply keeps using
 * the old vocabulary and quietly refuses readers the rest of the system considers
 * operator-scope. Nothing throws; cells just go absent again — the exact failure
 * P-005 fixed, re-entering through the back door.
 *
 * So this asserts AGREEMENT ACROSS BOTH COPIES on every input, driving the registry's
 * private copy through its one observable consumer (`canReadCell` on a harness-scoped
 * cell with an operator reader). The registry copy is not exported and deliberately
 * stays that way — exporting it to make testing easier would create the second public
 * definition this file exists to prevent.
 */

/**
 * Minimal harness-scoped spec — only `visibility` is load-bearing here.
 *
 * ⚠ The ref is a SYNTHETIC slug that appears in no INPUT below, and that is
 * load-bearing rather than cosmetic. A realistic ref (`'papercusp'`) collides with
 * the inputs, so `canReadCell` returns true via the EXACT-MATCH branch and the probe
 * silently stops measuring the sentinel branch it exists to measure. The first draft
 * of this file used `'papercusp'` and reported a false split for exactly that reason.
 */
const harnessCell = (): CellSpec =>
  ({
    cell: 'test.harnessScoped',
    owner: 'su-p005',
    headline: 'value',
    nullable: false,
    callerRelativity: { kind: 'global' },
    visibility: { kind: 'harness', ref: 'harness-under-test-never-an-input' },
    federation: { kind: 'local' },
    provenance: { obtainedBy: 'fixture', liveExercised: false, evidence: 'n/a' },
    resolver: 'n/a',
    shape: '{ value }',
  }) as unknown as CellSpec;

/** The registry's PRIVATE copy, observed through its only public consumer. */
const registrySaysSentinel = (harnessSlug: string | undefined): boolean =>
  canReadCell(harnessCell(), { ownerId: 'su-p005', roles: ['operator'], harnessSlug });

/**
 * Inputs span the accepted forms, the near-misses, and the shapes a future edit to
 * either predicate is most likely to disturb (case, padding, empty, undefined).
 */
const INPUTS: Array<string | undefined> = [
  '*',
  'all',
  'ALL',
  'All',
  '  all  ',
  ' * ',
  'papercusp',
  'sidestage',
  'all-hands',
  'allowlist',
  '**',
  '',
  '   ',
  undefined,
];

describe('P-005 — the registry sentinel and the canonical sentinel agree', () => {
  for (const input of INPUTS) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      const canonical = isAllHarnessSentinel(input);
      const registry = registrySaysSentinel(input);
      expect(
        registry,
        `canonical isAllHarnessSentinel(${JSON.stringify(input)})=${canonical} but the cell ` +
          `registry's private copy resolved ${registry}. The two definitions have split — ` +
          `update isOperatorScopeSentinel() in cell-registry.ts to match _harness-scope.ts, ` +
          `or the access check will silently refuse readers the rest of the system treats ` +
          `as operator-scope.`,
      ).toBe(canonical);
    });
  }

  it('the canonical constant itself is recognised by the registry copy', () => {
    // Guards the case where HARNESS_ALL is re-pointed at a different literal.
    expect(registrySaysSentinel(HARNESS_ALL)).toBe(true);
  });

  it('a concrete harness is NOT a sentinel on either side', () => {
    // Calibration: proves the agreement above is not two predicates that both say
    // "true" for everything. Without this, a broken pair would pass every case.
    expect(isAllHarnessSentinel('papercusp')).toBe(false);
    expect(registrySaysSentinel('sidestage')).toBe(false);
  });
});
