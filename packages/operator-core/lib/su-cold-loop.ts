/**
 * su-cold-loop — the cold-auto wake DECISION (su-cold-auto-mode-2026-07-03
 * Phase 2; P-005 HYBRID cadence + P-006 carry-note precondition). PURE: the wake
 * executor calls this at its live-psu-host inject branch to decide whether a loop
 * wake goes COLD (a `reset`/`recycle` control verb — psu-pty-host.mjs P-004)
 * instead of the default WARM `turn`, and which cold verb. No DB / no spawn / no
 * flag store lives here — the caller resolves the flag + the carry-note and hands
 * them in, exactly like the bee fresh-context fork (wake-executor-fresh-context).
 *
 * WHY the su loop can go cold in-place while the bee can't: a bee is ALWAYS
 * process-exited between tasks (bee-fresh-context-delta D-021 ⇒ fresh-context ≡
 * cold spawn), so it has no warm process to reset. A su AUTO loop KEEPS its warm
 * session across wakes (loop:arm re-wakes the SAME session), so RESET-CONTEXT
 * (drop transcript, keep the process + MCP warm) is a real, cheaper-than-respawn
 * cold path — and RECYCLE is the periodic hard reset that sheds process cruft.
 *
 * SAFETY (D-006 / D-001 / D-005): cold fires ONLY when the loop was explicitly
 * armed `carry:'cold'` (opt-in), cold-auto is enabled at all (master gate), AND a
 * carry-note EXISTS to reconstruct from — otherwise WARM. Never drop a session's
 * context with no anchor to rebuild it from.
 */

/**
 * The cold-auto marker the loop fire stamps on a cold loop's wake-delivery
 * payload (mirrors the bee fresh-context marker: presence signals the mode).
 * Absent / carry!=='cold' ⇒ a warm loop (or not a loop) ⇒ never cold.
 */
export interface ColdLoopMarker {
  /** 'cold' selects the cold lifecycle; 'warm' / absent = today's warm inject. */
  carry?: string;
  /** Total fires so far on this loop (1-based) — drives the recycle-after-N
   *  cadence. Absent / 0 ⇒ treated as a plain RESET-CONTEXT (no recycle). */
  wakeCount?: number;
  /** The loop's harness — the carry-note scope key (loopScope(harness, ownerId)).
   *  Stamped by the loop fire so the wake executor can resolve getLoopCarryNote
   *  without a separate routine lookup. Absent ⇒ the caller cannot scope the
   *  carry-note ⇒ stays warm (fail-safe). */
  harness?: string;
}

export interface ColdLoopCaps {
  /** Force a hard RECYCLE every Nth cold wake (sheds process cruft); the other
   *  wakes are the cheap in-place RESET-CONTEXT. Ported from bee-transcript-cap's
   *  maxTasks recycle cadence (D-002 HYBRID). ≤0 ⇒ never recycle (reset-only). */
  recycleEveryNWakes: number;
}

/** Conservative default: reset each wake, a hard recycle every 8th — matching the
 *  bee transcript-cap DEFAULT (maxTasks: 8). Editable via the loop's config. */
export const DEFAULT_COLD_LOOP_CAPS: ColdLoopCaps = { recycleEveryNWakes: 8 };

/** Read the cold-loop marker off a wake-delivery payload. Returns null when the
 *  payload carries neither field (an ordinary warm wake). Pure. */
export function readColdLoopMarker(payload: unknown): ColdLoopMarker | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { carry?: unknown; wakeCount?: unknown; harness?: unknown };
  const carry = typeof p.carry === 'string' ? p.carry : undefined;
  const wakeCount =
    typeof p.wakeCount === 'number' && Number.isFinite(p.wakeCount) ? p.wakeCount : undefined;
  // The carry-note scope key (loopScope(harness, ownerId)) — the wake executor needs
  // it to resolve getLoopCarryNote without a separate routine lookup. A blank/missing
  // harness ⇒ undefined ⇒ decideColdWake's caller cannot scope the note ⇒ stays warm.
  const harness = typeof p.harness === 'string' && p.harness.length > 0 ? p.harness : undefined;
  if (carry === undefined && wakeCount === undefined && harness === undefined) return null;
  return { carry, wakeCount, harness };
}

export type ColdWakeDecision =
  | { cold: false; reason: string }
  | { cold: true; mode: 'reset' | 'recycle'; carryNote: string };

/**
 * The HYBRID cadence (D-002 / P-005): a hard RECYCLE every Nth cold wake to shed
 * process cruft (wedged MCP / slow leak), the cheap in-place RESET-CONTEXT the
 * rest. `wakeCount` is the 1-based fire number; the Nth, 2Nth… recycle. An
 * unknown/0 wakeCount, or a non-positive cap, ⇒ 'reset' (never a surprise hard
 * kill). Pure — exported for tests.
 */
export function coldWakeMode(
  wakeCount: number,
  caps: ColdLoopCaps = DEFAULT_COLD_LOOP_CAPS,
): 'reset' | 'recycle' {
  const n = caps.recycleEveryNWakes;
  if (!Number.isFinite(wakeCount) || wakeCount <= 0 || n <= 0) return 'reset';
  return wakeCount % n === 0 ? 'recycle' : 'reset';
}

/**
 * Decide the cold-auto disposition of a loop wake. COLD requires ALL of:
 *   (1) the loop was armed `carry:'cold'` (marker.carry === 'cold') — the opt-in
 *       (D-001 / P-003); a warm loop or a non-loop wake is never cold;
 *   (2) cold-auto is enabled at all (`coldEnabled` — the P-007 master gate the
 *       caller resolves; defence-in-depth over the per-loop opt-in);
 *   (3) a carry-note EXISTS to reconstruct from (P-006) — cold-start loses
 *       whatever the note fails to capture, so with NO anchor we MUST stay warm.
 * Otherwise WARM, with a reason (the caller injects the normal turn). When cold,
 * the cadence picks RECYCLE every Nth wake, else RESET-CONTEXT. Pure.
 */
export function decideColdWake(input: {
  payload: unknown;
  coldEnabled: boolean;
  carryNote: string | null;
  caps?: ColdLoopCaps;
}): ColdWakeDecision {
  const marker = readColdLoopMarker(input.payload);
  if (!marker || marker.carry !== 'cold') {
    return { cold: false, reason: 'warm loop (or not a cold loop wake)' };
  }
  if (!input.coldEnabled) {
    return { cold: false, reason: 'cold-auto disabled (master gate off)' };
  }
  const note = (input.carryNote ?? '').trim();
  if (!note) {
    return { cold: false, reason: 'no carry-note anchor — cannot safely cold-start (P-006)' };
  }
  const mode = coldWakeMode(marker.wakeCount ?? 0, input.caps ?? DEFAULT_COLD_LOOP_CAPS);
  return { cold: true, mode, carryNote: note };
}

/**
 * Render the text a COLD wake injects (P-002 producer half): the agent's carry-note
 * framed as its reconstructed working state, plus the STANDING re-checkpoint mandate.
 *
 * On a cold wake the injected `data` is the agent's ENTIRE opening context — the prior
 * transcript is gone. So the carry-note alone is not enough: the fresh agent must also
 * be told (a) that the note IS its continuity (continue from its "Next action"), and
 * (b) to refresh the note via `loop:checkpoint` before ending, or the NEXT cold wake
 * restarts from this same stale note. This closes the loop that keeps a cold loop's
 * anchor fresh across wakes. Pure — the wake executor calls it at the inject boundary.
 */
export function renderColdWakeInjection(carryNote: string): string {
  const note = (carryNote ?? '').trim();
  return [
    '❄️ COLD LOOP WAKE — your context was just reset to your carry-note. Your prior transcript is GONE;',
    'the note below IS your continuity — treat it as your working state and continue from its "Next action".',
    '',
    note,
    '',
    '────────',
    'Before you END this turn you MUST refresh this carry-note so the NEXT cold wake can continue —',
    'otherwise the next wake restarts from this same note:',
    '    loop:checkpoint { did, left, insight, next }   (compressed facts, not a transcript)',
    'The carry-note dies with your session — so also persist what must OUTLIVE it:',
    '  • holding a work-item? REFRESH work_items:checkpoint { id, checkpoint } — a successor/reclaimer INHERITS it',
    '    if you die (the carry-note does not); refresh it at least as often as this note.',
    '  • reached a durable conclusion (root cause, repro, decision, a bug worth filing)? You MUST facts:assert it.',
    '    ⚠ A work-item COMMENT does NOT count — it is never folded into orient, so the next wake and every peer stay',
    '    BLIND to it. A fact is the ONLY thing folded VERBATIM into every future orient — don\'t let a comment stand',
    '    in for it (that reflex is exactly how conclusions get lost across cold wakes).',
    'If the goal is DONE or you are blocked, call loop:end instead of leaving the loop spinning.',
  ].join('\n');
}
