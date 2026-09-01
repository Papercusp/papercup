/**
 * SU-S09 — coord-injection read-correctness (token-efficient-coord-injection P-011).
 *
 * Question: given the `## Coord injection protocol` legend in the psu prompt
 * (spliced from `renderCoordLegend`), can the model READ a positional `[coord+N]`
 * block — mapping `<glyph> <handle> <text>` lines to their meaning — and act on
 * the right one? This is the load-bearing empirical check behind dropping the
 * per-block header: the schema is in the prompt, so the model must parse the
 * bare positional lines correctly.
 *
 * The block carries a `#` (scope-window) line from peer `5580e` holding the
 * dev-server, plus decoy lines (an intent `>`, a finding `!`). The user asks who
 * to coordinate with before touching the dev-server. Correct = `5580e` (the
 * holder), read from the `#` line — not a decoy handle.
 *
 * Load-bearing assert (ERROR): the reply names `5580e`. Secondary (ERROR): it
 * does not name the decoy handles (a glyph/line misread).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertTextForbids } from './_asserts';

const COORD_BLOCK = [
  '[coord+3]',
  '> ab533 now working on: the pre-prompt registry',
  '# 5580e holding dev-server — exclusive restart for the release-gate deploy',
  '! 9042e migration 174 number collision on db:next-migration',
].join('\n');

export const SU_S09_COORD_INJECTION_READ: Scenario = {
  id: 'su-S09-coord-injection-read',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'You are mid-task and about to restart the dev-server. Right after your last tool call you received this coord injection:\n\n' +
    COORD_BLOCK +
    '\n\nBefore you touch the dev-server, which peer should you coordinate with, and what are they doing? (Answer from the coord block.)',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 2, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertTextRequires(/5580e/, {
      name: 'reads-the-window-holder-from-the-hash-glyph-line',
      claim:
        'Expected the reply to name `5580e` — the handle on the `#` (scope-window) line holding the dev-server, ' +
        'read positionally from the `[coord+3]` block per the prompt legend.',
      suggestion:
        'Map each line `<glyph> <handle> <text>`: `#` = scope window (holding/draining/released). The dev-server holder is the handle on the `#` line.',
    }),
    // WI-8249: this was a bare `assertTextForbids(/\b(ab533|9042e)\b/)` — a naked
    // `pattern.test()` over the whole reply — so it fired on ANY mention of a decoy,
    // including the most useful answer available: one that names `5580e` and then
    // explicitly rules the other two lines OUT. A correct-and-thorough reply scored
    // identically to a genuine misread, so "the deterministic glyph-misread assert
    // fired in 2/3" (WI-8249's cited 2026-06-08 evidence) cannot distinguish a model
    // that misread the block from one that read it correctly and showed its work.
    //
    // Same defect class as SU-S05 2026-07-17 (see `assertTextForbidsAffirmed`'s
    // docstring: "a false positive that would have masked a genuine behavioral fix
    // … an assert-authoring gap, not a model regression"). S05 was migrated to the
    // Affirmed variant; S09 was missed. Affirmed alone is NOT sufficient here — it
    // scans BACKWARD `negationWindow` chars for a negation cue, and in a natural
    // dismissal ("… and 9042e is a finding") the negation governs the sentence from
    // too far left to be seen.
    //
    // So scope the assert to the ROLE rather than the mention: it violates only when
    // a decoy is named AS the peer to coordinate with, or AS the thing holding the
    // dev-server — which is the actual failure the scenario is trying to detect
    // ("treated the decoy `>` intent / `!` finding lines as actionable"). Merely
    // naming a decoy in order to dismiss it is a correct read, not a misread.
    // Discrimination is pinned in both directions by ./S09-coord-injection-read.test.ts.
    assertTextForbids(
      new RegExp(
        // decoy named as the coordination target: "coordinate with ab533"
        String.raw`(?:coordinate\s+with|check\s+with|talk\s+to|sync\s+with|ping|reach\s+out\s+to|defer\s+to)\s+\**\`?(?:ab533|9042e)` +
          '|' +
          // decoy named as the holder: "ab533 is holding the dev-server"
          String.raw`\b(?:ab533|9042e)\b[^.\n]{0,40}?\b(?:holding|holds|owns|has\s+the\s+dev-server|locked)`,
        'i',
      ),
      {
        name: 'no-glyph-or-line-misread',
        claim:
          'The reply treated a decoy handle (`ab533` intent / `9042e` finding) as ACTIONABLE — naming it as the peer to coordinate with, or as the dev-server holder — a misread of the positional coord lines.',
        suggestion:
          'Only the `#` scope-window line is about holding the dev-server; `>` is an intent and `!` is a finding. Naming a decoy in order to rule it out is fine; naming one as the holder is the misread.',
      },
    ),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S09_COORD_INJECTION_READ;
