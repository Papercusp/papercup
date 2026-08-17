/**
 * The built-in `rubric` plan-template (plan-templates-and-rubric-v2-2026-06-20 P-006).
 *
 * Phase 3's keystone: "a RUBRIC IS A PLAN" (D-002). A rubric-template plan carries
 * its STRUCTURED fields (characteristic, criteria, ratingScale, …) in the
 * `template_data` jsonb validated against THIS zod schema on write (P-005's
 * plans:set-template-data → validateTemplateData); its NARRATIVE model/method prose
 * lives in the plan body, and its top-level title in the plan frontmatter (so the
 * title has ONE home, not two). The re-pointed rubrics store (rubrics.ts) reconstructs
 * the v1 `Rubric` shape from a rubric-template plan + this validated templateData, so
 * rubrics:list/get/search + the Overwatch scorecard-emit read the SAME shape with the
 * backing changed (D-003, the scorecards.ts getRubric seam).
 *
 * This is a "schema definition" module the registry's own doc anticipates: it depends
 * only on zod + the (dependency-free) template-registry, and SELF-REGISTERS at module
 * load so both the write path (set-template-data) and the read path (the rubrics store)
 * find `rubric` without an explicit boot step. The agent-tools index also imports it
 * for side-effect (belt-and-suspenders + discoverability).
 */
import { z } from 'zod';
import { registerPlanTemplate, type PlanTemplate } from './template-registry';

/** The template TYPE name — a rubric-template plan's `template:` frontmatter/column. */
export const RUBRIC_TEMPLATE_NAME = 'rubric';

// ─── rubric KIND (acceptance-rubrics-on-every-plan-2026-08-11) ───────────────────────
// Two populations share the rubric machinery but have opposite lifecycles:
//   'standard'   = the reusable shared-standards library entry (the ONLY kind that
//                  existed before this plan — an absent `kind` means 'standard', so every
//                  pre-existing rubric is unchanged). Queen-ratified, staleness-watched,
//                  surfaced by the default rubrics:list/search library reads.
//   'acceptance' = a ONE-SHOT per-plan definition-of-done, linked to its subject plan via
//                  `subjectPlan`. Authored AFTER implementation, before the plan may be
//                  marked done/shipped (plan D-007); graded by a NON-implementer through
//                  the same grading path standards use (D-010); needs no ratification and
//                  is exempt from the staleness watchdog (D-008); hidden from the default
//                  library reads so the learning surfaces stay reusable-standards-only.

/** The rubric kinds. Absent = 'standard' (every pre-kind rubric). */
export const RUBRIC_KINDS = ['standard', 'acceptance'] as const;
export type RubricKind = (typeof RUBRIC_KINDS)[number];

/** Resolve a template_data's effective kind — absent/unknown maps to 'standard' so every
 *  pre-kind rubric keeps its original semantics. Use THIS, never a raw `data.kind` read. */
export function rubricKindOf(data: { kind?: string | null } | null | undefined): RubricKind {
  return data?.kind === 'acceptance' ? 'acceptance' : 'standard';
}

// ─── structured criterion grading-window (rubric-system-hardening-2026-07-14 P-001) ──
// EI-12146: the grading window used to live ONLY in criterion prose ("<5% post-watermark
// per the runbook") while the deployed instrument hardcoded its own (48h rolling) — on
// 2026-07-14 the two disagreed 9%-vs-0% on the same live system and stalled a release
// call. The window is now a STRUCTURED, machine-readable field on the criterion, and
// instruments/runbooks resolve it via resolveCriterionWindow() instead of re-hardcoding.

/** How far back a criterion's evidence window reaches. */
export const rubricCriterionWindowSchema = z
  .object({
    kind: z
      .enum(['rolling', 'post-watermark'])
      .describe(
        "'rolling' = a fixed look-back from now (ms required); 'post-watermark' = everything since a named event watermark (watermarkRef required), e.g. the running bg-host generation",
      ),
    ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("rolling window length in ms (required when kind='rolling')"),
    watermarkRef: z
      .string()
      .min(1)
      .optional()
      .describe(
        "named watermark the window starts at (required when kind='post-watermark'), e.g. 'bg-host-restart' = the running papercup-bg-host generation start",
      ),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.kind === 'rolling' && w.ms == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "window kind 'rolling' requires ms (the look-back length)" });
    }
    if (w.kind === 'post-watermark' && !w.watermarkRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "window kind 'post-watermark' requires watermarkRef (the named watermark the window starts at)",
      });
    }
  });

/** The structured grading window a criterion may declare (validated on write). */
export type RubricCriterionWindow = z.infer<typeof rubricCriterionWindowSchema>;

/** The default evidence window when a criterion declares none — 48h rolling (the bar the
 *  blender-release-readiness rubric and its instrument shipped with). Consumers that need
 *  a different default pass their own `defaultMs`. */
export const DEFAULT_CRITERION_WINDOW_MS = 48 * 60 * 60 * 1000;

/** A resolved, concrete evidence window: the epoch-ms floor + how it was derived. */
export interface ResolvedCriterionWindow {
  /** Inclusive epoch-ms floor — evidence at/after this instant is in the window. */
  sinceMs: number;
  kind: 'rolling' | 'post-watermark';
  /** The rolling look-back length (rolling resolutions only). */
  windowMs?: number;
  /** The watermark that produced sinceMs (post-watermark resolutions only). */
  watermarkRef?: string;
  /**
   * Provenance — a verdict must never be read without knowing which window judged it:
   *  'window' = the criterion's own structured window resolved cleanly;
   *  'default' = no structured window declared, the caller's default applied;
   *  'watermark-unresolved' = a post-watermark window was declared but its watermarkRef
   *    did not resolve — fell back to the rolling default rather than judging nothing.
   */
  source: 'window' | 'default' | 'watermark-unresolved';
}

/**
 * Resolve a criterion's structured window into a concrete epoch-ms floor. PURE — the
 * caller supplies `watermarks` (named ref → epoch-ms) it resolved through its own IO
 * (e.g. 'bg-host-restart' via scout/generation-watermark.ts). Degrades with provenance,
 * never throws: an unresolvable watermark falls back to the rolling default and SAYS SO
 * (`source:'watermark-unresolved'`), so a read-only instrument keeps answering while the
 * gap stays visible instead of silently judging the wrong window.
 */
export function resolveCriterionWindow(
  window: RubricCriterionWindow | undefined,
  opts: {
    nowMs?: number;
    /** Fallback rolling window (default {@link DEFAULT_CRITERION_WINDOW_MS}). */
    defaultMs?: number;
    /** Named watermark refs the caller has resolved (ref → epoch-ms; null/absent = unresolved). */
    watermarks?: Readonly<Record<string, number | null | undefined>>;
  } = {},
): ResolvedCriterionWindow {
  const nowMs = opts.nowMs ?? Date.now();
  const defaultMs = opts.defaultMs ?? DEFAULT_CRITERION_WINDOW_MS;
  if (!window) {
    return { sinceMs: nowMs - defaultMs, kind: 'rolling', windowMs: defaultMs, source: 'default' };
  }
  if (window.kind === 'rolling') {
    const ms = window.ms ?? defaultMs;
    return { sinceMs: nowMs - ms, kind: 'rolling', windowMs: ms, source: 'window' };
  }
  const ref = window.watermarkRef;
  const wm = ref != null ? opts.watermarks?.[ref] : undefined;
  if (typeof wm === 'number' && Number.isFinite(wm) && wm > 0) {
    return { sinceMs: wm, kind: 'post-watermark', ...(ref ? { watermarkRef: ref } : {}), source: 'window' };
  }
  return {
    sinceMs: nowMs - defaultMs,
    kind: 'rolling',
    windowMs: defaultMs,
    ...(ref ? { watermarkRef: ref } : {}),
    source: 'watermark-unresolved',
  };
}

/**
 * One gradeable criterion of a rubric. Field-for-field the v1 `RubricCriterion`
 * (rubrics.ts) so the re-pointed store maps templateData → Rubric 1:1 with no drift
 * (a compile-time assignability check pins this in rubric-template.test.ts). A
 * structured observation's `ratings` Record is keyed by `key`.
 */
export const rubricCriterionSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .describe("stable kebab id; a structured observation's ratings Record is keyed by this"),
    title: z.string().min(1).describe('short human label for the criterion'),
    model: z.string().min(1).describe('how this criterion is supposed to work (the MODEL)'),
    method: z.string().min(1).describe('how to investigate it (the METHOD: signals / queries)'),
    driftMarkers: z.string().min(1).describe('what a degraded / broken state looks like'),
    ratingScale: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("optional per-criterion override of the rubric's default rating scale"),
    replication: z
      .string()
      .min(1)
      .optional()
      .describe(
        "the criterion's own REPLICATION DRILL — the full end-to-end testing procedure a future " +
          'agent can copy-run to re-grade this criterion (fixtures → verbatim subject prompt → ' +
          'spawn/measurement → grading queries → cleanup). Structured slot, so a rubric revision ' +
          "can't silently drop it as 'verbose method prose' (WI-4287; rubrics:propose loss-guards " +
          'key off it)',
      ),
    instrumentKey: z
      .string()
      .min(1)
      .optional()
      .describe(
        "machine-readable instrument binding for this criterion. Use a stable key naming the exact tool/report field that grades it, or 'none' only when deliberately manual. Legacy trailing [instrumentKey: …] model tokens remain readable but new writes should use this field",
      ),
    window: rubricCriterionWindowSchema
      .optional()
      .describe(
        "the criterion's STRUCTURED evidence window (EI-12146) — instruments/graders resolve it " +
          'via resolveCriterionWindow() instead of re-hardcoding a look-back in prose. Omitted = ' +
          "the consumer's default (48h rolling)",
      ),
    criterionClass: z
      .enum(['settle-once', 'violatable'])
      .optional()
      .describe(
        "grading class (EI-20581177540737568): 'violatable' = monotonic-downward — one violation " +
          'falsifies it permanently and no later virtue restores it, so a mid-run rating is ' +
          'PROVISIONAL until the graded subject terminates (scorecards:emit stamps this). ' +
          "'settle-once' (also the omitted default) = settled permanently once its phase ends",
      ),
  })
  .strict();

/**
 * The acceptance-kind criterion: the SAME field vocabulary as a standard criterion (so
 * the grading path — ratings keyed by `key` against the rating scale — is identical,
 * D-010) but with the heavyweight prose fields OPTIONAL (plan D-007's light profile:
 * an acceptance criterion is authored post-implementation and must trace to the plan's
 * goal + Decisions; model/method/drift prose is welcome, never required). Standard-kind
 * rubrics still require the full fields — enforced by the per-kind superRefine below,
 * NOT by this element schema, so one criteria array serves both kinds.
 */
export const acceptanceRubricCriterionSchema = rubricCriterionSchema.partial({
  model: true,
  method: true,
  driftMarkers: true,
});

/**
 * The `rubric` template's structured data (the `template_data` jsonb). EXACTLY the
 * brief's fields — characteristic, criteria:[{key,title,model,method,driftMarkers}],
 * ratingScale — plus the optional methodRef + description the v1 Rubric also surfaces
 * (so the re-pointed reads return the full shape consumers depend on). `.strict()` so
 * an unknown/typo'd field fails loud on write (the D-004 fail-loud theme), never silent-
 * strips. NB: the rubric's top-level TITLE is NOT here — it derives from the plan
 * frontmatter title (one source of truth); the long-form narrative lives in the body.
 */
export const rubricTemplateDataSchema = z
  .object({
    kind: z
      .enum(RUBRIC_KINDS)
      .optional()
      .describe(
        "'standard' (the default when absent — every pre-kind rubric) = a reusable shared-standards " +
          "library entry; 'acceptance' = a one-shot per-plan definition-of-done linked via subjectPlan, " +
          'hidden from the default library reads / watchdog / ratification queue (acceptance-rubrics-on-every-plan-2026-08-11)',
      ),
    subjectPlan: z
      .string()
      .min(1)
      .optional()
      .describe(
        "acceptance-kind only: the slug of the plan this rubric is the definition-of-done FOR. " +
          "Required when kind='acceptance'; refused on a standard rubric",
      ),
    classRef: z
      .string()
      .min(1)
      .optional()
      .describe(
        'acceptance-kind only: rubricId of the standard-kind CLASS rubric this acceptance rubric builds on ' +
          '(feature-ship / bugfix / migration / investigation) — it carries the shared invariants so bespoke ' +
          'criteria stay short. With classRef an acceptance rubric may carry ZERO bespoke criteria (plan D-009)',
      ),
    characteristic: z
      .string()
      .min(1)
      .describe('umbrella domain, e.g. "hive-coordination" — Blender\'s digest groups by this'),
    criteria: z
      .array(acceptanceRubricCriterionSchema)
      .describe(
        'the gradeable criteria (a structured observation grades each). Standard kind: >=1 required, each ' +
          'with full model/method/driftMarkers (the per-kind superRefine enforces it). Acceptance kind: ' +
          'may be empty ONLY with a classRef (plan D-009); model/method/driftMarkers optional per criterion',
      ),
    ratingScale: z
      .array(z.string().min(1))
      .min(1)
      .describe('the rubric\'s default rating vocabulary, e.g. ["healthy","degraded","broken","unknown"]'),
    methodRef: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('agent-insights runbook slug holding the long-form METHOD (no prose duplication)'),
    releaseGating: z
      .boolean()
      .optional()
      .describe(
        'this rubric GATES a release verdict (EI-12149): the rubric-staleness watchdog alerts when an ' +
          'ACTIVE releaseGating rubric has no COMPLETE scorecard within its threshold window — a release ' +
          'bar nobody is grading is a silent gate, not a green one',
      ),
    stalenessWatched: z
      .boolean()
      .optional()
      .describe(
        'this rubric must keep being GRADED, without gating a release (blender-su-grade-integration-2026-08-11 ' +
          'P-011). The staleness watchdog watches releaseGating OR stalenessWatched rubrics. These are two ' +
          'different questions that shared one flag: "does a stale verdict block a ship?" vs "is anyone still ' +
          'grading this?" — so an ongoing HEALTH rubric had to either masquerade as a release bar (inheriting ' +
          'the machine-instrument contract it does not need, and blocking releases it should not) or go ' +
          'unwatched, which made a dead health loop indistinguishable from a healthy one',
      ),
    historyResetAt: z
      .string()
      .min(1)
      .optional()
      .describe(
        'CONTRACT-GENERATION BOUNDARY (goal-mode-rubric-v2 D-015): ISO instant before which gradings ' +
          'against this rubric measured a materially DIFFERENT contract, so scorecardTrend excludes them ' +
          '(reported as preContractResetExcluded, never silently). Set via setRubricHistoryReset, NOT a ' +
          'propose — a propose is a whole-document replace that would demote a ratified rubric. Needed ' +
          'because the cases that break comparability share a criterion KEY: a question that narrowed ' +
          'under a kept key, or a kept key whose drill could not measure at all',
      ),
    description: z
      .string()
      .optional()
      .describe('one-line summary; the long-form narrative lives in the plan body'),
    proposedBy: z
      .string()
      .min(1)
      .optional()
      .describe(
        'ownerId that authored the CURRENT proposal (EI-10751 provenance: the plan owner column is the ORIGINAL creator and does not track a re-propose, so projecting owner as proposer misattributes every revision)',
      ),
    ratifiedBy: z
      .string()
      .min(1)
      .optional()
      .describe(
        'ownerId that ratified this rubric (EI-10751: projecting the plan owner as ratifier fabricated the self-ratification record D-012 forbids). Written by ratifyRubric in the same locked write that activates; cleared by any re-propose (a revision needs re-ratification)',
      ),
    seedContentHash: z
      .string()
      .min(1)
      .optional()
      .describe(
        'EI-12932 first-party-bundle upgrade tracking: a stable hash of this rubric\'s bundle-sourced fields (characteristic/criteria/ratingScale/methodRef/description) as of the last first-party seed/upgrade write. Absent for a rubric never touched by the seeder, or one seeded before this field existed. Compared against a freshly computed hash of the LIVE stored fields to detect drift since that write — see rubricsNeedingSeed (cupboard/rubric-store.ts) for the decision core this guards.',
      ),
  })
  .strict()
  // Per-kind validation profile (acceptance-rubrics-on-every-plan-2026-08-11 P-001).
  // Fail-loud teaching errors, per the D-004 theme: a wrong-kind field combination is a
  // caller mistake to explain, never to silently strip or tolerate.
  .superRefine((d, ctx) => {
    const kind = rubricKindOf(d);
    if (kind === 'standard') {
      if (d.subjectPlan !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectPlan'],
          message:
            "subjectPlan is acceptance-kind only — a standard rubric is a reusable library standard, not a per-plan definition-of-done. Set kind:'acceptance' if this rubric belongs to one plan",
        });
      }
      if (d.classRef !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['classRef'],
          message:
            "classRef is acceptance-kind only — a standard rubric IS the class; it cannot reference one. Set kind:'acceptance' if this rubric builds on a class rubric",
        });
      }
      if (d.criteria.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria'],
          message: 'a standard rubric requires at least one criterion',
        });
      }
      d.criteria.forEach((c, i) => {
        for (const field of ['model', 'method', 'driftMarkers'] as const) {
          if (c[field] === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['criteria', i, field],
              message: `standard-kind criterion '${c.key}' requires ${field} (only acceptance-kind criteria may omit it)`,
            });
          }
        }
      });
    } else {
      // kind === 'acceptance'
      if (!d.subjectPlan) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectPlan'],
          message:
            "an acceptance rubric requires subjectPlan (the slug of the plan it is the definition-of-done for) — without it the completion gate cannot find it and the rubric is orphaned",
        });
      }
      if (d.criteria.length === 0 && !d.classRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria'],
          message:
            'an acceptance rubric needs bespoke criteria OR a classRef (plan D-009: only a class-rubric reference may stand alone, e.g. investigation-only plans referencing the investigation class rubric)',
        });
      }
      if (d.releaseGating) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['releaseGating'],
          message:
            'releaseGating is standard-kind only — an acceptance rubric is one-shot and watchdog-exempt (plan D-008); a release bar must be a standard rubric',
        });
      }
      if (d.stalenessWatched) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stalenessWatched'],
          message:
            'stalenessWatched is standard-kind only — an acceptance rubric is one-shot and watchdog-exempt (plan D-008), so "is anyone still grading this?" is not a question about it',
        });
      }
    }
  });

/** The validated structured-data type for a `rubric` template instance. */
export type RubricTemplateData = z.infer<typeof rubricTemplateDataSchema>;

/** The registry entry for the `rubric` built-in template type. */
export const RUBRIC_TEMPLATE: PlanTemplate = {
  name: RUBRIC_TEMPLATE_NAME,
  description:
    'A shared STANDARD for a system characteristic: criteria (key/title/model/method/driftMarkers) that structured observations grade, plus a rating scale. A rubric IS a plan (template:rubric); rubrics:list/get/search query these.',
  schema: rubricTemplateDataSchema,
};

// Self-register at module load so the write path (plans:set-template-data →
// validateTemplateData) and the read path (the rubrics store re-point) both resolve
// `rubric` without a separate boot step. Idempotent (registerPlanTemplate is by name).
registerPlanTemplate(RUBRIC_TEMPLATE);
