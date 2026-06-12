/**
 * mine.ts — the regret-mining tick (self-learning-frontier-2026-06-12
 * P-021 / FB-07). One tick =
 *
 *   1. SELECT  — read the window's terminal spawns (store.readSelectionRows),
 *                score badness (selection-core), keep the top candidates not
 *                already mined;
 *   2. DETECT  — fetch each new candidate's persisted transcript, parse
 *                (transcript-core), locate the divergence turn
 *                (divergence-core), template candidate changes
 *                (counterfactual-core), upsert the finding;
 *   3. REPLAY  — when a RegretReplayRunner is wired (FB-06's lib/replay —
 *                this leg stays dormant until `frontier:replay-landed`),
 *                counterfactually price pending findings' candidates under
 *                the per-cycle budget, oldest first;
 *   4. FILE    — replayed findings whose best candidate clears minFileScore
 *                file ONE scored report each through the capture core,
 *                origin='replay' (D-002), watchdogKey-deduped, capped per
 *                tick. `maxFilePerTick: 0` is mine-only mode (the supervised
 *                live-proof mode; also the pre-P-001 stance).
 *
 * Deps are injectable (tests run the tick without PG/LLM); the flag +
 * governor gates live in the routine action (regret-action.ts), not here —
 * the FB-04 layering, which also keeps this factory hermetic per the
 * default-on-flag-glue-vs-hermetic-unit-tests insight.
 */

import { scoreBadSessions, type SelectionInputRow, type SelectionOptions } from './selection-core';
import { parseTranscript } from './transcript-core';
import { detectDivergenceSignals, pickDivergence } from './divergence-core';
import {
  candidateChangesFor,
  type CandidateReplayScore,
  type RegretReplayRunner,
} from './counterfactual-core';
import {
  MIN_FILE_IMPROVEMENT_SCORE,
  bestReplayScore,
  regretReportBody,
  regretReportTitle,
  regretWatchdogKey,
} from './report-core';
import type { RegretFindingRecord } from './store';
import type { CaptureImprovementInput, CaptureImprovementResult } from '../../harness/improvements/capture-core';

export interface RegretTickOptions extends SelectionOptions {
  /** Trailing selection window in days. Default 14. */
  windowDays?: number;
  /** Pending findings priced per tick once the replay leg is live. Default 3. */
  maxReplaysPerTick?: number;
  /** Per-cycle replay spend cap in USD, split across a finding's candidates. Default 0 (no replay). */
  replayBudgetUsd?: number;
  /** Reports filed per tick; 0 = mine-only (no filing). Default 3. */
  maxFilePerTick?: number;
  /** Best-candidate improvement score a report needs to file. Default 0.5. */
  minFileScore?: number;
}

export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MAX_REPLAYS_PER_TICK = 3;
export const DEFAULT_MAX_FILE_PER_TICK = 3;

/** Routine payload_template → tick options (all optional, all bounded). */
export function regretOptionsFromPayload(payload: unknown): RegretTickOptions {
  const p = (payload ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    windowDays: num(p.windowDays),
    minScore: num(p.minScore),
    maxSessions: num(p.maxSessions),
    maxReplaysPerTick: num(p.maxReplaysPerTick),
    replayBudgetUsd: num(p.replayBudgetUsd),
    maxFilePerTick: num(p.maxFilePerTick),
    minFileScore: num(p.minFileScore),
  };
}

/** Injectable seams (tests run the tick without PG / LLM). */
export interface RegretTickDeps {
  readRows: (workspaceId: string, windowDays: number) => Promise<SelectionInputRow[]>;
  readTranscript: (runId: string) => Promise<string | null>;
  listKnownRunIds: (workspaceId: string) => Promise<Set<string>>;
  upsertFinding: (finding: RegretFindingRecord) => Promise<void>;
  readPendingReplay: (workspaceId: string, limit: number) => Promise<RegretFindingRecord[]>;
  recordReplayScores: (workspaceId: string, runId: string, scores: CandidateReplayScore[]) => Promise<void>;
  readUnfiledReplayed: (workspaceId: string, limit: number) => Promise<RegretFindingRecord[]>;
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  markFiled: (workspaceId: string, runId: string, improvementId: string) => Promise<void>;
  /** null until FB-06's replay harness is wired in — the replay leg then activates. */
  replayRunner: RegretReplayRunner | null;
  /** Current ISO timestamp — injected so the tick is deterministic in tests. */
  nowIso: () => string;
  log?: (message: string) => void;
}

export interface RegretTickResult {
  scanned: number;
  candidates: number;
  /** Newly mined (upserted) findings this tick. */
  mined: number;
  skippedKnown: number;
  /** Findings priced by the replay leg this tick. */
  replayed: number;
  replayCostUsd: number;
  /** Improvement ids filed this tick. */
  filed: string[];
  declined: number;
}

/** One mining tick: select → detect → (replay) → (file). Never throws per-item. */
export async function runRegretTick(
  workspaceId: string,
  deps: RegretTickDeps,
  opts: RegretTickOptions = {},
): Promise<RegretTickResult> {
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  const maxReplays = opts.maxReplaysPerTick ?? DEFAULT_MAX_REPLAYS_PER_TICK;
  const replayBudgetUsd = opts.replayBudgetUsd ?? 0;
  const maxFile = opts.maxFilePerTick ?? DEFAULT_MAX_FILE_PER_TICK;
  const minFileScore = opts.minFileScore ?? MIN_FILE_IMPROVEMENT_SCORE;
  const log = deps.log ?? (() => {});

  // ── 1. SELECT ──────────────────────────────────────────────────────────────
  const rows = await deps.readRows(workspaceId, windowDays);
  const candidates = scoreBadSessions(rows, opts);
  const known = await deps.listKnownRunIds(workspaceId);
  const fresh = candidates.filter((c) => !known.has(c.runId));
  const skippedKnown = candidates.length - fresh.length;

  // ── 2. DETECT ─────────────────────────────────────────────────────────────
  let mined = 0;
  for (const candidate of fresh) {
    try {
      const body = await deps.readTranscript(candidate.runId);
      const transcript = body === null ? null : parseTranscript(body);
      const divergence =
        transcript && transcript.turns.length > 0 ? pickDivergence(detectDivergenceSignals(transcript)) : null;
      const changes = divergence ? candidateChangesFor(divergence) : [];
      await deps.upsertFinding({
        workspaceId,
        runId: candidate.runId,
        harnessSlug: candidate.harnessSlug,
        role: candidate.role,
        badnessScore: candidate.badnessScore,
        badnessReasons: candidate.reasons,
        divergenceTurn: divergence?.turn ?? null,
        divergenceKind: divergence?.kind ?? null,
        divergenceEvidence: divergence?.evidence ?? null,
        candidateChanges: changes,
        // No transcript or no divergence signal ⇒ nothing to replay.
        replayStatus: divergence ? 'pending' : 'skipped',
        replayScores: null,
        reportImprovementId: null,
        minedAt: deps.nowIso(),
      });
      mined += 1;
    } catch (e) {
      log(`[regret-mine] mining "${candidate.runId}" FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 3. REPLAY (dormant until FB-06's runner is wired) ─────────────────────
  let replayed = 0;
  let replayCostUsd = 0;
  if (deps.replayRunner && replayBudgetUsd > 0 && maxReplays > 0) {
    const pending = await deps.readPendingReplay(workspaceId, maxReplays);
    const perFinding = replayBudgetUsd / Math.max(1, pending.length);
    for (const finding of pending) {
      if (finding.divergenceTurn === null || finding.candidateChanges.length === 0) continue;
      try {
        const perCandidate = perFinding / finding.candidateChanges.length;
        const scores: CandidateReplayScore[] = [];
        for (const change of finding.candidateChanges) {
          const result = await deps.replayRunner.replayCandidate({
            workspaceId,
            harnessSlug: finding.harnessSlug,
            runId: finding.runId,
            fromTurn: change.fromTurn,
            promptDelta: change.promptDelta,
            budgetUsd: perCandidate,
          });
          replayCostUsd += result.costUsd;
          scores.push({ candidateId: change.id, ...result });
        }
        await deps.recordReplayScores(workspaceId, finding.runId, scores);
        replayed += 1;
      } catch (e) {
        log(`[regret-mine] replay for "${finding.runId}" FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ── 4. FILE (mine-only when maxFilePerTick = 0) ───────────────────────────
  const filed: string[] = [];
  let declined = 0;
  if (maxFile > 0) {
    const unfiled = await deps.readUnfiledReplayed(workspaceId, maxFile);
    for (const finding of unfiled) {
      const best = bestReplayScore(finding);
      if (!best || best.improvementScore < minFileScore || finding.divergenceTurn === null) continue;
      try {
        const result = await deps.capture({
          title: regretReportTitle(finding),
          kind: 'change',
          body: regretReportBody(finding),
          severity: 'minor',
          subTopic: 'regret-mining',
          sourceRole: 'system',
          source: 'su',
          origin: 'replay',
          watchdogKey: regretWatchdogKey(finding.runId),
          dedupScope: 'open',
          evidenceAt: finding.minedAt,
          createdBy: 'system:regret-mine',
        });
        if (result.created && result.issue) {
          filed.push(result.issue.id);
          await deps.markFiled(workspaceId, finding.runId, result.issue.id);
        } else {
          declined += 1;
          log(`[regret-mine] report for "${finding.runId}" declined (${result.reason ?? 'not created'})`);
        }
      } catch (e) {
        declined += 1;
        log(`[regret-mine] capture for "${finding.runId}" FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  return {
    scanned: rows.length,
    candidates: candidates.length,
    mined,
    skippedKnown,
    replayed,
    replayCostUsd,
    filed,
    declined,
  };
}
