/**
 * improvements:capture — file a captured papercusp improvement
 * (papercusp-self-improvement-loop-2026-06-04, Phase 1 / D-001;
 * close-the-self-improvement-loop-2026-06-05 D-002).
 *
 * The capture verb of the self-improvement loop: when an agent hits a papercusp
 * friction, this files it as a durable, claimable, topic-tagged work-unit (an
 * engineer_issue = work_item[kind ∈ bug|change]) instead of letting the insight
 * rot in chat. A THIN wrapper over the shared `captureImprovement` core
 * (capture-core.ts) — the watchdog's event-driven captures use the same core, so
 * the semantics (search-first dedup, native kind column, payload paths,
 * auto-tagging) live in exactly one place.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveAgentRole, resolveSelfLiteral } from '../coordination/identity';
import { getPresence } from '../coordination/presence';
import { COORD_ROLES } from '../coordination/roles';
import { notifyAgents } from '../coordination/notify-agents';
import { issueRef, linkIssue, type IssueSeverity } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { ObservationEvidenceError } from '../../harness/improvements/observation-types';
import { noveltyPriorArt } from '../../scout/novelty-precheck';
import { readRunningGeneration } from '../../scout/generation-watermark';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';
import { resolveWorkItemRef } from '../../work-items';
import { clampText, hardText, softText, LIMITS } from '../limits';
import { coerceCaptureArgs } from './capture-coerce';
import {
  normalizeSuspectedToolFailure,
  type SuspectedToolFailure,
} from '../../harness/improvements/tool-error-classifier';

const observationRatingsSchema = z.record(
  z.string().min(1),
  z.object({
    rating: z
      .string()
      .min(1)
      .describe(
        "a value from the criterion's ratingScale — default ['healthy','degraded','broken','unknown'] ('unknown' = not-assessable this wake)",
      ),
    evidence: z
      .string()
      .min(1)
      .describe(
        'MANDATORY concrete evidence backing the rating — a metric, a query result, a reference (a rating without evidence is rejected)',
      ),
    suggestion: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('OPTIONAL: your concrete improvement idea for this criterion — the Blender ideators see it as a seed'),
  }),
);

/**
 * EI-19325151590626958 — the DEFAULT conditionKey for a rubric-graded scorecard observation.
 *
 * THE FLOOD: a rubric-graded observation is auto-titled from its rubricRef, so every emission
 * of the same scorecard produces a near-identical row. Measured 2026-08-02 over 45d:
 * `pot-coordination-health scorecard` 823 filings / 821 still open, `hive-coordination-health
 * scorecard` 490 / 341 — ~1,162 open rows from one condition, EVERY one with conditionKey NULL.
 * Keyless items are invisible to dedup, known-open aging AND auto-close (all three key off
 * payload.watchdogKey — see harness/improvements/keyless-ei-policy), so they only accrete;
 * improvements:keyless-digest can surface that pile but deliberately closes nothing. This
 * closes it at the SOURCE instead of triaging it afterwards.
 *
 * WHY A DEFAULT RATHER THAN FIXING CALL SITES: the two large populations are not the backstop
 * emitters (scorecard-emission-pulse / overwatch-scorecard-backstop already pass their own keys,
 * and correspondingly sit at n=1–4 with no accretion). They are AGENT-filed — any agent grading
 * a rubric mints a fresh row — so there is no call site to patch.
 *
 * THE KEY SHAPE follows the convention those existing emitters already established
 * (`scorecard-pulse:<hive>`, `scorecard-backstop:<hive>`): rubric AND hive, never rubric alone.
 * Keying on rubricRef only would collapse DIFFERENT pots' scorecards into a single row — a
 * worse defect than the flood, because a per-pot health signal would silently overwrite its
 * siblings. So this returns undefined (keyless, i.e. today's behaviour) unless BOTH are known;
 * a hive-less filing is left alone rather than guessed at.
 *
 * SAFE TO COLLAPSE: dedup updates in place and refreshes to the latest reading, which would
 * lose history if these rows were the only record — they are not. The authoritative per-reading
 * series lives in the scorecards store (scorecards:list / scorecards:freshness / rubrics:trend);
 * the observation lane is an explicitly pre-idea reflection lane feeding Blender's digest.
 * An explicit conditionKey always wins, so a caller can still opt out or override.
 */
export function defaultScorecardConditionKey(
  observation: { rubricRef?: string; sourceHive?: string } | undefined,
): string | undefined {
  const rubricRef = observation?.rubricRef;
  const sourceHive = observation?.sourceHive;
  if (!rubricRef || !sourceHive) return undefined;
  return `scorecard:${rubricRef}:${sourceHive}`;
}

/**
 * gym-real-fitness-signal P-007 / D-010: report the MISSING cheapExperiment on a
 * kind:'feature' capture — as a response field, NEVER as a gate.
 *
 * The idea-fitness loop's input is the `cheapExperiment` block: an idea without one
 * cannot be compiled into a probe, so it can never be judged on an observed outcome
 * (D-002) and is invisible to the fitness loop entirely. P-007's R-2 originally
 * proposed making the block REQUIRED at capture for kind:'feature'. Two measurements
 * killed that (both recorded on D-010, both re-runnable):
 *
 *  1. It contradicts `su-ideate-learning-substrate` D-005 — "Enrich, never gate …
 *     no idea is too speculative to file — no quality gate, no quota" — itself carried
 *     VERBATIM from an earlier parity decision, i.e. ratified twice. This very
 *     directory is the reason: capture-coerce.ts exists because a hard `kind` enum was
 *     rejecting ~17% of calls and "every rejected call is a captured insight LOST".
 *  2. R-2's premise was a DENOMINATOR ERROR. "21 of 33,770 = 0.07%" divided by every
 *     work item ever. Against the population the field actually applies to — su
 *     kind:'feature' captures since the schema shipped 2026-07-11 — it is 21 of 66,
 *     i.e. ~32%, and the rate is FLAT (24-25%) across the last 7d and the prior 23d
 *     rather than decayed to zero. A gate would therefore have rejected ~2 of every 3
 *     feature filings.
 *
 * So the gap is reported, not enforced. Measured 2026-08-08: of the 66 post-schema
 * captures, ZERO supplied a partial block — every filer sent all three fields or none.
 * There is nothing to "repair", which is why this names the gap instead of coercing it.
 *
 * Same eligibility as the ideation PERSISTENCE below (kind:'feature', improvement lane):
 * it fires exactly where a supplied block would have been stored, so it can never nag a
 * filer about a field the handler would have discarded anyway.
 */
export function describeExperimentGap(args: {
  kind?: string;
  lane?: string;
  ideation?: { cheapExperiment?: { hypothesis?: string; method?: string; falsifiableSignal?: string } };
}): { missing: string[]; note: string } | undefined {
  if (args.kind !== 'feature' || args.lane === 'observation') return undefined;
  const exp = args.ideation?.cheapExperiment;
  const missing = (['hypothesis', 'method', 'falsifiableSignal'] as const).filter((f) => !exp?.[f]);
  if (missing.length === 0) return undefined;
  return {
    missing: [...missing],
    note:
      'Filed — this is a report, not a rejection. This idea carries no complete `ideation.cheapExperiment`, ' +
      'so it cannot be compiled into a probe and stays invisible to the idea-fitness loop (it is also ranked ' +
      'below bettable ideas in triage). To make it bettable, re-file or amend with ideation.cheapExperiment: ' +
      '{ hypothesis: what is true if this has merit, method: the cheap first test, falsifiableSignal: the ' +
      'observable that would prove it WRONG }.',
  };
}

export default defineTool({
  name: 'improvements:capture',
  profile: 'engineer',
  description:
    'Capture a papercusp improvement you discovered (a friction, a missing affordance, a tooling bug) as a durable, claimable, `papercusp-improvement`-tagged work-unit. kind=bug → auto-implement-eligible; change|feature → human-reviewed. Search-first: declines an obvious duplicate (link instead) unless force. An su kind=feature filing also gets a REPORT-ONLY novelty pre-check (`priorArt[]`, incl. already-tried-and-failed priors) — never blocks. Pass `paths` (files involved) to feed the protected-path gate. lane:"observation" files a turn-end PRE-IDEA into a separate lane that NEVER enters the work queue (Scout-digest + Observations pane only).',
  guidance: {
    when: 'The MOMENT you suspect ANY papercusp bug — broken OR SUB-OPTIMAL (a monitor false alarm, a self-recovered flap, load-correlated degradation) — filing is mandatory, not a judgment call: file (kind:bug, evidence in body) even with no fix and even if it self-recovered; only fix-now-vs-leave-filed is the judgment call. Also DX/tooling/code friction out of scope. Include `paths` — the auto-implement risk gate reads them.',
    notWhen:
      'A problem in a MANAGED harness/project (not papercusp itself) — that is work_items:create with that harness scope. Something needing real design — write a plan (plans:new) and capture with kind=feature linking it. A passing question — coord:ask.',
    chaining:
      'improvements:capture { kind, title, paths? } → improvements:digest triages it → an agent claims + fixes it, or the auto-implement loop picks up bugs and improvements:resolve closes them.',
    returns:
      'CREATE: { ok, created, issue, topics, possibleDuplicates, dedupCoverage, alreadyDecided? }. CHECK (checkDuplicatesOnly): { ok, created:false, reason:"check-only", possibleDuplicates, dedupCoverage, alreadyDecided? }.\n\n' +
      'possibleDuplicates[] carries THREE kinds of hit, and they do NOT mean the same thing:\n' +
      '  • no flag        — token-overlap (Jaccard) above threshold. May DECLINE your capture.\n' +
      '  • semantic:hard  — embedding match. May DECLINE your capture.\n' +
      '  • semantic:soft  — weaker embedding match. ADVISORY ONLY, never declines.\n' +
      '  • lexical:"containment" — your (shorter) title is almost fully covered by a much longer stored one. ADVISORY ONLY, never declines. This is the net that makes a SHORT symptom query work: Jaccard divides by the union, so a short query that is a perfect subset of a long stored title scores |query|/|title| and cannot clear the threshold on its own.\n\n' +
      'dedupCoverage { lexical, semantic, degraded } — WHAT COULD ACTUALLY BE CHECKED. Read it before treating an empty possibleDuplicates as "nothing similar exists". The embedding leg fails OPEN (semantic:"unavailable" when the embedder is down/over budget), so degraded:true means a differently-worded duplicate would NOT have been found and your empty result is "could not check", not "checked and clean".',
    seeAlso: [
      'SYMPTOM-FIRST — improvements:capture { title, checkDuplicatesOnly:true } BEFORE you diagnose: "has anyone already hit this?" costs one call and a title, and creates nothing',
      'improvements:digest (triage the backlog this lands in)',
      'work_items:create (a problem in a MANAGED harness, not papercusp itself)',
      'plans:new (something needing real design — capture kind=feature linking it)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // `scanner` (the scan launch blueprint's role, unify-agent-launches D-005):
  // capturing findings into the self-improvement backlog IS its output
  // contract — the P-009 live smoke proved the role allowlist (not the
  // capability gate) was what kept the spawned scanner from landing its
  // findings (it has coord:write via BLUEPRINT_ROLE_CAPS, but wasn't in
  // this list, so the tool never appeared in its projected surface).
  agentRoles: [...COORD_ROLES, 'scanner'],
  // WI-1974: normalise a mis-used top-level `kind` (observation / null / an observation
  // sub-kind / a free-form label) to intent BEFORE validation, so a captured insight is
  // never rejected+lost on the enum. Only `kind` is touched; the .strict() observation
  // sub-object keeps failing loud on unknown keys (deliberate, anti-silent-data-loss).
  // EI-10424: also forces an IDEATE-pass proposal (structured `ideation` payload, or a
  // `foundDuring` naming an ideate pass) that left `kind` at its ambiguous 'change'
  // default into the reviewed 'feature' lane instead of landing as ordinary claimable
  // change-work — see capture-coerce.ts for the full contract.
  args: z.preprocess(
    coerceCaptureArgs,
    z
      .object({
        title: hardText(LIMITS.SHORT_TITLE).describe(
          'one-line summary (do NOT include a [kind] prefix — pass kind separately)',
        ),
        kind: z
          .enum(['bug', 'change', 'feature'])
          .optional()
          .describe(
            'bug = something broken (auto-eligible); change = a desired improvement; feature = net-new (both human-gated). Required for an improvement; ignored for lane:observation (always stored as a non-bug nit). Default change.',
          ),
        body: hardText(LIMITS.CONTENT).optional().describe('repro / context / the correct-state, especially for a bug'),
        severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
        subTopic: z.string().min(1).max(40).optional().describe('optional sub-area topic, e.g. coord-dx, db-tooling'),
        scope: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Pot scope. OMIT (recommended) → the item files under the workspace platform Pot; pass 'harness:<slug>' to scope it to a specific Pot. (An omitted/'operator'/workspace-global scope auto-homes to the platform Pot — you do NOT need to pass 'harness:papercusp' by hand.)",
          ),
        // EI-10943: was `z.string().max(120)` — a HARD reject. Overrunning it bounced the
        // WHOLE capture (the finding is lost, and the agent gets the entire args schema
        // dumped back at it) over a provenance LABEL the tool only stores and echoes, into
        // an unbounded `text` column. Soft-capped: truncate + warn, never reject. The clamp
        // is handler-side, NOT a zod .transform() — a transform is unrepresentable in JSON
        // Schema and crashes z.toJSONSchema for the whole catalog (see limits.ts).
        foundDuring: softText(LIMITS.LABEL)
          .optional()
          .describe(
            `what you were doing when you found this (a plan slug, a task, "the X audit"). ` +
              `Free text — truncated to ${LIMITS.LABEL} chars with a warning if longer, never rejected.`,
          ),
        paths: z
          .array(z.string().min(1).max(300))
          .max(20)
          .optional()
          .describe('repo-relative file paths the improvement touches, when known — feeds the protected-path gate'),
        notifyAgents: z
          .array(z.string().min(1))
          .max(8)
          .optional()
          .describe(
            '@-mention SPECIFIC agents: ownerId prefixes / handles (resolve via coord:presence). Each is SUBSCRIBED to the captured item (gets every future update) AND pinged now, pointing at it — a DIRECTED handoff to a known owner. Distinct from the auto-topic broadcast (which reaches whoever subscribed to the area) and from claiming. Ignored for lane:observation. Use when you know exactly who should see/own this.',
          ),
        force: z
          .boolean()
          .optional()
          .describe('file even if a likely duplicate exists (default false → search-first declines)'),
        checkDuplicatesOnly: z
          .boolean()
          .optional()
          .describe(
            'SEARCH ONLY, creates nothing: "has anyone already hit this?" — run BEFORE you diagnose, with just a `title` (the symptom in your own words).',
          ),
        // WI-5950. Kept SHORT on purpose: the prompt-weight budget (≤1500 soft / ≤1600 hard
        // per tool) is shared across every field, and the first draft of this description
        // blew the hard cap on its own. The rationale lives here, not in the agent's context:
        // the persona tells every agent to file the moment it notices AND to hold a work-item
        // before editing — without an atomic claim those two conflict, so filing a bug you are
        // already fixing publishes it to the claimable pool and a peer duplicates the work
        // (observed 2026-07-26, cost su-63f9b336 a duplicate run at the same fix).
        // Same name + semantics as work_items:create's assign_to; 'self' resolves to the caller.
        assign_to: z
          .string()
          .max(120)
          .optional()
          .describe(
            'Atomically CLAIM the filed item in this same capture — an ownerId, or "self". Use when you are ALREADY working the thing you are filing: an unclaimed item goes to the claimable pool, where a peer may duplicate your in-progress fix. Omit ⇒ unclaimed. Ignored for observations.',
          ),
        origin: z
          .enum(['organic', 'drill', 'replay', 'shadow'])
          .optional()
          .describe(
            'signal provenance (frontier P-002) — default organic. ONLY a frontier loop passes non-organic (vaccination drill, replay counterfactual, shadow ablation); synthetic rows stay out of organic learners',
          ),
        lane: z
          .enum(['improvement', 'observation'])
          .optional()
          .describe(
            "'observation' files a PRE-IDEA turn-end reflection into the SEPARATE observation lane (D-005) — it never enters the work queue/triage/auto-implement; only Blender's corpus-digest + the Observations pane read it. Default 'improvement'.",
          ),
        conditionKey: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .describe(
            "EI-15448, lane:'observation' ONLY: a STABLE identity for a RECURRING condition (e.g. an OverwatchBrief anomaly line's `[conditionKey: overwatch:escalation-aging]` — copy it verbatim). A still-OPEN prior observation carrying the SAME conditionKey is updated in place (repeatCount bumped, title/body refreshed to this call's latest reading) instead of minting a fresh row every call — fixes the wake-over-wake status-note flood (7k+ open items from one unresolved condition). Omit for a genuinely novel/one-off reading, which always re-files as before. A rubric-graded scorecard (observation.rubricRef) DEFAULTS to `scorecard:<rubricRef>:<sourceHive>` when you omit this (EI-19325151590626958) — pass it explicitly to override. Ignored outside lane:'observation'.",
          ),
        toolFailure: z
          .object({
            toolName: z.string().min(1).max(160),
            errorCode: z.string().max(160).optional(),
            status: z.string().max(80).optional(),
            message: z.string().min(1).max(4000),
            schemaRevision: z.string().max(160).optional(),
            fieldPath: z.string().max(300).optional(),
            runtimeVersion: z.string().max(160).optional(),
            reproduced: z.boolean().optional(),
            clearServerMismatch: z.boolean().optional(),
            hardInternal: z.boolean().optional(),
          })
          .strict()
          .optional()
          .describe(
            'Suspected tool-call failure. A one-off is captured immediately in non-claimable probation and correlated by tool/error/schema/field/runtime; a second independent reporter or the invocation watchdog promotes the SAME row. Set reproduced, clearServerMismatch, or hardInternal only with direct evidence to file claimable work immediately.',
          ),
        // EI-12176 compatibility aliases. Older generated guidance advertised these at
        // top level. Declaring + normalising them prevents tools:invoke's permissive
        // envelope from silently stripping a scorecard while keeping observation.* as
        // the canonical shape shown to new callers.
        rubricRef: z
          .string()
          .max(120)
          .optional()
          .describe('compatibility alias for observation.rubricRef; prefer observation:{ rubricRef, ratings }'),
        ratings: observationRatingsSchema
          .optional()
          .describe('compatibility alias for observation.ratings; prefer observation:{ rubricRef, ratings }'),
        observation: z
          .object({
            kind: z.enum(['friction', 'workaround', 'gap', 'surprise', 'reinforce']).optional(),
            scope: z.enum(['self', 'role', 'harness', 'papercusp']).optional(),
            confidence: z.enum(['low', 'med', 'high']).optional(),
            refs: z
              .array(z.string().max(200))
              .max(12)
              .optional()
              .describe('attribution: tool:/file:/WI- refs grounding the observation'),
            // ── Structured-observation v2 (rubric-driven-observations-2026-06-20 P-001 / D-003).
            // Converges the source-hive tag (workspace-scoped-coordination P-001) + rubric
            // grading (this plan) into ONE coherent extension. All optional — free-text
            // observations stay first-class.
            sourceHive: z
              .string()
              .max(120)
              .optional()
              .describe(
                'the pot the observation came FROM — AUTO-DERIVED from ctx (the agent harness/pot) when omitted; explicit callers (Kettle/Blender) may set it',
              ),
            targetHive: z
              .string()
              .max(120)
              .optional()
              .describe('optional: the pot the observation is ABOUT (a cross-pot observation)'),
            rubricRef: z
              .string()
              .max(120)
              .optional()
              .describe(
                "a rubrics.rubric_id this observation grades against (e.g. 'pot-coordination-health'). Present ⇒ a rubric-graded observation; ratings must accompany it",
              ),
            ratings: observationRatingsSchema
              .optional()
              .describe(
                'per-criterion ratings against rubricRef, KEYED by rubric criterion `key` (a scorecard: one rating per criterion). evidence is mandatory on every entry',
              ),
            // rubric-system-improvements-2026-07-12 P-002: the scoped-drill shorthand.
            // A targeted run exercises a handful of a rubric's criteria; the completeness
            // gate still (rightly) demands every key, which day-one produced ~13 hand-written
            // boilerplate unknowns per scorecard. Each listed key expands server-side to
            // { rating:'unknown', evidence:'idle: not exercised by this run.' } — the idle:
            // form the staleness calc excludes. Explicit ratings always win; the key is
            // stripped before storage so the persisted payload stays pure ratings.
            notExercised: z
              .array(z.string().min(1))
              .max(64)
              .optional()
              .describe(
                "criterion keys this run did NOT exercise — each expands to { rating:'unknown', evidence:'idle: not exercised by this run.' } so a scoped drill passes the completeness gate without hand-written boilerplate (explicit ratings win)",
              ),
            // WI-3594 (scorecard→improvement flow): a GRADE filing (rubricRef+ratings) often
            // identifies a concrete follow-up — link it AT FILE TIME instead of a separate
            // work_items:link round-trip later (which is easy to forget, silently orphaning the
            // scorecard from the work it motivated). Surfaced in ScorecardDetail's UI (scorecards.list
            // linkedItems). Optional — a scorecard with nothing concrete to link stays unlinked.
            linkTo: z
              .array(
                z.object({
                  targetId: z
                    .string()
                    .min(1)
                    .max(120)
                    .describe('the work-item id (WI-/F-/EI-…) this scorecard relates to'),
                  rel: z
                    .enum(['relates', 'blocks', 'duplicates', 'fixes', 'revises'])
                    .optional()
                    .describe(
                      "default 'relates'; use 'revises' when this new filing incorporates feedback on the target",
                    ),
                  targetHarness: z
                    .string()
                    .max(80)
                    .optional()
                    .describe('harness for a feature targetId (disambiguation)'),
                }),
              )
              .max(5)
              .optional()
              .describe(
                "link this filing to one or more existing work-items at file time (e.g. a GRADE follow-up, or rel:'revises' for a feedback-driven revision) — best-effort, never fails the capture",
              ),
            // goal-mode-rubric-v2-2026-08-10 P-009: WHAT this scorecard grades.
            // sourceHive/targetHive answer which POT; for a PER-RUN rubric
            // (goal-mode-e2e grades ONE run of ONE agent) nothing said which RUN —
            // so five v1 scorecards were indistinguishable by field, none re-derivable.
            // The shape is the DRILL PARAMETER BINDING, measured across that rubric's
            // 25 criteria: `:subject` (20), `:run_start` (12), `:run_end` (11) and
            // nothing else. Recording exactly those makes a scorecard re-runnable
            // from its own record.
            subject: z
              .object({
                kind: z
                  .enum(['agent-run', 'session', 'work-item', 'plan', 'pot'])
                  .optional()
                  .describe('what `ref` names; omit if you did not classify it'),
                ref: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe(
                    "the graded thing's id — the drills' `:subject` (an ownerId for an agent-run, a session id, a WI-/EI- id, a plan slug, a pot slug)",
                  ),
                windowStart: z
                  .string()
                  .max(40)
                  .optional()
                  .describe("ISO — start of the graded window; the drills' `:run_start`"),
                windowEnd: z
                  .string()
                  .max(40)
                  .optional()
                  .describe("ISO — end of the graded window; the drills' `:run_end`"),
              })
              .strict()
              .optional()
              .describe(
                'WHAT this scorecard grades (a per-RUN rubric needs this to be attributable/re-runnable): { ref, kind?, windowStart?, windowEnd? } — the replication-drill parameter binding. Omit for a pot-level or free-text observation.',
              ),
          })
          // plan-templates-and-rubric-v2 P-012 (strict/fail-loud): reject UNKNOWN observation keys
          // LOUDLY instead of silently STRIPPING them. A silent strip dropped data live (su-2a0b4: an
          // Overwatch scorecard emitted against the not-yet-deployed schema persisted scope-only with no
          // error, corrupting the trend). A schema-evolution / deploy-timing mismatch now surfaces as a
          // named-key validation error at arg-parse instead of vanishing.
          .strict()
          .optional()
          .describe(
            'structured fields for a lane:observation record (the one-line "what" is the title, the optional "why" is the body). Pass rubricRef+ratings (each {rating,evidence}) to file a RUBRIC-GRADED observation — check rubrics:list first to see if a rubric fits.',
          ),
        // ── IDEATE-pass provenance (su-ideate-learning-substrate-2026-07-10 P-002 / D-004:
        // the ONE schema bump — the full shape is declared here so the tool contract never
        // churns again; P-002 stamps `lens` on the ledger row, P-007 persists the whole
        // declared object onto the created item's payload (payload.ideation) for the
        // triage/learning read). Enrichment only, never a gate (D-005): absence changes
        // nothing about the capture.
        ideation: z
          .object({
            lens: z
              .enum([...SU_IDEATION_LENSES] as [SuIdeationLens, ...SuIdeationLens[]])
              .optional()
              .describe(
                "the generative stance that produced this idea — Scout's four creative lenses (analogical / first-principles / reframing / constraint-removal) + the su stances (risk-first = de-risk the riskiest assumption; user-value = backward from felt owner/user value; cost-leverage = small change, big recurring cost). Declaring it earns per-lens outcome feedback on YOUR ideas (P-004); omitted = recorded under the 'su-ideate' sentinel (no per-lens learning)",
              ),
            bet: z
              .string()
              .max(2000)
              .optional()
              .describe(
                'the bet — the concrete upside if the idea pans out (persisted to the created item payload, payload.ideation)',
              ),
            // EI-10607: the GROUNDING leg. Without it the su-ideate rail could not write
            // addresses_pattern_refs at all (no su-reachable verb accepted them — only Scout's
            // internal router did), so observationsImpact.ideasGrounded/shipped were pinned at 0
            // by construction: 122 su ideas, 0 grounded, against Scout's 24/24. The reader and the
            // ledger column had been waiting for a writer since P-021 shipped.
            addressesPatternRefs: z
              .array(z.string().min(1).max(200))
              .max(10)
              .optional()
              .describe(
                "the digest meta-pattern refs this idea GROUNDS ON — the observation→pattern→idea→shipped arc is joined on this field, so an idea filed without it can never show up as grounded in anyone's observationsImpact. You already have the refs: they come back from blender:ideation-feedback as observationsImpact.patterns[].ref (e.g. 'wi:EI-10587'). Pass the pattern(s) your pass actually built on",
              ),
            cheapExperiment: z
              .object({
                hypothesis: z.string().min(1).max(2000).describe('what we believe will be true if the idea has merit'),
                method: z.string().min(1).max(2000).describe('the cheap first test (what to run / build / measure)'),
                falsifiableSignal: z
                  .string()
                  .min(1)
                  .max(2000)
                  .describe('the observable that would prove the hypothesis WRONG'),
              })
              .optional()
              .describe(
                'the cheap falsifiable first experiment (ScoutExperiment shape, D-006 bettable-not-clever; persisted to payload.ideation — a COMPLETE one makes the idea machine-checkably bettable and ranks it first in triage)',
              ),
          })
          .strict()
          .optional()
          .describe(
            "IDEATE-pass provenance for an su session's kind:'feature' origination — stamps the routed-idea ledger row (origin='su-ideate') with your declared lens so grade→outcome→feedback learning attributes back to it. Never a gate: purely additive, ignored for lane:observation / non-feature kinds.",
          ),
      })
      .strict(),
  ),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';
    // Resolve the filer's ROLE for per-role observation attribution (close the
    // ~100%-'unknown' gap, 2026-06-21). The caller is LIVE while it files, so its
    // coord presence carries the FINE self-reported role (overwatch/queen/scout/
    // bee/worker/…) that the server-side deriveAgentRole cannot see (the agent's
    // PAPERCUSP_AGENT_ROLE env is not in THIS process). Fall back to the coarse
    // source-derived role; best-effort — a presence-read miss never blocks a capture.
    const filedByRole =
      (await getPresence(id.ownerId).catch(() => null))?.agentRole ?? deriveAgentRole(id) ?? undefined;
    // Auto-derive sourceHive (rubric-driven-observations D-003) from the caller's
    // hive/harness when omitted: signed-spawn bees carry ctx.harnessSlug; explicit
    // callers (Overwatch/Scout) set observation.sourceHive themselves. '*' (the
    // unscoped session) is not a hive → leave undefined.
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness =
      typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : undefined;
    if (args.observation?.rubricRef && args.rubricRef && args.observation.rubricRef !== args.rubricRef) {
      throw new ObservationEvidenceError(
        'conflicting rubricRef values: pass the scorecard once under observation.rubricRef (preferred) or top-level rubricRef (compatibility alias)',
      );
    }
    if (args.observation?.ratings && args.ratings) {
      throw new ObservationEvidenceError(
        'ratings were supplied twice: pass them once under observation.ratings (preferred) or top-level ratings (compatibility alias)',
      );
    }
    const observationInput =
      args.observation || args.rubricRef || args.ratings
        ? {
            ...args.observation,
            rubricRef: args.observation?.rubricRef ?? args.rubricRef,
            ratings: args.observation?.ratings ?? args.ratings,
          }
        : undefined;
    const observationBase = observationInput
      ? (() => {
          // P-002 notExercised expansion (rubric-system-improvements-2026-07-12):
          // each listed key becomes an idle:-tagged unknown UNLESS explicitly rated;
          // the shorthand key itself is stripped so the stored payload is pure ratings.
          const { notExercised, ...rest } = observationInput;
          const expanded =
            notExercised && notExercised.length > 0
              ? Object.fromEntries(
                  notExercised
                    .filter((k) => !(rest.ratings && k in rest.ratings))
                    .map((k) => [k, { rating: 'unknown', evidence: 'idle: not exercised by this run.' }]),
                )
              : undefined;
          return {
            ...rest,
            ...(expanded && Object.keys(expanded).length > 0 ? { ratings: { ...expanded, ...rest.ratings } } : {}),
            sourceHive: rest.sourceHive ?? ctxHarness,
          };
        })()
      : undefined;
    // EI-12147: stamp the GRADED GENERATION on a rubric scorecard, SERVER-SIDE (no caller
    // change — the observation schema is .strict(), so only this stamp can write it). A
    // long-lived host executes whatever was on disk when it last STARTED, so a scorecard
    // without a generation identity is ambiguous evidence after any restart/deploy: the
    // 2026-07-14 GO stall was graders reconciling verdicts that had silently judged two
    // different generations. Best-effort by construction (both legs degrade to null) —
    // the stamp must never fail the capture it rides on.
    const gradedGeneration =
      observationBase?.rubricRef && observationBase.ratings ? await readRunningGeneration().catch(() => null) : null;
    const observation = observationBase
      ? { ...observationBase, ...(gradedGeneration ? { gradedGeneration } : {}) }
      : undefined;
    // P-007 (su-ideate-learning-substrate): persist the declared IDEATE-pass provenance
    // onto the created item's payload (payload.ideation) so the triage/learning read can
    // surface the bet + experiment and rank machine-checkably bettable ideas first.
    // Same eligibility the contract doc states: a kind:'feature' improvement-lane capture
    // only. Enrichment only (D-005) — absence changes nothing about the capture.
    const ideation =
      args.ideation && args.kind === 'feature' && args.lane !== 'observation'
        ? {
            ...(args.ideation.lens ? { lens: args.ideation.lens } : {}),
            ...(args.ideation.bet ? { bet: args.ideation.bet } : {}),
            ...(args.ideation.cheapExperiment ? { cheapExperiment: args.ideation.cheapExperiment } : {}),
          }
        : undefined;
    const hasIdeation = !!ideation && Object.keys(ideation).length > 0;
    // EI-10943: truncate-and-warn. The capture always lands; the agent is TOLD what
    // was trimmed rather than losing the finding to a validation bounce.
    const foundDuring = clampText(args.foundDuring, LIMITS.LABEL);
    const foundDuringTruncated = typeof args.foundDuring === 'string' && args.foundDuring.length > LIMITS.LABEL;
    const normalizedToolFailure = args.toolFailure
      ? normalizeSuspectedToolFailure(args.toolFailure as SuspectedToolFailure)
      : undefined;
    const toolFailureKind: 'bug' | 'change' | undefined = normalizedToolFailure
      ? args.toolFailure?.clearServerMismatch || args.toolFailure?.hardInternal
        ? 'bug'
        : normalizedToolFailure.class === 'caller' || normalizedToolFailure.class === 'rate-limit'
          ? 'change'
          : 'bug'
      : undefined;
    const effectiveKind = toolFailureKind ?? args.kind ?? 'change';
    const effectiveLane = normalizedToolFailure && !normalizedToolFailure.direct ? 'observation' : args.lane;
    const toolFailureProbation = normalizedToolFailure
      ? {
          state: normalizedToolFailure.direct ? ('promoted' as const) : ('probation' as const),
          class: normalizedToolFailure.class,
          watchdogKey: normalizedToolFailure.watchdogKey,
          correlationFingerprint: normalizedToolFailure.correlationFingerprint,
          messageFingerprint: normalizedToolFailure.messageFingerprint,
          intendedKind: toolFailureKind,
          reporters: [id.ownerId],
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          report: args.toolFailure,
          ...(normalizedToolFailure.direct ? { directEvidence: true } : {}),
        }
      : undefined;
    try {
      const result = await captureImprovement({
        title: args.title,
        kind: effectiveKind,
        body: args.body,
        severity: args.severity as IssueSeverity | undefined,
        subTopic: args.subTopic,
        scope: args.scope,
        foundDuring,
        paths: args.paths,
        force: args.force,
        checkDuplicatesOnly: args.checkDuplicatesOnly,
        origin: args.origin,
        lane: effectiveLane,
        watchdogKey:
          normalizedToolFailure
            ? normalizedToolFailure.watchdogKey
            : effectiveLane === 'observation'
            ? (args.conditionKey ?? defaultScorecardConditionKey(observation))
            : undefined,
        payloadExtra:
          observation || hasIdeation || toolFailureProbation
            ? {
                ...(observation ? { observation } : {}),
                ...(hasIdeation ? { ideation } : {}),
                ...(toolFailureProbation ? { toolFailureProbation } : {}),
              }
            : undefined,
        createdBy: id.ownerId,
        // WI-5950: resolve the 'self' literal here (same seam work_items:create uses) so the
        // core always receives a concrete ownerId and never has to know about caller identity.
        assignee: resolveSelfLiteral(args.assign_to, id.ownerId),
        filedByRole,
        source,
      });
      // Directed @-mention — only when we actually CREATED a claimable item (not a
      // dedup-decline / checkDuplicatesOnly / observation-lane reflection).
      const captured = result as { created?: boolean; issue?: { id: string; title?: string } };
      // su-loop-capability-parity P-005 (D-009): an SU session's IDEATE-pass FEATURE origination
      // earns a routed-ledger provenance row (origin='su-ideate') so it rides the SAME
      // grade/outcome/priming machinery Scout's ideas do — WITHOUT skewing Scout's per-lens
      // weight learning (the lens readers filter origin='scout'). Fires only for an su caller's
      // freshly-created kind:'feature' (not the watchdog, not an observation, not a dedup-decline).
      // Fully guarded + best-effort: a ledger hiccup must NEVER fail the capture the user asked for.
      if (
        source === 'su' &&
        args.kind === 'feature' &&
        args.lane !== 'observation' &&
        captured.created &&
        captured.issue?.id
      ) {
        const featureId = captured.issue.id;
        const ledgerHarness =
          ctxHarness ?? (args.scope?.startsWith('harness:') ? args.scope.slice('harness:'.length) : 'papercusp');
        try {
          await recordRoutedIdea({
            origin: 'su-ideate',
            createdBy: id.ownerId, // originator join key: grade→revise wakes + scope:'mine' reads (migration 558)
            ideaId: featureId,
            // P-002: the caller-declared su ideation lens, else the 'su-ideate' sentinel. Either
            // way the row is origin-partitioned OUT of Scout's lens learning (D-009 / D-002).
            lens: args.ideation?.lens ?? 'su-ideate',
            rail: 'improvement',
            routedRef: `wi:${featureId}`,
            harnessSlug: ledgerHarness,
            title: captured.issue.title ?? args.title,
            // EI-10607: the pattern refs this idea grounds on — the ONE field that lets an
            // su idea appear as `grounded` in observationsImpact. Omitted when the caller
            // declared none, so the row shape is unchanged for an ungrounded filing.
            ...(args.ideation?.addressesPatternRefs?.length
              ? { addressesPatternRefs: [...args.ideation.addressesPatternRefs] }
              : {}),
          });
        } catch {
          // best-effort provenance — never affects the capture the user requested
        }
      }
      // WI-3594 (scorecard→improvement flow): link a freshly-filed GRADE filing to
      // its named follow-up work-items AT FILE TIME, so a scorecard's motivating
      // improvement is never a separate round-trip someone forgets to make. Fires
      // only when the caller passed observation.linkTo AND an item was actually
      // created (not a dedup-decline). Best-effort per target: one bad targetId
      // never fails the capture, and a partial failure is reported (not silent).
      let linked: { targetId: string; ok: boolean; error?: string }[] | undefined;
      if (observation?.linkTo?.length && captured.created && captured.issue?.id) {
        const sourceId = captured.issue.id;
        linked = await Promise.all(
          observation.linkTo.map(async (l) => {
            try {
              const dst = await resolveWorkItemRef(l.targetId, l.targetHarness);
              if (!dst) return { targetId: l.targetId, ok: false, error: `work_item '${l.targetId}' not found` };
              await linkIssue(sourceId, dst, l.rel ?? 'relates', id.ownerId);
              return { targetId: l.targetId, ok: true };
            } catch (e) {
              return { targetId: l.targetId, ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }),
        );
      }
      // P-008 (su-ideate-learning-substrate): REPORT-ONLY novelty pre-check on the su
      // IDEATE-pass feature path — the same eligibility as the ledger row, but independent
      // of creation (a dedup-decline / checkDuplicatesOnly response benefits too). Surfaces
      // the priors the title collides with (plans / decisions / routed-ledger ideas, incl.
      // already-decided "tried, failed" ones) as response.priorArt. NEVER a gate (D-005):
      // only the improvement-dedup above may decline; a failed check just omits the field
      // (absent = not checked; [] = checked, nothing similar).
      const priorArtRaw =
        source === 'su' && args.kind === 'feature' && args.lane !== 'observation'
          ? await noveltyPriorArt(args.title).catch(() => undefined)
          : undefined;
      // The su-ideate ledger bridge above inserts THIS filing's own row (wi:<id>)
      // BEFORE this read, so the corpus contains the filing itself — a similarity-1.0
      // self-match is not prior art (it reads as a false "already tried"). Filter it
      // (audit find 2026-07-11, first surfaced on the EI-9694 filing). [] semantics
      // preserved: checked-nothing-similar.
      const selfId = captured.issue?.id;
      const priorArt = selfId ? priorArtRaw?.filter((p) => p.ref !== `wi:${selfId}` && p.ref !== selfId) : priorArtRaw;
      const notified =
        args.notifyAgents?.length && captured.created && captured.issue?.id && effectiveLane !== 'observation'
          ? await notifyAgents(id, {
              addressees: args.notifyAgents,
              objectRef: issueRef(captured.issue.id),
              summary: `🔖 ${id.ownerLabel} tagged you on ${captured.issue.id}: ${(captured.issue.title ?? args.title).slice(0, 80)}`,
              body:
                `${id.ownerLabel} tagged you on improvement ${captured.issue.id}: ${captured.issue.title ?? args.title}` +
                (args.body ? `\n\n${args.body.slice(0, 600)}` : '') +
                `\n\n— it's on your radar: work_items:get ${captured.issue.id} (comment / claim there).`,
              harnessSlug: args.scope?.startsWith('harness:') ? args.scope.slice('harness:'.length) : undefined,
            }).catch(() => null)
          : null;
      // P-007/D-010: report-only cheapExperiment gap (see describeExperimentGap above).
      // Computed from the CALLER's args, so a dedup-decline / checkDuplicatesOnly response
      // carries it too — the filer is told before they re-file, not after.
      const experimentGap = describeExperimentGap(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
              ...(priorArt ? { priorArt } : {}),
              ...(experimentGap ? { experimentGap } : {}),
              ...(notified ? { notified: notified.notified } : {}),
              ...(linked ? { linked } : {}),
              ...(foundDuringTruncated
                ? {
                    warnings: [
                      `foundDuring was ${args.foundDuring!.length} chars — truncated to ${LIMITS.LABEL}. ` +
                        'It is a short provenance label, not a body; put the detail in `body`.',
                    ],
                  }
                : {}),
            }),
          },
        ],
      };
    } catch (err) {
      // Surface a rubric-rating contract violation (missing evidence / rubricRef)
      // as a clean tool error instead of an opaque throw (D-002 evidence gate).
      if (err instanceof ObservationEvidenceError) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err.message }) }] };
      }
      throw err;
    }
  },
});
