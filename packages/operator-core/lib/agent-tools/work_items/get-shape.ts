/**
 * work_items:get payload-tier shapers (context-trimming-tiers-2026-07-01 D-004).
 *
 * EI-19447969329510166. `work_items:get` declared NO shaper, so a trimmed session
 * fell through to the framework's GENERIC bounded projection — which knows
 * nothing about which of this tool's fields matter and clips every string at a
 * flat `maxString` (800 chars at the trimmed tier). Measured: a ~13,000-char
 * checkpoint arrived as its first 800 chars.
 *
 * That is the worst possible field to pick. `work_items:checkpoint`'s own
 * description says "your transcript does NOT carry across a task boundary; the
 * checkpoint is your continuity" — so on a post-respawn re-orient the checkpoint
 * IS the session's memory, and `work_items:get` is the tool that exists to
 * deliver it. Clipping it to its head is not a smaller answer, it is a DIFFERENT
 * one: a checkpoint that opens with a superseded root cause and retracts it
 * further down reads, truncated, as confident endorsement of the retracted lead.
 *
 * The ordering principle here is therefore the inverse of the generic
 * projection's:
 *   1. `checkpoint` and the verdicts ABOUT it are the payload — degraded LAST.
 *   2. The conditional "read before acting" warnings (claim collisions, blocked
 *      plan lanes, prior-work, bg-job evidence) are what this tool's `returns`
 *      contract promises a caller must see — kept whole; they are small.
 *   3. `workItem.summary` / `workItem.payload` / `lifecycle` events are the bulk,
 *      and are what a trimmed tier should spend its budget on instead. Dropped or
 *      capped, ALWAYS with a `_shapeNote` saying so (D-004: no silent caps).
 *   4. The `detail:true` coord substrate (`workItem.topics/posts/links`) is
 *      dropped, but its COUNTS are disclosed — see `noteDroppedDetail`. Content
 *      out, evidence-of-content in: a reader must never conclude "no comments"
 *      from a shaping decision.
 *
 * SELF-LIMITING, not hand-tuned. `ids` accepts up to 100, and hand-picked
 * per-field caps that look fine for one row silently blow the 30k
 * PAYLOAD_TIER_HARD_CEILING_CHARS at a hundred — which force-applies this same
 * shaper again and, on failing to shrink, falls back to the very generic
 * projection this file exists to avoid. So we walk a DEGRADATION LADDER and emit
 * the first rung that actually fits, measured rather than assumed. Rung 1 is
 * generous enough that the single-item post-respawn read — the case that matters —
 * always keeps its checkpoint whole.
 */

/** Comfortably under PAYLOAD_TIER_HARD_CEILING_CHARS (30_000), leaving envelope room. */
const TIER_TARGET_CHARS = { trimmed: 20_000, standard: 26_000 } as const;

/**
 * Each rung: how many rows get the FULL projection (the rest degrade to an
 * id-preserving stub, so correlation NEVER breaks) and the TOTAL checkpoint
 * chars shared across them. Ordered most→least generous.
 */
const DEGRADATION_LADDER = {
  trimmed: [
    { fullRows: 100, checkpointTotal: 6_000 },
    { fullRows: 25, checkpointTotal: 3_000 },
    { fullRows: 12, checkpointTotal: 1_200 },
    { fullRows: 6, checkpointTotal: 600 },
    { fullRows: 3, checkpointTotal: 0 },
  ],
  standard: [
    { fullRows: 100, checkpointTotal: 16_000 },
    { fullRows: 50, checkpointTotal: 8_000 },
    { fullRows: 25, checkpointTotal: 3_000 },
    { fullRows: 12, checkpointTotal: 1_200 },
    { fullRows: 6, checkpointTotal: 600 },
  ],
} as const;

const FIELD_CAPS = {
  trimmed: {
    title: 160,
    summary: 0,
    warning: 300,
    lifecycleEvents: 4,
    checkpointMin: 400,
    citedFacts: 3,
    citedExcerpt: 120,
  },
  standard: {
    title: 300,
    summary: 400,
    warning: 600,
    lifecycleEvents: 10,
    checkpointMin: 800,
    citedFacts: 6,
    citedExcerpt: 240,
  },
} as const;

/** `threadLimit` bounds rows at the query, and these caps keep individual post
 * bodies bounded too. A post can be large enough to overflow an otherwise small
 * recent window, so row-count-only bounding is not sufficient for MCP replies. */
const THREAD_CAPS = {
  trimmed: { posts: 5, topics: 12, body: 600 },
  standard: { posts: 10, topics: 24, body: 1200 },
} as const;

type WorkItemsGetTier = keyof typeof FIELD_CAPS;
type FieldCaps = (typeof FIELD_CAPS)[WorkItemsGetTier];
type Row = Record<string, unknown>;

/**
 * Clip with the SAME loud in-band marker the framework projection now uses
 * (payload-tier.ts `truncationMarker`). A bare `…` is indistinguishable from
 * content — the whole defect this file and that one were filed for.
 */
function clip(value: unknown, max: number): unknown {
  if (typeof value !== "string") return value ?? null;
  if (value.length <= max) return value;
  if (max <= 0) return null;
  return `${value.slice(0, max)}…[TRUNCATED +${value.length - max} chars — re-read with payloadTier:'full']`;
}

/**
 * EI-20106094931898818 / EI-20190481053365787. `detail:true` folds the coord
 * substrate ONTO the workItem — `getWorkItemDetail` returns
 * `{ ...wi, topics, posts, links }` (work-items.ts:1156) — and the allow-list
 * below drops all three, because they are simply absent from its literal.
 *
 * That drop was SILENT, which on this field is the worst-shaped lie available:
 * a caller who passed `detail:true` and sees no `posts` key reads it as "this
 * item has no comments" and acts on it. That misreading has already happened
 * here — a finding WAS on an item, as an unread comment, and got reported as
 * never filed. `_shapeNote` is emitted only when `dropped` is non-empty, so
 * before this a detail read whose ONLY loss was the thread produced no marker
 * at all, and absence of the marker is a positive claim of completeness.
 *
 * The COUNTS are therefore disclosed even though the content is not. The
 * recovery CALL stays once in `_shapeNote.next` instead of per row: repeating
 * it across 100 rows would spend the budget this shaper exists to protect
 * (D-012). A count is ~30 chars.
 *
 * Only a NON-EMPTY array is disclosed. An empty `posts: []` is a real answer
 * ("no comments"), and a defensively-emitted marker on it would destroy the one
 * property that makes the marker worth anything.
 *
 * The numbers are what was PRESENT ON THE ROW before shaping — deliberately not
 * described as the thread total, which this shaper cannot see.
 */
function noteDroppedDetail(w: Row, dropped: Set<string>): Record<string, number> | null {
  const omitted: Record<string, number> = {};
  for (const field of ["posts", "topics", "links"] as const) {
    const value = w[field];
    if (Array.isArray(value) && value.length > 0) {
      omitted[field] = value.length;
      // The LABEL carries no count, deliberately. `dropped` is a payload-level
      // Set shared by every row, so an interpolated count would emit up to one
      // distinct string PER ROW on a bulk read — noise, and budget spent on the
      // very thing this shaper protects. The count lives per row in
      // `detailOmitted`; the label matches the countless convention used by
      // `workItem.summary` / `lifecycle.events` / `citedFacts.cited`.
      dropped.add(`workItem.${field}`);
    }
  }
  return Object.keys(omitted).length > 0 ? omitted : null;
}

/** Identity + lifecycle facts about the item; never the summary/payload blob. */
function projectWorkItem(raw: unknown, caps: FieldCaps, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const w = raw as Row;
  const detailOmitted = noteDroppedDetail(w, dropped);
  return {
    id: w.id ?? null,
    kind: w.kind ?? null,
    family: w.family ?? null,
    harness: w.harness ?? null,
    state: w.state ?? null,
    title: clip(w.title, caps.title),
    severity: w.severity ?? null,
    assignee: w.assignee ?? null,
    takenAt: w.takenAt ?? null,
    lastProgressAt: w.lastProgressAt ?? null,
    parent: w.parent ?? null,
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    closedAt: w.closedAt ?? null,
    ...(caps.summary > 0 ? { summary: clip(w.summary, caps.summary) } : {}),
    // Per-row attribution: `dropped` is payload-level, so across 100 rows it
    // cannot say WHICH item has the 7 unread comments. Mirrors the existing
    // `citedTruncated` / `eventsTruncated` convention in this file.
    ...(detailOmitted ? { detailOmitted } : {}),
  };
}

/** The degraded row: still correlatable by id, and it SAYS it is degraded. */
function stubRow(r: Row, caps: FieldCaps): Row {
  const w = (r.workItem ?? {}) as Row;
  return {
    ok: r.ok ?? true,
    id: r.id ?? w.id ?? null,
    state: w.state ?? null,
    title: clip(w.title, Math.min(caps.title, 80)),
    hasCheckpoint: typeof r.checkpoint === "string" && r.checkpoint.length > 0,
    _stub: "row omitted to fit payload tier — re-read this id alone for detail",
  };
}

/**
 * EI-19465127338264010. The prose fact-citation warning. Its `note` + counts are
 * the finding and are KEPT WHOLE (small, and they are what a reader must act on);
 * the per-key `excerpt`s are the bulk — valuable (they hand back the body of a
 * decayed authority) but capped here, since ten 160-char excerpts across a
 * hundred rows is exactly the blow-up this file's ladder exists to prevent.
 *
 * Never silently: a capped list says so via `citedTruncated` in-band AND lands in
 * the shared `dropped` set, so `_shapeNote` names it too.
 */
function projectCitedFacts(raw: unknown, caps: FieldCaps, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const cf = raw as Row;
  const cited = Array.isArray(cf.cited) ? cf.cited : [];
  const kept = cited.slice(0, caps.citedFacts).map((c) => {
    if (!c || typeof c !== "object") return c;
    const e = c as Row;
    return {
      ...e,
      ...(typeof e.excerpt === "string" ? { excerpt: clip(e.excerpt, caps.citedExcerpt) } : {}),
    };
  });
  if (cited.length > caps.citedFacts) dropped.add("citedFacts.cited");
  return {
    dangling: cf.dangling ?? null,
    decayed: cf.decayed ?? null,
    ...(cf.truncated ? { truncated: cf.truncated } : {}),
    note: cf.note ?? null,
    cited: kept,
    ...(cited.length > caps.citedFacts
      ? { citedTruncated: { shown: kept.length, total: cited.length } }
      : {}),
  };
}

/** Project the explicit bounded diagnostic thread. The query already limits the
 * window, but the payload still needs a body cap because one post can be large.
 * `shown` and `total` stay in-band so a short window is never mistaken for the
 * whole conversation. */
function projectThreadWindow(raw: unknown, tier: WorkItemsGetTier, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const w = raw as Row;
  const caps = THREAD_CAPS[tier];
  const posts = Array.isArray(w.posts) ? w.posts : [];
  const topics = Array.isArray(w.topics) ? w.topics : [];
  const keptPosts = posts.slice(-caps.posts).map((value) => {
    const post = value && typeof value === "object" ? (value as Row) : {};
    const body = typeof post.body === "string" ? post.body : "";
    const bodyTruncated = body.length > caps.body;
    if (bodyTruncated) dropped.add("threadWindow.postBodies");
    return {
      id: post.id ?? null,
      thread_id: post.thread_id ?? null,
      author_id: post.author_id ?? null,
      body: clip(body, caps.body),
      created_ts: post.created_ts ?? null,
      ...(bodyTruncated ? { bodyChars: body.length, bodyTruncated: true } : {}),
    };
  });
  if (posts.length > caps.posts) dropped.add("threadWindow.posts");
  if (topics.length > caps.topics) dropped.add("threadWindow.topics");
  return {
    posts: keptPosts,
    shown: keptPosts.length,
    total: typeof w.total === "number" ? w.total : null,
    topics: topics.slice(0, caps.topics),
    createdAt: w.createdAt ?? null,
  };
}

function projectRow(r: Row, caps: FieldCaps, checkpointChars: number, dropped: Set<string>): Row {
  if (r.ok === false) return r; // an error row is already tiny and self-describing

  const checkpoint = r.checkpoint;
  if (typeof checkpoint === "string" && checkpoint.length > checkpointChars) {
    dropped.add("checkpoint(clipped)");
  }
  const w = r.workItem as Row | undefined;
  if (typeof w?.summary === "string" && caps.summary === 0) dropped.add("workItem.summary");
  if (w?.payload !== undefined) dropped.add("workItem.payload");

  const lifecycle = r.lifecycle as Row | undefined;
  let shapedLifecycle: unknown;
  if (lifecycle && typeof lifecycle === "object") {
    const events = Array.isArray(lifecycle.events) ? lifecycle.events : [];
    if (events.length > caps.lifecycleEvents) dropped.add("lifecycle.events");
    shapedLifecycle = {
      // `coverage` and `flags` are the fields this tool's contract says must be
      // read BEFORE concluding anything from an empty timeline. Never drop them
      // to make room for the events they qualify — an unqualified empty
      // `events` is precisely the misreading they exist to prevent.
      coverage: lifecycle.coverage ?? null,
      flags: lifecycle.flags ?? null,
      events: events.slice(0, caps.lifecycleEvents),
      ...(events.length > caps.lifecycleEvents
        ? { eventsTruncated: { shown: caps.lifecycleEvents, total: events.length } }
        : {}),
    };
  }

  return {
    ok: r.ok ?? true,
    id: r.id ?? null,
    workItem: projectWorkItem(r.workItem, caps, dropped),
    ...(r.threadWindow !== undefined
      ? { threadWindow: projectThreadWindow(r.threadWindow, caps === FIELD_CAPS.trimmed ? "trimmed" : "standard", dropped) }
      : {}),
    ...(r.threadWindowReadFailed ? { threadWindowReadFailed: true } : {}),
    // THE payload of this tool. Degraded only after everything above was already
    // dropped, and never without the loud in-band marker.
    checkpoint: clip(checkpoint, checkpointChars),
    checkpointAgeMs: r.checkpointAgeMs ?? null,
    checkpointUpdatedAtMs: r.checkpointUpdatedAtMs ?? null,
    ...(r.checkpointReadFailed ? { checkpointReadFailed: r.checkpointReadFailed } : {}),
    // Verdicts ABOUT the checkpoint — small, and each one changes how the
    // checkpoint above should be read. Kept whole.
    ...(r.checkpointFreshness ? { checkpointFreshness: r.checkpointFreshness } : {}),
    ...(r.checkpointStale ? { checkpointStale: r.checkpointStale } : {}),
    ...(r.checkpointBgJobWarning
      ? { checkpointBgJobWarning: clip(r.checkpointBgJobWarning, caps.warning) }
      : {}),
    // Conditional "read before acting" warnings this tool's `returns` promises.
    ...(r.priorWorkWarning ? { priorWorkWarning: clip(r.priorWorkWarning, caps.warning) } : {}),
    ...(r.citedFacts ? { citedFacts: projectCitedFacts(r.citedFacts, caps, dropped) } : {}),
    ...(r.planItemBlocked ? { planItemBlocked: r.planItemBlocked } : {}),
    ...(r.planItemClaimCollision ? { planItemClaimCollision: r.planItemClaimCollision } : {}),
    ...(r.holder ? { holder: r.holder } : {}),
    ...(shapedLifecycle ? { lifecycle: shapedLifecycle } : {}),
  };
}

function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function shapeWorkItemsGet(data: unknown, tier: WorkItemsGetTier): unknown {
  const d = data as ({ results?: unknown[] } & Row) | null | undefined;
  if (!d || !Array.isArray(d.results)) return data;
  const caps = FIELD_CAPS[tier];
  const rows = d.results.map((r) => (r && typeof r === "object" ? (r as Row) : ({} as Row)));
  const ladder = DEGRADATION_LADDER[tier];
  const target = TIER_TARGET_CHARS[tier];

  let out: unknown;
  for (let rung = 0; rung < ladder.length; rung += 1) {
    const { fullRows, checkpointTotal } = ladder[rung];
    const dropped = new Set<string>();
    const carrying = rows
      .slice(0, fullRows)
      .filter((r) => typeof r.checkpoint === "string" && r.checkpoint.length > 0).length;
    const checkpointChars =
      carrying === 0 ? 0 : Math.max(caps.checkpointMin, Math.floor(checkpointTotal / carrying));

    const projected = rows.map((r, i) =>
      i < fullRows ? projectRow(r, caps, checkpointChars, dropped) : stubRow(r, caps),
    );
    if (rows.length > fullRows) dropped.add(`rows(${rows.length - fullRows} stubbed)`);

    out = {
      ...d,
      results: projected,
      ...(dropped.size > 0
        ? {
            _shapeNote: {
              tier,
              checkpointCharsPerRow: checkpointChars,
              dropped: [...dropped].sort(),
              next: `Fields above were dropped or clipped to fit the '${tier}' payload tier. Re-read with payloadTier:'full' — it is FRAMEWORK-RESERVED and absent from this tool's published schema, so route it through your host's raw-args dispatch path (papercusp: tools:invoke { name:'work_items:get', args:{ …, payloadTier:'full' } }).`,
            },
          }
        : {}),
    };
    // Measured, not assumed. The last rung is the floor and ships regardless.
    if (jsonLen(out) <= target || rung === ladder.length - 1) return out;
  }
  return out;
}
