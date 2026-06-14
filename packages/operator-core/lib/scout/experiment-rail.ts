/**
 * The dark Scout→experiment rail (experiment-registry-invocation-api-2026-06-14 #2,
 * "close the loop"). Behind the `SCOUT_EXPERIMENT_RAIL` flag (default OFF), each
 * TESTABLE (gym-rail) Scout proposal is ADDITIVELY expressed as a DRY-RUN experiment
 * spec — it does NOT change the proposal's gym routing and it NEVER spends (dryRun
 * returns before any substrate call).
 *
 * This is the mechanical (LLM-free) v1: the candidate arm's system-prompt overlay IS
 * the proposal's framing+mechanism prose, and the synthetic case is built from the
 * proposal. It proves the loop closes (Scout → experiment:run) with zero spend. The
 * LLM-polished candidate-overlay / case generation — turning prose into a sharp
 * overlay + a real resumable case — is the owner-reviewable follow-on.
 */
import type { Proposal } from './types';
import type { RoutingDecision } from './router';
import {
  runExperiment,
  type RunExperimentDeps,
  type RunExperimentInput,
  type RunExperimentOutcome,
} from '../experiment/run-core';

const OVERLAY_CAP = 4000;

/** Map a Scout proposal → a dry-run replay experiment request. Mechanical, no LLM. */
export function proposalToExperimentRequest(p: Proposal): RunExperimentInput {
  const overlay = [p.framing, p.mechanism].filter(Boolean).join('\n\n').slice(0, OVERLAY_CAP);
  const intent = p.bet || p.cheapExperiment?.hypothesis || p.framing || p.mechanism;
  return {
    testId: 'replay',
    batteryId: `scout:${p.id}`,
    arms: [
      { id: 'baseline', knobs: {} },
      { id: 'candidate', label: (p.framing || p.id).slice(0, 80), knobs: { 'overlay.systemOverlay': overlay } },
    ],
    cases: [{ caseId: p.id, context: p.framing || p.mechanism || intent, intent }],
    repeats: 1,
    dryRun: true,
  };
}

/** The dispatch port — what the rail calls per testable proposal. */
export interface ExperimentDispatchPort {
  (request: RunExperimentInput): Promise<RunExperimentOutcome>;
}

/**
 * The default dispatch: DRY-RUN-validate the request through run-core (no spend, no
 * ledger) and acknowledge. Forces `dryRun:true` so it can never spend regardless of
 * input. The deps below exist only to satisfy the type — `dryRun` returns before any
 * is used. Mirrors the `echoInstanceCandidates` acknowledge-only precedent; the live
 * executor is wired when the owner arms it.
 */
export function buildExperimentDispatchPort(): ExperimentDispatchPort {
  return async (request) => {
    const { activeWorkspaceId } = await import('../workspace-registry');
    return runExperiment({ ...request, dryRun: true }, { workspaceId: activeWorkspaceId() }, {
      runGovernedReplay: (async () => ({ verdict: { allow: false, remainingUsd: null }, result: null })) as RunExperimentDeps['runGovernedReplay'],
      replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: false })) as RunExperimentDeps['replayRunner'],
      judge: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as RunExperimentDeps['judge'],
    });
  };
}

/**
 * For each TESTABLE (gym-rail) decision, build a dry-run experiment request from its
 * proposal and dispatch it. Best-effort + defensive — never throws into the cycle, and
 * does NOT touch the proposal's existing gym routing (purely additive).
 */
export async function forkTestableToExperiments(
  decisions: readonly RoutingDecision[],
  proposals: readonly Proposal[],
  dispatch: ExperimentDispatchPort,
): Promise<{ dispatched: number; failed: number }> {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  let dispatched = 0;
  let failed = 0;
  for (const d of decisions) {
    if (d.rail !== 'gym') continue;
    const p = byId.get(d.proposalId);
    if (!p) continue;
    try {
      await dispatch(proposalToExperimentRequest(p));
      dispatched += 1;
    } catch {
      failed += 1;
    }
  }
  return { dispatched, failed };
}
