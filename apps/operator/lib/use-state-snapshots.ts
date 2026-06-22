/**
 * useStateSnapshots — chat-surface hook that subscribes to
 * /api/operator/state-snapshot and tracks the union of open cards
 * across every active run in the workspace.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md
 *
 * Returns an array of OpenCardSnapshot[] flattened across runs, with
 * the runId attached so /card-response posts can include workspace.
 * Cards disappear when a run's snapshot's openCards no longer
 * contains them (resolve / decline / cancel / run-end).
 *
 * Note: this hook does NOT itself render — it produces the data
 * stream. The renderer (OperatorChat, OracleDock) chooses how to
 * display the queue and which card to show first.
 */

'use client';

import { useEffect, useState, useMemo } from 'react';
import { createResilientEventSource } from '@papercusp/sse';

import type { OpenCardSnapshot, SnapshotDelta } from '@papercusp/agent-mcp';
import { reduceSnapshotEvent } from './snapshot-reducer';

export interface SnapshotEnvelope {
  runId: string;
  version: number;
  snapshot: {
    openCards: OpenCardSnapshot[];
    toolState?: unknown;
  };
}

export interface OpenCardWithRun extends OpenCardSnapshot {
  /** The runId that owns this card — needed for /card-response. */
  runId: string;
}

function isValidSnapshotEnvelope(data: unknown): data is SnapshotEnvelope {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<SnapshotEnvelope>;
  if (typeof d.runId !== 'string' || d.runId.length === 0) return false;
  if (typeof d.version !== 'number' || !Number.isFinite(d.version)) return false;
  if (!d.snapshot || typeof d.snapshot !== 'object') return false;
  if (!Array.isArray(d.snapshot.openCards)) return false;
  return true;
}

/** Minimal shape guard for a P-009 data-carrying delta (drops malformed deltas
 *  rather than letting a bad apply throw in the React render). */
function isValidSnapshotDelta(data: unknown): data is SnapshotDelta {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<SnapshotDelta>;
  return (
    typeof d.runId === 'string' &&
    d.runId.length > 0 &&
    typeof d.baseVersion === 'number' &&
    typeof d.version === 'number' &&
    Array.isArray(d.cards) &&
    Array.isArray(d.order)
  );
}

/**
 * Subscribes to /api/operator/state-snapshot. Returns:
 *   - cards: flattened OpenCardWithRun[] across all runs, ordered by
 *     (runId, createdAt). Empty until the first snapshot arrives.
 *   - connected: true once the EventSource is open.
 *
 * The hook owns one EventSource for its lifetime. Caller controls
 * when to mount it by gating with a conditional render.
 */
export function useStateSnapshots(): {
  cards: OpenCardWithRun[];
  connected: boolean;
  byRun: Map<string, SnapshotEnvelope>;
} {
  const [byRun, setByRun] = useState<Map<string, SnapshotEnvelope>>(() => new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = createResilientEventSource({
      url: '/api/operator/state-snapshot',
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      handlers: {
        snapshot: (raw) => {
          // @papercusp/sse hands handlers the raw event data string; parse here.
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch {
            console.warn('[useStateSnapshots] non-JSON snapshot payload', raw);
            return;
          }
          // Defensive validation: any field-level malformation here
          // would crash the React render downstream when it iterates
          // openCards. Drop the event on a shape mismatch — server-side
          // bugs shouldn't take the chat surface offline.
          if (!isValidSnapshotEnvelope(parsed)) {
            // eslint-disable-next-line no-console
            console.warn('[useStateSnapshots] dropping malformed snapshot', parsed);
            return;
          }
          setByRun((prev) => reduceSnapshotEvent(prev, { kind: 'snapshot', env: parsed }));
        },
        // P-009 data-carrying delta (received only when the stream is opened with
        // ?delta=1). reduceSnapshotEvent applies it on top of the run's current
        // envelope and keeps the stale entry on any version gap, so a bad/late delta
        // can never corrupt or crash the card map.
        delta: (raw) => {
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch {
            // eslint-disable-next-line no-console
            console.warn('[useStateSnapshots] non-JSON delta payload', raw);
            return;
          }
          if (!isValidSnapshotDelta(parsed)) {
            // eslint-disable-next-line no-console
            console.warn('[useStateSnapshots] dropping malformed delta', parsed);
            return;
          }
          setByRun((prev) => reduceSnapshotEvent(prev, { kind: 'delta', delta: parsed }));
        },
      },
    });
    return () => source.close();
  }, []);

  const cards = useMemo<OpenCardWithRun[]>(() => {
    const out: OpenCardWithRun[] = [];
    // Iterate runs in insertion order for determinism; within a run,
    // openCards is already in createdAt order from the correlator.
    for (const env of byRun.values()) {
      for (const c of env.snapshot.openCards) {
        out.push({ ...c, runId: env.runId });
      }
    }
    return out;
  }, [byRun]);

  return { cards, connected, byRun };
}

/**
 * Selector helper: from a useStateSnapshots() result, extract
 * (runId → toolState) for runs that have a published toolState.
 * Pure function (no hook); does not open a second EventSource.
 *
 * Usage:
 *   const snaps = useStateSnapshots();
 *   const states = selectToolStates(snaps.byRun);
 */
export function selectToolStates(
  byRun: Map<string, SnapshotEnvelope>,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const env of byRun.values()) {
    if (env.snapshot.toolState !== undefined) {
      out.set(env.runId, env.snapshot.toolState);
    }
  }
  return out;
}
