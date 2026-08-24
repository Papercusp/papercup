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
import { capPreservingOperativeDetailed } from './operative-clause';

/** A held work-item, reduced to what the fold actually prints. */
export interface OrientationHeldItem {
  id: string;
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
export interface OrientationState {
  /** Non-terminal work-items assigned to this agent. */
  held: OrientationHeldItem[];
  /** Directed messages awaiting THIS agent's reply. */
  unansweredDirected: number;
  /** Newest actionable inbox headlines; count remains `unansweredDirected`. */
  inboxRecent: OrientationInboxEntry[];
  /** Declared-but-unfired gates visible to the caller's fleet/plan/harness. */
  announcedGates: OrientationAnnouncedGate[];
  /** Whether an engine loop is armed — i.e. whether a wake source exists. */
  loopArmed: boolean;
  /** Whether the armed loop's most recent fire was withheld before delivery. */
  loopFireWithheld: boolean;
  /** Ranked, still-untriaged improvement signal; null means none or unreadable. */
  improvementTriage: OrientationImprovementTriage | null;
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
const IMPROVEMENT_TRIAGE_WINDOW_LIMIT = 100;

/** True when there is genuinely nothing worth spending a single character on. */
export function isEmptyOrientation(state: OrientationState): boolean {
  return (
    state.held.length === 0 &&
    state.unansweredDirected === 0 &&
    state.inboxRecent.length === 0 &&
    state.announcedGates.length === 0 &&
    !state.loopArmed &&
    !state.loopFireWithheld &&
    state.improvementTriage === null
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
export function fingerprintOrientation(state: OrientationState, epoch: number): CursorState {
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
    a.inbox === b.inbox &&
    a.gates === b.gates &&
    a.loop === b.loop &&
    a.loopWithheld === b.loopWithheld &&
    a.triage === b.triage &&
    a.epoch === b.epoch
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

function compactHeadline(summary: string | undefined): string {
  const text = (summary ?? '(no summary)').replace(/\s+/g, ' ').trim();
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`;
}

function renderCheckpointLine(item: OrientationHeldItem): string | null {
  const raw = item.checkpoint?.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const excerpt = capPreservingOperativeDetailed(raw, CHECKPOINT_EXCERPT_CHARS, {
    inlineNotice: true,
    more: `work_items:get { id: '${item.id}' }`,
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
export function renderOrientationLines(state: OrientationState): string[] {
  const lines: string[] = [];
  if (state.unansweredDirected > 0) {
    lines.push(`- ⚠ ${state.unansweredDirected} directed msg(s) awaiting YOUR reply — answer first.`);
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
  if (state.improvementTriage) {
    const { pending, considered, lowerBound, top } = state.improvementTriage;
    const population = lowerBound
      ? `at least ${pending} untriaged in ${considered}-row window`
      : `${pending} untriaged`;
    lines.push(
      `- improvement triage: ${population}; top ${top.id} [${top.lane}] — ${compactHeadline(top.title)}`,
    );
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
  if (orientationUnchanged(committed, fingerprintOrientation(state, epoch))) return '';

  const header = `## ${HEADING}`;
  const lines = renderOrientationLines(state);
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
  }>;
  announcedGates: (ownerId: string) => Promise<OrientationAnnouncedGate[]>;
  loopArmed: (ownerId: string) => Promise<boolean>;
  loopFireWithheld: (ownerId: string) => Promise<boolean>;
  /** Existing improvement triage/ranking path, reduced to one bounded row. */
  improvementTriage: (workspaceId: string) => Promise<OrientationImprovementTriage | null>;
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
  const [held, inbox, announcedGates, loopArmed, loopFireWithheld, improvementTriage] = await Promise.all([
    d.held(ownerId, workspaceId).catch(() => [] as OrientationHeldItem[]),
    d.inbox(ownerId).catch(() => ({ count: 0, newest: [] as OrientationInboxEntry[] })),
    d.announcedGates(ownerId).catch(() => [] as OrientationAnnouncedGate[]),
    d.loopArmed(ownerId).catch(() => false),
    d.loopFireWithheld(ownerId).catch(() => false),
    d.improvementTriage(workspaceId).catch(() => null),
  ]);
  return {
    held,
    unansweredDirected: inbox.count,
    inboxRecent: inbox.newest,
    announcedGates,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
  };
}

/** Default readers — each one is an EXISTING shared primitive, never a new query.
 *  Dynamic imports keep them off the module graph until a turn actually needs them. */
export function defaultOrientationDeps(): OrientationDeps {
  return {
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
      await stage(ownerId, ORIENTATION_CURSOR_SURFACE, fingerprintOrientation(state, epoch)).catch(() => {});
    }
    return block;
  } catch {
    // Fail-soft by contract — the endpoint must never surface an error into a turn.
    return '';
  }
}
