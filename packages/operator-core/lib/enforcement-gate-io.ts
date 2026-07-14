/**
 * enforcement-gate-io — the IO wiring for the P-016 flush-enforcement gate
 * (pure ladder: ./enforcement-gate.ts; seams: session:request-compaction,
 * coord:handoff).
 *
 * Contract, in one sentence: the gate can only ever ADD a bounded, single-bounce
 * refusal — it is bounded (FLUSH_GATE_BUDGET_MS), fail-OPEN (any error ⇒ `clear`),
 * env-disable-able (PAPERCUSP_FLUSH_GATE=off), and its `mechanical-fallback` verdict
 * always PROCEEDS after writing state. No path permanently blocks a compaction or a
 * handoff, so it cannot reintroduce the strand session:request-compaction's
 * warn-only design was avoiding.
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  decideFlushGate,
  detectFlushTripwires,
  renderFlushRefusal,
  type FlushGateVerdict,
  type FlushTripwire,
  type GateBoundary,
} from './enforcement-gate';
import type { CarryBrief } from './carry-brief';

/** Total budget for the whole gate (detect + fallback writes) — advisory work
 *  riding a seam that must not slow down or fail because of it. */
export const FLUSH_GATE_BUDGET_MS = 4_000;

/** How long an owner's per-boundary refusal marker stands. A retry within this
 *  window that STILL has tripwires is "the agent still won't flush" ⇒ mechanical
 *  fallback. Long enough to span a loop wake (60s) and an agent's own re-read;
 *  short enough that a much-later, unrelated boundary starts fresh at `refuse`. */
export const REFUSAL_MARKER_TTL_MS = 10 * 60_000;

/** Is the gate enabled? Default ON; PAPERCUSP_FLUSH_GATE in {off,0,false,no}
 *  disables it (operational reversibility without a redeploy). */
export function flushGateEnabled(): boolean {
  const v = (process.env.PAPERCUSP_FLUSH_GATE ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

// ── The in-process refusal marker ────────────────────────────────────────────
// Per (boundary, ownerId). In-memory by design: a process restart that forgets a
// marker costs at most one extra refusal (the agent flushes or retries), never a
// strand — so a durable store would be strictly more machinery for no safety gain.

const refusals = new Map<string, number>();

function markerKey(boundary: GateBoundary, ownerId: string): string {
  return `${boundary}:${ownerId}`;
}

/** True if this owner was refused at this boundary within the TTL. */
export function wasRecentlyRefused(boundary: GateBoundary, ownerId: string, nowMs: number = Date.now()): boolean {
  const at = refusals.get(markerKey(boundary, ownerId));
  return typeof at === 'number' && nowMs - at <= REFUSAL_MARKER_TTL_MS;
}

/** Record a refusal (opportunistically evicts expired markers so the map can't grow). */
export function markRefused(boundary: GateBoundary, ownerId: string, nowMs: number = Date.now()): void {
  for (const [k, at] of refusals) if (nowMs - at > REFUSAL_MARKER_TTL_MS) refusals.delete(k);
  refusals.set(markerKey(boundary, ownerId), nowMs);
}

/** Clear an owner's marker at a boundary (called once the fallback has fired, so
 *  the NEXT boundary for this owner starts fresh at `refuse`). */
export function clearRefused(boundary: GateBoundary, ownerId: string): void {
  refusals.delete(markerKey(boundary, ownerId));
}

/** For tests: drop all markers. */
export function __resetRefusalMarkers(): void {
  refusals.clear();
}

// ── The mechanical fallback writer ───────────────────────────────────────────

export interface FlushFallbackResult {
  /** Held work-item ids the system checkpointed (P-015 autoCheckpointStaleHeldItems). */
  checkpointedItems: string[];
  /** The armed loop's harness if the system wrote a mechanical carry-note for it. */
  loopCarryNoteWritten?: string;
}

/**
 * Write the mechanical fallback the P-016 ladder's `mechanical-fallback` verdict
 * calls for: for held-item tripwires, reuse the P-015 mechanical auto-checkpoint
 * (journal note + tool-log tail, agent prose preserved); for the armed-loop
 * tripwire, write a mechanical loop carry-note so a cold wake isn't blind. Bounded
 * + fail-soft per leg; returns what was actually written.
 */
export async function writeFlushFallback(input: {
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote: string | null;
  tripwires: ReadonlyArray<FlushTripwire>;
  brief: CarryBrief | null;
  nowMs?: number;
}): Promise<FlushFallbackResult> {
  const nowMs = input.nowMs ?? Date.now();
  const result: FlushFallbackResult = { checkpointedItems: [] };

  const hasHeldTripwire = input.tripwires.some(
    (t) => t.kind === 'missing-checkpoint' || t.kind === 'stale-checkpoint',
  );
  if (hasHeldTripwire) {
    try {
      const { autoCheckpointStaleHeldItems } = await import('./turn-end-tracking-io');
      const written = await autoCheckpointStaleHeldItems({
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sinceIso: input.sinceIso,
        journalNote: input.journalNote,
        nowMs,
      });
      result.checkpointedItems = written.map((w) => w.id);
    } catch {
      /* fail-soft: the loop fallback + the refusal already gave the agent a chance */
    }
  }

  const loopTripwire = input.tripwires.find((t) => t.kind === 'armed-loop-no-carry-note');
  if (loopTripwire && input.brief?.loop) {
    try {
      const { setLoopCarryNote } = await import('./carry-note');
      const atIso = new Date(nowMs).toISOString();
      const note = input.journalNote?.trim()
        ? `## Next action\n${input.journalNote.trim()}`
        : '## Next action\nResume the armed loop; reconstruct working state via coord:orient { afterCompaction: true }.';
      await setLoopCarryNote(
        { harness: input.brief.loop.harness, ownerId: input.ownerId },
        `⟦auto-checkpoint mechanical @${atIso}⟧ — the system wrote this because the loop was armed with no carry-note at a ${input.tripwires.length > 0 ? 'flush' : ''} boundary; replace it with a real loop:checkpoint.\n\n${note}`,
      );
      result.loopCarryNoteWritten = input.brief.loop.harness;
    } catch {
      /* fail-soft */
    }
  }
  return result;
}

// ── The gate entrypoint ──────────────────────────────────────────────────────

export interface FlushGateOutcome {
  verdict: FlushGateVerdict;
  tripwires: FlushTripwire[];
  /** Present on `refuse` — the actionable flush instruction. */
  refusalText?: string;
  /** Present on `mechanical-fallback` — what the system wrote. */
  fallback?: FlushFallbackResult;
}

/**
 * Run the flush gate at a boundary. Loads the caller's carry brief if one isn't
 * supplied, detects tripwires, and applies the {@link decideFlushGate} ladder:
 *   - clear  → proceed (also when the gate is env-disabled or errors — fail-open);
 *   - refuse → the caller must NOT perform the operation; marks the refusal marker;
 *   - mechanical-fallback → writes durable state, clears the marker, caller proceeds.
 * Never throws; fail-open to `clear` on any error.
 */
export async function runFlushGate(input: {
  boundary: GateBoundary;
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote?: string | null;
  brief?: CarryBrief | null;
  nowMs?: number;
}): Promise<FlushGateOutcome> {
  const clear: FlushGateOutcome = { verdict: 'clear', tripwires: [] };
  if (!flushGateEnabled()) return clear;
  const { value } = await withBoundedTimeout(runFlushGateInner(input), {
    fallback: clear,
    timeoutMs: FLUSH_GATE_BUDGET_MS,
    label: `flush-gate:${input.boundary}`,
  });
  return value;
}

async function runFlushGateInner(input: {
  boundary: GateBoundary;
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote?: string | null;
  brief?: CarryBrief | null;
  nowMs?: number;
}): Promise<FlushGateOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  // Only FETCH when the caller didn't provide a brief at all (undefined). An
  // explicit `null` means the caller already tried and the read failed (e.g. the
  // compaction seam's loadCarryBrief) — don't re-pay a failing round-trip.
  let brief: CarryBrief | null;
  if (input.brief === undefined) {
    try {
      const { buildCarryBrief } = await import('./carry-brief');
      brief = await buildCarryBrief(input.ownerId, { workspaceId: input.workspaceId });
    } catch {
      brief = null;
    }
  } else {
    brief = input.brief;
  }
  const tripwires = detectFlushTripwires(brief, nowMs);
  const alreadyRefused = wasRecentlyRefused(input.boundary, input.ownerId, nowMs);
  const verdict = decideFlushGate({ tripwires, alreadyRefused });

  if (verdict === 'clear') {
    // A clean boundary retires any stale marker so the next real one starts fresh.
    if (alreadyRefused) clearRefused(input.boundary, input.ownerId);
    return { verdict, tripwires };
  }
  if (verdict === 'refuse') {
    markRefused(input.boundary, input.ownerId, nowMs);
    return { verdict, tripwires, refusalText: renderFlushRefusal(input.boundary, tripwires) };
  }
  // mechanical-fallback: write durable state, then let the caller proceed.
  const fallback = await writeFlushFallback({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sinceIso: input.sinceIso,
    journalNote: input.journalNote ?? null,
    tripwires,
    brief,
    nowMs,
  });
  clearRefused(input.boundary, input.ownerId);
  return { verdict, tripwires, fallback };
}
