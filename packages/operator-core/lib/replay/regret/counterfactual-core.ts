/**
 * counterfactual-core.ts — candidate what-would-have-helped changes + the
 * replay-runner seam (self-learning-frontier-2026-06-12 P-021 / FB-07).
 *
 * Candidate changes are TEMPLATED per divergence kind — deterministic, free,
 * and testable. The counterfactual leg then prices each candidate by actually
 * replaying the session from the divergence turn with the candidate's
 * promptDelta injected, via the FB-06 replay harness (lib/replay, P-020).
 *
 * The seam is `RegretReplayRunner`: mine.ts takes `runner | null`. While the
 * replay harness is unlanded (this lane awaits `frontier:replay-landed`),
 * the runner stays null and findings persist as replay_status='pending';
 * wiring the landed lib/replay API in is the adapter's one job — nothing
 * else in this module changes.
 */

import type { DivergenceFinding } from './divergence-core';

export interface CandidateChange {
  /** Stable id, e.g. 'stop-retry-ladder' — replay_scores key per candidate. */
  id: string;
  title: string;
  /** The rule text a counterfactual replay injects into the agent's prompt at the divergence point. */
  promptDelta: string;
  rationale: string;
  /** Divergence turn the replay re-enters from. */
  fromTurn: number;
}

/** Templated candidates per divergence kind — 1-2 each, ordered most-likely-to-help first. */
export function candidateChangesFor(finding: DivergenceFinding): CandidateChange[] {
  const fromTurn = finding.turn;
  switch (finding.kind) {
    case 'error-loop': {
      const tools = Array.isArray(finding.evidence.tools) ? (finding.evidence.tools as string[]).join(', ') : 'the tool';
      return [
        {
          id: 'stop-retry-ladder',
          title: 'Stop after two consecutive failures of the same tool; change approach',
          promptDelta:
            'HARD RULE: after 2 consecutive failures of the same tool, STOP retrying it. ' +
            'Re-read the relevant doc/insight (docs:search the literal error string first), state a ' +
            'different approach in one line, then act on the new approach.',
          rationale: `An error loop on ${tools} burned the session; an early stop-and-replan likely recovers it.`,
          fromTurn,
        },
        {
          id: 'escalate-on-third-failure',
          title: 'Escalate or file the blocker instead of grinding',
          promptDelta:
            'HARD RULE: on a third consecutive tool failure of any kind, stop work, record the blocker ' +
            '(issues:create or work_items:set_state blocked with the error verbatim), and end the turn.',
          rationale: 'When stop-and-replan cannot recover, surfacing the blocker beats burning the budget.',
          fromTurn,
        },
      ];
    }
    case 'repeat-loop': {
      const tool = typeof finding.evidence.tool === 'string' ? finding.evidence.tool : 'a tool';
      return [
        {
          id: 'no-identical-reissue',
          title: 'Never reissue an identical tool call',
          promptDelta:
            'HARD RULE: never call the same tool with the exact same input twice. If a call did not ' +
            'produce what you needed, change the input or change the strategy — an identical reissue ' +
            'returns the identical result.',
          rationale: `${tool} was re-invoked with identical input ${String(finding.evidence.identicalCalls ?? '3+')} times.`,
          fromTurn,
        },
      ];
    }
    case 'burn-inflection':
      return [
        {
          id: 'checkpoint-on-burn-spike',
          title: 'Checkpoint and re-plan when output rate spikes',
          promptDelta:
            'HARD RULE: when you notice your responses growing much longer turn-over-turn, pause: ' +
            'restate the goal in two lines, list what is actually left, and drop everything else. ' +
            'Prefer finishing one small verified step over broad parallel exploration.',
          rationale: 'Output-token burn spiked mid-session — a re-plan at the inflection likely contains it.',
          fromTurn,
        },
      ];
    case 'rescue-marker':
      return [
        {
          id: 'yield-early-checkpoint',
          title: 'Checkpoint cheaply and yield at the first interrupt',
          promptDelta:
            'HARD RULE: when a yield/interrupt arrives, finish ONLY the atomic edit in flight, persist ' +
            'partial state with a one-line successor note, and END YOUR TURN. Do not start new work.',
          rationale: 'A human/peer rescue marker means the session kept going past the point it should have stopped.',
          fromTurn,
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// The replay seam (FB-06 lib/replay adapter implements this; tests fake it)
// ---------------------------------------------------------------------------

export interface RegretReplayRequest {
  workspaceId: string;
  harnessSlug: string;
  runId: string;
  /** Divergence turn to re-enter the historical session from. */
  fromTurn: number;
  /** The candidate rule injected into the replayed agent's prompt. */
  promptDelta: string;
  /** Per-candidate spend cap (the loop's per-cycle governor budget, split). */
  budgetUsd: number;
}

export interface RegretReplayResult {
  /** 0..1 — how much better the counterfactual trajectory scored vs the original. */
  improvementScore: number;
  summary: string;
  costUsd: number;
}

export interface RegretReplayRunner {
  replayCandidate(req: RegretReplayRequest): Promise<RegretReplayResult>;
}

export interface CandidateReplayScore extends RegretReplayResult {
  candidateId: string;
}
