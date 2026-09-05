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

/** Default budget. Small on purpose: this fires EVERY turn and compounds. */
export const ORIENTATION_BUDGET_CHARS = 600;

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

/** True when there is genuinely nothing worth spending a single character on. */
export function isEmptyOrientation(state: OrientationState): boolean {
  return (
    state.held.length === 0 &&
    state.unansweredDirected === 0 &&
    state.openAsks === null &&
    state.inboxRecent.length === 0 &&
    state.announcedGates.length === 0 &&
    !state.loopArmed &&
    !state.loopFireWithheld &&
    state.improvementTriage === null &&
    state.executableFrontier === null &&
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
    unanswered: state.unansweredDirected,
    // COUNT ONLY, mirroring `unanswered` above (not identity, not age): a
    // fingerprint keyed on oldestAgeMs would re-emit every turn purely
    // because time passed, defeating the whole point of the diff.
    openAsks: state.openAsks ? state.openAsks.count : 0,
    inbox: state.inboxRecent.map((entry) => `${entry.msgId}:${entry.from}:${entry.summary ?? ''}`).join('|'),
    gates: state.announcedGates
      .map((gate) => `${gate.event}:${gate.note ?? ''}`)
      .sort()
      .join('|'),
    loop: state.loopArmed ? 1 : 0,
    loopWithheld: state.loopFireWithheld ? 1 : 0,
    triage: state.improvementTriage
      ? `${state.improvementTriage.pending}:${state.improvementTriage.considered}:` +
        `${state.improvementTriage.lowerBound ? 1 : 0}:${state.improvementTriage.top.lane}:` +
        `${state.improvementTriage.top.id}:${state.improvementTriage.top.title}`
      : '',
    // UNKNOWN preserves the last known frontier token. A transient read failure
    // must not erase the cursor and make the same stable width look like a new
    // edge on the next successful turn.
    frontier: state.executableFrontier
      ? encodeExecutableFrontier(state.executableFrontier)
      : typeof committed?.frontier === 'string'
        ? committed.frontier
        : '',
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
    a.unanswered === b.unanswered &&
    // REQUIRED, same rule as `unanswered` beside it: writing the token in
    // fingerprintOrientation does nothing unless it is compared here.
    (a.openAsks ?? 0) === (b.openAsks ?? 0) &&
    a.inbox === b.inbox &&
    a.gates === b.gates &&
    a.loop === b.loop &&
    a.loopWithheld === b.loopWithheld &&
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
 * PURE: render the block, highest-priority line first so budget truncation drops
 * the least important thing rather than an arbitrary tail.
 *
 * The ORDER encodes the playbook's own priority rule: a directed message awaiting
 * your answer outranks your own work, so it leads. The no-wake-source warning is
 * next because an agent that cannot be re-woken silently halts, which is the most
 * expensive failure on this list.
 */
export function renderOrientationLines(state: OrientationState, committed: CursorState | null = null): string[] {
  const lines: string[] = [];
  // FIRST, above even the directed-message line. An agent whose tool surface is
  // empty cannot act on ANY line below this one — it cannot claim, checkpoint, or
  // even answer the directed message that otherwise leads. Deliberately terse: the
  // composer BREAKS on the first line that does not fit, so length spent here is
  // taken from every line after it.
  if (state.toolSurface) {
    lines.push(
      `- 🚨 MCP TOOLS NOT REGISTERED — 0 tool calls in ${state.toolSurface.windowMinutes}m vs ` +
        `${state.toolSurface.hookCalls} harness beats OK. Tool list loaded EMPTY; it cannot ` +
        `self-heal. RESTART THE SESSION (EI-21308269358666878).`,
    );
  }
  // Second, and above the directed-message line for one reason: it is the only
  // line here that DECAYS. Every other line describes state the agent can re-read
  // at any point in the session; this one describes turns that exist solely in a
  // dead predecessor's transcript, and an owner-salient deliverable stranded there
  // (EI-21442716425230784: an OAuth consent URL the owner was told to act on) is
  // discovered late or never. It renders once per respawn, so the cost is bounded.
  if (state.carryBlindWindow) {
    lines.push(renderCarryBlindWindowLine(state.carryBlindWindow));
  }
  if (state.unansweredDirected > 0) {
    lines.push(`- ⚠ ${state.unansweredDirected} directed msg(s) awaiting YOUR reply — answer first.`);
  }
  // The reciprocal counter (WI-2142142): asks THIS agent made that a peer has
  // not yet answered. Lower priority than the line above (an ask you are
  // owed never outranks an ask you owe), so it renders second.
  if (state.openAsks) {
    const { count, oldestAgeMs, oldestTo } = state.openAsks;
    lines.push(
      `- ${count} open ask(s) sent, oldest ${compactAgeHours(oldestAgeMs)} — awaiting ${compactActor(oldestTo)}.`,
    );
  }
  // A missing wake source can strand every line below it, so the WARNING is
  // high-priority. The reassuring ARMED line is cheap context and goes last.
  if (!state.loopArmed) {
    lines.push('- ⚠ engine loop: not armed — loop:arm open-ended work or you halt silently after this turn.');
  }
  const stale = state.held.filter((h) => Boolean(h.checkpoint?.trim()) && h.checkpointStale).map((h) => h.id);
  if (stale.length > 0) {
    lines.push(
      `- ⚠ stale checkpoint: ${compactIds(stale, HELD_DISPLAY_CAP)} — verify current files/state before trusting it.`,
    );
  }
  const missing = state.held.filter((h) => !h.checkpoint?.trim()).map((h) => h.id);
  if (missing.length > 0) {
    lines.push(`- ⚠ no checkpoint: ${compactIds(missing, HELD_DISPLAY_CAP)} — read work_items:get before acting.`);
  }
  // ABOVE the "what to work on" lines (frontier / triage) on purpose. These say
  // "not that way", and a do-not-repeat is worth almost nothing once the agent
  // has already picked an approach — which is exactly what the lines below help
  // it do. Deliberately short: the composer BREAKS on the first line that does
  // not fit, so length spent here is taken from every line after it.
  if (state.neverDropFacts.length > 0) {
    lines.push(
      `- 🛡️ never-drop facts: ${compactIds(
        state.neverDropFacts.map(compactFactKey),
        FACT_DISPLAY_CAP,
      )} — facts:list before you plan.`,
    );
  }
  const frontierLine = renderExecutableFrontierLine(state.executableFrontier, committed);
  if (frontierLine) lines.push(frontierLine);
  if (state.improvementTriage) {
    const { pending, considered, lowerBound, top } = state.improvementTriage;
    const population = lowerBound
      ? `at least ${pending} untriaged in ${considered}-row window`
      : `${pending} untriaged`;
    lines.push(`- improvement triage: ${population}; top ${top.id} [${top.lane}] — ${compactHeadline(top.title)}`);
  }
  if (state.held.length > 0) {
    const shown = state.held.slice(0, HELD_DISPLAY_CAP);
    const rest = state.held.length - shown.length;
    const held = shown.map((h) => (h.status ? `${h.id} (${h.status})` : h.id)).join(', ');
    lines.push(`- holding: ${held}${rest > 0 ? ` +${rest} more` : ''}`);
  } else {
    lines.push('- holding: nothing — claim before your first edit.');
  }
  if (state.announcedGates.length > 0) {
    lines.push(
      `- announced gates: ${compactIds(
        state.announcedGates.map((gate) => gate.event),
        GATE_DISPLAY_CAP,
      )}${state.announcedGates.length > GATE_DISPLAY_CAP ? ' — events:catalog for all' : ''}`,
    );
  }
  for (const item of state.held.slice(0, CHECKPOINT_DISPLAY_CAP)) {
    const line = renderCheckpointLine(item);
    if (line) lines.push(line);
  }
  for (const entry of state.inboxRecent.slice(0, INBOX_DISPLAY_CAP)) {
    lines.push(`- inbox ${compactActor(entry.from)}: ${compactHeadline(entry.summary)}`);
  }
  if (state.loopArmed) {
    lines.push(
      state.loopFireWithheld
        ? '- engine loop: ARMED — fire pending, withheld for interactive turn.'
        : '- engine loop: ARMED (a wake source exists).',
    );
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
  if (orientationUnchanged(committed, fingerprintOrientation(state, epoch, committed))) return '';

  const header = `## ${HEADING}`;
  const lines = renderOrientationLines(state, committed);
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

/**
 * Injectable IO seam (mirrors orient-capture-miss-hint.ts's deps pattern), so the
 * composition above stays unit-testable without PG and each source can be faulted
 * independently in a test.
 */
export interface OrientationDeps {
  held: (ownerId: string, workspaceId: string) => Promise<OrientationHeldItem[]>;
  inbox: (ownerId: string) => Promise<{
    count: number;
    newest: OrientationInboxEntry[];
    /** EI-20085805220385722: asks whose SENDER is positively ended. Optional so
     *  an older/stubbed seam still satisfies this contract (absent ⇒ 0). */
    staleCount?: number;
  }>;
  announcedGates: (ownerId: string) => Promise<OrientationAnnouncedGate[]>;
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
  const [
    held,
    inbox,
    announcedGates,
    openAsks,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
    executableFrontier,
    neverDropFacts,
    toolSurface,
    carryBlindWindow,
  ] = await Promise.all([
    d.held(ownerId, workspaceId).catch(() => [] as OrientationHeldItem[]),
    d.inbox(ownerId).catch(() => ({ count: 0, newest: [] as OrientationInboxEntry[] })),
    d.announcedGates(ownerId).catch(() => [] as OrientationAnnouncedGate[]),
    // Fail-soft to null, same rule as toolSurface below: "cannot tell" must
    // render as silence, never as a false "nothing outstanding".
    d.openAsks(ownerId).catch(() => null as OrientationOpenAsk | null),
    d.loopArmed(ownerId).catch(() => false),
    d.loopFireWithheld(ownerId).catch(() => false),
    d.improvementTriage(workspaceId).catch(() => null),
    d.executableFrontier(ownerId, workspaceId).catch(() => null),
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
    unansweredDirected: inbox.count,
    inboxRecent: inbox.newest,
    announcedGates,
    openAsks,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
    executableFrontier,
    neverDropFacts,
    toolSurface,
    carryBlindWindow,
  };
}

/** Default readers — each one is an EXISTING shared primitive, never a new query.
 *  Dynamic imports keep them off the module graph until a turn actually needs them. */
export function defaultOrientationDeps(): OrientationDeps {
  return {
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
            newest: summary.newest.map((entry) => ({
              msgId: entry.msgId,
              from: entry.from,
              ...(entry.summary ? { summary: entry.summary } : {}),
            })),
          }
        : { count: 0, newest: [] };
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
    announcedGates: async (ownerId) => {
      const [{ listActiveAnnouncements }, { announcementVisibleTo }, { getSessionBrief }, { fetchPresenceFleet }] =
        await Promise.all([
          import('./events/await/store'),
          import('./events/await/announce-key'),
          import('./session-brief'),
          import('./agent-tools/coordination/presence-fleet'),
        ]);
      const [announcements, brief, memberships] = await Promise.all([
        listActiveAnnouncements({ unfiredOnly: true, limit: 50 }),
        getSessionBrief({ ownerId }),
        fetchPresenceFleet([ownerId]),
      ]);
      const fleet = memberships.get(ownerId)?.fleetSlug ?? null;
      return announcements
        .filter((announcement) =>
          announcementVisibleTo(announcement, {
            fleetSlug: fleet,
            planSlug: brief?.currentPlanSlug ?? null,
            harnessSlug: brief?.harnessSlug ?? null,
          }),
        )
        .map((announcement) => ({
          event: announcement.eventKey,
          note: announcement.note,
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
        fingerprintOrientation(state, epoch, ack?.committed ?? null),
      ).catch(() => {});
    }
    return block;
  } catch {
    // Fail-soft by contract — the endpoint must never surface an error into a turn.
    return '';
  }
}
