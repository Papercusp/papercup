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
import { createResilientEventSource } from '@restart/sse';

import type { OpenCardSnapshot } from '@papercusp/agent-mcp';

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
} {
  const [byRun, setByRun] = useState<Map<string, SnapshotEnvelope>>(() => new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = createResilientEventSource({
      url: '/api/operator/state-snapshot',
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      handlers: {
        snapshot: (data: unknown) => {
          const env = data as SnapshotEnvelope;
          if (!env || typeof env.runId !== 'string') return;
          setByRun((prev) => {
            const existing = prev.get(env.runId);
            // Versions are monotonic per run; later wins.
            if (existing && existing.version >= env.version) return prev;
            const next = new Map(prev);
            next.set(env.runId, env);
            return next;
          });
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

  return { cards, connected };
}
