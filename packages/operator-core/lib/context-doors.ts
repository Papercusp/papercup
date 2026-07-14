/**
 * Per-hop context doors (deterministic-context-carry P-006, ornith-overflow brief).
 *
 * A "hop" = ONE provider round-trip: one model response plus the tool results appended
 * before the next provider request (NOT the user-visible agent turn). The harness bounds
 * what a single hop can add to context — `maxTurn` — so the compaction thresholds
 * (P-007: soft = window − (2×maxTurn + overhead), hard = window − maxTurn) hold by
 * CONSTRUCTION, never by observation of past turns (owner-rejected feedback loops, D-001).
 *
 * DECIDED formula [owner:Avi 2026-07-14, plan D-007]:
 *   maxTurn = min(15K, max(8K, effectiveWindow / 26))
 * Knees: the 8K floor binds below ~208K windows (Ornith 204.8K → 8K); the 15K cap binds
 * above ~390K; /26 scales in between. `maxTurn` is the SUM of the per-door caps, and when
 * the formula lands below (or above) the base door-sum the doors scale proportionally
 * inside it — default split at the 8K floor: output 4K / tool results 2×1.5K /
 * injections 1K.
 *
 * Enforcement legs (who consumes which door):
 *   output     → the `max_tokens` request param (psu-launcher rewrites the per-session
 *                model registry; MIRRORED in psu-launcher.mjs — it cannot import TS,
 *                same lockstep rule as OMP_LOCAL_MODEL_PREFIXES);
 *   resultEach → per-tool-result cap with spill-to-disk behind a pointer;
 *   injections → the wake/coord injection path's per-delivery cap, same spill contract.
 *
 * These constants become adjustable DEFAULTS via the P-023 config surface — keep every
 * knob here, exported, so that item wires one module.
 */

/** The output-door floor sum: below ~208K windows every model gets exactly this hop budget. */
export const MAX_TURN_FLOOR_TOKENS = 8_000;
/** Cap: above ~390K windows the hop budget stops growing (context is rent — a bigger
 *  window is headroom for the SESSION, not licence for bigger hops). */
export const MAX_TURN_CAP_TOKENS = 15_000;
/** Window divisor between the knees; /26 deliberately lands virtually every fleet model
 *  AT the 8K floor (the value measured essentially free: 2/4048 length-stops). */
export const MAX_TURN_WINDOW_DIVISOR = 26;

/** Door proportions of maxTurn — the default split at the 8K floor (output 4K / results
 *  2×1.5K / injections 1K). output + resultSlots×resultEach + injections === 1. */
export const DOOR_SPLIT = Object.freeze({
  output: 0.5,
  resultEach: 0.1875,
  resultSlots: 2,
  injections: 0.125,
});

/** maxTurn for an effective window (tokens): min(cap, max(floor, window/divisor)). */
export function computeMaxTurn(effectiveWindow: number): number {
  const w = Number(effectiveWindow);
  if (!Number.isFinite(w) || w <= 0) return MAX_TURN_FLOOR_TOKENS;
  return Math.min(MAX_TURN_CAP_TOKENS, Math.max(MAX_TURN_FLOOR_TOKENS, Math.floor(w / MAX_TURN_WINDOW_DIVISOR)));
}

export interface TurnDoors {
  /** The per-hop ingestion budget the doors sum to. */
  maxTurn: number;
  /** Model output cap → the `max_tokens` request param. */
  output: number;
  /** Per-tool-result cap (spill-to-disk beyond it). */
  resultEach: number;
  /** Concurrent tool-result slots the split budgets for. */
  resultSlots: number;
  /** System/coord injection cap per delivery (spill-to-disk beyond it). */
  injections: number;
}

/** The per-door caps for an effective window: the DOOR_SPLIT proportions applied to
 *  computeMaxTurn. Doors scale inside maxTurn in BOTH directions (D-007 amendment (a) —
 *  at the 8K floor this is exactly the default 4K/1.5K×2/1K split). */
export function computeTurnDoors(effectiveWindow: number): TurnDoors {
  const maxTurn = computeMaxTurn(effectiveWindow);
  return {
    maxTurn,
    output: Math.floor(maxTurn * DOOR_SPLIT.output),
    resultEach: Math.floor(maxTurn * DOOR_SPLIT.resultEach),
    resultSlots: DOOR_SPLIT.resultSlots,
    injections: Math.floor(maxTurn * DOOR_SPLIT.injections),
  };
}
