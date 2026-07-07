/**
 * Post-compaction recovery fold for coord:orient
 * (compaction-context-loss-2026-07-05 P-002 / D-002).
 *
 * The first orient after a compaction re-delivers, structurally, what prose
 * summaries lose: (a) the caller's HELD work-items' checkpoints (the carry
 * notes a successor is normally re-injected with only on item pickup),
 * (b) the armed engine-loop status, and (c) the self-recall pointer — the
 * pre-compaction transcript survives on disk and is searchable via
 * sessions:search { session:'self' }. Resolving here ALSO force-tails the
 * caller's own transcript (ingestFileNow) so that pointer is FRESH the
 * moment it's handed out — client-neutral (claude/omp/codex), no hook
 * required.
 *
 * Handler-side IO (like ownerPresent/modes): composeOrient stays pure.
 * Every leg is best-effort — recovery must never break orientation.
 */

export interface CompactionRecovery {
  /** The one-line pointer back to the pre-compaction verbatim record. */
  selfRecall: string;
  /** The caller's live transcript, when resolvable (already force-tailed). */
  selfSession?: { sourceKind: string; sessionId: string } | null;
  /** Armed engine loop, if any — the loop's carry-note is re-injected on its own wake. */
  loop?: { active: boolean; intervalSec?: number | null } | null;
  /** Held (assigned, non-terminal) work-items + their checkpoints. `body` is the
   *  item's description (capped) so the post-compaction agent doesn't re-fetch it
   *  via work_items:get — measured at 43% of post-compaction orients
   *  (compaction-fold-audit-2026-07-06). */
  checkpoints?: Array<{ id: string; title?: string; body?: string; checkpoint: string | null }>;
}

const MAX_HELD_ITEMS = 6;
const CHECKPOINT_CAP = 1200;
/** Held-item body cap (fold #3) — enough of the description to resume without a
 *  work_items:get, small enough to stay compact across up to MAX_HELD_ITEMS. */
const BODY_CAP = 600;

export async function buildCompactionRecovery(
  ownerId: string,
  workspaceId: string,
): Promise<CompactionRecovery> {
  const recovery: CompactionRecovery = {
    selfRecall:
      "Your pre-compaction turns survive on disk and are INDEXED — recover any lost detail with " +
      "sessions:search { session:'self', mode:'verbatim', query:'<what you remember>' } " +
      "(or sessions:read { session:'self' } for the tail).",
  };

  // (c) self live-tail + pointer — freshness at the moment of hand-out.
  try {
    const { resolveSelfSession } = await import('../../search/self-session');
    const self = await resolveSelfSession(ownerId);
    if (self) {
      recovery.selfSession = { sourceKind: self.sourceKind, sessionId: self.sessionId };
      try {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath);
      } catch { /* the 2-min tick covers it */ }
    } else {
      recovery.selfSession = null;
    }
  } catch {
    recovery.selfSession = null;
  }

  // (b) armed engine loop.
  try {
    const { getLoopStatus } = await import('../../harness/routines/loop');
    const loop = (await getLoopStatus(ownerId)) as
      | { active?: boolean; rescheduleIntervalSec?: number; reschedule_interval_sec?: number }
      | null;
    recovery.loop = loop
      ? {
          active: Boolean(loop.active),
          intervalSec: loop.rescheduleIntervalSec ?? loop.reschedule_interval_sec ?? null,
        }
      : null;
  } catch {
    recovery.loop = null;
  }

  // (a) held work-items' checkpoints — normally re-injected only on pickup;
  // after a compaction the agent may not know it still HOLDS them. Shares the
  // carry-brief held-items read (compaction-continuity-hardening P-003) so this
  // fold and the compaction/cold-anchor briefs can never drift.
  try {
    const { readHeldWorkItems } = await import('../../carry-brief');
    const held = await readHeldWorkItems(ownerId, workspaceId, { limit: MAX_HELD_ITEMS });
    if (held.length) {
      recovery.checkpoints = held.map((h) => ({
        id: h.id,
        ...(h.title ? { title: h.title.slice(0, 120) } : {}),
        ...(h.body ? { body: h.body.slice(0, BODY_CAP) } : {}),
        checkpoint: h.checkpoint ? h.checkpoint.slice(0, CHECKPOINT_CAP) : null,
      }));
    }
  } catch { /* best-effort */ }

  return recovery;
}
