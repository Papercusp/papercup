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
 * checkpoint is your continuity" — so on a post-respawn re-orient, the checkpoint
 * IS the session's memory, and `work_items:get` is the tool that exists to
 * deliver it. Clipping it to its head is not a smaller answer, it is a
 * DIFFERENT one: a checkpoint that opens with a superseded root cause and
 * retracts it further down reads, truncated, as confident endorsement of the
 * retracted lead.
 *
 * So the ordering principle here is the inverse of the generic projection's:
 *   1. `checkpoint` and the verdicts ABOUT it are the payload — trimmed LAST.
 *   2. The conditional "read before acting" warnings (claim collisions, blocked
 *      plan lanes, prior-work, bg-job evidence) are what the tool's own `returns`
 *      contract promises a caller must see — kept, clipped only if huge.
 *   3. `workItem.summary` / `workItem.payload` / `lifecycle` detail are the bulk,
 *      and are what a trimmed tier should spend its budget on instead. Dropped or
 *      hard-capped, ALWAYS with a `_shapeNote` saying so (D-004: no silent caps).
 *
 * Bulk reads: `ids` accepts up to 100. A per-row checkpoint budget would blow the
 * 30k hard ceiling (100 × 6k), which force-applies this same shaper again and, on
 * failing to shrink, falls back to the very generic projection this exists to
 * avoid. So the checkpoint budget is a TOTAL for the call, divided across the
 * rows that actually carry one — a single-item read (the post-respawn case that
 * matters) gets the whole budget; a 100-id sweep gets a floor each.
 */

export const WORK_ITEMS_GET_TIER_CAPS = {
  trimmed: {
    checkpointTotal: 6_000,
    checkpointMin: 400,
    title: 160,
    summary: 0,
    warning: 300,
    lifecycleEvents: 4,
  },
  standard: {
    checkpointTotal: 16_000,
    checkpointMin: 800,
    title: 300,
    summary: 400,
    warning: 600,
    lifecycleEvents: 10,
  },
} as const;

type WorkItemsGetTier = keyof typeof WORK_ITEMS_GET_TIER_CAPS;

type Row = Record<string, unknown>;

/**
 * Clip with the SAME loud in-band marker shape the framework projection now uses
 * (payload-tier.ts `truncationMarker`). A bare `…` is indistinguishable from
 * content — which is the whole defect this file and that one were filed for.
 */
function clip(value: unknown, max: number): unknown {
  if (typeof value !== 'string' || value.length <= max) return value ?? null;
  if (max <= 0) return null;
  return `${value.slice(0, max)}…[TRUNCATED +${value.length - max} chars — re-read with payloadTier:'full']`;
}

/** Identity + lifecycle facts about the item; never the summary/payload blob. */
function projectWorkItem(raw: unknown, caps: (typeof WORK_ITEMS_GET_TIER_CAPS)[WorkItemsGetTier]): unknown {
  if (!raw || typeof raw !== 'object') return raw ?? null;
  const w = raw as Row;
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
    origin: w.origin ?? null,
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    closedAt: w.closedAt ?? null,
    ...(caps.summary > 0 ? { summary: clip(w.summary, caps.summary) } : {}),
  };
}

/**
 * How much checkpoint each row may keep. Divided across the rows that HAVE one,
 * so a single-item read keeps its checkpoint whole up to the tier total.
 */
function checkpointBudget(rows: Row[], caps: (typeof WORK_ITEMS_GET_TIER_CAPS)[WorkItemsGetTier]): number {
  const withCheckpoint = rows.filter((r) => typeof r.checkpoint === 'string' && r.checkpoint.length > 0).length;
  if (withCheckpoint <= 1) return caps.checkpointTotal;
  return Math.max(caps.checkpointMin, Math.floor(caps.checkpointTotal / withCheckpoint));
}

export function shapeWorkItemsGet(data: unknown, tier: WorkItemsGetTier): unknown {
  const d = data as ({ results?: unknown[] } & Row) | null | undefined;
  if (!d || !Array.isArray(d.results)) return data;
  const caps = WORK_ITEMS_GET_TIER_CAPS[tier];
  const rows = d.results.map((r) => (r && typeof r === 'object' ? (r as Row) : ({} as Row)));
  const perRow = checkpointBudget(rows, caps);

  const dropped = new Set<string>();
  const projected = rows.map((r) => {
    if (r.ok === false) return r; // an error row is already tiny and self-describing
    const checkpoint = r.checkpoint;
    if (typeof checkpoint === 'string' && checkpoint.length > perRow) dropped.add('checkpoint(clipped)');
    if (typeof (r.workItem as Row | undefined)?.summary === 'string' && caps.summary === 0) {
      dropped.add('workItem.summary');
    }
    if ((r.workItem as Row | undefined)?.payload !== undefined) dropped.add('workItem.payload');

    const lifecycle = r.lifecycle as Row | undefined;
    let shapedLifecycle: unknown;
    if (lifecycle && typeof lifecycle === 'object') {
      const events = Array.isArray(lifecycle.events) ? lifecycle.events : [];
      if (events.length > caps.lifecycleEvents) dropped.add('lifecycle.events');
      shapedLifecycle = {
        // `coverage` and `flags` are the fields the tool's contract says must be
        // read BEFORE concluding anything from an empty timeline — never drop
        // them to make room for the events they qualify.
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
      workItem: projectWorkItem(r.workItem, caps),
      // THE payload of this tool. Clipped only after everything above was already
      // dropped, and never without the loud in-band marker.
      checkpoint: clip(checkpoint, perRow),
      checkpointAgeMs: r.checkpointAgeMs ?? null,
      checkpointUpdatedAtMs: r.checkpointUpdatedAtMs ?? null,
      ...(r.checkpointReadFailed ? { checkpointReadFailed: r.checkpointReadFailed } : {}),
      // Verdicts ABOUT the checkpoint — small, and each one changes how the
      // checkpoint above should be read. Kept whole.
      ...(r.checkpointFreshness ? { checkpointFreshness: r.checkpointFreshness } : {}),
      ...(r.checkpointStale ? { checkpointStale: r.checkpointStale } : {}),
      ...(r.checkpointBgJobWarning ? { checkpointBgJobWarning: clip(r.checkpointBgJobWarning, caps.warning) } : {}),
      // Conditional "read before acting" warnings the tool's `returns` promises.
      ...(r.priorWorkWarning ? { priorWorkWarning: clip(r.priorWorkWarning, caps.warning) } : {}),
      ...(r.planItemBlocked ? { planItemBlocked: r.planItemBlocked } : {}),
      ...(r.planItemClaimCollision ? { planItemClaimCollision: r.planItemClaimCollision } : {}),
      ...(r.holder ? { holder: r.holder } : {}),
      ...(shapedLifecycle ? { lifecycle: shapedLifecycle } : {}),
    };
  });

  return {
    ...d,
    results: projected,
    ...(dropped.size > 0
      ? {
          _shapeNote: {
            tier,
            checkpointCharsPerRow: perRow,
            dropped: [...dropped].sort(),
            next: `Fields above were dropped or clipped to fit the '${tier}' payload tier. Re-read with payloadTier:'full' — it is FRAMEWORK-RESERVED and absent from this tool's published schema, so route it through your host's raw-args dispatch path (papercusp: tools:invoke { name:'work_items:get', args:{ …, payloadTier:'full' } }).`,
          },
        }
      : {}),
  };
}
