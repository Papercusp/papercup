/**
 * blender:ideation-feedback — the SU IDEATE-pass read of "your own past graded proposals".
 *
 * su-loop-capability-parity-2026-07-03 P-005 (D-009): SU sessions ORIGINATE feature ideas
 * (improvements:capture kind:'feature'), which now earn `origin='su-ideate'` rows on the routed
 * ledger. This returns the owner/Queen grades + critiques on those su-ideate ideas as the SAME
 * grader-feedback PRIMING block Scout's own ideators consume (reuses formatGraderFeedbackPriming
 * via gatherGraderFeedbackPriming) — so an IDEATE pass builds on what landed and what the grader
 * flagged, instead of a cold start.
 *
 * su-ideate-learning-substrate-2026-07-10 P-003 adds the OUTCOME readback: every su-ideate
 * filing joined to its routed artifact's fate — `outcomes[]` (won / lost / pending via
 * classifyIdeaOutcome over the loss-augmented change feed: resolved wi ⇒ won, deprecated wi ⇒
 * lost, open wi ⇒ pending) + a `summary` roll-up — so the pass sees not just what the grader
 * SAID but what actually SHIPPED. Read-only, origin-scoped to 'su-ideate', so it NEVER touches
 * Scout's per-lens weight learning (which reads origin='scout').
 *
 * P-004 adds `lensWinRates[]`: the same outcome data tallied per {@link SuIdeationLens}
 * (grade-dominated like Scout's weight math), with an anti-strangle sampling weight
 * (samplingWeightsWithFloor) baked in — computed at READ TIME on every call, never written
 * to scout_lens_weights (D-003). Sentinel ('su-ideate'-lens / unlensed) filings appear in
 * `outcomes`/`summary` but in no lens row.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { ChangeFeedEntry } from '../../curation/change-feed';
import { gatherGraderFeedbackPriming } from '../../scout/ideator-feedback-priming';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  samplingWeightsWithFloor,
  type IdeaOutcome,
  type RoutedIdeaProvenance,
} from '../../scout/outcome-feedback';
import { buildScoutOutcomeReaders } from '../../scout/routed-ledger';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';

/** One su-ideate filing joined to its routed artifact's fate (P-003). */
export interface IdeationOutcomeEntry {
  ideaId: string;
  title?: string;
  rail: RoutedIdeaProvenance['rail'];
  routedRef: string;
  /** Grade-blind change-feed classification (D-002) — grades ride alongside. */
  outcome: IdeaOutcome;
  humanGrade?: number;
  gradedBy?: RoutedIdeaProvenance['gradedBy'];
}

/**
 * One su lens's win-rate row (P-004) — read-time only, never persisted (D-003).
 * `won`/`lost` are MASS, fractional when grades exist (a grade dominates the
 * change-feed outcome as winCredit, exactly like Scout's weight tally).
 */
export interface SuLensWinRate {
  lens: SuIdeationLens;
  /** su-ideate filings declared under this lens (sentinel/unlensed rows appear in no lens row). */
  ideas: number;
  won: number;
  lost: number;
  pending: number;
  /** won / (won + lost) over decided mass; null when nothing decided yet. */
  winRate: number | null;
  /** Sampling share over SU_IDEATION_LENSES with the anti-strangle floor baked in — sums to 1. */
  weight: number;
}

export interface IdeationFeedbackResult {
  priming: string;
  entries: string[];
  count: number;
  /** Newest-first, one per su-ideate ledger row (P-003). */
  outcomes: IdeationOutcomeEntry[];
  summary: { won: number; lost: number; pending: number; graded: number; total: number };
  /** Per-su-lens win-rates + floored sampling weights, SU_IDEATION_LENSES order (P-004). */
  lensWinRates: SuLensWinRate[];
  /** Present only when the outcome leg failed — the priming leg still returns (fail-open, D-016). */
  outcomesError?: string;
}

const NO_GRADES_FALLBACK =
  'No graded su-ideate proposals yet — file features (improvements:capture kind:"feature") and they appear here once the owner/Queen grades them.';

/** The testable core: priming + outcome readback composed over the su-ideate ledger scope. */
export async function runIdeationFeedback(args: {
  harness?: string;
  maxEntries?: number;
}): Promise<IdeationFeedbackResult> {
  const scope = args.harness ? { harnessSlug: args.harness } : {};
  const { priming, entries } = await gatherGraderFeedbackPriming({
    origin: 'su-ideate',
    ...scope,
    ...(args.maxEntries ? { maxEntries: args.maxEntries } : {}),
  });

  let outcomes: IdeationOutcomeEntry[] = [];
  const summary = { won: 0, lost: 0, pending: 0, graded: 0, total: 0 };
  let lensWinRates: SuLensWinRate[] = [];
  let outcomesError: string | undefined;
  try {
    const readers = buildScoutOutcomeReaders({ origin: 'su-ideate', ...scope });
    const [provenance, completions] = await Promise.all([
      readers.routedIdeas(),
      readers.completions(),
    ]);
    const byRef = new Map<string, ChangeFeedEntry>();
    for (const e of completions) {
      // First-wins matches gatherCompletions' dedup; refs are unique per artifact.
      if (!byRef.has(e.ref)) byRef.set(e.ref, e);
    }
    outcomes = provenance.map((p) => ({
      ideaId: p.ideaId,
      ...(p.title ? { title: p.title } : {}),
      rail: p.rail,
      routedRef: p.routedRef,
      outcome: classifyIdeaOutcome(p, byRef),
      ...(p.humanGrade != null ? { humanGrade: p.humanGrade } : {}),
      ...(p.gradedBy ? { gradedBy: p.gradedBy } : {}),
    }));
    summary.total = outcomes.length;
    for (const o of outcomes) {
      summary[o.outcome] += 1;
      if (o.humanGrade != null) summary.graded += 1;
    }

    // P-004: per-su-lens win-rates, READ-TIME only (D-003 — no scout_lens_weights
    // write; Scout's persist→read-back floor becomes a same-call floor here).
    // Grade-dominated tally (a graded filing counts as fractional win/loss mass),
    // sentinel/unlensed rows land in no lens row but stay in the report total.
    const report = computeLensOutcomes(provenance, completions, { lenses: SU_IDEATION_LENSES });
    const floored = samplingWeightsWithFloor(
      Object.fromEntries(
        SU_IDEATION_LENSES.map((l) => [l, report.byLens[l].weight]),
      ) as Partial<Record<SuIdeationLens, number>>,
      { lenses: SU_IDEATION_LENSES },
    );
    lensWinRates = SU_IDEATION_LENSES.map((l) => {
      const s = report.byLens[l];
      return {
        lens: l,
        ideas: s.routed,
        won: s.won,
        lost: s.lost,
        pending: s.pending,
        winRate: s.winRate,
        weight: floored[l],
      };
    });
  } catch (err) {
    // Fail-open (D-016): a broken outcome join degrades to the pre-P-003
    // priming-only read instead of failing the whole grounding pre-pass.
    outcomesError = err instanceof Error ? err.message : String(err);
  }

  return {
    priming: priming || NO_GRADES_FALLBACK,
    entries,
    count: entries.length,
    outcomes,
    summary,
    lensWinRates,
    ...(outcomesError ? { outcomesError } : {}),
  };
}

export default defineTool({
  name: 'blender:ideation-feedback',
  description:
    "Your IDEATE-pass read of your OWN past proposals: the owner/Mug grades + critiques on features you filed (improvements:capture kind:'feature') as a grader-feedback priming block, PLUS each filing's real-world outcome (outcomes[]: won / lost / pending from the routed artifact's fate — resolved ⇒ won, deprecated ⇒ lost) with a summary roll-up, PLUS lensWinRates[] — per-ideation-lens win-rates with a floored sampling weight, so you can lean into the stances that land without abandoning the rest. Read-only; su-ideate origin only — never touches Blender's lens-weight learning.",
  capability: 'curation:read',
  guidance: {
    when: 'Opening an IDEATE-mode grounding pre-pass — pull this to see how your past feature proposals were graded AND how they actually fared (shipped, deprecated, still pending), so the pass builds on what landed / what the grader flagged rather than starting cold. Pairs with curation:state-of-pot + rubrics:list + scorecards:freshness as the IDEATE grounding reads.',
    notWhen:
      "Grading an idea — that is blender:grade-idea. Reading Blender's OWN lens-routed ideas or lens weights — a different, lens-learning surface; this returns your su-ORIGINATED ideas only.",
    chaining:
      'curation:state-of-pot + rubrics:list + scorecards:freshness + blender:ideation-feedback → your IDEATE pass, grounded.',
    seeAlso: [
      'blender:grade-idea (record a grade on a routed idea)',
      'improvements:capture (file a kind:"feature" — it becomes a su-ideate ledger row)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('scope to one harness (default: the whole workspace)'),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('priming window size (default 10, newest-first)'),
  }),
  async handler(args) {
    const out = await runIdeationFeedback(args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  },
});
