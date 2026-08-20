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
 *
 * EI-20743148487714069. Point 3 was originally implemented as a FLAT
 * `FIELD_CAPS.trimmed.summary = 0` — a hard drop at every rung. Measured, that
 * spent nothing to save nothing: a single-item trimmed read is ~890 chars against
 * a 6,000-char door, so the field was dropped from a payload using 15% of its
 * budget, and even the 13,000-char-checkpoint case above finishes ~2,000 chars
 * short of the door. The cost was real — `work_items:get` is how an agent reads a
 * backlog item before acting on it, and title-only is the one shape the standing
 * "a title is a LABEL, read the writer" discipline exists to prevent.
 *
 * A flat per-row cap is the wrong repair, though: `ids` accepts 100, so any fixed
 * summary spend is multiplied by the row count and pushes a bulk read down the
 * ladder into stubbing rows — trading 97 items' identity for 3 items' prose,
 * which is the worse answer for a read that asked about 100 things. So the
 * summary budget is LADDER-SHARED like `checkpointTotal`: a per-rung total,
 * divided across the rows actually carrying one. A 1-row read gets the whole
 * budget (enough for the 95th-percentile body outright); a 100-row read's share
 * falls below `SUMMARY_USEFUL_MIN_CHARS` and is dropped as it is today. Nothing is
 * hand-tuned per row count — the existing measured ladder resolves it.
 *   4. The `detail:true` coord substrate (`workItem.topics/posts/links`) is
 *      dropped, but its COUNTS are disclosed — see `noteDroppedDetail`. Content
 *      out, evidence-of-content in: a reader must never conclude "no comments"
 *      from a shaping decision.
 *
 * SELF-LIMITING, not hand-tuned. `ids` accepts up to 100, and hand-picked
 * per-field caps that look fine for one row silently blow the 30k
 * PAYLOAD_TIER_HARD_CEILING_CHARS at a hundred — which force-applies this same
 * shaper again and, on failing to shrink, falls back to the very generic
 * projection this file exists to avoid. The shaped result also goes through the
 * MCP result door, whose baked universal floor is only ~6k chars. So we walk a
 * DEGRADATION LADDER and emit the first rung that actually fits the stricter
 * result-door budget, measured rather than assumed. Rung 1 is still generous
 * enough that a normal single-item post-respawn read keeps its checkpoint whole.
 */

import { CHARS_PER_TOKEN_ESTIMATE } from "../../context-doors";
import { RESULT_DOOR_TOKENS } from "../../result-door";

/**
 * The shaper has no caller identity, so it cannot resolve a per-session door
 * override. Use the baked universal floor: this keeps the default path below
 * the enforced door, while the result door itself remains the authoritative
 * enforcement point for any runtime override (including a stricter one).
 */
export const RESULT_DOOR_BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

/** Both payload tiers must fit the same MCP per-result door. */
const TIER_TARGET_CHARS = { trimmed: RESULT_DOOR_BUDGET_CHARS, standard: RESULT_DOOR_BUDGET_CHARS } as const;

/**
 * Each rung: how many rows get the FULL projection (the rest degrade to an
 * id-preserving stub, so correlation NEVER breaks), the TOTAL checkpoint chars
 * shared across them, and the TOTAL summary chars shared across them. Ordered
 * most→least generous.
 *
 * `summaryTotal` sits BELOW `checkpointTotal` at every rung on purpose: the
 * checkpoint is this tool's payload and is degraded last (point 1 above), so when
 * a rung cannot fit both, the summary is what gives way.
 */
const DEGRADATION_LADDER = {
  trimmed: [
    { fullRows: 100, checkpointTotal: 6_000, summaryTotal: 2_400 },
    { fullRows: 25, checkpointTotal: 3_000, summaryTotal: 1_200 },
    { fullRows: 12, checkpointTotal: 1_200, summaryTotal: 600 },
    { fullRows: 6, checkpointTotal: 600, summaryTotal: 0 },
    { fullRows: 3, checkpointTotal: 0, summaryTotal: 0 },
    { fullRows: 0, checkpointTotal: 0, summaryTotal: 0 },
  ],
  standard: [
    { fullRows: 100, checkpointTotal: 16_000, summaryTotal: 4_000 },
    { fullRows: 50, checkpointTotal: 8_000, summaryTotal: 2_400 },
    { fullRows: 25, checkpointTotal: 3_000, summaryTotal: 1_200 },
    { fullRows: 12, checkpointTotal: 1_200, summaryTotal: 600 },
    { fullRows: 6, checkpointTotal: 600, summaryTotal: 0 },
    { fullRows: 0, checkpointTotal: 0, summaryTotal: 0 },
  ],
} as const;

/**
 * Below this, a summary's share of the rung budget buys nothing: the head of a
 * body is not a smaller answer to "what is this item about", and a 24-char
 * fragment costs the marker bytes that say it was clipped. So a share under this
 * floor DROPS the field (disclosed, exactly as today) instead of emitting a
 * useless stub. This is what makes the ladder-shared budget safe at 100 rows
 * without a per-row-count special case.
 */
const SUMMARY_USEFUL_MIN_CHARS = 200;

/**
 * Per-row caps for the fields whose size does NOT scale with the row count in a
 * way the ladder must arbitrate. `summary` is deliberately NOT here: it is the
 * one bulk field a caller can multiply by 100, so its budget is ladder-shared
 * (see DEGRADATION_LADDER) rather than fixed per row.
 */
const FIELD_CAPS = {
  trimmed: {
    title: 160,
    warning: 300,
    lifecycleEvents: 4,
    checkpointMin: 400,
    citedFacts: 3,
    citedExcerpt: 120,
  },
  standard: {
    title: 300,
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

/**
 * Identity + lifecycle facts about the item, plus as much of the summary as the
 * rung's shared budget affords (`summaryChars`; 0 ⇒ the field is omitted, which
 * `projectRow` discloses). Never the payload blob.
 */
function projectWorkItem(
  raw: unknown,
  caps: FieldCaps,
  summaryChars: number,
  dropped: Set<string>,
): unknown {
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
    ...(summaryChars > 0 ? { summary: clip(w.summary, summaryChars) } : {}),
    // Per-row attribution: `dropped` is payload-level, so across 100 rows it
    // cannot say WHICH item has the 7 unread comments. Mirrors the existing
    // `citedTruncated` / `eventsTruncated` convention in this file.
    ...(detailOmitted ? { detailOmitted } : {}),
  };
}

/**
 * The floor row preserves only correlation plus a machine-readable degradation flag.
 *
 * WI-39844: this used to repeat `ok` / `state` / `title` / `hasCheckpoint` and the same
 * 66-character recovery sentence on every stub. At the supported maximum of 100 ids,
 * those rows alone exceeded the entire MCP result door. The human-readable explanation
 * now lives once in `_shapeNote.stubbed`; a row the caller must re-read needs only the id
 * that makes that recovery possible.
 */
function stubRow(r: Row): Row {
  const w = (r.workItem ?? {}) as Row;
  return {
    id: r.id ?? w.id ?? null,
    _stub: true,
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

function projectRow(
  r: Row,
  caps: FieldCaps,
  checkpointChars: number,
  summaryChars: number,
  dropped: Set<string>,
): Row {
  if (r.ok === false) return r; // an error row is already tiny and self-describing

  const checkpoint = r.checkpoint;
  if (typeof checkpoint === "string" && checkpoint.length > checkpointChars) {
    dropped.add("checkpoint(clipped)");
  }
  const w = r.workItem as Row | undefined;
  // Disclose the summary's fate in the SAME two shapes used for the checkpoint:
  // a full drop and a clip are different losses and a reader acts differently on
  // them (a clip is recoverable from what is in hand; a drop is not).
  if (typeof w?.summary === "string") {
    if (summaryChars === 0) dropped.add("workItem.summary");
    else if (w.summary.length > summaryChars) dropped.add("workItem.summary(clipped)");
  }
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
    workItem: projectWorkItem(r.workItem, caps, summaryChars, dropped),
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
  // Two attempts per rung — this ordering is what makes "the checkpoint is
  // degraded LAST" true rather than aspirational. Descending a rung CUTS THE
  // CHECKPOINT, so before we do that we retry the SAME rung with the summary
  // budget withdrawn. A summary therefore only ever spends slack the rung already
  // had; it can never buy its bytes from the checkpoint. (Without this, adding any
  // summary spend at rung 1 pushed the 5,000-char-checkpoint single-item read down
  // to a rung that clipped it to 3,000 — reintroducing EI-19447969329510166's
  // exact defect from a new direction.)
  const attempts: Array<{ rung: number; withSummary: boolean }> = [];
  for (let rung = 0; rung < ladder.length; rung += 1) {
    if (ladder[rung].summaryTotal > 0) attempts.push({ rung, withSummary: true });
    attempts.push({ rung, withSummary: false });
  }

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const { rung, withSummary } = attempts[attempt];
    const { fullRows, checkpointTotal, summaryTotal } = ladder[rung];
    const dropped = new Set<string>();
    const carrying = rows
      .slice(0, fullRows)
      .filter((r) => typeof r.checkpoint === "string" && r.checkpoint.length > 0).length;
    const checkpointChars =
      carrying === 0 ? 0 : Math.max(caps.checkpointMin, Math.floor(checkpointTotal / carrying));

    // Divided across the rows that actually HAVE a summary, so one row's read is
    // not rationed against 99 rows that would not have spent it. Deliberately NO
    // `Math.max(min, …)` floor: unlike the checkpoint — whose floor is what keeps
    // the tool's payload readable at all — a summary below the useful floor is
    // worth less than the bytes it costs, so the share is taken to zero and the
    // drop is disclosed instead.
    const carryingSummaries = rows
      .slice(0, fullRows)
      .filter((r) => {
        const s = (r.workItem as Row | undefined)?.summary;
        return typeof s === "string" && s.length > 0;
      }).length;
    const summaryShare =
      !withSummary || carryingSummaries === 0
        ? 0
        : Math.floor(summaryTotal / carryingSummaries);
    const summaryChars = summaryShare >= SUMMARY_USEFUL_MIN_CHARS ? summaryShare : 0;

    const projected = rows.map((r, i) =>
      i < fullRows
        ? projectRow(r, caps, checkpointChars, summaryChars, dropped)
        : stubRow(r),
    );
    const stubbedCount = Math.max(0, rows.length - fullRows);
    if (stubbedCount > 0) dropped.add(`rows(${stubbedCount} stubbed)`);

    out = {
      ...d,
      results: projected,
      ...(dropped.size > 0
        ? {
            _shapeNote: {
              tier,
              checkpointCharsPerRow: checkpointChars,
              summaryCharsPerRow: summaryChars,
              dropped: [...dropped].sort(),
              ...(stubbedCount > 0
                ? {
                    stubbed: {
                      count: stubbedCount,
                      note: "stub rows preserve only id + _stub; re-read an id alone for detail",
                    },
                  }
                : {}),
              // The generic sentence is not enough when the dropped field is the
              // item's PROSE: a reader who still has the title reads a size
              // advisory as "you got the item, just smaller" and acts on the
              // label. Name that specific loss, once per payload (never per row
              // — D-012).
              next: `${
                dropped.has("workItem.summary")
                  ? "⚠ The SUMMARY was dropped — you have this item's TITLE and no sentence of its body. A title is a LABEL: do not act on it. Re-read before deciding anything. "
                  : ""
              }Fields above were dropped or clipped to fit the '${tier}' payload tier. Re-read with payloadTier:'full' — it is FRAMEWORK-RESERVED and absent from this tool's published schema, so route it through your host's raw-args dispatch path (papercusp: tools:invoke { name:'work_items:get', args:{ …, payloadTier:'full' } }).`,
            },
          }
        : {}),
    };
    // Measured, not assumed. The last attempt is the floor and ships regardless.
    if (jsonLen(out) <= target || attempt === attempts.length - 1) return out;
  }
  return out;
}
