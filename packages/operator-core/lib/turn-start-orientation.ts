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

/** A held work-item, reduced to what the fold actually prints. */
export interface OrientationHeldItem {
  id: string;
  status?: string | null;
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
  /** Whether an engine loop is armed — i.e. whether a wake source exists. */
  loopArmed: boolean;
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

/** True when there is genuinely nothing worth spending a single character on. */
export function isEmptyOrientation(state: OrientationState): boolean {
  return state.held.length === 0 && state.unansweredDirected === 0 && !state.loopArmed;
}

/**
 * PURE: the compact fingerprint this turn's orientation is diffed against.
 *
 * Held items carry their STATUS, not just their id, so a work-item moving
 * wip→blocked re-emits the block. Keep this small — it is stored per agent per
 * turn, and its only job is to answer "same as last time?".
 */
export function fingerprintOrientation(state: OrientationState): CursorState {
  return {
    held: state.held
      .map((h) => `${h.id}:${h.status ?? ''}`)
      .sort()
      .join(','),
    unanswered: state.unansweredDirected,
    loop: state.loopArmed ? 1 : 0,
  };
}

/** PURE: is `committed` the same orientation this fingerprint describes? */
export function orientationUnchanged(
  committed: CursorState | null,
  next: CursorState,
): boolean {
  if (!committed || typeof committed !== 'object') return false;
  const a = committed as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  return a.held === b.held && a.unanswered === b.unanswered && a.loop === b.loop;
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
    lines.push(
      `- ⚠ ${state.unansweredDirected} directed msg(s) awaiting YOUR reply — answer first.`,
    );
  }
  if (state.held.length > 0) {
    const shown = state.held.slice(0, HELD_DISPLAY_CAP);
    const rest = state.held.length - shown.length;
    const held = shown
      .map((h) => (h.status ? `${h.id} (${h.status})` : h.id))
      .join(', ');
    lines.push(`- holding: ${held}${rest > 0 ? ` +${rest} more` : ''}`);
  } else {
    lines.push('- holding: nothing — claim before your first edit.');
  }
  lines.push(
    state.loopArmed
      ? '- engine loop: ARMED (a wake source exists).'
      : '- engine loop: not armed — if your directive is open-ended, loop:arm or you halt silently when this turn ends.',
  );
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
  budgetChars?: number;
}): string {
  const { state, committed } = input;
  const budget = input.budgetChars ?? ORIENTATION_BUDGET_CHARS;
  if (isEmptyOrientation(state)) return '';
  if (orientationUnchanged(committed, fingerprintOrientation(state))) return '';

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
  unansweredDirected: (ownerId: string) => Promise<number>;
  loopArmed: (ownerId: string) => Promise<boolean>;
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
  const [held, unansweredDirected, loopArmed] = await Promise.all([
    d.held(ownerId, workspaceId).catch(() => [] as OrientationHeldItem[]),
    d.unansweredDirected(ownerId).catch(() => 0),
    d.loopArmed(ownerId).catch(() => false),
  ]);
  return { held, unansweredDirected, loopArmed };
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
      const { readHeldWorkItems } = await import('./carry-brief');
      const rows = await readHeldWorkItems(ownerId, workspaceId);
      return rows.map((r) => ({ id: r.id })).filter((r) => Boolean(r.id));
    },
    // The SAME primitive fleet:assignments / leader-brief count with, so this
    // number can never disagree with the one a leader sees.
    unansweredDirected: async (ownerId) => {
      const { fetchUnansweredDirected } = await import(
        './agent-tools/coordination/unanswered-directed'
      );
      const map = await fetchUnansweredDirected([ownerId]);
      return map.get(ownerId)?.count ?? 0;
    },
    loopArmed: async (ownerId) => {
      const { activeLoopOwners } = await import('./adv-roster');
      return (await activeLoopOwners()).has(ownerId);
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
    const [{ ackAndRead, stage }, state] = await Promise.all([
      import('./agent-tools/coordination/read-cursors'),
      resolveOrientationState(ownerId, workspaceId, input.deps ?? {}),
    ]);
    if (isEmptyOrientation(state)) return '';
    const ack = await ackAndRead(ownerId, ORIENTATION_CURSOR_SURFACE).catch(() => null);
    const block = composeOrientationBlock({
      state,
      // A failed cursor read ⇒ treat as baseline and DELIVER. Fail-open: a delta
      // must never make orientation worse than no delta.
      committed: ack?.committed ?? null,
      ...(input.budgetChars === undefined ? {} : { budgetChars: input.budgetChars }),
    });
    if (block) {
      await stage(ownerId, ORIENTATION_CURSOR_SURFACE, fingerprintOrientation(state)).catch(
        () => {},
      );
    }
    return block;
  } catch {
    // Fail-soft by contract — the endpoint must never surface an error into a turn.
    return '';
  }
}
