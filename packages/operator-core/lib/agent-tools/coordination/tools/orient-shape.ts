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
  trimmed: { claimable: 8, title: 90, inbox: 5, inboxSummary: 140, memory: 3, memoryText: 220, events: 5, eventText: 220, catchUp: 5, meChars: 2_400, facts: 8, factsBody: 200, paneContext: 2_400, briefMembers: 6, briefLists: 5, briefReason: 240 },
  standard: { claimable: 15, title: 140, inbox: 8, inboxSummary: 240, memory: 5, memoryText: 400, events: 8, eventText: 500, catchUp: 8, meChars: 6_000, facts: 14, factsBody: 400, paneContext: 6_000, briefMembers: 12, briefLists: 10, briefReason: 500 },
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

/** Priority for keeping a fleet member when the roster is capped (EI-19314271768708528).
 *  A leader reads `leaderBrief` to find the members that need INTERVENTION, so a naive
 *  head-slice is not merely lossy — it is inverted: on an 11-member fleet with a cap of
 *  6 it can show six healthy workers and hide the one dead member, which is the same
 *  silent-drop class this whole shaper exists to prevent. Rank the actionable rows
 *  first; healthy working members are the droppable bulk. Array.sort is stable, so the
 *  brief's own ordering is preserved within a rank. */
function briefMemberRank(m: unknown): number {
  const r = (m ?? {}) as Record<string, unknown>;
  const state = String(r.sessionState ?? '');
  const verdict = String(r.verdict ?? '');
  // Gone or wedged — the leader must relaunch/reclaim.
  if (r.stalled === true || verdict === 'dead' || verdict === 'stalled' || state === 'ended' || state === 'suspect') return 0;
  // About to compact, or sitting on an unanswered directed question.
  const unanswered = (r.unanswered as { count?: number } | undefined)?.count ?? 0;
  const pressure = String(r.contextPressure ?? '');
  if (pressure === 'critical' || pressure === 'high' || unanswered > 0) return 1;
  // Idle next to claimable work, benched, or dormant — recoverable throughput.
  if (r.benchSuggestion != null || r.dormant === true) return 2;
  return 3;
}

/** Project one leaderBrief member row. Keeps every field a leader ACTS on
 *  (liveness, claim, pressure, bench advice) and caps the two unbounded legs:
 *  `benchSuggestion.reason` is a ~450-char paragraph repeated per idle member, and
 *  `unanswered.newest` carries whole message bodies (already depth-omitted upstream). */
function projectBriefMember(m: unknown, titleCap: number, reasonCap: number): unknown {
  if (!m || typeof m !== 'object') return m;
  const r = m as Record<string, unknown>;
  const doing = r.doing as Record<string, unknown> | null | undefined;
  const unanswered = r.unanswered as Record<string, unknown> | null | undefined;
  const bench = r.benchSuggestion as Record<string, unknown> | null | undefined;
  return {
    agentId: r.agentId,
    ...(r.label ? { label: r.label } : {}),
    ...(r.fleetRole ? { fleetRole: r.fleetRole } : {}),
    ...(r.sessionState ? { sessionState: r.sessionState } : {}),
    ...(r.verdict ? { verdict: r.verdict } : {}),
    ...(r.wakeMode ? { wakeMode: r.wakeMode } : {}),
    ...(r.stalled === true ? { stalled: true } : {}),
    ...(r.dormant === true ? { dormant: true } : {}),
    ...(r.contextPressure ? { contextPressure: r.contextPressure } : {}),
    ...(typeof r.load === 'number' ? { load: r.load } : {}),
    ...(typeof r.queuedCount === 'number' ? { queuedCount: r.queuedCount } : {}),
    ...(typeof r.lastToolCallAgeMs === 'number' ? { lastToolCallAgeMs: r.lastToolCallAgeMs } : {}),
    ...(r.nextFireAt ? { nextFireAt: r.nextFireAt } : {}),
    ...(Array.isArray(r.workItemIds) ? { workItemIds: r.workItemIds } : {}),
    ...(doing ? { doing: { id: doing.id, title: cap(doing.title, titleCap), ...(doing.status ? { status: doing.status } : {}) } } : {}),
    // parkedOn is how a leader distinguishes "correctly parked on a gate" from "idle".
    ...(r.parkedOn != null ? { parkedOn: r.parkedOn } : {}),
    ...(r.parkedOnResolved != null ? { parkedOnResolved: r.parkedOnResolved } : {}),
    ...(unanswered ? { unanswered: { count: unanswered.count, ...(unanswered.oldestAgeMs != null ? { oldestAgeMs: unanswered.oldestAgeMs } : {}) } } : {}),
    ...(bench ? { benchSuggestion: { kind: bench.kind, ...(bench.item != null ? { item: bench.item } : {}), reason: cap(bench.reason, reasonCap) } } : {}),
    ...(r.isSelf === true ? { isSelf: true } : {}),
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

/** Project noisy coord/feed-ish entries. Plan-event `before`/`after` fields can
 * carry whole plan lines or `## Now` bodies; keep identity/routing fields intact
 * and cap the prose fields so a small number of events cannot dominate orient. */
function projectEventEntry(e: unknown, textCap: number): unknown {
  if (!e || typeof e !== 'object') return e;
  const out: Record<string, unknown> = { ...(e as Record<string, unknown>) };
  for (const key of ['summary', 'detail', 'before', 'after', 'text', 'body']) {
    if (key in out) out[key] = cap(out[key], textCap);
  }
  return out;
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
    // fold #2 (compaction-fold-audit-2026-07-06): a post-compaction orient (recovery
    // block present ⇒ afterCompaction) carries a deliberately BEEFED inbox — a
    // just-compacted agent lost its message context. Relax the inbox re-cap so the
    // shaper doesn't re-truncate away the very entries/bodies the fold added; every
    // other leg keeps its per-tier cap.
    const afterCompaction = d.recovery != null;
    const inboxCap = afterCompaction ? Math.max(c.inbox, 20) : c.inbox;
    const inboxSummaryCap = afterCompaction ? Math.max(c.inboxSummary, 700) : c.inboxSummary;
    const recent = Array.isArray(inbox.recent) ? inbox.recent : [];
    const projectedRecent = recent.slice(-inboxCap).map((e) => projectInboxEntry(e, inboxSummaryCap));
    out.inbox = {
      summary: inbox.summary,
      recent: projectedRecent,
      // EI-18667514339699744: keep `entries` aliased to the SAME projected/capped
      // array as `recent` through tier-shaping too — reconstructing `inbox` here
      // without it would silently re-drop the alias for trimmed/standard sessions
      // (the common fleet-member case) even after coord:orient/coord:inbox added it.
      entries: projectedRecent,
      ...(recent.length > inboxCap ? { recentTruncated: { total: recent.length, shown: inboxCap, more: 'coord:inbox' } } : {}),
    };
  }

  const memory = d.memory as
    | { query?: unknown; hits?: unknown[]; degraded?: unknown; degradedReason?: unknown; withheld?: unknown; filteredLowScore?: unknown; withheldBudget?: unknown; note?: unknown }
    | null
    | undefined;
  if (memory && typeof memory === 'object' && Array.isArray(memory.hits)) {
    out.memory = {
      query: memory.query,
      hits: memory.hits.slice(0, c.memory).map((h) => {
        if (!h || typeof h !== 'object') return h;
        const r = h as Record<string, unknown>;
        return { ...r, memory: cap(r.memory, c.memoryText) };
      }),
      ...(memory.hits.length > c.memory ? { hitsTruncated: { total: memory.hits.length, shown: c.memory, more: 'memory:search' } } : {}),
      // EI-9031: carry the LOUD scalar markers through tier-shaping — a trimmed/
      // standard session (a fleet member — the exact case this ticket reports) must
      // still see `degraded` so an empty `hits` isn't read as an informative empty
      // during an embedding-backend outage. `withheld`/`filteredLowScore` are the
      // same class of loud marker and were being silently dropped here too.
      ...(memory.degraded === true ? { degraded: true } : {}),
      ...(typeof memory.degradedReason === 'string' ? { degradedReason: memory.degradedReason } : {}),
      ...(typeof memory.withheld === 'number' ? { withheld: memory.withheld } : {}),
      ...(typeof memory.filteredLowScore === 'number' ? { filteredLowScore: memory.filteredLowScore } : {}),
      // orient-recall-quality P-002/P-003: same loud-marker class — the budget
      // drop count and the non-exhaustive advisory must reach trimmed sessions
      // (fleet members are exactly who acts on them).
      ...(typeof memory.withheldBudget === 'number' ? { withheldBudget: memory.withheldBudget } : {}),
      ...(typeof memory.note === 'string' ? { note: memory.note } : {}),
    };
  }

  const events = d.planEvents as { total?: number; recent?: unknown[] } | null | undefined;
  if (events && typeof events === 'object' && Array.isArray(events.recent)) {
    const total = events.recent.length;
    out.planEvents = {
      total: events.total,
      recent: events.recent.slice(-c.events).map((e) => projectEventEntry(e, c.eventText)),
      ...(total > c.events ? { recentTruncated: { shown: c.events, more: 'coord:plan-events' } } : {}),
    };
  }

  // P-016 (voice-public-release-readiness-2026-07-12): the papercup pane digest is
  // a rendered markdown block (several KB when the system is busy) — cap by chars
  // with the D-004 fetch-pointer. `deepWork` is already bounded at source (newest
  // capped at 3, short summaries) and passes through untouched.
  if (typeof d.paneContext === 'string' && d.paneContext.length > c.paneContext) {
    out.paneContext = `${d.paneContext.slice(0, c.paneContext)}\n… (trimmed — drill in via curation:feed / curation:state-of-pot / fleet:assignments, or payloadTier:'full')`;
  }

  // EI-19314271768708528: `leaderBrief` had NO shaper, so it reached the budget pass
  // full-fat and was dropped WHOLE — on a monitor wake (the mode that exists to deliver
  // it) the leader was left with `me`, its own one-row assignment view, which reads
  // exactly like a fleet-wide verdict of one live agent and zero stalled. Project it
  // like every other leg instead: `summary` is ~20 scalars carrying every aggregate
  // alert (dead / stalled / idle_with_claimable / unowned_criticals) and is the highest
  // value-per-byte field in the whole result, so it is kept WHOLE and the roster is what
  // yields — with the D-004 count + fetch-pointer.
  const brief = d.leaderBrief as Record<string, unknown> | null | undefined;
  if (brief && typeof brief === 'object') {
    const out2: Record<string, unknown> = { ...brief };
    if (Array.isArray(brief.members)) {
      const total = brief.members.length;
      const ranked = [...brief.members].sort((a, b) => briefMemberRank(a) - briefMemberRank(b));
      out2.members = ranked.slice(0, c.briefMembers).map((m) => projectBriefMember(m, c.title, c.briefReason));
      if (total > c.briefMembers) {
        out2.membersTruncated = { total, shown: c.briefMembers, ranked: 'actionable-first (dead/stalled → pressured/unanswered → idle/benched → healthy)', more: 'fleet:leader-brief' };
      }
    }
    // The advisory rosters are unbounded work-item lists (18 unowned criticals in the
    // reporting incident); cap with a pointer rather than letting them crowd out members.
    for (const key of ['unownedCriticals', 'abandonedUnclaimed', 'orphaned', 'stalled']) {
      const list = brief[key];
      if (Array.isArray(list) && list.length > c.briefLists) {
        out2[key] = list.slice(0, c.briefLists);
        out2[`${key}Truncated`] = { total: list.length, shown: c.briefLists, more: 'fleet:leader-brief' };
      }
    }
    out.leaderBrief = out2;
  }

  const catchUp = d.fleetCatchUp as { fleet?: unknown; total?: number; recent?: unknown[] } | null | undefined;
  if (catchUp && typeof catchUp === 'object' && Array.isArray(catchUp.recent)) {
    const total = catchUp.recent.length;
    out.fleetCatchUp = {
      ...catchUp,
      recent: catchUp.recent.slice(-c.catchUp).map((e) => projectEventEntry(e, c.eventText)),
      ...(total > c.catchUp ? { recentTruncated: { shown: c.catchUp, more: 'coord:catch-up' } } : {}),
    };
  }

  return out;
}
