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
import { listAllProjectedTools } from '@papercusp/tooldef';

// Raised 1200 → 1500 by owner decision (2026-06-14). Rationale: a uniform budget is
// blunt — a load-bearing, multi-mode coordination primitive (coord:send's
// required/optimistic wake semantics) legitimately earns more guidance than a trivial
// tool. HARD_CAP unchanged, so the soft-ratchet / hard-cap two-tier is preserved; this
// raises the soft ceiling, it does not remove the bound. (token-usage-reduction P-011.)
const BUDGET = 1500;
const HARD_CAP = 1600;

/** Grandfathered over-budget tools. Shrink-only: an entry here still must stay
 *  ≤ HARD_CAP and may be removed the moment the tool fits the budget. After the
 *  2026-06-14 raise to 1,500, only locks:acquire remains over — the other five
 *  (watch:create, plans:promote, substrate:revoke_contributor, improvements:capture,
 *  events:await) now fit and were removed. */
const ALLOW_OVER_BUDGET = new Set<string>([]);

interface GuidanceShape {
  when?: string;
  notWhen?: string;
  chaining?: string;
  byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
}

function promptWeight(tool: { description?: string; guidance?: GuidanceShape }): number {
  const g = tool.guidance ?? {};
  const byRole = Object.values(g.byRole ?? {}).reduce(
    (acc, r) => acc + (r.when?.length ?? 0) + (r.notWhen?.length ?? 0) + (r.chaining?.length ?? 0),
    0,
  );
  return (
    (tool.description?.length ?? 0) +
    (g.when?.length ?? 0) +
    (g.notWhen?.length ?? 0) +
    (g.chaining?.length ?? 0) +
    byRole
  );
}

interface NamedToolWeight {
  name: string;
  weight: number;
}

/** The real projected catalog, one { name, weight } per MCP-exposed tool. */
function namedToolWeights(): NamedToolWeight[] {
  const tools = listAllProjectedTools() as unknown as Array<{
    description?: string;
    guidance?: GuidanceShape;
    expose?: { mcp?: { name?: string } };
  }>;
  return tools
    .map((t) => ({ name: t.expose?.mcp?.name ?? '(unexposed)', weight: promptWeight(t) }))
    .filter((t) => t.name !== '(unexposed)');
}

/**
 * The full P-011 budget ratchet suite. Called from BOTH
 * tool-guidance-budget.test.ts (standalone / gate) and tools-md-sync.test.ts
 * (the quick-check the CLAUDE.md tool discipline mandates), so editing a tool
 * over budget reds the exact command an agent runs after the edit.
 */
export function describeToolGuidanceBudget(): void {
  const named = namedToolWeights();

  describe('tool guidance budget (P-011 ratchet)', () => {
    it('the registry loaded a real catalog', () => {
      expect(named.length).toBeGreaterThan(100);
    });

    it(`every non-grandfathered tool fits the ${BUDGET}-char description+guidance budget`, () => {
      const over = named
        .filter((t) => t.weight > BUDGET && !ALLOW_OVER_BUDGET.has(t.name))
        .map((t) => `${t.name} (${t.weight})`);
      expect(
        over,
        `Over the ${BUDGET}-char prompt-weight budget: ${over.join(', ')}. ` +
          `Trim the guidance (prefer a docs pointer over prose-in-place) or — only if ` +
          `genuinely irreducible — add an ALLOW_OVER_BUDGET entry with a reason.`,
      ).toEqual([]);
    });

    it(`nothing exceeds the ${HARD_CAP}-char hard cap (grandfathered included)`, () => {
      const over = named.filter((t) => t.weight > HARD_CAP).map((t) => `${t.name} (${t.weight})`);
      expect(over, `Over the ${HARD_CAP}-char hard cap: ${over.join(', ')}`).toEqual([]);
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
