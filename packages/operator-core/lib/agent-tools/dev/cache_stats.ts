/**
 * dev:cache_stats — runtime observability for the operator read cache
 * (no-http-anywhere-2026-07-28 D-074).
 *
 * `cachedRead` has recorded per-tool hit/miss/stale/bypass/deadline counters
 * since it was written, and the shared `Cache` keeps its own hit/miss/build/
 * single-flight tallies — but NOTHING consumed either. `snapshotCachedReadStats`
 * was exported and re-exported at `cache/index.ts` and read by no caller, so
 * cache health was invisible in the running operator. That gap has a measured
 * cost: chasing P-007's parallelism ceiling, two successive root-cause
 * hypotheses (a 16-worker L1 split, then a tag-bust storm) were each formed by
 * INFERRING cache behaviour from response latency, and each was refuted — the
 * counters that would have settled it in one call existed the whole time.
 * Same fix, same reason as P-003(b), which published the concurrency gate's
 * live depth after a saturated gate proved unobservable from the running app.
 *
 * ⚠ PER-WORKER BY CONSTRUCTION. These counters live in ONE process's memory and
 * `:3070` runs a reuseport CLUSTER (PAPERCUSP_CLUSTER, 16 on this box), so a
 * single call is answered by whichever worker took the request and reports only
 * that worker's tallies. `pid` and `clusterSize` are returned so the numbers are
 * never read as fleet-wide, and `sampledWorkers` accumulates across repeat calls
 * so a caller can tell "I sampled one of 16" from "I sampled them all".
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { snapshotCachedReadStats } from '../../cache';

/** Workers observed across calls in THIS process's lifetime — see the pid caveat. */
const SEEN_PIDS = new Set<number>();

export default defineTool({
  name: 'dev:cache_stats',
  description:
    "Live operator READ-CACHE counters (cachedRead), per tool: hits/misses/stale/bypass/deadline + hitRatePct, sorted by traffic. ⚠ PER-WORKER: these live in one process's memory and :3070 is a reuseport cluster, so one call reports only the worker that answered it — read `pid`/`clusterSize`, and repeat-call to sample more (`sampledWorkers`). `bypass`>0 means the CACHE_LAYER kill-switch is off (nothing is being cached); `deadline`>0 means callers hit the cachedRead deadline and got the degraded value. A tool absent from `perTool` never called cachedRead at all — which is different from calling it and missing.",
  guidance: {
    when: "Diagnosing why a read is slow or a cache seems not to serve — read hit/miss here instead of inferring cache behaviour from response latency (that inference is unsound: a cheap query and a cache hit look identical, and it produced two refuted root causes on P-007). Also for confirming the CACHE_LAYER kill-switch state (`bypass`) and whether callers are hitting deadlines.",
    notWhen:
      'Sync-transport concurrency/queue depth — that is the gate probe (window.__sync_metrics__). DB-side cost of a cache MISS — dev:pg_query / pg_stat_statements.',
    seeAlso: ['dev:pg_health (pool + connection health)', 'dev:service_health (is the process up at all)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'curator'],
  args: z.object({
    tool: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Only this tool's row (e.g. 'plans:attention'). Omit for all."),
  }),
  async handler(args) {
    const pid = process.pid;
    SEEN_PIDS.add(pid);

    // `args` arrives undefined when every field is optional and the caller sends
    // an empty body — the shape the HTTP route (/api/agent-tools/dev/cache_stats)
    // produces, and the shape a bare tools:invoke produces. Found by exercising
    // this live on :3170; the unit tests all passed an object, so they could not
    // have caught it.
    const wanted = args?.tool;

    const snapshot = snapshotCachedReadStats();
    const rows = Object.entries(snapshot)
      .filter(([tool]) => (wanted ? tool === wanted : true))
      .map(([tool, s]) => {
        // Served-without-building = hits + stale (SWR returns the stale value
        // immediately and rebuilds in the background), so both count as "the
        // caller did not wait for a build".
        const served = s.hits + s.stale;
        const total = served + s.misses;
        return {
          tool,
          ...s,
          total,
          hitRatePct: total > 0 ? Number(((served / total) * 100).toFixed(1)) : null,
        };
      })
      .sort((a, b) => b.total - a.total);

    const clusterSize = Number(process.env.PAPERCUSP_CLUSTER ?? 1) || 1;
    const totals = rows.reduce(
      (acc, r) => ({
        hits: acc.hits + r.hits,
        misses: acc.misses + r.misses,
        stale: acc.stale + r.stale,
        bypass: acc.bypass + r.bypass,
        deadline: acc.deadline + r.deadline,
      }),
      { hits: 0, misses: 0, stale: 0, bypass: 0, deadline: 0 },
    );

    return {
      data: {
        ok: true,
        pid,
        clusterSize,
        sampledWorkers: SEEN_PIDS.size,
        perWorkerCaveat:
          clusterSize > 1
            ? `counters are THIS worker's only (pid ${pid}); ${clusterSize} workers serve :3070, so call repeatedly to sample others`
            : null,
        uptimeSec: Math.round(process.uptime()),
        toolCount: rows.length,
        totals,
        killSwitchLikelyOff: totals.bypass > 0 && totals.hits + totals.misses + totals.stale === 0,
        perTool: rows,
      },
    };
  },
});
