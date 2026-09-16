/**
 * omp-seed-wire-budget — the same detector as claude-seed-wire-budget, pointed at the
 * OTHER seed: the core MCP spine handed to OMP/codex sessions and to operator-core role
 * launches. It is the sibling half of EI-23345472964244980 (catalog-wide argSchema wire
 * budget), and it exists because of a finding recorded in the canonical list itself.
 *
 * WHAT IS ACTUALLY WRONG HERE — and it is NOT the same shape as the Claude seed.
 *
 * The Claude seed was a REGRESSION: it doubled, nobody noticed, and shrinking it to 31
 * names recovered ~116K tokens/turn. This spine is not that. It is a DECLARED CEILING
 * WITH NO ENFORCEMENT. D-001 set a 256 KB wire ceiling and said crossing it "requires an
 * explicit owner decision". The canonical list's own comment records the measurement
 * (2026-09-05, real tools/list): the 47-entry spine was already 345,140 B — 32% OVER —
 * and states plainly why nobody was told:
 *
 *     "crossed silently, because the only guard that runs in CI is this count"
 *
 * There are two guards on that array today and BOTH count names: invoke.test.ts's ratchet
 * (<=48) and core-spine-inverses.test.ts's bloat ceiling (<=48). A name count cannot see
 * the cost — since D-001 measured 190,885 B on 2026-08-09 the seed has more than DOUBLED
 * in bytes while the ratchet moved 43->47, +9%. The bytes were never in the list; they
 * are in the schemas of tools already on it. So every addition was reviewed against an
 * instrument that was structurally blind to the thing the ceiling was about, and the
 * owner decision D-001 required was never triggered because nothing measured the trigger.
 *
 * WHAT THIS FILE MEASURED ON ITS FIRST RUN (2026-09-16): 353,380 B, in-repo, for the
 * 48-name spine — 34.8% over D-001's 262,144 B ceiling. Because this projection reads
 * BELOW the live wire (see the constant's docstring), that is a LOWER BOUND on the breach.
 * The eight heaviest are not close to marginal:
 *
 *     43,709  work_items:complete      20,722  loop:checkpoint
 *     38,747  coord:send               19,396  improvements:capture
 *     24,012  work_items:checkpoint    15,156  facts:assert
 *     22,378  fleet:launch-on-plan     11,332  work_items:create
 *
 * Those eight are 195,452 B — 55% of the spine across 8 of 48 names. The concentration is
 * the actionable part: this is not 48 tools each a little too fat, it is a handful of
 * whales, and the top three alone (106,468 B) exceed 40% of D-001's entire ceiling.
 *
 * THIS FILE IS THAT MEASUREMENT. It is deliberately a RATCHET pinned at the current size,
 * not an attempt to enforce 256 KB today: the spine is mirrored from a canonical list
 * under a lockstep guard, and bringing it under D-001's ceiling is schema-slimming work on
 * the whales (coord:send alone is ~39 KB; work_items:complete and work_items:checkpoint
 * each inline their full nested payload schema TWICE, for the single shorthand and the
 * items[] batch). What the ratchet changes is the direction of travel: growth now has to
 * argue with a number instead of slipping past a name count, and the debt is stated in a
 * failing-message the next editor reads rather than in a comment they do not.
 *
 * WHY THE CANONICAL LIST AND NOT THE LAUNCHER MIRROR. CORE_MCP_TOOL_NAMES is what D-001
 * ruled on, what `role-launch-spec.ts` hands to operator-core role launches, and what
 * apps/operator/scripts/psu-launcher.mjs mirrors into OMP_CORE_MCP_TOOL_NAMES for OMP/codex
 * psu sessions. Measuring the canonical one covers every consumer; the mirror is asserted
 * identical below so a cost claim about one is a cost claim about both.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { listAllProjectedTools, type ProjectedTool } from '@papercusp/tooldef';
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';
import { advertisedWireBytes, MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations.
import { OMP_CORE_MCP_TOOL_NAMES } from '../../../../apps/operator/scripts/psu-launcher.mjs';

/**
 * Ratchet on the core spine's advertised tools/list wire payload, pinned to its CURRENT
 * measured size. Shrink-only.
 *
 * MEASURED 2026-09-16 by this file: 353,380 B for the 48-name spine.
 *
 * ⚠ THIS IS A RATCHET, NOT D-001's CEILING, AND THE GAP IS THE POINT. D-001's ceiling is
 * 256 KB (262,144 B). The reading above is 34.8% over it — and that comparison needs no
 * extrapolation, which is what makes it worth stating: this projection UNDER-reads the
 * wire (see below), so 353,380 B is a LOWER BOUND on the breach, not an estimate of it.
 * This constant is therefore a RECORD OF A DEBT, not an allowance: it stops the debt
 * growing while the schema-slimming that would discharge it is done on the whale tools.
 *
 * ⚠ IN-REPO READING, NOT A WIRE READING. advertisedWireBytes() measures the same catalog
 * the server renders from but skips its late entity-enum/sanitize passes, so it reads
 * BELOW the live endpoint (measured the same week: 90,869 B in-repo for names the live
 * endpoint served as 113,588 B — a ratio of 0.80). Never re-seed this constant from a
 * live tools/list: that would silently hand the spine ~20% of free growth. Re-seed it
 * only from a fresh run of THIS file.
 *
 * ⚠ AND DO NOT RUN THAT RATIO BACKWARDS TO QUOTE A WIRE NUMBER HERE. It was measured on a
 * different tool set (the Claude seed), so applying it to this one yields an estimate,
 * not a measurement — and an estimate written into a constant's docstring is read as a
 * measurement by the next person. If a wire figure is needed, measure the wire.
 *
 * LOWERING IT IS ALWAYS CORRECT AND NEEDS NO CEREMONY. Raising it is an owner decision
 * under D-001, which this spine is already in breach of.
 */
export const CORE_SPINE_WIRE_BYTE_RATCHET = 360_000;

/** D-001's stated ceiling, for the failure message to quote. Not asserted — the spine is
 *  already over it, so asserting it would red the gate on a pre-existing, tracked debt
 *  instead of on the new growth this file exists to catch. */
const D001_WIRE_CEILING_BYTES = 256 * 1024;

/**
 * Lower plausibility floor on the SAME measurement — this guard's own vacuous-green trap.
 *
 * Every assertion here is an UPPER bound, and an upper bound is satisfied trivially by a
 * broken instrument: if `inputSchema` stops being populated on ProjectedTool (a projection
 * change, a renamed field), advertisedWireBytes() collapses toward zero, the ratchet
 * passes with room to spare, and this file reports healthy while measuring nothing. The
 * catalog-size and name-resolution floors do NOT catch that — they check the catalog and
 * the names, not the bytes. A reading below this floor means the instrument broke, not
 * that the spine got cheap.
 */
const MIN_PLAUSIBLE_SPINE_WIRE_BYTES = 140_000;

function mcpName(t: ProjectedTool): string | null {
  return (t as { expose?: { mcp?: { name?: string } } }).expose?.mcp?.name ?? null;
}

describe('core MCP spine wire budget (EI-23345472964244980 / D-001)', () => {
  let byName: Map<string, ProjectedTool>;
  let catalogSize = 0;

  beforeAll(async () => {
    // Side-effect import: registers the catalog listAllProjectedTools() reads. A bare
    // tsx import of this barrel HANGS — registration needs the vitest bootstrap.
    await import('./index');
    const all = listAllProjectedTools();
    catalogSize = all.length;
    byName = new Map();
    for (const t of all) {
      const n = mcpName(t);
      if (n) byName.set(n, t);
    }
  });

  const rows = () =>
    (CORE_MCP_TOOL_NAMES as readonly string[])
      .map((n) => ({ name: n, bytes: byName.has(n) ? advertisedWireBytes(n, byName.get(n)!) : 0 }))
      .sort((a, b) => b.bytes - a.bytes);

  it('sees a genuinely-registered catalog (a vacuous green is worse than a red)', () => {
    expect(
      catalogSize,
      `listAllProjectedTools() returned ${catalogSize} tool(s). Below ${MIN_PLAUSIBLE_CATALOG_SIZE} ` +
        `means the agent-tools barrel did not register — every measurement in this file would be ` +
        `vacuously clean.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_CATALOG_SIZE);
    expect(CORE_MCP_TOOL_NAMES.length).toBeGreaterThan(12);
  });

  it('every spine name resolves to a real catalog tool', () => {
    // A typo'd name is silently DROPPED by the server's ?tools= allowlist: the agent never
    // sees that tool, and the byte total goes DOWN — so the ratchet below would read green
    // for a broken spine. This is what stops that.
    const missing = (CORE_MCP_TOOL_NAMES as readonly string[]).filter((n) => !byName.has(n));
    expect(
      missing,
      missing.length
        ? `Spine name(s) not in the projected catalog: ${missing.join(', ')}. A name that does ` +
          `not resolve is dropped from the advertised surface — the agent never sees the tool.`
        : undefined,
    ).toEqual([]);
  });

  it('the launcher mirror is identical, so this measurement covers OMP/codex too', () => {
    // psu-launcher.test.ts already holds the canonical lockstep drift guard. This is not a
    // duplicate of it: it is what entitles THIS file to measure the canonical list and
    // state a cost for OMP sessions, which are served the mirror. If the two ever diverge,
    // the number below stops describing OMP and the claim in this file's header goes quiet
    // rather than wrong.
    expect([...(OMP_CORE_MCP_TOOL_NAMES as string[])]).toEqual([...CORE_MCP_TOOL_NAMES]);
  });

  it('the advertised spine stays within its measured wire ratchet', () => {
    const all = rows();
    const total = all.reduce((s, r) => s + r.bytes, 0);

    // Floor FIRST: a collapsed measurement must be loud, not silently under budget.
    expect(
      total,
      `measured only ${total.toLocaleString()} B for ${CORE_MCP_TOOL_NAMES.length} spine tools. ` +
        `Below ${MIN_PLAUSIBLE_SPINE_WIRE_BYTES.toLocaleString()} B means the projection stopped ` +
        `carrying argSchema — the instrument broke, the spine did not get cheap. Every other ` +
        `assertion here is an upper bound and would pass anyway.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_SPINE_WIRE_BYTES);

    expect(
      total,
      total > CORE_SPINE_WIRE_BYTE_RATCHET
        ? `\n\nCORE MCP SPINE OVER ITS WIRE RATCHET: ${total.toLocaleString()} B > ` +
          `${CORE_SPINE_WIRE_BYTE_RATCHET.toLocaleString()} B.\n` +
          `This spine is advertised to every OMP/codex psu session and every operator-core role ` +
          `launch, and its cost is paid on EVERY turn.\n\n` +
          `⚠ IT IS ALREADY OVER D-001's ${D001_WIRE_CEILING_BYTES.toLocaleString()} B CEILING ` +
          `(measured 345,140 B on a real tools/list, 2026-09-05). The ratchet above is a record ` +
          `of that debt, not an allowance — so this red means the debt GREW.\n\n` +
          `Heaviest spine tools:\n` +
          all
            .slice(0, 8)
            .map((r) => `  ${String(r.bytes).padStart(7)}  ${r.name}`)
            .join('\n') +
          `\n\nFIX, cheapest first:\n` +
          `  (a) SHRINK the argSchema of an offender above — this is the lever that actually\n` +
          `      moves the number. The whales inline their full nested payload schema TWICE\n` +
          `      (single shorthand + items[] batch); collapsing that duplication is the single\n` +
          `      largest available win and costs no tool its place on the spine.\n` +
          `      ⚠ npm run tool-weight's PROMPT budget will look fine while this fails — it\n` +
          `      measures description+guidance. Read the argSchema half of its report instead.\n` +
          `  (b) UNSEED a name — but do it in BOTH lists in the same change:\n` +
          `      libs/papercusp/packages/orchestrator/src/invoke.ts (canonical) AND\n` +
          `      apps/operator/scripts/psu-launcher.mjs (OMP mirror). psu-launcher.test.ts\n` +
          `      compares them EXACTLY, so editing one alone trades this red for that one.\n` +
          `      An unseeded tool stays reachable via tools:find / tools:invoke, both of which\n` +
          `      are themselves on the spine.\n` +
          `  (c) RAISE the ratchet — an owner decision under D-001, which this spine is\n` +
          `      already in breach of. Re-seed it from a fresh run of THIS file, never from a\n` +
          `      live tools/list (that reads ~20% higher and would gift the spine the gap).\n`
        : undefined,
    ).toBeLessThanOrEqual(CORE_SPINE_WIRE_BYTE_RATCHET);
  });

  it('CONTROL: the ratchet actually fires when the spine grows', () => {
    // A budget guard nobody has seen fail is a budget guard nobody has tested. Adding the
    // heaviest NON-spine verbs must blow the ceiling — proved without mutating the tree.
    const offSpine = [...byName.keys()]
      .filter((n) => !(CORE_MCP_TOOL_NAMES as readonly string[]).includes(n))
      .map((n) => ({ name: n, bytes: advertisedWireBytes(n, byName.get(n)!) }))
      .sort((a, b) => b.bytes - a.bytes);
    expect(offSpine.length, 'expected off-spine tools to exist in the catalog').toBeGreaterThan(0);

    const base = rows().reduce((s, r) => s + r.bytes, 0);
    const regrown = offSpine.slice(0, 5).reduce((s, r) => s + r.bytes, base);
    expect(regrown).toBeGreaterThan(CORE_SPINE_WIRE_BYTE_RATCHET);
  });

  it('the ratchet is pinned near the measurement, not parked far above it', () => {
    // The failure mode a ratchet has that a budget does not: re-seeded generously once, it
    // stops being a ratchet and becomes headroom, silently, while still reading as a guard.
    //
    // ⚠ THIS ASSERTION FIRES ON SUCCESS, BY DESIGN — read its message before "fixing" it.
    // Slimming a whale's schema is exactly what the ratchet above asks for, and it makes
    // the slack GROW. That red is the ratchet tightening, not a regression: a ratchet that
    // never re-pins after a win is just a ceiling with extra steps. The remedy is a
    // one-line DOWNWARD re-pin, which needs no ceremony and no owner decision.
    const total = rows().reduce((s, r) => s + r.bytes, 0);
    const slack = CORE_SPINE_WIRE_BYTE_RATCHET - total;
    expect(
      slack,
      `the ratchet is pinned ${slack.toLocaleString()} B above the current ` +
        `${total.toLocaleString()} B measurement — more slack than ordinary schema churn needs, ` +
        `so it has stopped being a ratchet and become unreviewed headroom.\n\n` +
        `If you just SHRANK a schema: that is the win this file exists to ask for. Re-pin ` +
        `CORE_SPINE_WIRE_BYTE_RATCHET down to just above ${total.toLocaleString()} B and bank it ` +
        `— lowering is always correct and needs no owner decision.\n` +
        `If you did NOT: someone re-seeded the ratchet generously instead of tightly. Same fix.`,
    ).toBeLessThan(30_000);
  });
});
