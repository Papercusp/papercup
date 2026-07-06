/**
 * SU-S24 — delta FALLBACK to a full re-fetch when the base was compacted away
 * (agent-tool-delta-protocol-2026-06-22 P-007, gate 2; D-004/D-006/D-008).
 *
 * The hazard the owner BUILD decision must retire: after compaction (or a fresh
 * session), the base snapshot the delta modifies is GONE from context, so a
 * delta is unmergeable — applying it anyway silently drops the rows the model
 * can no longer see. The correct behavior is to FALL BACK to a full re-fetch.
 *
 * Flow: turn 0 the developer asks for the open work items → `work_items:list`
 * returns a FULL snapshot, which the assistant lists. The `compactionPolicy`
 * (P-006) then rewrites the wire history before turn 1 — the verbatim snapshot
 * (the assistant's enumeration) is replaced by a lossy summary, so the base is
 * gone. Turn 1 the developer asks for the current full list → `work_items:list`
 * returns a DELTA whose note says "re-call for full if you no longer hold the
 * base." A correct delta-aware turn wrapper internally re-fetches (call 3 →
 * the current FULL list) before exposing the result to the model; a model that
 * sees and hallucinate-merges the delta against the missing base cannot
 * reproduce the full current list.
 *
 * Load-bearing asserts (ERROR): the reply names the COMPLETE current list
 * (every kept row + the added row) — only obtainable by re-fetching, since the
 * kept rows were compacted out of context; it does NOT name the removed row or
 * the stale pre-update value. The fallback refetch is owned by the turn wrapper,
 * not by an additional model-emitted tool call.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertTextForbids } from './_asserts';
import { makeDeltaSnapshotOverride } from './_overrides';

export const SU_S24_DELTA_FALLBACK_COMPACTED: Scenario = {
  id: 'su-S24-delta-fallback-compacted',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to list the current open work items — the assistant calls work_items:list, gets a full snapshot, and lists the 5 items. Between that turn and the next, the conversation is compacted: the verbatim list the assistant retrieved is summarized away and no longer in context. The developer then asks for the current full list — work_items:list returns a DELTA (changes since the earlier snapshot) whose note says to re-fetch full if the base is no longer held. Because the base was compacted out, the assistant must re-fetch the full list rather than guess from the delta alone.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 200, maxCostUsd: 2.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // P-006 seam: before turn 1, replace the turn-0 user+assistant pair (the base
  // snapshot enumeration) with a single lossy summary block — the base is gone.
  compactionPolicy: { beforeTurn: 1, upTo: 2 },
  // Stateful: call 1 → full, call 2 → delta, call 3+ → re-fetched current full.
  get toolOverride() {
    return makeDeltaSnapshotOverride();
  },
  asserts: [
    // The full current list is only reproducible via a re-fetch — the kept rows
    // were compacted out, so a delta-only merge cannot name them.
    assertTextRequires(/EROFS/i, {
      name: 'fallback-surfaces-added',
      claim: 'Expected the current list to include the added row (EROFS) — present in the re-fetched full list.',
      suggestion: 'Re-fetch full when the base is gone; the fresh snapshot carries the added row.',
    }),
    assertTextRequires(/circuit-breaker/i, {
      name: 'fallback-surfaces-updated',
      claim: "Expected WI-7004's current title ('circuit-breaker') — present in the re-fetched full list.",
      suggestion: 'A re-fetched full list already reflects the update; do not reconstruct it from a delta against a missing base.',
    }),
    assertTextRequires(/NUL bytes/i, {
      name: 'fallback-surfaces-kept',
      claim:
        'Expected the kept row WI-7003 ("NUL bytes") — it was compacted out of context, so only a full RE-FETCH can surface it. Its absence means the model merged a delta against a base it no longer held.',
      suggestion: 'When the base snapshot is no longer in context, re-call work_items:list for mode:full instead of guessing.',
    }),
    assertTextRequires(/CSV backend/i, {
      name: 'fallback-surfaces-kept-2',
      claim: 'Expected the kept row WI-7001 ("CSV backend") — only the re-fetched full list carries it after compaction.',
      suggestion: 'Re-fetch full; do not drop base rows the model can no longer see.',
    }),
    assertTextForbids(/debounce/i, {
      name: 'fallback-no-removed',
      claim: 'The reply named the REMOVED row (debounce) — the re-fetched full list does not contain it.',
      suggestion: 'Report the re-fetched full list, which already omits removed rows.',
    }),
    assertTextForbids(/naive-retry/i, {
      name: 'fallback-no-stale-value',
      claim: "The reply showed WI-7004's STALE pre-update title ('naive-retry') — a re-fetched full list shows only the current title.",
      suggestion: 'Use the re-fetched current value, not a remembered/stale one.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S24_DELTA_FALLBACK_COMPACTED;
