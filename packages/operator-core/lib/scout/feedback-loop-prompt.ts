/**
 * feedback-loop-prompt.ts — the CANONICAL Scout-side prompt guidance for the
 * Queen↔Scout feedback-iteration loop (queen-scout-feedback-loop-2026-06-20,
 * P-005 / D-001 / D-002 / D-003).
 *
 * The loop lets the Queen send actionable feedback on a Scout-routed DRAFT plan,
 * wake Scout, iterate, then converge to READY (Queen promotes) or DEPRECATE
 * (either party + a `learnings` observation) — riding on the existing coord+wake
 * rails (no new table, no new cadence mechanism).
 *
 * This module is the SINGLE SOURCE for the Scout side of that protocol:
 *   • {@link SCOUT_FEEDBACK_LOOP_GUIDANCE} — the agent instruction the Scout
 *     REVISION cycle injects when it wakes to Queen feedback. The cycle/cadence
 *     WIRING that reads coord:inbox and runs the targeted revision is a sibling
 *     brief (P-001/P-002, scheduler.ts/cadence.ts); this is the TEXT it carries.
 *   • {@link SCOUT_DRAFT_LOOP_NOTE} — the concise, state-describing note embedded
 *     in every Scout-generated draft's `## Now` (see scout-plan-draft.ts), so the
 *     draft is self-documenting about its lifecycle for whoever reads it (the
 *     Queen reviewing it, or a later Scout revision re-reading it).
 *
 * The Queen side of the SAME protocol is mirrored in the shared Queen persona
 * (`blueprints/base/prompts/queen.base.md`, the "Iterate on Scout's routed
 * drafts" bullet). The two are kept in lock-step by
 * `feedback-loop-prompt.test.ts`, which asserts both carry the loop's invariants
 * (announce → revise-on-feedback → ready|deprecate, the "still making progress?"
 * heuristics, the deprecate-emits-learnings rule).
 */

/**
 * The Scout-side agent guidance for one turn of the feedback loop — what Scout
 * does on a draft it has routed, and on a Queen-feedback wake. Authored as plain
 * markdown so the revision-cycle prompt can inject it verbatim.
 */
export const SCOUT_FEEDBACK_LOOP_GUIDANCE = `## Queen↔Scout feedback loop — your side of the iteration

When you route a broad idea to a \`status: draft\` plan, \`coord:send\` the Queen to
announce it so she reviews it (D-003 #1). The 1–5 grade she may give is a separate
one-way LEARNING signal — THIS loop is the two-way ITERATION signal on that one
draft.

When you wake to Queen feedback on a draft (a coord message carrying its
\`plan_slug\`), run a TARGETED revision on THAT draft: address the specific gaps she
named, record a new plan revision, then \`coord:send\` her back that it's ready for
re-review. Revise the EXISTING draft — do not re-ideate from scratch, and do not
start a fresh idea while a revision is pending (a pending revision preempts fresh
ideation, D-003 #4).

Iterate while you are making good progress — and do NOT loop forever. Stop when
progress stalls. Check yourself each round:
- Does my revision actually CLOSE the feedback, or just restate/dodge it?
- Is the gap to "ready" SHRINKING round over round?
- Am I re-litigating the SAME point a second time (a stall, not progress)?
- Is the open objection about EXECUTION (keep iterating) or the PREMISE (deprecate)?

Only the Queen marks a draft READY (she promotes it) — that's not yours to do.
Your terminal move is the other one: if you conclude the PREMISE is flawed (not
just the execution), self-deprecate the draft with one atomic call —
\`plans:set-plan-status { status: 'superseded', learnings: { tried, stalled,
salvageable } }\`, which marks it superseded AND emits the structured \`learnings\`
observation — then tell the Queen. A deprecated draft still produces fuel (a
future cycle re-ideates from the salvage); the loop stays closed, no dead ends.`;

/**
 * The concise, state-describing lifecycle note embedded in a Scout draft's
 * `## Now` (`buildScoutPlanTemplate`). It tells whoever opens the draft what loop
 * it is in and how it terminates — without restating the full agent guidance.
 */
export const SCOUT_DRAFT_LOOP_NOTE =
  'Queen reviews this proposal in the Queen↔Scout feedback loop: she promotes it ' +
  'to greenlight (ready), or `coord:send`s plan-keyed feedback to revise. Iterate ' +
  'while making good progress; if the premise will not reach ready, either party ' +
  'deprecates it with a `learnings` observation (no dead ends).';
