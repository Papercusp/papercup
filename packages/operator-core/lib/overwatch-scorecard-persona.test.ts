/**
 * overwatch-scorecard-persona.test.ts — the OWNER-#1 anti-drift guard
 * (rubric-driven-observations-2026-06-20 P-004 / B7, D-002).
 *
 * The owner's #1 requirement: the Overwatch role MUST, EVERY turn, emit a STRUCTURED
 * SCORECARD against the (now 14-point) `hive-coordination-health` rubric (rate each criterion
 * + cite evidence), IN ADDITION TO its free-form observations. That requirement lives in
 * the canonical Overwatch persona (`blueprints/coding/prompts/overwatch.md`) as prompt
 * instructions — there is no runtime that forces an LLM to emit a tool call, so the
 * persona text IS the contract. A refactor that softens "every turn" to "when relevant",
 * drops the emit shape, or renames a criterion key (silently desyncing from the seeded
 * rubric B6 + the capture accept-schema B1, which use these exact keys + the Record
 * `{rating, evidence}` shape) would quietly kill the owner mandate. This pins it so any
 * such drift trips here.
 *
 * The criterion keys below are the SHARED CONTRACT across B1 (improvements:capture
 * accept schema), B6 (the seeded `hive-coordination-health` rubric ids), and B7 (this
 * persona) — the founding 13 are 1:1 with the owner's Q1..Q13 (hive-coordination-test-loop
 * D-001), plus `scheduler-usage` (the 14th, rubric mig 371).
 * If you change a key here you MUST change it in lockstep in the seeded rubric + the
 * capture schema, or the emitted ratings stop mapping to the rubric.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { harnessPath } from './harness-paths';

const CANONICAL = harnessPath('blueprints', 'coding', 'prompts', 'overwatch.md');

/** The per-characteristic criterion keys — the founding 13 (owner Q1..Q13) plus
 *  `scheduler-usage` (14th, rubric mig 371 / hybrid-bee-scheduler-work-stealing-2026-06-22
 *  P-004 — within-hive scheduler-usage health). */
const CRITERION_KEYS = [
  'end-to-end-flow', // Q1
  'ideation-quality', // Q2
  'queen-workitem-selection', // Q3
  'queen-plan-selection', // Q4
  'parallel-distribution', // Q5
  'bee-execution', // Q6
  'bee-observation-quality', // Q7
  'overwatch-observation-quality', // Q8
  'watchdog-determinism', // Q9
  'coordination-comms', // Q10
  'chatter-economy', // Q11
  'coordination-utilization', // Q12
  'tool-utilization', // Q13
  'scheduler-usage', // Q14 (scheduler P-004)
] as const;

describe('overwatch persona — the owner #1 hive-coordination-health scorecard mandate (D-002)', () => {
  const persona = readFileSync(CANONICAL, 'utf8');

  it('MANDATES the scorecard EVERY turn (not "when relevant"), against the named rubric', () => {
    // The rubric is named + referenced as the standing per-turn output.
    expect(persona).toContain('hive-coordination-health');
    // "every turn" + a hard-requirement framing — the load-bearing words of the mandate.
    expect(persona).toMatch(/every turn/i);
    expect(persona).toMatch(/without exception|non-negotiable|must/i);
    // It is a turn-completion step, not an optional flourish.
    expect(persona).toMatch(/hard turn-completion step/i);
  });

  it('carries all 14 criterion keys — a complete scorecard (the B1/B6/B7 shared contract)', () => {
    for (const key of CRITERION_KEYS) {
      // Each key appears as inline code (the persona lists `key` — em-dash gloss).
      expect(persona, `criterion key \`${key}\` must be listed in the persona`).toContain(
        `\`${key}\``,
      );
    }
    // Exactly fourteen — the founding 13 + scheduler-usage (mig 371). Guards against a
    // 15th sneaking in or one being dropped; move this in lockstep with the seeded rubric.
    expect(CRITERION_KEYS).toHaveLength(14);
  });

  it('pins the structured-observation emit shape (rubricRef + Record ratings via capture)', () => {
    expect(persona).toContain('improvements:capture');
    expect(persona).toMatch(/lane:\s*'observation'/);
    expect(persona).toContain('rubricRef');
    expect(persona).toContain('ratings');
    // The Record value shape — one { rating, evidence } per criterion, evidence mandatory.
    expect(persona).toMatch(/\{\s*rating[,:]/);
    expect(persona).toMatch(/evidence/);
    expect(persona).toMatch(/MANDATORY|mandatory/);
  });

  it('documents the four rating levels (healthy | degraded | broken | unknown)', () => {
    for (const level of ['healthy', 'degraded', 'broken', 'unknown']) {
      expect(persona, `rating level "${level}" must be documented`).toContain(level);
    }
  });

  it('keeps free-text observations first-class — the scorecard AUGMENTS, never replaces (D-001)', () => {
    expect(persona).toMatch(/in addition to/i);
    expect(persona).toMatch(/never instead|augment/i);
  });

  it('wires the scorecard into the end-of-turn close (the DONE verb requires it)', () => {
    // The terminal DONE verb enumerates scorecard-emission as a completion criterion,
    // so a turn cannot read as "done" without it.
    expect(persona).toMatch(/scorecard emitted/i);
  });

  // EI-6365: the Overwatch died mid-turn with intent "Need schema confidence for
  // improvements:capture to emit ... the scorecard before turn close" — it took a
  // live schema-lookup detour at turn close and never emitted, spawning duplicate
  // overwatch-scorecard-skipped advisories. Two root-cause defects, pinned here:
  it('makes the scorecard emit self-sufficient — no live schema lookup needed (EI-6365)', () => {
    // The persona must explicitly tell the Overwatch the worked example IS the complete,
    // verified call shape and NOT to "confirm the schema" before emitting — the exact
    // detour that stranded the turn.
    expect(persona).toMatch(/no live schema lookup/i);
    expect(persona).toMatch(/schema-confidence detour/i);
  });

  it('references rubrics:get with the CORRECT arg name (rubricId, not rubric) — EI-6365', () => {
    // The real rubrics:get tool arg is `rubricId` (see rubrics/get.ts). A `{ rubric: … }`
    // call fails validation, which is exactly what sends the Overwatch into the
    // schema-confidence spiral. Guard against the wrong arg re-appearing.
    expect(persona).not.toMatch(/rubrics:get\s*\{\s*rubric\s*:/);
    // If the persona references rubrics:get at all, it uses rubricId.
    if (/rubrics:get/.test(persona)) {
      expect(persona).toMatch(/rubrics:get\s*\{\s*rubricId\s*:/);
    }
  });
});
