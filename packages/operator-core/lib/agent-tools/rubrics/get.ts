/**
 * rubrics:get — one OR many rubrics in full, including every criterion (model +
 * method + drift markers + rating scale). The Overwatch scorecard and a
 * structured observation grade against these criteria
 * (rubric-driven-observations-2026-06-20 P-002; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21).
 *
 * Bulk by default (the house keyed-array contract): pass `rubricRef` for one or
 * `rubricRefs` for several → { ok, results:[{ ok, rubricRef, rubric? | error }],
 * counts } — each result self-describes its rubricRef, so a not-found ref never
 * poisons the rest and the agent correlates by ref (not array position). The
 * result key is deliberately the SAME spelling the input accepts, so a ref read
 * off a result can be passed straight back (P-005/EI-11400 retired `rubricId`
 * as a public argument; emitting it here re-taught the rejected key —
 * EI-22084112133846580). The
 * generic read-tool `ref`, caller-natural `slug`, and legacy `id` spellings are
 * accepted as compatibility aliases for the single-rubric form. Pass a positive
 * `revision` to resolve an immutable historical snapshot; a missing or malformed
 * snapshot fails closed instead of falling back to the current rubric. An
 * optional `harness` compatibility hint is accepted but does not filter this
 * workspace-wide read.
 */
import { z } from 'zod';
import { defineTool, formatVintageAge, readServerVintage } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getAcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import { getRubric, readRubricPlanRevision } from '../../rubrics';
import { listScorecards } from '../../scorecards';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

/**
 * `coord:send` provenance uses the typed dependency ref `plan:<slug>` for a
 * rubric read because rubrics are persisted as rubric-template plans. Preserve
 * the caller's original ref in the keyed result, but strip that dependency
 * kind before reaching the rubric store, whose public lookup key is the bare
 * rubric/plan slug.
 */
function normalizeRubricLookupRef(ref: string): string {
  const trimmed = ref.trim();
  const typed = /^plan:(.+)$/i.exec(trimmed);
  return typed?.[1]?.trim() || trimmed;
}

export default defineTool({
  name: 'rubrics:get',
  profile: 'engineer',
  description:
    "Read one OR many rubrics in full — criteria (key + model + method + drift markers + rating scale), default rating scale, method_ref runbook, and acceptance-rubric vetting status. Pass `rubricRef` (one) or `rubricRefs` (several); `plan:<rubric-slug>` refs are normalized; `ref`/`slug`/`id` are single-rubric compatibility aliases (rubricRef wins). A positive `revision` reads an immutable snapshot (results expose rubric.revision + rubric.criteriaHash; an unavailable snapshot is an item error, never a fallback to current). `harness` is accepted but does not filter. Returns { ok, results:[{ ok, rubricRef, rubric?, vetting? | error }], counts } — correlate by rubricRef, not position.",
  guidance: {
    when: 'You hold rubric refs (from rubrics:list/search or coord provenance) and need full criteria to grade against — a scorecard or a structured observation. Pass every ref at once via `rubricRefs`; add `revision` for pinned grading.',
    notWhen: 'Scanning many — rubrics:list (summary rows).',
    chaining: "rubrics:list → rubrics:get { rubricRefs:[…] } → grade each criterion (observation `ratings` is a Record keyed by criteria[].key). For a frozen audit pass { rubricRef, revision } and retain rubric.revision + rubric.criteriaHash. One failed ref never fails the rest.",
    seeAlso: [
      'rubrics:list (scan summary rows to find an id)',
      'rubrics:search (keyword lookup)',
      'rubrics:trend (how this rubric\'s criteria trend over time)',
    ],
  },
  // The criteria are the machine-readable grading contract, not browseable list
  // detail. Keep the complete rubric inline for model-facing grading: the generic
  // result door would replace a full response with a projection whose preview can
  // omit model/method/driftMarkers, even though this read has no narrower recovery
  // argument. The payload-tier hard ceiling remains the guard for pathological bulk
  // reads; this exemption is specifically for the deliberate full correctness body
  // (EI-21406267171411887).
  skipResultDoor: 'oversize-by-design',
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z
    .object({
      rubricRef: z.string().min(1).optional().describe('a single rubric ref/slug, e.g. "pot-coordination-health" (n=1 shorthand for rubricRefs:[ref])'),
      rubricRefs: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric refs/slugs to fetch (1–100)'),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe('Compatibility alias for rubricRef for generic read-tool callers; rubricRef wins when both are supplied.'),
      slug: z
        .string()
        .min(1)
        .optional()
        .describe('Caller-natural compatibility alias for rubricRef; rubricRef wins, then ref, when multiple single-rubric keys are supplied.'),
      id: z
        .string()
        .min(1)
        .optional()
        .describe('Legacy compatibility alias for rubricRef; used after rubricRef, ref, and slug.'),
      revision: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Read this exact immutable rubric revision; unavailable or malformed history fails closed.'),
      harness: z
        .string()
        .min(1)
        .optional()
        .describe('Optional caller scope hint accepted for compatibility; rubric reads remain workspace/template scoped and are not filtered by harness.'),
    })
    .refine((a) => Boolean(a.rubricRef ?? a.ref ?? a.slug ?? a.id) || (a.rubricRefs?.length ?? 0) > 0, {
      message: 'pass `rubricRef`/`ref`/`slug`/`id` (one) or `rubricRefs` (many)',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // EI-22577140653575153: handlers also run through in-process/nested
    // projected dispatch paths that do not necessarily traverse the MCP
    // transport's workspace wrapper. The rubric store resolves its partition
    // through activeWorkspaceId(), so bind the caller identity here rather than
    // silently falling through to the process-global workspace.
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      // Keep the canonical field authoritative when a caller supplies both it and
      // the generic/caller-natural/legacy compatibility aliases (the same rule
      // used by other aliased reads). `ref` wins over `slug`, and `slug` wins over
      // legacy `id`, when neither canonical key is set.
      const ids = mergeIds(args.rubricRef ?? args.ref ?? args.slug ?? args.id, args.rubricRefs);
      const env = await runBulk(
        ids,
        async (rubricRef) => {
          const lookupRef = normalizeRubricLookupRef(rubricRef);
          const rubric =
            args.revision === undefined ? await getRubric(lookupRef) : await getRubric(lookupRef, args.revision);
          if (rubric) {
            if (rubric.kind === 'acceptance') {
              const vetting = await getAcceptanceRubricVettingStatus(rubric, { listScorecards });
              return { ok: true as const, rubricRef, rubric, vetting };
            }
            return { ok: true as const, rubricRef, rubric };
          }

          // An explicit revision is an immutable-read contract. Do not reuse the
          // current-read projection-miss diagnostic here: a current plan-row
          // revision can exist while the requested historical snapshot is absent
          // or malformed, and neither case may look like a successful fallback.
          if (args.revision !== undefined) {
            const revisionRead = await readRubricPlanRevision(lookupRef);
            if (!revisionRead.ok) {
              return {
                ok: false as const,
                rubricRef,
                error: `rubric revision ${args.revision} could not be resolved; the revision read failed`,
              };
            }
            if (revisionRead.revision !== args.revision) {
              return {
                ok: false as const,
                rubricRef,
                error:
                  revisionRead.revision == null
                    ? `rubric revision ${args.revision} not found`
                    : `rubric revision ${args.revision} not found; current revision is ${revisionRead.revision}`,
              };
            }

            const vintage = readServerVintage();
            const vintageHint = vintage
              ? ` This server is running build ${vintage.buildId ?? 'an unknown build'}, started ${formatVintageAge(vintage.bootedAgoMs)} ago.`
              : '';
            const freshCodeEndpoint = vintage?.freshCodeEndpoint?.trim();
            const freshCodeHint = freshCodeEndpoint
              ? ` For the current source tree, retry this call against ${freshCodeEndpoint}.`
              : '';
            return {
              ok: false as const,
              rubricRef,
              error:
                `rubric revision ${args.revision} exists, but its immutable snapshot could not be projected.` +
                vintageHint +
                freshCodeHint,
            };
          }

          // EI-22439598382266201: getRubric intentionally hides acceptance rubric
          // rows from the default scan path. When its projection misses a ref but
          // the revision spine can still see a versioned backing plan row, report
          // the measured stale-reader shape instead of a false ordinary absence.
          // A failed revision read is a distinct UNKNOWN state: it cannot establish
          // that the rubric is absent, so never collapse it into a false not-found.
          const revisionRead = await readRubricPlanRevision(lookupRef);
          if (!revisionRead.ok) {
            return {
              ok: false as const,
              rubricRef,
              error:
                'rubric could not be resolved because the backing plan read failed; retry or verify independently before treating it as absent',
            };
          }
          if (revisionRead.revision == null) {
            return { ok: false as const, rubricRef, error: 'rubric not found' };
          }

          const vintage = readServerVintage();
          const vintageHint = vintage
            ? ` This server is running build ${vintage.buildId ?? 'an unknown build'}, started ${formatVintageAge(vintage.bootedAgoMs)} ago.`
            : '';
          const freshCodeEndpoint = vintage?.freshCodeEndpoint?.trim();
          const freshCodeHint = freshCodeEndpoint
            ? ` For the current source tree, retry this call against ${freshCodeEndpoint}.`
            : '';
          return {
            ok: false as const,
            rubricRef,
            error:
              `rubric not found; a backing rubric plan row exists at revision ${revisionRead.revision}, but this server could not project it.` +
              vintageHint +
              freshCodeHint,
          };
        },
        { keyOf: (rubricRef) => ({ rubricRef }) },
      );
      return bulkContent(env);
    });
  },
});
