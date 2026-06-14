/**
 * spawn-hydration — the ONE bounded spawn/wake hydration seam
 * (directed-wake-honesty-and-spawn-handoff-2026-06-14 P-021 / D-004).
 *
 * Assembles the volatile-tail `## Handoff` block a freshly-spawned or warm-woken
 * agent opens with, composing the now-parallel content halves into ONE bounded
 * precompute — called ONCE on both spawn paths (operator-spawn autonomous +
 * bootstrap-role interactive, P-012) instead of each path gathering separately:
 *
 *   • predecessor handoff  — getSpawnHandoffContext (directed-wake P-010, su-88991):
 *       to_feature_id messages + blocked_by predecessor completion summaries + the
 *       sliced plan Now/decisions. Each entry.body is ALREADY provenance-framed
 *       (P-022): remote/un-admitted authors wrapped in the G3 untrusted-peer frame,
 *       pre-capped atomically. The planSlice is local/trusted, raw.
 *   • hive-roster snapshot — listHiveRoster (presence-v2 P-006, su-2ab53).
 *   • work-item checkpoint — getWorkItemCheckpoint (bee-context P-010, su-0de71):
 *       the predecessor/own carry-note, so an evicted bee's successor inherits state.
 *
 * Each source is a DI seam (injected for tests; the production wiring binds the
 * real functions on both spawn paths). Each is FAIL-SOFT: a source that throws or
 * is absent degrades ITS section to empty, never the whole block. The
 * SPAWN_HANDOFF_HYDRATION flag is checked by the caller; this pure assembler just
 * composes + bounds (so it unit-tests with no flag store / no DB).
 *
 * BOUNDING (P-013) — the load-bearing safety rule: an untrusted handoff entry's
 * body is a wrapUntrusted frame; truncating it mid-string would sever the closing
 * tag = a prompt-injection hole. So the total budget is enforced by DROPPING WHOLE
 * ENTRIES (atomic), never by cutting an entry body. Raw (trusted, unframed) text —
 * planSlice / roster / checkpoint — may be truncated at its boundary. Everything
 * dropped/truncated is LOGGED (no silent caps).
 *
 * This module OWNS the SpawnHandoffContext/HandoffEntry contract (the assembler is
 * the single source of truth, per D-004); the gather (su-88991's getSpawnHandoffContext)
 * imports these types from here so producer + consumer never drift.
 */

/** One predecessor-handoff item (su-88991's gather, directed-wake P-010/P-022). */
export interface HandoffEntry {
  kind: 'message' | 'completion';
  fromFeatureId?: string;
  author?: string;
  origin: 'local' | 'remote';
  /** local/admitted-trusted ⇒ true; remote/un-admitted ⇒ false (body already framed). */
  trusted: boolean;
  /**
   * The rendered body — ALREADY provenance-framed and pre-capped ATOMICALLY by the
   * gather (untrusted ⇒ wrapped in the G3 untrusted-peer frame). NEVER truncate this
   * mid-string at assembly: a mid-body cut severs an untrusted frame = injection hole.
   * Bound by dropping the whole entry instead.
   */
  body: string;
  ts: number;
}

/** What getSpawnHandoffContext (su-88991, directed-wake P-010) returns. */
export interface SpawnHandoffContext {
  /** to_feature_id handoff messages addressed to this feature. */
  messages: HandoffEntry[];
  /** blocked_by predecessor completion summaries (direct upstreams only). */
  predecessorSummaries: HandoffEntry[];
  /** Local/trusted plan Now + decisions (getPlanContextBySlug) — raw, never framed. */
  planSlice: string | null;
  /** The gather already hit its own per-source bound (logged there too). */
  truncated: boolean;
}

export interface SpawnHydrationDeps {
  /** Predecessor handoff (su-88991). Absent ⇒ no handoff section (degrades, never throws). */
  getHandoff?: (q: {
    harness: string;
    featureId?: string;
    planSlug?: string;
    workspaceId?: string;
  }) => Promise<SpawnHandoffContext | null>;
  /** A bounded hive-roster snapshot string (su-2ab53's listHiveRoster, rendered). */
  getRoster?: (q: { harness: string; ownerId?: string; workspaceId?: string }) => Promise<string | null>;
  /** The work-item carry-note (su-0de71's getWorkItemCheckpoint). */
  getCheckpoint?: (q: {
    harness: string;
    workItemId: string;
    workspaceId?: string;
  }) => Promise<string | null>;
}

export interface SpawnHydrationInput {
  harness: string;
  featureId?: string;
  planSlug?: string;
  workItemId?: string;
  workspaceId?: string;
  ownerId?: string;
  /** Total char budget for the assembled `## Handoff` block (P-013). Default 4000. */
  maxChars?: number;
  deps?: SpawnHydrationDeps;
  /** Truncation/drop telemetry sink (no silent caps). */
  log?: (msg: string) => void;
}

export interface SpawnHydrationResult {
  /** The `## Handoff` markdown block, or '' when every source was empty/absent. */
  text: string;
  /** Entries dropped to fit the budget (atomic drops) + raw sections truncated. */
  dropped: number;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 4000;
const HANDOFF_HEADING = '## Handoff';

/** Truncate a RAW (unframed, trusted) string at its char boundary + a visible marker. */
function clampRaw(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  if (max <= 0) return { text: '', truncated: true };
  return { text: `${s.slice(0, max).trimEnd()}\n…[truncated]`, truncated: true };
}

/**
 * Compose the available hydration sources into ONE bounded `## Handoff` block.
 * Pure + fail-soft: each `deps.*` call is individually guarded, so a throwing or
 * absent source degrades to an empty section. Returns `text: ''` when nothing was
 * gathered, so the caller can omit the section entirely (never an empty heading).
 */
export async function assembleSpawnHydration(input: SpawnHydrationInput): Promise<SpawnHydrationResult> {
  const { harness, featureId, planSlug, workItemId, workspaceId, ownerId } = input;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const log = input.log ?? (() => {});
  const deps = input.deps ?? {};

  // Gather every source fail-soft, in parallel — a rejection becomes null.
  const safe = async <T>(label: string, fn: (() => Promise<T>) | undefined): Promise<T | null> => {
    if (!fn) return null;
    try {
      return await fn();
    } catch (e) {
      log(`spawn-hydration: ${label} source failed (degraded): ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const [handoff, roster, checkpoint] = await Promise.all([
    safe('handoff', deps.getHandoff && (() => deps.getHandoff!({ harness, featureId, planSlug, workspaceId }))),
    safe('roster', deps.getRoster && (() => deps.getRoster!({ harness, ownerId, workspaceId }))),
    safe(
      'checkpoint',
      deps.getCheckpoint && workItemId
        ? () => deps.getCheckpoint!({ harness, workItemId, workspaceId })
        : undefined,
    ),
  ]);

  let dropped = 0;
  let truncated = handoff?.truncated ?? false;
  let budget = maxChars - HANDOFF_HEADING.length - 1; // the heading itself is in-budget
  const parts: string[] = [];

  /** Append a RAW (trusted, truncatable) section if it fits; truncate at the boundary. */
  const pushRaw = (subheading: string | null, body: string | null | undefined): void => {
    if (!body) return;
    const header = subheading ? `${subheading}\n` : '';
    const clamped = clampRaw(body, Math.max(0, budget - header.length - 2));
    if (!clamped.text) {
      truncated = true;
      log(`spawn-hydration: dropped raw section ${subheading ?? '(plan)'} — no budget left`);
      return;
    }
    if (clamped.truncated) {
      truncated = true;
      log(`spawn-hydration: truncated raw section ${subheading ?? '(plan)'} to fit budget`);
    }
    const block = `${header}${clamped.text}`;
    parts.push(block);
    budget -= block.length + 2;
  };

  /** Append framed handoff ENTRIES atomically — drop whole entries that don't fit (P-013). */
  const pushEntries = (subheading: string, entries: HandoffEntry[] | undefined): void => {
    if (!entries || entries.length === 0) return;
    const kept: string[] = [];
    for (const e of entries) {
      const rendered = e.fromFeatureId ? `- (${e.fromFeatureId}) ${e.body}` : `- ${e.body}`;
      // +2 for the join newline; reserve the subheading on the first kept entry.
      const cost = rendered.length + 1 + (kept.length === 0 ? subheading.length + 1 : 0);
      if (cost > budget) {
        dropped += 1; // atomic drop — NEVER cut a (possibly untrusted-framed) body
        continue;
      }
      kept.push(rendered);
      budget -= cost;
    }
    if (kept.length > 0) parts.push(`${subheading}\n${kept.join('\n')}`);
    if (dropped > 0) truncated = true;
  };

  // Priority order (most load-bearing first, so the budget protects what matters):
  //   1. your own carry-note (checkpoint) — continuity after eviction
  //   2. direct predecessor completion summaries — what the upstream finished
  //   3. the plan slice — Now + decisions for this lane
  //   4. feature handoff messages — explicit notes addressed to this feature
  //   5. hive-roster snapshot — who else is around (cheapest to lose)
  pushRaw('### Carry-note (your last checkpoint)', checkpoint);
  pushEntries('### Upstream completions', handoff?.predecessorSummaries);
  pushRaw(null, handoff?.planSlice);
  pushEntries('### Handoff messages', handoff?.messages);
  pushRaw('### Hive peers', roster);

  if (parts.length === 0) {
    if (dropped > 0) log(`spawn-hydration: all ${dropped} handoff entries dropped — block omitted`);
    return { text: '', dropped, truncated };
  }
  return { text: `${HANDOFF_HEADING}\n\n${parts.join('\n\n')}`, dropped, truncated };
}
