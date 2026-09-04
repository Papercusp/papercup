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
 * A criterion's optional STRUCTURED CHECK (consult-min-max-and-rubric-vetting-2026-08-17
 * P-011, owner-ratified D-006): the deterministic binding that replaces fuzzy judgment
 * where the outcome is objectively checkable.
 *
 *  - kind:'tests'      → { files } names Vitest files that MUST PASS. Paths resolve
 *    against the live tree at PROPOSE time or the propose is refused (mirroring
 *    replicationSqlCheck's write-time validation + plan-audit citation resolution, but
 *    REFUSING — a check that can never run is a booby trap, not advice). At GRADING
 *    time scorecards:emit actually RUNS the files (never stale ledger rows) and refuses
 *    a path that no longer resolves.
 *  - kind:'cargo'      → { manifestPath, sourceFiles, test? } runs one native Cargo
 *    crate at GRADING time. `sourceFiles` are the repo-relative Rust implementation
 *    files the crate-level verdict is attributed to; Cargo's stable runner does not
 *    expose per-test source files, so the record keeps this attribution explicit
 *    instead of pretending its aggregate counts came from each file independently.
 *  - kind:'instrument' → the existing instrumentKey binding, generalized into the same
 *    structured slot. `effectiveCriterionInstrumentKey` prefers it over the legacy
 *    top-level field.
 *  - kind:'coverage'   → { scope, floor } asserts that every surface the SURFACE CENSUS
 *    knows about in `scope` is proven to depth `floor` (deterministic-coverage-census
 *    P-006). Judged at grading time against `readCoverage` — the one derivation the
 *    tool, both state cells and the /admin/testing panel already share — so the gate can
 *    never disagree with the panel a human just read. Refuses the emit naming the
 *    surfaces below the floor. `floor` reuses the census's OWN rung vocabulary
 *    (l1..l4); there is deliberately no second scale and no percentage threshold —
 *    "90% covered" invites a denominator argument, "these 3 surfaces are unproven"
 *    does not.
 *  - kind:'requirements' → argless. Asserts that every requirement the subject plan's
 *    ACTIVATION audit dispositioned `covered`/`repaired` actually reached a plan item the
 *    COMPLETION audit verifies with a `code`/`test` citation — the same P-014 join the
 *    ship gate runs, exposed as a criterion so an INDEPENDENT GRADER can execute it.
 *    That is the whole point of the kind: the grader cannot run Bash, so a structured
 *    check is the only executable evidence available to it (design-to-code-coverage-seam
 *    P-026), and "which promises have no observable code" is precisely the question a
 *    grader is otherwise forced to take on the implementer's word.
 *    No scope argument: the subject plan IS the scope.
 *  - absent            → a fuzzy judgment criterion (today's behavior, still first-class).
 *
 * Fuzzy + deterministic criteria coexist in one rubric.
 */
export const rubricCriterionCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tests'),
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe(
          'Vitest test files that must pass for this criterion (repo-root-relative preferred; ' +
            'workspace-relative accepted when unambiguous). Validated to resolve against the live ' +
            'tree at propose time; actually RUN at grading time.',
        ),
    })
      .strict(),
  z
    .object({
      kind: z.literal('cargo'),
      manifestPath: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'repo-root-relative Cargo.toml manifest for the native test crate; validated to resolve against the live tree at propose time',
        ),
      sourceFiles: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(50)
        .describe(
          'repo-root-relative Rust/source files whose crate-level Cargo verdict is attributed to this criterion; Cargo does not expose per-test source attribution',
        ),
      test: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('optional Cargo test-name filter; an empty match is refused at grading time'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('instrument'),
      instrumentKey: z
        .string()
        .min(1)
        .describe(
          "stable machine-readable instrument binding (the generalized form of the criterion-level instrumentKey field); 'none' means explicitly manual",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('probe'),
      probe: z
        .unknown()
        .describe(
          'an existing typed ContinuityProbe ({ kind:"tool"|"state-cell", schemaRevision, expect, ... }). ' +
            'The rubric template keeps this field dependency-light; the proposal and scorecard write paths ' +
            'validate the live projected-tool/state-cell contract before persisting or executing it.',
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('coverage'),
      scope: z
        .object({
          surfaceKind: z
            .string()
            .min(1)
            .optional()
            .describe("census surface kind to scope to, e.g. 'http-route' | 'mcp-tool' | 'sync-query'"),
          sourceFiles: z
            .array(z.string().min(1))
            .min(1)
            .max(50)
            .optional()
            .describe(
              'implementing-file substrings; a surface is in scope if ANY matches (matched as one SQL union, never summed per file)',
            ),
          planTouched: z
            .literal(true)
            .optional()
            .describe(
              "resolve sourceFiles at grading time from the subject plan's completed work-items (their completion-evidence filesChanged) — the reverse map from 'what this plan changed' to 'the surfaces those files implement'. Mutually exclusive with an explicit sourceFiles.",
            ),
        })
        .strict()
        .describe(
          'which censused surfaces this criterion is about. An EMPTY scope means the whole harness census — legitimate, and still refused if it resolves to zero surfaces.',
        ),
      floor: z
        .enum(['l1', 'l2', 'l3', 'l4'])
        .describe(
          'the depth rung every in-scope surface must meet (the census\'s own vocabulary: l1 executed, l2 conformant, l3 intent-tested, l4 hardened). Judged by the meets_lN flag, never depth >= N — the rungs are not nested.',
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('requirements'),
    })
    .strict()
    .describe(
      "argless: asserts every requirement the subject plan's activation audit dispositioned covered/repaired reached a plan item the completion audit verifies with a code/test citation. The subject plan is the scope. Judged fresh at grading time; refuses when the plan has NO realizing mappings rather than passing vacuously.",
    ),
]);

/** The validated structured-check type — see {@link rubricCriterionCheckSchema}. */
export type RubricCriterionCheck = z.infer<typeof rubricCriterionCheckSchema>;

/** Structural acceptance role — outcome truth and disclosure about truth are never
 * interchangeable in coverage or at the ship floor. */
export const acceptanceCriterionRoleSchema = z.enum(['outcome', 'disclosure']);
export type AcceptanceCriterionRole = z.infer<typeof acceptanceCriterionRoleSchema>;

/** Lifecycle provenance for a canonical acceptance BAR. Historical criteria omit it;
 * post-adoption writers distinguish true predeclaration from honest legacy backfill. */
export const acceptanceBarProvenanceSchema = z
  .object({
    lifecycle: z.enum(['pre-implementation', 'legacy-backfilled']),
    declaredAt: z.string().datetime({ offset: true }),
    declaredBy: z.string().trim().min(1),
  })
  .strict();
export type AcceptanceBarProvenance = z.infer<typeof acceptanceBarProvenanceSchema>;

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
    barKey: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('acceptance-kind only: stable BAR identity, normally the source R-N key'),
    barHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe(
        'acceptance-kind only: server-derived SHA-256 binding key + model/bar text + falsifier + scope + role + pass semantics',
      ),
    role: acceptanceCriterionRoleSchema
      .optional()
      .describe("acceptance-kind only: 'outcome' is gradeable truth; 'disclosure' can report but never satisfy it"),
    mandatory: z
      .boolean()
      .optional()
      .describe('acceptance-kind only: whether this outcome belongs to the non-waivable ship floor'),
    requiredScope: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(200)
      .optional()
      .describe('acceptance-kind only: stable scope tokens the BAR promises to cover'),
    passRatings: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe('acceptance-kind only: explicit rating labels that satisfy this BAR'),
    coversBarKeys: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(200)
      .optional()
      .describe('acceptance disclosure only: outcome BAR keys this criterion reports on'),
    barProvenance: acceptanceBarProvenanceSchema
      .optional()
      .describe('acceptance-kind only: whether the BAR was predeclared or explicitly legacy-backfilled'),
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
    check: rubricCriterionCheckSchema
      .optional()
      .describe(
        "the criterion's STRUCTURED CHECK (P-011 / D-006): kind:'tests' { files } = deterministic " +
          "must-pass, validated at propose time and actually run at grading time; kind:'instrument' " +
          '= the generalized instrument binding. Omitted = fuzzy judgment criterion',
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
          "An acceptance rubric names exactly one subject (subjectPlan or subjectGoal); refused on a standard rubric",
      ),
    subjectGoal: z
      .string()
      .min(1)
      .optional()
      .describe(
        "acceptance-kind only: the GOAL id this rubric is the definition-of-done FOR (the goal-mode " +
          "'achieved' gate keys off it — consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2). " +
          'An acceptance rubric names exactly one subject (subjectPlan or subjectGoal); refused on a standard rubric',
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
          'may be empty ONLY with a classRef (plan D-009); model/method optional per criterion, but ' +
          'driftMarkers (the concrete falsifier) is REQUIRED on every bespoke criterion — the write-time ' +
          'authoring profile (rubricTemplateDataAuthoringSchema) enforces this even though the base schema ' +
          'reports it as optional',
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
    // P-011 (D-006), kind-independent: a criterion carrying BOTH the structured
    // instrument check and a CONFLICTING legacy top-level instrumentKey has two
    // bindings that cannot both be true — fail-loud teaching error (D-004 theme),
    // never a silent precedence pick. Equal values are tolerated (a transitional
    // double-write is harmless); kind:'tests' beside an instrumentKey is two
    // DIFFERENT bindings (a test suite and an instrument) and stays legal.
    d.criteria.forEach((c, i) => {
      if (
        c.check?.kind === 'instrument' &&
        c.instrumentKey !== undefined &&
        c.instrumentKey.trim() !== c.check.instrumentKey.trim()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria', i, 'check'],
          message:
            `criterion '${c.key}' binds two different instruments: check.instrumentKey ` +
            `'${c.check.instrumentKey}' vs the legacy instrumentKey field '${c.instrumentKey}' — `
            + 'they cannot both be authoritative. Keep the structured check (preferred) and drop ' +
            'the legacy field, or make them equal',
        });
      }
    });
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
      if (d.subjectGoal !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectGoal'],
          message:
            "subjectGoal is acceptance-kind only — a standard rubric is a reusable library standard, not a per-goal definition-of-done. Set kind:'acceptance' if this rubric belongs to one goal",
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
        for (const field of [
          'barKey',
          'barHash',
          'role',
          'mandatory',
          'requiredScope',
          'passRatings',
          'coversBarKeys',
          'barProvenance',
        ] as const) {
          if (c[field] !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['criteria', i, field],
              message:
                `${field} is acceptance-kind only — a standard criterion's model is reusable guidance, ` +
                'not a subject-plan BAR',
            });
          }
        }
      });
    } else {
      // kind === 'acceptance'
      if (!d.subjectPlan && !d.subjectGoal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectPlan'],
          message:
            "an acceptance rubric requires subjectPlan (the slug of the plan it is the definition-of-done for) or subjectGoal (the goal id, for the goal-mode 'achieved' gate) — without a subject the completion gate cannot find it and the rubric is orphaned",
        });
      }
      if (d.subjectPlan && d.subjectGoal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectGoal'],
          message:
            'an acceptance rubric names exactly ONE subject — subjectPlan or subjectGoal, not both (a rubric graded against two different definitions-of-done gates neither honestly)',
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

/**
 * Rating labels that can honestly carry a no-verdict result when a grader cannot
 * establish the criterion from the available evidence. `unknown` is the canonical
 * spelling used by scorecards, but acceptance rubrics have historically used a few
 * equivalent labels (for example `not-measured`) in their own scales.
 *
 * Keep this vocabulary here, beside the acceptance authoring guard, rather than in a
 * consumer: the authoring contract must not depend on whichever grader happens to read
 * the rubric first.
 */
export const UNKNOWN_RATING_EQUIVALENTS = [
  'unknown',
  'unassessable',
  'not-assessable',
  'not-assessed',
  'not-measured',
  'not-observed',
  'not-observable',
  'indeterminate',
  'inconclusive',
  'unverified',
  'unavailable',
  'no-verdict',
  'not-applicable',
  'na',
] as const;

function normalizeRatingVocabularyToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^n\/a$/, 'na');
}

/** True when a rating-scale entry can represent an honest no-verdict outcome. */
export function isUnknownRatingEquivalent(value: string): boolean {
  return (UNKNOWN_RATING_EQUIVALENTS as readonly string[]).includes(normalizeRatingVocabularyToken(value));
}

/**
 * The WRITE-TIME acceptance-rubric profile.
 *
 * `rubricTemplateDataSchema` remains permissive for the read/re-point path: historical
 * acceptance plans can be inspected even when they predate the falsifier/no-verdict
 * contract. Every new or amended acceptance rubric must use this stricter profile:
 * each bespoke criterion names a non-empty `driftMarkers` falsifier, and the rubric
 * scale has a label for evidence that cannot produce a verdict.
 */
export const rubricTemplateDataAuthoringSchema = rubricTemplateDataSchema.superRefine((d, ctx) => {
  if (rubricKindOf(d) !== 'acceptance') return;

  if (!d.ratingScale.some(isUnknownRatingEquivalent)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ratingScale'],
      message:
        'an acceptance rubric ratingScale must include an unknown-equivalent value ' +
        "(for example 'unknown', 'not-measured', 'indeterminate', or 'not-applicable') " +
        'so a grader can record that the evidence did not establish a verdict instead of fabricating pass/fail',
    });
  }

  d.criteria.forEach((criterion, index) => {
    if (!criterion.driftMarkers?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria', index, 'driftMarkers'],
        message:
          `acceptance-kind criterion '${criterion.key}' requires non-empty driftMarkers ` +
          '(the concrete degraded/broken state that falsifies the outcome)',
      });
    }

    const carriesBarContract =
      criterion.barKey !== undefined ||
      criterion.barHash !== undefined ||
      criterion.role !== undefined ||
      criterion.mandatory !== undefined ||
      criterion.requiredScope !== undefined ||
      criterion.passRatings !== undefined ||
      criterion.coversBarKeys !== undefined ||
      criterion.barProvenance !== undefined;
    if (!carriesBarContract) return; // explicit legacy compatibility
    if (!criterion.model?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria', index, 'model'],
        message:
          `acceptance BAR '${criterion.barKey ?? criterion.key}' requires canonical model text; ` +
          '`bar` is only a wire alias and is never persisted',
      });
    }
    if (!criterion.barHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria', index, 'barHash'],
        message:
          `acceptance BAR '${criterion.barKey ?? criterion.key}' requires its server-derived barHash; ` +
          'write through rubrics:propose/amend rather than hand-authoring partial template_data',
      });
    }
  });
});

/** The validated structured-data type for a `rubric` template instance. */
export type RubricTemplateData = z.infer<typeof rubricTemplateDataSchema>;

/** The registry entry for the `rubric` built-in template type. */
export const RUBRIC_TEMPLATE: PlanTemplate = {
  name: RUBRIC_TEMPLATE_NAME,
  description:
    'A shared STANDARD for a system characteristic: criteria (key/title/model/method/driftMarkers) that structured observations grade, plus a rating scale. A rubric IS a plan (template:rubric); rubrics:list/get/search query these.',
  // Registry consumers are write paths (plans:set-template-data). The read/re-point
  // path intentionally imports rubricTemplateDataSchema directly so legacy acceptance
  // rows remain inspectable while new writes get the stricter authoring profile.
  schema: rubricTemplateDataAuthoringSchema,
};

// Self-register at module load so the write path (plans:set-template-data →
// validateTemplateData) and the read path (the rubrics store re-point) both resolve
// `rubric` without a separate boot step. Idempotent (registerPlanTemplate is by name).
registerPlanTemplate(RUBRIC_TEMPLATE);
