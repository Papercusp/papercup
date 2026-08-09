/**
 * tool-sequence-patterns.ts — mine the ORDERED tool-call dances that recur across
 * distinct agents, so a pattern a dozen agents each rediscover can become one
 * reusable thing (okf-frontmatter-adoption-2026-08-08 §D).
 *
 * This is the INPUT-WIDENING half of workstream D. The recipe graduation layer
 * (code-recipes-candidates.ts) already scores repetition and clusters
 * near-duplicates, but it only ever sees SAVED code:run scripts — while the
 * repetition actually worth capturing is in the tool-call sequences agents
 * perform without ever saving anything. `tool_invocations` has recorded those
 * all along. Deliberately NOT a second synthesizer: this module produces
 * candidates and hands them to the existing scorer (§10 names a parallel
 * synthesizer as the mistake).
 *
 * The counting is delegated to @papercusp/sequence-patterns, which is
 * domain-free. Everything here is the part that is NOT generic: how this
 * particular table encodes "an agent decided to do something".
 *
 * ── THE PROVENANCE RULE, and why it is the whole ballgame ──────────────────
 *
 * Three facts about `tool_invocations`, each measured on live data 2026-08-09
 * (papercusp-workspace) rather than assumed, and each one fatal to the obvious
 * implementation:
 *
 *  1. `spawn_id` IS NOT A SESSION. It is per-REQUEST (`ephemeral-<hash>`) —
 *     572,435 of them across 607,140 rows in 7d, ~1.06 rows each. Grouping a
 *     "session" by it yields sequences of length one.
 *
 *  2. The agent is `coord_owner_id`, and its stream must be SEGMENTED. An
 *     agent's 7-day history is not one sequence; adjacency across an idle hour
 *     is not adjacency. Hence the burst gap.
 *
 *  3. `transport` ENCODES WHO DECIDED. `mcp` = the agent called it over the
 *     wire. `in_process` = a TOOL IMPLEMENTATION called it. `coord:orient`
 *     fans out to ~10 in_process calls (memory:search, coord:whoami,
 *     coord:plan-events, …) under its own spawn_id, and the parent row is
 *     written LAST, after its children complete.
 *
 *     Miss (3) and the miner's top "patterns" are the internals of ONE tool
 *     that already exists — it would confidently propose promoting
 *     `coord:orient`'s own guts into a new tool. Measured: `memory:search →
 *     coord:whoami → coord:plan-events` appeared across 52 distinct agents,
 *     ranking 15th overall, and every one of those was coord:orient's fan-out.
 *
 * A caution earned the expensive way, because the SAME pair of conditions is
 * already wired into the promotion rubric and silently cancels out there: the
 * existing `toolCooccurrence` miner (dev-data.ts) filters `transport='mcp'` and
 * THEN groups by `spawn_id` — but the rows that share a spawn are exactly the
 * `in_process` ones the filter just removed. Measured over 24h: 53,295 spawns,
 * 998 (1.9%) with ≥2 tools, and every top "co-occurrence" was a dispatcher and
 * the thing it dispatched. Filter and grouping key must be chosen together.
 *
 * ── ONE SPAWN IS ONE DECISION ──────────────────────────────────────────────
 *
 * Several `mcp` rows can still share a spawn when the agent's call dispatches
 * others (`code:run` running a script that calls three tools; `tools:invoke`
 * dispatching one). Those are ONE agent decision, so a spawn contributes ONE
 * event: the OUTERMOST call, which is the last-written row (a wrapper completes
 * after its children). `code:run` is genuinely that decision — the agent chose
 * to run a script. `tools:invoke` is not: it is pure dispatch, and the intent is
 * the tool it names, so it is unwrapped (see {@link DEFAULT_DISPATCHER_TOOLS}).
 *
 * Server-only. Transport-agnostic: takes the `sql` handle like its siblings.
 */
import type postgres from 'postgres';
import {
  minePatternsFromEvents,
  type SequenceEvent,
  type MinedPattern,
} from '@papercusp/sequence-patterns';

/**
 * Tools that are PURE DISPATCH — the agent's intent is the tool they name, not
 * the call itself, so they are unwrapped to the inner call sharing their spawn.
 * `code:run` is deliberately absent: running a script IS the decision, and the
 * script's internal calls are implementation, not intent.
 */
export const DEFAULT_DISPATCHER_TOOLS = ['tools:invoke'] as const;

export interface ToolSequenceOpts {
  /** Workspace to mine (required — the table is multi-tenant). */
  workspaceId: string;
  /** Optional harness scope. Omitted ⇒ every harness in the workspace. */
  harnessSlug?: string;
  /** Lookback window in hours (default 168 = 7d, max 720). */
  hours?: number;
  /** Idle gap that ends a burst, in seconds (default 120). */
  gapSec?: number;
  /** Distinct-agent floor — the "ours, not mine" gate (default 3). */
  minAgents?: number;
  /** Total-occurrence floor (default 5). */
  minOccurrences?: number;
  /** Lift floor — rejects ambient telemetry (default 3). */
  minLift?: number;
  /** Longest dance to mine (default 5). */
  maxLength?: number;
  /** Max patterns returned (default 25). */
  limit?: number;
  /** Row cap pulled from PG before mining (default 200k) — bounds memory. */
  maxRows?: number;
  /** Override the pure-dispatch set. */
  dispatcherTools?: readonly string[];
}

/** One mined dance, in the shape the recipe scorer's rubric can read. */
export interface ToolSequenceCandidate {
  /** Stable kebab id derived from the tool sequence — the recipe-id shape. */
  id: string;
  /** The ordered tool names. */
  toolsUsed: string[];
  /** How many times the dance occurred. */
  occurrences: number;
  /** How many DISTINCT agents performed it — the reuse-breadth signal. */
  distinctAgents: number;
  /** A bounded sample of those agent ids, as evidence. */
  agentSample: string[];
  /** Distinct bursts it appeared in. */
  bursts: number;
  /** observed / expected-under-independence. ~1 = ambient; >>1 = a real dance. */
  lift: number;
  /** Human-readable rendering, for a work-item body or a log line. */
  label: string;
}

export interface ToolSequenceResult {
  candidates: ToolSequenceCandidate[];
  stats: {
    rowsRead: number;
    /** Rows dropped as `in_process` — a tool implementation's calls, not an agent's. */
    droppedNonAgent: number;
    /** Rows collapsed because they shared a spawn with an outer call. */
    collapsedInnerCalls: number;
    /** Agent decisions actually mined, after the collapse. */
    decisions: number;
    agents: number;
    bursts: number;
    distinctTools: number;
    candidatesConsidered: number;
    rejected: { occurrences: number; cohorts: number; lift: number; subsumed: number };
    /** True when the row cap was hit — the window is then a SAMPLE, not the whole period. */
    truncated: boolean;
  };
}

type InvocationRow = {
  agent: string;
  tool_name: string;
  spawn_id: string;
  invoked_at: Date | string;
};

const asMs = (v: Date | string): number => (typeof v === 'string' ? Date.parse(v) : v.getTime());

/** Kebab id for a tool sequence, matching the recipe-id shape (`ns:verb` → `ns-verb`). */
export function sequenceId(tools: readonly string[]): string {
  return tools
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .join('--');
}

/**
 * Collapse each spawn to the ONE agent decision it represents: the outermost
 * (last-written) call, unwrapping a pure dispatcher to the inner call it names.
 *
 * Exported for unit test without PG — this is the step that carries the
 * provenance rule, so it is the step most worth testing directly.
 */
export function collapseSpawnsToDecisions(
  rows: readonly InvocationRow[],
  dispatcherTools: readonly string[] = DEFAULT_DISPATCHER_TOOLS,
): { events: SequenceEvent[]; collapsed: number } {
  const dispatchers = new Set(dispatcherTools);
  const bySpawn = new Map<string, InvocationRow[]>();
  for (const r of rows) {
    const list = bySpawn.get(r.spawn_id);
    if (list) list.push(r);
    else bySpawn.set(r.spawn_id, [r]);
  }

  const events: SequenceEvent[] = [];
  let collapsed = 0;
  for (const [, list] of bySpawn) {
    list.sort((a, b) => asMs(a.invoked_at) - asMs(b.invoked_at));
    collapsed += list.length - 1;
    // Walk inward from the outermost row past any pure dispatcher.
    let idx = list.length - 1;
    while (idx > 0 && dispatchers.has(list[idx]!.tool_name)) idx--;
    const chosen = list[idx]!;
    events.push({
      symbol: chosen.tool_name,
      cohort: chosen.agent,
      // Anchor the decision at the OUTERMOST row's time: that is when the
      // agent's call completed, so consecutive decisions order correctly even
      // when an inner call started much earlier.
      at: asMs(list[list.length - 1]!.invoked_at),
    });
  }
  return { events, collapsed };
}

/** Render a mined pattern as a candidate the recipe rubric can score. */
function toCandidate(p: MinedPattern): ToolSequenceCandidate {
  return {
    id: sequenceId(p.symbols),
    toolsUsed: p.symbols,
    occurrences: p.occurrences,
    distinctAgents: p.cohorts,
    agentSample: p.cohortSample,
    bursts: p.bursts,
    lift: Math.round(p.lift * 10) / 10,
    label: p.symbols.join(' → '),
  };
}

/**
 * Mine the recurring cross-agent tool dances for a workspace.
 *
 * Deterministic given the same rows and options. Read-only.
 */
export async function mineToolSequences(
  sql: postgres.Sql,
  opts: ToolSequenceOpts,
): Promise<ToolSequenceResult> {
  const hours = Math.max(1, Math.min(720, opts.hours ?? 168));
  const maxRows = Math.max(1000, Math.min(1_000_000, opts.maxRows ?? 200_000));
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const harnessFrag = opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``;

  // Provenance filter lives HERE, in the query: only the agent's own calls.
  // `in_process` rows are a tool implementation's fan-out (see the module
  // docstring) and must never enter the sequence.
  const rows = (await sql`
      SELECT coord_owner_id AS agent, tool_name, spawn_id, invoked_at
        FROM harness_shared.tool_invocations
       WHERE invoked_at > ${sinceIso}::timestamptz
         AND workspace_id = ${opts.workspaceId}
         ${harnessFrag}
         AND transport = 'mcp'
         AND status = 'ok'
         AND coord_owner_id IS NOT NULL
         AND spawn_id IS NOT NULL AND spawn_id <> ''
       ORDER BY invoked_at
       LIMIT ${maxRows}
  `) as unknown as InvocationRow[];

  const { events, collapsed } = collapseSpawnsToDecisions(
    rows,
    opts.dispatcherTools ?? DEFAULT_DISPATCHER_TOOLS,
  );

  const mined = minePatternsFromEvents(
    events,
    { gapMs: (opts.gapSec ?? 120) * 1000, minBurstLength: 2 },
    {
      minLength: 2,
      maxLength: opts.maxLength ?? 5,
      minOccurrences: opts.minOccurrences ?? 5,
      minCohorts: opts.minAgents ?? 3,
      minLift: opts.minLift ?? 3,
      maximalOnly: true,
    },
  );

  return {
    candidates: mined.patterns.slice(0, opts.limit ?? 25).map(toCandidate),
    stats: {
      rowsRead: rows.length,
      // Every row read is already agent-initiated (the query filters
      // in_process out), so this is reported as 0 rather than inferred — an
      // honest 0 beats a number that looks measured and is not.
      droppedNonAgent: 0,
      collapsedInnerCalls: collapsed,
      decisions: events.length,
      agents: mined.stats.cohorts,
      bursts: mined.stats.bursts,
      distinctTools: mined.stats.distinctSymbols,
      candidatesConsidered: mined.stats.candidatesConsidered,
      rejected: mined.stats.rejected,
      truncated: rows.length >= maxRows,
    },
  };
}
