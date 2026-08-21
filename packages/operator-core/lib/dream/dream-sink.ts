/**
 * Accepted-dream sink (REM dreaming P-004).
 *
 * A reviewed dream does not get a parallel idea store or outcome loop. It is
 * captured onto the existing improvement rail, then enrolled in the existing
 * Blender routed-idea ledger with origin='dream'. The ordinary grade and
 * change-feed outcome machinery therefore sees the same wi:<id> artifact it
 * already understands. Source-fragment refs ride the ledger's established
 * addresses_pattern_refs provenance column.
 */
import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from '../harness/improvements/capture-core';
import { recordRoutedIdea, type RecordRoutedIdeaInput } from '../scout/routed-ledger';
import { validateDreamFragments, type DreamInsight } from './dream-pass';
import type { DreamReviewResult } from './dream-review';
import type { DreamFragment } from './fragment-sampler';

export interface SinkDreamInsightInput {
  /** Stable id of the persisted dream run; retries must reuse it. */
  dreamRunId: string;
  cycleId: string;
  harnessSlug: string;
  insight: DreamInsight;
  fragments: readonly DreamFragment[];
  review: DreamReviewResult;
  workspaceId?: string;
  createdBy?: string;
}

export interface DreamSinkDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  recordRoutedIdea: (input: RecordRoutedIdeaInput) => Promise<void>;
  now: () => number;
}

export type SinkDreamInsightResult =
  | { sunk: false; reason: 'review-rejected' }
  | {
      sunk: true;
      ideaId: string;
      workItemId: string;
      routedRef: string;
      sourceRefs: string[];
      created: boolean;
      captureReason?: CaptureImprovementResult['reason'];
    };

const defaultDeps: DreamSinkDeps = {
  capture: (input) => captureImprovement(input),
  recordRoutedIdea,
  now: Date.now,
};

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${name} must be a non-empty string`);
  return normalized;
}

function normalizedInsight(insight: DreamInsight): DreamInsight {
  return {
    text: required(insight.text, 'dream insight text'),
    requiresA: required(insight.requiresA, 'dream insight requiresA'),
    requiresB: required(insight.requiresB, 'dream insight requiresB'),
    actionable: required(insight.actionable, 'dream insight actionable'),
  };
}

export function dreamIdeaId(dreamRunId: string): string {
  return `dream:${required(dreamRunId, 'dreamRunId')}`;
}

/** Human-readable artifact body; the structured copy also lands in payload.dream. */
export function buildDreamInsightBody(input: {
  dreamRunId: string;
  cycleId: string;
  insight: DreamInsight;
  sourceRefs: readonly string[];
  review: Extract<DreamReviewResult, { verdict: 'accept' }>;
}): string {
  return [
    input.insight.text,
    '',
    `**Why fragment A is required:** ${input.insight.requiresA}`,
    `**Why fragment B is required:** ${input.insight.requiresB}`,
    `**Action / falsifiable next step:** ${input.insight.actionable}`,
    '',
    '**Dream provenance**',
    `- Dream run: ${input.dreamRunId}`,
    `- Cycle: ${input.cycleId}`,
    `- Source fragments: ${input.sourceRefs.join(', ')}`,
    `- Independent review: dependence ${input.review.scores.dependence}/2, actionability ${input.review.scores.actionability}/2, novelty ${input.review.scores.novelty}/2`,
    `- Review note: ${input.review.note}`,
  ].join('\n');
}

function artifactId(result: CaptureImprovementResult): string | null {
  return result.issue?.id ?? result.coalescedOnto?.id ?? result.possibleDuplicates[0]?.id ?? null;
}

/**
 * Sink one review-passed dream onto Blender's existing improvement rail.
 *
 * Rejected reviews are a side-effect-free no-op. Accepted retries are stable:
 * the dream-run key participates in capture dedup, and the ledger upserts on
 * the deterministic dream idea id.
 */
export async function sinkDreamInsight(
  input: SinkDreamInsightInput,
  deps: DreamSinkDeps = defaultDeps,
): Promise<SinkDreamInsightResult> {
  if (input.review.verdict !== 'accept') return { sunk: false, reason: 'review-rejected' };

  const dreamRunId = required(input.dreamRunId, 'dreamRunId');
  const cycleId = required(input.cycleId, 'cycleId');
  const harnessSlug = required(input.harnessSlug, 'harnessSlug');
  const insight = normalizedInsight(input.insight);
  validateDreamFragments(input.fragments);
  if (input.fragments.some((fragment) => fragment.harness !== harnessSlug)) {
    throw new RangeError('dream sink fragments must belong to the target harness');
  }
  const sourceRefs = [...new Set(input.fragments.map((fragment) => required(fragment.ref, 'fragment ref')))];
  if (sourceRefs.length < 2) throw new RangeError('dream sink requires at least two distinct source refs');

  const ideaId = dreamIdeaId(dreamRunId);
  const title = insight.text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)!
    .slice(0, 200);
  const captured = await deps.capture({
    title,
    kind: 'feature',
    body: buildDreamInsightBody({ dreamRunId, cycleId, insight, sourceRefs, review: input.review }),
    scope: `harness:${harnessSlug}`,
    sourceRole: 'system',
    filedByRole: 'dream',
    foundDuring: 'dream-cycle',
    createdBy: input.createdBy,
    semanticBlockBand: 'soft',
    watchdogKey: ideaId,
    payloadExtra: {
      dream: {
        dreamRunId,
        cycleId,
        sourceRefs,
        review: {
          scores: input.review.scores,
          note: input.review.note,
          model: input.review.usage.model,
        },
      },
    },
  });
  const workItemId = artifactId(captured);
  if (!workItemId) {
    throw new Error(`dream sink capture returned no routable artifact for ${ideaId}`);
  }
  const routedRef = `wi:${workItemId}`;

  await deps.recordRoutedIdea({
    ideaId,
    origin: 'dream',
    lens: 'dream',
    rail: 'improvement',
    routedRef,
    harnessSlug,
    cycleId,
    title,
    addressesPatternRefs: sourceRefs,
    routedAt: deps.now(),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });

  return {
    sunk: true,
    ideaId,
    workItemId,
    routedRef,
    sourceRefs,
    created: captured.created,
    ...(captured.reason ? { captureReason: captured.reason } : {}),
  };
}
