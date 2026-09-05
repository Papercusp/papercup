/**
 * orient-task-schema-pack-live-contract.test.ts — EI-21281382734417014.
 *
 * The sibling `orient-task-schema-pack.test.ts` already asserts that
 * `work_items:complete`'s compact preview keeps BOTH terminal contracts
 * (`assumptions?` and the `completion?:object structured record` marker). It
 * asserts them against a SYNTHETIC fixture: every catalog entry there is a
 * hand-built 2-property schema, and the `completion` case splices in 20 short
 * `evidence*` string props. That pins the MECHANISM; it never exercises the
 * real tool.
 *
 * That gap is what let the recurrence this file is named for go unnoticed. The
 * real `work_items:complete` schema is enormous — its `completion` description
 * alone is ~2.5KB of prose — which is exactly the regime where a suffix
 * fragment can exceed `suffixBudget` and be silently skipped by the `continue`
 * in `compactSchema`. A 20-short-prop fixture cannot reproduce that regime, so
 * a green fixture test and a broken live preview look identical.
 *
 * So this guard runs the LIVE projected catalog through the real pack builder
 * across a representative slice of the input space (intents × mode stacks), and
 * checks the property an agent actually depends on: after compaction, the
 * preview it is handed must still say that a terminal close needs
 * `assumptions` and that `completion` is a structured object — not a prose
 * shorthand.
 *
 * Two things keep this from being a vacuous green:
 *   1. a catalog-size floor, so an unregistered registry (the standalone-probe
 *      failure mode: `listAllProjectedTools()` returns [] outside the vitest
 *      bootstrap) fails loudly instead of reporting "0 packs, 0 problems";
 *   2. a permanent NEGATIVE CONTROL — the same builder over a catalog whose
 *      work_items:complete schema has had both contracts removed must produce a
 *      preview WITHOUT them. If the control ever starts passing the positive
 *      assertions, the assertions have stopped measuring anything.
 */
import { describe, it, expect } from 'vitest';
import '../../index';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { MIN_PLAUSIBLE_CATALOG_SIZE } from '../../tool-guidance-budget';
import { buildTaskToolSchemaPack } from './orient-task-schema-pack';

const TOOL = 'work_items:complete';
const ASSUMPTIONS_MARKER = /assumptions\?/;
const COMPLETION_MARKER = 'completion?:object structured record';

interface CatalogEntry {
  expose?: { mcp?: { name?: string } | null };
  inputSchema?: unknown;
}

/** The input shapes a real session actually orients with. */
const CASES: { label: string; input: Parameters<typeof buildTaskToolSchemaPack>[0] }[] = [
  { label: 'bare recovery', input: { intent: undefined, modes: [] } },
  { label: 'auto member', input: { intent: 'resume the queue and complete the held work-item', modes: ['auto'] } },
  { label: 'drain', input: { intent: 'drain the backlog to terminal and close every filing with evidence', modes: ['drain'] } },
  {
    label: 'auto+drain+ideate with lane',
    input: {
      intent: 'hand off my lane, dispatch the remaining plan items, and grade the rubric scorecard',
      modes: ['auto', 'drain', 'ideate'],
      harness: 'papercusp',
      plan: 'tool-contract-repair-2026-09-05',
      planItems: ['P-001', 'P-002', 'P-003'],
      recipeTitles: ['drain the fleet backlog', 'checkpoint and hand off'],
    },
  },
  {
    label: 'recovery intent (reserves loop:checkpoint detail slot)',
    input: { intent: 'checkpoint loop recovery then run the recipe batch fan-out', modes: ['auto'] },
  },
];

function liveCatalog(): CatalogEntry[] {
  return listAllProjectedTools() as unknown as CatalogEntry[];
}

function previewFor(catalog: readonly CatalogEntry[], input: Parameters<typeof buildTaskToolSchemaPack>[0]) {
  const pack = buildTaskToolSchemaPack(input, catalog as never);
  const entry = pack.tools.find((tool) => tool.name === TOOL);
  return { pack, entry };
}

describe('orient task schema pack — live work_items:complete terminal contracts', () => {
  it('reads a genuinely-registered catalog (guards the vacuous-green probe failure)', () => {
    expect(liveCatalog().length).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);
  });

  it.each(CASES)('$label keeps both terminal contracts in the compact preview', ({ input }) => {
    const { pack, entry } = previewFor(liveCatalog(), input);

    // The preview slot itself is part of the contract: an agent that is handed
    // the tool NAME but no args has to pay a tools:find round-trip precisely
    // when it is recovering from compaction.
    expect(pack.toolNames).toContain(TOOL);
    expect(entry, `${TOOL} was evicted from the schema-detail set`).toBeTruthy();
    expect(entry?.args, `${TOOL} kept its detail slot but lost its args to the char budget`).toBeTruthy();

    const args = String(entry?.args);
    expect(args).toMatch(ASSUMPTIONS_MARKER);
    expect(args).toContain(COMPLETION_MARKER);

    // The pack must stay inside its declared budget, or the eviction loop above
    // starts nulling args from the tail — and work_items:complete sits second
    // from the end of the ordinary detail set.
    expect(pack.budget.serializedChars).toBeLessThanOrEqual(pack.budget.maxChars);
  });

  it('NEGATIVE CONTROL: a catalog whose schema drops both contracts renders a preview without them', () => {
    const catalog = liveCatalog();
    const index = catalog.findIndex((tool) => tool.expose?.mcp?.name === TOOL);
    expect(index, `${TOOL} is absent from the live catalog — the positive cases above are meaningless`)
      .toBeGreaterThanOrEqual(0);

    const original = catalog[index];
    const schema = JSON.parse(JSON.stringify(original.inputSchema)) as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.assumptions, 'live schema shape changed — re-derive this control').toBeTruthy();
    expect(schema.properties?.completion, 'live schema shape changed — re-derive this control').toBeTruthy();

    // Deliberately wrong input: no `assumptions` property at all, and
    // `completion` renamed so the `name === 'completion'` branch cannot fire.
    // The schema stays long enough that compactSchema still has to clip.
    schema.properties = { ...schema.properties };
    schema.properties.completionRecord = schema.properties.completion;
    delete schema.properties.completion;
    delete schema.properties.assumptions;

    const stripped = catalog.map((tool, i) => (i === index ? { ...tool, inputSchema: schema } : tool));
    const { entry } = previewFor(stripped, CASES[0].input);

    expect(entry?.args, 'the control must still render a preview, just without the contracts').toBeTruthy();
    const args = String(entry?.args);
    expect(args).not.toMatch(ASSUMPTIONS_MARKER);
    expect(args).not.toContain(COMPLETION_MARKER);
    // Still clipped: this proves the control exercised the same compactSchema
    // path as the positive cases rather than short-circuiting on a small schema.
    expect(args.length).toBeGreaterThan(100);
  });
});
