/**
 * report-core.ts — the scored what-would-have-helped report regret mining
 * files into the idea queue (self-learning-frontier-2026-06-12 P-021 / FB-07).
 *
 * One report per mined session, filed through the shared capture core as a
 * kind=change improvement with origin='replay' (D-002: every consumer
 * filters to organic unless opted in — a regret report never pollutes the
 * organic learners). watchdogKey `regret:<runId>` + dedupScope 'open' is the
 * anti-flood rail; report_improvement_id on the finding row is the local
 * never-re-file belt (the FB-04 carry-forward rule).
 *
 * Filing bar: a report files only once the replay leg has PRICED the
 * candidates (P-021: "counterfactual replay … output is a scored report") —
 * best improvementScore ≥ minFileScore. Detection alone never files.
 */

import type { CandidateChange, CandidateReplayScore } from './counterfactual-core';

export const MIN_FILE_IMPROVEMENT_SCORE = 0.5;

export function regretWatchdogKey(runId: string): string {
  return `regret:${runId}`;
}

/** The slice of a regret finding the report renders (store.RegretFindingRecord satisfies it). */
export interface RegretReportInput {
  runId: string;
  harnessSlug: string;
  role: string | null;
  badnessScore: number;
  badnessReasons: string[];
  divergenceTurn: number | null;
  divergenceKind: string | null;
  divergenceEvidence: Record<string, unknown> | null;
  candidateChanges: CandidateChange[];
  replayScores: CandidateReplayScore[] | null;
}

function shortRunId(runId: string): string {
  return runId.length > 24 ? `${runId.slice(0, 24)}…` : runId;
}

export function bestReplayScore(input: Pick<RegretReportInput, 'replayScores'>): CandidateReplayScore | null {
  let best: CandidateReplayScore | null = null;
  for (const s of input.replayScores ?? []) if (best === null || s.improvementScore > best.improvementScore) best = s;
  return best;
}

export function regretReportTitle(input: RegretReportInput): string {
  const best = bestReplayScore(input);
  const change = input.candidateChanges.find((c) => c.id === best?.candidateId);
  return `Regret: ${input.role ?? 'agent'} session diverged (${input.divergenceKind ?? 'unknown'}) — ${
    change?.title ?? 'what would have helped'
  }`;
}

export function regretReportBody(input: RegretReportInput): string {
  const best = bestReplayScore(input);
  const lines: string[] = [
    `Regret-mining report for run \`${input.runId}\` (${input.role ?? 'unknown role'}, harness ${input.harnessSlug}).`,
    '',
    `**Why this session:** ${input.badnessReasons.join(', ')} (badness ${input.badnessScore.toFixed(2)})`,
    `**Divergence:** turn ${input.divergenceTurn ?? '?'}, ${input.divergenceKind ?? 'unknown'} — evidence: ${JSON.stringify(
      input.divergenceEvidence ?? {},
    )}`,
    '',
    '**Counterfactual replay scores** (0..1, higher = the change helped more):',
    '',
  ];
  for (const change of input.candidateChanges) {
    const score = (input.replayScores ?? []).find((s) => s.candidateId === change.id);
    lines.push(
      `- \`${change.id}\` — ${change.title}: ` +
        (score ? `**${score.improvementScore.toFixed(2)}** — ${score.summary}` : 'not replayed'),
    );
  }
  lines.push(
    '',
    `Proposed rule (best candidate): ${input.candidateChanges.find((c) => c.id === best?.candidateId)?.promptDelta ?? 'n/a'}`,
    '',
    `_origin=replay (D-002); filed by system:regret-mine over run ${shortRunId(input.runId)}._`,
  );
  return lines.join('\n');
}
