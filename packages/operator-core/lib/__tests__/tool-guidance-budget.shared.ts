/**
 * tool-guidance-budget.shared.ts — the per-tool prompt-weight budget
 * (token-usage-reduction-audit-2026-06-09 P-011), extracted so BOTH
 * tool-guidance-budget.test.ts AND tools-md-sync.test.ts assert the SAME
 * ratchet from ONE source of truth.
 *
 * WHY it lives here and both call it (EI-7284): a tool-file guidance/
 * description edit already makes the operator-core workspace "affected", so
 * the full `npm run test:affected` DOES run the standalone budget test. But
 * the CLAUDE.md "Adding a tool" discipline (step 5) tells you to run only the
 * scoped quick-check `npx vitest run tools-md-sync` — which did NOT assert the
 * budget. An agent who followed that step exactly got a FALSE GREEN while a
 * tool sat over budget; the breach only surfaced in the green checkpoint,
 * wedging deploys fleet-wide for ~12h (loop:checkpoint 1552, plans:set-status
 * 1693, autonomy:decide 1545 all drifted over, each locally-green). Folding
 * this ratchet into tools-md-sync makes the mandated quick-check catch it.
 *
 *   - BUDGET (1,500 chars, description + all guidance fields): every tool
 *     must fit unless grandfathered in ALLOW_OVER_BUDGET below.
 *   - HARD CAP (1,600 chars): nothing may exceed it, grandfathered or not.
 *
 * Trimming a grandfathered tool under budget? Delete its ALLOW entry so it
 * can't regress. Adding a genuinely-irreducible tool over budget? Add it to
 * ALLOW with a one-line reason — but try the docs-pointer pattern first
 * (guidance points at /internal/docs, not prose-in-place).
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index'; // side-effect: register the full real tool catalog
// Constants + weight formula + self-serve trim message live in the PRODUCTION module
// (EI-10966) so the live operator's boot/hot-reload self-check and this gate test share
// ONE source of truth — the numbers can't drift between "warned at edit time" and
// "redded at the gate".
import {
  BUDGET,
  HARD_CAP,
  ALLOW_OVER_BUDGET,
  namedToolWeights,
  budgetViolations,
  formatViolations,
} from '../agent-tools/tool-guidance-budget';

/**
 * The full P-011 budget ratchet suite. Called from BOTH
 * tool-guidance-budget.test.ts (standalone / gate) and tools-md-sync.test.ts
 * (the quick-check the CLAUDE.md tool discipline mandates), so editing a tool
 * over budget reds the exact command an agent runs after the edit.
 */
export function describeToolGuidanceBudget(): void {
  const named = namedToolWeights();
  // Single computation, shared with the live operator self-check (EI-10966): the
  // failure message names each tool AND the exact chars to cut, so a fixer never
  // has to reverse-engineer the number.
  const violations = budgetViolations(named);

  describe('tool guidance budget (P-011 ratchet)', () => {
    it('reports the soft-budget trim for a non-grandfathered hard-cap breach', () => {
      const weight = HARD_CAP + 25;
      const violations = budgetViolations([{ name: 'non-grandfathered-hard-cap', weight }]);
      expect(violations).toHaveLength(1);

      const violation = violations[0]!;
      expect(violation).toMatchObject({
        name: 'non-grandfathered-hard-cap',
        weight,
        hardCap: true,
        grandfathered: false,
        cutAtLeast: weight - BUDGET,
      });
      expect(formatViolations(violations)).toContain(
        `cut ≥${weight - BUDGET} to clear the ${BUDGET}-char budget`,
      );
      expect(formatViolations(violations)).not.toContain(`${HARD_CAP}-char HARD CAP`);
    });

    it('keeps grandfathered hard-cap breaches bound to the hard cap', () => {
      const name = 'grandfathered-hard-cap';
      const weight = HARD_CAP + 25;
      ALLOW_OVER_BUDGET.add(name);
      try {
        const violations = budgetViolations([{ name, weight }]);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({
          name,
          hardCap: true,
          grandfathered: true,
          cutAtLeast: 25,
        });
        expect(formatViolations(violations)).toContain(`${HARD_CAP}-char HARD CAP`);
      } finally {
        ALLOW_OVER_BUDGET.delete(name);
      }
    });

    it('the registry loaded a real catalog', () => {
      // 724 tools as measured 2026-08-08 (the comment said 655 and had drifted —
      // the HEADROOM report below now prints the live count every run, so this
      // number stops being a thing anyone has to trust); a floor well above any
      // partial-registration failure mode
      // (a barrel that failed to register the package-side tools yields ~40) so a
      // vacuous "0 over budget because the catalog is empty" can never pass green.
      expect(named.length).toBeGreaterThan(500);
    });

    it(`every non-grandfathered tool fits the ${BUDGET}-char description+guidance budget`, () => {
      const over = violations.filter((v) => !v.grandfathered && !v.hardCap).map((v) => v.name);
      expect(
        over,
        over.length === 0
          ? ''
          : `Over the ${BUDGET}-char prompt-weight budget:\n${formatViolations(
              violations.filter((v) => !v.grandfathered && !v.hardCap),
            )}`,
      ).toEqual([]);
    });

    it(`nothing exceeds the ${HARD_CAP}-char hard cap (grandfathered included)`, () => {
      const over = violations.filter((v) => v.hardCap).map((v) => v.name);
      expect(
        over,
        over.length === 0
          ? ''
          : `Over the ${HARD_CAP}-char hard cap:\n${formatViolations(violations.filter((v) => v.hardCap))}`,
      ).toEqual([]);
    });

    /**
     * P-009 (borrow item 2 remainder). NOT a pass/fail assertion about any
     * tool — a MEASUREMENT. "Should we interpolate more per-tool prose (e.g.
     * each tool's own result cap) into descriptions?" is unanswerable without
     * knowing how much room the catalog actually has, and this gate is the only
     * place the real catalog is loaded, so the number was being guessed. The
     * gate reported BREACHES but never PRESSURE, which is why weight drifts
     * over silently and is discovered at the fleet gate.
     */
    it('reports catalog prompt-weight HEADROOM (P-009 — what one added sentence would cost)', () => {
      const SENTENCE = 120; // chars — a short added sentence, e.g. a per-tool cap note
      const sorted = [...named].sort((a, b) => a.weight - b.weight);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!.weight;
      const wouldBreachBudget = named.filter((t) => t.weight <= BUDGET && t.weight + SENTENCE > BUDGET).length;
      const wouldBreachHardCap = named.filter((t) => t.weight <= HARD_CAP && t.weight + SENTENCE > HARD_CAP).length;
      // eslint-disable-next-line no-console
      console.log(
        `[prompt-weight] tools=${named.length} budget=${BUDGET} hardCap=${HARD_CAP} ` +
          `p50=${at(0.5)} p90=${at(0.9)} p99=${at(0.99)} max=${sorted[sorted.length - 1]!.weight} ` +
          `| adding ${SENTENCE} chars to EVERY tool would newly breach: budget=${wouldBreachBudget} hardCap=${wouldBreachHardCap}`,
      );
      expect(named.length).toBeGreaterThan(500);
    });

    it('grandfather list stays shrink-only (no stale entries for now-fitting tools)', () => {
      const byName = new Map(named.map((t) => [t.name, t.weight]));
      const stale = [...ALLOW_OVER_BUDGET].filter((n) => (byName.get(n) ?? 0) <= BUDGET);
      expect(
        stale,
        `These ALLOW_OVER_BUDGET entries now fit the budget — delete them so they can't regress: ${stale.join(', ')}`,
      ).toEqual([]);
    });
  });
}
