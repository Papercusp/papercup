/**
 * SU-S23 — delta-merge correctness when the base IS present
 * (agent-tool-delta-protocol-2026-06-22 P-007, gate 1; D-007/D-008).
 *
 * The de-risk contract behind the owner BUILD decision: a semantic delta only
 * helps if the model merges it CORRECTLY against the base it still holds in
 * context. This scenario proves the happy path.
 *
 * Flow: the developer asks for the current open work items (turn 0 → the
 * `work_items:list` override returns a FULL snapshot of 5 rows), then asks what
 * changed and for the updated full list (turn 1 → the same tool returns a DELTA:
 * WI-7002 removed, WI-7004 retitled, WI-7006 added). The base snapshot is still
 * in context (no compaction), so the model must apply the delta and report the
 * merged current list.
 *
 * Load-bearing asserts (ERROR): the merged reply names the ADDED row (EROFS),
 * the UPDATED row's NEW value (circuit-breaker), and a KEPT row (NUL bytes);
 * and does NOT name the REMOVED row (debounce) — a silent failure to apply the
 * removal.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertTextForbids } from './_asserts';
import { makeDeltaSnapshotOverride } from './_overrides';

export const SU_S23_DELTA_MERGE_BASE_PRESENT: Scenario = {
  id: 'su-S23-delta-merge-base-present',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer first asks the engineer to list the current open work items — the assistant calls work_items:list and gets a full snapshot of 5 items, which it lists. The developer then asks "what has changed since you checked, and give me the updated full list" — work_items:list now returns a DELTA (mode:delta): one item removed, one retitled, one added. The earlier full snapshot is still in the conversation, so the assistant should apply the delta to it and report the correct merged current list.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 180, maxCostUsd: 2 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // Stateful: call 1 → full snapshot, call 2 → delta. Getter ⇒ per-run-fresh
  // call-count state across the matrix repeats.
  get toolOverride() {
    return makeDeltaSnapshotOverride();
  },
  asserts: [
    assertTextRequires(/EROFS/i, {
      name: 'delta-add-applied',
      claim:
        'Expected the merged list to include the ADDED row (WI-7006 "Sandbox npm-install EROFS") — the delta added it, so a correct merge surfaces it.',
      suggestion: 'Apply change=added rows from the delta to the base snapshot.',
    }),
    assertTextRequires(/circuit-breaker/i, {
      name: 'delta-update-applied',
      claim:
        "Expected the merged list to show WI-7004's NEW title ('Gateway pool circuit-breaker') — the delta updated it.",
      suggestion: "Apply change=updated rows: replace the base row's data with the delta's new data.",
    }),
    assertTextRequires(/NUL bytes/i, {
      name: 'delta-keeps-unchanged',
      claim:
        'Expected the merged list to still include the UNCHANGED row WI-7003 ("Audit log drops NUL bytes") — a delta carries only changes, so unchanged base rows must be retained.',
      suggestion: 'Do not drop base rows the delta did not mention; a delta is changes-since, not a replacement.',
    }),
    assertTextForbids(/debounce/i, {
      name: 'delta-remove-applied',
      claim:
        'The merged list still named the REMOVED row (WI-7002 "Flaky harness-fs-watcher debounce") — a silent failure to apply change=removed.',
      suggestion: 'Drop change=removed ids from the merged result.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S23_DELTA_MERGE_BASE_PRESENT;
