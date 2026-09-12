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
 * A STATIC (source-text) read cannot be TRUSTED for this job: a tool may build
 * its description/guidance non-literally (concatenating a shared constant, a
 * helper call, or per-role blocks), and a source scan then under-counts exactly
 * the tools nearest the ceiling. Only the RUNTIME-projected catalog
 * (listAllProjectedTools, after the agent-tools barrel has registered) is
 * ground truth — which is precisely what registration-time has and a file
 * scanner does not.
 *
 * ⚠ This paragraph used to cite "12 fleet:* tools compose their guidance from a
 * shared `ROUTING_LADDER` constant (+368 chars each)" as the worked example.
 * That constant NO LONGER EXISTS anywhere in the repo (2026-08-02: the only
 * remaining occurrence of the identifier was this comment). The stale example
 * actively misleads: chasing a ~+368/tool hidden surcharge makes a CORRECT
 * static measurement look wrong, which is how an agent triaging a breach ends
 * up trimming a tool that already fits. Measured that day, fleet:leader-brief
 * projected at runtime to exactly its static weight (1503, byRole: []).
 * The RULE above still stands — verify with the runtime catalog, not a grep —
 * but do NOT expect a fixed hidden surcharge; measure the tool in question.
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

/**
 * Floor for a genuinely-registered live catalog (EI-19377066316560032). ~655
 * tools are live today; a barrel that only partially registered yields ~40 —
 * this sits well above that and well below the real count, mirroring the
 * `named.length > 500` floor the vitest gate suite already asserts
 * (tool-guidance-budget.shared.ts). `listAllProjectedTools()` returns `[]`
 * when called before the agent-tools barrel has side-effect-imported (e.g. a
 * standalone `npx tsx -e "...listAllProjectedTools()..."` probe run outside
 * the vitest bootstrap) — with NO error, so `budgetViolations()` over an empty
 * catalog silently reports "0 violations", indistinguishable from a genuinely
 * clean 655-tool catalog. This floor turns that vacuous green into a loud
 * throw at the one production call site (`namedToolWeights()` reading the
 * live registry) instead of leaving the gate suite's floor as the only guard.
 */
export const MIN_PLAUSIBLE_CATALOG_SIZE = 500;

/** Grandfathered over-budget tools. Shrink-only: an entry here still must stay
 *  ≤ HARD_CAP and may be removed the moment the tool fits the budget. Currently
 *  EMPTY — a clean ratchet worth defending. */
export const ALLOW_OVER_BUDGET = new Set<string>([]);

type GuidanceShape = ProjectedTool['guidance'];

/** The per-field split of a tool's prompt weight, so a trimmer sees WHICH field
 *  is heavy instead of only that the total is too big (EI-19418721410168539).
 *  `seeAlso` is deliberately ABSENT: it is not summed into the weight, and
 *  adding it here would make a correct green read as a breach. */
export interface PromptWeightBreakdown {
  description: number;
  when: number;
  notWhen: number;
  chaining: number;
  /** when+notWhen+chaining summed across EVERY role — one aggregated line. */
  byRole: number;
  /** The weight itself: exactly the sum of the fields above. */
  total: number;
}

/** description + every guidance field (incl. per-role) — the exact string weight
 *  a tool contributes to the assembled system prompt, split per field.
 *
 *  This is the ONE place the summed field list lives; `promptWeight()` returns
 *  `.total` rather than re-adding them, so the scalar and the breakdown cannot
 *  drift apart into a second copy of the formula. */
export function promptWeightBreakdown(tool: {
  description?: string;
  guidance?: GuidanceShape;
}): PromptWeightBreakdown {
  const g = tool.guidance ?? {};
  const byRole = Object.values(g.byRole ?? {}).reduce(
    (acc, r) => acc + (r.when?.length ?? 0) + (r.notWhen?.length ?? 0) + (r.chaining?.length ?? 0),
    0,
  );
  const description = tool.description?.length ?? 0;
  const when = g.when?.length ?? 0;
  const notWhen = g.notWhen?.length ?? 0;
  const chaining = g.chaining?.length ?? 0;
  return {
    description,
    when,
    notWhen,
    chaining,
    byRole,
    total: description + when + notWhen + chaining + byRole,
  };
}

/** description + every guidance field (incl. per-role) — the exact string weight
 *  a tool contributes to the assembled system prompt. Derived from
 *  `promptWeightBreakdown()` so the two can never disagree. */
export function promptWeight(tool: { description?: string; guidance?: GuidanceShape }): number {
  return promptWeightBreakdown(tool).total;
}

/**
 * Runtime tool calls carry each selected tool's JSON Schema separately from
 * the description/guidance text measured above. Keep this accounting separate:
 * promptWeight() describes the assembled prompt catalog, while this metric
 * describes the schema payload a selected tool load adds to the model context.
 *
 * This is intentionally a byte count of JSON.stringify(inputSchema), encoded
 * as UTF-8. String.length would count UTF-16 code units and under-count schemas
 * containing non-ASCII descriptions (the wire payload is UTF-8).
 */
export const MAX_SELECTED_INPUT_SCHEMA_BYTES = 128_000;

const UTF8_ENCODER = new TextEncoder();

export interface SelectedInputSchemaTool {
  name: string;
  inputSchema?: unknown;
}

export interface InputSchemaCost {
  name: string;
  bytes: number;
}

export interface SelectedInputSchemaBudget {
  budgetBytes: number;
  totalBytes: number;
  remainingBytes: number;
  overBudget: boolean;
  entries: InputSchemaCost[];
}

/** Count the exact UTF-8 bytes in a projected tool's serialized input schema. */
export function serializedInputSchemaBytes(inputSchema: unknown): number {
  const serialized = JSON.stringify(inputSchema);
  return serialized === undefined ? 0 : UTF8_ENCODER.encode(serialized).byteLength;
}

/** Calculate the aggregate schema load for one selected tool set. */
export function selectedInputSchemaBudget(
  tools: readonly SelectedInputSchemaTool[],
  budgetBytes = MAX_SELECTED_INPUT_SCHEMA_BYTES,
): SelectedInputSchemaBudget {
  const entries = tools.map(({ name, inputSchema }) => ({
    name,
    bytes: serializedInputSchemaBytes(inputSchema),
  }));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    budgetBytes,
    totalBytes,
    remainingBytes: budgetBytes - totalBytes,
    overBudget: totalBytes > budgetBytes,
    entries,
  };
}

export interface SelectedInputSchemaBudgetOptions {
  budgetBytes?: number;
  label?: string;
}

/**
 * Fail closed before a selected schema set is mounted when its aggregate load
 * would exceed the runtime budget. The report is returned for callers that
 * want to emit telemetry or diagnostics on a successful check.
 */
export function assertSelectedInputSchemaBudget(
  tools: readonly SelectedInputSchemaTool[],
  options: SelectedInputSchemaBudgetOptions = {},
): SelectedInputSchemaBudget {
  const report = selectedInputSchemaBudget(tools, options.budgetBytes);
  if (!report.overBudget) return report;

  const label = options.label ?? 'selected tool set';
  const largest = [...report.entries]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((entry) => `${entry.name}=${entry.bytes}`)
    .join(', ');
  throw new Error(
    `${label} input schemas use ${report.totalBytes} UTF-8 bytes, exceeding the ` +
      `${report.budgetBytes}-byte aggregate budget; largest schemas: ${largest}`,
  );
}

export interface NamedToolWeight {
  name: string;
  weight: number;
  /** Per-field split of `weight`. Optional so every existing producer of a
   *  `{ name, weight }` literal (tests, fixtures) keeps compiling. */
  breakdown?: PromptWeightBreakdown;
}

/**
 * Guards the LIVE-registry read only (never an explicitly-passed fixture
 * catalog — a unit test legitimately hands in a handful of synthetic tools).
 * Throws instead of letting a caller silently measure zero tools and read
 * "over-budget: NONE" as a real, clean verdict.
 */
function assertLiveCatalogSane(tools: readonly ProjectedTool[]): void {
  if (tools.length >= MIN_PLAUSIBLE_CATALOG_SIZE) return;
  throw new Error(
    `tool-guidance-budget: listAllProjectedTools() returned only ${tools.length} tool(s) — ` +
      `far below the ${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor for a genuinely-registered live catalog. ` +
      `This means the agent-tools barrel never registered (most likely: this ran standalone — e.g. a bare ` +
      `\`npx tsx -e "...listAllProjectedTools()..."\` script — outside the vitest bootstrap, which side-effect-` +
      `imports '../agent-tools/index' first), NOT that the catalog is genuinely empty. Run the focused ` +
      `suites with \`npm run test:file -- packages/operator-core/lib/__tests__/tool-guidance-budget.test.ts ` +
      `packages/operator-core/lib/agent-tools/tool-guidance-budget-live-guard.test.ts\` instead of measuring ` +
      `standalone, or ` +
      `side-effect-import '../agent-tools/index' before calling this. (EI-19377066316560032)`,
  );
}

/** The real projected catalog, one { name, weight } per MCP-exposed tool. Pass a
 *  catalog to measure (tests); omit to read the live registry — reading the
 *  live registry asserts it looks genuinely registered (see
 *  assertLiveCatalogSane) rather than silently measuring an empty/partial one. */
export function namedToolWeights(catalog?: readonly ProjectedTool[]): NamedToolWeight[] {
  const tools = catalog ?? listAllProjectedTools();
  if (catalog === undefined) assertLiveCatalogSane(tools);
  return tools
    .map((t) => {
      const breakdown = promptWeightBreakdown(t);
      return { name: t.expose?.mcp?.name ?? '(unexposed)', weight: breakdown.total, breakdown };
    })
    .filter((t) => t.name !== '(unexposed)');
}

export interface BudgetViolation {
  name: string;
  weight: number;
  /** true iff over the HARD CAP (the absolute bound, grandfathered or not). */
  hardCap: boolean;
  /** true iff this tool is grandfathered in ALLOW_OVER_BUDGET. */
  grandfathered: boolean;
  /** chars to cut to clear the effective binding ceiling. */
  cutAtLeast: number;
}

/**
 * The ceiling a fixer must reach depends on the exemption: an ordinary tool
 * must fit the soft budget, while a grandfathered tool may use the hard cap.
 * Keep the hard cap as the upper bound even if the soft budget is configured
 * above it in the future.
 */
function bindingCeiling(grandfathered: boolean): number {
  return grandfathered ? HARD_CAP : Math.min(BUDGET, HARD_CAP);
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
      cutAtLeast: t.weight - bindingCeiling(grandfathered),
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Self-serve failure text: the tool, its weight, and exactly how many chars to
 *  cut — so a fixer never has to reverse-engineer the number (EI-10966 #2). */
export function formatViolations(violations: readonly BudgetViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map((v) => {
    const ceiling = bindingCeiling(v.grandfathered);
    const hardCapBinding = ceiling === HARD_CAP;
    const limit = hardCapBinding ? `${HARD_CAP}-char HARD CAP` : `${BUDGET}-char budget`;
    const tail = hardCapBinding
      ? ''
      : ' (trim it — prefer a docs pointer over prose-in-place — or, only if genuinely irreducible, add an ALLOW_OVER_BUDGET entry)';
    return `  • ${v.name} is ${v.weight} — cut ≥${v.cutAtLeast} to clear the ${limit}${tail}`;
  });
  return lines.join('\n');
}
