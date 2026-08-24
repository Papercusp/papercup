/**
 * leader-blocker-stall-alert — the pure P-009 detector for a blocking item
 * whose work has stopped moving.
 *
 * This module deliberately owns NO graph query, liveness read, clock, or
 * remediation. P-006 supplies ranked bottleneck rows from the canonical
 * dependency traversal; this evaluator only decides whether one measured row
 * has the incident shape P-009 names:
 *
 *   openBlockedCount >= 1
 *     AND (unowned OR holderLive === false)
 *     AND hoursSinceProgress >= thresholdHours
 *
 * Unknown is in-band. A missing graph count, holder identity/liveness, or
 * progress age must never become a false all-clear. Known negatives short-
 * circuit later unknowns: an item blocking zero open rows is not this alert,
 * and a live holder is not this alert even when its progress age was not read.
 *
 * The alert is observability only. It never claims, releases, reassigns,
 * resizes, or wakes anything (R7).
 */
import type { AlertFalsifier } from './agent-tools/fleet/leader-brief';

export const DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS = 4;

export type LeaderBlockerStallUnknownCode =
  | 'open-blocked-count-unmeasured'
  | 'holder-ownership-unmeasured'
  | 'holder-liveness-unmeasured'
  | 'progress-age-unmeasured';

export interface LeaderBlockerStallAlertInput {
  /** Stable plan-item or work-item identity named in the alert/falsifier. */
  itemRef: string;
  /** Fleet scope for the independent assignments-path falsifier. */
  fleet?: string | null;
  /** Number of currently-open downstream items blocked by this item. */
  openBlockedCount: number | null | undefined;
  /**
   * null = measured and unowned; string = measured owner; undefined = the
   * ownership leg did not resolve.
   */
  holderId: string | null | undefined;
  /** Required only when holderId is a string. null/undefined = unmeasured. */
  holderLive: boolean | null | undefined;
  /** Age of canonical item progress at the caller's as-of time. */
  hoursSinceProgress: number | null | undefined;
  /** Defaults to the existing four-hour leader-health age convention. */
  thresholdHours?: number;
}

export type LeaderBlockerStallAlertEvaluation =
  | {
      alert: true;
      thresholdHours: number;
      reason: string;
      falsifier: AlertFalsifier;
    }
  | {
      alert: false;
      thresholdHours: number;
      reason?: undefined;
      falsifier?: undefined;
    }
  | {
      alert: null;
      thresholdHours: number;
      reason: string;
      unknown: { code: LeaderBlockerStallUnknownCode };
      falsifier?: undefined;
    };

function measuredNonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeThresholdHours(value: number | undefined): number {
  return measuredNonNegative(value) ? value : DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS;
}

/** Match leader-brief's literal call style without importing it at runtime. */
function quoteFalsifierString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function buildBlockerStallFalsifier(
  itemRef: string,
  fleet: string | null | undefined,
  thresholdHours: number,
): AlertFalsifier {
  const fleetArg = fleet == null ? '' : `fleet: ${quoteFalsifierString(fleet)}, `;
  return {
    tool: 'fleet:assignments',
    check: `fleet:assignments { ${fleetArg}include_stale: true }`,
    measurement:
      `the roster/assignment path's live holder, last tool call, and claim-progress evidence for ${itemRef} ` +
      '— independent of the dependency-ranked bottleneck row that fired this alert',
    kills:
      `${itemRef} appears under a live speaking holder or its assignment/progress advanced within ` +
      `${thresholdHours} hour(s) → the ranked row's ownership/progress reading is stale; do not reclaim, ` +
      'wake, or reassign from this alert.',
  };
}

function unknown(
  thresholdHours: number,
  code: LeaderBlockerStallUnknownCode,
  detail: string,
): LeaderBlockerStallAlertEvaluation {
  return {
    alert: null,
    thresholdHours,
    unknown: { code },
    reason: `leader-blocker stall state is UNKNOWN: ${detail}`,
  };
}

/**
 * Evaluate one measured bottleneck row. Ordering is logical short-circuiting,
 * not severity: a known-false antecedent makes later evidence irrelevant,
 * while an unknown antecedent stays unknown instead of being rounded to false.
 */
export function computeLeaderBlockerStallAlert(input: LeaderBlockerStallAlertInput): LeaderBlockerStallAlertEvaluation {
  const thresholdHours = normalizeThresholdHours(input.thresholdHours);

  if (!measuredNonNegative(input.openBlockedCount)) {
    return unknown(
      thresholdHours,
      'open-blocked-count-unmeasured',
      'the canonical dependency traversal did not yield a finite non-negative open-blocked count.',
    );
  }
  if (input.openBlockedCount < 1) return { alert: false, thresholdHours };

  if (input.holderId === undefined) {
    return unknown(
      thresholdHours,
      'holder-ownership-unmeasured',
      'the holder leg did not distinguish an unowned item from an unresolved owner.',
    );
  }

  const unowned = input.holderId === null;
  if (!unowned) {
    if (input.holderLive == null) {
      return unknown(
        thresholdHours,
        'holder-liveness-unmeasured',
        `holder ${input.holderId} was resolved, but its live-session verdict was not measured.`,
      );
    }
    if (input.holderLive) return { alert: false, thresholdHours };
  }

  if (!measuredNonNegative(input.hoursSinceProgress)) {
    return unknown(
      thresholdHours,
      'progress-age-unmeasured',
      'the item has no finite non-negative hours-since-progress measurement.',
    );
  }
  if (input.hoursSinceProgress < thresholdHours) return { alert: false, thresholdHours };

  const holderReason = unowned ? 'unowned' : `held by non-live session ${input.holderId}`;
  return {
    alert: true,
    thresholdHours,
    reason:
      `${input.itemRef} blocks ${input.openBlockedCount} open item(s), is ${holderReason}, and has had ` +
      `no progress for ${input.hoursSinceProgress}h (threshold ${thresholdHours}h). Run the read-only ` +
      'falsifier before any reclaim, wake, or reassignment.',
    falsifier: buildBlockerStallFalsifier(input.itemRef, input.fleet, thresholdHours),
  };
}
