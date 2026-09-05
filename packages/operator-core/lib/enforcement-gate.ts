/**
 * enforcement-gate — the flush-integrity ENFORCEMENT tier over the P-012..P-015
 * tracking surfaces (deterministic-context-carry-2026-07-14 P-016, Phase 5 close).
 *
 * P-003 (staleCheckpointWarnings, in session:request-compaction) DETECTS unflushed
 * state at a compaction boundary but only WARNS — a deliberate choice, because a
 * hard-refuse on the very tool an agent calls BECAUSE it is at its context limit
 * would strand it there on any gate bug (a worse failure than the one it catches).
 *
 * P-016 adds teeth WITHOUT reintroducing that strand: the boundary REFUSES once,
 * naming exactly what to flush; if the agent still won't flush and retries, the
 * system writes a MECHANICAL fallback checkpoint ITSELF and lets the operation
 * proceed. The ladder is therefore bounded — the worst case for any gate bug is
 * ONE bounced call, after which the operation always proceeds with system-written
 * durable state. The wiring layer (enforcement-gate-io.ts) additionally runs the
 * whole gate fail-OPEN, so an evaluation error degrades to `clear`, never a block.
 *
 * This module is PURE (brief → tripwires → verdict → refusal text); the IO layer
 * owns the brief read, the refusal-marker state, and the fallback writes.
 *
 * The three tripwires named in the P-016 item map here as:
 *   - "stale checkpoint after N hops"     → 'stale-checkpoint' / 'missing-checkpoint'
 *       There is no per-hop counter at these seams and D-001 forbids deriving one
 *       from history/telemetry, so "N hops" is realized as elapsed wall-time
 *       ({@link STALE_CHECKPOINT_WARN_MS}, ~several wakes / a task step) — the same
 *       signal P-003 already uses. 'missing-checkpoint' is the never-written case.
 *   - "unflushed state past soft threshold" → the BOUNDARY itself. A compaction seam
 *       fires at/near the soft threshold by construction (the agent calls it because
 *       it is near its limit); a handoff is the analogous hand-off boundary. So the
 *       "past soft threshold" condition is satisfied by BEING at the seam — the
 *       missing/stale tripwires above ARE the unflushed state at that threshold. No
 *       token gauge is read here (D-001).
 *   - "armed COLD loop without loop:checkpoint" → 'armed-loop-no-carry-note'.
 */
import type { CarryBrief } from './carry-brief';
import { parseCarryNote } from './carry-note';

/** A held item's checkpoint older than this at a boundary is STALE — the turns
 *  since it was written will NOT carry across the boundary. 15 min ≈ several
 *  monitor wakes / a full task step; younger than that, the checkpoint plausibly
 *  still covers the current unit. (Formerly owned by session:request-compaction;
 *  this is now the single source, re-exported there for its existing warn path.) */
export const STALE_CHECKPOINT_WARN_MS = 15 * 60_000;

/**
 * A held work-item flagged by the flush-integrity check (P-003 shape, kept
 * byte-compatible so session:request-compaction's warn path re-exports it):
 *   - 'missing' — NO checkpoint at all (highest-risk genuine state loss);
 *   - 'stale'   — written, but long enough ago that the turns since will not carry.
 */
export interface CheckpointFlushWarning {
  id: string;
  title: string | null;
  reason: 'missing' | 'stale';
  /** Minutes since the checkpoint was written — only on reason:'stale'. */
  ageMinutes?: number;
}

/**
 * Best-effort flush-integrity scan over a carry brief's held work-items (P-003).
 * Pure; an absent brief yields an empty list. This is the detector both the WARN
 * path (request-compaction) and the ENFORCEMENT gate (below) share.
 */
export function staleCheckpointWarnings(
  brief: CarryBrief | null,
  nowMs: number = Date.now(),
): CheckpointFlushWarning[] {
  if (!brief) return [];
  const out: CheckpointFlushWarning[] = [];
  for (const h of brief.heldItems) {
    if (h.checkpoint === null) {
      out.push({ id: h.id, title: h.title, reason: 'missing' });
    } else if (
      typeof h.checkpointUpdatedAtMs === 'number' &&
      nowMs - h.checkpointUpdatedAtMs > STALE_CHECKPOINT_WARN_MS
    ) {
      out.push({
        id: h.id,
        title: h.title,
        reason: 'stale',
        ageMinutes: Math.round((nowMs - h.checkpointUpdatedAtMs) / 60_000),
      });
    }
  }
  return out;
}

/** The boundaries the gate protects. Both are stale-snapshot cut-overs: compaction
 *  drops unparked context; a handoff hands the receiver whatever the offerer flushed. */
export type GateBoundary = 'compaction' | 'handoff';

/** The enforcement tripwire kinds (the three P-016 detectors, split by cause). */
export type FlushTripwireKind =
  | 'missing-checkpoint'
  | 'stale-checkpoint'
  | 'armed-loop-no-carry-note'
  | 'cold-successor-no-progress';

export interface FlushTripwire {
  kind: FlushTripwireKind;
  /** The subject: a held work-item id, or the loop's harness for the armed-loop case. */
  subject: string;
  /** Human-facing one-liner for the refusal text. */
  detail: string;
  /** Minutes since the last write — only on 'stale-checkpoint'. */
  ageMinutes?: number;
}

/**
 * The flush tripwires present at a boundary: missing/stale held-item checkpoints
 * (via {@link staleCheckpointWarnings}) plus an armed COLD loop carrying no
 * loop:checkpoint note. Warm loops carry their transcript and are not flagged.
 * Pure; empty when the brief is clean or unavailable.
 */
export function detectFlushTripwires(
  brief: CarryBrief | null,
  nowMs: number = Date.now(),
  /**
   * EI-21874665446367942: caller-resolved evidence (countAgentToolCallsInWindow)
   * of how many real agent tool calls this owner made since its armed COLD
   * loop's carry-note was last written. Only relevant to the
   * 'cold-successor-no-progress' tripwire below. undefined/null means
   * "evidence unavailable" and MUST NOT be read as zero — same fail-open
   * discipline as every other best-effort signal on this boundary; a query
   * failure must never manufacture a spurious refusal.
   */
  agentToolCallsSinceNote?: number | null,
): FlushTripwire[] {
  if (!brief) return [];
  const out: FlushTripwire[] = [];
  for (const w of staleCheckpointWarnings(brief, nowMs)) {
    if (w.reason === 'missing') {
      out.push({
        kind: 'missing-checkpoint',
        subject: w.id,
        detail: `${w.id} has NO checkpoint written — its in-flight state will not carry.`,
      });
    } else {
      out.push({
        kind: 'stale-checkpoint',
        subject: w.id,
        ageMinutes: w.ageMinutes,
        detail: `${w.id} has a STALE checkpoint (${w.ageMinutes}m old) — everything since it was written will not carry.`,
      });
    }
  }
  // Armed COLD loop with no carry-note: a cold wake reconstructs from the loop
  // carry-note; an active WARM loop intentionally carries its transcript and
  // does not require loop:checkpoint (the warm-loop contract). The mode comes
  // from the persisted LoopStatus carried into CarryBrief; an absent mode in
  // an injected/legacy brief fails open rather than inventing a requirement.
  if (brief.loop && brief.loop.active && brief.loop.carry === 'cold' && !(brief.loop.carryNote ?? '').trim()) {
    out.push({
      kind: 'armed-loop-no-carry-note',
      subject: brief.loop.harness,
      detail: `armed loop @${brief.loop.harness} has NO loop:checkpoint carry-note — a cold wake would start blind.`,
    });
  } else if (
    // EI-21874665446367942 (cold-carry recurrence guard): the note EXISTS (the
    // branch above is mutually exclusive) and already names a concrete next
    // action, but this life is CONFIRMED to have made zero real tool calls
    // since that note was written. Left unguarded, a cold successor can
    // re-derive context / re-verify instead of running the named action, hit
    // its soft compaction limit having tried nothing, and compact again —
    // repeating indefinitely with no progress (the su-6627a incident: three
    // consecutive checkpoints, each recording that no acceptance leg or
    // mutation ran before another compaction boundary). Strictly `=== 0`:
    // even ONE real tool call already satisfies "at least one scoped tool
    // call before compaction" and must not re-trip this. A live deliberate
    // await is the other safe state: the named next action is intentionally
    // conditional on that event, so zero post-note calls means PARKED, not
    // spinning. `CarryBrief.awaits` already excludes the infrastructure
    // inbox-wake keepalive; any remaining entry is an agent-owned event await.
    brief.loop &&
    brief.loop.active &&
    brief.loop.carry === 'cold' &&
    brief.awaits.length === 0 &&
    agentToolCallsSinceNote === 0
  ) {
    const next = parseCarryNote(brief.loop.carryNote ?? '').next?.trim();
    if (next) {
      out.push({
        kind: 'cold-successor-no-progress',
        subject: brief.loop.harness,
        detail:
          `your carry-note already names a next action ("${next.length > 140 ? `${next.slice(0, 139)}…` : next}") ` +
          'but you have made ZERO tool calls since it was written — run that action before compacting again ' +
          '(re-deriving/re-verifying context first is exactly the loop this tripwire exists to break).',
      });
    }
  }
  return out;
}

/** The gate's decision. `clear` = proceed; `refuse` = bounce once, naming the
 *  flush; `mechanical-fallback` = the agent already refused and still hasn't
 *  flushed, so the system writes the checkpoints itself and the caller proceeds. */
export type FlushGateVerdict = 'clear' | 'refuse' | 'mechanical-fallback';

/**
 * The pure ladder (P-016): no tripwires ⇒ clear; tripwires on a first encounter
 * ⇒ refuse; tripwires when the boundary was ALREADY refused for this owner and
 * they still weren't cleared ⇒ mechanical-fallback (write + proceed). Never a
 * permanent block — the second state is always terminal-and-proceeding.
 */
export function decideFlushGate(input: {
  tripwires: ReadonlyArray<FlushTripwire>;
  alreadyRefused: boolean;
}): FlushGateVerdict {
  if (input.tripwires.length === 0) return 'clear';
  return input.alreadyRefused ? 'mechanical-fallback' : 'refuse';
}

/** The actionable refusal text — names the exact flush command per tripwire, and
 *  states the escape (flush + retry, OR retry as-is and the system flushes for you).
 *  Written for the agent that reads the tool result, not a log. */
export function renderFlushRefusal(boundary: GateBoundary, tripwires: ReadonlyArray<FlushTripwire>): string {
  const noCheckpointIds = tripwires.filter((t) => t.kind === 'missing-checkpoint').map((t) => t.subject);
  const staleIds = tripwires
    .filter((t) => t.kind === 'stale-checkpoint')
    .map((t) => `${t.subject} (${t.ageMinutes}m old)`);
  const armedLoop = tripwires.find((t) => t.kind === 'armed-loop-no-carry-note');
  const coldNoProgress = tripwires.find((t) => t.kind === 'cold-successor-no-progress');
  const steps: string[] = [];
  if (noCheckpointIds.length > 0) {
    steps.push(
      `write a checkpoint for ${noCheckpointIds.join(', ')} — work_items:checkpoint { id, checkpoint } (no in-flight state survives without it)`,
    );
  }
  if (staleIds.length > 0) {
    // P-007/R-06: a STALE checkpoint has two honest remedies, and naming only the
    // expensive one is what produced the measured churn (48h to 2026-09-05: 261 of 347
    // compaction refusals provoked a flush, costing 339 checkpoint writes made solely
    // to clear this gate). If state genuinely moved, rewrite it; if it did not, attest
    // and keep your turn. The attestation is offered ONLY here, never for a MISSING
    // checkpoint below — there is nothing to attest to when nothing was ever written,
    // and offering it there would read as a way to skip the flush entirely.
    steps.push(
      `refresh the stale checkpoint(s) for ${staleIds.join(', ')} — work_items:checkpoint { id, checkpoint } ` +
        'if the state moved, or, if it genuinely has NOT, attest it instead of rewriting it: ' +
        'work_items:checkpoint { id, unchanged: true, contentHash } (the hash comes from work_items:get { id }; ' +
        'the attestation is bounded and refuses once the item itself has moved)',
    );
  }
  if (armedLoop) {
    steps.push(
      `write your loop carry-note — loop:checkpoint { did, left, insight, next } (your armed loop @${armedLoop.subject} has none, so a cold wake starts blind)`,
    );
  }
  if (coldNoProgress) {
    steps.push(coldNoProgress.detail);
  }
  const what = boundary === 'compaction' ? 'Compaction' : 'This handoff';
  return (
    `${what} is HELD: unflushed state would be lost across the boundary. Flush first, then retry:\n- ` +
    steps.join('\n- ') +
    `\nIf you retry WITHOUT flushing, the system will write a mechanical fallback checkpoint for you and proceed — but a checkpoint you write yourself carries far more than the mechanical one.`
  );
}
