/**
 * pot:survey — the Mug's plan-aware placement survey
 * (queen-autonomous-execution-2026-06-13 B-08 / P-010, P-012).
 *
 * One call returns BOTH ranked views of the Pot's work (autonomy-policy D-013),
 * ranked by the ONE placement registry (lib/pot/placement-ranker.ts):
 *   - `plans`    — every STARTED plan across the Pot's MEMBER harnesses, ranked
 *                  "which plan to pour cups into" (the plan-item / Queue side).
 *   - `frontier` — every unplaced (todo, unassigned) work-item across the same
 *                  harnesses, ranked "which ready item to place" (dispatch side).
 *
 * It surveys every MEMBER harness (registry `hive_slug`), not the Mug's home
 * seat — the P-012 fix for the 2026-06-11 home-slug-only miss; membership not
 * wired ⇒ a workspace-wide survey, so the home-only blind spot can't recur.
 *
 * EI-18953436700237995: the placement ranker (this file) and the claim-serving
 * order (`scheduler:get_next` / `work_items:claimable`) are TWO DIFFERENT
 * rankers over the same work — the Mug places off this survey's `frontier`,
 * but a cup pulls via its claim spec, which does not consult this ranking at
 * all. With `checkClaimOrder:true` the tool cross-checks its own frontier head
 * against the SAME oracle `work_items:claimable` uses (the harness's DEFAULT
 * claim-serving order) and flags `rankingDivergence` when the two heads share
 * NOTHING — the "Mug says place X, cups will actually pull Y" case, made
 * visible instead of silent. Opt-in (NOT run by default): it re-runs the full
 * floor computation over the harness's issue-family backlog, which is a real
 * cost on a large pool (~6s measured against a ~14k-row population) — too
 * expensive to pay on every placement wake, so a caller (or a periodic
 * Mug self-check) asks for it explicitly instead of it being silently free.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { surveyPot, surveyWorkspace } from '../../pot/survey';
import { placementRankerSpec } from '../../pot/placement-ranker';
import { isWorkspaceCoordinationOn } from '../../workspace-brain-scope';
import { shapePotSurvey } from './survey-shape';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';
import { readIssueClaimability } from '../../scheduler/get-next';
import { DEFAULT_CLAIM_SPEC, formatSpecRef } from '../../scheduler/claim-spec';
import type { Ranked } from '../../queue-ranker';
import type { PlacementCandidate } from '../../pot/placement-ranker';

/**
 * Cross-check the survey's own work-item frontier head against the harness's
 * actual claim-serving order (the DEFAULT spec — the same oracle
 * `work_items:claimable` reports when no fleet spec narrows it). Fail-open:
 * a read error or an inconclusive comparison (either side empty) returns
 * `undefined` rather than ever breaking or blanking the placement survey —
 * this is a diagnostic overlay, not a floor the survey depends on.
 */
async function checkClaimOrderDivergence(
  installSlug: string,
  frontier: readonly Ranked<PlacementCandidate>[],
  headSize: number,
): Promise<
  | {
      rankingDivergence: boolean;
      claimSpec: string;
      surveyHead: string[];
      claimOrderHead: string[];
      note: string;
    }
  | undefined
> {
  // Only work-item candidates IN THIS harness are comparable — the served
  // head below is scoped to this one harness, while the frontier can span
  // every member harness the Mug surveys.
  const surveyHead = frontier
    .filter((c) => c.view === 'work-item' && c.harness === installSlug)
    .slice(0, headSize)
    .map((c) => c.id);
  if (surveyHead.length === 0) return undefined; // nothing IN-HARNESS to compare against

  let claimOrderHead: string[];
  try {
    const reading = await readIssueClaimability(
      undefined, // no spec filter — the DEFAULT claim-serving order, unsteered
      { harness: installSlug },
      { limit: headSize },
    );
    claimOrderHead = reading.rows.map((r) => r.id);
  } catch (err) {
    console.warn(
      '[pot-survey] checkClaimOrder comparison failed — skipping (fail-open):',
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
  if (claimOrderHead.length === 0) return undefined; // nothing served — no divergence to report

  const surveySet = new Set(surveyHead);
  const overlap = claimOrderHead.filter((id) => surveySet.has(id));
  const rankingDivergence = overlap.length === 0;
  const specRef = formatSpecRef(DEFAULT_CLAIM_SPEC.specId, DEFAULT_CLAIM_SPEC.revision);
  return {
    rankingDivergence,
    claimSpec: specRef,
    surveyHead: surveyHead.slice(0, 10),
    claimOrderHead: claimOrderHead.slice(0, 10),
    note: rankingDivergence
      ? `RANKING DIVERGENCE: none of this survey's top ${surveyHead.length} in-harness frontier items appear in the ` +
        `top ${claimOrderHead.length} rows a cup would actually be served under ${specRef} (no fleet claim spec ` +
        `narrows it). Placement judgment here is not reaching the cups pulling this harness's default lane — ` +
        `see EI-18953436700237995.`
      : `${overlap.length}/${surveyHead.length} of this survey's top in-harness frontier items also appear in the ` +
        `top rows served under ${specRef} — no divergence detected.`,
  };
}

/** Compact a ranked candidate for the Mug — id, score, top reasons, signals.
 *  The `hive` tag is surfaced ONLY when present (the cross-pot workspace survey
 *  sets it; the single-pot survey omits it → byte-identical OFF output). */
function compact(c: Ranked<PlacementCandidate>) {
  const reasons = c.rank.features.flatMap((f) => f.reasons).slice(0, 4);
  return {
    id: c.id,
    harness: c.harness,
    ...(c.pot ? { pot: c.pot } : {}),
    title: c.title,
    importance: c.importance ?? 'normal',
    score: Math.round(c.rank.score * 100) / 100,
    ...(reasons.length > 0 ? { why: reasons } : {}),
    ...(c.openItems != null ? { openItems: c.openItems } : {}),
    ...(c.escalations ? { escalations: c.escalations } : {}),
  };
}

export default defineTool({
  name: 'pot:survey',
  profile: 'engineer',
  description:
    "The Mug's plan-aware placement survey: started plans ranked (which plan to pour cups into) AND the unplaced work-item frontier ranked (which ready item to place), across EVERY member harness — one ranker, two views. Read-only; call it at the top of a placement wake.",
  guidance: {
    when: 'You are the Mug starting a placement wake — survey what to work on next (which plan matters, which ready items to place) across all member harnesses.',
    notWhen: 'You already hold a specific work-item id and just need to place it — go straight to cup:spawn / the batch placement.',
    chaining:
      'pot:survey → place the top frontier items (cup:spawn / batch placement) and steer plan order (work_items:set_priority / plans:set-priority); pot:status to inspect the wake declaration.',
    seeAlso: [
      'pot:status (inspect the wake declaration)',
      'work_items:set_priority (steer the frontier order surveyed)',
      'fleet:assignments (who is already placed on the frontier)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    frontierLimit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Max frontier work-items to rank+return (default 50).'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max ranked rows returned per view (default 20).'),
    checkClaimOrder: z
      .boolean()
      .optional()
      .describe(
        'EI-18953436700237995: cross-check this survey\'s frontier head against the harness\'s ACTUAL claim-serving ' +
          'order (the same oracle work_items:claimable reports) and flag `rankingDivergence` when they share no ' +
          'items — the "placement says X, cups pull Y" trap, made visible instead of silent. Default false: it ' +
          're-runs the full claim-floor computation over the harness\'s issue-family backlog (a real cost on a large ' +
          'pool), so it is opt-in rather than paid on every placement wake. Single-pot survey only (ignored under ' +
          'the cross-pot workspace scope).',
      ),
  }),
  // context-trimming-tiers P-024: trimmed/standard sessions get capped ranked
  // rows (top-reason why, clipped titles) and — trimmed — the static ranker
  // spec replaced by a pointer (see survey-shape.ts).
  shape: {
    standard: (data) => shapePotSurvey(data, 'standard'),
    trimmed: (data) => shapePotSurvey(data, 'trimmed'),
  },
  async handler(args, ctx) {
    // D-048 ruled this TIER, from its own guidance: "You are the Mug starting a
    // placement wake" — and its documented chaining is `pot:survey → cup:spawn`,
    // which D-017 already gates. Read-only, so the refusal is not preventing a
    // write; it is refusing to hand back a placement frontier that nothing
    // retired can act on, and whose only next step is a tool that refuses.
    const retired = await refuseIfMugKettleRetired(
      "run the Mug's placement survey",
      'Drive the app with an su session (GOAL mode); scheduler:get_next is the claim path that replaces placement.',
    );
    if (retired) return retired;
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        data: {
          ok: false,
          error: 'no_home_harness',
          message: 'Pass `harness` (or set PAPERCUSP_POT_HOME_SLUG) — the survey is Pot-scoped.',
        },
      };
    }

    const limit = args.limit ?? 20;

    // P-003 (workspace-scoped-coordination-2026-06-20 / D-002): the central
    // dispatcher. When FLAGS.WORKSPACE_COORDINATION is ON, the ONE workspace
    // Mug surveys EVERY pot — per-pot sections (focused ideation, the D-004
    // dilution mitigation) PLUS a single cross-pot ranked backlog she dispatches
    // by cross-pot priority (each row pot-tagged so placement routes onto the
    // right pot's cups). OFF (the dark default) ⇒ the single-pot survey,
    // BYTE-IDENTICAL to today.
    if (await isWorkspaceCoordinationOn()) {
      const ws = await surveyWorkspace(workspaceId, {
        frontierLimit: args.frontierLimit,
        fallbackHome: installSlug,
      });
      // {data} envelope so the payload-tier shapers apply (P-024).
      return {
        data: {
          ok: true,
          scope: 'workspace',
          hives: ws.hives,
          counts: {
            hives: ws.hives.length,
            plans: ws.crossPot.plans.length,
            frontier: ws.crossPot.frontier.length,
            frontierBlocked: ws.crossPot.frontierBlocked,
            frontierQuarantined: ws.crossPot.frontierQuarantined ?? 0,
          },
          // EI-8498 / WI-4563 — a cross-pot frontier of zero is diagnosable too:
          // flag the admission deadlock LOUDLY so it never reads as a read-path bug.
          ...(ws.crossPot.frontier.length === 0 && (ws.crossPot.frontierQuarantined ?? 0) > 0
            ? {
                admissionStarved: true,
                note: `ADMISSION-STARVED DEADLOCK: 0 placeable cross-pot frontier items, but ${ws.crossPot.frontierQuarantined} withheld by the G2 admission gate (remote + un-admitted). NOT an idle workspace — work is structurally blocked from placing. Not a survey read-path bug.`,
              }
            : {}),
          // The cross-pot ranked priority — the central-dispatch ordering.
          crossPot: {
            plans: ws.crossPot.plans.slice(0, limit).map(compact),
            frontier: ws.crossPot.frontier.slice(0, limit).map(compact),
          },
          // The per-pot sections — focused, so ideation/placement stays scoped.
          perPot: ws.perPot.map(({ pot, survey }) => ({
            pot,
            home: survey.home,
            members: survey.members,
            scope: survey.scope,
            counts: { plans: survey.plans.length, frontier: survey.frontier.length, frontierBlocked: survey.frontierBlocked, frontierQuarantined: survey.frontierQuarantined ?? 0 },
            plans: survey.plans.slice(0, limit).map(compact),
            frontier: survey.frontier.slice(0, limit).map(compact),
          })),
          ranker: placementRankerSpec(),
        },
      };
    }

    const survey = await surveyPot(workspaceId, installSlug, {
      frontierLimit: args.frontierLimit,
    });

    // EI-18953436700237995: opt-in — see checkClaimOrderDivergence's header for why
    // this is never run unconditionally. Fail-open (returns undefined on any error
    // or inconclusive comparison), so it can never blank or break the survey itself.
    const claimOrderCheck = args.checkClaimOrder
      ? await checkClaimOrderDivergence(installSlug, survey.frontier, Math.min(limit, 25))
      : undefined;

    // {data} envelope so the payload-tier shapers apply (P-024).
    const frontierCount = survey.frontier.length;
    const frontierQuarantined = survey.frontierQuarantined ?? 0;
    return {
      data: {
        ok: true,
        home: survey.home,
        members: survey.members,
        scope: survey.scope,
        counts: { plans: survey.plans.length, frontier: frontierCount, frontierBlocked: survey.frontierBlocked, frontierQuarantined },
        // EI-8498 / WI-4563 — an empty frontier is diagnosable, never mysterious:
        // when the ONLY reason nothing is placeable is the G2 admission gate, say so
        // LOUDLY so a Mug (or a human) never re-reads "frontier: 0" as a read-path bug
        // for 14 consecutive wakes. `placeable === 0 && quarantined > 0` is a deadlock,
        // not an idle pot — there is no admit path in production that clears it on its own.
        ...(frontierCount === 0 && frontierQuarantined > 0
          ? {
              admissionStarved: true,
              note: `ADMISSION-STARVED DEADLOCK: 0 placeable frontier items, but ${frontierQuarantined} withheld by the G2 admission gate (remote + un-admitted). This is NOT an idle pot — it has work it is structurally blocked from placing. Not a survey read-path bug.`,
            }
          : {}),
        plans: survey.plans.slice(0, limit).map(compact),
        frontier: survey.frontier.slice(0, limit).map(compact),
        ranker: placementRankerSpec(),
        // EI-18953436700237995: present ONLY when checkClaimOrder was requested AND
        // the comparison was conclusive — absence means either "not asked" or "not
        // enough in-harness data to compare", never "checked, no divergence" (that
        // case reports rankingDivergence:false explicitly).
        ...(claimOrderCheck ? { claimOrderCheck } : {}),
      },
    };
  },
});
