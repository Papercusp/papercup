/**
 * hud-board-model — the pure derivation behind /adv/HUD's fleet board
 * (adv-hud-fleet-board-2026-07-25 P-002).
 *
 * The board answers ONE question: *where is the work piling up?* Its columns are
 * therefore DERIVED from live session state, never assigned by a human — which
 * is exactly why the board is not built on the repo's dnd-kit `Kanban` primitive
 * (plan D-001): a drag affordance would promise that moving a card changes the
 * session's state, and it cannot.
 *
 * Everything here is pure and clock-injected so the whole classification is
 * unit-testable without PG, without React, and without a real `Date.now()`. The
 * component layer does presentation only; if you find yourself deriving state in
 * a `.tsx` under this directory, it belongs here instead.
 *
 * The two columns that justify the surface are `blocked` and `stalled`. Both are
 * failure modes nobody raises a hand for: a gate that will never open, and an
 * agent that is nominally alive but has stopped moving. Everything else the
 * roster already showed; these are the ones that cost hours.
 */

import { deepEqual } from '@papercusp/rules';

import type { Liveness } from '@papercusp/operator-core/lib/liveness';
// Mode chip label + hover come from the registry (pure data, zero imports of its
// own — safe in the SPA bundle) so the five official modes are explained here
// without this file keeping its own copy of what each one means.
import { modeChipLabel, modeChipTitle } from '@papercusp/operator-core/lib/modes/registry';

/**
 * Sentinel for the "all fleets" chip. Not a real slug (slugs are kebab and never
 * contain a space), so it cannot collide with one.
 *
 * EXPORTED deliberately: HudBoard raises it and HudView compares against it, and
 * when each spelled the literal out itself the two silently drifted — HudBoard's
 * copy had its leading space corrupted to a raw NUL byte, so `slug === ALL_FLEETS`
 * never matched and the chip filtered the board to nothing instead of clearing
 * the filter. A whitespace-ish sentinel is invisible in a diff, so it gets exactly
 * one definition; never re-spell it inline.
 */
export const ALL_FLEETS = ' all';

/** Grouping key for sessions belonging to no fleet. Same rule: one definition. */
export const SOLO_FLEET_KEY = ' solo';

/**
 * Sentinel for the "All plans" row of the plan filter (P-004) — the plan-axis
 * twin of ALL_FLEETS, and same rule: ONE definition, never re-spelled inline
 * (see ALL_FLEETS' docblock for the NUL-byte drift that rule is paying for).
 * A leading space keeps it out of slug space.
 */
export const ALL_PLANS = ' all-plans';

/**
 * The plan filter's token for "sessions bound to no plan at all".
 *
 * Unlike the fleet strip — which carries SOLO_FLEET_KEY as its grouping key and
 * then spells `'solo'` again as the URL token in HudView — this is ONE constant
 * doing both jobs: it is the Combobox option value AND the value that lands in
 * the `hudplan` query param. Two spellings of one concept is exactly what
 * ALL_FLEETS' comment is a monument to; a plain token needs no %20 in the URL,
 * so there is no reason to have a second form.
 */
export const NO_PLAN_TOKEN = 'none';

/** One standing mode as the roster delivers it (adv-roster's AdvRosterMode). */
export interface HudMode {
  mode: string;
  ownerDirected?: boolean;
  since?: string | null;
}

/** Normalize the tolerated bare-string form to the object form. */
export function toHudMode(m: HudMode | string): HudMode {
  return typeof m === 'string' ? { mode: m } : m;
}

/** The open `events:await` shape as the roster carries it (adv-roster's OpenAwait).
 *  Re-declared structurally so this client module never imports the server file. */
export interface HudOpenAwait {
  eventKey: string;
  note: string | null;
  sinceIso: string;
  expiresIso: string | null;
}

/**
 * The subset of `RosterEntry` the board reads. Structural, not an import: the
 * server module pulls in the PG presence store, and importing it from a client
 * component leaks node builtins into the SPA bundle (the operator-vite
 * blank-page failure mode). The endpoint JSON is the contract.
 */
export interface HudRosterEntry {
  ownerId: string;
  label: string;
  source: string;
  intent: string;
  currentFiles: string[];
  liveness: Liveness;
  /**
   * THE liveness verdict from the shared oracle (adv-roster's `sessionState`,
   * via `resolveSessionStates`) — the same one coord:presence, fleet:status and
   * leader-brief project. Optional so a payload from an older operator (or a
   * mid-deploy SSE push) still classifies via the heartbeat legs.
   *
   * `liveness` above is HEARTBEAT FRESHNESS, not "is it taking turns" — a
   * parked agent waiting on its inbox keeps beating, so `liveness` reads 'live'
   * for a session that has not taken a turn in days. Prefer this field.
   */
  sessionState?: string | null;
  stale: boolean;
  lastActiveAt: string | null;
  intentDeclaredAt: string | null;
  loopArmed: boolean;
  /** Standing modes with provenance (adv-roster's AdvRosterMode). A bare string is
   *  tolerated so a roster payload from an older operator still renders chips
   *  instead of throwing — federation and a mid-deploy SSE push both produce one. */
  modes: Array<HudMode | string>;
  pidAlive: boolean | null;
  claims: Array<{ id?: string; planSlug?: string | null; status?: string | null }>;
  declaredUnclaimed: boolean;
  currentPlanSlug: string | null;
  /** The harness a spawned-agent run row attributes this session to (adv-
   *  roster.ts's `spawnedAgentRunInfoByOwner`) — null for a session with no
   *  matching run (chat-ref-pills-2026-07-26 P-008: SessionChatModal's own
   *  harness scoping for its WI-/EI-/F- ref-pill popup destinations). Always
   *  present on the raw roster row; only newly TYPED here. */
  harnessSlug: string | null;
  agentPaneKind: string;
  role: string | null;
  agent: string | null;
  advSessionId: number | null;
  windowId: string | null;
  wakeMode: string | null;
  pendingWakes: number;
  fleetSlug: string | null;
  fleetColor: string | null;
  fleetRole: string | null;
  contextTokens: number | null;
  compactionLimit: number | null;
  openAwait: HudOpenAwait | null;
  thinking: boolean;
  /** The adv_sessions `display` hint. Optional — only the launch-record tiers
   *  carry one ('workbench' for a D-006 pane launch, 'terminal' for a WI-6376
   *  terminal spawn); a presence-derived row has none. Read ONLY to tell a
   *  terminal launch that never came online from one that is still booting. */
  display?: string | null;
  /** When the session (or its launch record) started. Optional for the same
   *  reason as `display`. */
  startedAt?: string | null;
}

/** How long a terminal-spawned launch may sit un-registered before the board
 *  stops calling it "starting" and calls it a launch that never came online.
 *  Matches the 60s did-not-come-online fallback WI-6367 gave the chat modal —
 *  the two surfaces should not disagree about the same session. */
export const TERMINAL_LAUNCH_ONLINE_GRACE_SEC = 60;

/** An unanswered thing addressed to the human, keyed to the agent that asked.
 *  Sourced from the SAME `plans.attention` feed the inbox and Queue read — the
 *  board never invents a second asks pipeline.
 *
 * `ownerAgentId` is nullable BY DESIGN, not an edge case to special-case away:
 * several AttentionItem sources (hud-consolidation-2026-07-26 P-002 — the
 * `improvement`, `standing-approval`, and `dark-flag-ratification` adapters
 * structurally always carry `ownerAgentId: null`; `operator-report` and
 * `plan-item` carry it only when a claimant is resolvable) are genuine
 * needs-human Decisions with no live agent to attach them to. Live count as
 * of 2026-07-26 (workspace-wide, papercusp harness — the query is `plans:
 * attention` with `payloadTier:'full'`, decision-tier items filtered
 * `!ownerAgentId`): 301, dominated by `work-item-needs-human` (240). These
 * MUST still render somewhere on the board (see `unattributedAsks` /
 * `HudBoard.unattributed`) — a `.filter(i => i.ownerAgentId)` upstream of
 * this type would silently drop every one of them with no UI anywhere in the
 * app once the sidebar Inbox is retired (D-001). The remaining fields
 * (id/kind/itemRef/planSlug/harnessSlug) mirror the subset of `AttentionItem`
 * an unattributed card needs to render + be identified without an owning
 * agent to key off of. */
export interface HudAsk {
  ownerAgentId: string | null;
  title: string;
  occurredAt: string | null;
  /** The source AttentionItem's own id — stable React key for an unattributed
   *  card (there is no ownerAgentId to key off of). */
  id: string;
  /** AttentionItem['kind'] — not re-typed here (a full string import would
   *  drag the admin/plans module into this pure, PG-free file); rendered as a
   *  human label via HUD_ASK_KIND_LABEL, unknown kinds falling back to the
   *  raw string. */
  kind: string;
  itemRef: string | null;
  planSlug: string | null;
  harnessSlug: string | null;
}

/** Human label for an unattributed ask's kind badge. Deliberately covers only
 *  the kinds that are STRUCTURALLY capable of reaching here (ownerAgentId
 *  null on a decision-tier item — see HudAsk's doc) rather than every
 *  AttentionKind; an unlisted kind still renders via the raw string
 *  fallback, so this table can never make a real ask invisible by omission. */
export const HUD_ASK_KIND_LABEL: Record<string, string> = {
  improvement: 'Improvement triage',
  'standing-approval': 'Standing approval',
  'dark-flag-ratification': 'Dark flag',
  'operator-report': 'Operator report',
  'plan-item': 'Plan item',
  'work-item-needs-human': 'Work item',
  'owner-wall': 'Owner wall',
};

/** The unattributed asks — needs-human items with no `ownerAgentId` to key a
 *  session card off of (see HudAsk's doc for why this is structural, not an
 *  edge case). Oldest first: the same urgency ordering `deriveColumn` applies
 *  to a session's own needs-you reason. */
export function unattributedAsks(asks: HudAsk[]): HudAsk[] {
  return asks
    .filter((a) => !a.ownerAgentId)
    .slice()
    .sort((a, b) => {
      const at = a.occurredAt ? new Date(a.occurredAt).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.occurredAt ? new Date(b.occurredAt).getTime() : Number.POSITIVE_INFINITY;
      return at - bt;
    });
}

export const HUD_COLUMNS = ['needs-you', 'working', 'blocked', 'stalled', 'parked'] as const;
export type HudColumnId = (typeof HUD_COLUMNS)[number];

export const HUD_COLUMN_LABEL: Record<HudColumnId, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  blocked: 'Blocked',
  stalled: 'Stalled',
  parked: 'Parked · done',
};

/** Per-column one-liner shown when the column is EMPTY. Written as good news,
 *  because an empty Blocked/Stalled column IS the good outcome. */
export const HUD_COLUMN_EMPTY: Record<HudColumnId, string> = {
  'needs-you': 'Nothing is waiting on you',
  working: 'No sessions are running',
  blocked: 'Nothing is waiting on a gate',
  stalled: 'Everything alive is moving',
  parked: 'Nothing parked',
};

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

export interface HudBadge {
  id: string;
  label: string;
  tone: BadgeTone;
  /** Hover text — the full explanation the short label compresses. */
  title?: string;
  /** 'mode' = a standing mode (rendered always, exempt from the chip cap);
   *  'stat' (default) = a derived statistic, capped by the card. */
  kind?: 'mode' | 'stat';
  /** Mode chips only: the human owner armed it, so it is sticky against peers. */
  ownerDirected?: boolean;
}

export interface HudSession {
  ownerId: string;
  /** Short display handle, e.g. `su-92bacd`. */
  handle: string;
  label: string;
  /** Declared intent, or null when the agent never declared one (the roster
   *  normalizes its self-referential placeholder away, so empty means empty). */
  intent: string | null;
  column: HudColumnId;
  /** Why it landed in this column, in words a human can act on. */
  reason: string;
  /** Seconds it has been in this condition; null when unknown. */
  sinceSec: number | null;
  badges: HudBadge[];
  fleetSlug: string | null;
  fleetColor: string | null;
  isLeader: boolean;
  planSlug: string | null;
  blockedOn: HudOpenAwait | null;
  /** Context use as a 0–100 percentage; null when never sampled (NOT 0 — an
   *  unmeasured context rendered as 0% reads as "plenty of room left"). */
  contextPct: number | null;
  claimedCount: number;
  doneCount: number;
  advSessionId: number | null;
  windowId: string | null;
  /** Sort key WITHIN the column: lower sorts first. */
  sortKey: number;
}

export interface HudFleetRollup {
  fleetSlug: string | null;
  fleetColor: string | null;
  label: string;
  total: number;
  leaderOwnerId: string | null;
  byColumn: Record<HudColumnId, number>;
  /** The one-line health note shown beside the fleet chip — present only when
   *  something is actually wrong, so its absence is meaningful. */
  warning: string | null;
}

/**
 * One row of the plan filter (P-004) — the plan-axis twin of HudFleetRollup.
 *
 * Deliberately the same SHAPE as a fleet rollup rather than a bare
 * `{ slug, count }`: the plan filter "works like the existing fleet filter"
 * (P-004), and the per-column breakdown is what lets a plan row carry the same
 * one-line health note a fleet chip does — "3 needs you, 1 stalled" reads the
 * same whether the group is a fleet or a plan.
 */
export interface HudPlanRollup {
  /** `null` = sessions bound to no plan. Rendered from NO_PLAN_TOKEN. */
  planSlug: string | null;
  label: string;
  total: number;
  byColumn: Record<HudColumnId, number>;
  /** Present only when something needs a human — an absent warning is itself
   *  information, exactly as on HudFleetRollup. */
  warning: string | null;
}

export interface HudBoard {
  columns: Array<{ id: HudColumnId; label: string; empty: string; sessions: HudSession[] }>;
  fleets: HudFleetRollup[];
  /**
   * The plan filter's option list, derived from the sessions the FLEET filter
   * left in view but BEFORE the plan filter narrows them (P-004: "driven by the
   * fleets currently in view"). See buildHudBoard for why that ordering is
   * load-bearing rather than incidental.
   */
  plans: HudPlanRollup[];
  counts: Record<HudColumnId, number>;
  total: number;
  /** Needs-human asks with no owning agent — see `unattributedAsks`. Kept
   *  OUT of `counts`/`columns['needs-you']`: those are per-SESSION
   *  classifications, and an unattributed ask has no session to classify. */
  unattributed: HudAsk[];
}

export interface HudThresholds {
  /** No genuine tool activity for this long, while nominally alive ⇒ stall
   *  candidate. The heartbeat keeps beating every 60s regardless, so activity —
   *  not heartbeat — is the only honest movement signal. */
  stallActivitySec: number;
  /** …AND the intent text has not changed for this long. Both are required: a
   *  long single task with fresh tool calls is working, not stalled. */
  stallIntentSec: number;
  contextWarnPct: number;
  contextCritPct: number;
}

export const HUD_DEFAULT_THRESHOLDS: HudThresholds = {
  stallActivitySec: 15 * 60,
  stallIntentSec: 30 * 60,
  contextWarnPct: 60,
  contextCritPct: 85,
};

export interface HudBuildOptions {
  /** Injected clock (ms epoch) — never read Date.now() inside the model. */
  nowMs: number;
  thresholds?: HudThresholds;
  /** Restrict to the owner's own su sessions (plan D-003). The roster carries
   *  ~85 agents, mostly nursery cups; showing them all rebuilds the firehose the
   *  board exists to replace. */
  suOnly?: boolean;
  /** Show only these fleets (empty/omitted = all). `null` selects the no-fleet
   *  (solo) group, so it can be filtered like any other. */
  fleets?: Array<string | null>;
  /** Show only sessions on these plans (empty/omitted = all). `null` selects
   *  the no-plan group, so it filters like any other — same contract as
   *  `fleets`, on purpose (P-004). Applied AFTER `fleets`. */
  plans?: Array<string | null>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** `su-709bb0d6-12de-…` → `su-709bb0d6`. Long uuids are unreadable on a card and
 *  the leading segment is already unique in practice. */
export function shortHandle(ownerId: string): string {
  const m = /^([a-z]+)-([0-9a-f]{6,8})/i.exec(ownerId);
  if (m) return `${m[1]}-${m[2]}`;
  return ownerId.length > 16 ? `${ownerId.slice(0, 16)}…` : ownerId;
}

function ageSec(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Compact duration for a card: `40s`, `12m`, `3h`, `2d`. */
export function formatAge(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Context use as a percentage, or null when either input is unknown. Returning
 *  null (rather than 0) is deliberate — see HudSession.contextPct. */
export function contextPct(tokens: number | null, limit: number | null): number | null {
  if (tokens == null || limit == null || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
}

/**
 * Awaits that are INFRASTRUCTURE, not a block on work.
 *
 * `coord:inbox-wake:<self>` is armed permanently for every agent at
 * SessionStart (migration 183) and means "I am reachable by a wake" — the
 * opposite of blocked. Measured live while building this board: 126 of 139 open
 * awaits were inbox-wakes, one per agent, against 13 real gates. Treating them
 * as blocks would have parked ~93% of sessions in Blocked and made the column
 * worthless, since a signal that fires for nearly everyone distinguishes no one.
 *
 * The server query already excludes these; this is the second line of defence,
 * so a caller passing a raw awaits list (a test, a future endpoint, a cached
 * payload written before that fix) still cannot resurrect the bug.
 */
export function isInfrastructureAwait(a: HudOpenAwait | null | undefined): boolean {
  return Boolean(a && a.eventKey.startsWith('coord:inbox-wake:'));
}

/** Is this entry one of the owner's interactive su sessions? Uses the existing
 *  shared taxonomy (classifyAgentPane stamps `agentPaneKind`) rather than
 *  re-sniffing ids, so the board can't drift from the rest of the app. */
export function isSuSession(e: HudRosterEntry): boolean {
  return e.agentPaneKind === 'su';
}

/** The asks addressed to the human, grouped by the agent that asked. */
export function asksByOwner(asks: HudAsk[]): Map<string, HudAsk[]> {
  const out = new Map<string, HudAsk[]>();
  for (const a of asks) {
    if (!a.ownerAgentId) continue;
    const list = out.get(a.ownerAgentId);
    if (list) list.push(a);
    else out.set(a.ownerAgentId, [a]);
  }
  return out;
}

// ── column derivation ───────────────────────────────────────────────────────

export interface ColumnVerdict {
  column: HudColumnId;
  reason: string;
  sinceSec: number | null;
}

/**
 * Classify ONE session. Precedence is the whole design, so it is spelled out
 * rather than implied:
 *
 *   needs-you > blocked > stalled > working > parked
 *
 * - `needs-you` outranks everything because it is the only column whose fix is
 *   the human's to apply; a blocked agent that ALSO asked you something is your
 *   problem first.
 * - `blocked` outranks `stalled` because an agent parked on a gate is behaving
 *   CORRECTLY — calling it stalled would cry wolf on the one signal that must
 *   stay trustworthy.
 * - `stalled` outranks `working` because it is the *contradiction* of working:
 *   nominally alive, demonstrably not moving.
 */
export function deriveColumn(
  e: HudRosterEntry,
  asks: HudAsk[] | undefined,
  opts: { nowMs: number; thresholds: HudThresholds },
): ColumnVerdict {
  const { nowMs, thresholds } = opts;

  // 1. Needs you — an unanswered directed ask, or a wake staged behind manual
  //    mode. A staged wake is genuinely owner-gated: the message is sitting
  //    there undelivered until a human releases it.
  if (asks && asks.length > 0) {
    const oldest = asks.reduce((acc, a) => {
      const t = a.occurredAt ? new Date(a.occurredAt).getTime() : Number.POSITIVE_INFINITY;
      return t < acc.t ? { t, a } : acc;
    }, { t: Number.POSITIVE_INFINITY, a: asks[0] });
    return {
      column: 'needs-you',
      reason: oldest.a.title || 'Asked you a question',
      sinceSec: ageSec(oldest.a.occurredAt, nowMs),
    };
  }
  if (e.pendingWakes > 0) {
    return {
      column: 'needs-you',
      reason: `${e.pendingWakes} wake${e.pendingWakes === 1 ? '' : 's'} staged behind manual mode — nothing reaches this agent until you release them`,
      sinceSec: null,
    };
  }
  // 1c. Fresh — launched but has never taken a turn (owner ask 2026-07-27: "all
  //     fresh sessions start as needs you"). These used to land in `parked`, which
  //     was precisely backwards: a session you just launched is not idle-and-fine,
  //     it is sitting there with no task, and the ONLY thing that starts it moving
  //     is you telling it what to work on. That is the definition of this column —
  //     the one whose fix is the human's to apply.
  //
  //     `lastActiveAt == null` is the honest "never took a turn" signal: the
  //     pending tier synthesizes it as null (adv-roster's pendingLaunchesToRosterEntries)
  //     and a real session sets it on its first tool call, so a session leaves this
  //     column on its own the moment it starts working — no timer, no cleanup.
  //
  //     Guarded on !stale so a session that was recorded, never ran, and has since
  //     died is NOT advertised as fresh; that one is genuinely parked (dead), and
  //     calling it "needs you" would put unfixable rows in the column whose whole
  //     value is that everything in it is actionable.
  if (e.lastActiveAt == null && !e.stale && e.liveness !== 'stale') {
    // WI-6376: a TERMINAL launch that is still un-registered well past the point
    // it should have booted is not "fresh", it is a launch that failed — the
    // terminal never opened, or psu died on startup. Say so. It stays in
    // needs-you because it is still the human's to fix (relaunch it); what
    // changes is that the card stops implying a healthy session is on its way.
    const sinceStart = ageSec(e.startedAt ?? null, nowMs);
    if (
      e.display === 'terminal' &&
      sinceStart != null &&
      sinceStart >= TERMINAL_LAUNCH_ONLINE_GRACE_SEC
    ) {
      return {
        column: 'needs-you',
        reason: `Launched ${formatAge(sinceStart)} ago but never came online — the terminal may have failed to start. Relaunch it.`,
        sinceSec: sinceStart,
      };
    }
    return {
      column: 'needs-you',
      reason:
        e.liveness === 'pending'
          ? 'Fresh session — launched, not started yet. Tell it what to work on.'
          : 'Fresh session — no turn taken yet. Tell it what to work on.',
      sinceSec: null,
    };
  }

  // 2. Blocked — parked on a REAL gate, and we know which one. An
  //    infrastructure await (the always-armed inbox wake every agent holds) is
  //    explicitly not a block: see isInfrastructureAwait for why counting it
  //    would have swallowed ~93% of the roster.
  if (e.openAwait && !isInfrastructureAwait(e.openAwait)) {
    const waited = ageSec(e.openAwait.sinceIso, nowMs);
    return {
      column: 'blocked',
      reason: e.openAwait.note?.trim()
        ? `${e.openAwait.note.trim()} (${e.openAwait.eventKey})`
        : `Waiting on ${e.openAwait.eventKey}`,
      sinceSec: waited,
    };
  }

  // 3. Stalled — nominally alive but not moving. Requires BOTH a dead activity
  //    clock and an unchanged intent, so a long single task with live tool calls
  //    is never mislabelled.
  const sinceActivity = ageSec(e.lastActiveAt, nowMs);
  const sinceIntent = ageSec(e.intentDeclaredAt, nowMs);
  // WI-6636: "nominally alive" MUST come from the shared liveness oracle, not
  // from `liveness`. `liveness` is heartbeat freshness alone, and a PARKED agent
  // — idle between turns, waiting on its inbox wake — keeps beating, so it reads
  // 'live' forever. Combined with the stall test below (no tool call in 15min +
  // unchanged intent for 30min), every parked agent eventually became "Stalled":
  // measured 2026-07-28 on the default board, 110 of 133 cards, median 2 DAYS
  // and up to 11 days stale, while coord:presence called the same population
  // live 5 / parked 123. The board asserted the system was mostly stuck when it
  // was mostly idle — and `parked` is column 5, whose own doc says it is "not a
  // problem by itself".
  //
  // `loopArmed` stays in the test on purpose, and is the one case where a
  // non-live verdict still belongs here: an agent whose engine loop is armed is
  // SUPPOSED to be producing turns on a cadence, so an armed loop with a dead
  // activity clock is a dead loop — the sharpest genuine stall this column can
  // report, and exactly what it exists for.
  //
  // `sessionState` absent/null means the oracle had no verdict (an older
  // payload, or a degraded fetch). Fall back to the heartbeat legs rather than
  // guessing — an unknown verdict must never silently empty this column, which
  // would hide a real stall instead of a fake one.
  const nominallyAlive =
    e.sessionState != null
      ? e.sessionState === 'live' || e.loopArmed
      : e.liveness === 'live' || e.liveness === 'idle' || e.loopArmed;

  // A zombie is the sharpest case: heartbeat fresh, process gone. Report it as a
  // stall with its own reason rather than letting it masquerade as working.
  if (nominallyAlive && e.pidAlive === false && !e.stale) {
    return {
      column: 'stalled',
      reason: 'Heartbeat is fresh but the OS process is gone — this session is a zombie',
      sinceSec: sinceActivity,
    };
  }
  if (
    nominallyAlive &&
    sinceActivity != null &&
    sinceActivity >= thresholds.stallActivitySec &&
    sinceIntent != null &&
    sinceIntent >= thresholds.stallIntentSec
  ) {
    return {
      column: 'stalled',
      reason: `No tool call in ${formatAge(sinceActivity)} and the intent has not changed in ${formatAge(sinceIntent)}`,
      sinceSec: sinceActivity,
    };
  }

  // 4. Working — taking turns, thinking, or carried by an armed loop.
  //
  // WI-6636: this must consult the oracle for the same reason step 3 does, and
  // it is the half that makes the fix safe. Dropping parked agents out of
  // `stalled` without touching this test would have sent all 110 straight into
  // `working` — `liveness` reads 'live' for every one of them — turning a board
  // that overstated stalls into one that overstates progress, which is worse.
  // `thinking` is kept as an independent override: it is a direct in-flight
  // signal (transcript appended within the thinking window) that can lead the
  // oracle, never trail it.
  const oracleWorking =
    e.sessionState != null
      ? e.sessionState === 'live' || e.sessionState === 'recorded'
      : e.liveness === 'live';
  if (oracleWorking || e.thinking || (e.loopArmed && e.liveness !== 'stale')) {
    return {
      column: 'working',
      reason: e.intent?.trim() || 'Running',
      sinceSec: sinceActivity,
    };
  }

  // 5. Parked — idle, stale, ended, or not yet started. Not a problem by itself.
  return {
    column: 'parked',
    reason:
      e.liveness === 'pending'
        ? 'Recorded — has not started yet'
        : e.liveness === 'stale'
          ? 'No heartbeat — session has ended'
          : 'Idle between turns',
    sinceSec: sinceActivity,
  };
}

// ── badges ──────────────────────────────────────────────────────────────────

/** The chip row under a card's intent. Ordered by decision value, capped by the
 *  caller — the most useful chips must survive truncation. */
export function deriveBadges(
  e: HudRosterEntry,
  opts: { nowMs: number; thresholds: HudThresholds },
): HudBadge[] {
  const out: HudBadge[] = [];

  // NOTE: fleet leadership is deliberately NOT a badge. It is IDENTITY, not
  // state, so the card renders it beside the handle (HudSession.isLeader) —
  // emitting it here as well rendered "LEAD" twice on every leader card, and
  // spent one of the capped badge slots on it. Keep identity out of this row.

  // Standing modes decide whether your silence is fine or is the thing blocking
  // this agent — the single most useful chip on the card.
  //
  // Label and hover come from the MODE REGISTRY, not from a hand-written map
  // here: the map only covered auto/ideate/drain, so `cold-auto` and `grade`
  // rendered a bare "Standing mode: grade" that explained nothing. Registry-derived
  // means a mode added there is explained here the same day, with no edit.
  //
  // kind:'mode' is what keeps them out of the chip cap (HudBoard renders every
  // mode chip and caps only the stats) — an agent in auto+ideate+grade used to
  // spend the whole 4-chip budget on modes and hide its claims and asks.
  for (const raw of e.modes) {
    const m = toHudMode(raw);
    out.push({
      id: `mode-${m.mode}`,
      kind: 'mode',
      label: modeChipLabel(m.mode),
      tone: 'accent',
      ownerDirected: m.ownerDirected === true,
      title: modeChipTitle(m.mode, { ownerDirected: m.ownerDirected }),
    });
  }

  const claimed = e.claims.length;
  if (claimed > 0) {
    const done = e.claims.filter((c) => (c.status ?? '').toLowerCase() === 'done').length;
    out.push({
      id: 'claims',
      label: `${done}/${claimed}`,
      tone: done === claimed ? 'good' : 'neutral',
      title: `${done} of ${claimed} claimed item${claimed === 1 ? '' : 's'} done`,
    });
  }

  const pct = contextPct(e.contextTokens, e.compactionLimit);
  if (pct != null && pct >= opts.thresholds.contextWarnPct) {
    out.push({
      id: 'ctx',
      label: `ctx ${pct}%`,
      tone: pct >= opts.thresholds.contextCritPct ? 'bad' : 'warn',
      title: `Context ${pct}% full — answers degrade as this approaches the compaction limit`,
    });
  }

  // A manual-wake session STAGES your reply instead of delivering it. Surfacing
  // this is the difference between "it ignored me" and "it never heard me".
  if (e.wakeMode === 'manual') {
    out.push({
      id: 'wake',
      label: 'wake: manual',
      tone: 'warn',
      title: 'Messages are staged, not delivered, until released',
    });
  }

  if (e.loopArmed) {
    out.push({ id: 'loop', label: 'loop', tone: 'good', title: 'An engine loop is armed — it re-wakes on a cadence' });
  }

  // A declared plan with no claim backing it: the agent says it is on something
  // it never took, so peers cannot see the lane and work gets double-placed.
  if (e.declaredUnclaimed) {
    out.push({
      id: 'unclaimed',
      label: 'unclaimed lane',
      tone: 'warn',
      title: `Declared plan ${e.currentPlanSlug ?? ''} but claimed no item on it`.trim(),
    });
  }

  if (e.currentFiles.length > 0) {
    out.push({
      id: 'files',
      label: `${e.currentFiles.length} file${e.currentFiles.length === 1 ? '' : 's'}`,
      tone: 'neutral',
      title: e.currentFiles.join('\n'),
    });
  }

  return out;
}

// ── board assembly ──────────────────────────────────────────────────────────

/** Within a column, the longest-suffering card sorts first: a 40-minute block is
 *  more urgent than a 40-second one. Unknown ages sort last (they carry no
 *  urgency signal, so they must never outrank a measured one). */
function sortKeyFor(v: ColumnVerdict): number {
  return v.sinceSec == null ? Number.MAX_SAFE_INTEGER : -v.sinceSec;
}

export function toHudSession(
  e: HudRosterEntry,
  asks: HudAsk[] | undefined,
  opts: { nowMs: number; thresholds: HudThresholds },
): HudSession {
  const verdict = deriveColumn(e, asks, opts);
  const claimed = e.claims.length;
  const done = e.claims.filter((c) => (c.status ?? '').toLowerCase() === 'done').length;
  return {
    ownerId: e.ownerId,
    handle: shortHandle(e.ownerId),
    label: e.label,
    intent: e.intent?.trim() ? e.intent.trim() : null,
    column: verdict.column,
    reason: verdict.reason,
    sinceSec: verdict.sinceSec,
    badges: deriveBadges(e, opts),
    fleetSlug: e.fleetSlug,
    fleetColor: e.fleetColor,
    isLeader: e.fleetRole === 'leader',
    planSlug: e.currentPlanSlug,
    blockedOn: e.openAwait,
    contextPct: contextPct(e.contextTokens, e.compactionLimit),
    claimedCount: claimed,
    doneCount: done,
    advSessionId: e.advSessionId,
    windowId: e.windowId,
    sortKey: sortKeyFor(verdict),
  };
}

/** The fleet chips + their health notes. A fleet's warning names only the
 *  conditions that need a human — an all-clear fleet gets `null`, so the chip
 *  row stays quiet when everything is fine. */
export function deriveFleetRollups(sessions: HudSession[]): HudFleetRollup[] {
  const groups = new Map<string, HudFleetRollup>();
  for (const s of sessions) {
    const key = s.fleetSlug ?? SOLO_FLEET_KEY;
    let g = groups.get(key);
    if (!g) {
      g = {
        fleetSlug: s.fleetSlug,
        fleetColor: s.fleetColor,
        label: s.fleetSlug ?? 'solo',
        total: 0,
        leaderOwnerId: null,
        byColumn: { 'needs-you': 0, working: 0, blocked: 0, stalled: 0, parked: 0 },
        warning: null,
      };
      groups.set(key, g);
    }
    g.total += 1;
    g.byColumn[s.column] += 1;
    if (s.isLeader && !g.leaderOwnerId) g.leaderOwnerId = s.ownerId;
    if (!g.fleetColor && s.fleetColor) g.fleetColor = s.fleetColor;
  }
  for (const g of groups.values()) {
    const parts: string[] = [];
    if (g.byColumn['needs-you']) parts.push(`${g.byColumn['needs-you']} needs you`);
    if (g.byColumn.blocked) parts.push(`${g.byColumn.blocked} blocked`);
    if (g.byColumn.stalled) parts.push(`${g.byColumn.stalled} stalled`);
    // A fleet with members but no leader cannot be driven — nobody reclaims a
    // dead member's claim or opens the gates the members are parked on.
    if (g.fleetSlug && !g.leaderOwnerId) parts.push('no leader');
    g.warning = parts.length ? parts.join(', ') : null;
  }
  return [...groups.values()].sort((a, b) => {
    // Solo last; otherwise the fleet needing the most attention first.
    if ((a.fleetSlug == null) !== (b.fleetSlug == null)) return a.fleetSlug == null ? 1 : -1;
    const aw = a.byColumn['needs-you'] + a.byColumn.blocked + a.byColumn.stalled;
    const bw = b.byColumn['needs-you'] + b.byColumn.blocked + b.byColumn.stalled;
    if (aw !== bw) return bw - aw;
    return a.label.localeCompare(b.label);
  });
}

/** The plan filter's rows + their health notes — the plan-axis twin of
 *  `deriveFleetRollups`, down to the ordering rule (the group needing the most
 *  attention first, the "no plan" group last). Kept as its own function rather
 *  than a generic groupBy over a key selector: the two differ in their label
 *  and warning rules (a fleet with no leader is broken; a plan with no leader
 *  is normal), and collapsing them would mean a config object per call site to
 *  express three lines of difference. */
export function derivePlanRollups(sessions: HudSession[]): HudPlanRollup[] {
  const groups = new Map<string, HudPlanRollup>();
  for (const s of sessions) {
    const key = s.planSlug ?? NO_PLAN_TOKEN;
    let g = groups.get(key);
    if (!g) {
      g = {
        planSlug: s.planSlug,
        label: s.planSlug ?? 'no plan',
        total: 0,
        byColumn: { 'needs-you': 0, working: 0, blocked: 0, stalled: 0, parked: 0 },
        warning: null,
      };
      groups.set(key, g);
    }
    g.total += 1;
    g.byColumn[s.column] += 1;
  }
  for (const g of groups.values()) {
    const parts: string[] = [];
    if (g.byColumn['needs-you']) parts.push(`${g.byColumn['needs-you']} needs you`);
    if (g.byColumn.blocked) parts.push(`${g.byColumn.blocked} blocked`);
    if (g.byColumn.stalled) parts.push(`${g.byColumn.stalled} stalled`);
    // No "no leader" rule here: a plan does not have a leader, and inventing
    // one would be the chrome-that-lies failure P-009's docblock warns about.
    g.warning = parts.length ? parts.join(', ') : null;
  }
  return [...groups.values()].sort((a, b) => {
    // The unbound group last; otherwise the plan needing the most attention first.
    if ((a.planSlug == null) !== (b.planSlug == null)) return a.planSlug == null ? 1 : -1;
    const aw = a.byColumn['needs-you'] + a.byColumn.blocked + a.byColumn.stalled;
    const bw = b.byColumn['needs-you'] + b.byColumn.blocked + b.byColumn.stalled;
    if (aw !== bw) return bw - aw;
    return a.label.localeCompare(b.label);
  });
}

/** Build the whole board from a roster snapshot + the attention feed. */
export function buildHudBoard(
  roster: HudRosterEntry[],
  asks: HudAsk[],
  options: HudBuildOptions,
): HudBoard {
  const thresholds = options.thresholds ?? HUD_DEFAULT_THRESHOLDS;
  const nowMs = options.nowMs;
  const byOwner = asksByOwner(asks);

  let entries = options.suOnly === false ? roster : roster.filter(isSuSession);
  if (options.fleets && options.fleets.length > 0) {
    const want = new Set(options.fleets);
    entries = entries.filter((e) => want.has(e.fleetSlug));
  }

  const inView = entries.map((e) => toHudSession(e, byOwner.get(e.ownerId), { nowMs, thresholds }));

  /* The plan filter's options are derived HERE — after the fleet filter, before
     the plan filter — and that ordering is the whole of P-004's "driven by the
     fleets currently in view":

       - AFTER `fleets`, so picking a fleet narrows the plan list to the plans
         that fleet is actually on. That is the feature.
       - BEFORE the plan filter, so the picker does not eat its own options. A
         single-select control whose list collapses to the one row already
         selected can only be changed by first clearing it — two steps to do
         one thing. (The fleet strip derives its chips from the post-filter set
         and has exactly that wrinkle; it gets away with it because its "all
         fleets" chip is always visible on screen. A closed combobox has no
         such affordance, so the plan axis does not inherit the wrinkle.) */
  const plans = derivePlanRollups(inView);

  let sessions = inView;
  if (options.plans && options.plans.length > 0) {
    const wantPlans = new Set(options.plans);
    sessions = inView.filter((s) => wantPlans.has(s.planSlug));
  }

  const counts: Record<HudColumnId, number> = {
    'needs-you': 0, working: 0, blocked: 0, stalled: 0, parked: 0,
  };
  for (const s of sessions) counts[s.column] += 1;

  const columns = HUD_COLUMNS.map((id) => ({
    id,
    label: HUD_COLUMN_LABEL[id],
    empty: HUD_COLUMN_EMPTY[id],
    sessions: sessions
      .filter((s) => s.column === id)
      .sort((a, b) => a.sortKey - b.sortKey || a.handle.localeCompare(b.handle)),
  }));

  return {
    columns,
    fleets: deriveFleetRollups(sessions),
    plans,
    counts,
    total: sessions.length,
    unattributed: unattributedAsks(asks),
  };
}

/**
 * WI-6560 — reuse the PREVIOUS board's object references wherever the freshly
 * derived value is structurally identical, so `React.memo` downstream can
 * actually bite.
 *
 * WHY THIS IS NEEDED AT ALL. `buildHudBoard` is pure and allocates a new
 * `HudSession` per agent on every call, and it is re-run whenever ANY of its
 * inputs change — including `nowMs`, which the view bumps every 15s. But the
 * clock only changes what a card *renders* at the granularity `formatAge`
 * prints: seconds under a minute, then MINUTES, then HOURS. So for any session
 * older than a minute, three of every four ticks rebuild an object whose
 * rendered output is byte-identical; for an hour-old session it is 239 of every
 * 240. Same story for roster payloads that arrive unchanged. Without this,
 * `MemoSessionCard`'s shallow compare misses on the `session` prop every time
 * and the entire board re-renders for nothing.
 *
 * This is deliberately NOT solved by quantising `sinceSec` to display
 * granularity: `sinceSec` also feeds `sortKey` and the threshold comparisons,
 * and rounding it would change classification, not just presentation. Comparing
 * the finished value is both safer and strictly more general — it also collapses
 * the *data*-arrival case (an unchanged roster re-fetched), which quantising
 * would not.
 *
 * Equality is STRUCTURAL (`deepEqual`), never a hand-listed field comparison.
 * That is the load-bearing choice: a hand-written comparator silently goes stale
 * the moment someone adds a field to `HudSession`, and the failure mode is a
 * card that renders permanently stale data — far worse than a missed memo. A
 * structural compare cannot rot that way.
 *
 * Reuse is applied bottom-up (session → column → board) so that an unchanged
 * board returns the IDENTICAL object, which lets memos above the board hold too.
 * A session that is unchanged but has MOVED position still forces a new column
 * object, because the column's rendered order genuinely differs.
 *
 * SAFETY NOTE for the caller: this is a pure cache, so it stays correct even if
 * a render is discarded (React may run a memo and throw the result away). The
 * worst case is that `prev` refers to a board that was never committed; the next
 * comparison is still structural, so the output is never stale — at most one
 * extra re-render happens.
 */
export function reconcileBoardIdentity(prev: HudBoard | null, next: HudBoard): HudBoard {
  if (!prev) return next;

  const priorByOwner = new Map<string, HudSession>();
  for (const col of prev.columns) {
    for (const s of col.sessions) priorByOwner.set(s.ownerId, s);
  }

  let anyColumnChanged = false;
  const columns = next.columns.map((col, colIdx) => {
    const prevCol = prev.columns[colIdx];
    let columnChanged =
      !prevCol ||
      prevCol.id !== col.id ||
      prevCol.label !== col.label ||
      prevCol.empty !== col.empty ||
      prevCol.sessions.length !== col.sessions.length;

    const sessions = col.sessions.map((s, i) => {
      const prior = priorByOwner.get(s.ownerId);
      if (prior && deepEqual(prior, s)) {
        // Unchanged content — but a different slot means the column's order
        // changed, so the column object itself must not be reused.
        if (!prevCol || prevCol.sessions[i] !== prior) columnChanged = true;
        return prior;
      }
      columnChanged = true;
      return s;
    });

    if (!columnChanged && prevCol) return prevCol;
    anyColumnChanged = true;
    return { ...col, sessions };
  });

  const fleets = deepEqual(prev.fleets, next.fleets) ? prev.fleets : next.fleets;
  const plans = deepEqual(prev.plans, next.plans) ? prev.plans : next.plans;
  const counts = deepEqual(prev.counts, next.counts) ? prev.counts : next.counts;
  const unattributed = deepEqual(prev.unattributed, next.unattributed)
    ? prev.unattributed
    : next.unattributed;

  if (
    !anyColumnChanged &&
    prev.columns.length === next.columns.length &&
    fleets === prev.fleets &&
    plans === prev.plans &&
    counts === prev.counts &&
    unattributed === prev.unattributed &&
    prev.total === next.total
  ) {
    return prev;
  }

  return { columns, fleets, plans, counts, total: next.total, unattributed };
}
