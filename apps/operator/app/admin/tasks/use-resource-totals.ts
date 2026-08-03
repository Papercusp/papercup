/**
 * Shared derivation for the Task Manager's live resource header (WI-7371).
 *
 * WHY A SHARED HOOK RATHER THAN A `useMemo` IN EACH VIEW: the header pill's popover
 * (`TasksRosterPanel`) and the admin page (`TasksClient`) render the same numbers, and
 * `TasksRunningPill` already carries a warning about WI-6844 — the bug where the pill and
 * the panel it opens disagreed because each derived its own figure. The totals themselves
 * come from one server-side fold; this keeps the one *client-side* derivation (the CPU
 * rate) single-sourced too.
 *
 * Layering: this lives under `apps/operator/app` on purpose. operator-vite may import from
 * apps/operator (forward dependency), never the reverse — so this is the only placement
 * both surfaces can reach.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  cpuBusyPercent,
  type TaskResourceTotals,
} from '@papercusp/operator-core/lib/task-manager/inventory';

export type ResourceHeader = {
  /** Σ RSS across tracked tasks. Upper bound — shared pages double-count. */
  rssBytesTotal: number;
  /** Cores-busy percent since the previous sample; `null` until two samples exist. */
  cpuBusyPct: number | null;
  /** True once a rate has been computed at least once (drives "measuring…" vs a value). */
  hasRate: boolean;
  /** How many tracked rows reported each metric, and how many were considered. */
  rssBytesKnown: number;
  cpuUsecKnown: number;
  rowsConsidered: number;
};

/**
 * Turn the server's cumulative totals into a renderable header.
 *
 * The CPU figure is a RATE derived from two successive samples — `cpuUsecTotal` is a
 * monotonic cgroup counter, so its raw sum is lifetime CPU-time and would be a lie if
 * labelled "usage". `cpuBusyPct` stays `null` (never 0) until a second sample arrives, and
 * reverts to `null` whenever the counter goes backwards, which happens legitimately every
 * time a task ends and leaves the row set. Rendering that as "0%" on a busy box is exactly
 * the absent-vs-zero conflation this codebase keeps paying for.
 */
export function useResourceTotals(res: TaskResourceTotals | null | undefined): ResourceHeader | null {
  const prevRef = useRef<TaskResourceTotals | null>(null);
  const [cpuBusyPct, setCpuBusyPct] = useState<number | null>(null);
  const [hasRate, setHasRate] = useState(false);

  const sampledAtMs = res?.sampledAtMs ?? 0;

  useEffect(() => {
    if (!res || !sampledAtMs) return;
    const prev = prevRef.current;
    // Idempotent under StrictMode's double-invoke: the same sample is a no-op.
    if (prev && prev.sampledAtMs === sampledAtMs) return;
    if (prev) {
      const pct = cpuBusyPercent(prev, res);
      setCpuBusyPct(pct);
      if (pct !== null) setHasRate(true);
    }
    prevRef.current = res;
  }, [res, sampledAtMs]);

  if (!res) return null;
  return {
    rssBytesTotal: res.rssBytesTotal,
    cpuBusyPct,
    hasRate,
    rssBytesKnown: res.rssBytesKnown,
    cpuUsecKnown: res.cpuUsecKnown,
    rowsConsidered: res.rowsConsidered,
  };
}

/** `1600%` reads better than `1600.00%`; sub-10% keeps one decimal so idle is legible. */
export function fmtCpuPct(pct: number | null): string {
  if (pct === null) return '—';
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/**
 * The tooltip both surfaces show. Stated explicitly because every number here is easy to
 * over-read: RSS double-counts shared pages, and CPU can legitimately exceed 100%.
 */
export function resourceTitle(h: ResourceHeader): { mem: string; cpu: string } {
  return {
    mem: `Σ RSS over ${h.rssBytesKnown} of ${h.rowsConsidered} tracked task(s). Upper bound — pages shared between processes are counted once per process.`,
    cpu: h.hasRate
      ? `Cores busy across ${h.cpuUsecKnown} of ${h.rowsConsidered} tracked task(s), since the previous sample. 100% = one core saturated.`
      : 'Needs two samples to compute a rate — waiting for the next refresh.',
  };
}
