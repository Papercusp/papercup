/**
 * turn-end-tracking-io — the IO wiring for the P-015 turn-end sweeps
 * (pure logic: ./turn-end-tracking.ts; seam: journal:record-turn).
 *
 * Every leg is bounded and fail-soft: the sweeps are advisory tracking, the
 * journal write they ride on is not allowed to slow down or fail because of
 * them (same contract as the carry-surface provenance stamp).
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  composeMechanicalCheckpoint,
  detectUnguardedHalt,
  isStaleHeldCheckpoint,
  mergeMechanicalCheckpoint,
  unregisteredArtifactTripwire,
  type UnguardedHaltTripwire,
  type UnregisteredArtifactTripwire,
} from './turn-end-tracking';

/** Total budget for each sweep — advisory work riding a fire-and-forget hook. */
export const TURN_END_SWEEP_BUDGET_MS = 4_000;

/** Held items auto-checkpointed per turn end (readHeldWorkItems' own cap is 6). */
const MAX_AUTO_CHECKPOINTS = 4;

/** Tool-log tail folded into a mechanical checkpoint. */
const AUTO_CHECKPOINT_LOG_LINES = 12;

export interface AutoCheckpointResult {
  id: string;
  /** 'written' | 'skipped-fresh' is never reported (only written ids return). */
  mechanical: true;
}

/**
 * Auto-checkpoint the caller's held work-items whose checkpoints are missing
 * or stale: compose a mechanical block from the turn's journal note + the
 * P-013 tool-call log tail, merge it under the agent-authored prose (replacing
 * only a previous mechanical block), and write it back. Returns the item ids
 * written. Never throws.
 */
export async function autoCheckpointStaleHeldItems(input: {
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote: string | null;
  nowMs?: number;
}): Promise<AutoCheckpointResult[]> {
  try {
    const [{ readHeldWorkItems }, { setWorkItemCheckpoint }, { toolCallRowsFor }, { renderToolCallLog }] =
      await Promise.all([
        import('./carry-brief'),
        import('./work-item-checkpoint'),
        import('./tool-call-log-store'),
        import('./tool-call-log'),
      ]);
    const nowMs = input.nowMs ?? Date.now();
    const held = await readHeldWorkItems(input.ownerId, input.workspaceId);
    const stale = held
      .filter((h) => isStaleHeldCheckpoint(h, nowMs))
      .slice(0, MAX_AUTO_CHECKPOINTS);
    if (stale.length === 0) return [];

    // One tool-log render for the turn window — shared across the stale items
    // (the snapshot is holder-session-level by design; the block says so).
    let toolLog = '';
    try {
      const rows = await toolCallRowsFor({ sessionId: input.sessionId, sinceIso: input.sinceIso, limit: 400 });
      toolLog = renderToolCallLog(rows, { maxLines: AUTO_CHECKPOINT_LOG_LINES });
    } catch {
      /* the block is still useful with the journal note alone */
    }
    const block = composeMechanicalCheckpoint({
      atIso: new Date(nowMs).toISOString(),
      journalNote: input.journalNote,
      toolLog,
      sessionId: input.sessionId,
    });

    const written: AutoCheckpointResult[] = [];
    for (const item of stale) {
      try {
        await setWorkItemCheckpoint(
          { harness: item.harness, workItemId: item.id, workspaceId: input.workspaceId },
          mergeMechanicalCheckpoint(item.checkpoint, block),
        );
        written.push({ id: item.id, mechanical: true });
      } catch {
        /* per-item fail-soft */
      }
    }
    return written;
  } catch {
    return [];
  }
}

/**
 * The unregistered-artifact sweep for one turn window: the turn's file-write
 * ledger vs the artifact registrations in the same window. Null on the clean
 * (overwhelmingly common) case. Never throws.
 */
export async function sweepUnregisteredArtifacts(
  sessionId: string,
  sinceIso: string,
): Promise<UnregisteredArtifactTripwire | null> {
  try {
    const { fileWritesSince, artifactRelPathsSince } = await import('./turn-journal-store');
    const writes = await fileWritesSince(sessionId, sinceIso);
    if (writes.length === 0) return null;
    const registered = await artifactRelPathsSince(sinceIso);
    return unregisteredArtifactTripwire(writes, registered);
  } catch {
    return null;
  }
}

/** Bounded wrappers — the record-turn handler calls these. */
export async function boundedArtifactSweep(
  sessionId: string,
  sinceIso: string,
): Promise<UnregisteredArtifactTripwire | null> {
  const { value } = await withBoundedTimeout(sweepUnregisteredArtifacts(sessionId, sinceIso), {
    fallback: null,
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-artifact-sweep',
  });
  return value;
}

export async function boundedAutoCheckpoint(
  input: Parameters<typeof autoCheckpointStaleHeldItems>[0],
): Promise<AutoCheckpointResult[]> {
  const { value } = await withBoundedTimeout(autoCheckpointStaleHeldItems(input), {
    fallback: [] as AutoCheckpointResult[],
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-auto-checkpoint',
  });
  return value;
}

/**
 * The re-wake-guarantee sweep for one turn end: does this owner have a
 * guaranteed re-wake, or is an autonomous session about to silently halt? Reads
 * the three signals the compaction-strategy triad turns on — active
 * mode(s), the engine loop, and this owner's REAL (non-inbox-wake) event-awaits
 * — and returns the {@link UnguardedHaltTripwire} when none guarantee a wake.
 * Null (the common case) when a re-wake is guaranteed. Never throws.
 *
 * The `coord:inbox-wake:` keepalive is excluded on purpose: every live agent
 * always holds one (INBOX_WAKE_KEY_PREFIX), so counting it would mean the sweep
 * NEVER fires. It is liveness, not a deliberate wake for this session's work.
 */
export async function sweepUnguardedHalt(input: {
  ownerId: string;
  workspaceId: string;
}): Promise<UnguardedHaltTripwire | null> {
  try {
    const [{ getModes }, { getLoopStatus }, { listActiveAwaits, INBOX_WAKE_KEY_PREFIX }] =
      await Promise.all([
        import('./modes/store'),
        import('./harness/routines/loop'),
        import('./events/await/store'),
      ]);
    const [modes, loop, awaits] = await Promise.all([
      getModes(input.workspaceId, input.ownerId).catch(() => []),
      getLoopStatus(input.ownerId).catch(() => null),
      listActiveAwaits(input.ownerId).catch(() => []),
    ]);
    const autonomousModeActive = modes.some((m) => m.mode === 'auto' || m.mode === 'drain');
    const activeAwaitCount = awaits.filter(
      (a) => !a.eventKey.startsWith(INBOX_WAKE_KEY_PREFIX),
    ).length;
    return detectUnguardedHalt({
      autonomousModeActive,
      loopActive: Boolean(loop?.active),
      activeAwaitCount,
    });
  } catch {
    return null;
  }
}

export async function boundedUnguardedHaltSweep(input: {
  ownerId: string;
  workspaceId: string;
}): Promise<UnguardedHaltTripwire | null> {
  const { value } = await withBoundedTimeout(sweepUnguardedHalt(input), {
    fallback: null,
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-unguarded-halt-sweep',
  });
  return value;
}
