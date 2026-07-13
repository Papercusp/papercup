/**
 * tool-guidance-budget — the per-tool prompt-weight budget (P-011), as a
 * PRODUCTION-SAFE module (no vitest import), so BOTH the gate test AND the live
 * operator's boot/hot-reload self-check share ONE source of truth for the
 * numbers, the weight formula, and the self-serve "how much to trim" message.
 *
 * WHY a live self-check exists (EI-10966): the ratchet's only reliable
 * enforcement point used to be the green checkpoint — a gate that blocks
 * deploys for the WHOLE fleet. So one agent EDITING a tool's guidance over
 * budget (never "adding a tool", so the CLAUDE.md quick-check never runs)
 * froze hive-wide deploys until someone triaged a stale gate log. Every
 * prompt-weight breach on record was an edit, not an add (verified over the
 * whole 655-tool catalog: only 3 tools were ever born over budget, all long
 * grandfathered/removed). The fix moves the signal to where the edit happens:
 * `tool-weight-selfcheck.ts` calls this at catalog-registration time, which the
 * live operator re-runs on every hot-reload — so an over-budget edit surfaces
 * in the operator's own logs the moment the file is saved, not at the gate.
 *
 * A STATIC (source-text) read cannot do this job: 12 fleet:* tools compose
 * their guidance from a shared `ROUTING_LADDER` constant (+368 chars each) and
 * a couple build their description non-literally, so a source scan under-counts
 * exactly the tools nearest the ceiling. Only the RUNTIME-projected catalog
 * (listAllProjectedTools, after the agent-tools barrel has registered) is
 * ground truth — which is precisely what registration-time has and a file
 * scanner does not.
 *
 *   - BUDGET (1,500 chars, description + all guidance fields): every tool must
 *     fit unless grandfathered in ALLOW_OVER_BUDGET.
 *   - HARD CAP (1,600 chars): nothing may exceed it, grandfathered or not.
 */
import { listAllProjectedTools, type ProjectedTool } from '@papercusp/tooldef';

// Raised 1200 → 1500 by owner decision (2026-06-14): a uniform budget is blunt — a
// load-bearing multi-mode coordination primitive legitimately earns more guidance than a
// trivial tool. HARD_CAP unchanged, so the soft-ratchet / hard-cap two-tier is preserved.
export const BUDGET = 1500;
export const HARD_CAP = 1600;

/** Grandfathered over-budget tools. Shrink-only: an entry here still must stay
 *  ≤ HARD_CAP and may be removed the moment the tool fits the budget. Currently
 *  EMPTY — a clean ratchet worth defending. */
export const ALLOW_OVER_BUDGET = new Set<string>([]);

type GuidanceShape = ProjectedTool['guidance'];

/** description + every guidance field (incl. per-role) — the exact string weight
 *  a tool contributes to the assembled system prompt. */
export function promptWeight(tool: { description?: string; guidance?: GuidanceShape }): number {
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

export interface NamedToolWeight {
  name: string;
  weight: number;
}

/** The real projected catalog, one { name, weight } per MCP-exposed tool. Pass a
 *  catalog to measure (tests); omit to read the live registry. */
export function namedToolWeights(catalog?: readonly ProjectedTool[]): NamedToolWeight[] {
  const tools = catalog ?? listAllProjectedTools();
  return tools
    .map((t) => ({ name: t.expose?.mcp?.name ?? '(unexposed)', weight: promptWeight(t) }))
    .filter((t) => t.name !== '(unexposed)');
}

export interface BudgetViolation {
  name: string;
  weight: number;
  /** true iff over the HARD CAP (the absolute bound, grandfathered or not). */
  hardCap: boolean;
  /** true iff this tool is grandfathered in ALLOW_OVER_BUDGET. */
  grandfathered: boolean;
  /** chars to cut to clear the binding limit (hard cap if over it, else budget). */
  cutAtLeast: number;
}

/**
 * Every tool that would RED the gate: a non-grandfathered tool over BUDGET, or
 * ANY tool over HARD_CAP. Mirrors the two-tier gate test exactly, so the live
 * self-check and the gate agree on what counts as a breach.
 */
export function budgetViolations(weights?: readonly NamedToolWeight[]): BudgetViolation[] {
  const named = weights ?? namedToolWeights();
  const out: BudgetViolation[] = [];
  for (const t of named) {
    const hardCap = t.weight > HARD_CAP;
    const grandfathered = ALLOW_OVER_BUDGET.has(t.name);
    const overBudget = t.weight > BUDGET && !grandfathered;
    if (!hardCap && !overBudget) continue;
    out.push({
      name: t.name,
      weight: t.weight,
      hardCap,
      grandfathered,
      cutAtLeast: t.weight - (hardCap ? HARD_CAP : BUDGET),
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Self-serve failure text: the tool, its weight, and exactly how many chars to
 *  cut — so a fixer never has to reverse-engineer the number (EI-10966 #2). */
export function formatViolations(violations: readonly BudgetViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map((v) => {
    const limit = v.hardCap ? `${HARD_CAP}-char HARD CAP` : `${BUDGET}-char budget`;
    const tail = v.hardCap
      ? ''
      : ' (trim it — prefer a docs pointer over prose-in-place — or, only if genuinely irreducible, add an ALLOW_OVER_BUDGET entry)';
    return `  • ${v.name} is ${v.weight} — cut ≥${v.cutAtLeast} to clear the ${limit}${tail}`;
  });
  return lines.join('\n');
}
