/**
 * deprecate-learnings.ts — the Queen↔Scout loop's "a dead draft still produces
 * fuel" seam (queen-scout-feedback-loop-2026-06-20 P-006 / brief B10, D-002).
 *
 * When the loop concludes a routed DRAFT plan won't reach `ready`, it DEPRECATES
 * the draft (supersedes it) AND emits a structured, SOURCE-TAGGED *learnings*
 * OBSERVATION — what was tried / why it stalled / what's salvageable — into the
 * observation lane. That observation re-enters Scout's corpus-digest
 * (`readObservationItems` → `friction()` lane in corpus-digest-deps.ts), so a
 * future cycle can re-ideate a better-framed draft from the salvage instead of
 * hitting the same dead end. The loop stays CLOSED — no waste (D-002).
 *
 * REUSE-FIRST (agents-reuse-first-default-2026-06-20 + queen-scout D-001 "ride on
 * existing rails, no new table/mechanism"): a thin COMPOSER over the shared
 * observation writer {@link captureImprovement} (lane:'observation') and the
 * canonical {@link StructuredObservation} shape (rubric-driven-observations
 * P-001 / D-003, owned by observation-types.ts). It introduces no storage and no
 * schema — it only SHAPES the capture input. The builder is PURE (unit-testable
 * without PG); only {@link emitDeprecateLearnings} touches the writer (injectable).
 *
 * SOURCE-TAGGING rides the EXISTING axes:
 *  - `scope: 'harness:<sourceHive>'` is what `issueToCandidate` maps to
 *    `candidate.scope`, which the digest's per-Hive lens
 *    (`readObservationItems({ harnessScopes })`) already filters on; AND
 *  - `payload.observation.sourceHive` (camelCase) is the typed-column source for
 *    structured-observation v2 (B1) — written here NOW so B1's schema backfills
 *    from it (one coherent extension, not a fork — rubric D-002 convergence,
 *    casing confirmed camelCase with the schema owner).
 *
 * Free-text learnings stay FIRST-CLASS and the permanent fallback; the
 * rubric-graded fields (`rubricRef`/`ratings`) are an optional ADDITION
 * (queen-scout D-003 #6) and pass straight to the v2 evidence gate.
 */

import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from './capture-core';
import type { ObservationRatings, StructuredObservation } from './observation-types';

/**
 * The free-text learnings salvaged from a deprecated draft — the three prose
 * fields P-006 names. Each is plain text (free-text is the default + permanent
 * fallback per queen-scout D-003 #6); a future rubric-graded addition rides the
 * optional `rubricRef`/`ratings` on {@link DeprecateLearningsInput}.
 */
export interface DeprecateLearnings {
  /** What approach / premise was attempted on the draft. */
  tried: string;
  /** Why it stalled — the reason it won't reach `ready`. */
  stalled: string;
  /** What's salvageable — the reusable signal a future cycle can re-ideate from. */
  salvageable: string;
}

/**
 * Who concluded the draft won't reach ready. Either party may deprecate
 * (queen-scout D-002): the Queen (the reviewer/gate) or the Scout (self-deprecate
 * mid-revision on a flawed premise). A manual/su deprecation acts as the owner.
 */
export type DeprecatedByRole = 'Queen' | 'Scout' | 'owner';

/** The `sourceRole` the observation is filed under (capture-core's vocabulary). */
function sourceRoleOf(by: DeprecatedByRole): 'Queen' | 'Scout' | 'human' {
  return by === 'owner' ? 'human' : by;
}

export interface DeprecateLearningsInput {
  /** The draft plan being deprecated (its slug). */
  planSlug: string;
  /** Who concluded the draft won't reach ready (D-002). */
  deprecatedBy: DeprecatedByRole;
  /** The free-text learnings (the default; D-003 #6). */
  learnings: DeprecateLearnings;
  /**
   * The SOURCE hive the draft belonged to — the source-tag (workspace-scoped
   * P-001 / rubric P-001). At the call site this defaults to the plan's harness
   * slug. Drives both `scope: 'harness:<sourceHive>'` and
   * `payload.observation.sourceHive`.
   */
  sourceHive: string;
  /**
   * Optional TARGET hive (`StructuredObservation.targetHive`) when the draft was
   * about a DIFFERENT hive than the one that produced it.
   */
  targetHive?: string;
  /**
   * Grounding refs for the observation (`StructuredObservation.refs`). The
   * deprecated plan ref is always prepended, so passing none still yields a
   * grounded observation.
   */
  evidence?: string[];
  /**
   * Forward-compat rubric-graded addition (queen-scout D-003 #6 — an ADDITION
   * once a fitting rubric exists, never a replacement for free-text). When
   * `ratings` is set, `rubricRef` is required + each rating must carry evidence
   * (the v2 evidence gate, enforced in capture-core).
   */
  rubricRef?: string;
  ratings?: ObservationRatings;
  /** Attribution — the ownerId of the deprecating agent (capture `createdBy`). */
  createdBy?: string;
}

/** The machine-readable observation sub-kind (`payload.deprecateLearnings`). */
export const DEPRECATE_LEARNINGS_OBSERVATION_KIND = 'deprecate-learnings' as const;

/** Flatten whitespace + truncate to `n` chars with an ellipsis (for the title net). */
function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * PURE: shape a {@link DeprecateLearningsInput} into the
 * {@link CaptureImprovementInput} for a structured, source-tagged learnings
 * observation. No PG, no I/O — exhaustively unit-testable.
 *
 * Invariants the tests pin:
 *  - `lane: 'observation'` + `scope: 'harness:<sourceHive>'` (source-tagged into
 *    the digest's per-Hive lens) + `origin: 'organic'`.
 *  - `force: true` — a deprecation's learnings must NEVER be suppressed as a
 *    near-duplicate (observations skip dedup anyway; belt-and-braces so the "no
 *    dead ends" guarantee holds even if the lane ever gains dedup).
 *  - title carries the stall reason so the digest CLUSTERS recurring dead-ends;
 *    body carries the three free-text fields the ideators read.
 *  - the v2 convergence fields ride `payload.observation` (the canonical
 *    {@link StructuredObservation}, camelCase) so B1's schema backfills its typed
 *    columns from `payload.observation.sourceHive` etc.; the deprecate-specific
 *    metadata rides a sibling `payload.deprecateLearnings` (no collision with the
 *    generic observation shape).
 */
export function buildDeprecateLearningsObservation(
  input: DeprecateLearningsInput,
): CaptureImprovementInput {
  const { planSlug, deprecatedBy, learnings, sourceHive, targetHive, rubricRef, ratings, createdBy } =
    input;
  const planRef = `plan:${planSlug}`;
  // Always ground the observation on the deprecated plan; de-dup the ref list.
  const refs = [planRef, ...(input.evidence ?? [])].filter((v, i, a) => a.indexOf(v) === i);

  const title = `Deprecated draft "${planSlug}": ${oneLine(learnings.stalled, 100)}`;

  const body = [
    `A Queen↔Scout draft plan was deprecated (it will not reach \`ready\`) — recording the`,
    `learnings so a future Scout cycle can re-ideate from the salvage instead of hitting the`,
    `same dead end (queen-scout-feedback-loop D-002, "a dead draft still produces fuel").`,
    ``,
    `- Deprecated plan: ${planSlug}`,
    `- Decided by: ${deprecatedBy}`,
    `- Source hive: ${sourceHive}`,
    ...(targetHive ? [`- Target hive: ${targetHive}`] : []),
    ``,
    `What was tried:`,
    learnings.tried.trim(),
    ``,
    `Why it stalled:`,
    learnings.stalled.trim(),
    ``,
    `What's salvageable:`,
    learnings.salvageable.trim(),
  ].join('\n');

  // The canonical v2 structured observation (observation-types.ts). All v2 fields
  // are camelCase + ride payload.observation (the schema owner's confirmed shape).
  const observation: StructuredObservation = {
    // A deprecated premise is a capability/idea GAP the loop learned about.
    kind: 'gap',
    scope: 'harness',
    confidence: 'med',
    refs,
    sourceHive,
    ...(targetHive ? { targetHive } : {}),
    ...(rubricRef ? { rubricRef } : {}),
    ...(ratings ? { ratings } : {}),
  };

  return {
    title,
    kind: 'change',
    body,
    severity: 'nit',
    scope: `harness:${sourceHive}`,
    lane: 'observation',
    origin: 'organic',
    force: true,
    sourceRole: sourceRoleOf(deprecatedBy),
    ...(createdBy ? { createdBy } : {}),
    payloadExtra: {
      observation,
      // Deprecate-specific metadata — a sibling of the generic observation shape,
      // for the Observations pane / future consumers (the digest clusters on
      // title/body/scope, not these).
      deprecateLearnings: {
        kind: DEPRECATE_LEARNINGS_OBSERVATION_KIND,
        planSlug,
        deprecatedBy,
        ...learnings,
      },
    },
  };
}

/** Injectable writer seam — unit tests run the emit with a fake captureImprovement. */
export interface DeprecateLearningsDeps {
  captureImprovement: typeof captureImprovement;
}

const defaultDeps: DeprecateLearningsDeps = { captureImprovement };

/**
 * Emit the structured, source-tagged learnings observation for a deprecated
 * draft. Thin: builds the input ({@link buildDeprecateLearningsObservation}) and
 * hands it to the shared observation writer. Callers: the deprecate handler
 * (plans:set-plan-status's superseded path) and a future Scout self-deprecate.
 */
export async function emitDeprecateLearnings(
  input: DeprecateLearningsInput,
  deps: DeprecateLearningsDeps = defaultDeps,
): Promise<CaptureImprovementResult> {
  return deps.captureImprovement(buildDeprecateLearningsObservation(input));
}
