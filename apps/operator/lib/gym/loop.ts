/**
 * Continuous autonomous loop driver (P-022).
 *
 * One cycle: select parent from the frontier → reflect & propose (prompts-only) →
 * evaluate the candidate → gate (accept iff all gates hold) → on accept update the
 * frontier + champion and promote the champion's overrides into the dedicated gym
 * harness (D-012) → append the changelog → check the arithmetic circuit-breaker
 * (auto-revert on drift) → repeat until budget / maxCycles / breaker. Unattended.
 *
 * All effects are injected, so the orchestration is unit-tested without a real
 * pipeline, real agents, or PG. The bounded budget is the unattended-spend guard
 * (D-019): the loop never exceeds `budgetUsd`.
 */
import { paretoFrontier } from './frontier';
import { decideAccept, selectParent, type AcceptThresholds, type VariantEval } from './gate-engine';
import { appendChangelog } from './changelog';
import { circuitBreakerTripped } from './circuit-breaker';
import type { VariantOverlay } from './variant-overlay';
import type { CandidateProposal, WorstTrace } from './proposer';

export interface LoopConfig {
  thresholds: AcceptThresholds;
  baselineMeanCost: number;
  /** Dev-anchor baseline-of-record for the circuit-breaker. */
  baselineOfRecord: number;
  dropThreshold: number;
  maxCycles: number;
  /** Hard unattended-spend cap (D-019); null ⇒ rely on maxCycles only. */
  budgetUsd: number | null;
  proposerModel: string;
}

export interface EvaluateResult {
  evalResult: VariantEval;
  worstTraces: WorstTrace[];
  costUsd: number;
}

export interface LoopDeps {
  baseline: { variantId: string; overlay: VariantOverlay };
  evaluate(variantId: string, overlay: VariantOverlay): Promise<EvaluateResult>;
  propose(parentOverlay: VariantOverlay, worstTraces: WorstTrace[], changelog: string): Promise<CandidateProposal>;
  /** Promote the champion overrides into the dedicated gym harness (P-020/D-012). */
  promote(overlay: VariantOverlay): Promise<void>;
  /** Auto-revert the harness overrides to last-known-good (circuit-breaker). */
  revert(): Promise<void>;
  persistCycle(rec: {
    cycle: number;
    parentId: string;
    candidateId: string;
    decision: 'accept' | 'reject';
    gateResults: unknown;
  }): Promise<void>;
  newVariantId(cycle: number): string;
}

export interface LoopResult {
  cycles: number;
  accepts: number;
  championId: string;
  spentUsd: number;
  breakerTripped: boolean;
}

interface Tracked {
  evalResult: VariantEval;
  overlay: VariantOverlay;
  worstTraces: WorstTrace[];
}

export async function runOptimizationLoop(config: LoopConfig, deps: LoopDeps): Promise<LoopResult> {
  const variants = new Map<string, Tracked>();

  // Seed: evaluate the baseline.
  const base = await deps.evaluate(deps.baseline.variantId, deps.baseline.overlay);
  let spentUsd = base.costUsd;
  variants.set(deps.baseline.variantId, {
    evalResult: base.evalResult,
    overlay: deps.baseline.overlay,
    worstTraces: base.worstTraces,
  });
  let frontierIds = [deps.baseline.variantId];
  let championId = deps.baseline.variantId;
  let changelog = '';
  let accepts = 0;
  let breakerTripped = false;
  let cycles = 0;

  for (let cycle = 1; cycle <= config.maxCycles; cycle++) {
    if (config.budgetUsd !== null && spentUsd >= config.budgetUsd) break;
    cycles = cycle;

    // Select parent from the frontier (most headroom).
    const frontierEvals = frontierIds.map((id) => ({ variantId: id, trainAgg: variants.get(id)!.evalResult.trainAgg }));
    const parentPick = selectParent(frontierEvals);
    const parentId = parentPick?.variantId ?? championId;
    const parent = variants.get(parentId)!;

    // Reflect & propose.
    const proposal = await deps.propose(parent.overlay, parent.worstTraces, changelog);
    const candidateId = deps.newVariantId(cycle);

    // Evaluate the candidate.
    const evalRes = await deps.evaluate(candidateId, proposal.overlay);
    spentUsd += evalRes.costUsd;
    variants.set(candidateId, { evalResult: evalRes.evalResult, overlay: proposal.overlay, worstTraces: evalRes.worstTraces });

    const champion = variants.get(championId)!;
    const verdict = decideAccept(
      evalRes.evalResult,
      parent.evalResult,
      champion.evalResult,
      config.baselineMeanCost,
      config.thresholds,
    );

    const championDevBefore = champion.evalResult.devAnchorAgg;
    if (verdict.accept) {
      accepts++;
      // Update frontier (Pareto prune) over the candidate set.
      const candidatesForFrontier = [...frontierIds, candidateId].map((id) => ({
        id,
        vector: variants.get(id)!.evalResult.trainVector,
      }));
      frontierIds = paretoFrontier(candidatesForFrontier).map((c) => c.id);
      // Champion = best dev-anchor; promote on a new champion.
      if (evalRes.evalResult.devAnchorAgg > champion.evalResult.devAnchorAgg) {
        championId = candidateId;
        await deps.promote(proposal.overlay);
      }
      changelog = appendChangelog(changelog, {
        cycle,
        decision: 'accept',
        devAnchorDelta: variants.get(championId)!.evalResult.devAnchorAgg - championDevBefore,
        costDelta: evalRes.evalResult.meanCost - config.baselineMeanCost,
        probeCaught: evalRes.evalResult.allProbesCaught,
        narrative: proposal.rationale,
      });
    } else {
      changelog = appendChangelog(changelog, {
        cycle,
        decision: 'reject',
        devAnchorDelta: evalRes.evalResult.devAnchorAgg - championDevBefore,
        costDelta: evalRes.evalResult.meanCost - config.baselineMeanCost,
        probeCaught: evalRes.evalResult.allProbesCaught,
        narrative: proposal.rationale,
      });
    }

    await deps.persistCycle({
      cycle,
      parentId,
      candidateId,
      decision: verdict.accept ? 'accept' : 'reject',
      gateResults: verdict.results,
    });

    // Circuit-breaker: the real safety net (D-006/D-012).
    if (circuitBreakerTripped(variants.get(championId)!.evalResult.devAnchorAgg, config.baselineOfRecord, config.dropThreshold)) {
      await deps.revert();
      breakerTripped = true;
      break;
    }
  }

  return { cycles, accepts, championId, spentUsd, breakerTripped };
}
