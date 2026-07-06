/**
 * blender:grade-idea — record an owner/Queen grade (1–5 + optional critique) on a
 * routed Scout idea (scout-idea-grading-2026-06-12 B-03 / P-003, contract C-3).
 *
 * The thin tool projection over the C-2 write seam ({@link gradeRoutedIdea}).
 * Two invariants live HERE rather than in any prompt:
 *
 *   - `gradedBy` is DERIVED from the caller, never caller-supplied (D-004):
 *     a Queen spawn ctx grades as 'Queen'; every other allowed surface — the
 *     admin UI tool proxy, SU/psu sessions, operator chat — acts on the
 *     owner's behalf and grades as 'owner'.
 *   - The idea key is `ideaId` OR the routed artifact's change-feed ref
 *     `routedRef` ("plan:<slug>" | "wi:<id>" | "gym:<id>"), exactly one
 *     (D-007): the Queen triages routed artifacts and holds only the ref;
 *     snapshot/UI callers hold the ideaId.
 *
 * Grades are a pure learning signal (D-005): fractional win credit in the
 * lens weights (C-5) + labelled feedback in ideator priming (C-4); they never
 * touch the routed artifact itself.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';

import {
  gradeRoutedIdea,
  type GradeRoutedIdeaInput,
  type GradeRoutedIdeaResult,
} from '../../scout/routed-ledger';
import { softText, clampText, LIMITS } from '../limits';

/** Grader attribution vocabulary (C-1 / D-004) — the seam's input type is the pin. */
export type GradedBy = GradeRoutedIdeaInput['gradedBy'];

/**
 * C-3: derive grader attribution from the caller — never from args. The Queen's
 * spawn ctx carries role 'queen'; every other surface this tool admits (admin
 * UI proxy, SU sessions, operator chat) is the owner acting directly or by proxy.
 */
export function deriveGradedBy(ctx: { role?: string } | undefined): GradedBy {
  return ctx?.role === 'mug' ? 'Queen' : 'owner';
}

/** Post-write summary of the graded ledger row, returned to the caller (C-3). */
export interface GradedIdeaSummary {
  ideaId: string;
  lens: string | null;
  rail: string | null;
  routedRef: string | null;
  title: string | null;
  routedAt: string | null;
  humanGrade: number | null;
  humanFeedback: string | null;
  gradedBy: string | null;
  gradedAt: string | null;
}

/** The C-2 result + attribution + row summary — the tool's full payload. */
export interface GradeIdeaOutcome extends GradeRoutedIdeaResult {
  gradedBy: GradedBy;
  /** The resolved ledger key (null when a routedRef resolved to nothing). */
  ideaId: string | null;
  /** Post-write row state; on an owner-grade-sovereign no-op this carries the standing owner grade. */
  idea: GradedIdeaSummary | null;
}

export const gradeIdeaArgs = z
  .object({
    /** The routed idea's ledger id. Pass this OR routedRef, not both. */
    ideaId: z.string().min(1).max(256).optional(),
    /**
     * Alternate key (D-007): the routed artifact's change-feed ref —
     * "plan:<slug>" | "wi:<id>" | "gym:<id>" — for callers that hold the
     * artifact but not the scout ideaId (the Queen's triage path).
     */
    routedRef: z.string().min(1).max(512).optional(),
    /** 1–5 integer (D-001): 5 = clear win, 3 = neutral, 1 = clear loss. */
    grade: z.number().int().min(1).max(5),
    /** Free-text critique shown to next cycles' ideators (C-4). Omitting it on a regrade clears the stored feedback. */
    feedback: softText(LIMITS.ANNOTATION).optional(),
  })
  .refine((a) => (a.ideaId == null) !== (a.routedRef == null), {
    message: 'Pass exactly one of ideaId or routedRef.',
  });
export type GradeIdeaArgs = z.infer<typeof gradeIdeaArgs>;

interface SummaryRow {
  idea_id: string;
  lens: string | null;
  rail: string | null;
  routed_ref: string | null;
  title: string | null;
  routed_at: string | number | null;
  human_grade: number | string | null;
  human_feedback: string | null;
  graded_by: string | null;
  graded_at: string | Date | null;
}

function toIso(v: string | number | Date | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * routedRef → ideaId (D-007). PK-adjacent lookup, deliberately NOT
 * workspace-narrowed — same EI-346 reasoning as {@link gradeRoutedIdea} /
 * readScoutPlanRefs: in-process tool dispatch runs under the 'default' ALS
 * workspace while ledger rows carry the active one, so a workspace clause
 * here would silently strand every ref-keyed grade. Newest routed_at wins
 * if a ref was ever routed twice.
 */
async function resolveIdeaIdFromRef(routedRef: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ idea_id: string }[]>`
    SELECT idea_id FROM harness_shared.scout_routed_ideas
     WHERE routed_ref = ${routedRef}
     ORDER BY routed_at DESC
     LIMIT 1`;
  return rows[0]?.idea_id ?? null;
}

/**
 * Read back the (post-write) row for the result summary. PK-keyed and not
 * workspace-narrowed for the same reason as the resolver above; the ledger's
 * list reader (readRoutedIdeas) stays the home for scoped multi-row reads.
 */
async function readIdeaSummary(ideaId: string): Promise<GradedIdeaSummary | null> {
  const { sql } = getOrgPg();
  const rows = await sql<SummaryRow[]>`
    SELECT idea_id, lens, rail, routed_ref, title, routed_at,
           human_grade, human_feedback, graded_by, graded_at
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${ideaId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    ideaId: r.idea_id,
    lens: r.lens,
    rail: r.rail,
    routedRef: r.routed_ref,
    title: r.title,
    routedAt: toIso(r.routed_at),
    humanGrade: r.human_grade == null ? null : Number(r.human_grade),
    humanFeedback: r.human_feedback,
    gradedBy: r.graded_by,
    gradedAt: toIso(r.graded_at),
  };
}

/** Injectable PG seams — unit tests run the full flow with fakes (gym-tools pattern). */
export interface GradeIdeaDeps {
  gradeRoutedIdea: typeof gradeRoutedIdea;
  resolveIdeaIdFromRef: typeof resolveIdeaIdFromRef;
  readIdeaSummary: typeof readIdeaSummary;
}

const defaultDeps: GradeIdeaDeps = { gradeRoutedIdea, resolveIdeaIdFromRef, readIdeaSummary };

/** The testable core: resolve key → C-2 write → row read-back. */
export async function runGradeIdea(
  args: GradeIdeaArgs,
  ctx: { role?: string } | undefined,
  deps: GradeIdeaDeps = defaultDeps,
): Promise<GradeIdeaOutcome> {
  const gradedBy = deriveGradedBy(ctx);
  const feedback = clampText(args.feedback, LIMITS.ANNOTATION);

  const ideaId = args.ideaId ?? (await deps.resolveIdeaIdFromRef(args.routedRef as string));
  if (ideaId == null) {
    return { applied: false, reason: 'not-found', gradedBy, ideaId: null, idea: null };
  }

  const result = await deps.gradeRoutedIdea({
    ideaId,
    grade: args.grade,
    ...(feedback !== undefined ? { feedback } : {}),
    gradedBy,
  });

  // Post-write read-back (PK-keyed, total). On applied=true it shows exactly
  // what was written; on owner-grade-sovereign it shows the standing owner
  // grade the caller lost to. Best-effort: a summary miss never fails a write.
  let idea: GradedIdeaSummary | null = null;
  try {
    idea = await deps.readIdeaSummary(ideaId);
  } catch {
    if (result.applied) {
      idea = {
        ideaId,
        lens: null,
        rail: null,
        routedRef: args.routedRef ?? null,
        title: null,
        routedAt: null,
        humanGrade: args.grade,
        humanFeedback: feedback ?? null,
        gradedBy,
        gradedAt: new Date().toISOString(),
      };
    }
  }

  return { ...result, gradedBy, ideaId, idea };
}

/** Map the outcome onto the tool result envelope (isError ONLY for not-found — a sovereign no-op is designed behavior). */
export function toToolResult(out: GradeIdeaOutcome): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    ...(out.reason === 'not-found' ? { isError: true } : {}),
  };
}

export default defineTool({
  name: 'blender:grade-idea',
  description:
    "Grade a routed Blender idea 1–5 with optional feedback (≤2000 chars). Grades steer Blender's learning: fractional win credit in the lens weights + the critique primed into next cycles' ideator prompts. Key by ideaId or routedRef.",
  capability: 'harness:write',
  guidance: {
    when:
      "You want to score a routed Blender idea 1–5 (optional one-line critique) so Blender learns which lenses to favor. Key by ideaId (Blender view / learning.scout snapshot callers) or by routedRef — the routed artifact's change-feed ref 'plan:<slug>' | 'wi:<id>' | 'gym:<id>' — when you hold the artifact but not the ideaId (the Mug's triage path: grade each ungraded routed draft).",
    notWhen:
      'Not an accept/reject of the routed artifact — a grade is a pure learning signal; the draft proceeds through normal triage regardless. Never pass grader attribution: gradedBy is derived from the caller role (Mug vs owner surface).',
    chaining:
      "Nothing to chain: weights update on the next refreshScoutOutcomes pass and feedback enters ideator priming automatically. applied:false + reason 'owner-grade-sovereign' (Mug regrading an owner-graded row) is expected, not an error — owner grades are sovereign; the returned summary carries the standing grade.",
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: gradeIdeaArgs,
  async handler(args, ctx) {
    return toToolResult(await runGradeIdea(args, ctx));
  },
});
