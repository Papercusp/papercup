/**
 * turn-start-orientation.ts — orientation that ARRIVES instead of being asked for
 * (fleet-deltas-leader-primitives-2026-07-10 item P-004; D-004 ruling 3).
 *
 * THE PROBLEM THIS SOLVES. `coord:orient` is mandated in the MCP `initialize`
 * instructions, restated in the su playbook, and graded by a dedicated LLM assert
 * (`S17-orient-bootstrap`) — three separate mechanisms whose only job is to make an
 * agent CALL something. Measured 2026-08-11 (`harness_shared.tool_invocations`, 7d,
 * `workspace_id='papercusp-workspace'`, grouped by `coord_owner_id` — NOT `spawn_id`,
 * which is per-call on that table): of 378 owners with >=5 tool calls, 240 (64.5%)
 * ever called `coord:orient`, and **119 (31.5%) issued no coordination read of ANY
 * kind** — no orient, no inbox, no catch-up, no feed. Instruction is not delivery.
 *
 * So the READ half of orientation moves onto the rail that already fires every turn
 * (`POST /api/agent-mcp/turn-start-memory`, which already carries the CTRL transition
 * and a server-built memory recall). The WRITE half stays an explicit agent call,
 * because it genuinely needs the agent: `coord:declare-intent(intent)` requires an
 * agent-authored one-line intent, and the lane claim requires knowing which items you
 * are taking. Neither can be synthesized server-side, and inventing a placeholder
 * intent to broadcast to peers would be worse than not declaring one.
 *
 * ── THREE CONSTRAINTS, ALL INHERITED RATHER THAN INVENTED ────────────────────────
 *
 * 1. FAIL-SOFT BY CONTRACT. The host endpoint answers `{ ok: true, text: '' }` on
 *    every failure path — a hook must never surface an error into a turn. Every
 *    function here returns a string (possibly empty) and never throws.
 * 2. THE 2.5s WALL. `userpromptsubmit-memory.sh` holds a hard wall on the whole
 *    turn-start request, so this fold must never be the reason a turn stalls. All
 *    IO runs in ONE `Promise.all` with per-source `.catch()`, and a missing source
 *    degrades that line rather than the block.
 * 3. ITS OWN BUDGET. Turn-start's 4000 chars belong to the MEMORY block, and
 *    injected lines compound in a warm session. This fold gets a separate, much
 *    smaller budget so the two can never cannibalize each other.
 *
 * ── WHY ALL-OR-NOTHING, NOT A PARTIAL DIFF ───────────────────────────────────────
 *
 * The delta is computed against the server-side read cursor (`read-cursors.ts`,
 * surface `orientation`), but when anything has changed the FULL block is emitted,
 * not just the changed lines. That is deliberate and follows the rule
 * `orient-list-delta.ts` already established: partial deltas are safe only for
 * "read-only informational streams where 'nothing new' is a safe, fully-actionable
 * answer", and were deliberately NOT applied to orient's `claimable`/`facts` folds
 * because omitting unchanged content from a SELF-SELECT or BINDING-CONTEXT surface
 * risks an agent acting on stale knowledge. Orientation is binding-context: an agent
 * shown only "unread: 6" with its held items elided would reasonably conclude it
 * holds nothing. So the choice is between the whole block and silence.
 *
 * The economy still holds, because silence is the common case: a turn that changed
 * nothing costs zero characters.
 */

import type { CursorState } from './agent-tools/coordination/read-cursors';
import type { ScoredItem } from './harness/improvements/digest';
import type { Sql } from 'postgres';
import { renderCarryBlindWindowLine, type CarryBlindWindow } from './carry-blind-window';
import { capPreservingOperativeDetailed } from './operative-clause';
import { workItemFetchHint } from './work-item-fetch-hint';
import type { AgentObligationBrief } from './agent-obligation-reader';
import type { OwnerDirectiveRow } from './owner-directives';

/** A held work-item, reduced to what the fold actually prints. */
export interface OrientationHeldItem {
  id: string;
  /** EI-20451119672468393: the item's CANONICAL harness (may differ from the
   *  session's scope); null/absent ⇒ operator-scoped. Qualifies the re-fetch
   *  hint so a cross-harness held item resolves on the first try. */
  harness?: string | null;
  status?: string | null;
  /** In-flight state written through work_items:checkpoint. */
  checkpoint?: string | null;
  /** Write time for the absolute-staleness verdict below. */
  checkpointUpdatedAtMs?: number | null;
  /** True only when the shared turn-end checkpoint rule proves this snapshot old. */
  checkpointStale?: boolean;
}

/** Compact owner-directive context delivered on the deterministic turn-start rail. */
export interface OrientationOwnerDirective {
  id: number;
  captureStatus: 'pending' | 'open';
  verbatimText: string;
}

/**
 * ONE carried claim the reader must FALSIFY before relying on it, or one still-open
 * external blocker — each delivered WITH the probe that settles it (P-010).
 *
 * This is the compaction contract's "[inferred] until re-probed" rule mechanised.
 * That rule already exists in prose, and `loop:checkpoint { checks }` already stores
 * `{ claim, recheck, verified }` rows precisely so a probe travels with its claim —
 * but nothing put the UNVERIFIED ones in front of the agent at the moment it acts.
 * A claim whose probe is delivered gets re-checked; a claim that arrives bare gets
 * INHERITED, and an inherited false claim is indistinguishable from a measured one.
 *
 * Root observation (first-hand, 2026-09-22, and the reason this class exists): a cold
 * wake carried NINE checks, every one PREDICTED, each with a real re-check probe — and
 * the turn-start block surfaced NONE of them. Two were already FALSE at wake time
 * (their subjects had gone terminal). The carry note even renders a `?` legend the
 * turn-start reader never sees.
 */
export interface OrientationOpenCheck {
  /** Stable row identity (`carryRowKey`) where the source carries one, else a
   *  source-qualified ordinal — so the same row keeps one identity across turns. */
  id: string;
  /** What the row asserts. Excerpted for the line; the pointer carries the rest. */
  claim: string;
  /** The probe that SETTLES the row. Absent ⇒ the row is unfalsifiable as stored,
   *  which the line states outright rather than implying a probe exists. */
  recheck?: string;
  /** Where to read/settle the row — the loop carry-note or a specific work-item. */
  pointer: string;
  /** `blocker` rows are open external blockers (`work_items:set_blocker`), not
   *  carried claims: they are already known-open, so they need no falsifying. */
  kind: 'check' | 'blocker';
  /** Supplied evidence CONTRADICTS the claim (the carry-note CONTESTED state).
   *  Strictly worse than merely unverified — a claim with disproof attached — so
   *  it is surfaced ahead of the plain PREDICTED rows. */
  contested?: boolean;
}

/** Post-claim discussion changes that the holder has not necessarily seen yet. */
export interface OrientationHistoryUpdate {
  workItemId: string;
  harness?: string | null;
  count: number;
  newestPostId: number;
}

/** Post-claim revisions on the held work's bounded plan/goal ancestry. */
export interface OrientationEffortUpdate {
  level: 'plan' | 'goal';
  ref: string;
  count: number;
  newestPostId: number;
}

/** Actionable inbox context from the same primitive as fleet:leader-brief. */
export interface OrientationInboxEntry {
  msgId: string;
  from: string;
  summary?: string;
}

/** A declared, still-unfired gate visible in this caller's current scope. */
export interface OrientationAnnouncedGate {
  event: string;
  note?: string | null;
  /** Stable logical gate identity, when the declarer supplied one. */
  logical_gate?: string | null;
  /** Number of live non-announce awaits on this event key, when measured. */
  live_awaiters?: number;
  /** Live successors that can declare a replacement for a stale binding. */
  live_successor_ids?: string[];
  /** True only when the declarer ended and no live successor owns the binding. */
  stale_owner?: boolean;
  /** Actionable warning about a stranded or ambiguous announced gate. */
  warning?: string;
}

/**
 * Plan-item-shaped gate names are dangerous when announced globally: a bare
 * `p006-complete` is easy to mistake for the completion edge of the current
 * plan even when another plan owns it. Keep this detector deliberately narrow
 * so ordinary `phase3-open`/`p2p-ready` event names do not become warnings.
 */
export function isPlanItemLikeGateName(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^p-?\d+(?:[-_:.\/].*)?$/i.test(value.trim());
}

/** Build the shared, concise warning rendered by both orientation surfaces. */
export function buildAnnouncedGateWarning(input: {
  event: string;
  logical_gate?: string | null;
  scope?: string | null;
  announcedBy?: string | null;
  stale_owner?: boolean;
}): string | undefined {
  const warnings: string[] = [];
  if (input.stale_owner) {
    warnings.push(
      `STALE announced gate "${input.event}": declarer ${input.announcedBy ?? 'unknown'} ended and no live successor holds its binding; do not await it.`,
    );
  }
  const global = !input.scope || input.scope === 'global';
  const ambiguousName = [input.event, input.logical_gate].find(isPlanItemLikeGateName);
  if (global && ambiguousName) {
    warnings.push(
      `AMBIGUOUS GLOBAL announced gate "${ambiguousName}": its name resembles a plan-item key; verify the plan/owner before awaiting.`,
    );
  }
  return warnings.length > 0 ? warnings.join(' ') : undefined;
}

/**
 * WI-2142142: the SENDER-side mirror of `unansweredDirected` — directed
 * messages THIS agent sent, expecting a reply, that the recipient has not
 * yet answered. `unansweredDirected` is "what do I still owe?"; this is
 * "what am I still owed?", and the block previously had no line for it at
 * all. `oldestTo` is computed directly by fetchOpenAsks, not derived from a
 * capped list, so it stays correct even when `count` exceeds any display cap.
 */
export interface OrientationOpenAsk {
  count: number;
  oldestAgeMs: number;
  oldestTo: string;
}

/** The one actionable captured-improvement row worth injecting this turn. */
export interface OrientationImprovementTriage {
  /** Untriaged rows in the same bounded window that produced `top`. */
  pending: number;
  /** Improvement rows the bounded read actually considered. */
  considered: number;
  /** True when the read hit its cap, so `pending` is only a lower bound. */
  lowerBound: boolean;
  top: {
    id: string;
    title: string;
    lane: 'human' | 'auto';
  };
}

/** The exact-plan fleet frontier, reduced to the edge this fold can deliver. */
export interface OrientationExecutableFrontier {
  planSlug: string;
  executableWidth: number;
}

/**
 * Reduce the existing triage lanes to the one row worth injecting at turn
 * start. `humanQueue` arrives in the one ranker's order; `selectUntriaged`
 * sorts its argument in place by the legacy triage score, so call it on copies
 * and use only its membership result for that lane. Otherwise merely filtering
 * lifecycle state silently destroys the ranker's order before `top` is chosen.
 */
export function selectOrientationImprovementTriage(
  digest: { humanQueue: ScoredItem[]; autoEligible: ScoredItem[] },
  selectUntriaged: (scored: ScoredItem[], max: number) => ScoredItem[],
  population: { considered: number; lowerBound: boolean },
): OrientationImprovementTriage | null {
  const untriagedHumanIds = new Set(
    selectUntriaged([...digest.humanQueue], digest.humanQueue.length).map((item) => item.id),
  );
  const human = digest.humanQueue.filter((item) => untriagedHumanIds.has(item.id));
  const auto = selectUntriaged([...digest.autoEligible], digest.autoEligible.length);
  const top = human[0] ?? auto[0];
  if (!top) return null;
  return {
    pending: human.length + auto.length,
    considered: population.considered,
    lowerBound: population.lowerBound,
    top: {
      id: top.id,
      title: top.title,
      lane: human[0] ? 'human' : 'auto',
    },
  };
}

/**
 * Everything the fold can say, resolved once per turn.
 *
 * ⚠ `claimable` is deliberately ABSENT in v1. The claimable set has real
 * semantics — `work_items:claimable` exists precisely because a raw
 * `status='open'` query overcounts by ~13x — and a wrong count injected into
 * every turn is worse than no count. Add it by calling that tool's underlying
 * read, never by hand-writing a floor query here.
 */
/**
 * Evidence that this agent's MCP tool surface loaded EMPTY (EI-21308269358666878).
 *
 * A psu session can come up with ZERO papercusp tools and never notice: it keeps
 * heartbeating, presence stays 'live', and it looks healthy to every peer — while
 * being unable to claim, checkpoint, complete, or control its own loop. The tool
 * list is fetched once at MCP connect and never re-listed, so the condition is
 * PERMANENT for that session's life: it cannot self-heal, and retrying inside the
 * session cannot fix it. That is why this warns instead of waiting.
 *
 * The signal is the CALL-ORIGIN SPLIT, not a call count. Hook calls reach the
 * operator over plain HTTP, BYPASSING the agent MCP surface, so they keep flowing
 * while agent-issued calls stop dead. Measured on the confirmed incident
 * (su-b39c3537, sessions cdcdc38c + ed80eafe, 2026-08-24): 355+ hook calls against
 * 0 agent calls, over ~4 hours — a state its own transcript describes as "no
 * papercusp tools registered". That asymmetry also rules out "merely idle": an
 * idle session is not being handed turn-start blocks at all.
 *
 * ⚠ A raw invocation COUNT does not work and was tried first: the sanctioned
 * `scripts/mcp-call.mjs` fallback and the hooks both write rows, so a toolless
 * agent still logs plenty of invocations. Only the split separates them.
 *
 * Present ⇒ toolless. `null` is BOTH "healthy" and "cannot tell", deliberately:
 * every unknown degrades to silence, never to a false alarm on a working agent.
 */
export interface OrientationToolSurface {
  /** Hook-origin calls since the context generation began — proves the operator is reachable. */
  hookCalls: number;
  /** Minutes since the context generation began, so the line can say how long. */
  windowMinutes: number;
}

export interface OrientationState {
  /** Non-terminal work-items assigned to this agent. */
  held: OrientationHeldItem[];
  /** Unresolved explicit directives and hook-captured pending owner turns. */
  ownerDirectives?: OrientationOwnerDirective[];
  /** `undefined` means the read failed and must preserve the prior cursor token. */
  historyUpdates?: OrientationHistoryUpdate[];
  /** `undefined` means unreadable; preserve the previous delivery token. */
  effortUpdates?: OrientationEffortUpdate[];
  /**
   * Carried claims still UNVERIFIED, and still-open external blockers, each with
   * its settling probe. `undefined` means the read failed and must preserve the
   * prior cursor token — measured-empty ("nothing to re-check") and unreadable
   * ("I could not tell") must not collapse, because only the first is a verdict.
   */
  openChecks?: OrientationOpenCheck[];
  /** Directed messages awaiting THIS agent's reply, from a sender who is not
   *  positively dead — the population that genuinely outranks your own work. */
  unansweredDirected: number;
  /**
   * EI-20085805220385722: still-unanswered asks whose SENDER has ended. Split
   * OUT of `unansweredDirected` (nobody is blocked behind them, so they must
   * not preempt) but still REPORTED, because a silently vanished obligation is
   * the worse failure — this file's own `unanswered` primitive was reshaped
   * once already after a false ZERO lost a real commitment.
   */
  unansweredStale: number;
  /** Newest actionable inbox headlines; count remains `unansweredDirected`. */
  inboxRecent: OrientationInboxEntry[];
  /** Directed messages THIS agent sent that await a PEER's reply; null means
   *  none or unreadable. See {@link OrientationOpenAsk}. */
  openAsks: OrientationOpenAsk | null;
  /** Declared-but-unfired gates visible to the caller's fleet/plan/harness. */
  announcedGates: OrientationAnnouncedGate[];
  /** Whether an engine loop is armed — i.e. whether a wake source exists. */
  loopArmed: boolean;
  /** Whether the armed loop's most recent fire was withheld before delivery. */
  loopFireWithheld: boolean;
  /** Ranked, still-untriaged improvement signal; null means none or unreadable. */
  improvementTriage: OrientationImprovementTriage | null;
  /** Canonical P-011 executable width; null means inapplicable or unreadable. */
  executableFrontier: OrientationExecutableFrontier | null;
  /**
   * Shared policy agenda. `null` means measured with no actionable entries;
   * `undefined` means the optional read was unavailable and preserves the last
   * cursor token instead of manufacturing a cleared obligation.
   */
  obligations?: AgentObligationBrief | null;
  /**
   * KEYS of the never-drop standing facts (`dead-end:` / `wall:` / `guard-rail:`).
   *
   * These exist to OVERRIDE a stale plan, which is the whole reason they are
   * folded into a block this small. EI-18725816532600240 established exactly
   * this rule for coord:orient's monitor tick, after a cold wake was told to
   * implement an approach a `dead-end:` fact had ALREADY falsified — "the
   * antidote was absent precisely where the poison was strongest". This fold
   * fires even more often than that one and did not inherit the lesson
   * (EI-21309540201944554).
   *
   * KEYS ONLY. The bodies are what make the full fold expensive, and a key is
   * enough to answer the only question this line needs to answer: "is there a
   * settled do-not-repeat about the thing I am about to do?"
   */
  neverDropFacts: string[];
  /**
   * Set when this agent's MCP tool surface is observably EMPTY; null when it is
   * healthy OR unreadable. See OrientationToolSurface for why unknown ⇒ null.
   */
  toolSurface: OrientationToolSurface | null;
  /**
   * EI-21442716425230784: what the carry document could NOT have seen — the work
   * the predecessor did between the carry snapshot and the cut. Present only on a
   * fresh successor whose window was measured and NON-EMPTY; null otherwise,
   * which covers "no recent cut", "the window was empty", and "unreadable"
   * alike, because none of those is something to spend a line on.
   *
   * This is the first-turn line a just-respawned agent most needs and can least
   * derive: the carry doc warns that a blind window exists but carries no signal
   * about THIS one, so a successor cannot tell an empty window from one holding
   * the single most owner-salient act of the session.
   */
  carryBlindWindow: CarryBlindWindow | null;
}

/**
 * Default budget for the compact turn-start delta.
 *
 * This block is cursor-deduplicated, so the full budget is spent only when an
 * orientation signal changes (or a new context epoch starts), not on every
 * prompt. 1,000 characters leaves room for the recovery/action lines that
 * routinely fell beyond the old 600-character ceiling while remaining a small
 * fraction of the turn-start memory budget.
 */
export const ORIENTATION_BUDGET_CHARS = 1_000;

export const ORIENTATION_CURSOR_SURFACE = 'orientation';

/**
 * DELIBERATELY TERSE. This is paid on every turn that changes anything, and it
 * competes with the CONTENT for the budget. An earlier 62-char heading
 * ("Your orientation (delivered — you did not have to ask for it)") consumed
 * enough of a tight budget that the highest-priority line no longer fit and the
 * fold emitted NOTHING — going silent in exactly the case it exists for. Caught
 * by the budget test; keep this short.
 */
const HEADING = 'Orientation';

/** Held items printed in full before collapsing to a count — keeps the line
 *  useful under pressure instead of dropping it wholesale. */
const HELD_DISPLAY_CAP = 5;
const CHECKPOINT_DISPLAY_CAP = 2;
const CHECKPOINT_EXCERPT_CHARS = 150;
const GATE_DISPLAY_CAP = 3;
const INBOX_DISPLAY_CAP = 2;
/** Two keys is enough to say "a do-not-repeat exists here"; the count carries the
 *  rest. Kept small because composeOrientationBlock BREAKS on the first line that
 *  does not fit, so an overlong line here silently truncates every line below it. */
const FACT_DISPLAY_CAP = 2;
const FACT_KEY_CHARS = 38;
const IMPROVEMENT_TRIAGE_WINDOW_LIMIT = 100;
/**
 * Hook-origin calls required before the toolless warning fires (EI-21308269358666878).
 *
 * MEASURED, not guessed. Among active agent owners with ZERO agent-origin calls since
 * their context epoch, the hook-call distribution has a hard cliff — 355, 96, then 12,
 * 8, 8, 5, 4, 3, 2… — so every threshold in 20..90 selects the same set, and 20 keeps
 * margin above the low-activity noise floor while still firing within a few turns of
 * onset. Live 6h sample: 1 flagged of 243 active agent owners (0.41%).
 */
export const TOOLLESS_HOOK_THRESHOLD = 20;

/** One owner whose call-origin split proves its Papercusp MCP surface loaded
 * empty. Kept beside OrientationToolSurface so every consumer uses the same
 * units, epoch anchor, threshold, and deliberately-unscoped invocation query. */
export interface OrientationToolSurfaceOwner extends OrientationToolSurface {
  ownerId: string;
}

/**
 * Read the call-origin split for one or many owners in one bounded SQL shape.
 *
 * This is the shared source of truth for both the turn-start warning and the
 * mcp-dark watchdog's recovery consumer. Keeping the query here prevents the
 * two from drifting on the three load-bearing constraints above: anchor on the
 * current context epoch, require zero agent-origin calls, and NEVER filter by
 * harness/workspace (workspace-global tools legitimately record `*`).
 */
export async function readOrientationToolSurfaces(
  sql: Sql,
  ownerIds: string[],
): Promise<OrientationToolSurfaceOwner[]> {
  if (ownerIds.length === 0) return [];
  const rows = await sql<Array<{ owner_id: string; hook_calls: string | number; window_minutes: string | number }>>`
    WITH anchors AS (
      SELECT session_id AS owner_id, bumped_at
        FROM harness_shared.memory_session_epochs
       WHERE session_id = ANY(${ownerIds})
    ), silent AS (
      SELECT a.owner_id, a.bumped_at
        FROM anchors a
       WHERE NOT EXISTS (
               SELECT 1
                 FROM harness_shared.tool_invocations t
                WHERE t.coord_owner_id = a.owner_id
                  AND t.invoked_at >= a.bumped_at
                  AND t.call_origin = 'agent'
             )
    )
    SELECT s.owner_id,
           count(*) FILTER (WHERE t.call_origin = 'hook') AS hook_calls,
           floor(extract(epoch FROM (now() - s.bumped_at)) / 60)::int AS window_minutes
      FROM silent s
      LEFT JOIN harness_shared.tool_invocations t
        ON t.coord_owner_id = s.owner_id
       AND t.invoked_at >= s.bumped_at
     GROUP BY s.owner_id, s.bumped_at
  `;
  return rows.flatMap((row) => {
    const hookCalls = Number(row.hook_calls);
    if (!Number.isFinite(hookCalls) || hookCalls < TOOLLESS_HOOK_THRESHOLD) return [];
    const windowMinutes = Number(row.window_minutes);
    return [
      {
        ownerId: row.owner_id,
        hookCalls,
        windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : 0,
      },
    ];
  });
}

/**
 * P-002: is any delivered obligation still UNDISCHARGED?
 *
 * A class-B row is discharged by DISPOSITION, not by DELIVERY. `agenda.primary`
 * is already exactly the actionable set — `evaluateAgentObligations` filters it
 * with `agentObligationIsActionable`, and each entry carries its own
 * `clearsWhen` predicate naming the effect that ends it. So the discharge
 * question is answered by the canonical agenda, never re-derived here.
 *
 * Reading `primary` rather than `projection.entries` is deliberate: a row the
 * outer budget OMITTED is still undischarged, and the "+N omitted — <detailRef>"
 * pointer must keep rendering while it is.
 */
export function hasUndischargedObligations(state: OrientationState): boolean {
  return (state.obligations?.primary.length ?? 0) > 0;
}

/**
 * The reduced state used when every class is unchanged but an obligation is
 * still undischarged: obligations ONLY.
 *
 * Re-emitting the WHOLE block each turn for one standing row would repeat held
 * items, gates and facts that genuinely have not changed — manufacturing the
 * exact signal decay D-003 withdrew the improvement-triage line for. The item
 * says an obligation ROW renders every turn, not the block, so this keeps the
 * re-injection as narrow as the contract requires.
 *
 * `loopArmed: true` is the QUIET value, not an assertion about the loop: the
 * renderer warns on a loop that is NOT armed, so `false` here would fabricate a
 * "not armed" line on a healthy session every time a directive went unsettled.
 */
function undischargedObligationsOnly(state: OrientationState): OrientationState {
  return {
    held: [],
    unansweredDirected: 0,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    loopArmed: true,
    loopFireWithheld: false,
    improvementTriage: null,
    executableFrontier: null,
    neverDropFacts: [],
    toolSurface: null,
    carryBlindWindow: null,
    obligations: state.obligations,
  };
}

/** True when there is genuinely nothing worth spending a single character on. */
export function isEmptyOrientation(state: OrientationState): boolean {
  return (
    state.held.length === 0 &&
    (!state.ownerDirectives || state.ownerDirectives.length === 0) &&
    (!state.historyUpdates || state.historyUpdates.length === 0) &&
    (!state.effortUpdates || state.effortUpdates.length === 0) &&
    (!state.openChecks || state.openChecks.length === 0) &&
    state.unansweredDirected === 0 &&
    state.unansweredStale === 0 &&
    state.openAsks === null &&
    state.inboxRecent.length === 0 &&
    state.announcedGates.length === 0 &&
    !state.loopArmed &&
    !state.loopFireWithheld &&
    // improvementTriage is NOT a conjunct here (P-017): it no longer renders,
    // so letting it hold the block open would emit a block whose only reason
    // for existing is invisible to the reader.
    state.executableFrontier === null &&
    !state.obligations &&
    state.neverDropFacts.length === 0 &&
    state.toolSurface === null &&
    state.carryBlindWindow === null
  );
}

/**
 * The durable loop-status discriminator for a fire that never reached the wake
 * ladder. A withhold deliberately leaves `lastFiredAt` alone, so the signal is
 * current only when its timestamp is at or after the latest fire. Invalid or
 * incomplete status is fail-open: orientation must not call an armed loop dead
 * merely because observability is unavailable.
 */
export function isLoopFireWithheld(
  status:
    | {
        active: boolean;
        lastFiredAt?: string | null;
        lastWithheldAt?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!status?.active || !status.lastFiredAt || !status.lastWithheldAt) return false;
  const lastFiredMs = Date.parse(status.lastFiredAt);
  const lastWithheldMs = Date.parse(status.lastWithheldAt);
  return Number.isFinite(lastFiredMs) && Number.isFinite(lastWithheldMs) && lastWithheldMs >= lastFiredMs;
}

/**
 * PURE: the compact fingerprint this turn's orientation is diffed against.
 *
 * The held-item key is `id:status`, so this fingerprint CAN re-emit on a
 * wip→blocked move — but ⚠ v1 DOES NOT: `defaultOrientationDeps.held` populates
 * `{ id }` only (see the note at its definition — `CarryBriefHeldItem` has no
 * `status` field), so in v1 every status collapses to `''` and only a CLAIM or
 * RELEASE re-emits. The `:status` half is the seam a status-carrying source
 * drops into, not a description of current behaviour — do not cite it as one.
 *
 * ── WHY `epoch` IS PART OF THE KEY (P-023 / D-008) ───────────────────────────
 *
 * The cursor this fingerprint is stored under is keyed `(workspace_id, owner_id,
 * surface)` — the OWNER. But what the fold actually dedups against is the
 * agent's CONTEXT: the block is suppressed because "you were already told", and
 * that is only true while the context it was told into still exists. Wherever
 * those two diverge — the owner id survives but the context does not — the fold
 * went silent for a successor that knew nothing, which is precisely the boundary
 * it exists to serve.
 *
 * That divergence is not hypothetical and not rare. A carry-respawn and a cold
 * loop wake both preserve the owner id and discard the context, and both are the
 * cases where orientation state is MOST likely to be byte-identical to the
 * predecessor's last turn (nothing changed — the process merely restarted). So
 * the suppression was ANTI-CORRELATED with need: the more cleanly the boundary
 * preserved state, the more certain the successor was told nothing.
 *
 * `epoch` is `memory_session_epochs.epoch` — the context generation the memory
 * surfaced-ledger already dedups on for exactly this reason (D-002/D-006). Both
 * folds ride the same rail; keying them the same way is what stops them
 * disagreeing about what a boundary means.
 *
 * A committed value written before this key existed has no `epoch` field, so it
 * compares unequal and re-emits once. That is the intended migration: fail-open,
 * one extra block, never a silent stale suppression.
 *
 * Keep this small — it is stored per agent per turn, and its only job is to
 * answer "same as last time, in the same context?".
 */
function encodeExecutableFrontier(frontier: OrientationExecutableFrontier): string {
  return JSON.stringify([frontier.planSlug, frontier.executableWidth]);
}

function encodeAnnouncedGate(gate: OrientationAnnouncedGate): string {
  return JSON.stringify([
    gate.event,
    gate.note ?? null,
    gate.logical_gate ?? null,
    gate.live_awaiters === undefined ? null : gate.live_awaiters,
    gate.live_successor_ids === undefined ? null : [...gate.live_successor_ids].sort(),
    gate.stale_owner === undefined ? null : gate.stale_owner,
    gate.warning ?? null,
  ]);
}

function decodeExecutableFrontier(value: unknown): OrientationExecutableFrontier | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [planSlug, executableWidth] = parsed;
    if (
      typeof planSlug !== 'string' ||
      !planSlug ||
      !Number.isSafeInteger(executableWidth) ||
      (executableWidth as number) < 0
    ) {
      return null;
    }
    return { planSlug, executableWidth: executableWidth as number };
  } catch {
    return null;
  }
}

export function fingerprintOrientation(
  state: OrientationState,
  epoch: number,
  committed: CursorState | null = null,
): CursorState {
  return {
    held: state.held
      .map(
        (h) =>
          `${h.id}:${h.status ?? ''}:${h.checkpoint ? 1 : 0}:` +
          `${h.checkpointUpdatedAtMs ?? ''}:${h.checkpointStale ? 1 : 0}`,
      )
      .sort()
      .join(','),
    ownerDirectives: (state.ownerDirectives ?? [])
      .map((d) => `${d.id}:${d.captureStatus}:${d.verbatimText}`)
      .join('|'),
    historyUpdates:
      state.historyUpdates === undefined
        ? typeof committed?.historyUpdates === 'string'
          ? committed.historyUpdates
          : ''
        : state.historyUpdates
            .map((u) => `${u.workItemId}:${u.count}:${u.newestPostId}`)
            .sort()
            .join(','),
    effortUpdates:
      state.effortUpdates === undefined
        ? typeof committed?.effortUpdates === 'string'
          ? committed.effortUpdates
          : ''
        : state.effortUpdates
            .map((u) => `${u.level}:${u.ref}:${u.count}:${u.newestPostId}`)
            .sort()
            .join(','),
    // Same UNKNOWN-preserving rule as the two above. The token deliberately keys on
    // `contested` as well as identity: a row flipping PREDICTED → CONTESTED is the
    // single most action-worthy transition this class has (evidence arrived that
    // DISPROVES a claim the agent may already be acting on), and a token keyed on
    // identity alone would suppress it as "the same row, still open".
    // It does NOT key on the claim text: re-wording a row is not new information,
    // and `carryRowKey` exists precisely so identity survives a rewrite (P-013).
    openChecks:
      state.openChecks === undefined
        ? typeof committed?.openChecks === 'string'
          ? committed.openChecks
          : ''
        : state.openChecks
            .map((c) => `${c.kind}:${c.id}:${c.contested ? 1 : 0}`)
            .sort()
            .join(','),
    unanswered: state.unansweredDirected,
    // EI-20085805220385722: its own token, not folded into `unanswered` — the
    // two move independently (a sender DYING demotes an ask from one to the
    // other with the total unchanged, and that transition is exactly what the
    // reader needs re-emitted).
    unansweredStale: state.unansweredStale,
    // COUNT ONLY, mirroring `unanswered` above (not identity, not age): a
    // fingerprint keyed on oldestAgeMs would re-emit every turn purely
    // because time passed, defeating the whole point of the diff.
    openAsks: state.openAsks ? state.openAsks.count : 0,
    inbox: state.inboxRecent.map((entry) => `${entry.msgId}:${entry.from}:${entry.summary ?? ''}`).join('|'),
    gates: state.announcedGates
      .map(encodeAnnouncedGate)
      .sort()
      .join('|'),
    loop: state.loopArmed ? 1 : 0,
    loopWithheld: state.loopFireWithheld ? 1 : 0,
    // `triage` is deliberately ABSENT from the watermark (P-017). It stopped
    // rendering, and a component for an unrendered class would re-mark the
    // block as changed for a signal the reader can no longer see — a re-emit
    // with no visible cause, which is worse than the row it replaced.
    // UNKNOWN preserves the last known frontier token. A transient read failure
    // must not erase the cursor and make the same stable width look like a new
    // edge on the next successful turn.
    frontier: state.executableFrontier
      ? encodeExecutableFrontier(state.executableFrontier)
      : typeof committed?.frontier === 'string'
        ? committed.frontier
        : '',
    obligations:
      state.obligations === undefined
        ? typeof committed?.obligations === 'string'
          ? committed.obligations
          : ''
        : (state.obligations?.sourceGeneration ?? ''),
    // A NEWLY asserted guard-rail / dead-end / wall MUST re-emit the block. It is
    // most valuable on the very turn it first applies, and a fingerprint blind to
    // it would suppress the fold for an agent already mid-mistake — the same
    // "absent where it is needed most" failure EI-18725816532600240 describes.
    facts: state.neverDropFacts.slice().sort().join('|'),
    // MUST VARY WHILE THE CONDITION PERSISTS. `hookCalls` strictly increases on
    // every turn a toolless agent takes — the hooks are precisely what keep firing
    // — so this token changes each turn and the warning RE-EMITS. A constant token
    // (a bare boolean, say) would make the single most important line in this block
    // a ONE-SHOT: shown once, then suppressed as "unchanged" for the rest of a
    // session that cannot act. That is the `facts` trap noted below, in the one
    // case where the agent has no way to recover the information for itself.
    toolSurface: state.toolSurface ? `${state.toolSurface.hookCalls}` : '',
    // A one-shot BY CONSTRUCTION, not by suppression: both endpoints and the
    // count are bounded at the CUT, so the token is frozen the moment the
    // successor boots and the line renders exactly once per respawn. (An
    // unbounded count would keep growing with the successor's own calls and
    // re-emit a different line every turn — the noise this token's stability
    // buys us.) The epoch bump at the boundary guarantees the first emission.
    carryBlind: state.carryBlindWindow ? `${state.carryBlindWindow.cutAtMs}:${state.carryBlindWindow.callsAfter}` : '',
    epoch,
  };
}

/** PURE: is `committed` the same orientation this fingerprint describes? */
export function orientationUnchanged(committed: CursorState | null, next: CursorState): boolean {
  if (!committed || typeof committed !== 'object') return false;
  const a = committed as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  return (
    a.held === b.held &&
    a.ownerDirectives === b.ownerDirectives &&
    (a.historyUpdates ?? '') === (b.historyUpdates ?? '') &&
    (a.effortUpdates ?? '') === (b.effortUpdates ?? '') &&
    // REQUIRED, and the easiest line in this file to omit: writing the `openChecks`
    // token in fingerprintOrientation does NOTHING unless it is compared here. Drop
    // this and the class degrades to a one-shot with no visible symptom — a newly
    // CONTESTED claim is silently suppressed as "unchanged", which is precisely the
    // inherit-instead-of-falsify failure the class exists to prevent.
    (a.openChecks ?? '') === (b.openChecks ?? '') &&
    a.unanswered === b.unanswered &&
    // REQUIRED, same rule as `unanswered` beside it: writing the token in
    // fingerprintOrientation does nothing unless it is compared here.
    (a.unansweredStale ?? 0) === (b.unansweredStale ?? 0) &&
    (a.openAsks ?? 0) === (b.openAsks ?? 0) &&
    a.inbox === b.inbox &&
    a.gates === b.gates &&
    a.loop === b.loop &&
    a.loopWithheld === b.loopWithheld &&
    (a.obligations ?? '') === (b.obligations ?? '') &&
    // REQUIRED, and easy to omit: fingerprintOrientation writing a `facts` token
    // does nothing on its own — this whitelist is what decides re-emission. Without
    // the comparison a newly-landed guard rail is suppressed as "unchanged",
    // which is the silent half of the bug this fold exists to fix.
    a.facts === b.facts &&
    // REQUIRED for the same reason `facts` is: writing the fingerprint token above
    // does NOTHING unless it is compared HERE. Omitting this line reinstates the
    // one-shot warning with no visible symptom — the block simply goes quiet.
    a.toolSurface === b.toolSurface &&
    // Same rule again (EI-21442716425230784): the token is inert unless compared
    // here. It also matters in the OTHER direction — a measured blind window
    // arriving on a turn whose every other token is unchanged (the common shape:
    // a successor's first turn holding the same items its predecessor did) must
    // still re-emit the block, or the one warning that cannot be re-derived is
    // the one that is suppressed.
    (a.carryBlind ?? '') === (b.carryBlind ?? '') &&
    a.triage === b.triage &&
    (a.frontier ?? '') === (b.frontier ?? '') &&
    a.epoch === b.epoch
  );
}

function renderExecutableFrontierLine(
  frontier: OrientationExecutableFrontier | null,
  committed: CursorState | null,
): string | null {
  if (!frontier) return null;
  const previous = decodeExecutableFrontier(committed?.frontier);
  if (previous?.planSlug === frontier.planSlug && previous.executableWidth === frontier.executableWidth) {
    return null;
  }
  if (!previous) return `- frontier: ${frontier.executableWidth} executable (${frontier.planSlug}).`;
  if (previous.planSlug === frontier.planSlug) {
    return `- frontier: ${previous.executableWidth} -> ${frontier.executableWidth} executable (${frontier.planSlug}).`;
  }
  return (
    `- frontier: ${previous.planSlug}@${previous.executableWidth} -> ` +
    `${frontier.planSlug}@${frontier.executableWidth} executable.`
  );
}

function compactIds(ids: string[], cap: number): string {
  const shown = ids.slice(0, cap);
  const rest = ids.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

function compactActor(actor: string): string {
  return actor.length <= 18 ? actor : `${actor.slice(0, 15)}…`;
}

/** Terse age for a budget-constrained line — "38m" / "17h", never a full
 *  duration formatter. Deliberately not shared with the fuller `humanAge`
 *  helpers elsewhere (carry-respawn-outcome.ts, release-deploy-staleness-
 *  watchdog.ts): both already duplicate the same tiny shape locally, and a
 *  cross-module import here would cost more than the six lines it saves. */
function compactAgeHours(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '?';
  const minutes = ageMs / 60_000;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Truncate the SLUG, never the type prefix (`guard-rail:` / `wall:` / `dead-end:`):
 *  the prefix is the half that says how much authority the fact carries, so a key
 *  clipped down to a bare "guard-r…" would cost the reader the only part that is
 *  legible at a glance. */
function compactFactKey(key: string): string {
  return key.length <= FACT_KEY_CHARS ? key : `${key.slice(0, FACT_KEY_CHARS - 1)}…`;
}

function compactHeadline(summary: string | undefined): string {
  const text = (summary ?? '(no summary)').replace(/\s+/g, ' ').trim();
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`;
}

function renderCheckpointLine(item: OrientationHeldItem): string | null {
  const raw = item.checkpoint?.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const excerpt = capPreservingOperativeDetailed(raw, CHECKPOINT_EXCERPT_CHARS, {
    inlineNotice: true,
    more: workItemFetchHint(item.id, item.harness),
    maxChars: 40,
    maxClauses: 1,
  }).text;
  return `- checkpoint ${item.id}: ${excerpt}`;
}

/**
 * A prompt surface that renders orientation state categories.
 *
 * D-015 (plan turn-start-memory-two-class-2026-09-21) ruled that the three
 * briefs must NOT merge their payloads — they answer different questions with
 * different watermark semantics. What they share is the DECLARATION of what
 * each category IS; each surface then SELECTS from that shared declaration at
 * its own budget. Turn-start keeps its cursor/watermark semantics via
 * `watermarkTokens`; leader-brief is read-on-demand and uses none.
 *
 * REGISTERED CONSUMERS TODAY: `turn-start` (every class) and `leader-brief`
 * (`neverDropFacts` only, via P-025's `readLeaderNeverDropFacts`). `carry-brief`
 * is still named but claimed by no entry — registering it is P-029's lane.
 *
 * The rule that governs adding one has NOT changed: an `applicableSinks` naming
 * a surface which does not consume the registry would be a false declaration,
 * and the whole point of this table is that a category is declared once,
 * truthfully. Declaration and consumption land in the SAME change.
 *
 * ⚠ CONSUMPTION IS NOT ALWAYS A LINE (D-053). Turn-start is a text block and
 * consumes `segments[].render`. The leader brief is a STRUCTURED, field-capped
 * payload and consumes a class through `id` (typed `keyof OrientationState`),
 * emitting its own field — pushing a rendered line into that JSON would be the
 * "second copy of the line" this table exists to prevent. Both are truthful;
 * reading `applicableSinks` as "renders it as a line" would have made the
 * leader-brief and carry-brief sinks permanently unimplementable.
 */
export type OrientationSink = 'turn-start' | 'leader-brief' | 'carry-brief';

/**
 * One ordered emission of a class.
 *
 * ⚠ A CLASS MAY OWN SEVERAL SEGMENTS, AND THAT IS THE WHOLE REASON THIS TYPE
 * EXISTS. `renderOrientationLines` is NOT one block per category: `held`
 * emits at FOUR distinct priorities (stale checkpoints, missing checkpoints,
 * the holding line, checkpoint excerpts) and `loopArmed` at TWO (the not-armed
 * WARNING near the top, the reassuring ARMED line last), interleaved with
 * other categories. A registry keyed one-entry-per-category therefore CANNOT
 * reproduce the emitted order — and it would scramble it SILENTLY, because
 * the class-coverage guard asserts that each class reaches a rendered line, not
 * WHERE it lands. `order` is the thing that keeps the priority rule below
 * intact; it is asserted unique and order-preserving by the registry tests.
 */
export interface OrientationClassSegment<T> {
  /** Ascending emission order. Spaced by 10 so a segment can be inserted between two. */
  readonly order: number;
  /** PURE: the lines this segment contributes; `[]` when it has nothing to say. */
  readonly render: (value: T, state: OrientationState, committed: CursorState | null) => string[];
}

/**
 * The shared, sink-parameterized declaration of ONE orientation state category:
 * its data source (`populate`), its rendering (`segments`), its watermark token
 * and the prompt surfaces it applies to.
 */
export interface OrientationClassEntry<T> {
  /** The `OrientationState` field this class is declared by. Exactly one entry per field. */
  readonly id: keyof OrientationState;
  /**
   * The `CursorState` keys this class contributes to, as produced by
   * {@link fingerprintOrientation}. Empty means DELIBERATELY unwatermarked —
   * see `improvementTriage`, whose token was withdrawn with its line (P-017).
   * Plural because a class can own more than one token (`loopArmed` owns both
   * `loop` and, through its ARMED variant, nothing else — while
   * `loopFireWithheld` owns `loopWithheld`); a singular field would have to
   * lie for at least one entry, and these are pinned against the real
   * fingerprint keys by test.
   */
  readonly watermarkTokens: readonly string[];
  /** The surfaces that render this class FROM THIS DECLARATION. */
  readonly applicableSinks: readonly OrientationSink[];
  /** DATA SOURCE: select this class's slice out of the orientation state. */
  readonly populate: (state: OrientationState) => T;
  /** RENDERING: ordered segments; see {@link OrientationClassSegment}. */
  readonly segments: readonly OrientationClassSegment<T>[];
  /**
   * Set when the class is declared but deliberately renders NOTHING, carrying
   * the reason. A dropped class is a decision, not a coverage gap.
   */
  readonly unrenderedReason?: string;
}

/** A registry row with its `populate` type erased and bound into its segments. */
export interface RegisteredOrientationClass {
  readonly id: keyof OrientationState;
  readonly watermarkTokens: readonly string[];
  readonly applicableSinks: readonly OrientationSink[];
  readonly unrenderedReason?: string;
  readonly segments: readonly {
    readonly order: number;
    readonly render: (state: OrientationState, committed: CursorState | null) => string[];
  }[];
}

/**
 * Bind one authored entry into the registry, erasing `T` by composing
 * `populate` into each segment's `render`. Authoring stays fully typed per
 * class; the table itself stays a flat, iterable list.
 */
function orientationClass<T>(entry: OrientationClassEntry<T>): RegisteredOrientationClass {
  return {
    id: entry.id,
    watermarkTokens: entry.watermarkTokens,
    applicableSinks: entry.applicableSinks,
    ...(entry.unrenderedReason === undefined ? {} : { unrenderedReason: entry.unrenderedReason }),
    segments: entry.segments.map((segment) => ({
      order: segment.order,
      render: (state: OrientationState, committed: CursorState | null) =>
        segment.render(entry.populate(state), state, committed),
    })),
  };
}

const TURN_START: readonly OrientationSink[] = ['turn-start'];

/**
 * P-025: classes the LEADER BRIEF also renders from this declaration.
 *
 * ⚠ The leader brief is a STRUCTURED, field-capped payload, not a text block, so
 * it consumes a class through `RegisteredOrientationClass.id` (typed
 * `keyof OrientationState`) rather than through `segments[].render` — pushing a
 * rendered line into that JSON would be the "second copy of the line" this
 * registry exists to prevent. Plan decision D-053 rules that both are truthful
 * consumption of the shared declaration; `applicableSinks` means "renders this
 * class FROM THIS DECLARATION", not "renders it as a line".
 *
 * Consumer: `readLeaderNeverDropFacts` in `agent-tools/fleet/leader-brief.ts`,
 * which reads this very table for applicability — so withdrawing a sink here
 * turns the field off with no second edit.
 */
const TURN_START_AND_LEADER_BRIEF: readonly OrientationSink[] = ['turn-start', 'leader-brief'];

/**
 * THE SHARED CLASS REGISTRY (P-023; mechanism per D-015).
 *
 * Every orientation state category is declared here exactly once, and every
 * applicable surface renders it from this declaration. Adding a category to a
 * surface is a change to `applicableSinks`, not a second copy of the line.
 *
 * The `order` values encode the playbook's own priority rule, highest-priority
 * first so budget truncation drops the least important thing rather than an
 * arbitrary tail: a directed message awaiting your answer outranks your own
 * work, so it leads; the no-wake-source warning is next because an agent that
 * cannot be re-woken silently halts, which is the most expensive failure on
 * this list.
 */
export const ORIENTATION_CLASS_REGISTRY: readonly RegisteredOrientationClass[] = [
  orientationClass<OrientationToolSurface | null>({
    id: 'toolSurface',
    watermarkTokens: ['toolSurface'],
    applicableSinks: TURN_START,
    populate: (state) => state.toolSurface,
    segments: [
      {
        // FIRST, above even the directed-message line. An agent whose tool surface is
        // empty cannot act on ANY line below this one — it cannot claim, checkpoint, or
        // even answer the directed message that otherwise leads. Deliberately terse: the
        // composer BREAKS on the first line that does not fit, so length spent here is
        // taken from every line after it.
        order: 10,
        render: (toolSurface) =>
          toolSurface
            ? [
                `- 🚨 MCP TOOLS NOT REGISTERED — 0 tool calls in ${toolSurface.windowMinutes}m vs ` +
                  `${toolSurface.hookCalls} harness beats OK. Tool list loaded EMPTY; it cannot ` +
                  `self-heal. RESTART THE SESSION (EI-21308269358666878).`,
              ]
            : [],
      },
    ],
  }),

  orientationClass<OrientationOwnerDirective[]>({
    id: 'ownerDirectives',
    watermarkTokens: ['ownerDirectives'],
    applicableSinks: TURN_START,
    populate: (state) => state.ownerDirectives ?? [],
    segments: [
      {
        order: 20,
        render: (directives) => {
          if (directives.length === 0) return [];
          const lines: string[] = [];
          for (const directive of directives.slice(0, 2)) {
            const text = directive.verbatimText.replace(/\s+/g, ' ').trim();
            const excerpt = text.length > 110 ? `${text.slice(0, 109)}…` : text;
            lines.push(
              `- 📌 owner directive #${directive.id} [${directive.captureStatus}] ${JSON.stringify(excerpt)} — ` +
                (directive.captureStatus === 'pending' ? 'orders:resolve-pending first.' : 'carry/disposition when done.'),
            );
          }
          if (directives.length > 2) lines.push(`- 📌 +${directives.length - 2} more owner directives — orders:list { open: true }.`);
          return lines;
        },
      },
    ],
  }),

  orientationClass<CarryBlindWindow | null>({
    id: 'carryBlindWindow',
    watermarkTokens: ['carryBlind'],
    applicableSinks: TURN_START,
    populate: (state) => state.carryBlindWindow,
    segments: [
      {
        // Second, and above the directed-message line for one reason: it is the only
        // line here that DECAYS. Every other line describes state the agent can re-read
        // at any point in the session; this one describes turns that exist solely in a
        // dead predecessor's transcript, and an owner-salient deliverable stranded there
        // (EI-21442716425230784: an OAuth consent URL the owner was told to act on) is
        // discovered late or never. It renders once per respawn, so the cost is bounded.
        order: 30,
        render: (carryBlindWindow) => (carryBlindWindow ? [renderCarryBlindWindowLine(carryBlindWindow)] : []),
      },
    ],
  }),

  orientationClass<OrientationOpenCheck[] | undefined>({
    id: 'openChecks',
    watermarkTokens: ['openChecks'],
    applicableSinks: TURN_START,
    populate: (state) => state.openChecks,
    segments: [
      {
        // Directly after `carryBlindWindow` (30) and ahead of the post-claim update
        // lines, because it shares that class's decay property and worsens it. A
        // blind-window line describes turns the agent cannot read; THIS describes
        // conclusions it CAN read and will act on while they are wrong. The damage
        // from an inherited false claim lands on the agent's first action of the
        // turn, which is upstream of everything the lines below prompt it to do.
        order: 35,
        render: (openChecks) => {
          if (!openChecks || openChecks.length === 0) return [];
          // CONTESTED first (disproof already attached), then the remaining
          // unverified claims, then blockers — worst-first, so budget truncation
          // drops the least actionable tail rather than an arbitrary one.
          const rank = (row: OrientationOpenCheck): number =>
            row.contested ? 0 : row.kind === 'check' ? 1 : 2;
          const ordered = openChecks.slice().sort((a, b) => rank(a) - rank(b));
          const lines: string[] = [];
          for (const row of ordered.slice(0, 2)) {
            const claim = row.claim.replace(/\s+/g, ' ').trim();
            const excerpt = claim.length > 90 ? `${claim.slice(0, 89)}…` : claim;
            // The probe is the POINT of the row — an unprobed claim is reported as
            // unfalsifiable rather than silently rendered as if a probe existed.
            const probe = row.recheck?.replace(/\s+/g, ' ').trim();
            const settle = probe
              ? `run recheck: ${probe.length > 90 ? `${probe.slice(0, 89)}…` : probe}`
              : row.kind === 'blocker'
                ? 'no next verb recorded — re-read the blocker before waiting on it'
                : 'NO PROBE STORED — treat as [inferred]; do not rely on it';
            const badge = row.contested ? '⚠ CONTESTED' : row.kind === 'blocker' ? 'open blocker' : '? UNVERIFIED';
            lines.push(`- 🔎 ${badge} ${JSON.stringify(excerpt)} — ${settle} [${row.pointer}]`);
          }
          if (ordered.length > 2) {
            const rest = ordered.length - 2;
            lines.push(
              `- 🔎 +${rest} more unverified claim(s)/open blocker(s) — loop:status / work_items:get carry the rows.`,
            );
          }
          return lines;
        },
      },
    ],
  }),

  orientationClass<OrientationHistoryUpdate[] | undefined>({
    id: 'historyUpdates',
    watermarkTokens: ['historyUpdates'],
    applicableSinks: TURN_START,
    populate: (state) => state.historyUpdates,
    segments: [
      {
        order: 40,
        render: (updates) => {
          if (!updates || updates.length === 0) return [];
          const shown = updates.slice(0, 2);
          const total = updates.reduce((sum, update) => sum + update.count, 0);
          const refs = shown.map((update) => workItemFetchHint(update.workItemId, update.harness)).join('; ');
          return [`- ⚠ ${total} post-claim history update(s) on held work — read current context: ${refs}`];
        },
      },
    ],
  }),

  orientationClass<OrientationEffortUpdate[] | undefined>({
    id: 'effortUpdates',
    watermarkTokens: ['effortUpdates'],
    applicableSinks: TURN_START,
    populate: (state) => state.effortUpdates,
    segments: [
      {
        order: 50,
        render: (updates) => {
          if (!updates || updates.length === 0) return [];
          const total = updates.reduce((sum, update) => sum + update.count, 0);
          const refs = updates.slice(0, 3).map((update) => `${update.level}:${update.ref}`).join(', ');
          return [`- ⚠ ${total} post-claim plan/goal revision(s) (${refs}) — re-read the current plan/goal context.`];
        },
      },
    ],
  }),

  orientationClass<number>({
    id: 'unansweredDirected',
    watermarkTokens: ['unanswered'],
    applicableSinks: TURN_START,
    populate: (state) => state.unansweredDirected,
    segments: [
      {
        order: 60,
        render: (unansweredDirected) =>
          unansweredDirected > 0
            ? [`- ⚠ ${unansweredDirected} directed msg(s) awaiting YOUR reply — answer first.`]
            : [],
      },
    ],
  }),

  orientationClass<number>({
    id: 'unansweredStale',
    watermarkTokens: ['unansweredStale'],
    applicableSinks: TURN_START,
    populate: (state) => state.unansweredStale,
    segments: [
      {
        // EI-20085805220385722: reported, but deliberately NOT as "answer first" —
        // the sender is gone, so nobody is blocked and answering costs a turn nobody
        // reads. Shown so the obligation is visible rather than silently vanished.
        order: 70,
        render: (unansweredStale) =>
          unansweredStale > 0
            ? [`- ${unansweredStale} more from ENDED senders — no one is waiting; close them out, don't prioritise.`]
            : [],
      },
    ],
  }),

  orientationClass<OrientationOpenAsk | null>({
    id: 'openAsks',
    watermarkTokens: ['openAsks'],
    applicableSinks: TURN_START,
    populate: (state) => state.openAsks,
    segments: [
      {
        // The reciprocal counter (WI-2142142): asks THIS agent made that a peer has
        // not yet answered. Lower priority than the line above (an ask you are
        // owed never outranks an ask you owe), so it renders second.
        order: 80,
        render: (openAsks) => {
          if (!openAsks) return [];
          const { count, oldestAgeMs, oldestTo } = openAsks;
          return [`- ${count} open ask(s) sent, oldest ${compactAgeHours(oldestAgeMs)} — awaiting ${compactActor(oldestTo)}.`];
        },
      },
    ],
  }),

  orientationClass<{ armed: boolean; withheld: boolean }>({
    id: 'loopArmed',
    watermarkTokens: ['loop'],
    applicableSinks: TURN_START,
    populate: (state) => ({ armed: state.loopArmed, withheld: state.loopFireWithheld }),
    segments: [
      {
        // A missing wake source can strand every line below it, so the WARNING is
        // high-priority. The reassuring ARMED line is cheap context and goes last.
        order: 90,
        render: ({ armed }) =>
          armed ? [] : ['- ⚠ engine loop: not armed — loop:arm open-ended work or you halt silently after this turn.'],
      },
      {
        order: 190,
        render: ({ armed, withheld }) =>
          armed
            ? [
                withheld
                  ? '- engine loop: ARMED — fire pending, withheld for interactive turn.'
                  : '- engine loop: ARMED (a wake source exists).',
              ]
            : [],
      },
    ],
  }),

  orientationClass<OrientationHeldItem[]>({
    id: 'held',
    watermarkTokens: ['held'],
    applicableSinks: TURN_START,
    populate: (state) => state.held,
    segments: [
      {
        order: 100,
        render: (held) => {
          const stale = held.filter((h) => Boolean(h.checkpoint?.trim()) && h.checkpointStale).map((h) => h.id);
          return stale.length > 0
            ? [`- ⚠ stale checkpoint: ${compactIds(stale, HELD_DISPLAY_CAP)} — verify current files/state before trusting it.`]
            : [];
        },
      },
      {
        order: 110,
        render: (held) => {
          const missing = held.filter((h) => !h.checkpoint?.trim()).map((h) => h.id);
          return missing.length > 0
            ? [`- ⚠ no checkpoint: ${compactIds(missing, HELD_DISPLAY_CAP)} — read work_items:get before acting.`]
            : [];
        },
      },
      {
        order: 150,
        render: (held) => {
          if (held.length === 0) return ['- holding: nothing — claim before your first edit.'];
          const shown = held.slice(0, HELD_DISPLAY_CAP);
          const rest = held.length - shown.length;
          const line = shown.map((h) => (h.status ? `${h.id} (${h.status})` : h.id)).join(', ');
          return [`- holding: ${line}${rest > 0 ? ` +${rest} more` : ''}`];
        },
      },
      {
        order: 170,
        render: (held) =>
          held
            .slice(0, CHECKPOINT_DISPLAY_CAP)
            .map((item) => renderCheckpointLine(item))
            .filter((line): line is string => line !== null),
      },
    ],
  }),

  orientationClass<AgentObligationBrief | null | undefined>({
    id: 'obligations',
    watermarkTokens: ['obligations'],
    applicableSinks: TURN_START,
    populate: (state) => state.obligations,
    segments: [
      {
        // ABOVE the "what to work on" lines (frontier / triage) on purpose. These say
        // "not that way", and a do-not-repeat is worth almost nothing once the agent
        // has already picked an approach — which is exactly what the lines below help
        // it do. Deliberately short: the composer BREAKS on the first line that does
        // not fit, so length spent here is taken from every line after it.
        order: 120,
        render: (obligations) => {
          if (!obligations) return [];
          const lines: string[] = [];
          const projectedLines = obligations.projection.text.split('\n').filter(Boolean);
          const omitted = obligations.projection.receipt.entriesOmitted;
          if (omitted > 0) {
            lines.push(`- obligations: +${omitted} omitted — ${obligations.detailRef}`);
          } else if (projectedLines.length > 0) {
            // An inner-complete projection can still lose its action at the outer
            // budget. Keep recovery ahead of that action without claiming an omission
            // that the final composer has not yet measured.
            lines.push(`- obligations: ${obligations.detailRef}`);
          }
          lines.push(...projectedLines);
          return lines;
        },
      },
    ],
  }),

  orientationClass<string[]>({
    id: 'neverDropFacts',
    watermarkTokens: ['facts'],
    // P-025: also declared for the leader-brief sink, which genuinely selects it
    // (see TURN_START_AND_LEADER_BRIEF above). A fleet leader has the widest
    // blast radius on the pot and previously received NO wall / dead-end /
    // guard-rail facts at all — the "antidote absent where the poison is
    // strongest" failure EI-18725816532600240 established for cold wakes.
    applicableSinks: TURN_START_AND_LEADER_BRIEF,
    populate: (state) => state.neverDropFacts,
    segments: [
      {
        // A never-drop fact still precedes plan/frontier/work lines, but a current
        // obligation recovery route must fit first: if the outer budget drops the
        // obligation action, this exact reader is the only truthful way to recover it.
        order: 130,
        render: (neverDropFacts) =>
          neverDropFacts.length > 0
            ? [`- 🛡️ never-drop facts: ${compactIds(neverDropFacts.map(compactFactKey), FACT_DISPLAY_CAP)} — facts:list before you plan.`]
            : [],
      },
    ],
  }),

  orientationClass<OrientationExecutableFrontier | null>({
    id: 'executableFrontier',
    watermarkTokens: ['frontier'],
    applicableSinks: TURN_START,
    populate: (state) => state.executableFrontier,
    segments: [
      {
        order: 140,
        render: (executableFrontier, _state, committed) => {
          const frontierLine = renderExecutableFrontierLine(executableFrontier, committed);
          return frontierLine ? [frontierLine] : [];
        },
      },
    ],
  }),

  orientationClass<OrientationAnnouncedGate[]>({
    id: 'announcedGates',
    watermarkTokens: ['gates'],
    // P-027: the leader brief ALREADY rendered announced gates, but from an
    // undeclared read — so this table under-reported which surfaces carry the
    // class, which is exactly what P-024's (class x sink) matrix flagged.
    // Declaring it here makes `readLeaderAnnouncedGates` consume the
    // declaration (D-053: a structured sink consumes by `id`, not by
    // `segments[].render`), so withdrawing the sink is a ONE-LINE change here
    // and turns the leader field off with no second edit.
    applicableSinks: TURN_START_AND_LEADER_BRIEF,
    populate: (state) => state.announcedGates,
    segments: [
      {
        order: 160,
        render: (announcedGates) => {
          if (announcedGates.length === 0) return [];
          const lines: string[] = [];
          for (const warning of announcedGates.map((gate) => gate.warning).filter(Boolean)) {
            lines.push(`- ⚠ ${compactHeadline(warning)}`);
          }
          lines.push(
            `- announced gates: ${compactIds(
              announcedGates.map((gate) => gate.event),
              GATE_DISPLAY_CAP,
            )}${announcedGates.length > GATE_DISPLAY_CAP ? ' — events:catalog for all' : ''}`,
          );
          return lines;
        },
      },
    ],
  }),

  orientationClass<OrientationInboxEntry[]>({
    id: 'inboxRecent',
    watermarkTokens: ['inbox'],
    applicableSinks: TURN_START,
    populate: (state) => state.inboxRecent,
    segments: [
      {
        order: 180,
        render: (inboxRecent) =>
          inboxRecent
            .slice(0, INBOX_DISPLAY_CAP)
            .map((entry) => `- inbox ${compactActor(entry.from)}: ${compactHeadline(entry.summary)}`),
      },
    ],
  }),

  orientationClass<boolean>({
    id: 'loopFireWithheld',
    watermarkTokens: ['loopWithheld'],
    applicableSinks: TURN_START,
    populate: (state) => state.loopFireWithheld,
    segments: [],
    unrenderedReason:
      'Rendered as a VARIANT of the loopArmed ARMED line (order 190), not as a line of its own — see the loopArmed entry. ' +
      'It keeps its OWN watermark token (`loopWithheld`) because the variant it selects is a visible change the reader must be re-shown.',
  }),

  orientationClass<OrientationImprovementTriage | null>({
    id: 'improvementTriage',
    watermarkTokens: [],
    applicableSinks: TURN_START,
    populate: (state) => state.improvementTriage,
    segments: [],
    unrenderedReason:
      'DELIBERATELY NOT RENDERED (plan turn-start-memory-two-class-2026-09-21, P-017; rationale in D-003). It rendered on every ' +
      'turn and produced zero observed action — the canonical signal-decay case: a row that is always present teaches the reader ' +
      'to skip the whole block. The provider and `OrientationState.improvementTriage` REMAIN so the full coord:orient payload ' +
      'keeps serving it on demand; only the unconditional per-turn line is withdrawn. Its watermark token was withdrawn WITH the ' +
      'line: a component for an unrendered class would re-mark the block as changed for a signal the reader can no longer see. ' +
      'The class-coverage guard records this as an entry in DELIBERATELY_UNRENDERED, because a dropped class is a decision, not ' +
      'a coverage gap.',
  }),
];

/**
 * PURE: the segments an individual surface renders, in emission order.
 *
 * This is the SELECT half of the mechanism — each brief calls it with its own
 * sink and spends its own budget on the result.
 */
export function selectOrientationSegments(
  sink: OrientationSink,
  registry: readonly RegisteredOrientationClass[] = ORIENTATION_CLASS_REGISTRY,
): readonly { readonly order: number; readonly render: (state: OrientationState, committed: CursorState | null) => string[] }[] {
  return registry
    .filter((entry) => entry.applicableSinks.includes(sink))
    .flatMap((entry) => entry.segments)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/**
 * PURE: render the block, highest-priority line first so budget truncation drops
 * the least important thing rather than an arbitrary tail.
 *
 * The ORDER encodes the playbook's own priority rule: a directed message awaiting
 * your answer outranks your own work, so it leads. The no-wake-source warning is
 * next because an agent that cannot be re-woken silently halts, which is the most
 * expensive failure on this list. That order now lives in the `order` field of
 * {@link ORIENTATION_CLASS_REGISTRY}, which is where it is asserted.
 */
export function renderOrientationLines(state: OrientationState, committed: CursorState | null = null): string[] {
  const lines: string[] = [];
  for (const segment of selectOrientationSegments('turn-start')) {
    lines.push(...segment.render(state, committed));
  }
  return lines;
}


/**
 * PURE: compose the final injected block, or '' for "say nothing this turn".
 *
 * Returns '' in all three silence cases — unchanged since last turn, nothing worth
 * saying, or a budget too small to fit even one line — so the caller can splice the
 * result unconditionally.
 */
export function composeOrientationBlock(input: {
  state: OrientationState;
  committed: CursorState | null;
  /**
   * The CONTEXT GENERATION this composition belongs to (see
   * `fingerprintOrientation`). REQUIRED rather than defaulted: a caller that
   * forgets it silently reinstates the epoch-blind suppression this parameter
   * exists to remove, and a default would make that omission invisible. 0 is
   * the honest value for "no generation known" (an unbumped or unreadable
   * ledger), which degrades to the pre-P-023 behaviour rather than to noise.
   */
  epoch: number;
  budgetChars?: number;
}): string {
  const { state, committed, epoch } = input;
  const budget = input.budgetChars ?? ORIENTATION_BUDGET_CHARS;
  if (isEmptyOrientation(state)) return '';
  // P-002 — CLASS-B RE-INJECT POLICY. An obligation row is discharged by
  // DISPOSITION, not by DELIVERY, so the unchanged-fingerprint comparison must
  // not govern it: a standing owner directive that rendered once and was then
  // suppressed as "unchanged" is a one-shot, which is the defect this item
  // names. Undischarged rows are therefore EXCLUDED from that comparison.
  //
  // When everything else really is unchanged, re-emit the ROW and not the whole
  // block: repeating held items, gates and facts that have not moved would
  // manufacture the exact signal decay D-003 withdrew the improvement-triage
  // line for.
  const unchanged = orientationUnchanged(committed, fingerprintOrientation(state, epoch, committed));
  const undischarged = hasUndischargedObligations(state);
  if (unchanged && !undischarged) return '';
  const renderState = unchanged ? undischargedObligationsOnly(state) : state;

  const header = `## ${HEADING}`;
  const lines = renderOrientationLines(renderState, committed);
  const out: string[] = [header];
  let used = header.length;
  for (const line of lines) {
    const cost = line.length + 1; // + the newline joining it
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  // Header alone says nothing — emit only if at least one real line survived.
  return out.length > 1 ? out.join('\n') : '';
}

/** Fingerprint only obligation content that survived the final outer budget.
 * A provider receipt describes its inner projection; this check closes the
 * second budget boundary before the shared cursor is staged. */
export function fingerprintDeliveredOrientation(
  state: OrientationState,
  epoch: number,
  committed: CursorState | null,
  block: string,
): CursorState {
  let deliveredState = state;
  if (state.historyUpdates?.length) {
    const delivered = block.includes('post-claim history update(s)');
    if (!delivered) deliveredState = { ...deliveredState, historyUpdates: undefined };
  }
  if (state.effortUpdates?.length) {
    const delivered = block.includes('post-claim plan/goal revision(s)');
    if (!delivered) deliveredState = { ...deliveredState, effortUpdates: undefined };
  }
  // Budget-truncated ⇒ NOT delivered ⇒ do not advance the token. Without this the
  // first turn that trims this line marks the rows "seen" forever, and the agent
  // inherits a claim it was never shown — a silent failure indistinguishable from
  // the row having been re-checked.
  if (state.openChecks?.length) {
    const delivered = block.includes('🔎');
    if (!delivered) deliveredState = { ...deliveredState, openChecks: undefined };
  }
  const obligations = state.obligations;
  if (!obligations) return fingerprintOrientation(deliveredState, epoch, committed);
  const projectedLines = obligations.projection.text.split('\n').filter(Boolean);
  const actionsDelivered = projectedLines.every((line) => block.includes(line));
  const recoveryDelivered =
    obligations.projection.receipt.entriesOmitted === 0 || block.includes(obligations.detailRef);
  return fingerprintOrientation(
    actionsDelivered && recoveryDelivered ? deliveredState : { ...deliveredState, obligations: undefined },
    epoch,
    committed,
  );
}

/**
 * Injectable IO seam (mirrors orient-capture-miss-hint.ts's deps pattern), so the
 * composition above stays unit-testable without PG and each source can be faulted
 * independently in a test.
 */
export interface OrientationDeps {
  held: (ownerId: string, workspaceId: string) => Promise<OrientationHeldItem[]>;
  ownerDirectives?: (workspaceId: string) => Promise<OrientationOwnerDirective[]>;
  historyUpdates: (ownerId: string, workspaceId: string) => Promise<OrientationHistoryUpdate[]>;
  effortUpdates: (ownerId: string, workspaceId: string) => Promise<OrientationEffortUpdate[]>;
  /**
   * P-010: unverified carried claims + open external blockers, each with its probe.
   *
   * ⚠ OPTIONAL, AND THAT IS A RECORDED GAP — NOT A DESIGN CHOICE. `defaultOrientationDeps()`
   * does not implement this yet, so in production this class is DECLARED, registered,
   * watermarked and rendered-if-populated, but NOTHING POPULATES IT. That is precisely the
   * 0-renders-in-334-turns failure this plan exists to detect, one level up: the coverage
   * guard proves the RENDER path works (it supplies the state itself) and cannot see a
   * missing RESOLVER.
   *
   * It was `required` and unimplemented, which left the COMMITTED tree type-broken and
   * would have red-pinned the fleet gate. Made optional by su-c03852cb to unbreak the
   * build WITHOUT inventing su-6b1151ea's reader design while that session was MCP-dark.
   * The real fix is to implement it in `defaultOrientationDeps` (loop:checkpoint `checks`
   * + open `work_items:set_blocker` rows) and make this REQUIRED again. Tracked — do not
   * quietly accept the optionality as finished.
   */
  openChecks?: (ownerId: string, workspaceId: string) => Promise<OrientationOpenCheck[]>;
  inbox: (ownerId: string) => Promise<{
    count: number;
    newest: OrientationInboxEntry[];
    /** EI-20085805220385722: asks whose SENDER is positively ended. Optional so
     *  an older/stubbed seam still satisfies this contract (absent ⇒ 0). */
    staleCount?: number;
  }>;
  announcedGates: (ownerId: string, workspaceId: string) => Promise<OrientationAnnouncedGate[]>;
  /** WI-2142142: directed messages this agent sent that a peer has not yet
   *  answered; null for none/unreadable — same fail-soft contract as every
   *  other source here. */
  openAsks: (ownerId: string) => Promise<OrientationOpenAsk | null>;
  loopArmed: (ownerId: string) => Promise<boolean>;
  loopFireWithheld: (ownerId: string) => Promise<boolean>;
  /** Existing improvement triage/ranking path, reduced to one bounded row. */
  improvementTriage: (workspaceId: string) => Promise<OrientationImprovementTriage | null>;
  /** P-011 exact-plan executable width, or null when paused/unknown/broad. */
  executableFrontier: (ownerId: string, workspaceId: string) => Promise<OrientationExecutableFrontier | null>;
  /** Same evaluated agenda fleet:leader-brief consumes, projected to this sink's tighter cap. */
  obligations: (ownerId: string, workspaceId: string) => Promise<AgentObligationBrief | null>;
  /** KEYS of never-drop standing facts in this agent's scopes (workspace + owner). */
  neverDropFacts: (ownerId: string, workspaceId: string) => Promise<string[]>;
  /**
   * Evidence that this agent's MCP tool surface loaded EMPTY, or null for
   * healthy/unreadable. Takes only `ownerId`: the detector deliberately scopes by
   * NOTHING else (see the default reader for why a workspace/harness predicate
   * manufactures false positives here).
   */
  toolSurface: (ownerId: string) => Promise<OrientationToolSurface | null>;
  /**
   * The measured carry blind window (EI-21442716425230784), or null when there
   * is no recent cut, the window was empty, or it could not be read — all three
   * render as silence, because a window manufactured from a failed read would
   * send a successor hunting turns that do not exist.
   */
  carryBlindWindow: (ownerId: string, workspaceId: string) => Promise<CarryBlindWindow | null>;
  /**
   * The agent's CONTEXT GENERATION (P-023 / D-008) — NOT part of the rendered
   * state, only of the dedup key, which is why it is not on `OrientationState`.
   * Reads `memory_session_epochs`, the same counter the memory surfaced-ledger
   * dedups on, so the two folds on this rail cannot disagree about what a
   * context boundary is.
   */
  contextEpoch: (ownerId: string) => Promise<number>;
}

/**
 * Resolve this turn's orientation. EVERY source is independently `.catch()`ed and
 * the whole set runs in ONE `Promise.all`, because of the 2.5s wall: a slow or
 * broken source must degrade its own line, never the block and never the turn.
 * A failed `held` read yields [] and a failed count yields 0 — both of which
 * simply say less, and neither of which can throw into the endpoint.
 */
export async function resolveOrientationState(
  ownerId: string,
  workspaceId: string,
  deps: Partial<OrientationDeps> = {},
): Promise<OrientationState> {
  const d = { ...defaultOrientationDeps(), ...deps };
  const ownerDirectivesReader = d.ownerDirectives ?? (async () => [] as OrientationOwnerDirective[]);
  const [
    held,
    ownerDirectives,
    historyUpdates,
    effortUpdates,
    openChecks,
    inbox,
    announcedGates,
    openAsks,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
    executableFrontier,
    obligations,
    neverDropFacts,
    toolSurface,
    carryBlindWindow,
  ] = await Promise.all([
    d.held(ownerId, workspaceId).catch(() => [] as OrientationHeldItem[]),
    ownerDirectivesReader(workspaceId).catch(() => [] as OrientationOwnerDirective[]),
    // Unknown must remain distinct from measured-empty. Otherwise a transient
    // read failure advances the shared cursor past history the agent never saw.
    d.historyUpdates(ownerId, workspaceId).catch(() => undefined),
    d.effortUpdates(ownerId, workspaceId).catch(() => undefined),
    // Same unknown-vs-measured-empty rule. It matters MORE here than for the two
    // above: an empty list reads as "nothing left to falsify", which is the exact
    // false reassurance this class exists to deny. A read failure must stay silent
    // and preserve the prior token, never assert the all-clear.
    // An ABSENT reader and a FAILED read are the same thing to this class, and both
    // must resolve `undefined` rather than `[]` — see the dep's doc comment. `[]`
    // would assert "nothing left to falsify", the false all-clear this class denies.
    d.openChecks ? d.openChecks(ownerId, workspaceId).catch(() => undefined) : Promise.resolve(undefined),
    d.inbox(ownerId).catch(() => ({ count: 0, newest: [] as OrientationInboxEntry[] })),
    d.announcedGates(ownerId, workspaceId).catch(() => [] as OrientationAnnouncedGate[]),
    // Fail-soft to null, same rule as toolSurface below: "cannot tell" must
    // render as silence, never as a false "nothing outstanding".
    d.openAsks(ownerId).catch(() => null as OrientationOpenAsk | null),
    d.loopArmed(ownerId).catch(() => false),
    d.loopFireWithheld(ownerId).catch(() => false),
    d.improvementTriage(workspaceId).catch(() => null),
    d.executableFrontier(ownerId, workspaceId).catch(() => null),
    // Undefined is distinct from measured-empty: preserve the prior cursor on
    // an optional read failure so a transient outage cannot fake resolution.
    d.obligations(ownerId, workspaceId).catch(() => undefined),
    // Degrades to "say nothing about facts", never to a thrown turn — same rule
    // as every other source here. A failed read must not be able to suppress the
    // block that carries the other agents' warnings.
    d.neverDropFacts(ownerId, workspaceId).catch(() => [] as string[]),
    // Fail-soft to null — "cannot tell" renders as SILENCE, never as a verdict. A
    // slow or broken read here must not be able to accuse a working agent of being
    // toolless; the cost of a missed warning is one more turn, the cost of a false
    // one is an agent restarting a session that was fine.
    d.toolSurface(ownerId).catch(() => null as OrientationToolSurface | null),
    // Same fail-soft rule, and it matters here specifically: the reader spans a
    // host event log and a PG count, either of which can be unavailable on the
    // very turn a successor boots.
    d.carryBlindWindow(ownerId, workspaceId).catch(() => null as CarryBlindWindow | null),
  ]);
  return {
    held,
    ...(ownerDirectives.length > 0 ? { ownerDirectives } : {}),
    historyUpdates,
    effortUpdates,
    openChecks,
    unansweredDirected: inbox.count,
    // `in` rather than a plain read: an injected seam (tests, an older deps
    // object) may legitimately omit the field, and the union type says so.
    // Absent ⇒ 0 ⇒ nothing demoted, which is the fail-open direction.
    unansweredStale: 'staleCount' in inbox ? (inbox.staleCount ?? 0) : 0,
    inboxRecent: inbox.newest,
    announcedGates,
    openAsks,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
    executableFrontier,
    obligations,
    neverDropFacts,
    toolSurface,
    carryBlindWindow,
  };
}

/** Default readers — each one is an EXISTING shared primitive, never a new query.
 *  Dynamic imports keep them off the module graph until a turn actually needs them. */
export function defaultOrientationDeps(): OrientationDeps {
  return {
    ownerDirectives: async (workspaceId) => {
      const { listOpenOwnerDirectives } = await import('./owner-directives');
      const rows: OwnerDirectiveRow[] = await listOpenOwnerDirectives(workspaceId, 12);
      return rows
        .filter((row) => row.captureStatus === 'pending' || row.captureStatus === 'open')
        .map((row) => ({
          id: row.id,
          captureStatus: row.captureStatus === 'pending' ? 'pending' : 'open',
          verbatimText: row.verbatimText,
        }));
    },
    effortUpdates: async (ownerId, workspaceId) => {
      const [{ getOrgPg }, { resolveConcreteWorkspaceId }] = await Promise.all([
        import('@papercusp/db-org'),
        import('./workspace-registry'),
      ]);
      const { sql } = getOrgPg();
      const ws = resolveConcreteWorkspaceId(workspaceId);
      const rows = await sql<Array<{
        level: 'plan' | 'goal';
        effort_ref: string;
        post_count: number | string;
        newest_post_id: number | string;
      }>>`
        WITH held AS (
          SELECT feature_id, harness_slug, taken_by, source_plan_slug, goal_id, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${ws}
             AND taken_by = ${ownerId}
             AND taken_at IS NOT NULL
             AND ((item_kind IN ('bug', 'change', 'task') AND status NOT IN ('done', 'resolved', 'deprecated', 'closed'))
               OR (item_kind IN ('feature', 'chunk') AND status NOT IN ('passed', 'deprecated', 'done', 'resolved', 'closed')))
           ORDER BY feature_id DESC
           LIMIT 6
        ), ancestry AS (
          SELECT h.*,
                 COALESCE(h.goal_id, p.goal_id) AS effective_goal_id
            FROM held h
            LEFT JOIN harness_shared.harness_plans p
              ON p.workspace_id = ${ws}
             AND p.harness_slug = h.harness_slug
             AND p.plan_slug = h.source_plan_slug
        ), relevant AS (
          SELECT 'plan'::text AS level,
                 a.source_plan_slug AS effort_ref,
                 a.payload,
                 t.thread_id
            FROM ancestry a
            JOIN harness_shared.coord_threads t
              ON t.workspace_id = ${ws}
             AND t.parent_kind = 'plan'
             AND t.parent_ref = a.harness_slug || ':' || a.source_plan_slug
           WHERE a.source_plan_slug IS NOT NULL
          UNION ALL
          SELECT 'goal'::text AS level,
                 a.effective_goal_id AS effort_ref,
                 a.payload,
                 t.thread_id
            FROM ancestry a
            JOIN harness_shared.coord_threads t
              ON t.workspace_id = ${ws}
             AND t.parent_kind = 'goal'
             AND t.parent_ref = a.effective_goal_id
           WHERE a.effective_goal_id IS NOT NULL
        )
        SELECT r.level,
               r.effort_ref,
               count(DISTINCT p.id)::int AS post_count,
               max(p.id)::bigint AS newest_post_id
          FROM relevant r
          JOIN harness_shared.coord_thread_posts p
            ON p.workspace_id = ${ws}
           AND p.thread_id = r.thread_id
           AND p.id > COALESCE(NULLIF(r.payload ->> 'claim_history_post_id', '')::bigint, 0)
         GROUP BY r.level, r.effort_ref
         ORDER BY max(p.id) DESC
      `;
      return rows.map((row) => ({
        level: row.level,
        ref: row.effort_ref,
        count: Number(row.post_count),
        newestPostId: Number(row.newest_post_id),
      }));
    },
    historyUpdates: async (ownerId, workspaceId) => {
      const [{ getOrgPg }, { resolveConcreteWorkspaceId }] = await Promise.all([
        import('@papercusp/db-org'),
        import('./workspace-registry'),
      ]);
      const { sql } = getOrgPg();
      const ws = resolveConcreteWorkspaceId(workspaceId);
      const rows = await sql<Array<{
        work_item_id: string;
        harness_slug: string | null;
        post_count: number | string;
        newest_post_id: number | string;
      }>>`
        WITH held AS (
          SELECT feature_id, harness_slug, item_kind, taken_at, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${ws}
             AND taken_by = ${ownerId}
             AND taken_at IS NOT NULL
             AND ((item_kind IN ('bug', 'change', 'task') AND status NOT IN ('done', 'resolved', 'deprecated', 'closed'))
               OR (item_kind IN ('feature', 'chunk') AND status NOT IN ('passed', 'deprecated', 'done', 'resolved', 'closed')))
           ORDER BY feature_id DESC
           LIMIT 6
        ), relevant_threads AS (
          SELECT h.feature_id,
                 h.harness_slug,
                 h.taken_at,
                 h.payload,
                 t.thread_id
            FROM held h
            JOIN harness_shared.coord_threads t
              ON t.workspace_id = ${ws}
             AND (
               (t.parent_kind = 'issue' AND h.item_kind IN ('bug', 'change', 'task') AND t.parent_ref = h.feature_id)
               OR (t.parent_kind = 'feature' AND h.item_kind IN ('feature', 'chunk') AND t.parent_ref = h.harness_slug || '#' || h.feature_id)
             )
        )
        SELECT r.feature_id AS work_item_id,
               r.harness_slug,
               count(*)::int AS post_count,
               max(p.id)::bigint AS newest_post_id
          FROM relevant_threads r
          JOIN harness_shared.coord_thread_posts p
           ON p.workspace_id = ${ws}
           AND p.thread_id = r.thread_id
           AND p.id > COALESCE(
             NULLIF(r.payload ->> 'claim_history_post_id', '')::bigint,
             -- Legacy claims predate the atomic watermark. Reconstruct the
             -- best truthful baseline from posts that already existed by the
             -- claim instant; new claims never use this timestamp fallback.
             (SELECT max(before.id)
                FROM harness_shared.coord_thread_posts before
               WHERE before.workspace_id = ${ws}
                 AND before.thread_id = r.thread_id
                 AND before.created_at <= r.taken_at),
             0
           )
         GROUP BY r.feature_id, r.harness_slug
         ORDER BY max(p.id) DESC
      `;
      return rows.map((row) => ({
        workItemId: row.work_item_id,
        harness: row.harness_slug,
        count: Number(row.post_count),
        newestPostId: Number(row.newest_post_id),
      }));
    },
    // The SAME primitive coord:orient folds this tier with (foldNeverDropFacts,
    // narrowed in SQL to NEVER_DROP_KEY_PREFIXES), so the per-turn block and the
    // orient fold cannot drift on "what counts as a never-drop fact".
    //
    // Scoped to workspace + owner, matching orient's own selector set minus the
    // harness leg — this fold has no harness argument to pass, and a guard rail
    // worth interrupting a turn for is asserted at workspace scope in practice.
    neverDropFacts: async (ownerId, workspaceId) => {
      const { foldNeverDropFacts } = await import('./agent-facts/store');
      const selectors = [
        { scope: 'workspace' as const },
        ...(ownerId ? [{ scope: 'owner' as const, scopeRef: ownerId }] : []),
      ];
      const facts = await foldNeverDropFacts(selectors, { workspaceId });
      const keys = facts.map((f) => f.key).filter((k): k is string => Boolean(k));
      // Deduped because the same key can legitimately resolve from two selectors;
      // sorted so the fingerprint is stable across fold order.
      return [...new Set(keys)].sort();
    },
    // carry-brief.ts's reader, already extracted so this fold and orient's
    // post-compaction recovery fold cannot drift on "what am I holding".
    //
    // ⚠ v1 CARRIES NO STATUS. `CarryBriefHeldItem` is { id, title, body, harness,
    // checkpoint } — there is no `status` field, so nothing here can populate one
    // without a SECOND query. The consequence is precise and worth knowing: an
    // item moving wip→blocked does NOT re-emit the block (the fingerprint sees an
    // unchanged id list); an item being CLAIMED or RELEASED does. That is the
    // right trade for a per-turn fold, but do not read the absence of a re-emit
    // as "nothing about my items changed".
    held: async (ownerId, workspaceId) => {
      const [{ readHeldWorkItems }, { isStaleHeldCheckpoint }] = await Promise.all([
        import('./carry-brief'),
        import('./turn-end-tracking'),
      ]);
      const rows = await readHeldWorkItems(ownerId, workspaceId);
      const nowMs = Date.now();
      return rows
        .map((r) => ({
          id: r.id,
          harness: r.harness,
          checkpoint: r.checkpoint,
          checkpointUpdatedAtMs: r.checkpointUpdatedAtMs,
          checkpointStale: Boolean(r.checkpoint?.trim()) && isStaleHeldCheckpoint(r, nowMs),
        }))
        .filter((r) => Boolean(r.id));
    },
    // The SAME primitive fleet:assignments / leader-brief count with, so this
    // number can never disagree with the one a leader sees.
    inbox: async (ownerId) => {
      const { fetchUnansweredDirected } = await import('./agent-tools/coordination/unanswered-directed');
      const map = await fetchUnansweredDirected([ownerId]);
      const summary = map.get(ownerId);
      return summary
        ? {
            count: summary.count,
            staleCount: summary.staleCount,
            newest: summary.newest.map((entry) => ({
              msgId: entry.msgId,
              from: entry.from,
              ...(entry.summary ? { summary: entry.summary } : {}),
            })),
          }
        : { count: 0, staleCount: 0, newest: [] };
    },
    // WI-2142142: the sender-side mirror of `inbox` above, from the SAME
    // module (unanswered-directed.ts) so the two definitions of "answered"
    // cannot drift apart.
    openAsks: async (ownerId) => {
      const { fetchOpenAsks } = await import('./agent-tools/coordination/unanswered-directed');
      const map = await fetchOpenAsks([ownerId]);
      const summary = map.get(ownerId);
      return summary && summary.count > 0
        ? { count: summary.count, oldestAgeMs: summary.oldestAgeMs, oldestTo: summary.oldestTo }
        : null;
    },
    // D-004 keeps event discovery a directory. Reuse the SAME announcement
    // store + visibility predicate as coord:orient/events:catalog, deriving the
    // caller scope from its durable brief and live fleet label. Never copy gate
    // keys into a hand-maintained table.
    announcedGates: async (ownerId, workspaceId) => {
      const [
        { listActiveAnnouncements, countActiveAwaitsByPrefixes },
        { selectVisibleAnnouncements },
        { getSessionBrief },
        { fetchPresenceFleet },
        { resolveAnnouncementOwnership },
        timeout,
      ] =
        await Promise.all([
          import('./events/await/store'),
          import('./events/await/announced-gate-view'),
          import('./session-brief'),
          import('./agent-tools/coordination/presence-fleet'),
          import('./agent-tools/events/status'),
          import('./bounded-timeout'),
        ]);
      // The scope is not known until the brief and fleet membership resolve, so
      // the announcement read stays CONCURRENT with them and the scoping is
      // applied after. P-027 / D-063: the scoping itself is the shared unit
      // (`selectVisibleAnnouncements`), used by the leader-brief sink too, so
      // the two sinks cannot drift on what a reader may see. `unfiredOnly: true`
      // is this sink's own choice — a fired gate is not something to await, and
      // an always-present row is the signal decay P-017/D-003 ruled against.
      const [announcements, brief, memberships] = await Promise.all([
        listActiveAnnouncements({ unfiredOnly: true, limit: 50 }),
        getSessionBrief({ ownerId }),
        fetchPresenceFleet([ownerId]),
      ]);
      const fleet = memberships.get(ownerId)?.fleetSlug ?? null;
      const visible = selectVisibleAnnouncements(announcements, {
        fleetSlug: fleet,
        planSlug: brief?.currentPlanSlug ?? null,
        harnessSlug: brief?.harnessSlug ?? null,
      });
      // Metadata is advisory and independently bounded. A failure omits only
      // the affected optional fields; it must not erase the gate directory.
      const [countsResult, ownershipResult] = await Promise.all([
        timeout.withBoundedTimeout(countActiveAwaitsByPrefixes(visible.map((announcement) => announcement.eventKey)), {
          fallback: null as Map<string, number> | null,
          timeoutMs: 1_000,
          label: 'turn-start:announcedGateAwaiters',
        }),
        timeout.withBoundedTimeout(resolveAnnouncementOwnership(visible, workspaceId), {
          fallback: null as Map<number, { liveSuccessorIds: string[]; staleOwner: boolean }> | null,
          timeoutMs: 1_000,
          label: 'turn-start:announcedGateOwnership',
        }),
      ]);
      const counts = countsResult.value;
      const ownership = ownershipResult.value;
      return visible
        .filter((announcement) =>
          Boolean(announcement.eventKey),
        )
        .map((announcement) => ({
          event: announcement.eventKey,
          logical_gate: announcement.logicalGateKey ?? null,
          note: announcement.note,
          ...(counts ? { live_awaiters: counts.get(announcement.eventKey) ?? 0 } : {}),
          ...(ownership?.get(announcement.id)?.liveSuccessorIds.length
            ? { live_successor_ids: ownership.get(announcement.id)!.liveSuccessorIds }
            : {}),
          ...(ownership?.get(announcement.id)?.staleOwner ? { stale_owner: true } : {}),
          ...(buildAnnouncedGateWarning({
            event: announcement.eventKey,
            logical_gate: announcement.logicalGateKey ?? null,
            scope: announcement.scopeKind ? `${announcement.scopeKind}${announcement.scopeRef ? ':' + announcement.scopeRef : ''}` : 'global',
            announcedBy: announcement.subscriberId,
            stale_owner: ownership?.get(announcement.id)?.staleOwner,
          })
            ? {
                warning: buildAnnouncedGateWarning({
                  event: announcement.eventKey,
                  logical_gate: announcement.logicalGateKey ?? null,
                  scope: announcement.scopeKind ? `${announcement.scopeKind}${announcement.scopeRef ? ':' + announcement.scopeRef : ''}` : 'global',
                  announcedBy: announcement.subscriberId,
                  stale_owner: ownership?.get(announcement.id)?.staleOwner,
                }),
              }
            : {}),
        }));
    },
    loopArmed: async (ownerId) => {
      const { activeLoopOwners } = await import('./adv-roster');
      return (await activeLoopOwners()).has(ownerId);
    },
    loopFireWithheld: async (ownerId) => {
      const { getLoopStatus } = await import('./harness/routines/loop');
      return isLoopFireWithheld(await getLoopStatus(ownerId));
    },
    // P-013: filing already works; consumption did not. Reuse the exact bounded
    // triage window, policy split, and ONE human-queue ranker rather than adding
    // a second queue or reviving the paused scheduled routine. Duplicate
    // clustering is deliberately skipped: this per-turn consumer needs only the
    // ranked top row, and the fold's 2.5s wall makes unused O(n²) work a defect.
    improvementTriage: async (workspaceId) => {
      const [read, digestModule, grant, ranker, triageCore] = await Promise.all([
        import('./harness/improvements/read-items'),
        import('./harness/improvements/digest'),
        import('./harness/improvements/full-autonomy-grant'),
        import('./queue-ranker/human-queue'),
        import('./harness/improvements/triage-core'),
      ]);
      const [items, ownerFullAutonomy] = await Promise.all([
        read.readImprovementItems({ state: 'open', limit: IMPROVEMENT_TRIAGE_WINDOW_LIMIT }),
        grant.readOwnerFullAutonomyGrant(workspaceId),
      ]);
      const digest = await ranker.applyHumanQueueRanking(
        digestModule.buildDigest(items, {
          nowMs: Date.now(),
          ownerFullAutonomy,
          nearDuplicates: false,
        }),
        { candidates: items },
      );

      return selectOrientationImprovementTriage(digest, triageCore.selectUntriaged, {
        considered: items.length,
        // A full window may be the whole corpus or a slice; only a separate
        // count could distinguish them, so report the conservative lower bound.
        lowerBound: items.length === IMPROVEMENT_TRIAGE_WINDOW_LIMIT,
      });
    },
    // P-007 / D-005: reuse P-011's exact-plan + family-complete executable
    // width. This is deliberately bounded well inside the hook's 2.5s wall;
    // a slow graph/lane read is silence, not a delayed turn and not zero.
    executableFrontier: async (ownerId, workspaceId) => {
      const [frontier, timeout] = await Promise.all([
        import('./fleet/executable-frontier'),
        import('./bounded-timeout'),
      ]);
      const { value } = await timeout.withBoundedTimeout(
        frontier.readFleetExecutableFrontier({ ownerId, workspaceId }),
        {
          fallback: null as OrientationExecutableFrontier | null,
          timeoutMs: 900,
          label: 'turn-start executable frontier',
        },
      );
      return value ? { planSlug: value.planSlug, executableWidth: value.executableWidth } : null;
    },
    obligations: async (ownerId, workspaceId) => {
      const { readAgentObligationAgenda, projectAgentTurnStartObligationBrief } = await import(
        './agent-obligation-reader'
      );
      const { agenda, observedAt } = await readAgentObligationAgenda({ workspaceId, ownerId });
      // P-005: project the SAME evaluated agenda onto the existing durable await
      // plane. Reconciliation is fail-soft internally, so an unavailable optional
      // reminder can never suppress the load-bearing guidance rendered below.
      const { reconcileAgentObligationReminders } = await import('./agent-obligation-reminders');
      await reconcileAgentObligationReminders({ ownerId, agenda, now: new Date(observedAt) });
      if (agenda.primary.length === 0) return null;
      return projectAgentTurnStartObligationBrief(agenda);
    },
    // P-023 / D-008. The memory ledger's own epoch reader, reused rather than
    // re-derived: `currentSessionEpoch` is already best-effort by contract
    // (0 on a missing relation or a failed read, cached process-wide), and 0
    // is exactly the right degradation here — a generation that never moves
    // reproduces the pre-P-023 dedup rather than emitting on every turn.
    //
    // ⚠ The ledger is keyed by `session_id`, and the turn-start memory port
    // already passes the OWNER id as that key (`session: { sessionId: owner }`).
    // Passing the same value here is what makes the two folds share one
    // generation; a different key would silently give each its own.
    // EI-21308269358666878. DERIVED from two EXISTING ledgers — no new record, and
    // deliberately so: a server-side "we served tools/list" row would measure the
    // SERVER'S INTENT to serve, and goes blind in exactly the failure it is meant to
    // catch (the operator answers, the response dies in the proxy). Counting what
    // the CLIENT observably completed cannot be fooled that way.
    //
    // ⚠⚠ FILTER NEITHER harness_slug NOR workspace_id. Both legitimately hold the
    // literal '*' for workspace-global tools (coord:*, work_items:*) — 11k+ and 1k+
    // rows respectively in a 6h window — so scoping either DROPS most agent calls
    // and MANUFACTURES toolless-looking sessions. Measured, not theoretical: a
    // harness-scoped draft of this query flagged three healthy agents that had 379,
    // 432 and 331 agent calls. Only coord_owner_id + invoked_at + call_origin belong
    // in it. The same trap has a sibling — grouping by (owner, role) instead of
    // owner splits an owner's calls across role-slices and fakes a zero.
    //
    // The epoch row IS the guard, not just the window: no row ⇒ no anchor ⇒ no
    // verdict. That is what keeps a re-identified process (a carry-respawn whose
    // agent calls moved to a NEW ownerId while hook beats kept landing on the old
    // one) from reading as permanently toolless.
    toolSurface: async (ownerId) => {
      const [{ getOrgPg }, timeout] = await Promise.all([import('@papercusp/db-org'), import('./bounded-timeout')]);
      const { sql } = getOrgPg();
      const read = async (): Promise<OrientationToolSurface | null> => {
        const row = (await readOrientationToolSurfaces(sql, [ownerId]))[0];
        return row ? { hookCalls: row.hookCalls, windowMinutes: row.windowMinutes } : null;
      };
      const { value } = await timeout.withBoundedTimeout(read(), {
        fallback: null as OrientationToolSurface | null,
        timeoutMs: 700,
        label: 'turn-start tool surface',
      });
      return value;
    },
    // EI-21442716425230784. Both endpoints of the window are ALREADY recorded —
    // the carry snapshot is the caller's own session:request-compaction row, the
    // cut is the per-owner host event log's verdict — so this reader adds no
    // write at the boundary and no new state anywhere.
    carryBlindWindow: async (ownerId, workspaceId) => {
      const { readCarryBlindWindow } = await import('./carry-blind-window');
      return await readCarryBlindWindow(ownerId, { workspaceId });
    },
    contextEpoch: async (ownerId) => {
      const [{ currentSessionEpoch }, { getOrgPg }] = await Promise.all([
        import('./memory/session-epoch-ledger'),
        import('@papercusp/db-org'),
      ]);
      const { sql } = getOrgPg();
      return await currentSessionEpoch(sql, ownerId);
    },
  };
}

/**
 * The endpoint entry point: resolve, diff against the server-side cursor, render.
 * Returns '' on every failure and every silence case, so the caller can splice it
 * unconditionally into its section list.
 *
 * The cursor is advanced with the SPLIT-PHASE pair rather than the fused
 * `ackAndAdvance` for the same reason `coord:inbox` needs it — but note the phases
 * are cheap here, so the ordering is what matters: `stage` runs only AFTER a
 * non-empty block has actually been composed, so a turn that emits nothing does not
 * move the floor, and a turn that dies before injection re-emits next time.
 */
export async function buildTurnStartOrientationBlock(input: {
  ownerId: string;
  workspaceId: string;
  budgetChars?: number;
  deps?: Partial<OrientationDeps>;
}): Promise<string> {
  try {
    const { ownerId, workspaceId } = input;
    if (!ownerId) return '';
    // The epoch read joins the SAME Promise.all as the state read — it is one
    // indexed single-row lookup, but the 2.5s wall makes "one more await" a real
    // cost, and serializing it behind the state resolve would spend that wall for
    // nothing. Independently `.catch()`ed to 0 for the same reason every other
    // source is: a broken generation read must degrade the dedup to its old
    // behaviour, never fail the block or the turn.
    const epochDep = { ...defaultOrientationDeps(), ...(input.deps ?? {}) }.contextEpoch;
    const [{ ackAndRead, stage }, state, epoch] = await Promise.all([
      import('./agent-tools/coordination/read-cursors'),
      resolveOrientationState(ownerId, workspaceId, input.deps ?? {}),
      epochDep(ownerId).catch(() => 0),
    ]);
    if (isEmptyOrientation(state)) return '';
    const ack = await ackAndRead(ownerId, ORIENTATION_CURSOR_SURFACE).catch(() => null);
    const block = composeOrientationBlock({
      state,
      // A failed cursor read ⇒ treat as baseline and DELIVER. Fail-open: a delta
      // must never make orientation worse than no delta.
      committed: ack?.committed ?? null,
      epoch,
      ...(input.budgetChars === undefined ? {} : { budgetChars: input.budgetChars }),
    });
    if (block) {
      // Staged with the SAME epoch the block was composed against — never a
      // re-read. A second read here could land after a boundary and commit a
      // generation the agent was never actually told about, which would
      // reproduce the exact stale suppression this change removes.
      await stage(
        ownerId,
        ORIENTATION_CURSOR_SURFACE,
        fingerprintDeliveredOrientation(state, epoch, ack?.committed ?? null, block),
      ).catch(() => {});
    }
    return block;
  } catch {
    // Fail-soft by contract — the endpoint must never surface an error into a turn.
    return '';
  }
}
