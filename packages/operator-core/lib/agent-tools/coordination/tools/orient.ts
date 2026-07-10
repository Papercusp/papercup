/**
 * coord:orient — the COMPOUND agent wake-orientation + session-bootstrap read
 * (code-execution-tool-orchestration B-CX-1B; extended by tool-call-batching-wrappers
 * P-005). The worker's "where do I stand / what should I work on / what do I know /
 * what changed" in ONE call: my assignments (+ lane + load), the claimable backlog, my
 * inbox summary, the recent plan-events delta, and — when I pass `intent` — a memory
 * recall for it plus a coord:declare-intent so peers see me.
 *
 * Measured (harness_shared.tool_invocations, mcp transport, 14d): the
 * `fleet:assignments ↔ coord:inbox ↔ work_items:list/get` cluster is the dominant
 * orientation flow — triples like `memory:search → coord:inbox → fleet:assignments`
 * (36), `fleet:assignments → coord:inbox → work_items:get` (35). The MANDATED
 * session-bootstrap (memory:search + coord:inbox + coord:plan-events +
 * coord:declare-intent) is four MORE round-trips agents pay every wake — this collapses
 * the whole ritual into one.
 *
 * orient composes: fleet:assignments(me) + work_items:list(claimable) +
 * coord:inbox(summary) + coord:plan-events(delta) [+ memory:search(intent) +
 * coord:declare-intent(intent) when `intent` is passed] → 1 round-trip. It is the
 * worker/work-centric sibling of coord:glance (the fleet-HEALTH read). Composition is
 * the in-process re-dispatch pattern (see `_compound-dispatch.ts`) — each sub-read is
 * gated + telemetry-logged like a direct call, run SEQUENTIALLY so they never contend on
 * the caller's single ctx connection. The bootstrap folds are BEST-EFFORT (a slow/timed-
 * out memory recall, or a declare the caller lacks coord:write for, degrades to a null/
 * false field rather than failing orientation) and the result is bounded/COMPACT
 * (tool-call-batching-wrappers D-008): a wrapper that dumped raw concatenated sub-results
 * would re-introduce the very token cost it exists to remove.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveFleetMembership } from '../identity';
import { resolveSelfRef } from '../self-marker';
import { COORD_ROLES } from '../roles';
import { inProcessCall, type InnerCall } from '../../_compound-dispatch';
import { hardText, LIMITS } from '../../limits';
import { withBoundedTimeout } from '../../../bounded-timeout';
import { shapeOrient } from './orient-shape';
import { classifyOwnerDriveMode } from '../agent-drive-mode';
import { withholdQueenLoopControl, QUEEN_LOOP_WITHHELD_REASON } from '../queen-loop-facts';
import { readOwnerPresence } from '../../../power-user-sessions';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from '../../../workspace-registry';
import { getModes } from '../../../modes/store';
import { modeById } from '../../../modes/registry';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import type { AckResult, CursorState } from '../read-cursors';
import {
  fingerprintFleet,
  diffFleet,
  slimAssignmentsForDelta,
  type FleetFingerprint,
  type FleetDelta,
} from './fleet-monitor-delta';
import { fingerprintIdList, idListUnchanged, rowKey } from './orient-list-delta';

/** D-008 COMPACT bounds — keep the folded payload small so it doesn't re-enter
 *  context as bulk input on every later turn. */
const MEMORY_TEXT_CAP = 200;
const MEMORY_HITS_CAP = 10;
/** P-004 (fleet-member-dx, EI-9017): drop near-zero-relevance recall hits before
 *  folding — a degraded embedder (quota outage → lexical fallback) returns hits
 *  scored 0.01–0.03 that are pure noise yet still cost fold tokens on EVERY
 *  orient. Real recall hits score well above this; a hit with NO numeric score
 *  passes (fail-open). Filtered hits surface as `filteredLowScore`, never silently. */
const MEMORY_SCORE_FLOOR = 0.05;
const PLAN_EVENTS_FOLD = 10;
const FLEET_CATCHUP_FOLD = 8;
const FLEET_CATCHUP_CAP = 25;
/** Reuse-at-orient bounds (code-run-adoption): surface a few intent-relevant recipes so an
 *  agent reuses an EXISTING code:run script instead of hand-looping/re-authoring — kept tiny
 *  so it never re-enters context as bulk on later turns. */
const RECIPES_DEFAULT = 3;
const RECIPES_CAP = 5;
const RECIPE_TITLE_CAP = 120;
/** WI-3818: fleet:assignments (`me`) and coord:glance (`fleetHealth`) fan out to
 *  presence/assignments/Tier-1 reads with no internal budget — during the
 *  2026-07-10 host-load storm either could hang orient until the 55s MCP
 *  client timeout, in BOTH monitor and full mode (`me` runs unconditionally).
 *  Bound each so a slow leg degrades to an empty/null fallback instead. */
const ORIENT_FLEET_LEG_TIMEOUT_MS = 8_000;

export interface OrientArgs {
  harness?: string;
  claimableState?: string;
  claimableLimit?: number;
  inboxLimit?: number;
  /**
   * EI-8300: a repeating LEADER/MONITOR loop pays the full fresh-task bootstrap
   * cost (claimable backlog + facts + plan-events + mem0 recall + fleet
   * catch-up + recipes) every wake even though a monitoring tick only needs
   * "what changed in the fleet" — a major driver of that loop's compaction
   * frequency (measured: ~4 compactions in one lean-monitoring session).
   * `'monitor'` skips those heavy legs ENTIRELY (no sub-call, not just a capped
   * output): no `work_items:list` claimable read, no facts fold, no
   * `coord:plan-events` fold, no fleet catch-up, no recipes search, no memory
   * recall (even when `intent`/`memoryQuery` is set). It KEEPS `fleet:assignments`
   * (the live/parked/stalled/orphaned counts a monitor loop actually watches),
   * the inbox read (still your directed-message signal), and — if `intent` is
   * passed — the `coord:declare-intent` write (cheap, and peers still see your
   * status). Default `'full'` — every existing caller is byte-identical.
   */
  mode?: 'full' | 'monitor';
  // P-005 — the session-bootstrap folds (tool-call-batching-wrappers):
  /** Your one-line intent for THIS turn. When set: DECLARED to peers
   *  (coord:declare-intent) AND used as the memory:search recall query — the
   *  two halves of the bootstrap that need an intent, folded into the one call. */
  intent?: string;
  /** Explicit memory:search query (overrides `intent` for the recall fold). */
  memoryQuery?: string;
  /** Plan slug for the declared lane (used with `intent`). */
  planSlug?: string;
  /** Plan items to CLAIM as your lane (used with `intent` + `planSlug`). */
  planItems?: string[];
  /** Max memory hits to fold (default 5, hard-capped 10). */
  memoryLimit?: number;
  /** Fold the recent plan-events delta (default true). */
  includePlanEvents?: boolean;
  /** Only plan-events strictly later than this ISO timestamp. */
  planEventsSince?: string;
  /** Surface reusable code:run recipes relevant to `intent`/`memoryQuery` (default true). */
  includeRecipes?: boolean;
  /** Max relevant recipes to surface (default 3, hard-capped 5). */
  recipesLimit?: number;
  /** Fold a bounded catch-up slice of YOUR fleet's audience-history when you belong to a
   *  named fleet — the auto "what did my fleet say while I was away" at wake (default true). */
  includeFleetCatchUp?: boolean;
  /** Max fleet catch-up messages to fold (default 8, hard-capped 25). */
  fleetCatchUpLimit?: number;
  /** Fold a COMPACT fleet-health glance (coord:glance's health subset — bees
   *  running/working, staged wakes, paused governor buckets) when you belong to a
   *  named fleet: the health read agents otherwise re-fetch via coord:glance right
   *  after orient (compaction-fold-audit-2026-07-06). Default true; full mode only. */
  includeFleetHealth?: boolean;
  /** Set true on your FIRST orient after a compaction. Beefs the inbox fold (more
   *  entries + fuller bodies — a just-compacted agent lost its message context), and
   *  the handler ALSO folds the recovery block (held checkpoints + self-recall). */
  afterCompaction?: boolean;
}

export interface OrientMemoryHit {
  id?: unknown;
  memory?: string;
  score?: unknown;
}

export interface OrientResult {
  ok: boolean;
  /** fleet:assignments scoped to me (assignments, lane, load, orphans). */
  me: unknown;
  /** The claimable backlog (work_items:list, default state=todo). */
  claimable: unknown[];
  /** coord:inbox folded down to its summary + the most-recent bounded entries. */
  inbox: { summary?: unknown; recent?: unknown };
  /** memory:search recall for `intent`/`memoryQuery` — bounded hits; null if the
   *  recall failed/timed out; absent when no query was given. `withheld` counts
   *  queen-loop-steering hits stripped for a responsive caller (P-002). EI-9031:
   *  `degraded` (+ `degradedReason`) is propagated from memory:search when the
   *  embedder is on a reduced-breadth fallback — so an empty `hits` is NOT read as
   *  "nothing relevant exists" during an embedding-backend outage. */
  memory?: {
    query: string;
    hits: OrientMemoryHit[];
    withheld?: number;
    filteredLowScore?: number;
    degraded?: boolean;
    degradedReason?: string;
  } | null;
  /** STANDING FACTS (queen-memory-hybrid L1c) — deterministic scoped conclusions
   *  (workspace + owner + harness scopes), delivered VERBATIM every orient (unlike
   *  the fuzzy memory recall above). Assert via facts:assert; retract when stale.
   *  null on failure; absent when none stand. For an OWNER-DIRECTED (responsive)
   *  caller, queen-loop steering facts (pauseNewWork/maxBees) are withheld here —
   *  see `factsWithheld` — since they govern the queen-bee loop, not the caller's
   *  owner-directed task (P-002 / D-001). */
  facts?: Array<{ scope: string; ref: string | null; body: string; src: string | null }> | null;
  /** Present iff queen-loop steering facts were withheld from a responsive caller
   *  (P-002) — transparent, never a silent drop. Pull live state via pot:get-steering. */
  factsWithheld?: { count: number; reason: string };
  /** coord:plan-events delta — newest few + the true total; null on failure;
   *  absent when includePlanEvents:false. P-005 (full-mode delta rollout):
   *  `unchanged:true` ⇒ `recent` is deliberately empty — the newest events are
   *  byte-identical to what this caller already saw on a prior orient (server-
   *  side cursor, surface 'orient:planEvents'); `total` is still fresh. Absent
   *  `unchanged` ⇒ normal full delivery (baseline, changed, or no cursor injected). */
  planEvents?: { total: number; recent: unknown[]; unchanged?: boolean } | null;
  /** Reusable code:run recipes relevant to `intent`/`memoryQuery` (recipes:search) —
   *  id + title + run/similarity, bounded. Reuse one (recipes:run) instead of hand-looping
   *  or re-authoring. null on failure; absent when no query or includeRecipes:false. */
  recipes?: Array<{ id?: unknown; title?: string; runCount?: unknown; similarity?: unknown }> | null;
  /** Whether the optional coord:declare-intent succeeded (present only when
   *  `intent` was passed; false = the caller lacked coord:write). */
  intentDeclared?: boolean;
  /** A bounded slice of the caller's fleet audience-history (coord:catch-up on
   *  @fleet:<own slug>) — present only when the caller belongs to a fleet; null on a
   *  failed fold. The auto-catch-up at wake. P-005: `unchanged:true` ⇒ `recent` is
   *  deliberately empty (server-side cursor, surface 'orient:fleetCatchUp') — see
   *  `planEvents.unchanged`. */
  fleetCatchUp?: { fleet: string; total: number; recent: unknown[]; unchanged?: boolean } | null;
  /** A COMPACT fleet-health glance (coord:glance's health subset: bees, wake,
   *  governor) — present only when the caller is in a fleet and includeFleetHealth
   *  !== false; null on a failed fold. Folded so agents don't re-call coord:glance
   *  right after orient (compaction-fold-audit-2026-07-06 — 44%+ did). */
  fleetHealth?: { bees?: unknown; wake?: unknown; governor?: unknown } | null;
  /** A fleet LEADER's per-member health brief (fleet:leader-brief) — folded automatically
   *  on a MONITOR tick when the caller resolves (via their launch-env fleet membership)
   *  to a fleet leader: the lever that collapses "monitor orient + a separate
   *  fleet:assignments scan for the whole fleet" into ONE round-trip
   *  (fleet-reliability-verification-2026-07-10 P-007). Absent for a non-leader / non-fleet
   *  caller, or in full mode; null on a failed fold. */
  leaderBrief?: unknown | null;
  /** Monitor-mode fleet DELTA (fleet-deltas-leader-primitives P-004): what changed
   *  in the fleet since this caller's last monitor orient, diffed server-side
   *  against the (owner, 'fleet:monitor') read cursor — the caller carries nothing.
   *  `baseline:true` ⇒ first read (or cursor reset): `me` carries the FULL roster
   *  this once. Otherwise `me.agents` is slimmed to the caller's own row
   *  (`agentsElided` says how many peers were withheld) and `changes` carries the
   *  member transitions ({change:added|updated|removed, id, from, to} — v=verdict,
   *  s=sessionState, d=doing, c=claims). At-least-once: a wake that dies mid-turn
   *  re-receives the same delta next call. Absent in full mode / flag off. */
  fleetDelta?: {
    baseline: boolean;
    changes?: FleetDelta['rows'];
    unchanged?: number;
    orphaned?: { from: number; to: number };
    stalled?: { from: number; to: number };
  };
  /** ownerPresent (flush-to-proceed-stretch-discipline-2026-07-04 P-004): whether a human
   *  power-user session is live for this workspace (readOwnerPresence — a fresh, non-revoked
   *  auth session), so presence-adaptive cadence keys off a MECHANICAL signal rather than
   *  inferring from who sent the last message. `present:true` ⇒ owner is around: run units
   *  back-to-back and converse; `present:false` ⇒ owner absent: settle per unit so wakes stay
   *  injection points. null when the read failed; absent when the handler did not resolve it. */
  ownerPresent?: { present: boolean; lastSeenAgoMs: number | null; activeSessions: number } | null;
}

/**
 * EI-9130: did this orient's bespoke cursor-delta legs (fleetDelta / planEvents /
 * fleetCatchUp — none of which ride the formal `_meta.delta` protocol) actually SERVE a
 * narrowed/unchanged response? Pure + exported so it's directly unit-testable against a
 * composeOrient result without re-deriving the per-leg logic. The handler stamps
 * `ctx.metadata({ deltaServed: true })` when this is true (see dispatch-stack.ts's
 * recordTelemetry, which folds an explicit stamp like this ahead of its own derivation
 * from `_meta.delta.mode`) — the generic breadcrumb that makes a delta rollout's live win
 * directly queryable (`metadata_json->>'deltaServed'`) instead of only inferable.
 */
export function orientServedDelta(
  result: Pick<OrientResult, 'fleetDelta' | 'planEvents' | 'fleetCatchUp'>,
): boolean {
  return (
    result.fleetDelta?.baseline === false ||
    result.planEvents?.unchanged === true ||
    result.fleetCatchUp?.unchanged === true
  );
}

/**
 * Pure composition over an injected `call`, run SEQUENTIALLY. The first three reads are
 * the core orientation (always run); the memory/plan-events/declare folds are the
 * additive session-bootstrap, each gated by its input and BEST-EFFORT. `ownerId` scopes
 * assignments to the caller; when undefined (unresolved loopback identity) assignments
 * are fleet-wide.
 */
export async function composeOrient(
  args: OrientArgs,
  call: InnerCall,
  ownerId: string | undefined,
  /** The caller's drive mode (P-002). When 'responsive' (su/sentinel/planner),
   *  queen-loop steering is withheld from the folded facts + recall. Resolved by
   *  the handler (best-effort); injected here so the composition stays IO-free +
   *  unit-testable. Omitted / 'auto' ⇒ nothing withheld. */
  driveMode?: string,
  /** ownerPresent (P-004): resolved by the handler (a DB read over power_user_sessions) and
   *  INJECTED so composeOrient stays IO-free + unit-testable. Folded verbatim into the result
   *  when provided; undefined ⇒ the leg is absent (e.g. a test that doesn't exercise it). */
  ownerPresent?: OrientResult['ownerPresent'],
  /** fleet-deltas-leader-primitives P-004 (monitor mode) / P-005 (full mode):
   *  the (owner,'fleet:monitor') read-cursor ack — resolved by the handler (flag
   *  + identity + mode) and INJECTED so composeOrient stays IO-free. ONE surface
   *  regardless of which mode reads it (D-002: "server owns baseline+delta" — a
   *  single roster truth an agent alternating monitor/full calls shares).
   *  Undefined ⇒ no delta (full roster fold, pre-P-004 behavior). */
  fleetCursor?: (next: CursorState) => Promise<AckResult>,
  /** P-005: the (owner,'orient:planEvents') read-cursor ack for the plan-events
   *  fold — same injection contract as `fleetCursor`. Undefined ⇒ full delivery
   *  every call (pre-P-005 behavior). Applies in FULL mode only (monitor already
   *  skips this fold entirely). */
  planEventsCursor?: (next: CursorState) => Promise<AckResult>,
  /** P-005: the (owner,'orient:fleetCatchUp') read-cursor ack for the fleet
   *  catch-up fold — same contract. Undefined ⇒ full delivery every call. */
  fleetCatchUpCursor?: (next: CursorState) => Promise<AckResult>,
  /** fleet-reliability-verification-2026-07-10 P-007: the caller's launch-env fleet
   *  membership (fleetSlug/fleetRole) — resolved by the handler via
   *  deriveFleetMembership() (a sync, IO-free env read local to the CALLING agent's
   *  own process) and INJECTED so composeOrient stays IO-free + unit-testable.
   *  Drives the leaderBrief fold below (monitor mode + fleetRole==='leader' only). */
  fleetMembership?: { fleetSlug: string | null; fleetRole: string | null } | null,
): Promise<OrientResult> {
  const monitor = args.mode === 'monitor';
  // WI-3818: unconditional in BOTH modes (monitor's one fleet-related read) — a
  // hang here used to block the whole orient call. Degrades to a minimal
  // empty-roster shape (never throws) so downstream folds — already
  // try/catch-guarded (fingerprintFleet, slimAssignmentsForDelta) — see an
  // empty-but-well-shaped roster instead of hanging past the deadline.
  const meResult = await withBoundedTimeout(
    call('fleet:assignments', {
      ...(ownerId ? { agent: ownerId } : {}),
      ...(args.harness ? { harness: args.harness } : {}),
    }),
    {
      fallback: { ok: false, degraded: true, agents: [] } as unknown,
      timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
      label: 'orient:fleet:assignments',
    },
  );
  let me = meResult.value;
  // ── fleet ROSTER delta (P-004 monitor / P-005 full): diff the roster against
  // the caller's server-side cursor and deliver TRANSITIONS instead of the full
  // roster re-read byte-identically almost every call (D-003 audit — the same
  // ~100%-repeat shape in both modes). Gated on the INJECTED closure, not the
  // mode — the handler decides per-mode whether to inject it (monitor: existing
  // ORIENT_MONITOR_DELTA flag, unchanged; full: new ORIENT_FULL_DELTA flag).
  // FAIL-OPEN at every step: an unrecognizable roster shape, a cursor store
  // error, or a baseline (first read) all keep the full `me` fold — a delta must
  // never make orientation worse than no delta.
  let fleetDelta: OrientResult['fleetDelta'];
  if (fleetCursor) {
    try {
      const fp = fingerprintFleet(me);
      if (fp) {
        const ack = await fleetCursor(fp as unknown as CursorState);
        if (!ack.baseline && ack.committed) {
          const delta = diffFleet(ack.committed as unknown as FleetFingerprint, fp);
          fleetDelta = {
            baseline: false,
            changes: delta.rows,
            unchanged: delta.unchanged,
            ...(delta.orphaned ? { orphaned: delta.orphaned } : {}),
            ...(delta.stalled ? { stalled: delta.stalled } : {}),
          };
          me = slimAssignmentsForDelta(me);
        } else {
          fleetDelta = { baseline: true };
        }
      }
    } catch {
      fleetDelta = undefined; /* fail-open: full roster */
    }
  }
  // EI-8300: a monitor tick doesn't self-select work — skip the claimable read
  // entirely (no round-trip), not just cap its output.
  const list = monitor
    ? []
    : await call('work_items:list', {
        ...(args.harness ? { harness: args.harness } : {}),
        state: args.claimableState ?? 'todo',
        limit: args.claimableLimit ?? 20,
        // EI-7841: orient's claimable backlog feeds self-select loop agents — exclude
        // feature-family items the G2 admission/trust gate would refuse a claim on, so
        // "claimable" here matches what work_items:claim / claim_next will actually do
        // (previously a remote un-admitted item looked pickable here and bounced with
        // not_claimable on the real claim, burning a wake cycle).
        admissibleOnly: true,
      });
  // afterCompaction (fold #2, compaction-fold-audit-2026-07-06): a just-compacted
  // agent lost its message context and 79% immediately re-read coord:inbox, so fold
  // MORE entries + fuller bodies (the shaper relaxes its inbox re-cap when a recovery
  // block is present). Ambient broadcasts stay excluded by coord:inbox's default —
  // the directed-message bias the audit asked for is already the default.
  //
  // fleet-leader-frictions P-004: a MONITOR tick re-paid the full recent-inbox fold
  // every wake — mostly entries the [coord+N] channel already showed. Scope a monitor
  // read to SINCE-LAST-SHOWN via the caller's `messages_shown_ts` watermark (the
  // read-receipt cursor both the injection channel AND this very read advance), so a
  // 60s loop folds only the genuinely-new delta. NOT under afterCompaction — a
  // just-compacted agent lost its context, so "already shown" no longer means
  // "already known"; it keeps the fuller unscoped re-read. BEST-EFFORT + fail-open:
  // an absent/failed watermark ⇒ the unfiltered read, never a broken orient.
  let inboxSince: string | undefined;
  if (monitor && !args.afterCompaction) {
    try {
      const wm = (await call('coord:watermark', {})) as
        | { read_through_ts?: string | null }
        | null
        | undefined;
      if (typeof wm?.read_through_ts === 'string' && wm.read_through_ts) {
        inboxSince = wm.read_through_ts;
      }
    } catch {
      /* fail-open: unscoped read */
    }
  }
  const inbox = (await call('coord:inbox', {
    limit: args.inboxLimit ?? (args.afterCompaction ? 25 : 10),
    max_body_chars: args.afterCompaction ? 800 : 300,
    ...(inboxSince ? { since_ts: inboxSince } : {}),
  })) as { summary?: unknown; entries?: unknown } | undefined;

  // work_items:list returns the bare array (its `result` schema), but be defensive
  // about the wrapped shapes the unwrap may yield.
  const claimable = Array.isArray(list)
    ? list
    : ((list as { data?: unknown[]; items?: unknown[] } | null)?.data ??
       (list as { data?: unknown[]; items?: unknown[] } | null)?.items ??
       []);

  const result: OrientResult = {
    ok: true,
    me,
    claimable,
    inbox: { summary: inbox?.summary, recent: inbox?.entries },
    ...(fleetDelta !== undefined ? { fleetDelta } : {}),
    // P-004: fold the mechanical owner-present bit when the handler resolved it (undefined ⇒
    // leg absent; the handler passes null on a read failure).
    ...(ownerPresent !== undefined ? { ownerPresent } : {}),
  };

  // ── leaderBrief fold (fleet-reliability-verification-2026-07-10 P-007): a MONITOR
  // tick belonging to a resolvable FLEET LEADER also gets the whole fleet's per-member
  // health brief in this SAME round-trip — the lever that collapses "monitor orient +
  // a separate fleet:assignments scan" into one call. Gated the OPPOSITE way from the
  // full-mode fleet legs below (monitor-only); BEST-EFFORT, absent for a non-leader /
  // non-fleet caller or any failure.
  if (monitor && fleetMembership?.fleetRole === 'leader' && fleetMembership.fleetSlug) {
    try {
      result.leaderBrief = await call('fleet:leader-brief', {
        fleet: fleetMembership.fleetSlug,
        ...(args.harness ? { harness: args.harness } : {}),
      });
    } catch {
      result.leaderBrief = null;
    }
  }

  // ── memory:search recall — only when a query is available (a query-less recall is
  // meaningless). BEST-EFFORT: memory p95 is multi-second and can time out; that must
  // not break orientation. EI-8300: a monitor tick skips the recall ENTIRELY, even
  // when `intent`/`memoryQuery` is set — declare-intent (below) still fires, so peers
  // still see the caller's status.
  const memQuery = monitor ? undefined : (args.memoryQuery ?? args.intent);
  if (memQuery) {
    const memLimit = Math.min(args.memoryLimit ?? 5, MEMORY_HITS_CAP);
    try {
      const mem = (await call('memory:search', {
        query: memQuery,
        ...(args.harness ? { harness_slug: args.harness } : {}),
        limit: memLimit,
      })) as
        | { results?: OrientMemoryHit[]; degraded?: boolean; reason?: string; degraded_reason?: string }
        | undefined;
      const rawHits = (mem?.results ?? []).slice(0, memLimit).map((r) => ({
        id: r.id,
        memory: typeof r.memory === 'string' ? r.memory.slice(0, MEMORY_TEXT_CAP) : undefined,
        score: r.score,
      }));
      // P-004 (fleet-member-dx): relevance floor — see MEMORY_SCORE_FLOOR.
      const hits = rawHits.filter((h) => typeof h.score !== 'number' || h.score >= MEMORY_SCORE_FLOOR);
      const filteredLowScore = rawHits.length - hits.length;
      // P-002 / D-001: a responsive caller doesn't receive queen-loop steering as
      // a binding recall hit (it self-drained fleet leaders). Auto callers keep all.
      const { kept, withheld } = withholdQueenLoopControl(hits, driveMode, (h) => ({ body: h.memory }));
      // EI-9031: propagate memory:search's degraded signal (embedder on a
      // reduced-breadth fallback / a failed embed) into the fold, so an empty
      // `hits` is NOT read as "nothing relevant exists" during an embedding-backend
      // outage — the very false-miss this ticket reports. Reason prefers the
      // explicit degraded_reason, then the failure reason string.
      const memDegraded = mem?.degraded === true;
      const memDegradedReason = mem?.degraded_reason ?? mem?.reason;
      result.memory = {
        query: memQuery,
        hits: kept,
        ...(withheld.length > 0 ? { withheld: withheld.length } : {}),
        ...(filteredLowScore > 0 ? { filteredLowScore } : {}),
        ...(memDegraded
          ? { degraded: true, ...(memDegradedReason ? { degradedReason: memDegradedReason } : {}) }
          : {}),
      };
    } catch {
      result.memory = null;
    }
  }

  // ── standing-facts fold (queen-memory-hybrid L1c) — the deterministic sibling of
  // the fuzzy memory recall above: scoped conclusions delivered VERBATIM every
  // orient (workspace + this owner + the named harness). BEST-EFFORT like every
  // other leg — a facts outage must never break orientation. EI-8300: skipped
  // entirely on a monitor tick (a leader loop re-reads its own steering facts on
  // every wake for no reason — it already has them from an earlier full orient).
  if (!monitor) try {
    const { foldFacts } = await import('../../../agent-facts/store');
    const selectors = [
      { scope: 'workspace' as const },
      ...(ownerId ? [{ scope: 'owner' as const, scopeRef: ownerId }] : []),
      ...(args.harness ? [{ scope: 'harness' as const, scopeRef: args.harness }] : []),
    ];
    const facts = await foldFacts(selectors, {});
    // P-002 / D-001: withhold queen-loop steering facts (pauseNewWork/maxBees) from
    // an OWNER-DIRECTED (responsive) caller — filter the RAW facts (key + body both
    // inspected) BEFORE projecting, so the structural `queen-loop:` key convention
    // works alongside the body-vocabulary net. Auto callers keep every fact.
    const { kept, withheld } = withholdQueenLoopControl(facts, driveMode, (f) => ({ key: f.key, body: f.body }));
    if (kept.length > 0) {
      result.facts = kept.map((f) => ({
        scope: f.scope,
        ref: f.scopeRef,
        body: f.body,
        src: f.sourceRef,
      }));
    }
    if (withheld.length > 0) {
      result.factsWithheld = { count: withheld.length, reason: QUEEN_LOOP_WITHHELD_REASON };
    }
  } catch {
    result.facts = null;
  }

  // ── coord:plan-events — the "what plans changed" delta (default on; the bootstrap's
  // third leg). Already result-bounded server-side; we keep the newest few.
  // EI-8300: skipped entirely on a monitor tick.
  if (!monitor && args.includePlanEvents !== false) {
    try {
      const pe = (await call('coord:plan-events', {
        ...(args.planEventsSince ? { since_ts: args.planEventsSince } : {}),
        limit: PLAN_EVENTS_FOLD,
      })) as { events?: unknown[]; total?: number } | undefined;
      const events = Array.isArray(pe?.events) ? (pe!.events as unknown[]) : [];
      const total = typeof pe?.total === 'number' ? pe.total : events.length;
      const recent = events.slice(0, PLAN_EVENTS_FOLD);
      // P-005: full-mode delta — the newest batch is ~96% byte-identical to what
      // this caller already saw last orient (D-003 audit). FAIL-OPEN: any cursor
      // error just skips the unchanged check and delivers in full, same as no
      // cursor injected.
      let unchanged = false;
      if (planEventsCursor) {
        try {
          const ack = await planEventsCursor(fingerprintIdList(recent.map(rowKey)));
          unchanged = !ack.baseline && idListUnchanged(ack.committed, recent.map(rowKey));
        } catch { /* fail-open: full delivery */ }
      }
      result.planEvents = unchanged ? { total, recent: [], unchanged: true } : { total, recent };
    } catch {
      result.planEvents = null;
    }
  }

  // ── fleet legs (full mode only) — resolve the caller's fleet ONCE via coord:whoami,
  // then fold two bounded slices for a fleet member: (1) catch-up = "what did my fleet
  // say while I was away" (the pull counterpart to @fleet: broadcasts, NOT auto-polled),
  // and (2) fleet-health = the coord:glance health subset agents otherwise re-fetch right
  // after orient (compaction-fold-audit-2026-07-06 — 44%+ did). Both gated + BEST-EFFORT:
  // a non-fleet caller or any failure degrades to absent/null. EI-8300: skipped entirely
  // on a monitor tick (both legs). (fleet-messaging-integrate-and-land P-006)
  if (!monitor && (args.includeFleetCatchUp !== false || args.includeFleetHealth !== false)) {
    let fleetSlug: string | null = null;
    try {
      const who = (await call('coord:whoami', {})) as { fleetSlug?: string | null } | undefined;
      fleetSlug = who?.fleetSlug ?? null;
    } catch {
      fleetSlug = null;
    }
    if (fleetSlug && args.includeFleetCatchUp !== false) {
      try {
        const cuLimit = Math.min(args.fleetCatchUpLimit ?? FLEET_CATCHUP_FOLD, FLEET_CATCHUP_CAP);
        const cu = (await call('coord:catch-up', {
          audience: `@fleet:${fleetSlug}`,
          limit: cuLimit,
        })) as { total?: number; rows?: unknown[] } | undefined;
        const rows = Array.isArray(cu?.rows) ? (cu!.rows as unknown[]) : [];
        const total = typeof cu?.total === 'number' ? cu.total : rows.length;
        const recent = rows.slice(0, cuLimit);
        // P-005: same full-mode delta treatment as plan-events — an append-only
        // message log where "nothing new since last orient" is a safe, fully
        // actionable answer. FAIL-OPEN on any cursor error.
        let unchanged = false;
        if (fleetCatchUpCursor) {
          try {
            const ack = await fleetCatchUpCursor(fingerprintIdList(recent.map(rowKey)));
            unchanged = !ack.baseline && idListUnchanged(ack.committed, recent.map(rowKey));
          } catch { /* fail-open: full delivery */ }
        }
        result.fleetCatchUp = unchanged
          ? { fleet: fleetSlug, total, recent: [], unchanged: true }
          : { fleet: fleetSlug, total, recent };
      } catch {
        result.fleetCatchUp = null;
      }
    }
    // fleet-health (fold #1) — COMPACT: coord:glance's health subset only (bees/wake/
    // governor; audience 'su' + activity_limit:0 skip the human display/tips/activity
    // rows). Kills the post-orient coord:glance re-call for fleet members.
    if (fleetSlug && args.includeFleetHealth !== false) {
      // WI-3818: bounded — a slow coord:glance used to hang orient until the
      // 55s MCP client timeout; now degrades to null (same as the pre-existing
      // catch-based failure contract) within ORIENT_FLEET_LEG_TIMEOUT_MS.
      const glanceResult = await withBoundedTimeout(
        call('coord:glance', { audience: 'su', activity_limit: 0 }) as Promise<
          { bees?: unknown; wake?: unknown; governor?: unknown } | undefined
        >,
        { fallback: undefined, timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS, label: 'orient:coord:glance' },
      );
      const g = glanceResult.value;
      result.fleetHealth = g ? { bees: g.bees, wake: g.wake, governor: g.governor } : null;
    }
  }

  // ── recipes:search — surface reusable code:run RECIPES relevant to this turn's intent,
  // so an agent batches via an EXISTING recipe instead of hand-looping or re-authoring
  // (code-run-adoption: reuse-at-orient closes the "I didn't know one existed" gap — the
  // measured bottleneck is awareness, not authoring). Keyed off the same intent/memoryQuery
  // as the recall. BEST-EFFORT: a missing intel:read cap or a slow search degrades to null,
  // never breaks orientation. COMPACT: id/title/runCount/similarity only.
  // EI-8300: skipped entirely on a monitor tick.
  const recipeQuery = monitor ? undefined : (args.intent ?? args.memoryQuery);
  if (recipeQuery && args.includeRecipes !== false) {
    const recLimit = Math.min(args.recipesLimit ?? RECIPES_DEFAULT, RECIPES_CAP);
    try {
      const rec = (await call('recipes:search', {
        query: recipeQuery,
        limit: recLimit,
      })) as { recipes?: Array<{ id?: unknown; title?: unknown; runCount?: unknown; similarity?: unknown }> } | undefined;
      result.recipes = (rec?.recipes ?? []).slice(0, recLimit).map((r) => ({
        id: r.id,
        title: typeof r.title === 'string' ? r.title.slice(0, RECIPE_TITLE_CAP) : undefined,
        runCount: r.runCount,
        similarity: r.similarity,
      }));
    } catch {
      result.recipes = null;
    }
  }

  // ── coord:declare-intent — only when an intent is given (a WRITE; independently
  // capability-gated at re-dispatch, so a read-only caller gets intentDeclared:false
  // rather than an escalation). BEST-EFFORT.
  if (args.intent) {
    try {
      await call('coord:declare-intent', {
        intent: args.intent,
        ...(args.planSlug ? { current_plan_slug: args.planSlug } : {}),
        ...(args.planItems ? { items: args.planItems } : {}),
        ...(args.harness ? { harness: args.harness } : {}),
      });
      result.intentDeclared = true;
    } catch {
      result.intentDeclared = false;
    }
  }

  return result;
}

export default defineTool({
  name: 'coord:orient',
  description:
    "One agent wake-orientation + session-bootstrap read: your assignments (+lane+load), " +
    "the claimable backlog, your inbox summary, and the recent plan-events delta — plus, with " +
    "`intent`, a memory recall AND a coord:declare-intent so peers see you. The mandated bootstrap " +
    "(memory:search + coord:inbox + coord:plan-events + declare + assignments + claimable) in ONE " +
    'round-trip; a fleet member also gets a compact fleet-health glance.',
  guidance: {
    when:
      'At the START of a turn / on waking. Pass `intent` (your one-line task) for the whole ' +
      'bootstrap in ONE round-trip: assignments + claimable + inbox + plan-events + a memory recall ' +
      "+ your intent DECLARED to peers. Omit `intent` for a lighter re-orientation. On a repeating " +
      "LEADER/MONITOR tick pass `mode:'monitor'` — skips the claimable/facts/plan-events/fleet/" +
      'recipes/recall legs, keeping fleet:assignments + inbox + declare.',
    notWhen:
      'A human status-surface render (coord:glance display block — orient folds only the health ' +
      'counts) or the full presence roster (coord:presence). After a successful orient do NOT ' +
      're-call coord:plan-events / memory:search / coord:inbox / coord:glance / coord:declare-intent ' +
      '— it ALREADY returned them (pass afterCompaction:true for fuller inbox + the recovery block).',
    chaining:
      'Bundles fleet:assignments + work_items:list + coord:inbox + coord:plan-events [+ memory:search ' +
      '+ recipes:search + declare with `intent`] — prefer at wake over separate calls. A close ' +
      '`recipes` hit → recipes:run it. → work_items:pickup { id, intent }.',
  },
  capability: 'coord:read',
  // tool-call-batching-wrappers P-010 — composite marker: the primitives this bundles.
  // Drives the `composition: 'composite'` tag (agent_tools:list) + the bounded
  // back-pointer on each of these primitives' catalog entries (prompt-assembly).
  replaces: [
    'fleet:assignments',
    'work_items:list',
    'coord:inbox',
    'coord:plan-events',
    'memory:search',
    'recipes:search',
    'coord:declare-intent',
    'coord:catch-up',
    'coord:glance',
    'fleet:leader-brief',
  ],
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional().describe('Scope assignments + claimable + recall + declare to this harness.'),
    claimableState: z.string().max(40).optional().describe("Work-item state for the claimable list (default 'todo')."),
    claimableLimit: z.number().int().positive().max(100).optional().describe('Max claimable items (default 20).'),
    inboxLimit: z.number().int().positive().max(50).optional().describe('Max recent inbox entries (default 10).'),
    mode: z
      .enum(['full', 'monitor'])
      .optional()
      .describe(
        "Default 'full'. Pass 'monitor' for a repeating leader/monitor loop tick: skips the claimable backlog, facts fold, plan-events delta, fleet catch-up, recipes search, and memory recall ENTIRELY (no sub-call, not just capped output) — keeps fleet:assignments (the live/parked/stalled/orphaned counts a monitor loop watches), the inbox read, and coord:declare-intent (when `intent` is passed). A resolvable FLEET LEADER also gets `leaderBrief` (fleet:leader-brief) folded in — the whole fleet's per-member sessionState/verdict/claims/unanswered/contextPressure in this same round-trip. Sharply cuts per-wake context/token cost for a long-running monitor loop (EI-8300).",
      ),
    intent: hardText(LIMITS.ANNOTATION)
      .optional()
      .describe('Your one-line intent for this turn — DECLARED to peers (coord:declare-intent) AND used as the memory:search recall query. The bootstrap-in-one-call lever.'),
    memoryQuery: z.string().max(500).optional().describe('Explicit memory:search query (overrides `intent` for recall).'),
    planSlug: z.string().max(120).optional().describe('Plan slug for the declared lane (used with `intent`).'),
    planItems: z
      .array(z.string().max(20))
      .max(40)
      .optional()
      .describe('Plan items to claim as your lane (used with `intent` + `planSlug`).'),
    memoryLimit: z.number().int().positive().max(10).optional().describe('Max memory hits to fold (default 5).'),
    includePlanEvents: z.boolean().optional().describe('Fold the recent plan-events delta (default true).'),
    planEventsSince: z.string().optional().describe('Only plan-events strictly after this ISO timestamp.'),
    includeRecipes: z.boolean().optional().describe('Surface reusable code:run recipes relevant to `intent` (default true).'),
    recipesLimit: z.number().int().positive().max(5).optional().describe('Max relevant recipes to surface (default 3).'),
    includeFleetCatchUp: z.boolean().optional().describe("Fold a bounded catch-up of YOUR fleet's audience-history when you're in a named fleet (default true)."),
    fleetCatchUpLimit: z.number().int().positive().max(25).optional().describe('Max fleet catch-up messages to fold (default 8).'),
    includeFleetHealth: z.boolean().optional().describe("Fold a COMPACT fleet-health glance (bees running/working, staged wakes, paused governor buckets) when you're in a named fleet (default true; full mode only) — the coord:glance health read agents otherwise re-fetch right after orient."),
    afterCompaction: z.boolean().optional().describe('Pass true on your FIRST orient after a compaction: folds a recovery block — your held work-items’ checkpoints, armed-loop status, staleness_warnings (presence/fleet/claims that changed AFTER your summary was written — the summary’s view of them is stale), and the self-recall pointer (pre-compaction turns are searchable via sessions:search { session:’self’ }).'),
  }),
  // context-trimming-tiers P-012: orient is the fattest bootstrap read (one
  // unshaped call measured ~43k tokens in the 2026-07-01 fleet incident). The
  // tier shapers project the SAME orientation with caps + fetch-pointers;
  // `payloadTier: 'full'` on any call returns the unshaped result.
  shape: {
    standard: (data, sctx) => shapeOrient(data, sctx.tier as 'standard'),
    trimmed: (data, sctx) => shapeOrient(data, sctx.tier as 'trimmed'),
  },
  async handler(args, ctx) {
    // Soft identity resolve — orient is a READ; a bare loopback caller without an
    // attributable coord identity still gets a (fleet-wide) orientation.
    let ownerId: string | undefined;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = undefined;
    }
    // P-002 / D-001: resolve the caller's drive mode so an OWNER-DIRECTED
    // (responsive: su/sentinel/planner) caller doesn't get queen-loop steering
    // pushed as binding facts/recall. Best-effort + fail-open (an su-… id resolves
    // responsive with NO presence read; any error ⇒ undefined ⇒ nothing withheld).
    let driveMode: string | undefined;
    if (ownerId) {
      try {
        driveMode = (await classifyOwnerDriveMode(ownerId)).driveMode;
      } catch {
        driveMode = undefined;
      }
    }
    // P-004: resolve the MECHANICAL owner-present bit (a fresh, non-revoked human power-user
    // session for this workspace) so presence-adaptive cadence keys off it, not message
    // provenance. Best-effort — a read failure passes null (leg present-but-null), never breaks
    // orientation. Cheap single aggregate read; runs once per orient.
    let ownerPresent: OrientResult['ownerPresent'] = null;
    try {
      const ws = (ctx as { workspaceId?: string | null }).workspaceId ?? activeWorkspaceId();
      const op = await readOwnerPresence(ws);
      ownerPresent = { present: op.present, lastSeenAgoMs: op.lastSeenAgoMs, activeSessions: op.activeSessions };
    } catch {
      ownerPresent = null;
    }
    // P-004 (fleet-deltas-leader-primitives): resolve the monitor fleet-delta seam —
    // an attributable caller in monitor mode, with the flag ON, gets the
    // (owner,'fleet:monitor') server-side cursor closure. Fail-open: a flag-read
    // failure defaults ON (it's a read-path economizer); composeOrient itself
    // fail-opens to the full roster on any cursor error.
    let fleetCursor: ((next: CursorState) => Promise<AckResult>) | undefined;
    if (args.mode === 'monitor' && ownerId) {
      const deltaOn = await getFlag(FLAGS.ORIENT_MONITOR_DELTA, 'system').catch(() => true);
      if (deltaOn) {
        const oid = ownerId;
        fleetCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'fleet:monitor', next);
        };
      }
    }
    // fleet-deltas-leader-primitives P-005: the FULL-mode sibling of the monitor
    // delta above — same ONE 'fleet:monitor' surface (D-002: one roster truth
    // regardless of which mode reads it) plus two new surfaces for the
    // append-only-log folds (plan-events, fleet catch-up). Own flag
    // (ORIENT_FULL_DELTA) so it can be independently killed without touching the
    // separately-shipped, separately-tested monitor path above.
    let planEventsCursor: ((next: CursorState) => Promise<AckResult>) | undefined;
    let fleetCatchUpCursor: ((next: CursorState) => Promise<AckResult>) | undefined;
    if (args.mode !== 'monitor' && ownerId) {
      const fullDeltaOn = await getFlag(FLAGS.ORIENT_FULL_DELTA, 'system').catch(() => true);
      if (fullDeltaOn) {
        const oid = ownerId;
        fleetCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'fleet:monitor', next);
        };
        planEventsCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'orient:planEvents', next);
        };
        fleetCatchUpCursor = async (next) => {
          const { ackAndAdvance } = await import('../read-cursors');
          return ackAndAdvance(oid, 'orient:fleetCatchUp', next);
        };
      }
    }
    // fleet-reliability-verification-2026-07-10 P-007: a sync, IO-free read of THIS
    // process's own launch-env fleet membership (mirrors coord:whoami) — drives the
    // leaderBrief fold (monitor mode + fleetRole==='leader' only).
    const fleetMembership = deriveFleetMembership();
    const result = await composeOrient(
      args,
      inProcessCall(ctx),
      ownerId,
      driveMode,
      ownerPresent,
      fleetCursor,
      planEventsCursor,
      fleetCatchUpCursor,
      fleetMembership,
    );
    // Fold in the caller's own identity so the orientation states YOUR ownerId
    // explicitly (the roster/assignments it composes are about peers; `self` is
    // the "and this is you" anchor). Best-effort — omitted for an unattributable
    // caller. See self-marker.ts for why this is a response-layer overlay.
    const self = resolveSelfRef(ctx);
    // modes-and-intake-ux-2026-07-05 P-008: re-inject the caller's ACTIVE mode
    // contracts each orient — the always-present prompt carries only the one-line
    // mode index; orient (the mandated bootstrap read, run every wake) is the
    // activation-scoped carry surface, same pattern as checkpoint re-injection.
    // A peer-set mode thus takes effect at the target's next turn boundary.
    // Best-effort: a mode-read failure never breaks orientation.
    let modes: { active: Array<Record<string, unknown>>; contracts: string } | undefined;
    if (ownerId) {
      try {
        const ws = (ctx as { workspaceId?: string | null }).workspaceId ?? 'default';
        const rows = await getModes(ws, ownerId);
        if (rows.length) {
          modes = {
            active: rows.map((r) => ({ mode: r.mode, reason: r.reason, setBy: r.setBy, ownerDirected: r.ownerDirected, setAt: r.setAt })),
            contracts: rows
              .map((r) => modeById(r.mode)?.contract)
              .filter(Boolean)
              .join('\n\n'),
          };
        }
      } catch { /* fail-soft */ }
    }
    // compaction-context-loss-2026-07-05 P-002: the post-compaction recovery
    // fold — held-item checkpoints + armed-loop status + the self-recall
    // pointer (with a self live-tail so it's fresh). Handler-side IO like
    // ownerPresent/modes; best-effort — never breaks orientation.
    let recovery: unknown;
    if (args.afterCompaction && ownerId) {
      try {
        const { buildCompactionRecovery } = await import('../compaction-recovery');
        // EI-9013: an unscoped su session's ctx.workspaceId is the literal '*' —
        // passing it (or 'default') straight into the recovery build made the
        // held-items query + checkpoint reads look under a workspace that holds
        // no rows. Resolve to the concrete active workspace.
        const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
        recovery = await buildCompactionRecovery(ownerId, ws);
      } catch { /* fail-soft */ }
    }
    const out = { ...(self ? { self } : {}), ...(modes ? { modes } : {}), ...(recovery ? { recovery } : {}), ...(result as object) };
    // EI-9130: stamp the generic delta-served breadcrumb when at least one of orient's
    // bespoke cursor-delta legs actually narrowed/unchanged its response — see
    // orientServedDelta's doc comment + dispatch-stack.ts's recordTelemetry. Never
    // stamped `false`: absence already reads as "no delta mechanism engaged" (flag off,
    // no cursor, or a baseline/first read), same convention as the formal protocol.
    if (orientServedDelta(result)) {
      ctx.metadata?.({ deltaServed: true });
    }
    // `{ data }` envelope (tool-data-shape ratchet P-003) so payload-tier
    // shaping + format-aware serialization apply. On the MCP transport this is
    // behavior-equivalent to the prior raw-JSON text (the re-encode path
    // already routed orient through the same serializer when TOON shrank it).
    return { data: out };
  },
});
