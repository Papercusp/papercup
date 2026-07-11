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
import { resolveAgentIdentity, deriveAgentRole } from '../coordination/identity';
import { getPresence } from '../coordination/presence';
import { COORD_ROLES } from '../coordination/roles';
import { notifyAgents } from '../coordination/notify-agents';
import { issueRef, linkIssue, type IssueSeverity } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { ObservationEvidenceError } from '../../harness/improvements/observation-types';
import { noveltyPriorArt } from '../../scout/novelty-precheck';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';
import { resolveWorkItemRef } from '../../work-items';
import { hardText, LIMITS } from '../limits';
import { coerceCaptureKind } from './capture-coerce';

export default defineTool({
  name: 'improvements:capture',
  profile: 'engineer',
  description:
    'Capture a papercusp improvement you discovered (a friction, a missing affordance, a tooling bug) as a durable, claimable, `papercusp-improvement`-tagged work-unit. kind=bug → auto-implement-eligible; change|feature → human-reviewed. Search-first: declines an obvious duplicate (link instead) unless force. An su kind=feature filing also gets a REPORT-ONLY novelty pre-check (`priorArt[]`, incl. already-tried-and-failed priors) — never blocks. Pass `paths` (files involved) to feed the protected-path gate. lane:"observation" files a turn-end PRE-IDEA into a separate lane that NEVER enters the work queue (Scout-digest + Observations pane only).',
  guidance: {
    when: 'You hit a papercusp DX / tooling / code friction worth fixing but out of your current scope — file it so it lands in the triage backlog instead of being lost. Pick `kind` per its arg note. Include `paths` (repo-relative files) when known — the auto-implement risk gate reads them.',
    notWhen: 'A problem in a MANAGED harness/project (not papercusp itself) — that is work_items:create with that harness scope. Something needing real design — write a plan (plans:new) and capture with kind=feature linking it. A passing question — coord:ask.',
    chaining: 'improvements:capture { kind, title, paths? } → improvements:digest triages it → an agent claims + fixes it, or the auto-implement loop picks up bugs and improvements:resolve closes them.',
    seeAlso: [
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
  args: z.preprocess(
    coerceCaptureKind,
    z.object({
    title: hardText(LIMITS.SHORT_TITLE).describe('one-line summary (do NOT include a [kind] prefix — pass kind separately)'),
    kind: z.enum(['bug', 'change', 'feature']).optional().describe('bug = something broken (auto-eligible); change = a desired improvement; feature = net-new (both human-gated). Required for an improvement; ignored for lane:observation (always stored as a non-bug nit). Default change.'),
    body: hardText(LIMITS.CONTENT).optional().describe('repro / context / the correct-state, especially for a bug'),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
    subTopic: z.string().min(1).max(40).optional().describe('optional sub-area topic, e.g. coord-dx, db-tooling'),
    scope: z.string().max(80).optional().describe("'operator' (default) or 'harness:<slug>'"),
    foundDuring: z.string().max(120).optional(),
    paths: z.array(z.string().min(1).max(300)).max(20).optional().describe('repo-relative file paths the improvement touches, when known — feeds the protected-path gate'),
    notifyAgents: z
      .array(z.string().min(1))
      .max(8)
      .optional()
      .describe(
        "@-mention SPECIFIC agents: ownerId prefixes / handles (resolve via coord:presence). Each is SUBSCRIBED to the captured item (gets every future update) AND pinged now, pointing at it — a DIRECTED handoff to a known owner. Distinct from the auto-topic broadcast (which reaches whoever subscribed to the area) and from claiming. Ignored for lane:observation. Use when you know exactly who should see/own this.",
      ),
    force: z.boolean().optional().describe('file even if a likely duplicate exists (default false → search-first declines)'),
    checkDuplicatesOnly: z.boolean().optional().describe('only run the dedup search, do not create'),
    origin: z.enum(['organic', 'drill', 'replay', 'shadow']).optional().describe('signal provenance (frontier P-002) — default organic. ONLY a frontier loop passes non-organic (vaccination drill, replay counterfactual, shadow ablation); synthetic rows stay out of organic learners'),
    lane: z.enum(['improvement', 'observation']).optional().describe("'observation' files a PRE-IDEA turn-end reflection into the SEPARATE observation lane (D-005) — it never enters the work queue/triage/auto-implement; only Blender's corpus-digest + the Observations pane read it. Default 'improvement'."),
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
        sourceHive: z.string().max(120).optional().describe('the pot the observation came FROM — AUTO-DERIVED from ctx (the agent harness/pot) when omitted; explicit callers (Kettle/Blender) may set it'),
        targetHive: z.string().max(120).optional().describe('optional: the pot the observation is ABOUT (a cross-pot observation)'),
        rubricRef: z.string().max(120).optional().describe("a rubrics.rubric_id this observation grades against (e.g. 'pot-coordination-health'). Present ⇒ a rubric-graded observation; ratings must accompany it"),
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
        // WI-3594 (scorecard→improvement flow): a GRADE filing (rubricRef+ratings) often
        // identifies a concrete follow-up — link it AT FILE TIME instead of a separate
        // work_items:link round-trip later (which is easy to forget, silently orphaning the
        // scorecard from the work it motivated). Surfaced in ScorecardDetail's UI (scorecards.list
        // linkedItems). Optional — a scorecard with nothing concrete to link stays unlinked.
        linkTo: z
          .array(
            z.object({
              targetId: z.string().min(1).max(120).describe('the work-item id (WI-/F-/EI-…) this scorecard relates to'),
              rel: z.enum(['relates', 'blocks', 'duplicates', 'fixes']).optional().describe("default 'relates'"),
              targetHarness: z.string().max(80).optional().describe('harness for a feature targetId (disambiguation)'),
            }),
          )
          .max(5)
          .optional()
          .describe('link this GRADE filing to one or more existing work-items at file time (e.g. the improvement this rating is about) — best-effort, never fails the capture'),
      })
      // plan-templates-and-rubric-v2 P-012 (strict/fail-loud): reject UNKNOWN observation keys
      // LOUDLY instead of silently STRIPPING them. A silent strip dropped data live (su-2a0b4: an
      // Overwatch scorecard emitted against the not-yet-deployed schema persisted scope-only with no
      // error, corrupting the trend). A schema-evolution / deploy-timing mismatch now surfaces as a
      // named-key validation error at arg-parse instead of vanishing.
      .strict()
      .optional()
      .describe('structured fields for a lane:observation record (the one-line "what" is the title, the optional "why" is the body). Pass rubricRef+ratings (each {rating,evidence}) to file a RUBRIC-GRADED observation — check rubrics:list first to see if a rubric fits.'),
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
        bet: z.string().max(2000).optional().describe('the bet — the concrete upside if the idea pans out (persisted to the created item payload, payload.ideation)'),
        cheapExperiment: z
          .object({
            hypothesis: z.string().min(1).max(2000).describe('what we believe will be true if the idea has merit'),
            method: z.string().min(1).max(2000).describe('the cheap first test (what to run / build / measure)'),
            falsifiableSignal: z.string().min(1).max(2000).describe('the observable that would prove the hypothesis WRONG'),
          })
          .optional()
          .describe('the cheap falsifiable first experiment (ScoutExperiment shape, D-006 bettable-not-clever; persisted to payload.ideation — a COMPLETE one makes the idea machine-checkably bettable and ranks it first in triage)'),
      })
      .strict()
      .optional()
      .describe(
        "IDEATE-pass provenance for an su session's kind:'feature' origination — stamps the routed-idea ledger row (origin='su-ideate') with your declared lens so grade→outcome→feedback learning attributes back to it. Never a gate: purely additive, ignored for lane:observation / non-feature kinds.",
      ),
    }),
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
    const observation = args.observation
      ? { ...args.observation, sourceHive: args.observation.sourceHive ?? ctxHarness }
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
        payloadExtra:
          observation || hasIdeation
            ? { ...(observation ? { observation } : {}), ...(hasIdeation ? { ideation } : {}) }
            : undefined,
        createdBy: id.ownerId,
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
      if (source === 'su' && args.kind === 'feature' && args.lane !== 'observation' && captured.created && captured.issue?.id) {
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
      const priorArt =
        source === 'su' && args.kind === 'feature' && args.lane !== 'observation'
          ? await noveltyPriorArt(args.title).catch(() => undefined)
          : undefined;
      const notified =
        args.notifyAgents?.length && captured.created && captured.issue?.id && args.lane !== 'observation'
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
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
              ...(priorArt ? { priorArt } : {}),
              ...(notified ? { notified: notified.notified } : {}),
              ...(linked ? { linked } : {}),
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
