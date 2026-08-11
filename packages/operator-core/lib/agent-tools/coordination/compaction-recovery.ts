import {
  capPreservingOperativeDetailed,
  type CapPreservingOperativeTruncation,
} from '../../operative-clause';

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
  /** P-013: compact, generation-stamped control projection. This is the
   *  authoritative full-resync payload for AUTO/IDEATE/DRAIN, loop/carry,
   *  route, and active scope after compaction. */
  control?: import('./control-anchor').ControlAnchor | null;
  /** WI-7302 part 2: fires when this session is registered in an autonomy mode
   *  (modeImpliesAutonomy — the registry's derived set) while NOTHING will wake
   *  it unprompted — no
   *  armed loop and no standing wake-await. Present ONLY when it fires, so it
   *  costs nothing on the healthy path.
   *
   *  Delivered here specifically because a just-compacted successor is the
   *  agent most exposed to it and least able to notice: it inherits a mode
   *  registration from a predecessor whose loop may have died, and a respawn
   *  restores CONTEXT, not a TURN. This path already reads loop status LIVE, so
   *  the check reflects the world now rather than the last persisted anchor. */
  wakeSourceLostWarning?: string;
  /** Held (assigned, non-terminal) work-items + their checkpoints. `body` is the
   *  item's description (capped) so the post-compaction agent doesn't re-fetch it
   *  via work_items:get — measured at 43% of post-compaction orients
   *  (compaction-fold-audit-2026-07-06). */
  checkpoints?: Array<{
    id: string;
    title?: string;
    body?: string;
    checkpoint: string | null;
    /** What the `checkpoint` excerpt withheld + how to fetch it. Present ONLY
     *  when the checkpoint was actually truncated, so its absence means "you
     *  are reading the whole thing". Without this the excerpt's bare `…` is
     *  indistinguishable from a complete checkpoint to the one reader who can
     *  least afford the confusion: a just-compacted successor whose entire
     *  resume state is this field. */
    checkpointTruncated?: CapPreservingOperativeTruncation;
    /** Same disclosure for the item description excerpt (capped at BODY_CAP). */
    bodyTruncated?: CapPreservingOperativeTruncation;
  }>;
  /** compaction-continuity-hardening P-004: presence/fleet/claims that changed
   *  AFTER the summary was written (the transcript's compact_boundary time) —
   *  the summary's view of anything listed here is guaranteed stale. Present
   *  only when the boundary timestamp is derivable. */
  staleness_warnings?: {
    /** When the compaction summary was written (ISO). */
    summaryAt: string;
    /** Semantics of the list, for the reading agent. */
    note: string;
    /** Concrete detected changes, most-actionable first (bounded). Empty =
     *  nothing detectably changed since the summary. */
    warnings: string[];
  };
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
  let selfFilePath: string | null = null;
  try {
    const { resolveSelfSession } = await import('../../search/self-session');
    const self = await resolveSelfSession(ownerId);
    if (self) {
      selfFilePath = self.filePath;
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

  // (b) armed engine loop + the compact CTRL anchor (P-013). Reconcile once
  // from the canonical stores; derive the legacy loop fold from that result so
  // post-compaction recovery does not pay two loop reads. If the new projection
  // is unavailable during a rolling deploy, retain the old loop-only fallback.
  try {
    const { getLoopStatus } = await import('../../harness/routines/loop');
    const loop = await getLoopStatus(ownerId);
    try {
      const { buildAndPersistControlAnchor } = await import('./control-anchor');
      recovery.control = await buildAndPersistControlAnchor(ownerId, workspaceId, { loop });
      recovery.loop = {
        active: recovery.control.state.loop.active,
        intervalSec: recovery.control.state.loop.intervalSec,
      };
      // WI-7302 part 2: the anchor was just rebuilt from the canonical stores
      // (including a LIVE wake-source read), so this reflects the world now —
      // not the last persisted transition. Attached only when it fires.
      const { wakeSourceLostWarning } = await import('../mode/set');
      const warning = wakeSourceLostWarning({
        modes: recovery.control.state.modes,
        wakeSource: recovery.control.state.wakeSource,
      });
      if (warning) recovery.wakeSourceLostWarning = warning;
    } catch {
      recovery.control = null;
      recovery.loop = loop
        ? { active: Boolean(loop.active), intervalSec: loop.intervalSec ?? null }
        : null;
    }
  } catch {
    recovery.loop = null;
    recovery.control = null;
  }

  // (a) held work-items' checkpoints — normally re-injected only on pickup;
  // after a compaction the agent may not know it still HOLDS them. Shares the
  // carry-brief held-items read (compaction-continuity-hardening P-003) so this
  // fold and the compaction/cold-anchor briefs can never drift.
  try {
    const { readHeldWorkItems } = await import('../../carry-brief');
    const held = await readHeldWorkItems(ownerId, workspaceId, { limit: MAX_HELD_ITEMS });
    if (held.length) {
      recovery.checkpoints = held.map((h) => {
        // EI-19952485326105760: a plain head-only slice here reproduces the SAME
        // defect the carry-brief held-item render already fixed — append-style
        // checkpoints write the newest, most-operative content LAST, so a bare
        // cut discards a superseding owner directive first. This IS that surface
        // (payload.paths named this file's directory) and was left unpatched when
        // the carry-brief fix landed. Share the same preservation helper so the
        // post-compaction recovery fold and the cold carry-brief render can never
        // diverge on this again.
        //
        // ...and preserving the operative clause is only HALF the fix: the
        // excerpt still has to SAY it is an excerpt. Every sibling fold in this
        // same orient payload already discloses its own trim with a count and a
        // fetch verb (factsTruncated / claimableTruncated / recentTruncated /
        // bodiesTruncated); these two fields were the holdout, on the one path
        // where the reader is a cold successor whose whole resume state is what
        // it can see here. Hence the `*Truncated` siblings below.
        const fetch = `work_items:get { id: '${h.id}' }`;
        const ckpt = h.checkpoint
          ? capPreservingOperativeDetailed(h.checkpoint, CHECKPOINT_CAP, { more: fetch })
          : null;
        const body = h.body
          ? capPreservingOperativeDetailed(h.body, BODY_CAP, { more: fetch })
          : null;
        return {
          id: h.id,
          ...(h.title ? { title: h.title.slice(0, 120) } : {}),
          ...(body ? { body: body.text } : {}),
          ...(body?.truncation ? { bodyTruncated: body.truncation } : {}),
          checkpoint: ckpt ? ckpt.text : null,
          ...(ckpt?.truncation ? { checkpointTruncated: ckpt.truncation } : {}),
        };
      });
    }
  } catch { /* best-effort */ }

  // (d) staleness warnings (compaction-continuity-hardening P-004): recover the
  // summary's timestamp from the transcript's compact_boundary entry, then flag
  // the presence/fleet/claims that changed AFTER it — the changes the summary
  // cannot know about but the successor will treat as fact.
  try {
    if (selfFilePath) {
      const { readLastCompactBoundaryTs, buildStalenessWarnings } = await import(
        './compaction-staleness'
      );
      const summaryAtMs = await readLastCompactBoundaryTs(selfFilePath);
      if (summaryAtMs != null) {
        recovery.staleness_warnings = {
          summaryAt: new Date(summaryAtMs).toISOString(),
          note:
            'Everything below CHANGED after your compaction summary was written — the ' +
            "summary's view of it is stale. Liveness/fleet counts, service states, and " +
            'quantities in the summary are hypotheses to re-verify, never facts.',
          warnings: await buildStalenessWarnings(ownerId, workspaceId, { summaryAtMs }),
        };
      }
    }
  } catch { /* best-effort */ }

  return recovery;
}
