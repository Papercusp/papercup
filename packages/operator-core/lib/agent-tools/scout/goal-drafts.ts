/**
 * blender:goal-drafts — read the write-nothing goal-draft queue
 * (plan blender-goal-amendment-rail-2026-08-19 P-002).
 *
 * THE QUESTION THIS ANSWERS: "what WOULD the Blender have proposed, if the goal rail were
 * open to it?" P-001 built the projection that answers it (`readGoalDraftQueue`); until
 * this verb existed the only way to ask was a hand-written SELECT against
 * `harness_shared.scout_cycle_stage_artifacts`, which the repo's
 * hot-read-belongs-behind-a-tool rule forbids precisely because a hand-written query
 * re-derives the selection semantics and drifts from the live routing rule.
 *
 * READ-ONLY, and that is structural rather than promised: it calls one function that holds
 * no write port and issues one SELECT. Reading the queue can never create a goal or mint
 * an agent — which is the whole reason the queue was built before any authority was
 * granted.
 *
 * ⚠ AN EMPTY RESULT IS THE MEASURED NORMAL STATE, NOT AN ERROR OR AN OUTAGE (D-012).
 * Across the full retained corpus — 30 cycles, 106 proposals — ZERO proposals ever carried
 * `routeHint:'goal'`, and intake has never coerced a hint on any rail. The goal rail is not
 * blocked; it is UNUSED. So this verb reports `empty` with the reason attached rather than
 * letting a caller read "no rows" as "the read failed" or "something is holding drafts
 * back". Any consumer built on this must state what it does when the stream is empty,
 * because empty is what the stream measurably is.
 *
 * ⚠ EVERY DRAFT CARRIES ITS TRIGGER WORDS, and that is BINDING (D-012). The one
 * override-path draft in the corpus is a FALSE POSITIVE: proposal SP-001 is about a
 * tool-policy table and matched only because `goal mode` appears inside a quoted SQL value
 * in its `mechanism`. A report that showed that draft without its marker provenance would
 * present it as a genuine goal-scale ask — actively misleading. `markerHits` (which fields,
 * and whether the match is code-span-only) is therefore never omitted from a draft.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { readGoalDraftQueue, type GoalDraft } from '../../scout/goal-draft-queue';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

/** How much proposal prose a listed draft carries. The full `Proposal` is several KB and a
 *  queue read is a triage surface, so the default is an excerpt; `detail:'full'` returns
 *  the proposal untouched for the one draft a reader has decided to actually read. */
const EXCERPT_CHARS = 400;

export const goalDraftsArgs = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'max CYCLES scanned (default 30 — the artifact store\'s retention). Bounds cycles, NOT drafts: a cycle can contribute several drafts and truncating mid-cycle would under-report a burst.',
      ),
    detail: z
      .enum(['summary', 'full'])
      .optional()
      .describe(
        "'summary' (default) excerpts each proposal's prose; 'full' returns whole Proposal objects — several KB each, so pass it once you know WHICH draft you want to read.",
      ),
    includeCodeSpanMatches: z
      .boolean()
      .optional()
      .describe(
        'count a goal-scale marker that appears ONLY inside a code-ish span (a quoted SQL value, a backticked identifier). Default false, matching live routing. TRUE reproduces the pre-P-009 behaviour and is for auditing the D-012 false positive as evidence — never a production setting.',
      ),
  })
  .strict();
export type GoalDraftsArgs = z.infer<typeof goalDraftsArgs>;

/** One draft as rendered to a caller. Mirrors {@link GoalDraft}, with the proposal
 *  excerpted unless `detail:'full'`. */
export interface GoalDraftView {
  cycleId: string;
  createdAt: string;
  path: GoalDraft['path'];
  askedRail: string | null;
  title: string;
  matchedMarkers: string[];
  markerHits: GoalDraft['markerHits'];
  /** Set when a draft's ONLY markers are code-span matches — i.e. it is on this list only
   *  because `includeCodeSpanMatches` was passed. The D-012 shape, named at the row so a
   *  reader cannot mistake it for a real ask. */
  incidentalMatchOnly?: true;
  killCriterion: string;
  budgetCents: number;
  proposal: unknown;
}

const excerpt = (v: unknown): string => {
  const s = typeof v === 'string' ? v : '';
  return s.length > EXCERPT_CHARS ? `${s.slice(0, EXCERPT_CHARS)}…` : s;
};

/** Render one draft for the wire. Marker provenance is ALWAYS carried (D-012). */
export function toGoalDraftView(d: GoalDraft, detail: 'summary' | 'full'): GoalDraftView {
  const p = d.proposal as unknown as Record<string, unknown>;
  const incidental = d.markerHits.length > 0 && d.markerHits.every((h) => h.onlyInCodeSpan);
  return {
    cycleId: d.cycleId,
    createdAt: d.createdAt.toISOString(),
    path: d.path,
    askedRail: d.askedRail,
    title: d.title,
    matchedMarkers: d.matchedMarkers,
    markerHits: d.markerHits,
    ...(incidental ? { incidentalMatchOnly: true as const } : {}),
    killCriterion: d.killCriterion,
    budgetCents: d.budgetCents,
    proposal:
      detail === 'full'
        ? d.proposal
        : {
            id: p.id,
            routeHint: p.routeHint,
            droppedRouteHint: p.droppedRouteHint,
            framing: excerpt(p.framing),
            mechanism: excerpt(p.mechanism),
            bet: excerpt(p.bet),
            whyNew: excerpt(p.whyNew),
          },
  };
}

export interface GoalDraftsResult {
  ok: true;
  drafts: GoalDraftView[];
  summary: {
    total: number;
    /** Drafts on the 'asked' path — the model explicitly asked for the goal rail and
     *  intake coerced the hint away. Measured at 0 across the whole retained corpus. */
    asked: number;
    /** Drafts on the 'override' path — 'plan'-hinted text that matched the goal-scale
     *  vocabulary. */
    override: number;
    /** Of those, how many matched ONLY inside code-ish spans (visible only when
     *  `includeCodeSpanMatches` is on). */
    incidentalMatchOnly: number;
    cyclesScanned: number;
  };
  /** Present ONLY when the queue is empty, so a caller cannot read "no rows" as a fault.
   *  See the module header: empty is the measured normal state (D-012). */
  empty?: {
    reason: string;
    meaning: string;
  };
}

export async function runGoalDrafts(
  args: GoalDraftsArgs,
  ctx?: unknown,
): Promise<GoalDraftsResult | { ok: false; error: string }> {
  try {
    const workspaceId = resolveConcreteWorkspaceId(
      (ctx as { workspaceId?: string | null } | undefined)?.workspaceId,
    );
    const limit = args.limit ?? 30;
    const detail = args.detail ?? 'summary';
    const drafts = await readGoalDraftQueue({
      workspaceId,
      limit,
      ...(args.includeCodeSpanMatches == null
        ? {}
        : { includeCodeSpanMatches: args.includeCodeSpanMatches }),
    });
    const views = drafts.map((d) => toGoalDraftView(d, detail));
    const result: GoalDraftsResult = {
      ok: true,
      drafts: views,
      summary: {
        total: views.length,
        asked: views.filter((v) => v.path === 'asked').length,
        override: views.filter((v) => v.path === 'override').length,
        incidentalMatchOnly: views.filter((v) => v.incidentalMatchOnly === true).length,
        cyclesScanned: limit,
      },
    };
    if (views.length === 0) {
      result.empty = {
        reason: `no goal-scale drafts in the last ${limit} cycle(s)`,
        meaning:
          'This is the MEASURED NORMAL STATE, not a fault and not a blocked rail (D-012): across 30 cycles / 106 proposals, zero proposals ever carried routeHint:"goal" and intake has never coerced a hint on any rail. The constraint is proposal SUPPLY — the model does not propose goal-scale work — so an empty queue is evidence about the ideator, not about intake or about this read.',
      };
    }
    return result;
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

export default defineTool({
  name: 'blender:goal-drafts',
  description:
    'Read-only: what the Blender WOULD have proposed as goal-scale work, from persisted cycle artifacts. Writes NOTHING — creates no goal and mints no agent. Returns each draft with the rails the goal rail would have set (killCriterion, budgetCents) and, ALWAYS, the marker provenance that triggered it (markerHits: which fields, and whether the match is only inside quoted code). An EMPTY result is the measured normal state, not a fault — it comes back with `empty.meaning` explaining that the rail is unused rather than blocked.',
  capability: 'curation:read',
  guidance: {
    when:
      'Deciding whether the Blender should be given any authority near goals, or auditing what goal-scale work it has actually been generating. This is the evidence surface that argument is supposed to rest on.',
    notWhen:
      'Creating or amending a goal (goals:create / goals:update) — this verb only reports what a draft WOULD have been. Reading routed ideas that actually landed on a rail is the routed-idea ledger, not this.',
    chaining:
      'Read `summary` first. If total is 0, read `empty.meaning` before concluding anything is broken. For any draft you take seriously, check `markerHits` BEFORE the prose: a draft whose only marker sits in `mechanism` with onlyInCodeSpan:true is a vocabulary artifact (D-012 measured exactly one such draft in the whole corpus), and `incidentalMatchOnly` names that case at the row.',
    seeAlso: [
      'blender:success-metrics (is the ideation substrate working at all)',
      'blender:route-idea (route an idea onto a rail)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: goalDraftsArgs,
  async handler(args, ctx) {
    const out = await runGoalDrafts(args, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      ...(out.ok ? {} : { isError: true }),
    };
  },
});
