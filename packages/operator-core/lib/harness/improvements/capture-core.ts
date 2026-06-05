/**
 * capture-core.ts — the shared capture verb of the self-improvement loop
 * (papercusp-self-improvement-loop-2026-06-04 D-001 +
 * close-the-self-improvement-loop-2026-06-05 D-002/D-003).
 *
 * ONE implementation of "file a captured papercusp improvement" used by BOTH
 * entry points:
 *   - the agent-facing `improvements:capture` tool (the soft prompt-nudge feed),
 *   - the watchdog's event-driven captures (the hard feed-in, D-003).
 *
 * It owns the capture semantics:
 *   - **search-first dedup** (D-001): surfaces likely-existing items and declines
 *     to create a near-duplicate unless `force` — a nudge + good search, NOT a gate.
 *   - **native `kind`** (close-loop D-002): writes the real `engineer_issues.kind`
 *     column (bug | change). The title-prefix convention is RETIRED. `feature`
 *     captures (net-new, rare) store as kind='change' + `payload.improvementKind:
 *     'feature'` — engineer_issues = work_items[kind ∈ bug|change|task]
 *     (migration 152) and the feature *family* lives in the features base table,
 *     so 'feature' is a display refinement here, not a storage kind.
 *   - **candidate `paths`** (close-loop D-002): stored in `payload.paths` so the
 *     protected-path gate (`classifyImprovement`) actually fires.
 *   - auto-tags the built-in `papercusp-improvement` topic (+ optional sub-topic).
 *
 * Deps are injectable so the core is unit-testable without PG.
 */

import {
  createIssue,
  searchIssues,
  type EngineerIssue,
  type IssueSeverity,
  type IssueSource,
  type CreateIssueInput,
} from '../../issues-engineer';
import { IMPROVEMENT_TOPIC } from './read-items';
import { titleSimilarity } from './digest';

/** The fileable improvement kinds (companion D-001). */
export type ImprovementKind = 'bug' | 'change' | 'feature';

export const DUP_THRESHOLD = 0.6;

export interface CaptureImprovementInput {
  /** One-line summary — clean, NO [kind] prefix (kind is a real column now). */
  title: string;
  kind: ImprovementKind;
  body?: string;
  severity?: IssueSeverity;
  /** Optional sub-area topic, e.g. coord-dx, db-tooling. */
  subTopic?: string;
  /** 'operator' (default) or 'harness:<slug>'. */
  scope?: string;
  foundDuring?: string;
  /** Repo-relative paths the improvement touches — feeds the protected-path gate. */
  paths?: string[];
  /** File even if a likely duplicate exists (default false → search-first declines). */
  force?: boolean;
  /** Only run the dedup search, do not create. */
  checkDuplicatesOnly?: boolean;
  createdBy?: string;
  source?: IssueSource;
}

export interface PossibleDuplicate {
  id: string;
  title: string;
  state: string;
  severity: string;
  similarity: number;
}

export interface CaptureImprovementResult {
  ok: true;
  created: boolean;
  reason?: 'likely-duplicate' | 'check-only';
  kind?: ImprovementKind;
  issue?: EngineerIssue;
  topics?: string[];
  possibleDuplicates: PossibleDuplicate[];
  hint?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface CaptureDeps {
  searchIssues: (query: string, limit?: number) => Promise<EngineerIssue[]>;
  createIssue: (input: CreateIssueInput) => Promise<EngineerIssue>;
}

const defaultDeps: CaptureDeps = { searchIssues, createIssue };

/** The native column kind for a capture: feature is a payload refinement of change. */
export function storageKindOf(kind: ImprovementKind): 'bug' | 'change' {
  return kind === 'bug' ? 'bug' : 'change';
}

export async function captureImprovement(
  input: CaptureImprovementInput,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureImprovementResult> {
  // Search-first dedup (D-001): full-text search, then a title-similarity pass.
  const candidates = await deps.searchIssues(input.title, 20).catch(() => [] as EngineerIssue[]);
  const possibleDuplicates: PossibleDuplicate[] = candidates
    .map((i) => ({
      id: i.id,
      title: i.title,
      state: i.state,
      severity: i.severity,
      similarity: Math.round(titleSimilarity(input.title, i.title) * 100) / 100,
    }))
    .filter((d) => d.similarity >= DUP_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  if (input.checkDuplicatesOnly) {
    return { ok: true, created: false, reason: 'check-only', possibleDuplicates };
  }
  if (possibleDuplicates.length > 0 && !input.force) {
    return {
      ok: true,
      created: false,
      reason: 'likely-duplicate',
      possibleDuplicates,
      hint: 'This looks already filed — comment on / claim the existing item, or re-run with force:true if it is genuinely distinct.',
    };
  }

  const topics = [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])];
  // Kind-specific payload: the 'feature' refinement + candidate paths (close-loop D-002).
  const payload: Record<string, unknown> = {};
  if (input.kind === 'feature') payload.improvementKind = 'feature';
  if (input.paths?.length) payload.paths = input.paths;

  const issue = await deps.createIssue({
    title: input.title,
    kind: storageKindOf(input.kind),
    body: input.body,
    severity: input.severity ?? (input.kind === 'bug' ? 'major' : 'minor'),
    scope: input.scope,
    topics,
    foundDuring: input.foundDuring,
    createdBy: input.createdBy,
    source: input.source,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  });
  return { ok: true, created: true, kind: input.kind, issue, topics, possibleDuplicates };
}
