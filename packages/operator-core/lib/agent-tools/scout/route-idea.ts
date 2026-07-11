/**
 * blender:route-idea — route an su IDEATE-pass idea onto the PLAN rail
 * (su-ideate-learning-substrate-2026-07-10 P-009 / D-007).
 *
 * The su-side multi-rail router, plan rail first: an su session (or the Mug
 * triaging su filings) promotes an idea into a DRAFT plan the Queen/owner then
 * greenlights. It rides the SAME draft seam Scout's broad rail uses
 * ({@link createScoutPlanDraft} — scout-plan-draft.ts), so the draft is pinned
 * to the DEFAULT workspace (the register-scout-action lesson: a draft under the
 * caller's ctx workspace is invisible to every plan UI/read) and the routed-idea
 * ledger row carries origin='su-ideate'. P-003/P-004 grade→outcome→feedback
 * attribution then works unchanged — classifyIdeaOutcome already follows a
 * `plan:<slug>` ref's terminal states.
 *
 * Two entry shapes (D-007), exactly one:
 *   - draft {…}  — a fresh idea: mint a ledger row keyed by the plan ref.
 *   - featureId  — re-route an ALREADY-FILED su feature (an EI): upsert its
 *                  existing ledger row (idea_id ON CONFLICT) onto the plan rail
 *                  + link wi↔plan 'relates'; the wi STAYS OPEN for Mug
 *                  disposition (a routing is not a resolution).
 *
 * gym / instance rails are explicitly OUT of scope here (acknowledge-only first,
 * a later item) — `rail` is pinned to 'plan'.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { getIssue, linkIssue } from '../../issues-engineer';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { createScoutPlanDraft, type CreateScoutPlanDraftInput } from '../../scout/scout-plan-draft';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-id-constant';
import { resolveAgentIdentity } from '../coordination/identity';
import { hardText, softText, LIMITS } from '../limits';

const cheapExperimentArg = z
  .object({
    hypothesis: z.string().min(1).max(2000).describe('what we believe will be true if the idea has merit'),
    method: z.string().min(1).max(2000).describe('the cheap first test (what to run / build / measure)'),
    falsifiableSignal: z.string().min(1).max(2000).describe('the observable that would prove the hypothesis WRONG'),
  })
  .strict();

export const routeIdeaArgs = z
  .object({
    /**
     * Re-route an ALREADY-FILED su feature (an EI id) onto the plan rail. Its
     * existing ledger row is upserted; the wi is linked to the plan and STAYS
     * OPEN. Pass this XOR `draft`.
     */
    featureId: z.string().min(1).max(120).optional().describe("re-route an already-filed su feature (EI id) onto the plan rail — the wi stays open"),
    /** A fresh idea to route straight to a draft plan. Pass this XOR `featureId`. */
    draft: z
      .object({
        title: hardText(LIMITS.SHORT_TITLE).describe('one-line idea title (becomes the draft plan title + slug stem)'),
        framing: hardText(LIMITS.CONTENT).describe('the why / the reframe — what problem or opportunity this addresses'),
        mechanism: hardText(LIMITS.CONTENT).describe('the how — the concrete mechanism the plan would build'),
        bet: softText(LIMITS.ANNOTATION).optional().describe('the concrete upside if the idea pans out'),
        cheapExperiment: cheapExperimentArg.optional().describe('the cheap falsifiable first experiment (ScoutExperiment shape, D-006)'),
        lens: z
          .enum([...SU_IDEATION_LENSES] as [SuIdeationLens, ...SuIdeationLens[]])
          .optional()
          .describe("the generative stance that produced the idea — recorded on the ledger row (origin-partitioned OUT of Scout's lens-weight learning); omitted ⇒ the 'su-ideate' sentinel"),
      })
      .strict()
      .optional(),
    /** Only the plan rail is wired here (D-007); gym/instance land later. */
    rail: z.literal('plan').default('plan').describe("the target rail — only 'plan' is supported here (gym/instance are a later item)"),
  })
  .refine((a) => (a.featureId == null) !== (a.draft == null), {
    message: 'Pass exactly one of featureId or draft.',
  });
export type RouteIdeaArgs = z.infer<typeof routeIdeaArgs>;

/** The tool's payload — what was routed, where, and (re-route path) the link state. */
export interface RouteIdeaResult {
  ok: boolean;
  /** The only non-ok outcome: a featureId that resolved to no issue. */
  reason?: 'not-found';
  rail?: 'plan';
  /** The (dated) draft plan slug. */
  slug?: string;
  /** The change-feed ref of the routed artifact: `plan:<slug>`. */
  planRef?: string;
  /** false = an existing plan with that slug was reused (idempotent). */
  created?: boolean;
  /** The routed-idea ledger PK. */
  ideaId?: string;
  /** Set on the re-route path: the source feature id. */
  featureId?: string;
  /** Re-route path: whether the wi↔plan 'relates' edge landed (best-effort). */
  linked?: boolean;
  /** Re-route path: the wi is deliberately NOT closed (D-007). */
  wiStaysOpen?: boolean;
}

/** Injectable seams — unit tests drive the full flow with fakes (grade-idea/gym-tools pattern). */
export interface RouteIdeaDeps {
  createPlanDraft: (input: CreateScoutPlanDraftInput) => Promise<{ slug: string; created: boolean }>;
  recordRoutedIdea: typeof recordRoutedIdea;
  getIssue: typeof getIssue;
  linkIssue: typeof linkIssue;
}

/**
 * Production createPlanDraft: the shared idempotent draft seam, pinned to the
 * DEFAULT workspace (register-scout-action.ts: a draft under the caller's ctx
 * workspace is invisible to every plan UI/read — 3 stranded drafts, 2026-06-11).
 */
const defaultDeps: RouteIdeaDeps = {
  createPlanDraft: (input) => createScoutPlanDraft({ ...input, workspaceId: DEFAULT_WORKSPACE_ID }),
  recordRoutedIdea,
  getIssue,
  linkIssue,
};

/** kebab-case slug stem from a title; createScoutPlanDraft appends the date suffix. */
export function slugStemFromTitle(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return stem || 'su-idea';
}

/** PURE: compose the draft plan's rationale/background from the declared idea shape. */
export function buildRouteRationale(input: {
  framing?: string | null;
  mechanism?: string | null;
  bet?: string | null;
  cheapExperiment?: { hypothesis: string; method: string; falsifiableSignal: string } | null;
  sourceRef?: string | null;
}): string {
  const ce = input.cheapExperiment;
  return [
    input.framing ? `**Framing:** ${input.framing}` : null,
    input.mechanism ? `**Mechanism:** ${input.mechanism}` : null,
    input.bet ? `**Bet:** ${input.bet}` : null,
    ce ? `**Cheap experiment:** hypothesis — ${ce.hypothesis}; method — ${ce.method}; falsifiable signal — ${ce.falsifiableSignal}` : null,
    input.sourceRef ? `_Routed from ${input.sourceRef} (su-ideate P-009). The wi stays open for triage._` : null,
  ]
    .filter((l): l is string => !!l)
    .join('\n\n');
}

/** The declared ideation shape a routed su feature may carry on its payload. */
function lensFromPayload(payload: unknown): SuIdeationLens | 'su-ideate' {
  const lens = (payload as { ideation?: { lens?: unknown } } | null)?.ideation?.lens;
  return typeof lens === 'string' && (SU_IDEATION_LENSES as readonly string[]).includes(lens)
    ? (lens as SuIdeationLens)
    : 'su-ideate';
}

/**
 * The testable core: create the draft plan, record/upsert the ledger row
 * (origin='su-ideate', plan rail), and — on the re-route path — link wi↔plan.
 */
export async function runRouteIdea(
  args: RouteIdeaArgs,
  ctx: unknown,
  deps: RouteIdeaDeps = defaultDeps,
): Promise<RouteIdeaResult> {
  const identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
  const harnessSlug =
    typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : 'papercusp';

  // ── Re-route path: an already-filed su feature → the plan rail (wi stays open).
  if (args.featureId) {
    const issue = await deps.getIssue(args.featureId);
    if (!issue) return { ok: false, reason: 'not-found', featureId: args.featureId };

    const { slug, created } = await deps.createPlanDraft({
      slug: slugStemFromTitle(issue.title),
      title: issue.title,
      harnessSlug,
      rationale: buildRouteRationale({ framing: issue.body || null, sourceRef: `wi:${issue.id}` }),
    });
    const planRef = `plan:${slug}`;
    // idea_id ON CONFLICT upserts the feature's existing ledger row onto the
    // plan rail; created_by preserves the ORIGINATOR (not the re-router).
    await deps.recordRoutedIdea({
      ideaId: issue.id,
      origin: 'su-ideate',
      rail: 'plan',
      routedRef: planRef,
      lens: lensFromPayload(issue.payload),
      harnessSlug,
      title: issue.title,
      createdBy: issue.createdBy ?? identity.ownerId,
    });
    // Link wi↔plan 'relates' (D-007) — best-effort: a link hiccup never undoes
    // the routing the caller asked for.
    let linked = false;
    try {
      await deps.linkIssue(issue.id, { kind: 'plan', ref: slug }, 'relates', identity.ownerId);
      linked = true;
    } catch {
      /* best-effort edge */
    }
    return { ok: true, rail: 'plan', slug, planRef, created, ideaId: issue.id, featureId: issue.id, linked, wiStaysOpen: true };
  }

  // ── Draft path: a fresh idea → a new draft plan + a fresh ledger row.
  const d = args.draft!;
  const { slug, created } = await deps.createPlanDraft({
    slug: slugStemFromTitle(d.title),
    title: d.title,
    harnessSlug,
    rationale: buildRouteRationale({
      framing: d.framing,
      mechanism: d.mechanism,
      bet: d.bet ?? null,
      cheapExperiment: d.cheapExperiment ?? null,
    }),
  });
  const planRef = `plan:${slug}`;
  await deps.recordRoutedIdea({
    ideaId: planRef, // no pre-existing idea id — key the row by its routed artifact
    origin: 'su-ideate',
    rail: 'plan',
    routedRef: planRef,
    lens: d.lens ?? 'su-ideate',
    harnessSlug,
    title: d.title,
    createdBy: identity.ownerId,
  });
  return { ok: true, rail: 'plan', slug, planRef, created, ideaId: planRef, wiStaysOpen: false };
}

/** Map the outcome onto the tool envelope (isError only for a not-found featureId). */
export function toToolResult(out: RouteIdeaResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    ...(out.ok ? {} : { isError: true }),
  };
}

export default defineTool({
  name: 'blender:route-idea',
  description:
    "Route an su idea onto the PLAN rail: create a DRAFT plan (Queen/owner greenlights it) and record it in the routed-idea ledger (origin='su-ideate') so grade→outcome→feedback learning attributes back to it. Pass `draft {title, framing, mechanism, bet?, cheapExperiment?, lens?}` for a fresh idea, OR `featureId` to re-route an already-filed su feature — that path links the wi to the plan and leaves the wi OPEN for triage. Only rail:'plan' is supported (gym/instance land later).",
  capability: 'harness:write',
  guidance: {
    when: "You have an su IDEATE-pass idea worth a real plan (not just a backlog item). Route a fresh idea with `draft`, or promote an already-filed feature with `featureId`. The draft lands in the Create tab as `status: draft` for Mug/owner review.",
    notWhen:
      'A small fix or friction — that is improvements:capture (kind bug/change). Grading a routed idea — blender:grade-idea. gym/instance rails — not wired here yet.',
    chaining:
      'blender:route-idea → the draft plan appears for Mug/owner triage; greenlighting it (promoting the draft) starts the normal plan lifecycle, and classifyIdeaOutcome follows the plan:<slug> terminal state so the idea earns won/lost credit automatically.',
    seeAlso: [
      'improvements:capture (file a smaller improvement instead of a plan)',
      'blender:grade-idea (grade a routed idea 1–5)',
      'plans:new (author a plan directly, not through the ideation ledger)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: routeIdeaArgs,
  async handler(args, ctx) {
    return toToolResult(await runRouteIdea(args, ctx));
  },
});
