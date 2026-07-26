/**
 * hud-entity-board — the pure model behind the HUD's Plans and Work items tabs
 * (hud-session-launcher-and-board-tabs-2026-07-26 P-009).
 *
 * Owner ask, 2026-07-26: "What's currently in the kanban board are the
 * sessions, which is good, but there is a section show the work items above.
 * The sessions that are currently being shown in the kanban board should be
 * inside a 'sessions' tab alongside a 'plans' tab and 'Work Items' which show
 * the plans or work items in the same kanban style to replace the sessions."
 *
 * So the board grows a tab axis: the SAME five-column kanban renders three
 * different entity types. `hud-board-model.ts` stays the session model — it is
 * already 700 lines of session-specific classification and none of it applies
 * to a plan — and this file is its sibling for the two non-session tabs.
 *
 * Two things are deliberately SHARED rather than re-derived:
 *   - the column VOCABULARY. A plan with a needs-human item and a session
 *     waiting on you are the same fact about your attention, so they sit in a
 *     column with the same id, label and colour. `HudEntityColumnId` mirrors
 *     `HudColumnId` where the meaning matches (needs-you / working / blocked)
 *     and diverges only where it must (a plan is `ready`, not `parked`).
 *   - `HudBadge`, imported from the session model, so a chip renders through
 *     exactly one styling path.
 *
 * Pure + injected-clock, like hud-board-model: no `Date.now()` inside, no
 * imports that reach the server. Input types are structural and declared HERE
 * rather than imported from `plans-api` / `WorkItemsPanel` — the same reason
 * HudView inlines its roster payload type: the wire shape is the contract, and
 * importing the real modules would drag hooks (and, through them, PG-touching
 * server modules) into a file whose whole value is being testable without a DOM.
 */

import type { HudAsk, HudBadge } from './hud-board-model';
import { HUD_ASK_KIND_LABEL } from './hud-board-model';
import { SEVERITY_TONE } from '../../harness/theme';

/* ── tabs ────────────────────────────────────────────────────────────────── */

export const HUD_TABS = ['sessions', 'plans', 'items'] as const;
export type HudTabId = (typeof HUD_TABS)[number];

export const HUD_TAB_LABEL: Record<HudTabId, string> = {
  sessions: 'Sessions',
  plans: 'Plans',
  items: 'Work items',
};

/* ── columns ─────────────────────────────────────────────────────────────── */

/**
 * The entity columns. Ordered most- to least-urgent, matching the session
 * board's left-to-right reading: what needs you, what is moving, what is
 * stuck, what is queued, what is finished.
 *
 * `ready` replaces the session board's `stalled`/`parked` pair: a plan or a
 * work item has no heartbeat, so it cannot stall — the honest fifth state is
 * "queued, nobody has picked it up".
 */
export const HUD_ENTITY_COLUMNS = ['needs-you', 'working', 'blocked', 'ready', 'done'] as const;
export type HudEntityColumnId = (typeof HUD_ENTITY_COLUMNS)[number];

export const HUD_ENTITY_COLUMN_LABEL: Record<HudEntityColumnId, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  blocked: 'Blocked',
  ready: 'Ready',
  done: 'Done',
};

/** Per-column empty text, written per ENTITY: "no plans are blocked" is good
 *  news, and phrasing it as such is what keeps an empty column readable. */
const PLAN_COLUMN_EMPTY: Record<HudEntityColumnId, string> = {
  'needs-you': 'No plan is waiting on a decision',
  working: 'No plan has work in flight',
  blocked: 'Nothing is blocked',
  ready: 'Nothing queued',
  done: 'Nothing finished yet',
};

const ITEM_COLUMN_EMPTY: Record<HudEntityColumnId, string> = {
  'needs-you': 'Nothing is waiting on you',
  working: 'Nothing is being worked',
  blocked: 'Nothing is blocked',
  ready: 'The queue is empty',
  done: 'Nothing closed yet',
};

/* ── card + board shapes ─────────────────────────────────────────────────── */

export interface HudEntityCard {
  /** Stable React key + the id a click resolves against (plan slug / WI id). */
  id: string;
  /** Short monospace identifier rendered where a session card shows its handle. */
  ref: string;
  /** The headline — a plan's title, a work item's title. */
  title: string;
  column: HudEntityColumnId;
  /** One line of "what is actually going on here", or null when there is
   *  nothing honest to say (an empty string would render as a blank row). */
  reason: string | null;
  /** Secondary context line — the harness for a plan, the plan for a work
   *  item. Rendered in the slot a session card gives its plan slug. */
  context: string | null;
  badges: HudBadge[];
  /** Age in seconds of the entity's last movement; null when unknown. */
  sinceSec: number | null;
  /** Sort key WITHIN the column: lower sorts first. */
  sortKey: number;
}

export interface HudEntityBoard {
  columns: Array<{
    id: HudEntityColumnId;
    label: string;
    empty: string;
    cards: HudEntityCard[];
    /** Cards dropped by the per-column cap — surfaced as "+N more" so a
     *  truncated column never silently lies about its size. */
    hidden: number;
  }>;
  counts: Record<HudEntityColumnId, number>;
  total: number;
}

export interface HudEntityBuildOptions {
  /** Injected clock (ms epoch) — never read Date.now() inside the model. */
  nowMs: number;
  /**
   * Cards rendered per column before truncating. This workspace carries ~900
   * plans and ~1800 work items; rendering them all is thousands of DOM nodes
   * in a WebKitGTK webview for information nobody can read. The cap is a
   * RENDER bound only — `counts` and `total` always report the true numbers.
   */
  maxPerColumn?: number;
  /** Substring filter over ref/title/context, case-insensitive. */
  query?: string;
}

export const HUD_ENTITY_DEFAULT_MAX_PER_COLUMN = 60;

/* ── inputs ──────────────────────────────────────────────────────────────── */

/** The plan-list wire row, narrowed to what a card needs (see the file doc for
 *  why this is declared rather than imported from plans-api). */
export interface HudPlanInput {
  slug: string;
  title: string | null;
  status: string;
  updated: string | null;
  harnessSlug?: string | null;
  nextAction?: string | null;
  itemCounts?: Record<string, number> | null;
  archived?: boolean;
}

/** The work-item wire row (workItems.byHarness), narrowed the same way. */
export interface HudWorkItemInput {
  id: string;
  kind: string;
  title: string;
  state: string;
  assignee?: string | null;
  severity?: string | null;
  planSlug?: string | null;
  updatedAt?: string | null;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function ageSec(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Normalize a state token across the vocabulary drift the store still
 *  carries (`needs_human` vs `needs-human`, `in_progress` vs `wip`). Mirrors
 *  `ISSUE_STATE_ALIASES` in operator-core/lib/work-items.ts — NOT imported,
 *  because that module reaches Postgres and this one must not. */
function normalizeState(state: string | null | undefined): string {
  return (state ?? '').trim().toLowerCase().replace(/_/g, '-');
}

/** The cross-family settled set (`SETTLED_WORK_ITEM_STATES`, same reason for
 *  the local copy). The legacy terminals are still stored on pre-migration
 *  rows, so a card must recognize both spellings or a closed item reappears
 *  in the queue. */
const SETTLED_STATES: ReadonlySet<string> = new Set([
  'done',
  'dropped',
  'resolved',
  'closed',
  'passed',
  'deprecated',
]);

export function workItemColumn(state: string | null | undefined): HudEntityColumnId {
  const s = normalizeState(state);
  if (s === 'needs-human') return 'needs-you';
  if (s === 'wip' || s === 'in-progress') return 'working';
  if (s === 'blocked') return 'blocked';
  if (SETTLED_STATES.has(s)) return 'done';
  // `open`, `todo`, and anything unrecognized: claimable, nobody on it.
  // Defaulting UNKNOWN states to `ready` rather than `done` is deliberate —
  // a state this file has not learned about yet should surface as work, not
  // vanish into the finished column.
  return 'ready';
}

/**
 * Which column a plan belongs in.
 *
 * Order is the whole decision, so it is spelled out rather than folded into a
 * lookup: a plan is usually several of these at once (items in flight AND
 * items blocked AND one waiting on a human), and the column has to answer
 * "what does this plan need from me right now", not "what does it contain".
 */
export function planColumn(plan: HudPlanInput): HudEntityColumnId {
  const c = plan.itemCounts ?? {};
  const needsHuman = c['needs-human'] ?? 0;
  const wip = c.wip ?? 0;
  const blocked = c.blocked ?? 0;
  const todo = c.todo ?? 0;
  const status = (plan.status ?? '').toLowerCase();

  // 1. A decision only you can make outranks everything else on the board.
  if (needsHuman > 0) return 'needs-you';
  // 2. An explicit `blocked` status is the author's own verdict — it beats
  //    inferring "working" from an item somebody left flipped to wip.
  if (status === 'blocked') return 'blocked';
  // 3. Something is genuinely in flight.
  if (wip > 0) return 'working';
  // 4. Nothing moving, something stuck.
  if (blocked > 0) return 'blocked';
  // 5. The author closed it.
  if (status === 'shipped' || status === 'superseded') return 'done';
  // 6. Work remains and nobody has picked it up.
  if (todo > 0) return 'ready';
  // 7. No todo, no wip, no blocked, not explicitly shipped: every item is
  //    done or dropped. A plan with NO items at all also lands here — it has
  //    nothing to offer the queue, and `ready` would be a false promise.
  return 'done';
}

/** "3 todo · 1 blocked · 2 done" — the plan's shape when it has no explicit
 *  nextAction to show instead. Ordered by decision value, not alphabetically. */
export function planCountsSummary(counts: Record<string, number> | null | undefined): string | null {
  const c = counts ?? {};
  const parts: string[] = [];
  for (const key of ['needs-human', 'wip', 'blocked', 'todo', 'done'] as const) {
    const n = c[key] ?? 0;
    if (n > 0) parts.push(`${n} ${key === 'needs-human' ? 'needs you' : key}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function matchesQuery(card: { ref: string; title: string; context: string | null }, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    card.ref.toLowerCase().includes(needle) ||
    card.title.toLowerCase().includes(needle) ||
    (card.context ?? '').toLowerCase().includes(needle)
  );
}

/**
 * Assemble cards into the five columns.
 *
 * Sort: the needs-you column is OLDEST first (the thing that has been waiting
 * on you longest is the thing to answer next — the same urgency ordering
 * `unattributedAsks` applies), every other column is NEWEST first (the most
 * recently touched work is the most relevant context). That inversion is the
 * reason cards carry an explicit `sortKey` instead of the columns sorting by
 * age directly.
 */
function assemble(
  cards: HudEntityCard[],
  empty: Record<HudEntityColumnId, string>,
  opts: HudEntityBuildOptions,
): HudEntityBoard {
  const max = opts.maxPerColumn ?? HUD_ENTITY_DEFAULT_MAX_PER_COLUMN;
  const q = (opts.query ?? '').trim();
  const kept = q ? cards.filter((c) => matchesQuery(c, q)) : cards;

  const counts = Object.fromEntries(
    HUD_ENTITY_COLUMNS.map((id) => [id, 0]),
  ) as Record<HudEntityColumnId, number>;

  const byColumn = new Map<HudEntityColumnId, HudEntityCard[]>(
    HUD_ENTITY_COLUMNS.map((id) => [id, [] as HudEntityCard[]]),
  );
  for (const card of kept) {
    counts[card.column] += 1;
    byColumn.get(card.column)!.push(card);
  }

  const columns = HUD_ENTITY_COLUMNS.map((id) => {
    const all = byColumn.get(id)!.slice().sort((a, b) => a.sortKey - b.sortKey);
    return {
      id,
      label: HUD_ENTITY_COLUMN_LABEL[id],
      empty: empty[id],
      cards: all.slice(0, max),
      hidden: Math.max(0, all.length - max),
    };
  });

  return { columns, counts, total: kept.length };
}

/* ── plans ───────────────────────────────────────────────────────────────── */

export function toPlanCard(plan: HudPlanInput, nowMs: number): HudEntityCard {
  const column = planColumn(plan);
  const since = ageSec(plan.updated, nowMs);
  const badges: HudBadge[] = [];

  const c = plan.itemCounts ?? {};
  const needsHuman = c['needs-human'] ?? 0;
  if (needsHuman > 0) {
    badges.push({
      id: `${plan.slug}:needs-human`,
      label: `${needsHuman} needs you`,
      tone: 'warn',
      title: `${needsHuman} item${needsHuman === 1 ? '' : 's'} on this plan need a human decision`,
    });
  }
  const wip = c.wip ?? 0;
  if (wip > 0) {
    badges.push({ id: `${plan.slug}:wip`, label: `${wip} wip`, tone: 'good', title: `${wip} item${wip === 1 ? '' : 's'} in flight` });
  }
  const blocked = c.blocked ?? 0;
  if (blocked > 0) {
    badges.push({ id: `${plan.slug}:blocked`, label: `${blocked} blocked`, tone: 'bad', title: `${blocked} item${blocked === 1 ? '' : 's'} blocked` });
  }
  const todo = c.todo ?? 0;
  if (todo > 0) {
    badges.push({ id: `${plan.slug}:todo`, label: `${todo} todo`, tone: 'neutral', title: `${todo} item${todo === 1 ? '' : 's'} not started` });
  }
  if (plan.archived) {
    badges.push({ id: `${plan.slug}:archived`, label: 'archived', tone: 'neutral' });
  }

  return {
    id: plan.slug,
    ref: plan.slug,
    title: plan.title?.trim() || plan.slug,
    column,
    // `nextAction` is the plan's own answer to "what happens next", authored
    // by whoever wrote the plan — always better than a derived count line.
    reason: plan.nextAction?.trim() || planCountsSummary(plan.itemCounts),
    context: plan.harnessSlug ?? null,
    badges,
    sinceSec: since,
    sortKey: sortKeyFor(column, plan.updated),
  };
}

/** needs-you sorts oldest-first, everything else newest-first (see `assemble`).
 *  A row with no timestamp sinks to the bottom of either ordering rather than
 *  colonizing the top — an unknown date is not evidence of urgency. */
function sortKeyFor(column: HudEntityColumnId, iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : Number.NaN;
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return column === 'needs-you' ? t : -t;
}

export function buildPlanBoard(plans: HudPlanInput[], opts: HudEntityBuildOptions): HudEntityBoard {
  return assemble(
    plans.map((p) => toPlanCard(p, opts.nowMs)),
    PLAN_COLUMN_EMPTY,
    opts,
  );
}

/* ── work items ──────────────────────────────────────────────────────────── */

export function toWorkItemCard(item: HudWorkItemInput, nowMs: number): HudEntityCard {
  const column = workItemColumn(item.state);
  const badges: HudBadge[] = [
    { id: `${item.id}:kind`, label: item.kind, tone: 'neutral' },
  ];
  if (item.severity) {
    badges.push({
      id: `${item.id}:sev`,
      label: item.severity,
      tone: toBadgeTone(SEVERITY_TONE[item.severity.toLowerCase() as keyof typeof SEVERITY_TONE]),
    });
  }
  if (item.assignee) {
    badges.push({
      id: `${item.id}:assignee`,
      label: shortAssignee(item.assignee),
      tone: 'accent',
      title: `Assigned to ${item.assignee}`,
    });
  }
  return {
    id: item.id,
    ref: item.id,
    title: item.title?.trim() || item.id,
    column,
    reason: normalizeState(item.state) || null,
    context: item.planSlug ?? null,
    badges,
    sinceSec: ageSec(item.updatedAt, nowMs),
    sortKey: sortKeyFor(column, item.updatedAt),
  };
}

/** `su-709bb0d6-12de-…` → `su-709bb0d6`. Same treatment `shortHandle` gives a
 *  session's owner id, applied to an assignee (which is the same kind of id). */
export function shortAssignee(assignee: string): string {
  const m = /^([a-z]+)-([0-9a-f]{6,8})/i.exec(assignee);
  return m ? `${m[1]}-${m[2]}` : assignee;
}

/**
 * An unattributed ask rendered as a work-item card.
 *
 * This is the OTHER half of what P-009 moves. `hud-consolidation-2026-07-26`
 * P-002 established a hard gate before the sidebar Inbox could be retired
 * (D-001): every needs-human Decision with no owning agent must be visible
 * SOMEWHERE. It was visible as a strip above the session columns — exactly the
 * "section show the work items above" the owner asked to fold into a tab. So
 * the strip does not get deleted, it gets RE-HOMED into the Work items tab's
 * needs-you column, where it reads as what it is.
 *
 * Not every ask is a work item (an improvement triage, a dark-flag
 * ratification, an owner wall) — their kind rides on the card as a badge so
 * the distinction survives the move.
 */
export function askToCard(ask: HudAsk, nowMs: number): HudEntityCard {
  const kindLabel = HUD_ASK_KIND_LABEL[ask.kind] ?? ask.kind;
  return {
    id: `ask:${ask.id}`,
    ref: ask.itemRef ?? kindLabel,
    title: ask.title,
    column: 'needs-you',
    reason: ask.itemRef ? kindLabel : null,
    context: ask.planSlug ?? ask.harnessSlug ?? null,
    badges: [{ id: `${ask.id}:kind`, label: kindLabel, tone: 'warn' }],
    sinceSec: ageSec(ask.occurredAt, nowMs),
    sortKey: sortKeyFor('needs-you', ask.occurredAt),
  };
}

/**
 * The Work items board: the harness's own work items, plus the unattributed
 * asks folded into needs-you.
 *
 * DEDUPE is load-bearing. An ask of kind `work-item-needs-human` carries the
 * work item's id in `itemRef`, and that same work item is already in the
 * `workItems.byHarness` rows with `state = 'needs-human'` — so without this
 * the fold would render every such item twice, in the same column, which is
 * precisely the kind of double-count that makes a board untrustworthy. The
 * work item wins: it is the canonical row, and it carries kind/severity/
 * assignee the ask does not.
 */
export function buildWorkItemBoard(
  items: HudWorkItemInput[],
  asks: HudAsk[],
  opts: HudEntityBuildOptions,
): HudEntityBoard {
  const itemCards = items.map((i) => toWorkItemCard(i, opts.nowMs));
  const known = new Set(itemCards.map((c) => c.id));
  const askCards = asks
    .filter((a) => !a.itemRef || !known.has(a.itemRef))
    .map((a) => askToCard(a, opts.nowMs));
  return assemble([...itemCards, ...askCards], ITEM_COLUMN_EMPTY, opts);
}
