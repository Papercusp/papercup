/**
 * gym:signals — evaluate a target blueprint's declared `gym.signals` (the
 * deterministic, un-gameable guardrails — D-011) over one run's inputs.
 *
 * The gym is a blueprint now (D-022); its judge/proposer roles resolve a target's
 * signals BY NAME through the host-side registry (`GYM_SIGNAL_REGISTRY`). This tool
 * is that resolution exposed to a role: pass the signal names + whatever run inputs
 * you have (pre/post tests, the planted bug, the harness output text) and get back
 * each guardrail's boolean — with unknown/inapplicable signals reported, never
 * silently dropped.
 *
 * harness-blueprint-orchestration-2026-06-03 P-012 / D-022. Pure — no LLM, no PG.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { evaluateSignals, knownSignals, type SignalContext } from '../../gym/primitives';

const testResult = z.object({ name: z.string(), passed: z.boolean() });

// Mirrors the red-queen v1 DrillOutcome contract (lib/gym/drill-signals.ts) — the
// drill-ground-truth judging inputs (FB-23 / P-048).
const drillOutcome = z.object({
  drillId: z.string(),
  drillClass: z.string(),
  collectorFamily: z.string(),
  plantedAt: z.string(),
  detectedAt: z.string().nullish(),
  triagedAt: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  expectedWatchdogKey: z.string(),
  expectedKind: z.enum(['bug', 'change']),
  expectedSeverity: z.string(),
  expectedDecision: z.enum(['place', 'gate', 'gym', 'reject']).nullish(),
  detectedWatchdogKey: z.string().nullish(),
  detectedKind: z.string().nullish(),
  triagedDecision: z.string().nullish(),
  triagedIdeaType: z.string().nullish(),
  resolvedWithEvidence: z.boolean(),
  issueId: z.string().nullish(),
  mttsh: z
    .object({
      detectMs: z.number().optional(),
      triageMs: z.number().optional(),
      fixMs: z.number().optional(),
      totalMs: z.number().optional(),
    })
    .nullish(),
  leakCheckPassed: z.boolean().nullish(),
  status: z.enum(['planted', 'detected', 'triaged', 'resolved', 'failed', 'expired']),
  origin: z.literal('drill'),
});

export default defineTool({
  name: 'gym:signals',
  description:
    "Evaluate a target blueprint's deterministic gym signals (un-gameable guardrails) over one run's inputs. Pass `signals` (names from the target's blueprint.gym.signals) + any of {preTests, postTests, plantedBug, harnessOutputText, drillOutcomes}. Returns {results:[{name,value,applicable,metric?}], unknown, known}. Built-ins: regressionsFromTests (needs pre+post tests), plantedBugCaught (needs plantedBug+harnessOutputText), drillResolveRate / drillTriageAccuracy / drillMttsh (need drillOutcomes — red-queen drill rows with planted known answers; value = SLO verdict, metric = the raw rate/ms).",
  guidance: {
    when: "Scoring a gym run's deterministic guardrails — the optimizer cannot game these, so they gate/monitor a variant independently of the judge. Resolve the TARGET blueprint's declared gym.signals by name.",
    notWhen: 'Subjective quality scoring — that is the frozen judge (gym:judge). Running the pipeline — the gym runner.',
    chaining: 'gym runner → collect run inputs (tests/output) → gym:signals → feed results into the proposer + the trace summary.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  // D-002 (bee-capability-expansion-2026-06-08): gym signals are a Queen-only
  // optimization surface — the worker-bee (a COORD_ROLE since local-hive P-011) is
  // EXCLUDED so [...COORD_ROLES] doesn't leak it. Other coord roles are unchanged.
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee' && r !== 'sentinel'),
  args: z.object({
    signals: z.array(z.string()).min(1).describe("Signal names from the target blueprint's gym.signals"),
    preTests: z.array(testResult).optional().describe("The repo's own tests run BEFORE the change"),
    postTests: z.array(testResult).optional().describe("The repo's own tests run AFTER the change"),
    plantedBug: z
      .object({ location: z.string(), defect: z.string().optional(), detectionSignature: z.string().optional() })
      .optional()
      .describe('The defect planted in the task (for plantedBugCaught)'),
    harnessOutputText: z.string().optional().describe("The harness's produced output (verdicts, filed issues)"),
    drillOutcomes: z
      .array(drillOutcome)
      .optional()
      .describe('Red-queen drill outcomes (planted known answers) for the drill-ground-truth signals'),
  }),
  async handler(args) {
    const ctx: SignalContext = {
      preTests: args.preTests,
      postTests: args.postTests,
      plantedBug: args.plantedBug
        ? { location: args.plantedBug.location, defect: args.plantedBug.defect ?? '', detectionSignature: args.plantedBug.detectionSignature ?? '' }
        : null,
      harnessOutputText: args.harnessOutputText,
      drillOutcomes: args.drillOutcomes,
    };
    const { results, unknown } = evaluateSignals(args.signals, ctx);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: unknown.length === 0, results, unknown, known: knownSignals() }) }],
    };
  },
});
