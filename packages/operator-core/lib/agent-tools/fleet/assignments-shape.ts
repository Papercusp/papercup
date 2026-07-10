/**
 * fleet:assignments payload-tier shapers (context-trimming-tiers-2026-07-01
 * P-022). 7d MCP telemetry: avg 6KB × 1,157 calls — the Queen/overwatch
 * placement poll. The fat is per-agent claims[] (16 fields/claim), the
 * queued[] work-list, and the coverage[] links table.
 *
 * Trimmed = the placement decision core: summary + reclaimables (orphaned/
 * stalled ARE the point of the tool — kept, capped) + one compact row per
 * agent (doing/load/intent), coverage collapsed to a count + note. Standard
 * restores a projected coverage table and wider agent rows.
 *
 * Contract (D-004): uniform keys per tier, visible truncation notices,
 * `summary` verbatim (the counts contract; the result-aware seeAlso reads
 * summary.orphaned_claims/stalled_claims).
 */

export const ASSIGNMENTS_TIER_CAPS = {
  trimmed: { agents: 40, intent: 80, reclaim: 20, doing: 70 },
  standard: { agents: 80, intent: 160, reclaim: 40, doing: 110, coverage: 40 },
} as const;

type AssignTier = keyof typeof ASSIGNMENTS_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** One compact "id title…" cell from a work-list entry (doing/queued rows). */
function workRef(v: unknown, max: number): string | null {
  if (!v || typeof v !== "object") return null;
  const w = v as { id?: unknown; title?: unknown; status?: unknown };
  const title = typeof w.title === "string" ? w.title : "";
  return clip(`${String(w.id ?? "?")} ${title}`.trim(), max);
}

export function shapeFleetAssignments(data: unknown, tier: AssignTier): unknown {
  const d = data as
    | ({
        agents?: unknown[];
        orphaned?: unknown[];
        stalled?: unknown[];
        coverage?: unknown[];
        coverage_collisions?: unknown[];
      } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.agents)) return data;
  const c = ASSIGNMENTS_TIER_CAPS[tier];

  const projectAgent = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const claims = Array.isArray(r.claims) ? r.claims : [];
    const base = {
      agentId: r.agentId ?? null,
      alive: r.alive === true,
      // EI-6077: the coordinator-facing session state (live|parked|ended|recorded),
      // derived from wakeability — surfaced alongside `alive` so a caller can tell
      // "really runnable" from "just looks alive" without a second coord:presence
      // call. null when the wakeability read was unavailable (state unknown).
      sessionState: typeof r.sessionState === "string" ? r.sessionState : null,
      // EI-8995: the single derived lifecycle verdict (booted|joined|first-turn-
      // done|speaking|stalled|dead) + the member's wake mode (a MANUAL member
      // silently stages directed wakes) — the leader's relaunch/re-steer read,
      // kept at EVERY tier (two short strings; the monitor loop runs trimmed).
      verdict: typeof r.verdict === "string" ? r.verdict : null,
      wakeMode: typeof r.wakeMode === "string" ? r.wakeMode : null,
      intent: clip(r.intent, c.intent),
      plan: r.declaredPlanSlug ?? null,
      fleet: r.fleetSlug ?? null,
      claims: claims.length,
      doing: workRef(r.doing, c.doing),
      load: typeof r.load === "number" ? r.load : 0,
      isSelf: r.isSelf === true,
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      label: r.label ?? null,
      // EI-8995: the raw freshness timestamp behind `verdict` (standard+ only).
      lastToolCallAt: typeof r.lastToolCallAt === "string" ? r.lastToolCallAt : null,
      orphaned: r.orphaned === true,
      stalled: r.stalled === true,
      declaredUnclaimed: r.declaredUnclaimed === true,
      queued: Array.isArray(r.queued) ? r.queued.length : 0,
      claimRefs:
        claims
          .slice(0, 8)
          .map((cl) => {
            const x = (cl ?? {}) as { id?: unknown; planSlug?: unknown };
            return x.planSlug ? `${String(x.planSlug)}#${String(x.id ?? "?")}` : String(x.id ?? "?");
          })
          .join(",") || null,
    };
  };

  const capList = (list: unknown[] | undefined, cap: number) => {
    const arr = Array.isArray(list) ? list : [];
    return {
      rows: arr.slice(0, cap),
      note: arr.length > cap ? `showing ${cap} of ${arr.length}` : null,
    };
  };
  const orphaned = capList(d.orphaned, c.reclaim);
  const stalled = capList(d.stalled, c.reclaim);
  // Coverage collisions (EI-6074) are a reclaimable-grade coordination smell —
  // kept (capped) at every tier like orphaned/stalled, since the whole point is
  // the Queen sees the cross-table duplicate without a full-payload read.
  const collisions = capList(d.coverage_collisions, c.reclaim);

  const agents = d.agents.slice(0, c.agents).map(projectAgent);
  if (d.agents.length > c.agents) {
    agents.push({
      ...projectAgent({}),
      agentId: "(truncated)",
      intent: `showing ${c.agents} of ${d.agents.length} — narrow with agent/plan/harness, or payloadTier:"full"`,
    });
  }

  const coverage = Array.isArray(d.coverage) ? d.coverage : [];
  const coverageOut =
    tier === "standard"
      ? {
          coverage: coverage
            .slice(0, (c as { coverage?: number }).coverage ?? 40)
            .map((entry) => {
              const e = (entry ?? {}) as Record<string, unknown>;
              return {
                plan: e.plan ?? null,
                item: e.item ?? null,
                level: e.level ?? null,
                workers: Array.isArray(e.workers) ? e.workers.map(String).join(",") || null : null,
              };
            }),
        }
      : coverage.length > 0
        ? {
            coverage_note: `coverage table (${coverage.length} rows) omitted at trimmed tier — payloadTier:"standard"/"full", or narrow with {plan}`,
          }
        : {};

  // DAG-filter frontier (includeDag, EI-6949): the caller opted in, so NEVER
  // silently drop it. Standard/full carry the full frontier; trimmed collapses to
  // the counts + a visible note (the item list can be large), mirroring coverage.
  const dag = (d as { dag?: unknown }).dag;
  const dagOut =
    dag && typeof dag === "object"
      ? tier === "standard"
        ? { dag }
        : {
            dag_counts: (dag as { counts?: unknown }).counts ?? null,
            dag_note: `dag frontier items omitted at trimmed tier — payloadTier:"standard"/"full"`,
          }
      : {};

  return {
    ok: d.ok ?? true,
    ...(d.self !== undefined ? { self: d.self } : {}),
    summary: d.summary ?? null,
    orphaned: orphaned.rows,
    ...(orphaned.note ? { orphaned_note: orphaned.note } : {}),
    stalled: stalled.rows,
    ...(stalled.note ? { stalled_note: stalled.note } : {}),
    ...(collisions.rows.length ? { coverage_collisions: collisions.rows } : {}),
    ...(collisions.note ? { coverage_collisions_note: collisions.note } : {}),
    ...coverageOut,
    ...dagOut,
    agents,
  };
}
