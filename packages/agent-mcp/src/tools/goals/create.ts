/**
 * goals:create — open a durable GOAL record.
 *
 * The write half of a table that had a schema, a GIN full-text index, a
 * self-referencing lineage edge and two read tools, but no way to put a row in
 * it: `harness_shared.goals` held ZERO rows because nothing had ever written
 * one (goal-mode-2026-08-07 P-009).
 *
 * WHY A GOAL IS NOT A POT. Under D-009 a v1 goal lives as pots inside the
 * existing workspace, which tempts the shortcut "the pot IS the goal record".
 * It is not, and the cardinality is what gives it away: one goal spawns MANY
 * projects, so N pots share one goal and no single pot can carry the goal's
 * kill criterion, its spend ceiling, or its lineage. GOAL mode's contract
 * mandates both a kill criterion and a spend ceiling at creation time — this
 * row is where they live, which is exactly what `budget_cents` and `parent_id`
 * were shaped for.
 *
 * Reads already exist (`goals:list`, `goals:get`, the
 * `papercusp://workspace/goals` resource, and search:query's `goals` kind).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';
import { SU_WRITE_ROLES } from '../../role-config';
import { GOAL_STATUSES, TripwireSchema, goalId, insertGoalRow } from './_core';

// The id minter, the status vocabulary, the tripwire schema and the row write
// live in `./_core` so `goals:start` (operator-core — it also SPAWNS the
// GOAL-mode agent, which cannot be done from this package) shares one
// definition with this tool instead of re-typing the column list. Re-exported
// here because these were this module's public surface first, and callers
// (goals:update, goals:propose, the HUD board) already import them from it.
export { GOAL_STATUSES, TripwireSchema, goalId };
export type { Tripwire, GoalStatus } from './_core';

// Wire clients deliver booleans as the strings 'true'/'false' on some paths —
// the same tolerance plans:start ships for its consult override args.
const stringTolerantBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean(),
);

export default defineTool({
  name: 'goals:create',
  description:
    'Open a durable GOAL record (harness_shared.goals) — the weeks-long outcome a GOAL-mode agent owns, above the pot/plan/work-item stack. ' +
    '{ title, body?, killCriterion?, tripwires?, budgetCents?, parentId?, status? }. Returns the allocated id. ' +
    'A goal is NOT a pot: one goal spawns many projects, so the kill criterion and spend ceiling live HERE, not on any one pot. ' +
    'If the caller already has an active GOAL-mode row, stamps its subject with this id so later creations carry provenance. ' +
    'This tool does NOT enter GOAL mode; use goals:start for a new GOAL-mode owner or mode:set with mode:"goal" and subject:"<id>" for an existing session.',
  capability: 'goals:write',
  guidance: {
    when:
      'Recording a goal that an already-running GOAL-mode session owns, or splitting an owned goal into a sub-goal (pass parentId). Record it BEFORE creating the pots/plans that pursue it, so the kill criterion and spend ceiling exist before the spending does.',
    notWhen:
      'Do not use this as the mode-entry path for a new GOAL-mode agent — use goals:start, which creates the goal, enters GOAL mode, and spawns atomically. For a concrete unit of work use work_items:create; for a project use pot:create; for the plan of attack use plans:new. A goal is the INTENT those serve — if it has an obvious done-when-this-PR-merges, it is not a goal.',
    chaining: 'goals:start for a new GOAL-mode owner, or goals:create → mode:set { mode:"goal", subject:"<id>" } for an existing session → pot:create / plans:new per project → goals:update to record actuals, or status:"killed" when the kill criterion trips.',
    returns:
      'On success: { id, title, status, kill_criterion, budget_cents, tripwires, workspace_id, mode_subject_stamped, mode_subject_advisory?, kickoff_consult? }. ' +
      'For a caller with an ACTIVE GOAL-mode row, the goal-kickoff CHECKPOINT consult (min:1) runs first: the goal outline (outcome + kill criterion) is routed through the relevance router, and any selectable live peer refuses ONCE with data { error: "consult_available", candidates, selection, hint } — the goal is NOT created; re-call with consulted: true/false + consult_reason (a nudge, never a gate; any infra fault proceeds). ' +
      'Non-GOAL-mode callers (owner UI confirm cards, scripts) are never consulted. `kickoff_consult` records the disposition (override reason, no_live_responder, or routed_dead_context + transcript excerpts).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({
    title: z.string().min(1).max(500).describe('the outcome, stated so its achievement is checkable'),
    body: z.string().max(20000).optional().describe('the full statement: what winning looks like, scope, constraints'),
    killCriterion: z
      .string()
      .max(2000)
      .optional()
      .describe('the written condition under which this goal is abandoned — GOAL mode requires one at creation time'),
    budgetCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('declared spend ceiling in cents — the number actuals are reported against'),
    parentId: z.string().min(1).optional().describe('parent goal id, for a sub-goal'),
    tripwires: z
      .array(TripwireSchema)
      .max(12)
      .optional()
      .describe(
        'structured form of the kill criterion — renders as live bars ("day 12 of 30", "$310 of $500") instead of prose nobody re-checks. Optional: a free-text criterion works with no tripwires.',
      ),
    status: z.enum(GOAL_STATUSES).default('active'),
    metadata: z.record(z.string(), z.unknown()).optional(),
    consulted: stringTolerantBool
      .optional()
      .describe(
        'Answer to a `consult_available` refusal (the GOAL-mode kickoff consult). Pass true after actually consulting a listed candidate (name the consult in consult_reason), or false + consult_reason to proceed WITHOUT consulting (the reason is recorded). Omit on a first call — for a GOAL-mode caller the kickoff routing runs then. Accepts the wire strings "true"/"false" too.',
      ),
    consult_reason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('Why you are overriding (consulted: false) or what the consult concluded (consulted: true). Recorded on the result.'),
  }).refine((a) => a.consulted !== false || Boolean(a.consult_reason), {
    message:
      'consulted: false requires consult_reason — state why you are proceeding without consulting (it is recorded)',
  }),
  async handler(args, ctx) {
    // The table declares workspace_id NOT NULL with a CHECK (workspace_id <> ''),
    // so — unlike harness_text_artifacts, whose blank-stamp fallback minted the
    // legacy rows EI-280 had to repair — there is no safe empty default here.
    // Resolve GUC-first, then ctx, and REFUSE rather than write a row the
    // constraint would reject with a less legible error.
    const [gucRow] = await ctx.tx<Array<{ ws: string | null }>>`
      SELECT NULLIF(current_setting('app.workspace_id', true), '') AS ws
    `;
    const workspaceId =
      gucRow?.ws || (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : null);
    if (!workspaceId) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [
          'no concrete workspace in scope (neither the app.workspace_id GUC nor ctx.workspaceId resolved) — a goal cannot be filed workspace-less',
        ],
      };
    }
    const installSlug = ctx.harnessSlug;
    if (!installSlug) {
      return {
        data: null,
        degraded: true,
        degradedReasons: ['no harness in scope — goals are filed against an install_slug'],
      };
    }

    // EI-20049757392342975: a criterion that states no abandonment condition is
    // refused HERE too, not only at `goals:propose` and `goals:update`.
    //
    // Why this door was the gap that mattered. `goals:propose` validates and
    // then WRITES NOTHING — its own description says the confirm card is
    // "fully-editable" and "one button calls goals:create". So the owner could
    // edit the criterion down to a stub in that card and this door would land
    // it, bypassing the check propose had just applied. `goals:update`'s
    // comment already assumed otherwise in as many words ("a criterion the
    // create path would have rejected"), which is how the gap stayed invisible:
    // the doc described the system as if this line existed.
    //
    // A BLANK/ABSENT criterion still passes, deliberately — a goal may be
    // created with none at all (WI-37604, owner-directed 2026-08-09). That
    // overrule is about PRESENCE; this rule is about quality GIVEN presence,
    // and kill-criterion.ts's header separates the two explicitly. Same
    // `if (trimmed)` composition `goals:update` already ships.
    const criterionArg = args.killCriterion?.trim();
    if (criterionArg) {
      const problem = killCriterionProblem(criterionArg);
      if (problem) return { data: null, degraded: true, degradedReasons: [problem] };
    }

    // ── The GOAL-mode kickoff consult (consult-min-max-and-rubric-vetting
    // 2026-08-17 P-010 / D-004 §1) ───────────────────────────────────────────
    // GOAL mode's kickoff contract commits weeks of portfolio spend at this
    // door, so the goal OUTLINE (outcome + kill criterion + body) is routed
    // through the same checkpoint partition plans:start uses
    // (goalKickoffConsult — global min:1, D-001 §2). GATED ON THE CALLER'S
    // ACTIVE GOAL-MODE ROW: the owner UI confirm cards (GoalProposalCard,
    // SubGoalsSection) call this tool as the OWNER with no goal-mode row and
    // must never be nudge-refused — only a GOAL-mode agent committing its own
    // kickoff gets the consult. NUDGE, never a hard block: any router/infra
    // fault proceeds, and the override (consulted + consult_reason) always
    // works — the proven plans:start similar_exists/consulted shape.
    const callerOwnerId = ctx.uiClientId ?? null;
    let kickoffConsult: Record<string, unknown> | undefined;
    if (callerOwnerId) {
      let goalModeActive = false;
      try {
        // Same predicate the provenance stamp below uses — one definition of
        // "this caller is running GOAL mode".
        const modeRows = await ctx.tx<Array<{ owner_id: string }>>`
          SELECT owner_id
            FROM harness_shared.agent_modes
           WHERE workspace_id = ${workspaceId}
             AND owner_id = ${callerOwnerId}
             AND mode = 'goal'
        `;
        goalModeActive = modeRows.length > 0;
      } catch {
        goalModeActive = false; // fail open — the consult is a nudge, not a gate
      }
      if (goalModeActive) {
        if (args.consulted !== undefined) {
          // Override / acknowledgement path: routing already ran on the
          // refused call — record the disposition on the result and proceed.
          kickoffConsult = {
            overridden: true,
            consulted: args.consulted,
            ...(args.consult_reason ? { reason: args.consult_reason } : {}),
          };
        } else {
          try {
            // Dynamic imports, mirroring plans:start — the consult wiring is
            // heavyweight (embedder, liveness oracle) and must never tax the
            // common non-GOAL-mode create path.
            const [
              { getOrgPg },
              { routeConsult },
              { buildQueryEmbedder },
              { resolveSessionStates },
              consult,
            ] = await Promise.all([
              import('@papercusp/db-org'),
              import('@papercusp/operator-core/lib/consult/relevance-router'),
              import('@papercusp/operator-core/lib/agent-tools/search/embedder'),
              import('@papercusp/operator-core/lib/agent-tools/coordination/liveness-oracle'),
              import('@papercusp/operator-core/lib/consult/plan-start-consult'),
            ]);
            const embed = await buildQueryEmbedder();
            const outcome = await consult.goalKickoffConsult(
              {
                workspaceId,
                requesterId: callerOwnerId,
                title: args.title,
                body: args.body ?? null,
                killCriterion: args.killCriterion ?? null,
              },
              {
                route: (params) =>
                  routeConsult(params, {
                    getSql: () => getOrgPg().sql,
                    embed,
                    getLiveness: async (ownerIds) => {
                      const verdicts = await resolveSessionStates(
                        ownerIds.map((ownerId) => ({ ownerId })),
                        { hydratePerId: true },
                      );
                      return Object.fromEntries(
                        [...verdicts.values()].map((v) => [v.ownerId, v.sessionState]),
                      );
                    },
                  }),
                getExcerpts: (refs) => consult.fetchTurnExcerpts(getOrgPg().sql, workspaceId, refs),
              },
            );
            if (outcome.outcome === 'nudge') {
              const hasMinimumFill = outcome.selection.selected.some((s) => s.via === 'minimum');
              // ToolResponse is a CLOSED envelope (data + degraded fields), so
              // the structured refusal rides INSIDE data — the same
              // information plans:start's consult_available refusal carries,
              // adapted to this tool's idiom. `data.error` present + no `id`
              // ⇒ the goal was NOT created.
              return {
                data: {
                  error: 'consult_available' as const,
                  candidates: outcome.candidates,
                  selection: outcome.selection,
                  hint:
                    'Peers with relevant transcript history were selected for this goal outline — `selection.selected` labels each: via "floor" = cleared the router\'s precision floor on real evidence; via "minimum" = best-available LIVE peer BELOW the floor, selected because the goal-kickoff consult carries a minimum of 1 (a goal commits weeks of portfolio spend, so a wrong outline assumption is cheapest to catch HERE, before any pot or plan exists). ' +
                    (hasMinimumFill
                      ? 'A via:"minimum" candidate should review from FIRST PRINCIPLES — their selection is best-available, not evidence-matched. '
                      : '') +
                    'Review the candidates + their evidence turns; consult via get_feedback { question } — its default minResponders:1 reaches at least the best-available live peer. ' +
                    'Then re-call goals:create with consulted: true (+ consult_reason naming what the consult concluded), or consulted: false + consult_reason to proceed without consulting — the override always works; this is a nudge, never a gate.',
                },
                degraded: true,
                degradedReasons: [
                  'consult_available — the goal was NOT created; consult a listed candidate (get_feedback) or re-call with consulted + consult_reason',
                ],
              };
            }
            if (outcome.outcome === 'proceed' && outcome.verdict === 'no_live_responder') {
              // Not silent (P-002): a candidate pool existed but only liveness
              // kept everyone out — record the honest verdict on the result.
              kickoffConsult = {
                verdict: 'no_live_responder',
                note:
                  'The goal-kickoff consult found candidate peer history, but no LIVE candidate exists to consult (min:1 physically unfillable) — the create proceeded. Consider get_feedback later if a relevant peer comes alive.',
              };
            }
            if (outcome.outcome === 'proceed_with_excerpts') {
              kickoffConsult = {
                verdict: 'routed_dead_context',
                note:
                  'The router found above-floor peer history for this goal, but every candidate context is dead and no live peer could fill the min:1 — no wake is possible, so their matched transcript excerpts are injected here instead (retrieval, not consult). Read them before committing the portfolio.',
                candidates: outcome.candidates.map((c) => ({
                  ownerId: c.ownerId,
                  score: c.score,
                  liveness: c.liveness,
                })),
                excerpts: outcome.excerpts,
              };
            }
          } catch {
            /* nudge, never block — a router/infra fault must not stop a goal create */
          }
        }
      }
    }

    const id = goalId(args.title);
    await insertGoalRow(ctx.tx, {
      id,
      installSlug,
      workspaceId,
      title: args.title,
      body: args.body ?? null,
      parentId: args.parentId ?? null,
      budgetCents: args.budgetCents ?? null,
      status: args.status,
      killCriterion: args.killCriterion ?? null,
      tripwires: args.tripwires ?? null,
      metadata: args.metadata ?? null,
    });

    // ── Stamp the caller's GOAL mode with the goal it is now running ─────
    // This side effect IS the provenance mechanism (P-016). Everything the
    // agent creates from here on — work-items, and later pots/plans — reads
    // `agent_modes.subject` from SESSION CONTEXT and stamps `goal_id` with it,
    // so "what belongs to this goal?" is answerable without asking any agent to
    // remember to pass an id. Agent self-report was the alternative and it does
    // not survive a compaction.
    //
    // `ctx.uiClientId` is the same value `resolveAgentIdentity` returns as
    // `ownerId` for every population that can run GOAL mode (su sessions and
    // signed fleet spawns). This package cannot import that resolver —
    // agent-mcp does not depend on operator-core — so the narrow UPDATE is
    // written here rather than routed through `setMode`.
    //
    // It DEGRADES, never fails: a goal creation must not be lost because the
    // caller happens not to be in GOAL mode (the common case for a human-driven
    // or scripted create), or because the transport carried no session id.
    let modeSubjectStamped = false;
    if (callerOwnerId) {
      try {
        const stamped = await ctx.tx<Array<{ owner_id: string }>>`
          UPDATE harness_shared.agent_modes
             SET subject = ${id}
           WHERE workspace_id = ${workspaceId}
             AND owner_id = ${callerOwnerId}
             AND mode = 'goal'
          RETURNING owner_id
        `;
        modeSubjectStamped = stamped.length > 0;
      } catch {
        // Swallowed on purpose, and NOT silently: `mode_subject_stamped:false`
        // in the result is the signal, and it is the one the caller can act on
        // (enter GOAL mode, then re-assert). Failing the create here would
        // trade a missing decoration for a lost goal.
        modeSubjectStamped = false;
      }
    }

    // EI-20185819124341317: `mode_subject_stamped:false` is intentionally not
    // an error — humans and scripts may create a goal outside GOAL mode — but a
    // caller that supplied GOAL-shaped controls is very likely about to proceed
    // as though the mode transition happened. Make that mismatch impossible to
    // miss while preserving the successful goal write and the compatibility
    // boolean above. `budgetCents: 0` is still an explicit GOAL control, while
    // an empty tripwire array carries no control and should stay quiet.
    const goalIntentSupplied = Boolean(
      criterionArg ||
        args.budgetCents !== undefined ||
        (args.tripwires?.length ?? 0) > 0,
    );
    const modeSubjectAdvisory = !modeSubjectStamped && goalIntentSupplied
      ? {
          code: 'goal_mode_not_active',
          severity: 'warning',
          message:
            'The goal was created, but this session is not in GOAL mode, so subsequent projects will not be attributed to it automatically.',
          next: [
            {
              tool: 'goals:start',
              detail: 'For a new GOAL-mode owner, use goals:start so goal creation, mode entry, and spawn are atomic.',
            },
            {
              tool: 'mode:set',
              args: { mode: 'goal', subject: id, reason: 'Attribute this existing session to the goal just created.' },
              detail: 'For this existing session, enter GOAL mode with the created goal as its subject before creating projects.',
            },
          ],
        }
      : undefined;

    return {
      data: {
        id,
        title: args.title,
        status: args.status,
        parent_id: args.parentId ?? null,
        budget_cents: args.budgetCents ?? null,
        kill_criterion: args.killCriterion ?? null,
        tripwires: args.tripwires ?? null,
        workspace_id: workspaceId,
        install_slug: installSlug,
        // Told plainly so the agent knows whether later creations will carry
        // provenance. false ⇒ you are not in GOAL mode on this session; enter
        // it (mode:set { mode:'goal' }) before creating the projects, or the
        // work will not be attributable to this goal.
        mode_subject_stamped: modeSubjectStamped,
        ...(modeSubjectAdvisory ? { mode_subject_advisory: modeSubjectAdvisory } : {}),
        // The kickoff-consult disposition (override, no_live_responder, or
        // routed_dead_context + excerpts) — recorded so the create result
        // itself says what the routing found (P-002: honest, never silent).
        ...(kickoffConsult ? { kickoff_consult: kickoffConsult } : {}),
      },
    };
  },
});
