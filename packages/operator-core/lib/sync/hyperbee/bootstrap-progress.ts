/**
 * bootstrap-progress — Phase 5b P-066 data source.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * Tracks per-(workspaceId, harnessSlug) substrate-merge progress so
 * the BootstrapProgressIndicator can show applied versus known target progress.
 * Completion requires the applied head and frontier; idle time is never proof.
 *
 * Pure logic + a module-level Map. No PG, no FS. The substrate boot
 * code is expected to call `recordMergedOps` whenever a new op is
 * applied to a harness view; the indicator's polling endpoint reads
 * via `getBootstrapProgress`.
 *
 * Because the substrate hasn't wired its merge events into this yet,
 * the helper exposes `_resetForTests` + `_now` injection so the
 * tracker is fully testable on its own.
 */

import { createJoinProgressTracker, type JoinProgressSample, type JoinProgressTracker, type JoinState } from './join-progress';

export interface BootstrapProgressSnapshot {
  workspaceId: string;
  harnessSlug: string;
  /** Most-recently-recorded view length for this harness. */
  mergedOps: number;
  /** Highest value ever recorded for this harness (for back-fill races). */
  highestSeen: number;
  /** Epoch ms of the last recordMergedOps call. */
  lastChangeMs: number;
  /** True only when the join head and target frontier have been applied. */
  caughtUp: boolean;
  joinState: JoinState;
  targetFrontier: number;
  headApplied: boolean;
}

interface Entry {
  tracker: JoinProgressTracker;
  snapshot: BootstrapProgressSnapshot;
}

const tracker: Map<string, Entry> = new Map();

function key(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

let _nowImpl: () => number = () => Date.now();

/** Test seam — override Date.now() inside tests for determinism. */
export function _setNowForTests(impl: () => number): void {
  _nowImpl = impl;
}

export function _resetTrackerForTests(): void {
  tracker.clear();
  _nowImpl = () => Date.now();
}

/**
 * Record a fresh mergedOps count for a (workspace, harness). Idempotent:
 * passing the same count keeps the tracker stable but does NOT bump
 * lastChangeMs (so caught-up detection still fires).
 */
export function recordMergedOps(
  workspaceId: string,
  harnessSlug: string,
  mergedOps: number,
): void {
  // Count-only legacy callers cannot establish that a remote head has applied.
  recordJoinProgress(workspaceId, harnessSlug, {
    nowMs: _nowImpl(), headApplied: false, appliedFrontier: mergedOps, targetFrontier: mergedOps,
  });
}

/** The optional owner belongs to one booted handle, even when peers share a slug. */
export function recordJoinProgress(
  workspaceId: string,
  harnessSlug: string,
  sample: JoinProgressSample,
  owner?: JoinProgressTracker,
): BootstrapProgressSnapshot {
  const k = key(workspaceId, harnessSlug);
  const instance = owner ?? tracker.get(k)?.tracker ?? createJoinProgressTracker();
  const progress = instance.observe(sample);
  const snapshot: BootstrapProgressSnapshot = {
    workspaceId, harnessSlug,
    mergedOps: progress.appliedFrontier,
    highestSeen: progress.highestApplied,
    lastChangeMs: progress.lastAdvanceAtMs,
    caughtUp: progress.state === 'complete' && sample.headApplied &&
      sample.appliedFrontier >= sample.targetFrontier && sample.readyForCompletion !== false,
    joinState: progress.state,
    targetFrontier: progress.targetFrontier,
    headApplied: progress.headApplied,
  };
  tracker.set(k, { tracker: instance, snapshot });
  return { ...snapshot };
}

/** Remove only this handle's current view; a sibling handle may have published newer data. */
export function clearBootstrapProgress(workspaceId: string, harnessSlug: string, owner: JoinProgressTracker): void {
  const k = key(workspaceId, harnessSlug);
  if (tracker.get(k)?.tracker === owner) tracker.delete(k);
}

/**
 * Returns null when the harness has no recorded progress (substrate
 * never booted, or boot just started before any ops merged).
 */
export function getBootstrapProgress(
  workspaceId: string,
  harnessSlug: string,
): BootstrapProgressSnapshot | null {
  const entry = tracker.get(key(workspaceId, harnessSlug));
  return entry ? { ...entry.snapshot } : null;
}

/** Snapshot of every tracked harness. Used by the admin diagnostic page. */
export function listBootstrapProgress(): BootstrapProgressSnapshot[] {
  return [...tracker.values()].map((entry) => ({ ...entry.snapshot }));
}
