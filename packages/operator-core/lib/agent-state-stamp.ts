/**
 * agent-state-stamp.ts — the per-owner in-process cache behind P-009's
 * `tool_invocations` stamp (unified-agent-state-plane-2026-07-27).
 *
 * WHAT THIS IS. A `Map<ownerId, AgentStateStamp>` holding a POINTER to each of
 * the three declarations D-011 unified: the agent's current intent, its
 * assumption watermark, and its goal ref. `readAgentStateStamp` is one Map.get
 * on the dispatcher's hot path; everything else is written a few times per task
 * by acts the agent already performs.
 *
 * WHY A CACHE AND NOT A QUERY (D-014). `tool_invocations` takes ~238,866 rows a
 * day. D-014 is explicit that nothing here is calculated, inferred or
 * recomputed: "the agent writes each declaration ONCE, via an act it already
 * performs; the dispatcher COPIES A POINTER to the most recent one." So the
 * read must be a hashmap get with no I/O, and **a miss writes NULL rather than
 * blocking the call** — telemetry is best-effort and must never be able to fail
 * a tool call.
 *
 * WHY `assumptionSetId` IS A WATERMARK, NOT A SET. There is no assumption-set
 * table, and one bigint cannot enumerate a set — but it can BOUND one. P-008(a)
 * made `agent_facts` append-versioned: every version is its own immutable row
 * with a monotonic `id`, and a correction appends rather than mutating. That is
 * exactly what makes a single id a valid set identifier: the set is
 *
 *     every non-retracted, non-superseded kind='assumption' fact of this owner
 *     whose id <= assumption_set_id
 *
 * i.e. "the assumption state as of this point". Resolving it is P-024's job and
 * happens only on a filtered read (never eagerly per row — that would be an N+1
 * over `agent_facts`). Against the pre-P-008 in-place-mutated table this pointer
 * would have silently named different content than it did when stamped, which is
 * the D-003 violation P-008(a) existed to fix.
 *
 * ⚠ `assumptionSetId`'s PRODUCER IS MEASURED EMPTY. On 2026-07-27, 0 of 2,088
 * `agent_facts` rows carried kind='assumption', so this field is expected to be
 * null on every call until assumptions are actually written (P-012 is the item
 * that starts writing them). `intentEventId`'s producer is live by contrast
 * (12,331 events / 2,363 writers / 529 in 24h). This is disclosed rather than
 * hidden because a column that is structurally always-NULL and a column that is
 * NULL because nobody declared anything are different facts, and only the
 * measurement tells them apart — see P-015.
 *
 * ⚠ THIS IS A RETROSPECTIVE STAMP, NOT A CURRENT-STATE SURFACE (D-051). Nothing
 * that wants to know what an agent is assuming RIGHT NOW may read this or the
 * columns it feeds — that is re-derivation from the wrong datum. Live readers
 * project P-016's goal cell. This exists to answer "what was true when this call
 * was made", which only a per-call stamp can answer.
 */

/** The three declaration pointers stamped onto one tool call. */
export interface AgentStateStamp {
  /** `coord_event_log.id` of the owner's most recent intent declaration. */
  intentEventId: number | null;
  /** Watermark over `agent_facts.id` — see the module note. */
  assumptionSetId: number | null;
  /** Resolved goal ref, e.g. `WI-6393` or `plan:some-slug#P-009`. */
  goalRef: string | null;
}

const EMPTY_STAMP: AgentStateStamp = Object.freeze({
  intentEventId: null,
  assumptionSetId: null,
  goalRef: null,
});

/**
 * Bound on distinct owners held in memory. The live fleet is ~2,363 distinct
 * intent writers over 8 weeks but only a few dozen are ever concurrent, so this
 * is generous; it exists so a long-lived operator process cannot accumulate one
 * entry per agent that has ever run. Eviction is oldest-touched-first.
 */
const MAX_OWNERS = 512;

/**
 * Values are the EXACT `AgentStateStamp` handed to readers — no internal
 * bookkeeping field rides along. Recency is carried by the Map's own insertion
 * order (every write below deletes and re-inserts), so no touch counter is
 * needed; adding one would only leak into the public read.
 */
const stamps = new Map<string, AgentStateStamp>();

function upsert(ownerId: string, patch: Partial<AgentStateStamp>): void {
  if (!ownerId) return;
  const prev = stamps.get(ownerId);
  const next: AgentStateStamp = {
    intentEventId: prev?.intentEventId ?? null,
    assumptionSetId: prev?.assumptionSetId ?? null,
    goalRef: prev?.goalRef ?? null,
    ...patch,
  };
  // Re-insert so Map iteration order tracks recency for the eviction below.
  stamps.delete(ownerId);
  stamps.set(ownerId, next);
  if (stamps.size > MAX_OWNERS) {
    // Map preserves insertion order and we re-insert on every write, so the
    // first key is the least-recently-written owner.
    const oldest = stamps.keys().next();
    if (!oldest.done) stamps.delete(oldest.value);
  }
}

/**
 * `coord:declare-intent` landed an append-only intent row — point at it.
 * Declaring a new intent does NOT clear the goal or the assumptions: they have
 * independent lifetimes (D-011's table), and an agent re-declares intent on
 * every wake via coord:orient while holding the same claim throughout.
 */
export function noteIntentDeclared(ownerId: string, intentEventId: number | null): void {
  if (intentEventId == null || !Number.isFinite(intentEventId)) return;
  upsert(ownerId, { intentEventId });
}

/**
 * `facts:assert` wrote an assumption fact version — advance the watermark.
 *
 * MONOTONIC ONLY. The watermark must never move backwards: a lower id would
 * silently narrow the set every later call claims to have been made under. Ids
 * are assigned by a sequence, so out-of-order arrival is possible when two
 * asserts race, and the later-arriving-but-lower id is the one to drop.
 */
export function noteAssumptionAsserted(ownerId: string, factVersionId: number | null): void {
  if (factVersionId == null || !Number.isFinite(factVersionId)) return;
  const prev = stamps.get(ownerId)?.assumptionSetId ?? null;
  if (prev != null && factVersionId <= prev) return;
  upsert(ownerId, { assumptionSetId: factVersionId });
}

/**
 * The agent took (or released) work — its goal ref. Pass null on release, so a
 * call made after the agent puts work down is not attributed to a goal it no
 * longer holds. That is a real distinction for a forensic read, which is why
 * this is an explicit clear rather than a leave-untouched.
 */
export function noteGoalClaimed(ownerId: string, goalRef: string | null): void {
  const trimmed = typeof goalRef === 'string' ? goalRef.trim() : null;
  upsert(ownerId, { goalRef: trimmed && trimmed.length > 0 ? trimmed : null });
}

/**
 * The dispatcher's hot-path read: ONE Map.get, no I/O, never throws. An unknown
 * owner yields the all-null stamp, which is written as three NULLs.
 */
export function readAgentStateStamp(ownerId: string | null | undefined): AgentStateStamp {
  if (!ownerId) return EMPTY_STAMP;
  return stamps.get(ownerId) ?? EMPTY_STAMP;
}

/** Test seam — the module holds process-global state. */
export function resetAgentStateStamps(): void {
  stamps.clear();
}

/** Test/diagnostic seam: how many owners are currently held. */
export function agentStateStampSize(): number {
  return stamps.size;
}
