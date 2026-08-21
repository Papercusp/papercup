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
      .map((h) => `${h.id}:${h.status ?? ''}`)
      .sort()
      .join(','),
    unanswered: state.unansweredDirected,
    loop: state.loopArmed ? 1 : 0,
    epoch,
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
  return (
    a.held === b.held &&
    a.unanswered === b.unanswered &&
    a.loop === b.loop &&
    a.epoch === b.epoch
  );
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
  unansweredDirected: (ownerId: string) => Promise<number>;
  loopArmed: (ownerId: string) => Promise<boolean>;
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
      await stage(ownerId, ORIENTATION_CURSOR_SURFACE, fingerprintOrientation(state, epoch)).catch(
        () => {},
      );
    }
    return block;
  } catch {
    // Fail-soft by contract — the endpoint must never surface an error into a turn.
    return '';
  }
}
