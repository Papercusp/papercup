/**
 * Construct-validity guard for SU-S09 (WI-8249).
 *
 * S09 measures whether the model can read the positional `[coord+N]` block and
 * name the dev-server holder (`5580e`, on the `#` scope-window line) rather than
 * a decoy (`ab533` intent / `9042e` finding).
 *
 * WI-8249 cites S09's 2026-06-08 result — "3/3 misread, the deterministic
 * glyph-misread assert fired in 2/3" — as the evidence for redesigning the
 * highest-volume injection surface in the system (worded labels at a per-LINE
 * token cost). Before anyone pays that, the instrument that produced the number
 * has to be able to tell a misread from a CORRECT answer.
 *
 * It could not. S09's decoy assert was a bare `assertTextForbids`, i.e. a naked
 * `pattern.test()` over the whole reply, so a reply that correctly identifies
 * `5580e` and then *dismisses* the decoys — the most useful answer a peer could
 * give — failed exactly as hard as one that named a decoy as the holder.
 *
 * That defect class was already diagnosed on a SIBLING scenario and fixed there:
 * see `assertTextForbidsAffirmed`'s docstring ("Observed live (SU-S05,
 * 2026-07-17) … a false positive that would have masked a genuine behavioral
 * fix … an assert-authoring gap, not a model regression"). S05 was migrated;
 * S09 was not, and its cited measurement PREDATES the fix entirely.
 *
 * These tests pin the discrimination in BOTH directions, so the assert cannot
 * silently regress to something that only ever says "fail":
 *   - a correct answer (minimal OR thorough) must produce NO violation;
 *   - a genuine misread (a decoy named as the holder) MUST still violate.
 * The second case is the falsifiability control — without it, an assert that
 * never fires would pass this file.
 */

import { describe, it, expect } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import SU_S09_COORD_INJECTION_READ from './S09-coord-injection-read';

function mkTurn(partial: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...partial,
  };
}

function mkRun(turns: TurnResult[]): RunSummary {
  return {
    scenarioId: SU_S09_COORD_INJECTION_READ.id,
    turns,
    totalCostUsd: 0,
    totalLatencyMs: 0,
addendum: undefined,
  } as unknown as RunSummary;
}

/** S09's asserts, by the names the scenario declares. */
function assertByName(name: string) {
  const found = SU_S09_COORD_INJECTION_READ.asserts.find(
    (a) => (a as { name?: string }).name === name,
  );
  if (!found) throw new Error(`S09 no longer declares an assert named "${name}"`);
  return found as { name: string; eval: (run: RunSummary) => unknown[] };
}

const HOLDER = 'reads-the-window-holder-from-the-hash-glyph-line';
const DECOY = 'no-glyph-or-line-misread';

describe('SU-S09 construct validity — the decoy assert must discriminate, not just fire (WI-8249)', () => {
  it('a MINIMAL correct answer (names only the holder) produces no violations', () => {
    const run = mkRun([
      mkTurn({
        assistantText:
          'Coordinate with 5580e — they are holding the dev-server for an exclusive restart for the release-gate deploy.',
      }),
    ]);
    expect(assertByName(HOLDER).eval(run)).toEqual([]);
    expect(assertByName(DECOY).eval(run)).toEqual([]);
  });

  it('a THOROUGH correct answer — names the holder, then dismisses the decoys — must NOT be scored as a misread', () => {
    // This is the reply shape a good peer actually writes: it answers, then rules
    // out the other two lines so the reader knows they were considered. Under a
    // bare `assertTextForbids` this fails as hard as a genuine misread, which is
    // how a correct model gets recorded as "misread 3/3".
    const run = mkRun([
      mkTurn({
        assistantText:
          'Coordinate with 5580e — the `#` scope-window line shows them holding the dev-server ' +
          'for an exclusive restart for the release-gate deploy. The other two lines are not ' +
          'about the dev-server: ab533 is an intent (pre-prompt registry) and 9042e is a ' +
          'finding (migration 174 collision).',
      }),
    ]);
    expect(assertByName(HOLDER).eval(run)).toEqual([]);
    expect(assertByName(DECOY).eval(run)).toEqual([]);
  });

  it('FALSIFIABILITY CONTROL: a genuine misread (a decoy named as the holder) still violates', () => {
    const run = mkRun([
      mkTurn({
        assistantText:
          'Coordinate with ab533 — they are the one currently working on the dev-server.',
      }),
    ]);
    expect(assertByName(DECOY).eval(run).length).toBeGreaterThan(0);
  });

  it('FALSIFIABILITY CONTROL: the other misread shape — a decoy named AS the holder — still violates', () => {
    const run = mkRun([
      mkTurn({
        assistantText:
          'Looks like 9042e is holding the dev-server right now, so check with them first.',
      }),
    ]);
    expect(assertByName(DECOY).eval(run).length).toBeGreaterThan(0);
  });

  it('FALSIFIABILITY CONTROL: an answer that never names the holder fails the load-bearing assert', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'You should probably just restart it and see what happens.' }),
    ]);
    expect(assertByName(HOLDER).eval(run).length).toBeGreaterThan(0);
  });
});
