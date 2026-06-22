/**
 * reduceSnapshotEvent — pure per-run snapshot map reducer for useStateSnapshots
 * (agent-tool-delta-protocol-2026-06-22, Lane D / P-009).
 *
 * Applies a wire event — a full `snapshot` or a data-carrying `delta` — to the
 * run→envelope map. Full snapshots win by version (monotonic, later wins). A delta
 * applies on top of the run's current envelope; if it can't (no base yet, or a
 * version gap → `applySnapshotDelta` returns null) the stale entry is KEPT untouched
 * — the next full snapshot / reconnect heals it. Never throws, never corrupts, and
 * returns the SAME map reference on a no-op so the React consumer skips a re-render.
 */
import { applySnapshotDelta, type SnapshotDelta, type VersionedSnapshot } from '@papercusp/agent-mcp';
import type { SnapshotEnvelope } from './use-state-snapshots';

export type SnapshotWireEvent =
  | { kind: 'snapshot'; env: SnapshotEnvelope }
  | { kind: 'delta'; delta: SnapshotDelta };

export function reduceSnapshotEvent(
  byRun: Map<string, SnapshotEnvelope>,
  event: SnapshotWireEvent,
): Map<string, SnapshotEnvelope> {
  if (event.kind === 'snapshot') {
    const { env } = event;
    const existing = byRun.get(env.runId);
    if (existing && existing.version >= env.version) return byRun; // stale / duplicate
    const next = new Map(byRun);
    next.set(env.runId, env);
    return next;
  }

  const { delta } = event;
  const base = byRun.get(delta.runId);
  if (!base) return byRun; // no base yet — wait for a full snapshot
  const applied = applySnapshotDelta(base as VersionedSnapshot, delta);
  if (!applied) return byRun; // version gap → keep stale; the next full / reconnect heals
  const next = new Map(byRun);
  next.set(delta.runId, { runId: applied.runId, version: applied.version, snapshot: applied.snapshot });
  return next;
}
