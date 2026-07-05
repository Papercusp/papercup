/**
 * orient-shape.ts — payload-tier shapers for coord:orient
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * Why orient first: the 2026-07-01 fleet incident measured ONE unshaped orient
 * at ~43k tokens (~21% of a 200k window) — `claimable` full-fat work-item rows
 * (duplicated title+summary, UUID assignees, spelled-out nulls), `me.coverage`
 * spanning 37 plans, an inbox summarizing 3,327 unread. Six sonnet members died
 * within 3 tool calls.
 *
 * Shape contract (D-004): trimmed/standard PROJECT the same orientation —
 * nothing is silently dropped: every cap leaves a count + a fetch-pointer, and
 * a caller can always pass `payloadTier: 'full'` for the unshaped result.
 */

/** Per-tier caps. `standard` is a looser projection, not a different shape. */
const CAPS = {
  trimmed: { claimable: 8, title: 90, inbox: 5, inboxSummary: 140, memory: 3, memoryText: 220, events: 5, catchUp: 5, meChars: 2_400, facts: 8, factsBody: 200 },
  standard: { claimable: 15, title: 140, inbox: 8, inboxSummary: 240, memory: 5, memoryText: 400, events: 8, catchUp: 8, meChars: 6_000, facts: 14, factsBody: 400 },
} as const;

type TierName = keyof typeof CAPS;

const cap = (s: unknown, n: number): unknown =>
  typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Priority for keeping a standing fact when the count is capped: owner-scope
 *  (owner-walls / unverified claims) and this harness's facts are load-bearing;
 *  workspace-scope shared facts are the noisiest and drop first. Array.sort is
 *  stable, so within a rank the fold's original (recency) order is preserved. */
const FACT_SCOPE_RANK: Record<string, number> = { owner: 0, work_item: 1, harness: 1, role: 2, workspace: 3 };
const factRank = (f: unknown): number =>
  FACT_SCOPE_RANK[(f as { scope?: string } | null)?.scope ?? ''] ?? 2;

/** Project one claimable work-item row to its placement-relevant core.
 *  Drops the duplicated summary, null fields, timestamps, and the fat payload
 *  subtree; keeps the plan_item linkage (the "which lane" signal). */
function projectClaimable(row: unknown, titleCap: number): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  const planItem = (r.payload as Record<string, unknown> | undefined)?.plan_item;
  return {
    id: r.id,
    ...(r.kind ? { kind: r.kind } : {}),
    title: cap(r.title, titleCap),
    ...(r.state ? { state: r.state } : {}),
    ...(r.assignee ? { assignee: r.assignee } : {}),
    ...(r.severity ? { severity: r.severity } : {}),
    ...(planItem ? { plan_item: planItem } : {}),
  };
}

/** Project one inbox entry to glyph-line essentials. */
function projectInboxEntry(e: unknown, summaryCap: number): unknown {
  if (!e || typeof e !== 'object') return e;
  const r = e as Record<string, unknown>;
  return {
    ...(r.ts ? { ts: r.ts } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.from ? { from: r.from } : {}),
    summary: cap(r.summary ?? r.body, summaryCap),
  };
}

/** `me` arrives as fleet:assignments' inner result — commonly an opaque TOON
 *  string whose tail is a per-plan `coverage` listing (37 plans in the
 *  incident). Cut at the coverage marker (keep the self/summary/claims head),
 *  else cap by chars; either way leave a fetch-pointer. */
function trimMe(me: unknown, chars: number): unknown {
  if (typeof me !== 'string') return me;
  const covIdx = me.indexOf('\ncoverage');
  const cut = covIdx > 0 ? Math.min(covIdx, chars) : chars;
  if (me.length <= cut) return me;
  return `${me.slice(0, cut)}\n… (trimmed — full assignments+coverage via fleet:assignments, or payloadTier:'full')`;
}

/** Tier-project an OrientResult-shaped payload. Unknown fields pass through. */
export function shapeOrient(data: unknown, tier: TierName): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, unknown>;
  const c = CAPS[tier];

  const out: Record<string, unknown> = { ...d };
  out.payloadTier = tier;

  out.me = trimMe(d.me, c.meChars);

  if (Array.isArray(d.claimable)) {
    const total = d.claimable.length;
    out.claimable = d.claimable.slice(0, c.claimable).map((r) => projectClaimable(r, c.title));
    if (total > c.claimable) {
      out.claimableTruncated = { total, shown: c.claimable, more: 'work_items:list (or payloadTier:"full")' };
    }
  }

  // Standing facts are folded VERBATIM and grow unboundedly as agents assert
  // them (the coord:orient 59.8KB overflow, WI-2859). Cap count + body, keeping
  // owner/harness-scope facts first, with a fetch-pointer for the rest.
  if (Array.isArray(d.facts)) {
    const total = d.facts.length;
    const ranked = [...d.facts].sort((a, b) => factRank(a) - factRank(b));
    out.facts = ranked.slice(0, c.facts).map((f) =>
      f && typeof f === 'object' ? { ...(f as Record<string, unknown>), body: cap((f as Record<string, unknown>).body, c.factsBody) } : f,
    );
    if (total > c.facts) {
      out.factsTruncated = { total, shown: c.facts, more: 'facts:list' };
    }
  }

  const inbox = d.inbox as { summary?: unknown; recent?: unknown } | undefined;
  if (inbox && typeof inbox === 'object') {
    const recent = Array.isArray(inbox.recent) ? inbox.recent : [];
    out.inbox = {
      summary: inbox.summary,
      recent: recent.slice(-c.inbox).map((e) => projectInboxEntry(e, c.inboxSummary)),
      ...(recent.length > c.inbox ? { recentTruncated: { total: recent.length, shown: c.inbox, more: 'coord:inbox' } } : {}),
    };
  }

  const memory = d.memory as { query?: unknown; hits?: unknown[] } | null | undefined;
  if (memory && typeof memory === 'object' && Array.isArray(memory.hits)) {
    out.memory = {
      query: memory.query,
      hits: memory.hits.slice(0, c.memory).map((h) => {
        if (!h || typeof h !== 'object') return h;
        const r = h as Record<string, unknown>;
        return { ...r, memory: cap(r.memory, c.memoryText) };
      }),
      ...(memory.hits.length > c.memory ? { hitsTruncated: { total: memory.hits.length, shown: c.memory, more: 'memory:search' } } : {}),
    };
  }

  const events = d.planEvents as { total?: number; recent?: unknown[] } | null | undefined;
  if (events && typeof events === 'object' && Array.isArray(events.recent) && events.recent.length > c.events) {
    out.planEvents = { total: events.total, recent: events.recent.slice(-c.events), recentTruncated: { shown: c.events, more: 'coord:plan-events' } };
  }

  const catchUp = d.fleetCatchUp as { fleet?: unknown; total?: number; recent?: unknown[] } | null | undefined;
  if (catchUp && typeof catchUp === 'object' && Array.isArray(catchUp.recent) && catchUp.recent.length > c.catchUp) {
    out.fleetCatchUp = { ...catchUp, recent: catchUp.recent.slice(-c.catchUp), recentTruncated: { shown: c.catchUp, more: 'coord:catch-up' } };
  }

  return out;
}
