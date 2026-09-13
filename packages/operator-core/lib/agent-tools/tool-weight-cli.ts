import {
  ALLOW_OVER_BUDGET,
  BUDGET,
  HARD_CAP,
  budgetViolations,
  type NamedToolWeight,
  type PromptWeightBreakdown,
} from './tool-guidance-budget';
import { writeStdoutSync } from '../../../../scripts/lib/write-stdout-sync.mjs';

export interface ToolWeightRow {
  name: string;
  weight: number;
  budget: number;
  hardCap: number;
  overBudget: boolean;
  overHardCap: boolean;
  grandfathered: boolean;
  cutAtLeast: number | null;
  /** Per-field split of `weight` — which field to cut, not just how much
   *  (EI-19418721410168539). Absent when the caller supplied bare
   *  `{ name, weight }` weights (a fixture) rather than the live catalog. */
  breakdown?: PromptWeightBreakdown;
}

export interface ToolWeightCliArgs {
  all: boolean;
  json: boolean;
  selector?: string;
}

export function parseToolWeightArgs(args: readonly string[]): ToolWeightCliArgs {
  let all = false;
  let json = false;
  let selector: string | undefined;

  for (const arg of args) {
    if (arg === '--all') {
      all = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('usage: npm run tool-weight -- [--json] [--all | <tool-name>]');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (selector !== undefined) {
      throw new Error('expected at most one tool name; use --all to list the catalog');
    } else {
      selector = arg;
    }
  }

  if (all && selector !== undefined) {
    throw new Error('use either --all or a tool name, not both');
  }

  return { all, json, ...(selector === undefined ? {} : { selector }) };
}

export function measureToolWeights(
  weights: readonly NamedToolWeight[],
  selector?: string,
): ToolWeightRow[] {
  const violations = new Map(budgetViolations(weights).map((violation) => [violation.name, violation]));
  return weights
    .filter((tool) => selector === undefined || tool.name === selector)
    .map((tool) => {
      const grandfathered = ALLOW_OVER_BUDGET.has(tool.name);
      const overBudget = tool.weight > BUDGET && !grandfathered;
      const overHardCap = tool.weight > HARD_CAP;
      const violation = violations.get(tool.name);
      return {
        name: tool.name,
        weight: tool.weight,
        budget: BUDGET,
        hardCap: HARD_CAP,
        overBudget,
        overHardCap,
        grandfathered,
        cutAtLeast: violation?.cutAtLeast ?? null,
        ...(tool.breakdown === undefined ? {} : { breakdown: tool.breakdown }),
      };
    });
}

export function formatToolWeightReport(
  rows: readonly ToolWeightRow[],
  catalogSize: number,
  options: { json?: boolean; selector?: string } = {},
): string {
  if (options.json) {
    return JSON.stringify(
      {
        catalogSize,
        budget: BUDGET,
        hardCap: HARD_CAP,
        tools: rows,
      },
      null,
      2,
    );
  }

  const lines = [
    `tool-weight: ${catalogSize} runtime-projected tools (budget ${BUDGET}, hard cap ${HARD_CAP})`,
  ];
  for (const row of rows) {
    let status: string;
    if (row.overHardCap) {
      status = `OVER HARD CAP; cut at least ${row.cutAtLeast} chars`;
    } else if (row.overBudget) {
      status = `OVER BUDGET; cut at least ${row.cutAtLeast} chars`;
    } else if (row.grandfathered) {
      status = 'GRANDFATHERED';
    } else {
      status = `OK; ${BUDGET - row.weight} chars of headroom`;
    }
    lines.push(`${row.name}: ${row.weight} chars (${status})`);
    // EI-19418721410168539: the total alone tells a trimmer HOW MUCH to cut but
    // not WHICH field to cut, which is what made trims guesswork. Every field is
    // printed even at 0, so the columns stay fixed-shape and greppable.
    if (row.breakdown) {
      const b = row.breakdown;
      lines.push(
        `  description ${b.description} · when ${b.when} · notWhen ${b.notWhen} · ` +
          `chaining ${b.chaining} · byRole ${b.byRole}`,
      );
    }
  }
  if (options.selector !== undefined && rows.length === 0) {
    lines.push(`No runtime-projected tool named ${options.selector}`);
  }
  return lines.join('\n');
}

export function runToolWeightCli(
  args: readonly string[],
  weights: readonly NamedToolWeight[],
  write: (text: string) => void = writeStdoutSync,
  error: (text: string) => void = console.error,
): number {
  let parsed: ToolWeightCliArgs;
  try {
    parsed = parseToolWeightArgs(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const measured = measureToolWeights(weights, parsed.selector);
  if (parsed.selector !== undefined && measured.length === 0) {
    error(`No runtime-projected tool named ${parsed.selector}`);
    return 1;
  }

  const rows = parsed.selector || parsed.all
    ? [...measured].sort((a, b) => b.weight - a.weight)
    : [...measured].sort((a, b) => b.weight - a.weight).slice(0, 20);
  write(formatToolWeightReport(rows, weights.length, { json: parsed.json, selector: parsed.selector }));

  // EI-21863941004984235 / EI-21863792505619206: a budget or hard-cap violation
  // in the MEASURED set (not just the truncated `rows` slice shown, which top-20
  // trims on an unfiltered run) must exit non-zero. This CLI's own exit code is
  // NOT wired into the green-checkpoint gate (that protection is the separate
  // Vitest budget guard, tools-md-sync.test.ts, plus tool-weight-selfcheck.ts's
  // hard-cap escalation) — but the report ALREADY prints "OVER BUDGET"/"OVER
  // HARD CAP" for these rows, so an exit-0 alongside that text is a false-green
  // an agent can (and did — EI-21863792505619206) cite as "0 violations" when
  // deciding whether a real gate breach exists. Make the exit code agree with
  // the report it just printed.
  const hasViolation = measured.some((row) => row.overBudget || row.overHardCap);
  return hasViolation ? 1 : 0;
}
