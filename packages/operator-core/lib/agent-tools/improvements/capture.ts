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
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import type { IssueSeverity } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { ObservationEvidenceError } from '../../harness/improvements/observation-types';

export default defineTool({
  name: 'improvements:capture',
  profile: 'engineer',
  description:
    'Capture a papercusp improvement you discovered (a friction, a missing affordance, a bug in the tooling) as a durable, claimable, `papercusp-improvement`-tagged work-unit. kind=bug → auto-implement-eligible later; change|feature → human-reviewed. Search-first: declines an obvious duplicate (link to it instead) unless force. Pass `paths` when you know the files involved — it feeds the protected-path safety gate. Pass lane:"observation" for a turn-end-reflection PRE-IDEA — it files into a separate lane that NEVER enters the work queue (Scout-digest + the Observations pane only).',
  guidance: {
    when: 'You hit a papercusp DX / tooling / code friction worth fixing but out of your current scope. File it here so it lands in the triage backlog instead of being lost. Use kind=bug for something broken, kind=change for a desired improvement, kind=feature for net-new (the last two stay human-gated). Include `paths` (repo-relative files involved) when known — the auto-implement risk gate reads them.',
    notWhen: 'A problem in a MANAGED harness/project (not papercusp itself) — that is issues:create with that harness scope. Something needing real design — write a plan (plans:new) and capture with kind=feature linking it. A passing question — coord:ask.',
    chaining: 'improvements:capture { kind, title, paths? } → (later) improvements:digest triages it → an agent claims + fixes it self/inline, or the auto-implement loop picks up the bugs and improvements:resolve closes them.',
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
  args: z.object({
    title: z.string().min(1).max(180).describe('one-line summary (do NOT include a [kind] prefix — pass kind separately)'),
    kind: z.enum(['bug', 'change', 'feature']).optional().describe('bug = something broken (auto-eligible); change = a desired improvement; feature = net-new (both human-gated). Required for an improvement; ignored for lane:observation (always stored as a non-bug nit). Default change.'),
    body: z.string().max(8000).optional().describe('repro / context / the correct-state, especially for a bug'),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
    subTopic: z.string().min(1).max(40).optional().describe('optional sub-area topic, e.g. coord-dx, db-tooling'),
    scope: z.string().max(80).optional().describe("'operator' (default) or 'harness:<slug>'"),
    foundDuring: z.string().max(120).optional(),
    paths: z.array(z.string().min(1).max(300)).max(20).optional().describe('repo-relative file paths the improvement touches, when known — feeds the protected-path gate'),
    force: z.boolean().optional().describe('file even if a likely duplicate exists (default false → search-first declines)'),
    checkDuplicatesOnly: z.boolean().optional().describe('only run the dedup search, do not create'),
    origin: z.enum(['organic', 'drill', 'replay', 'shadow']).optional().describe('signal provenance (frontier P-002) — default organic. ONLY a frontier loop passes non-organic (vaccination drill, replay counterfactual, shadow ablation); synthetic rows stay out of organic learners'),
    lane: z.enum(['improvement', 'observation']).optional().describe("'observation' files a PRE-IDEA turn-end reflection into the SEPARATE observation lane (D-005) — it never enters the work queue/triage/auto-implement; only Scout's corpus-digest + the Observations pane read it. Default 'improvement'."),
    observation: z
      .object({
        kind: z.enum(['friction', 'workaround', 'gap', 'surprise', 'reinforce']).optional(),
        scope: z.enum(['self', 'role', 'harness', 'papercusp']).optional(),
        confidence: z.enum(['low', 'med', 'high']).optional(),
        refs: z.array(z.string().max(200)).max(12).optional().describe('attribution: tool:/file:/WI- refs grounding the observation'),
        // ── Structured-observation v2 (rubric-driven-observations-2026-06-20 P-001 / D-003).
        // Converges the source-hive tag (workspace-scoped-coordination P-001) + rubric
        // grading (this plan) into ONE coherent extension. All optional — free-text
        // observations stay first-class.
        sourceHive: z.string().max(120).optional().describe('the hive the observation came FROM — AUTO-DERIVED from ctx (the agent harness/hive) when omitted; explicit callers (Overwatch/Scout) may set it'),
        targetHive: z.string().max(120).optional().describe('optional: the hive the observation is ABOUT (a cross-hive observation)'),
        rubricRef: z.string().max(120).optional().describe("a rubrics.rubric_id this observation grades against (e.g. 'hive-coordination-health'). Present ⇒ a rubric-graded observation; ratings must accompany it"),
        ratings: z
          .record(
            z.string().min(1),
            z.object({
              rating: z.string().min(1).describe("a value from the criterion's ratingScale — default ['healthy','degraded','broken','unknown'] ('unknown' = not-assessable this wake)"),
              evidence: z.string().min(1).describe('MANDATORY concrete evidence backing the rating — a metric, a query result, a reference (a rating without evidence is rejected)'),
            }),
          )
          .optional()
          .describe('per-criterion ratings against rubricRef, KEYED by rubric criterion `key` (a scorecard: one rating per criterion). evidence is mandatory on every entry'),
      })
      // plan-templates-and-rubric-v2 P-012 (strict/fail-loud): reject UNKNOWN observation keys
      // LOUDLY instead of silently STRIPPING them. A silent strip dropped data live (su-2a0b4: an
      // Overwatch scorecard emitted against the not-yet-deployed schema persisted scope-only with no
      // error, corrupting the trend). A schema-evolution / deploy-timing mismatch now surfaces as a
      // named-key validation error at arg-parse instead of vanishing.
      .strict()
      .optional()
      .describe('structured fields for a lane:observation record (the one-line "what" is the title, the optional "why" is the body). Pass rubricRef+ratings (each {rating,evidence}) to file a RUBRIC-GRADED observation — check rubrics:list first to see if a rubric fits.'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';
    // Auto-derive sourceHive (rubric-driven-observations D-003) from the caller's
    // hive/harness when omitted: signed-spawn bees carry ctx.harnessSlug; explicit
    // callers (Overwatch/Scout) set observation.sourceHive themselves. '*' (the
    // unscoped session) is not a hive → leave undefined.
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness =
      typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : undefined;
    const observation = args.observation
      ? { ...args.observation, sourceHive: args.observation.sourceHive ?? ctxHarness }
      : undefined;
    try {
      const result = await captureImprovement({
        title: args.title,
        kind: args.kind ?? 'change',
        body: args.body,
        severity: args.severity as IssueSeverity | undefined,
        subTopic: args.subTopic,
        scope: args.scope,
        foundDuring: args.foundDuring,
        paths: args.paths,
        force: args.force,
        checkDuplicatesOnly: args.checkDuplicatesOnly,
        origin: args.origin,
        lane: args.lane,
        payloadExtra: observation ? { observation } : undefined,
        createdBy: id.ownerId,
        source,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
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
