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

import type { BadgeTone, HudAsk, HudBadge } from './hud-board-model';
import { HUD_ASK_KIND_LABEL } from './hud-board-model';
import { WORK_ITEM_ID, trailingWorkItemId } from '@/lib/work-item-ref';
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
  /**
   * WHICH popup a click on this card opens (WI-6742). Set by the Work-items
   * board on every card it builds — real work items AND the folded asks — so
   * the handler never has to re-derive a destination by pattern-matching `id`
   * or `ref`. That re-derivation was the bug: an ask card's `ref` is a KIND
   * LABEL ("Improvement triage"), so it matched no work-item id and the click
   * silently did nothing.
   *
   * Optional because the Plans board doesn't use it (its card `id` IS the plan
   * slug, and its own handler reads that directly).
   */
  open?: HudAskTarget;
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
  /**
   * TRUE per-column totals over the whole store (P-004), when the caller can
   * supply them — the cards it passes are only a bounded sample.
   *
   * The docblock on `maxPerColumn` above promised "`counts` and `total` always
   * report the true numbers". That was false: counts were derived from whatever
   * rows happened to be fetched, so on `papercusp` the Work items tab reported
   * "201 needs you" (which were 201 unattributed ASKS and zero work items,
   * because none of the 45 real needs-human rows were inside the fetched
   * window) and "197 ready" against an actual 13,126. Every number on the board
   * was a window artifact wearing the clothes of a total.
   *
   * Supplying `totals` makes that promise true. Omitted ⇒ counts fall back to
   * the cards present, which is the honest answer when there is nothing better.
   */
  totals?: Partial<Record<HudEntityColumnId, number>> | null;
}

export const HUD_ENTITY_DEFAULT_MAX_PER_COLUMN = 60;

/* ── inputs ──────────────────────────────────────────────────────────────── */

/** The plan-list wire row, narrowed to what a card needs (see the file doc for
 *  why this is declared rather than imported from plans-api). */
export interface HudPlanInput {
  slug: string;
  title?: string | null;
  status: string;
  updated?: string | null;
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

/**
 * The statuses the Work items tab fetches cards for (P-004), one bounded slice
 * each — see `workItems.byHarness`'s `states` arg for why a single
 * `updated_ts DESC` window is the wrong sample for a status-grouped board.
 *
 * Derived from the SAME vocabulary `workItemColumn` maps below (every branch it
 * names, plus the two `ready` states), so a status added to one is a visible
 * omission in the other rather than a column that silently stops loading.
 */
export const HUD_WORK_ITEM_FETCH_STATES: readonly string[] = [
  'needs-human',
  'wip',
  'in-progress',
  'blocked',
  'open',
  'todo',
  ...SETTLED_STATES,
];

/**
 * Roll a `{ state, n }` aggregate (the `workItems.stats` feed) up into TRUE
 * per-column totals, through the SAME `workItemColumn` mapping the cards use —
 * so the counts and the cards can never disagree about which column a status
 * belongs to. That shared mapping is the reason this rollup lives here in TS
 * rather than as a GROUP BY over a column expression in SQL.
 */
export function rollUpStateCounts(
  rows: readonly { state?: string | null; n?: number | null }[],
): Record<HudEntityColumnId, number> {
  const out = Object.fromEntries(
    HUD_ENTITY_COLUMNS.map((id) => [id, 0]),
  ) as Record<HudEntityColumnId, number>;
  for (const r of rows) {
    const n = typeof r.n === 'number' && Number.isFinite(r.n) ? r.n : 0;
    if (n <= 0) continue;
    out[workItemColumn(r.state)] += n;
  }
  return out;
}

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

  /* True totals REPLACE the sampled counts — but only when no query is active.
     A filter's whole contract on this board is that "the counts above always
     describe what is actually on screen"; a store-wide total would break that
     the moment you typed into the box. So filtering falls back to counting the
     matches, which is then genuinely the right number. */
  const filtering = q.length > 0;
  const totals = filtering ? null : opts.totals ?? null;
  if (totals) {
    for (const id of HUD_ENTITY_COLUMNS) {
      const t = totals[id];
      // Never report FEWER than the cards actually held: the ask cards folded
      // into needs-you are not work items and so are not in the store-side
      // totals, and a count below the visible card count reads as a bug.
      if (typeof t === 'number' && Number.isFinite(t)) {
        counts[id] = Math.max(t, counts[id]);
      }
    }
  }

  const columns = HUD_ENTITY_COLUMNS.map((id) => {
    const all = byColumn.get(id)!.slice().sort((a, b) => a.sortKey - b.sortKey);
    const cards = all.slice(0, max);
    return {
      id,
      label: HUD_ENTITY_COLUMN_LABEL[id],
      empty: empty[id],
      cards,
      // Hidden is measured against the COUNT, not the sample: with true totals
      // the rows this board never fetched are hidden too, and saying so is the
      // difference between a bounded view and a wrong one.
      hidden: Math.max(0, counts[id] - cards.length),
    };
  });

  return {
    columns,
    counts,
    total: totals
      ? HUD_ENTITY_COLUMNS.reduce((n, id) => n + counts[id], 0)
      : kept.length,
  };
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

/**
 * Narrow the shared theme's `ToneKey` to the board's `BadgeTone`.
 *
 * `SEVERITY_TONE` is reused from `harness/theme` rather than kept as a second
 * local copy — but the theme's tone vocabulary is WIDER than a badge's: it
 * carries presentation-only keys (`fg`, …) that no chip knows how to render.
 * Every value currently mapped happens to be a legal badge tone, which is
 * exactly what makes a bare cast tempting and wrong: it would compile today
 * and start emitting an unstyleable chip the day somebody maps a severity to
 * one of the other keys.
 *
 * So this narrows by CHECKING, and falls back to the neutral chip for anything
 * outside the badge vocabulary — the same "degrade to something renderable
 * rather than trust the input" posture `workItemColumn` takes for an
 * unrecognized state.
 */
const BADGE_TONES: ReadonlySet<string> = new Set<BadgeTone>([
  'neutral',
  'accent',
  'good',
  'warn',
  'bad',
]);

export function toBadgeTone(tone: string | undefined | null): BadgeTone {
  return tone && BADGE_TONES.has(tone) ? (tone as BadgeTone) : 'neutral';
}

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
    // Set here too, not just on asks: `open` is the ONE thing the click handler
    // reads, so a card without it is a dead button by construction. A real work
    // item is its own destination — `harnessSlug` stays null so the popup falls
    // back to the board's active harness, which is correct for these (unlike an
    // ask, they only ever render under a resolved harness).
    open: { kind: 'work-item', id: item.id, harnessSlug: null },
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
/* The id grammar itself now lives in `@/lib/work-item-ref` — the chat's
 * status-card drill-in shipped the SAME anchored-whole-token bug independently
 * (also "unit tested green", also dead live), so the rule is shared rather than
 * spelled out twice. The shapes THIS caller must handle are recorded there.
 *
 *   · a card id is `ask:<ask.id>`, itself composite with the item LAST —
 *     `ask:work-item-needs-human:WI-1142`, `ask:owner-wall:work-item:WI-4271`
 *   · a card ref is a DISPLAY string ({@link askToCard} sets `ask.itemRef ?? kindLabel`),
 *     so it reads "Work item" / "Owner wall" whenever the ask has no itemRef — the
 *     case for every live card — and when itemRef IS set the curator writes it
 *     harness-qualified (`papercusp#WI-7`, see attention/adapters.test.ts). */

/** Which work item, if any, a Work-items board card opens.
 *
 *  Lives here rather than in HudView because the contract it reads is `askToCard`'s,
 *  directly below — the two drifted apart once already and the click silently died.
 *  An ask with no work item behind it (`ask:improvement-triage:1234`) still resolves
 *  to null, so it opens nothing instead of pointing the popup at a kind label. */
export function workItemIdForCard(card: Pick<HudEntityCard, 'id' | 'ref'>): string | null {
  if (WORK_ITEM_ID.test(card.id)) return card.id.toUpperCase();
  if (card.id.startsWith('ask:')) {
    return trailingWorkItemId(card.id) ?? trailingWorkItemId(card.ref);
  }
  return null;
}

/**
 * WHERE a click on a Work-items card lands (WI-6742, owner-reported: a card in
 * the "Needs you" column did nothing while every other column opened a popup).
 *
 * There is deliberately no "nothing" member. The bug was that a destination
 * could come back null while `HudEntityColumns` still rendered the card as a
 * `<button>` — board-wide, because the board supplies `onOpenCard`, not
 * per-card. A total function is what makes that unrepresentable: every card
 * carries somewhere to go, so a card that LOOKS activatable is.
 */
export type HudAskTarget =
  | { kind: 'work-item'; id: string; harnessSlug: string | null }
  | { kind: 'plan'; slug: string }
  | { kind: 'ask'; askId: string };

/**
 * The ask → destination rule, in the owner's chosen order (2026-07-28: "entity
 * if there is one, else the ask").
 *
 * ⚠ The order is load-bearing and the work-item check MUST come first. An ask
 * frequently carries BOTH a work item and a `planSlug` — the latter as mere
 * context (`askToCard` renders it in the `context` slot for exactly that
 * reason) — so routing on the plan first would send every work-item-needs-human
 * ask to a plan popup instead of the item the human asked about.
 *
 * The `ask` case is a real destination, not a give-up: an improvement-triage or
 * standing-approval ask IS the thing to act on, and it carries its own
 * approve/resolve actions. That is also why an unmapped `ref.kind` degrades
 * here rather than to null — a new adapter can never reintroduce a dead button.
 */
export function askTargetFor(ask: HudAsk): HudAskTarget {
  const itemId = trailingWorkItemId(ask.itemRef) ?? trailingWorkItemId(ask.id);
  if (itemId) return { kind: 'work-item', id: itemId, harnessSlug: ask.harnessSlug ?? null };
  if (ask.ref?.kind === 'plan-item' && ask.ref.slug) {
    return { kind: 'plan', slug: ask.ref.slug };
  }
  return { kind: 'ask', askId: ask.id };
}

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
    open: askTargetFor(ask),
  };
}

/**
 * The Work items board: the harness's own work items, plus the unattributed
 * asks folded into needs-you.
 *
 * DEDUPE is load-bearing. An ask of kind `work-item-needs-human` names a work
 * item that is ALSO in the `workItems.byHarness` rows with
 * `state = 'needs-human'` — so without this the fold would render every such
 * item twice, in the same column, which is precisely the kind of double-count
 * that makes a board untrustworthy. The work item wins: it is the canonical
 * row, and it carries kind/severity/assignee the ask does not.
 *
 * ⚠ WI-6597 — this guard was INERT on the live board, in two independent ways,
 * and both are why it compares NORMALIZED IDS rather than raw ref strings:
 *
 *   1. `ask.itemRef` was null on 60/60 live cards (the attention adapter never
 *      populated it), so `!a.itemRef` short-circuited true and EVERY ask
 *      survived. Fixed upstream too, but the board must not depend on that: the
 *      ask's own `id` already ends in the work-item id
 *      (`work-item-needs-human:WI-1142`), so read the id from EITHER. A guard
 *      that only works when an optional upstream field is populated is a guard
 *      that silently stops working.
 *   2. Even with `itemRef` set it could not have matched: the curator writes it
 *      HARNESS-QUALIFIED (`papercusp#WI-1142`) while `known` held bare card ids
 *      (`WI-1142`), so `known.has(...)` was false for every populated ref too.
 *
 * Both collapse into one rule, the same one `workItemIdForCard` follows: a ref
 * token is a PATH with the id LAST — read the trailing segment via
 * `trailingWorkItemId`, never compare whole tokens. Hand-written `WI-7`-shaped
 * fixtures hide this (no producer emits that shape), so the tests use the real
 * strings — see work-item-ref.ts's warning.
 */
export function buildWorkItemBoard(
  items: HudWorkItemInput[],
  asks: HudAsk[],
  opts: HudEntityBuildOptions,
): HudEntityBoard {
  const itemCards = items.map((i) => toWorkItemCard(i, opts.nowMs));
  const known = new Set(
    itemCards.map((c) => trailingWorkItemId(c.id) ?? c.id.toUpperCase()),
  );
  const askCards = asks
    .filter((a) => {
      const id = trailingWorkItemId(a.itemRef) ?? trailingWorkItemId(a.id);
      return !id || !known.has(id);
    })
    .map((a) => askToCard(a, opts.nowMs));
  return assemble([...itemCards, ...askCards], ITEM_COLUMN_EMPTY, opts);
}
