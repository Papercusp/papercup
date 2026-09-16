/**
 * claude-seed-wire-budget — the AUTOMATIC detector for the regression class behind
 * EI-23319364088969722 (psu Claude first-turn context 151K -> 317K on 2026-09-11).
 *
 * THE CLASS THIS KILLS. A psu Claude session pays, on EVERY turn, the full JSON
 * schema of every tool its MCP seed advertises — because denying ToolSearch (owner
 * directive: one call cost +67,045 tokens bypassing the result door) also removes
 * Claude's native schema DEFERRAL, which is implemented BY that tool. So the
 * advertised surface stopped being a discovery convenience and became a per-turn
 * context bill. Measured 2026-09-15: the 64-name seed cost 432,714 B on the wire,
 * ~157K tokens — essentially the entire reported regression.
 *
 * WHY NOBODY CAUGHT IT FOR FOUR DAYS, and why this file is a TEST rather than an alarm:
 *
 *   1. Every one of those 64 names was added individually, each with real demand
 *      evidence (reaches/callers, reach-per-KB) and each individually defensible.
 *      NOTHING EVER MEASURED THE AGGREGATE. A per-item justification process with no
 *      total is not a budget, and it drifts in one direction only.
 *   2. The repo's existing weight instrument measures the WRONG HALF. `npm run
 *      tool-weight` / `tool-guidance-budget.ts` govern promptWeight — description +
 *      guidance, budget 1,500 chars/tool. But the cost here is dominated by argSchema,
 *      which that budget does not look at: coord:send is ~1.2K of guidance and
 *      39,254 B of schema. A tool can sit comfortably inside the prompt-weight budget
 *      and still cost 30 KB a turn.
 *   3. The obvious runtime signal does NOT work. harness_shared.agent_usage_samples
 *      was the natural place to watch first-turn size, and it CANNOT see this: its
 *      rows are periodic CUMULATIVE snapshots (turn_count is NULL; cache_read_tokens
 *      grows across rows for one session), and the population mixes every anthropic
 *      session in the workspace. Tested against the known 09-11 step: n=1-5 boots/day
 *      with medians swinging 82K / 770K / 104K and no visible step. A threshold alarm
 *      there would have fired all through August and still missed the real event.
 *
 * So the detector is deterministic and lives at the SOURCE: measure what the seed
 * actually costs on the wire, from the same projected catalog the server advertises,
 * and fail the build when it grows. No sampling, no thresholds, no false positives.
 *
 * WHAT IT CATCHES that the ratchet in psu-launcher.test.ts does not: that ratchet
 * bounds the NUMBER of seeded names. This bounds their COST — so it also fires when
 * someone leaves the seed list alone and grows a SEEDED TOOL'S SCHEMA, which is the
 * same regression arriving through a different door and is invisible to a name count.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { listAllProjectedTools, type ProjectedTool } from '@papercusp/tooldef';
import { advertisedWireBytes } from './tool-guidance-budget';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations. Imported directly
// (rather than mirrored into a second list guarded for drift, the way
// OMP_CORE_MCP_TOOL_NAMES mirrors the orchestrator's CORE_MCP_TOOL_NAMES) because the
// launcher is dependency-free by design: importing it makes seed drift STRUCTURALLY
// IMPOSSIBLE instead of merely detected.
import { CLAUDE_MINIMAL_SEED_TOOL_NAMES } from '../../../../apps/operator/scripts/psu-launcher.mjs';

/**
 * Ceiling on the advertised Claude seed's tools/list wire payload.
 *
 * MEASURED 2026-09-15 against the live MCP endpoint (:3170, ctx_tier=trimmed), summing
 * Buffer.byteLength(JSON.stringify(tool)) over the advertised entries:
 *   historical 64-name seed ... 432,714 B
 *   current 31-name seed ...... 113,588 B   (-319,126 B, -73.7%, ~-116K tokens/turn)
 *
 * The in-repo projection below is the same catalog the server renders from but skips
 * the server's late entity-enum/sanitize passes (packages/agent-mcp/src/server.ts:758),
 * so it is a faithful REGRESSION signal rather than a byte-exact replica of the wire.
 * ⚠ IT THEREFORE READS LOWER THAN THE WIRE — measured the same day: this projection
 * totals 90,869 B for the same 31 names the live endpoint serves as 113,588 B (~20%).
 * Compare in-repo numbers to in-repo numbers; do not read 90,869 as the context cost.
 * This budget is set just above the in-repo reading, so the ~9 KB of headroom covers
 * ordinary schema drift — it is NOT spare budget to spend.
 *
 * RAISING THIS IS A BUDGET DECISION, NOT A CHORE. Before you raise it, re-measure
 * against a live tools/list, and prefer the alternative that costs 0 B/turn: leave the
 * tool unseeded and let tools:find/tools:invoke reach it in one round-trip. A seeded
 * tool is paid for on every turn of every session, forever.
 */
export const CLAUDE_SEED_WIRE_BYTE_BUDGET = 100_000;

/**
 * Lower plausibility floor on the SAME measurement — the guard's own vacuous-green trap.
 *
 * Every assertion here is an UPPER bound, and an upper bound is satisfied trivially by a
 * broken instrument: if `inputSchema` ever stops being populated on ProjectedTool (a
 * projection change, a renamed field), wireBytes() collapses toward zero, the budget
 * passes with room to spare, and this file reports healthy while measuring nothing. The
 * catalog-size and name-resolution floors above do NOT catch that — they check the
 * catalog and the names, not the bytes. This projection measures 90,869 B today, so a
 * reading below this floor means the instrument broke, not that the seed got cheap.
 */
const MIN_PLAUSIBLE_SEED_WIRE_BYTES = 50_000;

/** Mirrors tool-guidance-budget's MIN_PLAUSIBLE_CATALOG_SIZE. listAllProjectedTools()
 *  returns [] with NO error when the agent-tools barrel has not registered — over an
 *  empty catalog every assertion below would pass while measuring nothing, which is the
 *  exact vacuous green this repo has already been bitten by twice
 *  (EI-19377066316560032). Floor first, so a broken import is LOUD. */
const MIN_PLAUSIBLE_CATALOG_SIZE = 500;

function mcpName(t: ProjectedTool): string | null {
  return (t as { expose?: { mcp?: { name?: string } } }).expose?.mcp?.name ?? null;
}

/** The shape the server advertises per tool. Shared with omp-seed-wire-budget so the two
 *  seed budgets cannot drift onto different measurements. */
function wireBytes(name: string, t: ProjectedTool): number {
  return advertisedWireBytes(name, t as { description?: string; inputSchema?: unknown });
}

describe('Claude seed wire budget (EI-23319364088969722)', () => {
  let byName: Map<string, ProjectedTool>;
  let catalogSize = 0;

  beforeAll(async () => {
    // Side-effect import: registers the catalog listAllProjectedTools() reads.
    await import('./index');
    const all = listAllProjectedTools();
    catalogSize = all.length;
    byName = new Map();
    for (const t of all) {
      const n = mcpName(t);
      if (n) byName.set(n, t);
    }
  });

  it('sees a genuinely-registered catalog (a vacuous green is worse than a red)', () => {
    expect(
      catalogSize,
      `listAllProjectedTools() returned ${catalogSize} tool(s). Below ${MIN_PLAUSIBLE_CATALOG_SIZE} ` +
        `means the agent-tools barrel did not register — every measurement in this file would be ` +
        `vacuously clean.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_CATALOG_SIZE);
    expect(CLAUDE_MINIMAL_SEED_TOOL_NAMES.length).toBeGreaterThan(12);
  });

  it('every seeded name resolves to a real catalog tool', () => {
    // A typo'd seed name is silently DROPPED by the server's ?tools= allowlist: the
    // agent simply never sees that tool, and the byte total goes DOWN — so the budget
    // assertion below would read green for a broken seed. This is what stops that.
    const missing = (CLAUDE_MINIMAL_SEED_TOOL_NAMES as string[]).filter((n) => !byName.has(n));
    expect(
      missing,
      missing.length
        ? `Seeded name(s) not in the projected catalog: ${missing.join(', ')}. A name that does ` +
          `not resolve is dropped from the advertised surface — the agent never sees the tool.`
        : undefined,
    ).toEqual([]);
  });

  it('the advertised seed stays within its measured wire budget', () => {
    const rows = (CLAUDE_MINIMAL_SEED_TOOL_NAMES as string[])
      .map((n) => ({ name: n, bytes: byName.has(n) ? wireBytes(n, byName.get(n)!) : 0 }))
      .sort((a, b) => b.bytes - a.bytes);
    const total = rows.reduce((s, r) => s + r.bytes, 0);

    // Floor FIRST: a collapsed measurement must be loud, not silently under budget.
    expect(
      total,
      `measured only ${total.toLocaleString()} B for ${CLAUDE_MINIMAL_SEED_TOOL_NAMES.length} seeded ` +
        `tools (this projection reads ~90,869 B today). Below ${MIN_PLAUSIBLE_SEED_WIRE_BYTES.toLocaleString()} B ` +
        `means the projection stopped carrying argSchema — the instrument broke, the seed did not ` +
        `get cheap. Every other assertion here is an upper bound and would pass anyway.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_SEED_WIRE_BYTES);

    expect(
      total,
      total > CLAUDE_SEED_WIRE_BYTE_BUDGET
        ? `\n\nCLAUDE SEED OVER WIRE BUDGET: ${total.toLocaleString()} B > ` +
          `${CLAUDE_SEED_WIRE_BYTE_BUDGET.toLocaleString()} B.\n` +
          `This is context every psu Claude session pays on EVERY turn (ToolSearch is denied, ` +
          `so there is no schema deferral).\n\nHeaviest seeded tools:\n` +
          rows
            .slice(0, 8)
            .map((r) => `  ${String(r.bytes).padStart(7)}  ${r.name}`)
            .join('\n') +
          `\n\nFIX, cheapest first:\n` +
          `  (a) UNSEED it — drop the name from CLAUDE_MINIMAL_SEED_TOOL_NAMES in\n` +
          `      apps/operator/scripts/psu-launcher.mjs. It stays fully reachable via\n` +
          `      tools:find / tools:invoke at a one-round-trip cost instead of every turn.\n` +
          `  (b) SHRINK the argSchema of the offender above (note: npm run tool-weight measures\n` +
          `      description+guidance, NOT argSchema — it will look fine while this fails).\n` +
          `  (c) RAISE the budget — only with a fresh live tools/list measurement recorded on\n` +
          `      CLAUDE_SEED_WIRE_BYTE_BUDGET, as a deliberate per-turn cost decision.\n`
        : undefined,
    ).toBeLessThanOrEqual(CLAUDE_SEED_WIRE_BYTE_BUDGET);
  });

  it('CONTROL: the budget assertion actually fires when the seed grows', () => {
    // A budget guard nobody has seen fail is a budget guard nobody has tested. Adding the
    // heaviest non-seeded verbs must blow the ceiling — proved without mutating the tree.
    const heavies = ['work_items:complete', 'coord:send', 'work_items:checkpoint'].filter((n) =>
      byName.has(n),
    );
    expect(heavies.length, 'expected the known heavy verbs to exist in the catalog').toBeGreaterThan(0);

    const seeded = (CLAUDE_MINIMAL_SEED_TOOL_NAMES as string[]).reduce(
      (s, n) => s + (byName.has(n) ? wireBytes(n, byName.get(n)!) : 0),
      0,
    );
    const regrown = heavies.reduce((s, n) => s + wireBytes(n, byName.get(n)!), seeded);
    expect(regrown).toBeGreaterThan(CLAUDE_SEED_WIRE_BYTE_BUDGET);
  });

  it('the seven measured heavies stay OUT of the advertised seed', () => {
    // 187,841 B for seven names in the old seed, and not one is promoted by the generated
    // bash->tool routing table (so seed-mandate-coverage will not object to their absence).
    for (const n of [
      'work_items:complete',
      'coord:send',
      'work_items:checkpoint',
      'fleet:launch-on-plan',
      'loop:checkpoint',
      'improvements:capture',
      'facts:assert',
    ]) {
      expect(CLAUDE_MINIMAL_SEED_TOOL_NAMES).not.toContain(n);
    }
  });
});
