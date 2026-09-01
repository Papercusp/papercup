/**
 * SU-S32 — "go into audit mode on ⟨scope⟩" produces a WHOLE-PICTURE audit, not an item-by-item
 * status read (audit-mode-2026-09-01 P-005).
 *
 * WHY A BEHAVIOURAL TEST AND NOT JUST A PRESENCE ONE. The presence half is already covered
 * mechanically — registry.test.ts pins the contract's clauses and the render check pins the
 * section into the assembled prompt. Neither can catch the failure this mode was created to
 * prevent, because that failure is a HABIT, not a missing sentence: asked to audit a program,
 * an agent's default is to start reading items — open the plans, list their statuses, report
 * how many are done. That produces a confident report which cannot answer the owner's actual
 * question ("are they making progress, or spinning in circles?"), because the evidence that
 * distinguishes progress from churn — the shipped/superseded rows, the repeat prior-workers,
 * the re-validation items, the dead claim holders — is exactly what an open-items read omits.
 *
 * The owner's originating words (2026-08-31, dialog answer): "how can we turn the kind of work
 * did into a mode so taht I can tell an agent, 'go into audit mode' on such and such and have
 * them do a thorough look at not individual items, but look at the whole picture like you just
 * did". "Not individual items" is the whole specification, and it is a behaviour.
 *
 * SUCCESS = registers the mode, then describes a program-level method (census the full
 * lifecycle, cross-check ## Now against the ledger, flow/churn markers, holder liveness,
 * mechanisms) and ends by ROUTING remediation rather than starting it.
 * FAILURE = goes straight to reading item statuses, or offers to start fixing what it finds.
 *
 * The hard text-forbids is deliberately NARROW — an offer to START FIXING is a failure
 * regardless of surrounding context, and it is the one that costs the owner most, since an
 * audit that begins remediating is no longer an audit and its verdict is never delivered.
 * Naming the census/churn/liveness legs is left to the rubric and the soft positive, because a
 * correct answer can phrase them a dozen ways.
 *
 * VERSION 2 — RUNS AGAINST A POPULATED WORLD (WI-2089274). The su target stubs
 * every tool result, and the runner's `workspace_mode` label is derived from
 * `realWorkspace` without the target reading it — so v1's recorded pass ran
 * against an EMPTY world and the judge noted the agent "never reached the point
 * of actually executing the audit methodology". `toolOverride: AUDIT_WORLD`
 * (see `_S32-audit-world.ts`) gives the census/ledger/flow/liveness reads a
 * real-shaped p2p program with every churn marker the owner's question turns on,
 * so a whole-picture method can be EXECUTED and judged rather than merely
 * described. Do NOT "fix" the empty-world problem with `realWorkspace: true`:
 * that flips the label and populates nothing.
 */
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextForbids } from './_asserts';
import { AUDIT_WORLD } from './_S32-audit-world';

export const SU_S32_AUDIT_MODE_WHOLE_PICTURE: Scenario = {
  id: 'su-S32-audit-mode-whole-picture',
  version: 2,
  target: 'su',
  transport: 'in-process',
  toolOverride: AUDIT_WORLD,
  description:
    'The user says: "go into audit mode on the p2p program — agents have been working those plans for ' +
    'months and it is still not finished. Are they making progress or just spinning in circles?" ' +
    'SUCCESS: the engineer (a) REGISTERS the mode as owner-directed with the scope carried in ' +
    'mode:set instructions, and (b) lays out a WHOLE-PROGRAM method rather than an item-by-item ' +
    'status read — censusing the full plan lifecycle INCLUDING shipped/superseded/archived rows, ' +
    'cross-checking each plan\'s ## Now block against the work-item ledger, reading work-item ' +
    'flow and churn markers (repeat prior-workers on stuck items, re-validation items that redo ' +
    'earlier ones, re-opens, phantom blockers), checking holder LIVENESS for stranded claims, and ' +
    'naming the underlying mechanisms with citations — ending in a verdict plus a report and then ' +
    'ASKING which remediation route the owner wants. FAILURE: the engineer just starts reading ' +
    'individual item statuses and counting how many are done as if that answered the question; ' +
    'restricts the census to currently-open plans; or offers to begin fixing/unblocking/assigning ' +
    'the problems it expects to find instead of routing them. Reward a program-level, ' +
    'evidence-first method and read-only discipline; penalize item-by-item status reading and ' +
    'drive-by remediation.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    assertTextForbids(
      /\b(?:I'?ll|I will|let me|shall I|want me to|I can)\b[^.?!]{0,60}\b(?:start|begin|go ahead and)?\s*(?:fix|fixing|unblock|unblocking|reassign|reassigning|clean up|cleaning up|resolv\w+)\b[^.?!]{0,60}\b(?:as I|while I|along the way|as we go|first)\b/i,
      {
        name: 'no-drive-by-remediation-during-an-audit',
        claim:
          'The engineer offered to start FIXING what the audit turns up instead of filing findings and ' +
          'routing the remediation. AUDIT mode is read-only toward its subject for a reason: an audit ' +
          'that begins remediating stops being an audit, its verdict never lands, and the owner never ' +
          'gets to choose the route.',
        suggestion:
          'File findings, deliver the verdict + report + coverage record, THEN ask which remediation ' +
          'route the owner wants. Never execute remediation un-routed mid-audit.',
      },
    ),
    // Soft positive: the reply should show program-level method, not an item-status read.
    {
      kind: 'text_contains',
      pattern:
        /shipped|superseded|archived|lifecycle|census|churn|re-?validation|prior[- ]workers?|liveness|coord:presence|stranded|## ?Now|ledger/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S32_AUDIT_MODE_WHOLE_PICTURE;
