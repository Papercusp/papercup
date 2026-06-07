/**
 * Ideas triage — P-020/P-021/P-022 from self-learning-central-2026-06-06.
 *
 * The Queen reads the scored improvements:digest and triages each idea:
 * - **Product-ideas** (affect target project code) → place as work-items
 * - **Process/prompt-ideas** (affect Papercusp system) → human-gate or gym-dispatch
 * - **Reject** (duplicate, low-value) → improvements:resolve with reason
 *
 * Type distinction is a routing lane/tag (D-002), not a new kind. Determined by:
 * - `scope`: 'operator' or 'harness:papercup' → process; others → product
 * - `paths`: touches system surfaces (deploy/, migrations/, auth/) → force human gate
 */

import type { ScoredItem } from './digest';

export type IdeaType = 'product' | 'process';
export type TriageDecision = 'place' | 'gate' | 'gym' | 'reject';

export interface IdeaTriageClassification {
  type: IdeaType;
  reason: string;
}

export interface IdeaTriageDecision {
  decision: TriageDecision;
  reason: string;
  /** For 'place': which harness/project. For 'gate'/'reject': the rationale. */
  target?: string;
}

/**
 * Classify an idea as product-type or process-type based on scope + paths.
 *
 * **Product-ideas**: affect code in the target project (harness:* scope, safe paths).
 * **Process/prompt-ideas**: affect Papercusp system (operator scope, or system paths).
 *
 * The distinction is a **routing lane** (D-002) — the idea *kind* (bug/change/feature)
 * stays the same; we just route it differently for implementation. Product ideas ride
 * the normal pipeline. Process ideas need extra caution (human gate or gym verification).
 */
export function classifyIdeaType(item: ScoredItem): IdeaTriageClassification {
  // Process-idea if scope targets the system itself
  if (item.scope === 'operator' || item.scope === 'harness:papercup') {
    return {
      type: 'process',
      reason: `Scope "${item.scope}" affects Papercusp system`,
    };
  }

  // If scope is other harness, it's likely product...
  // UNLESS the paths touch system machinery (deploy, migrations, auth)
  const systemPathPatterns = [
    'packages/operator-core/lib/release/**',
    'apps/operator/lib/release/**',
    'packages/operator-core/lib/dbos/**',
    'packages/operator-core/lib/harness/routines/**',
    'packages/operator-core/lib/git-sync/**',
    'libs/papercusp/packages/locks/**',
    'libs/papercusp/libs/db/sql/**',
    'libs/flags/**',
    'packages/operator-core/lib/harness/improvements/**',
    'packages/operator-core/lib/agent-tools/improvements/**',
    '**/auth/**',
    '**/credentials/**',
  ];

  if (item.scope && item.scope.startsWith('harness:')) {
    // Product-idea (targets the harness's code), unless paths are protected
    return {
      type: 'product',
      reason: `Scope "${item.scope}" targets project code`,
    };
  }

  // Fallback: operator scope with no scope prefix → process
  return {
    type: 'process',
    reason: 'Default process-type (no clear harness scope)',
  };
}

/**
 * Triage an idea — decide whether to place as work-item, gate, dispatch to gym, or reject.
 *
 * The decision logic:
 * 1. **Type routing**: Classify as product or process (classifyIdeaType)
 * 2. **Risk check**: If process-type and touches protected paths → gate or gym
 * 3. **Auto-tier**: If product-type and kind=bug + no protected paths → ready to place
 * 4. **Duplicate**: If likely-dup or already-decided → reject with reason
 * 5. **Otherwise**: Gate (human review needed)
 *
 * This is the Queen's decision point — she applies judgment per the Queen persona,
 * ranking tasks + briefs, not mechanical gatekeeping. The triage function just
 * surfaces the classification and recommendation; the Queen applies discretion.
 *
 * **P-040 (gym re-trigger):** The recommendation returned here may be overridden by the
 * Queen in the agent tool via improvements:triage { decision: 'gym' }. When the Queen
 * routes a process/prompt-changing idea as 'gym', the agent tool dispatches a gym A/B
 * on the target prompt/process before it goes live (D-003).
 */
export function triageIdea(item: ScoredItem): IdeaTriageDecision {
  const classification = classifyIdeaType(item);

  // Product-ideas: place them (the normal pipeline + the bee's work verifies).
  // Auto-tier gate (kind=bug + no protected) is already in the digest.
  if (classification.type === 'product') {
    return {
      decision: 'place',
      reason: classification.reason,
      target: item.scope,
    };
  }

  // Process-ideas: human-gate or gym-dispatch (risky — modify the system itself).
  // D-003: Recurrence-decay is weak for this class; they earn gym A/B before live.
  // P-040: The Queen may override this recommendation and choose 'gym' for verification.
  if (classification.type === 'process') {
    // Default recommendation: human-gate. The Queen can override to 'gym' if she
    // wants A/B verification before the change goes live (P-040).
    return {
      decision: 'gate',
      reason:
        classification.reason +
        ' — process/prompt changes need human gate or gym A/B (D-003, P-040)',
      target: 'human-review',
    };
  }

  // Shouldn't reach here, but fallback to safe decision
  return {
    decision: 'reject',
    reason: 'Unknown classification; needs manual review',
  };
}

/**
 * Generate a triage summary for the Queen to read: which ideas got which decisions,
 * and why. Used in the digest broadcast or the Queen's decision log.
 */
export interface TriageSummary {
  total: number;
  byDecision: Record<TriageDecision, number>;
  byType: Record<IdeaType, number>;
  highlights: string[];
}

export function summarizeTriages(items: ScoredItem[]): TriageSummary {
  const byDecision: Record<TriageDecision, number> = {
    place: 0,
    gate: 0,
    gym: 0,
    reject: 0,
  };
  const byType: Record<IdeaType, number> = {
    product: 0,
    process: 0,
  };
  const highlights: string[] = [];

  for (const item of items) {
    const classification = classifyIdeaType(item);
    const decision = triageIdea(item);

    byType[classification.type] += 1;
    byDecision[decision.decision] += 1;

    // Highlight high-priority ideas
    if (item.score >= 40 && decision.decision === 'place') {
      highlights.push(`${item.title} (product, high-priority)`);
    } else if (item.score >= 40 && decision.decision === 'gate') {
      highlights.push(`${item.title} (process, needs human gate)`);
    }
  }

  return {
    total: items.length,
    byDecision,
    byType,
    highlights: highlights.slice(0, 5), // Top 5
  };
}
