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
// P-008 (b): the cell-read identity injected into the standing-facts fold.
import { cellReaderFromCtx, type CellReaderCtxLike } from '../../cell-reader-ctx';
import type { FactDependencyStaleness } from '../../facts/dependency-staleness';
import type { CellReadEnv } from '../../../cell-read';
import type { CellReader } from '../../../cell-registry';
import { resolvePresenceFleet } from '../presence-fleet';
import { resolveSelfRef } from '../self-marker';
import { COORD_ROLES } from '../roles';
import { inProcessCall, type InnerCall } from '../../_compound-dispatch';
import { hardText, LIMITS } from '../../limits';
import { withBoundedTimeout } from '../../../bounded-timeout';
import { getHostSnapshot, type HostSnapshot } from '../../../host-snapshot';
import { shapeOrient } from './orient-shape';
import type { OrientPipeline } from '../pipeline-health';
import { classifyOwnerDriveMode } from '../agent-drive-mode';
import { withholdQueenLoopControl, QUEEN_LOOP_WITHHELD_REASON } from '../queen-loop-facts';
import { admitRecallHits, MEMORY_TEXT_CAP } from '../../../memory/recall-admission';
import { readOwnerPresence } from '../../../power-user-sessions';
import { listActiveAnnouncements } from '../../../events/await/store';
import { announcementVisibleTo } from '../../../events/await/announce-key';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from '../../../workspace-registry';
import { getModes } from '../../../modes/store';
import { modeById } from '../../../modes/registry';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { fixedCohortIds } from '../../../scheduler/claim-spec';
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
 *  context as bulk input on every later turn. (MEMORY_TEXT_CAP lives with the admission
 *  gates in lib/memory/recall-admission.ts — the char budget is charged against the
 *  truncated text, so the canary must truncate identically to model the same fold.) */
const MEMORY_HITS_CAP = 10;
/** P-003: the non-exhaustive advisory folded alongside a non-empty recall — agents
 *  must neither re-search the intent they just got recall for, NOR treat this fold
 *  as complete (absence here ≠ absence in store). Duplicate-over-missing is the
 *  designed asymmetry (su-agent-behavior `recall-utilization`, D-002). */
export const ORIENT_MEMORY_NOTE =
  'auto-recall (non-exhaustive): do not re-search this same intent; DO memory:search for specifics not shown — absence here is not absence in store.';
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
/** WI-4533: the pipeline leg is a DECORATION on the wake read — cached, and started by the handler
 *  before the legs above, so by the time it is awaited it is almost always already resolved. Bound
 *  it tightly anyway: an agent must never wait on "is the gate green" to find out what it's
 *  assigned. Blowing this budget drops the block; it never fails the orient. */
const ORIENT_PIPELINE_TIMEOUT_MS = 3_000;
/** P-016 (voice-public-release-readiness-2026-07-12): the papercup pane-context
 *  fold gathers FOUR ready-made digests (salience feed, overwatch brief, corpus
 *  digest, live fleet — papercup-context.ts) — heavier than a single fleet leg,
 *  so it gets its own budget. Degrades to null past it (WI-3818 contract). */
const ORIENT_PANE_CONTEXT_TIMEOUT_MS = 10_000;
/** EI-18162666491500151: buildCompactionRecovery (afterCompaction:true) fans out
 *  to FIVE independent legs — a self-transcript FORCE-TAIL/ingest (unbounded on a
 *  large/first-time-seen session file), an armed-loop + control-anchor read, a
 *  held-work-items query, and a staleness-warnings scan — none individually
 *  budgeted, so any one hanging (observed: a healthy MCP connection where
 *  SIBLING tool calls in the SAME turn returned instantly) silently wedged the
 *  WHOLE orient call for the full 300s MCP tool-idle timeout instead of the
 *  bounded-timeout contract (WI-3818) every other orient leg already gets.
 *  Generous vs the other legs (15s, not 8-10s) because it does genuinely more
 *  work and only runs on the FIRST post-compaction orient (low frequency), but
 *  still an order of magnitude under the 300s wedge this exists to prevent. */
const ORIENT_COMPACTION_RECOVERY_TIMEOUT_MS = 15_000;

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
  /** The claimable backlog (work_items:list, default state=todo). EI-6468: this list
   *  rides work_items:list's cachedRead (≤20s soft TTL, tag-invalidated on write) —
   *  advisory, NOT a live claim guarantee. A row can lag a just-completed/claimed
   *  state for a few seconds under normal cache-ECA propagation. Treat an id here as
   *  a CANDIDATE to attempt, never as pre-verified available; a real self-select
   *  (work_items:claim / scheduler:get_next / work_items:claim_next) re-checks live
   *  and is authoritative — a `not_claimable` bounce off a stale candidate is
   *  expected and cheap, not a bug to chase. */
  claimable: unknown[];
  /** coord:inbox folded down to its summary + the most-recent bounded entries.
   *  EI-18667514339699744: `entries` is aliased alongside `recent` (same array,
   *  same reference) so a caller reading either coord:orient's or coord:inbox's
   *  key name gets the real rows instead of a silent [] on a mismatched read. */
  inbox: { summary?: unknown; recent?: unknown; entries?: unknown };
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
    /** P-002 (orient-recall-quality): hits dropped by the AGGREGATE char budget
     *  (orientMemoryBudgetChars) — loud, never silent; pull them via memory:search. */
    withheldBudget?: number;
    /** P-003: the non-exhaustive advisory (ORIENT_MEMORY_NOTE) — present iff hits>0. */
    note?: string;
    degraded?: boolean;
    degradedReason?: string;
  } | null;
  /** STANDING FACTS (queen-memory-hybrid L1c) — deterministic scoped conclusions
   *  (workspace + owner + harness scopes), delivered VERBATIM every orient (unlike
   *  the fuzzy memory recall above). Assert via facts:assert; retract when stale.
   *  null on failure; absent when none stand. For an OWNER-DIRECTED (responsive)
   *  caller, queen-loop steering facts (pauseNewWork/maxBees) are withheld here —
   *  see `factsWithheld` — since they govern the queen-bee loop, not the caller's
   *  owner-directed task (P-002 / D-001).
   *  P-007: audience-filtered by the CALLER's fleet (an `aud`-scoped fact folds
   *  only for its fleet's members), and `src` is provenance-hydrated — a typed
   *  verified sourceRef renders `<ref> ✓ "<verbatim quote>"`, an unresolvable
   *  one renders `✗unverified` loudly. */
  /** P-008 (c): `changed` marks a fact asserted/superseded since this caller last
   *  oriented (D-012's watermark surface). Absent = unchanged, or a bootstrap read. */
  facts?: Array<{
    scope: string;
    ref: string | null;
    body: string;
    src: string | null;
    aud?: string;
    changed?: true;
  }> | null;
  /** Present iff queen-loop steering facts were withheld from a responsive caller
   *  (P-002) — transparent, never a silent drop. Pull live state via pot:get-steering. */
  factsWithheld?: { count: number; reason: string };
  /** The four scalars agents otherwise shell out for — current UTC instant, core
   *  count, load average, free memory (bash-to-tool-substitution-2026-07-26,
   *  P-026 + P-027). Measured over the 7d corpus: 852 `date` atoms across 50 of
   *  86 sessions (69% of them a bare `date`/`date -u`) and 283 load/mem/core
   *  atoms across 47 of 86 sessions, spread over ~26 distinct zero-argument
   *  shapes. A near-constant answer asked that often does not want a VERB — a
   *  verb still costs the inference round-trip that IS the measured cost — so it
   *  rides here, on a call already made 1,207 times in the same window. Always
   *  present (it cannot fail beyond `now`); ~25 tokens. See host-snapshot.ts for
   *  what deliberately stays bash (`du`/`df`, and `$(date …)` interpolation). */
  host?: HostSnapshot;
  /** coord:plan-events delta — newest few + the true total; null on failure;
   *  absent when includePlanEvents:false. P-005 (full-mode delta rollout):
   *  `unchanged:true` ⇒ `recent` is deliberately empty — the newest events are
   *  byte-identical to what this caller already saw on a prior orient (server-
   *  side cursor, surface 'orient:planEvents'); `total` is still fresh. Absent
   *  `unchanged` ⇒ normal full delivery (baseline, changed, or no cursor injected). */
  planEvents?: { total: number; recent: unknown[]; unchanged?: boolean } | null;
  /** WI-5228 (kickoff-prompt-absorption-2026-07-17 P-002): orient-first plan
   *  bootstrap. For a PLAN-BOUND caller — `planSlug` was passed, or (when
   *  omitted) the self row's `declaredPlanSlug` already sitting on `me`
   *  (fleet:assignments' presence-sourced self-declared current plan)
   *  resolves one — folds the plan's `## Now` block + the next actionable
   *  item + the caller's own claim state within that plan, so a plan-bound
   *  kickoff can reduce to "call coord:orient" with no separate
   *  plans:get/plans:items round-trip. `nextActionable` is the first item
   *  with `effectiveStatus:'todo'`, no unresolved blockers, and
   *  `needsHuman:false` (the same admissibility plans:get already computes)
   *  — null when nothing qualifies (plan fully claimed/blocked/done).
   *  `myClaims` is ALSO derived from the already-fetched `me` (no extra
   *  round-trip beyond plans:get itself). null on failure or no resolvable
   *  plan; absent only when this leg never ran (a monitor tick). */
  planNow?: {
    planSlug: string;
    state: string | null;
    next: string | null;
    nextActionable: { id: string; title: string; phase: string | null } | null;
    myClaims: string[];
  } | null;
  /** Reusable code:run recipes relevant to `intent`/`memoryQuery` (recipes:search) —
   *  compact identity/similarity plus the exact authority-preserving runArgs.
   *  Reuse via runArgs instead of hand-looping or re-authoring. Entity-bound
   *  recipes were already filtered against this orient's live lane context. */
  recipes?: Array<{
    id?: unknown;
    title?: string;
    runCount?: unknown;
    similarity?: unknown;
    authorityRefs?: unknown;
    runArgs?: unknown;
  }> | null;
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
  /** P-009 (coord-authority-hardening H4): the caller's fleet TYPED control state,
   *  folded whenever it is NOT plain 'active' — how a LATE JOINER (or a member who
   *  missed the cue) learns the fleet is winding down without any message having
   *  reached them. Read from the durable registry row (mig 575). Absent for a
   *  non-fleet caller / an active fleet / a failed read (best-effort). */
  fleetControl?: {
    fleet: string;
    state: string;
    reason: string | null;
    by: string | null;
    since: number | null;
  };
  /** EI-9270: declared-but-unfired ANNOUNCED gate events visible to this caller's
   *  fleet/plan/harness (+ global) — "what should I events:await", with zero leader
   *  messages. Absent when none are visible (or on a monitor tick). */
  announcedGates?: Array<{
    event: string;
    note: string | null;
    scope: string;
    announcedBy: string;
    expires_ts: string | null;
  }>;
  /** A fleet LEADER's per-member health brief (fleet:leader-brief) — folded automatically
   *  on a MONITOR tick when the caller resolves (via their launch-env fleet membership)
   *  to a fleet leader: the lever that collapses "monitor orient + a separate
   *  fleet:assignments scan for the whole fleet" into ONE round-trip
   *  (fleet-reliability-verification-2026-07-10 P-007). Absent for a non-leader / non-fleet
   *  caller, or in full mode; null on a failed fold. */
  leaderBrief?: unknown | null;
  /** EI-18731216945970087: present ONLY when composeOrient caught a presence/registry
   *  leadership DRIFT — the caller's presence row (coord_presence.fleet_slug/fleet_role)
   *  showed no fleet at all on a monitor tick, but `harness_shared.agent_fleets
   *  .leader_owner_id` (the durable registry fact) says they lead one. The
   *  `leaderBrief` above is still folded for the recovered fleet — this field exists
   *  so the drift itself is LOUD (never a silent leaderBrief omission) and so a
   *  repeat caller knows their presence row is not settling. Absent on the (default)
   *  agreeing path. */
  presenceDrift?: { fleet: string; note: string };
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
  /** P-016 (voice-public-release-readiness-2026-07-12): the papercup FAST pane's
   *  standing live-system digest — the SAME rendered block the converse brain walks
   *  in with (papercup-context.ts: anomalies → live signals → open deep delegations
   *  → standing patterns → live fleet), folded so a coord-side fast-pane turn
   *  orients with the whole pot picture in this ONE call instead of re-deriving it
   *  from raw reads. Present only for a `papercup`-role caller in full mode
   *  (orientRoleFolds); null on a failed/timed-out gather — never breaks orientation. */
  paneContext?: string | null;
  /** P-016: the papercup-deep pane's OPEN QUESTION THREAD — directed messages
   *  awaiting ITS reply (the unanswered-directed aggregate, newest-first capped
   *  list + true count). The deep brain's work unit IS the delegated question, so
   *  its orient leads with "what do I still owe an answer to" — count 0 is the
   *  honest "nothing pending, park". Present only for a `papercup-deep`-role
   *  caller in full mode (orientRoleFolds); null on a failed read. */
  deepWork?: {
    count: number;
    oldestAgeMs: number;
    newest: Array<{ msgId: string; from: string; summary?: string; ageMs: number }>;
    /** The answer-before-parking advisory — rides only a non-empty thread. */
    note?: string;
  } | null;
  /** WI-4533 (P-006): the release PIPELINE's health — the gate's colour + whether the tip is live
   *  — folded into the wake read every agent already makes. An agent that starts editing without
   *  knowing the gate is red is working on something that cannot ship; the fact existed (dev:why)
   *  but 425 agents oriented 2256×/7d and called it 16×. Terse when healthy ({gate,deploy}); when
   *  not, it carries the failing files + the root-cause leaf + what it means for the caller's work.
   *  ABSENT (never a false green) for a harness with no green-checkpoint routine, and on any
   *  read failure/timeout — see pipeline-health.ts. Both modes: a monitor tick wants this most. */
  pipeline?: OrientPipeline | null;
  /** P-006 / EI-11409: compact schemas for the exact task/mode pack orient
   *  activated on this session. Re-delivered after compaction with a stable
   *  content watermark and replace-full resync contract. */
  taskToolSchemaPack?: import('./orient-task-schema-pack').TaskToolSchemaPack & {
    activation: { requested: true; surfaceChanged: boolean | null };
  };
}

/** P-016: the role-specific fold closures the HANDLER injects (dynamic-import IO
 *  lives in the closures) so composeOrient stays IO-free + unit-testable — the
 *  same injection contract as the cursor/fleetMembership params. */
export interface OrientRoleFolds {
  /** Renders the papercup pane's live-system digest block (null ⇒ nothing to fold). */
  paneContext?: () => Promise<string | null>;
  /** Reads the papercup-deep pane's unanswered directed-question thread. */
  deepWork?: () => Promise<NonNullable<OrientResult['deepWork']> | null>;
}

/** PURE (P-016): which role-specific folds a caller's dispatch role earns.
 *  `papercup` (the user-facing FAST dock pane) → the live-system pane digest;
 *  `papercup-deep` (the hidden deep brain) → its open question thread. FULL mode
 *  only — a monitor tick skips both (the EI-8300 cost discipline every heavy leg
 *  follows). Every other role: neither — these are pane-role standing context,
 *  not general orientation. Exported so the gate is directly unit-testable
 *  without driving the handler. */
export function orientRoleFolds(
  role: string | null | undefined,
  mode: 'full' | 'monitor' | undefined,
): { paneContext: boolean; deepWork: boolean } {
  if (mode === 'monitor') return { paneContext: false, deepWork: false };
  return { paneContext: role === 'papercup', deepWork: role === 'papercup-deep' };
}

/** P-016: the deepWork answer-before-parking advisory (exported for the tests +
 *  any renderer that wants to pin the exact copy). */
export const ORIENT_DEEP_WORK_NOTE =
  'open delegated questions awaiting YOUR reply — answer each on its own thread ' +
  "(coord:send { to: [<from>], related_msg_id: <msgId>, wake: 'required' }) before parking; never go silent.";

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
export function orientServedDelta(result: Pick<OrientResult, 'fleetDelta' | 'planEvents' | 'fleetCatchUp'>): boolean {
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
  /** fleet-reliability-verification-2026-07-10 P-007: the caller's authoritative
   *  presence-backed fleet membership (fleetSlug/fleetRole), falling back to launch
   *  environment only when the presence read fails. Resolved by the handler and
   *  INJECTED so composeOrient stays IO-free + unit-testable.
   *  Drives the leaderBrief fold below (monitor mode + fleetRole==='leader' only). */
  fleetMembership?: { fleetSlug: string | null; fleetRole: string | null } | null,
  /** P-016 (voice-public-release-readiness-2026-07-12): the role-specific fold
   *  closures — resolved by the handler (ctx.role through the PURE orientRoleFolds
   *  gate) and INJECTED so composeOrient stays IO-free + unit-testable. Absent ⇒
   *  neither fold (every non-pane role, and every monitor tick). */
  roleFolds?: OrientRoleFolds,
  /** WI-4533 (P-006): the release-pipeline health fold. The handler STARTS the read before calling
   *  composeOrient and passes a closure over the in-flight promise, so its latency overlaps the
   *  sequential legs below instead of adding to them. Injected (not called inline) so composeOrient
   *  stays IO-free + unit-testable — the same contract as ownerPresent / roleFolds. Undefined ⇒
   *  the leg is absent. */
  pipelineFold?: () => Promise<OrientPipeline | null>,
  /** EI-18731216945970087: cross-checks `harness_shared.agent_fleets.leader_owner_id`
   *  (the durable, single-leader-invariant registry fact) for a caller whose presence-
   *  derived `fleetMembership` resolved to NO fleet at all — the exact shape that used
   *  to silently drop `leaderBrief` on a monitor tick for a caller who genuinely IS a
   *  registered leader (presence/registry disagreement, not "not a leader"). Resolves
   *  to the led fleet's slug, or null when the registry agrees the caller leads
   *  nothing. Injected so composeOrient stays IO-free + unit-testable — the same
   *  contract as pipelineFold / roleFolds. Undefined ⇒ the check never runs. */
  presenceDriftCheck?: () => Promise<string | null>,
  /** P-008 (b) (unified-agent-state-plane-2026-07-27): the cell-read identity the
   *  standing-facts fold re-checks declared dependencies under. Resolved by the
   *  handler via `cellReaderFromCtx(identity, ctx)` and INJECTED — same contract
   *  as roleFolds / pipelineFold, and for a sharper reason than testability:
   *  BOTH halves are access-control inputs (P-019 audience + the resolver's role
   *  gate, D-058), and composeOrient has no ctx, so a value derived in here would
   *  have to be GUESSED. A guessed role either fails closed (useless) or fails
   *  open (a leak). Undefined ⇒ the dependency re-check simply does not run and
   *  facts fold exactly as they did before. */
  cellIdentity?: { reader: CellReader; env: CellReadEnv },
): Promise<OrientResult> {
  const monitor = args.mode === 'monitor';
  // EI-18731216945970087: only exercised when presence itself found no fleet at all,
  // in monitor mode (the failure's exact shape) — a correctly-labeled member/leader's
  // tick never pays this extra lookup. A caught drift is treated as authoritative
  // 'leader' for the REST of this call (the leaderBrief gate + the fleet-scoped legs
  // below), and reported LOUDLY via `result.presenceDrift` rather than silently fixed.
  let effectiveFleetMembership = fleetMembership;
  let presenceDrift: OrientResult['presenceDrift'];
  if (monitor && !fleetMembership?.fleetSlug && presenceDriftCheck) {
    try {
      const ledFleet = await presenceDriftCheck();
      if (ledFleet) {
        effectiveFleetMembership = { fleetSlug: ledFleet, fleetRole: 'leader' };
        presenceDrift = {
          fleet: ledFleet,
          note:
            `PRESENCE DRIFT: the registry (agent_fleets.leader_owner_id) says you LEAD fleet ` +
            `'${ledFleet}', but your presence row (coord_presence.fleet_slug/fleet_role) showed no ` +
            `fleet at all — the exact shape that used to silently drop \`leaderBrief\` and read as ` +
            `"my whole fleet is gone". Recovered from the registry for THIS call; leaderBrief below ` +
            `is real. If this repeats, your presence row is not settling after fleet:take-leadership ` +
            `— do not relaunch live members on the strength of a bare orient read alone; corroborate ` +
            `with fleet:assignments { fleet } / fleet:status first.`,
        };
      }
    } catch {
      /* best-effort — never break orientation over a drift cross-check */
    }
  }
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
        // work-item-status-full-unify P-007: the unified claimable token is 'open' (feature
        // `todo`→`open`; issue claimable was already `open`). work_items:list filters
        // `status = <state>` EXACTLY (no alias-expand), so defaulting to the legacy 'todo'
        // matched ~nothing post-backfill — every agent's orient claimable backlog read empty.
        state: args.claimableState ?? 'open',
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
      const wm = (await call('coord:watermark', {})) as { read_through_ts?: string | null } | null | undefined;
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
    // EI-18667514339699744: alias `entries` alongside `recent` — coord:inbox's own
    // key name — so a caller who reads either name off this fold gets real rows
    // instead of a silent empty array on a mismatched accessor.
    inbox: { summary: inbox?.summary, recent: inbox?.entries, entries: inbox?.entries },
    // P-026/P-027: the shell-out-avoidance scalars. Unconditional and in-process
    // (no await, no round-trip) — the whole point is that the answer has already
    // arrived by the time an agent would have thought to run `date` or `uptime`.
    host: getHostSnapshot(),
    ...(fleetDelta !== undefined ? { fleetDelta } : {}),
    // P-004: fold the mechanical owner-present bit when the handler resolved it (undefined ⇒
    // leg absent; the handler passes null on a read failure).
    ...(ownerPresent !== undefined ? { ownerPresent } : {}),
    // EI-18731216945970087: loud, never silent — see the presenceDriftCheck doc above.
    ...(presenceDrift !== undefined ? { presenceDrift } : {}),
  };

  // ── leaderBrief fold (fleet-reliability-verification-2026-07-10 P-007): a MONITOR
  // tick belonging to a resolvable FLEET LEADER also gets the whole fleet's per-member
  // health brief in this SAME round-trip — the lever that collapses "monitor orient +
  // a separate fleet:assignments scan" into one call. Gated the OPPOSITE way from the
  // full-mode fleet legs below (monitor-only); BEST-EFFORT, absent for a non-leader /
  // non-fleet caller or any failure. Reads `effectiveFleetMembership` (not the raw
  // presence-only `fleetMembership`) so a caught presence/registry drift (above) still
  // gets its leaderBrief instead of silently dropping it a second time.
  if (monitor && effectiveFleetMembership?.fleetRole === 'leader' && effectiveFleetMembership.fleetSlug) {
    try {
      const brief = await call('fleet:leader-brief', {
        fleet: effectiveFleetMembership.fleetSlug,
        ...(args.harness ? { harness: args.harness } : {}),
      });
      // P-015: hydrate the EXISTING leader brief instead of introducing a parallel
      // monitor surface. These are authoritative reads a leader otherwise re-calls
      // immediately after orient; each remains independently fail-soft.
      const hydrated: Record<string, unknown> =
        brief && typeof brief === 'object' && !Array.isArray(brief)
          ? { ...(brief as Record<string, unknown>) }
          : { fleetHealth: brief };
      let claimSpec: unknown = null;
      try {
        claimSpec = await call('scheduler:get_claim_spec', {
          fleet: effectiveFleetMembership.fleetSlug,
        });
        hydrated.claimSpec = claimSpec;
      } catch {
        hydrated.claimSpec = null;
      }
      // Fixed-wave scope is already encoded in the fleet claim spec. Reuse that
      // literal cohort to drive work_items:burn_down's exact-ID audit; never ask a
      // leader to maintain a second list or infer scope from current assignments.
      const specRecord =
        claimSpec && typeof claimSpec === 'object' ? (claimSpec as { spec?: unknown; harnessSlug?: unknown }) : null;
      const cohortIds = fixedCohortIds(
        specRecord?.spec && typeof specRecord.spec === 'object'
          ? (specRecord.spec as { view?: { filter?: unknown } })
          : null,
      );
      const cohortHarness =
        args.harness ?? (typeof specRecord?.harnessSlug === 'string' ? specRecord.harnessSlug : undefined);
      if (cohortIds && cohortHarness) {
        try {
          const scoped = await call('work_items:burn_down', {
            harness: cohortHarness,
            ids: cohortIds.slice(0, 200),
          });
          hydrated.scopedBurndown = scoped;
          const allowed = new Set(cohortIds);
          const members = Array.isArray(hydrated.members) ? (hydrated.members as Array<Record<string, unknown>>) : [];
          hydrated.outOfScopeAssignments = members.flatMap((member) => {
            const ids = Array.isArray(member.workItemIds)
              ? member.workItemIds.filter((id): id is string => typeof id === 'string')
              : [];
            return ids.filter((id) => !allowed.has(id)).map((id) => ({ agentId: member.agentId ?? null, id }));
          });
          const auditRows =
            scoped &&
            typeof scoped === 'object' &&
            Array.isArray((scoped as { cohortAudit?: { rows?: unknown[] } }).cohortAudit?.rows)
              ? (scoped as { cohortAudit: { rows: Array<Record<string, unknown>> } }).cohortAudit.rows
              : [];
          hydrated.integrityWarnings = auditRows
            .filter((row) => row.reopenRecommended === true || row.bucket === 'missing')
            .map((row) => ({
              id: row.id,
              title: row.title ?? null,
              state: row.state ?? null,
              evidenceVerdict: row.evidenceVerdict ?? null,
              reopenRecommended: row.reopenRecommended === true,
              recommendation: row.recommendation ?? null,
            }));
        } catch {
          hydrated.scopedBurndown = null;
        }
      } else {
        hydrated.scopedBurndown = {
          available: false,
          reason: cohortIds ? 'claim-spec-harness-unresolved' : 'claim-spec-not-a-fixed-id-cohort',
        };
      }
      try {
        hydrated.walls = await call('coord:walls', {
          ...(args.harness ? { harness: args.harness } : {}),
        });
      } catch {
        hydrated.walls = null;
      }
      result.leaderBrief = hydrated;
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
      })) as { results?: OrientMemoryHit[]; degraded?: boolean; reason?: string; degraded_reason?: string } | undefined;
      const rawHits = (mem?.results ?? []).slice(0, memLimit).map((r) => ({
        id: r.id,
        memory: typeof r.memory === 'string' ? r.memory.slice(0, MEMORY_TEXT_CAP) : undefined,
        score: r.score,
      }));
      // EI-9031 markers first — the floor below is REGIME-SCOPED on them.
      const memDegraded = mem?.degraded === true;
      const memDegradedReason = mem?.degraded_reason ?? mem?.reason;
      // EI-10666: the consumer-admission gates (relevance floor → queen-loop withhold →
      // aggregate char budget) live in ONE shared module, because the memory recall canary
      // must probe THE PATH A CONSUMER ACTUALLY TAKES. A canary that re-implemented these
      // gates would drift from them and go green while orient's fold went dark — the exact
      // failure it exists to catch. See lib/memory/recall-admission.ts.
      // P-002 / D-001: a responsive caller doesn't receive queen-loop steering as a binding
      // recall hit (it self-drained fleet leaders). Auto callers keep all.
      const { admitted, filteredLowScore, withheld, withheldBudget, decisions } = admitRecallHits(rawHits, {
        degraded: memDegraded,
        withhold: (hs) => withholdQueenLoopControl(hs, driveMode, (h) => ({ body: h.memory })),
      });
      // EI-10619 — SHIP THE DECISIONS. `tool_invocations` records that orient returned ok; it
      // cannot see that the relevance floor discarded every hit on the way. That blind spot IS
      // EI-10372, and it is why a gate's decision has to be an event of its own. Fire-and-forget,
      // dynamic import, never load-bearing: a telemetry outage must never fail an orientation.
      if (decisions.length > 0) {
        void (async () => {
          try {
            const [{ getOrgPg }, { recordGateDecisions }] = await Promise.all([
              import('@papercusp/db-org'),
              import('../../../gates/decision'),
            ]);
            await recordGateDecisions(getOrgPg().sql, decisions);
          } catch {
            /* never load-bearing */
          }
        })();
      }
      result.memory = {
        query: memQuery,
        hits: admitted,
        ...(withheld > 0 ? { withheld } : {}),
        ...(filteredLowScore > 0 ? { filteredLowScore } : {}),
        ...(withheldBudget > 0 ? { withheldBudget } : {}),
        // P-003: the non-exhaustive advisory rides ONLY a non-empty fold (zero
        // noise on the empty path).
        ...(admitted.length > 0 ? { note: ORIENT_MEMORY_NOTE } : {}),
        ...(memDegraded ? { degraded: true, ...(memDegradedReason ? { degradedReason: memDegradedReason } : {}) } : {}),
      };
      // P-002 (memory-delivery-unification-2026-07-12 D-006): stamp the
      // orient-DELIVERED hits on the session-epoch surfaced-ledger, keyed by
      // the caller's ownerId (the same per-launch SID the MCP initialize
      // prelude and the injection ports key on) — so orient-then-hook/port
      // never double-injects the same memory within an epoch. Fire-and-forget,
      // dynamic imports: never load-bearing for orientation. Only ADMITTED ids
      // stamp (orient-recall-quality P-002): a budget-dropped hit was never
      // delivered, so it must stay eligible at the next injection port.
      if (ownerId && admitted.length > 0) {
        const stampIds = admitted
          .map((h) => h.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (stampIds.length > 0) {
          const sid = ownerId;
          void (async () => {
            try {
              const [{ getOrgPg }, ledger] = await Promise.all([
                import('@papercusp/db-org'),
                import('../../../memory/session-epoch-ledger'),
              ]);
              const { sql } = getOrgPg();
              const epoch = await ledger.currentSessionEpoch(sql, sid);
              await ledger.stampSurfaced(sql, sid, epoch, stampIds, 'orient');
            } catch {
              /* never load-bearing */
            }
          })();
        }
      }
    } catch {
      result.memory = null;
    }
  }

  // ── the caller's fleet (coord:whoami) — resolved ONCE, hoisted ABOVE the facts
  // fold because the P-007 audience filter needs it there; reused by the fleet
  // legs and the announced-gates fold below (EI-9270). A monitor tick reuses the
  // handler's already-resolved authoritative membership instead of paying a
  // coord:whoami sub-call; full mode keeps the existing whoami fold.
  let fleetSlug: string | null = monitor ? (fleetMembership?.fleetSlug ?? null) : null;
  if (!monitor) {
    try {
      const who = (await call('coord:whoami', {})) as { fleetSlug?: string | null } | undefined;
      fleetSlug = who?.fleetSlug ?? null;
    } catch {
      fleetSlug = null;
    }
  }

  // ── standing-facts fold (queen-memory-hybrid L1c) — the deterministic sibling of
  // the fuzzy memory recall above: scoped conclusions delivered VERBATIM every
  // orient (workspace + this owner + the named harness). BEST-EFFORT like every
  // other leg — a facts outage must never break orientation. EI-8300: skipped
  // entirely on a monitor tick (a leader loop re-reads its own steering facts on
  // every wake for no reason — it already has them from an earlier full orient).
  if (!monitor)
    try {
      const { foldFacts, renderFactSrc, factCitationRef } = await import('../../../agent-facts/store');
      const selectors = [
        { scope: 'workspace' as const },
        ...(ownerId ? [{ scope: 'owner' as const, scopeRef: ownerId }] : []),
        ...(args.harness ? [{ scope: 'harness' as const, scopeRef: args.harness }] : []),
      ];
      // P-007: filter by the RECIPIENT's audience — an audience-scoped fact
      // (audienceScope 'fleet:<slug>') folds only for that fleet's members;
      // a non-fleet caller receives only unrestricted facts.
      const facts = await foldFacts(selectors, {
        audiences: fleetSlug ? [`fleet:${fleetSlug}`] : [],
      });
      // P-002 / D-001: withhold queen-loop steering facts (pauseNewWork/maxBees) from
      // an OWNER-DIRECTED (responsive) caller — filter the RAW facts (key + body both
      // inspected) BEFORE projecting, so the structural `queen-loop:` key convention
      // works alongside the body-vocabulary net. Auto callers keep every fact.
      const { kept, withheld } = withholdQueenLoopControl(facts, driveMode, (f) => ({ key: f.key, body: f.body }));
      if (kept.length > 0) {
        // EI-10947: a fact anchored to a work-item that has since CLOSED is still folded
        // here verbatim, as binding context. If it was a carry-note ("NEXT: implement
        // EI-10539") that is now an instruction to REDO finished work — the exact failure
        // that cost su-71d9f8a2 a wasted re-implementation. Mark it (never auto-retract:
        // a durable conclusion the closed item PROVED stays true — see stale-source.ts).
        // Fail-soft: markStaleSourceFacts returns the facts unmarked on any lookup error.
        const { markStaleSourceFacts } = await import('../../facts/stale-source');
        const marked = await markStaleSourceFacts(kept);
        // P-008 (b): re-check DECLARED cell dependencies. This is where D-007's
        // "auto-invalidates ... so no agent has to remember to retract" actually
        // lands — orient runs on every wake, so an assumption whose ground moved
        // is flagged to its author without anyone having to think to look.
        //
        // The cost is proportionate BY CONSTRUCTION: zero dispatches when no
        // folded fact declared a dependency (every fold today), and otherwise
        // one dispatch per DISTINCT cell across the whole fold — not per fact.
        // An agent that files an assumption buys the re-check; nobody else pays.
        // Fail-soft twice over: markStaleDependencyFacts returns facts unmarked
        // on any failure, and this catch covers the imports themselves.
        let withDeps: Array<(typeof marked)[number] & { depsStale?: FactDependencyStaleness }> = marked;
        if (cellIdentity && marked.some((f) => f.dependsOn?.length)) {
          try {
            const { markStaleDependencyFacts } = await import('../../facts/dependency-staleness');
            withDeps = await markStaleDependencyFacts(marked, cellIdentity.reader, cellIdentity.env);
          } catch {
            withDeps = marked;
          }
        }
        // P-008 (c) / D-012: facts are a WATERMARK SURFACE. The fold above stays a
        // FULL read — that is the property D-012 chose watermarks for ("read with
        // watermark 0 and you get current state", so a compacted/respawned agent is
        // correct immediately). What the cursor adds is the separate question layered
        // on top: which of these did I not already have? Marked per-fact below.
        //
        // Best-effort and non-fatal by construction: a watermark outage must degrade
        // to today's unmarked full fold, never break orientation.
        let changedCells: ReadonlySet<string> = new Set();
        if (ownerId) {
          try {
            const [{ factsCellDelta, FACTS_CELL_SURFACE }, { readWatermark, writeWatermark }] = await Promise.all([
              import('../../../agent-facts/cells'),
              import('../watermarks'),
            ]);
            const wm = await readWatermark(ownerId);
            const delta = factsCellDelta(withDeps, wm.cursors?.[FACTS_CELL_SURFACE]);
            changedCells = new Set(delta.changed.map((f) => `${f.scope} ${f.scopeRef ?? ''} ${f.key}`));
            // Advance deterministically at fold time, like messages_shown_ts (EI-2042)
            // rather than at turn end: the agent HAS been shown these. Only write when
            // the position actually moved, so a quiet fold costs no row write.
            if (delta.nextCursor && delta.nextCursor !== wm.cursors?.[FACTS_CELL_SURFACE]) {
              await writeWatermark(ownerId, { cursors: { [FACTS_CELL_SURFACE]: delta.nextCursor } });
            }
          } catch {
            changedCells = new Set();
          }
        }
        result.facts = withDeps.map((f) => ({
          scope: f.scope,
          ref: f.scopeRef,
          body: f.body,
          // P-007: provenance-hydrated src — a verified typed sourceRef renders its
          // platform-captured verbatim quote (`msg:x ✓ "…"`); an unresolvable one
          // renders LOUDLY (`✗unverified`); free-text anchors pass through as before.
          src: renderFactSrc(f) || null,
          ...(f.audienceScope ? { aud: f.audienceScope } : {}),
          ...(f.sourceStale ? { stale: f.sourceStale } : {}),
          // P-008 (b): kept DISTINCT from `stale` above. `stale` is a hint (the
          // anchoring work-item closed); `dependsStale` is a mechanical verdict
          // on a dependency the fact's own author declared.
          ...(f.depsStale ? { dependsStale: f.depsStale } : {}),
          // P-018: the MODALITY, which this projection dropped — so a normative
          // convention arrived here byte-identical to a settled conclusion, at
          // the one surface every agent reads every wake. Same whitelist defect
          // P-033 (e) found in `toAgentMessageRow`: the field was stored and the
          // reader simply never selected it.
          //
          // Emitted ONLY when declared, so the common case (a legacy fact with
          // no kind) stays byte-identical and this costs the fold nothing.
          ...(f.kind ? { kind: f.kind } : {}),
          // P-008 (c) / D-012: asserted or superseded since this caller last
          // oriented. Emitted ONLY when true, so an unchanged fold — and every
          // bootstrap read, which marks nothing — stays byte-identical to before.
          ...(changedCells.has(`${f.scope} ${f.scopeRef ?? ''} ${f.key}`) ? { changed: true as const } : {}),
          ...(f.kind === 'convention'
            ? {
                // D-016's tier — and `cite`, the ref to pass verbatim as a
                // `premises` entry at the point of action (D-075 R1). Without it
                // the fold could name a convention it gave you no way to cite.
                ...(f.enforcement ? { enforcement: f.enforcement } : {}),
                cite: factCitationRef(f),
              }
            : {}),
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
        } catch {
          /* fail-open: full delivery */
        }
      }
      result.planEvents = unchanged ? { total, recent: [], unchanged: true } : { total, recent };
    } catch {
      result.planEvents = null;
    }
  }

  // ── WI-5228 (kickoff-prompt-absorption-2026-07-17 P-002): orient-first plan
  // bootstrap. Resolve the EFFECTIVE plan slug — the explicit arg, else (for a
  // plan-BOUND session that didn't repeat it) the SELF row's `declaredPlanSlug`
  // already sitting on `me` (fleet:assignments' presence-sourced "self-declared
  // current plan" — no extra IO: reusing the SAME leg fetched + bounded above,
  // never a fresh session-brief/DB read of our own) — then fold that plan's
  // `## Now` block, the next actionable item, and the caller's own claim state
  // within it. `myClaims` is ALSO derived from `me`. This costs exactly one
  // extra call (plans:get) on the common plan-bound path. EI-8300: skipped on a
  // monitor tick like the other plan/fleet legs. WI-3818: bounded like every
  // other fan-out leg — a slow plans:get must never block orient past budget.
  if (!monitor) {
    type SelfAgentRow = {
      isSelf?: boolean;
      declaredPlanSlug?: string | null;
      claims?: Array<{ planSlug: string | null; id: string | null }>;
    };
    const meAgentsForPlan = (me as { agents?: SelfAgentRow[] } | undefined)?.agents ?? [];
    const selfRow = meAgentsForPlan.find((a) => a.isSelf);
    const planNowResult = await withBoundedTimeout(
      (async () => {
        const effectivePlanSlug: string | null = args.planSlug ?? selfRow?.declaredPlanSlug ?? null;
        if (!effectivePlanSlug) return null;
        const planRes = (await call('plans:get', {
          slug: effectivePlanSlug,
          ...(args.harness ? { harness: args.harness } : {}),
        })) as
          | {
              results?: Array<{
                now?: { state?: string | null; next?: string | null } | null;
                items?: Array<{
                  id: string;
                  text: string;
                  phase?: string | null;
                  effectiveStatus?: string;
                  unresolvedBlockers?: unknown[];
                  needsHuman?: boolean;
                }>;
              }>;
            }
          | undefined;
        const p = planRes?.results?.[0];
        if (!p) return null;
        const nextActionableItem =
          (p.items ?? []).find(
            (it) =>
              it.effectiveStatus === 'todo' &&
              (it.unresolvedBlockers?.length ?? 0) === 0 &&
              !it.needsHuman,
          ) ?? null;
        const myClaims = (selfRow?.claims ?? [])
          .filter((c) => c.planSlug === effectivePlanSlug && c.id)
          .map((c) => c.id as string);
        return {
          planSlug: effectivePlanSlug,
          state: p.now?.state ?? null,
          next: p.now?.next ?? null,
          nextActionable: nextActionableItem
            ? { id: nextActionableItem.id, title: nextActionableItem.text, phase: nextActionableItem.phase ?? null }
            : null,
          myClaims,
        };
      })(),
      {
        fallback: null as OrientResult['planNow'],
        timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
        label: 'orient:planNow',
      },
    );
    result.planNow = planNowResult.value;
  }

  // ── fleet legs (full mode only) — the caller's fleet was resolved ONCE above
  // (hoisted for the P-007 facts audience filter); here it folds two bounded
  // slices for a fleet member: (1) catch-up = "what did my fleet say while I was
  // away" (the pull counterpart to @fleet: broadcasts, NOT auto-polled), and
  // (2) fleet-health = the coord:glance health subset agents otherwise re-fetch
  // right after orient (compaction-fold-audit-2026-07-06 — 44%+ did). Both gated
  // + BEST-EFFORT: a non-fleet caller or any failure degrades to absent/null.
  // EI-8300: skipped entirely on a monitor tick (both legs).
  // (fleet-messaging-integrate-and-land P-006)
  // ── fleet CONTROL STATE (P-009 / H4) — folded UNGATED by the catch-up/health
  // flags: a winding-down fleet must reach every member orient, especially a
  // LATE JOINER who never saw the wind-down cue. Only a non-'active' state is
  // surfaced (zero noise on the common path). BEST-EFFORT + dynamic import
  // (orient's static graph unchanged); skipped on a monitor tick like the
  // other fleet legs (a leader's monitor loop reads fleet:status itself).
  if (!monitor && fleetSlug) {
    try {
      const [{ getFleet }, { activeWorkspaceId }] = await Promise.all([
        import('../../../agent-fleets-store'),
        import('../../../workspace-registry'),
      ]);
      // composeOrient carries no ctx (IO arrives injected / dynamically imported,
      // like the facts fold above) — the process-active workspace is the same
      // fallback resolveFleetCaller uses for the registry writes.
      const ws = activeWorkspaceId();
      const fleet = ws && ws !== '*' ? await getFleet(ws, fleetSlug) : null;
      if (fleet && fleet.controlState !== 'active') {
        result.fleetControl = {
          fleet: fleetSlug,
          state: fleet.controlState,
          reason: fleet.controlReason,
          by: fleet.controlBy,
          since: fleet.controlAt,
        };
      }
    } catch {
      /* best-effort — a registry hiccup must never break orientation */
    }
  }

  if (!monitor && (args.includeFleetCatchUp !== false || args.includeFleetHealth !== false)) {
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
          } catch {
            /* fail-open: full delivery */
          }
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

  // ── Announced gate events (EI-9270) — declared-but-unfired gates visible to this
  // caller's fleet/plan/harness (+ global): the zero-message "what should I await".
  // BEST-EFFORT (absent on any failure). Monitor ticks intentionally KEEP this
  // compact fold: a newly-declared gate is an actionable fleet transition, not
  // heavyweight bootstrap context. TIME-BOUNDED:
  // a hung PG read degrades to absent within its own short budget (a discovery
  // nicety must never stall orientation — the WI-3818 bounded-leg contract).
  try {
    const annsResult = await withBoundedTimeout(listActiveAnnouncements({ unfiredOnly: true, limit: 50 }), {
      fallback: [] as Awaited<ReturnType<typeof listActiveAnnouncements>>,
      timeoutMs: 1_500,
      label: 'orient:announcedGates',
    });
    const anns = annsResult.value ?? [];
    const visible = anns
      .filter((a) =>
        announcementVisibleTo(a, {
          fleetSlug,
          planSlug: args.planSlug ?? null,
          harnessSlug: args.harness ?? null,
        }),
      )
      .slice(0, 8);
    if (visible.length > 0) {
      result.announcedGates = visible.map((a) => ({
        event: a.eventKey,
        note: a.note,
        scope: a.scopeKind ? `${a.scopeKind}${a.scopeRef ? ':' + a.scopeRef : ''}` : 'global',
        announcedBy: a.subscriberId,
        expires_ts: a.expiresTs,
      }));
    }
  } catch {
    /* best-effort — never break orientation */
  }

  // ── role-specific pane folds (voice-public-release-readiness-2026-07-12 P-016) —
  // injected by the handler ONLY for the papercup / papercup-deep dock-pane roles in
  // full mode (orientRoleFolds). BEST-EFFORT + TIME-BOUNDED like every other leg:
  // withBoundedTimeout NEVER throws (WI-3818), so a slow or failing gather degrades
  // to null instead of breaking orientation.
  if (roleFolds?.paneContext) {
    const pc = await withBoundedTimeout(roleFolds.paneContext, {
      fallback: null as string | null,
      timeoutMs: ORIENT_PANE_CONTEXT_TIMEOUT_MS,
      label: 'orient:paneContext',
    });
    result.paneContext = pc.value;
  }
  if (roleFolds?.deepWork) {
    const dw = await withBoundedTimeout(roleFolds.deepWork, {
      fallback: null as NonNullable<OrientResult['deepWork']> | null,
      timeoutMs: ORIENT_FLEET_LEG_TIMEOUT_MS,
      label: 'orient:deepWork',
    });
    result.deepWork = dw.value;
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
        context: {
          ...(fleetMembership?.fleetSlug ? { fleet: fleetMembership.fleetSlug } : {}),
          ...(args.planSlug ? { plan: args.planSlug } : {}),
          ...(args.harness ? { harness: args.harness } : {}),
          ...(args.planItems?.length ? { items: args.planItems } : {}),
        },
      })) as
        | { recipes?: Array<{
            id?: unknown;
            title?: unknown;
            runCount?: unknown;
            similarity?: unknown;
            authorityRefs?: unknown;
            runArgs?: unknown;
          }> }
        | undefined;
      result.recipes = (rec?.recipes ?? []).slice(0, recLimit).map((r) => ({
        id: r.id,
        title: typeof r.title === 'string' ? r.title.slice(0, RECIPE_TITLE_CAP) : undefined,
        runCount: r.runCount,
        similarity: r.similarity,
        ...(r.authorityRefs && typeof r.authorityRefs === 'object' ? { authorityRefs: r.authorityRefs } : {}),
        ...(r.runArgs && typeof r.runArgs === 'object' ? { runArgs: r.runArgs } : {}),
      }));
    } catch {
      result.recipes = null;
    }
  }

  // (WI-5951) The open-unanswered-questions fold that used to live here — the PULL
  // half of Q&A from WI-5807 / P-007 — was REMOVED, deliberately, by the same author.
  // It surfaced orphaned peer questions to agents at wake. coord:ask now REQUIRES a
  // recipient, so orphans can no longer be created, and the only questions left are
  // coord:ask-owner ones the OWNER must answer — pushing those at agents would be
  // noise they are not able to act on. Owner-directed questions belong in coord:walls
  // (the "what needs me" surface), not in every agent's wake.

  // ── release-pipeline health (WI-4533 / P-006): can what I'm about to write actually SHIP?
  // Folded in BOTH modes — a monitor tick is precisely where a leader wants the gate's colour —
  // and awaited LAST so the read (kicked off by the handler before any of the legs above) has been
  // running in the background the whole time. Bounded + fail-soft: a slow/failed pipeline read
  // drops the leg, never the orientation.
  if (pipelineFold) {
    const p = await withBoundedTimeout(pipelineFold(), {
      fallback: null as OrientPipeline | null,
      timeoutMs: ORIENT_PIPELINE_TIMEOUT_MS,
      label: 'orient:pipeline',
    });
    if (p.value) result.pipeline = p.value;
  }

  // P-015: gate + release snapshots ride the same hydrated leader brief as
  // member health/claim spec/walls. Keep the established top-level fields too
  // for compatibility: one authoritative read, two projections, no new API.
  if (monitor && result.leaderBrief && typeof result.leaderBrief === 'object') {
    Object.assign(result.leaderBrief as Record<string, unknown>, {
      announcedGates: result.announcedGates ?? [],
      release: result.pipeline ?? null,
    });
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

/** WI-5656 + EI-18689334534773965: assembles the final coord:orient response
 *  object with RESULT-DOOR-AWARE key priority. result-door.ts
 *  (`capInjectionText`) caps the FINAL serialized JSON text at a per-result
 *  token budget and keeps only the HEAD, spilling whatever comes after the
 *  cut to scratch — so KEY INSERTION ORDER in this object literal directly
 *  determines what survives in-context.
 *
 *  Priority, highest first:
 *   1. `self` + `recovery` — the one thing a just-compacted successor cannot
 *      get any other way (held-item checkpoints, armed-loop status,
 *      staleness warnings, the self-recall pointer). A just-compacted
 *      agent's MOST fragile turn.
 *   2. The CORE mandate result — `ok` / `me` (assignments) / `claimable`
 *      (backlog) / `inbox` (summary): the entire reason coord:orient is
 *      billed as a one-round-trip bootstrap. EI-18689334534773965: these
 *      previously rode inside `legs.result` spread dead LAST (behind every
 *      preamble leg below), so a large ownerDirectives/instructionPrecedence/
 *      taskToolSchemaPack routinely starved them — degrading the "bootstrap
 *      in ONE call" promise into 3-4 follow-up calls (coord:inbox,
 *      fleet:assignments, work_items:list) to rebuild what orient was
 *      supposed to hand over, on the exact turn (post-compaction) an agent
 *      has the least context left to notice the gap.
 *   3. `ownerDirectives` / `modes` / `instructionPrecedence` / `ideate` /
 *      `captureMiss` / `configIntegrity` / `codexLocks` / `taskToolSchemaPack`
 *      — all re-delivered on subsequent turns via the system prompt +
 *      CTRL:transition (or cheaply re-fetchable), so they are the right
 *      things to spill when the door truncates.
 *   4. The REST of `result` (leaderBrief, memory, planEvents, fleetCatchUp,
 *      fleetHealth, announcedGates, paneContext, deepWork, recipes,
 *      pipeline, intentDeclared, fleetDelta, ownerPresent) — genuinely
 *      discretionary supplementary folds, each independently re-fetchable
 *      (memory:search, coord:plan-events, coord:catch-up, …) and the least
 *      costly to lose. Lowest priority, stays last.
 *
 *  Exported (pure, no IO) so a regression test can assert the ordering
 *  directly against the real assembly code, not a mirrored fixture. */
export function assembleOrientOutput(legs: {
  self?: unknown;
  recovery?: unknown;
  presenceDrift?: unknown;
  ownerDirectives?: unknown;
  modes?: unknown;
  instructionPrecedence?: unknown;
  ideate?: unknown;
  captureMiss?: unknown;
  configIntegrity?: unknown;
  codexLocks?: unknown;
  taskToolSchemaPack?: unknown;
  result: object;
}): Record<string, unknown> {
  // EI-18731216945970087: `presenceDrift` is destructured OUT here (like ok/me/
  // claimable/inbox) so it rides ONLY the prioritized `legs.presenceDrift` slot
  // below, not also `resultRest` at the bottom — it is a rare, small, safety-
  // critical diagnostic that must survive the result-door's truncation, not get
  // buried behind leaderBrief/memory/planEvents.
  const { ok, me, claimable, inbox, presenceDrift: _presenceDriftFromResult, ...resultRest } =
    legs.result as Record<string, unknown>;
  return {
    ...(legs.self ? { self: legs.self } : {}),
    ...(legs.recovery ? { recovery: legs.recovery } : {}),
    // CORE mandate (EI-18689334534773965) — prioritized ahead of the
    // discretionary preamble legs below; see the doc comment above.
    ...(ok !== undefined ? { ok } : {}),
    ...(me !== undefined ? { me } : {}),
    ...(claimable !== undefined ? { claimable } : {}),
    ...(inbox !== undefined ? { inbox } : {}),
    // EI-18731216945970087: a presence/registry leadership DRIFT diagnostic — kept
    // LOUD and high-priority (never silently spilled) precisely because its whole
    // point is to replace a silent leaderBrief omission with something a leader
    // cannot miss.
    ...(legs.presenceDrift ? { presenceDrift: legs.presenceDrift } : {}),
    ...(legs.ownerDirectives ? { ownerDirectives: legs.ownerDirectives } : {}),
    ...(legs.modes ? { modes: legs.modes } : {}),
    ...(legs.instructionPrecedence ? { instructionPrecedence: legs.instructionPrecedence } : {}),
    ...(legs.ideate ? { ideate: legs.ideate } : {}),
    ...(legs.captureMiss ? { captureMiss: legs.captureMiss } : {}),
    ...(legs.configIntegrity ? { configIntegrity: legs.configIntegrity } : {}),
    ...(legs.codexLocks ? { codexLocks: legs.codexLocks } : {}),
    ...(legs.taskToolSchemaPack ? { taskToolSchemaPack: legs.taskToolSchemaPack } : {}),
    ...resultRest,
  };
}

export default defineTool({
  name: 'coord:orient',
  description:
    'One agent wake-orientation + session-bootstrap read: your assignments (+lane+load), ' +
    'the claimable backlog, your inbox summary, and the recent plan-events delta — plus, with ' +
    '`intent`, a memory recall AND a coord:declare-intent so peers see you. The mandated bootstrap ' +
    '(memory:search + coord:inbox + coord:plan-events + declare + assignments + claimable) in ONE ' +
    'round-trip; a fleet member also gets a compact fleet-health glance.',
  guidance: {
    when:
      'At the START of a turn / on waking. Pass `intent` (your one-line task) for the whole ' +
      'bootstrap in ONE round-trip: assignments + claimable + inbox + plan-events + a memory recall ' +
      '+ your intent DECLARED to peers. Omit `intent` for a lighter re-orientation. On a repeating ' +
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
      '`recipes` hit → recipes:run it. → work_items:pickup { id, intent }. claimable[] is advisory (EI-6468).',
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
    harness: z
      .string()
      .max(80)
      .optional()
      .describe('Scope assignments + claimable + recall + declare to this harness.'),
    claimableState: z.string().max(40).optional().describe("Work-item state for the claimable list (default 'open' — the unified claimable token)."),
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
      .describe(
        'Your one-line intent for this turn — DECLARED to peers (coord:declare-intent) AND used as the memory:search recall query. The bootstrap-in-one-call lever.',
      ),
    memoryQuery: z
      .string()
      .max(500)
      .optional()
      .describe('Explicit memory:search query (overrides `intent` for recall).'),
    planSlug: z.string().max(120).optional().describe('Plan slug for the declared lane (used with `intent`).'),
    planItems: z
      .array(z.string().max(20))
      .max(40)
      .optional()
      .describe('Plan items to claim as your lane (used with `intent` + `planSlug`).'),
    memoryLimit: z.number().int().positive().max(10).optional().describe('Max memory hits to fold (default 5).'),
    includePlanEvents: z.boolean().optional().describe('Fold the recent plan-events delta (default true).'),
    planEventsSince: z.string().optional().describe('Only plan-events strictly after this ISO timestamp.'),
    includeRecipes: z
      .boolean()
      .optional()
      .describe('Surface reusable code:run recipes relevant to `intent` (default true).'),
    recipesLimit: z
      .number()
      .int()
      .positive()
      .max(5)
      .optional()
      .describe('Max relevant recipes to surface (default 3).'),
    includeFleetCatchUp: z
      .boolean()
      .optional()
      .describe(
        "Fold a bounded catch-up of YOUR fleet's audience-history when you're in a named fleet (default true).",
      ),
    fleetCatchUpLimit: z
      .number()
      .int()
      .positive()
      .max(25)
      .optional()
      .describe('Max fleet catch-up messages to fold (default 8).'),
    includeFleetHealth: z
      .boolean()
      .optional()
      .describe(
        "Fold a COMPACT fleet-health glance (bees running/working, staged wakes, paused governor buckets) when you're in a named fleet (default true; full mode only) — the coord:glance health read agents otherwise re-fetch right after orient.",
      ),
    afterCompaction: z
      .boolean()
      .optional()
      .describe(
        'Pass true on your FIRST orient after a compaction: folds a recovery block — your held work-items’ checkpoints, armed-loop status, staleness_warnings (presence/fleet/claims that changed AFTER your summary was written — the summary’s view of them is stale), and the self-recall pointer (pre-compaction turns are searchable via sessions:search { session:’self’ }).',
      ),
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
    // P-015: leadership is mutable at runtime (fleet:take-leadership / join / leave),
    // but PAPERCUSP_FLEET_* is immutable launch context. Resolve the live presence
    // row first so a newly-installed leader gets the WHOLE fleet brief and a caller
    // that left a fleet does not resurrect stale membership. Only a failed presence
    // read may fall back to launch context.
    const fleetMembership = await resolvePresenceFleet(ownerId, deriveFleetMembership());
    // EI-18731216945970087: a resolvable FLEET LEADER on a monitor tick was seeing
    // `agents:1` (agents:'me' is BY DESIGN caller-scoped — see OrientResult.me) with
    // `leaderBrief` silently ABSENT — byte-indistinguishable from "all quiet" — because
    // presence (coord_presence.fleet_slug/fleet_role, the SOFT membership label
    // resolvePresenceFleet reads) had no row for this caller at the moment of the read,
    // even though `harness_shared.agent_fleets.leader_owner_id` (the durable, single-
    // leader-invariant REGISTRY fact `fleet:take-leadership` writes FIRST — see
    // take-leadership-core.ts step 1) already named them leader. Ground-truthed
    // (fleet:assignments{fleet:<slug>} showed the same caller as live leader in the
    // same window) — a presence/registry disagreement, not a "not a leader" verdict.
    // composeOrient cross-checks the registry via this INJECTED closure (IO stays out
    // of composeOrient, the established pattern for every other fold) — cheap (one
    // indexed lookup on a tiny table) and only actually queried by composeOrient when
    // presence resolved to NO fleet at all in monitor mode (the exact failure shape
    // reported), so every correctly-labeled member's monitor tick (the overwhelmingly
    // common case) pays no extra round-trip.
    const presenceDriftCheck = ownerId
      ? async () => {
          const { listFleetsLedBy } = await import('../../../agent-fleets-store');
          const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
          const led = await listFleetsLedBy(ws, ownerId);
          return led[0]?.fleetSlug ?? null;
        }
      : undefined;
    // ── role-specific pane folds (voice-public-release-readiness-2026-07-12 P-016):
    // the papercup FAST pane orients with the SAME live-system digest block the
    // converse brain walks in with (papercup-context.ts — one identity, one
    // picture), and the papercup-deep pane orients with its OPEN QUESTION THREAD
    // (directed messages awaiting its reply). The role comes from the dispatch ctx
    // (the signed launch role — same read as agent_tools/list.ts); the gate is the
    // PURE orientRoleFolds. Closures carry the IO (dynamic imports, best-effort)
    // and are INJECTED so composeOrient stays IO-free.
    const roleWants = orientRoleFolds((ctx as { role?: string | null }).role, args.mode);
    let roleFolds: OrientRoleFolds | undefined;
    if (roleWants.paneContext) {
      roleFolds = {
        paneContext: async () => {
          const [pc, { isWorkspaceCoordinationOn }] = await Promise.all([
            import('../../../papercup/papercup-context'),
            import('../../../workspace-brain-scope'),
          ]);
          const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
          // The primary hive the anomalies leg addresses — same resolution as the
          // converse-prompt consumer (first registered project, falling back to
          // the workspace id); an orient scoped by `harness` uses that directly.
          let primaryHive: string | null = args.harness ?? null;
          if (!primaryHive) {
            try {
              const { loadHarnessRegistry } = await import('../../../harness-registry');
              const reg = await loadHarnessRegistry(ws);
              primaryHive = reg.projects[0]?.slug ?? null;
            } catch {
              primaryHive = null;
            }
          }
          const potSlug = primaryHive ?? ws;
          // Heading scope LABEL only (workspace-scoped-coordination D-008) — the
          // anomalies leg's addressing stays potSlug, exactly like converse-prompt.
          const scopeLabel = pc.sentinelScopeLabel(ws, potSlug, await isWorkspaceCoordinationOn().catch(() => false));
          const input = await pc.gatherSentinelContext(pc.buildSentinelContextDeps(ws, potSlug), {
            potSlug: scopeLabel,
          });
          const block = pc.renderSentinelContext(input);
          return block.trim() ? block : null;
        },
      };
    }
    if (roleWants.deepWork && ownerId) {
      const oid = ownerId;
      roleFolds = {
        ...(roleFolds ?? {}),
        deepWork: async () => {
          const { fetchUnansweredDirected } = await import('../unanswered-directed');
          const summary = (await fetchUnansweredDirected([oid])).get(oid);
          if (!summary) return { count: 0, oldestAgeMs: 0, newest: [] };
          return {
            count: summary.count,
            oldestAgeMs: summary.oldestAgeMs,
            newest: summary.newest,
            ...(summary.count > 0 ? { note: ORIENT_DEEP_WORK_NOTE } : {}),
          };
        },
      };
    }
    // WI-4533 (P-006): START the pipeline-health read HERE — before composeOrient's sequential
    // legs — and hand composeOrient a closure over the in-flight promise. Its latency therefore
    // overlaps reads that were happening anyway (orient p50 1.75s; this leg is cached and usually
    // ~ms), instead of being added to them. `.catch(() => null)` is belt-and-braces: the fetch is
    // already fail-soft, but an unhandled rejection on a promise created early and awaited late
    // must be impossible.
    const pipelinePromise = (async () => {
      const { fetchOrientPipeline } = await import('../pipeline-health');
      return fetchOrientPipeline(args.harness ?? (ctx as { harnessSlug?: string | null }).harnessSlug ?? undefined);
    })().catch(() => null);
    const result = await composeOrient(
      args,
      // P-001 (orient-recall-quality-2026-07-12): the folded memory:search records
      // its recall telemetry under surface 'orient' (not generic 'search') so
      // orient's recall quality is measurable per-entry-point. Telemetry only.
      inProcessCall(ctx, { telemetrySurface: 'orient' }),
      ownerId,
      driveMode,
      ownerPresent,
      fleetCursor,
      planEventsCursor,
      fleetCatchUpCursor,
      fleetMembership,
      roleFolds,
      () => pipelinePromise,
      presenceDriftCheck,
      // P-008 (b): the identity the standing-facts fold re-checks declared cell
      // dependencies under. Best-effort — an unattributable caller (no ownerId)
      // gets no re-check rather than a read made under a guessed identity.
      (() => {
        try {
          if (!ownerId) return undefined;
          return cellReaderFromCtx({ ownerId }, ctx as CellReaderCtxLike);
        } catch {
          return undefined;
        }
      })(),
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
    let runtimeModeIds: string[] | null = null;
    if (ownerId) {
      try {
        const ws = (ctx as { workspaceId?: string | null }).workspaceId ?? 'default';
        const rows = await getModes(ws, ownerId);
        runtimeModeIds = rows.map((row) => row.mode);
        if (rows.length) {
          modes = {
            active: rows.map((r) => ({
              mode: r.mode,
              reason: r.reason,
              setBy: r.setBy,
              ownerDirected: r.ownerDirected,
              setAt: r.setAt,
            })),
            contracts: rows
              .map((r) => modeById(r.mode)?.contract)
              .filter(Boolean)
              .join('\n\n'),
          };
        }
      } catch {
        /* fail-soft */
      }
    }
    // P-022: the structured counterpart of the prose mode contracts. Resolve
    // the effective mission from canonical runtime mode + live fleet role +
    // durable session scope, and explicitly suppress generic rules that do not
    // apply now. A failed mode read omits the trace rather than falsely falling
    // back to confirm-first. The watermark is content-addressed; any mismatch
    // requires a full coord:orient replacement, never a partial merge.
    let instructionPrecedence: unknown;
    if (ownerId && runtimeModeIds) {
      try {
        const [{ buildInstructionPrecedenceTrace }, { getSessionBrief }] = await Promise.all([
          import('../../../instruction-lint'),
          import('../../../session-brief'),
        ]);
        const brief = await getSessionBrief({ ownerId });
        const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
        instructionPrecedence = buildInstructionPrecedenceTrace({
          source: 'coord:orient',
          ownerId,
          modes: runtimeModeIds,
          route: fleetMembership?.fleetSlug
            ? {
                kind: 'fleet',
                fleet: fleetMembership.fleetSlug,
                role: fleetMembership.fleetRole,
              }
            : { kind: 'self' },
          scope: {
            workspace: ws,
            harness: args.harness ?? brief?.harnessSlug ?? null,
            plan: args.planSlug ?? brief?.currentPlanSlug ?? null,
            items: args.planItems ?? [],
          },
        });
      } catch {
        /* fail-soft */
      }
    }
    // su-ideate-learning-substrate-2026-07-10 P-011: when the caller's active
    // modes include 'ideate', fold ONE line telling them whether they are OVERDUE
    // to run an ideate pass — keyed on OBSERVATION COUNT, never elapsed days
    // (D-015). Gated to ideate-active callers, fail-soft, a few indexed reads.
    // Same handler-side best-effort IO pattern as the modes fold above.
    let ideate: import('./orient-ideate-hint').IdeateHint | undefined;
    if (ownerId && modes?.active?.some((m) => m.mode === 'ideate')) {
      try {
        const { computeIdeateOverdue } = await import('./orient-ideate-hint');
        const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
        ideate = await computeIdeateOverdue({ ownerId, workspaceId: ws });
      } catch {
        /* fail-soft */
      }
    }
    // su-ideate-learning-substrate-2026-07-10 P-022(a): the capture-MISS advisory
    // (D-017). A high-signal turn — an error-retry cluster / EI-* reference /
    // durable-discovery language in the caller's boundary artifacts — that filed
    // ZERO lane:observation rows gets ONE advisory line. A NUDGE, never a quota
    // (D-017 rejects volume quotas). Fail-soft; the resolver short-circuits the
    // cost for anyone who already filed, and this is ATTACHED only when it fires
    // (a healthy session sees nothing).
    let captureMiss: import('./orient-capture-miss-hint').CaptureMissHint | undefined;
    if (ownerId) {
      try {
        const { resolveCaptureMissHint } = await import('./orient-capture-miss-hint');
        captureMiss = await resolveCaptureMissHint({ ownerId, harness: args.harness });
      } catch {
        /* fail-soft */
      }
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
        // EI-18162666491500151: bounded — a slow leg inside buildCompactionRecovery
        // (self-transcript ingest, held-items read, staleness scan) used to hang the
        // WHOLE orient call for the full 300s MCP tool-idle timeout; now degrades to
        // `undefined` (recovery omitted, same as the pre-existing catch contract)
        // within ORIENT_COMPACTION_RECOVERY_TIMEOUT_MS — the WI-3818 bounded-leg
        // contract every other orient fold already gets.
        const recoveryResult = await withBoundedTimeout(buildCompactionRecovery(ownerId, ws), {
          fallback: undefined,
          timeoutMs: ORIENT_COMPACTION_RECOVERY_TIMEOUT_MS,
          label: 'orient:buildCompactionRecovery',
        });
        recovery = recoveryResult.value;
      } catch {
        /* fail-soft */
      }
    }
    // WI-4562: a Claude Code config save (/model, /effort, theme) REWRITES the session's
    // settings.json from its own in-memory keys and drops every psu key — silently
    // de-enrolling the edit-LOCK hook, the coord inbox, turn-start recall, and the
    // SessionStart epoch bump, plus the papercusp-su MCP entry. The existing self-heals
    // cannot catch it: they live INSIDE the SessionStart hook whose registration the wipe
    // deletes. orient is the right detector precisely because it is operator-side and
    // needs no hooks — and because the repair takes effect in the RUNNING session
    // (hooks are re-read from the file), orient AUTO-REPAIRS rather than only warning:
    // the moment a de-enrolled session next orients, its capabilities are restored.
    // Reported ONLY when something was actually broken — a healthy session pays a couple
    // of file reads and adds no key.
    let configIntegrity: unknown;
    if (ownerId) {
      try {
        const { loadSessionConfigState, checkSessionConfigIntegrityForClient, repairSessionConfigOnDisk } =
          await import('../../../session-config-integrity');
        const state = loadSessionConfigState(ownerId);
        const recordedClient = (await (await import('../../../adv-sessions')).latestAdvSessionByCoordOwner(ownerId))
          ?.agent;
        const verdict = checkSessionConfigIntegrityForClient(state, recordedClient);
        if (verdict && !verdict.ok) {
          const repair = repairSessionConfigOnDisk(ownerId, undefined, recordedClient);
          configIntegrity = {
            ...verdict,
            repaired: repair.repaired,
            fixed: repair.fixed,
            wrote: repair.wrote,
            stillBroken: repair.stillBroken,
            residualCaveats: repair.residualCaveats,
            warning:
              repair.repaired && repair.stillBroken.length === 0
                ? 'YOUR SESSION WAS DE-ENROLLED (WI-4562) and has just been AUTO-REPAIRED. Claude Code had rewritten this session config and dropped psu-owned keys; orient restored them on disk. Hook registrations are re-read from the file, so delivery (edit-locks, coord inbox, turn-start recall) resumes WITHOUT a relaunch — verified live on su-5d6764f9, where the coord inbox delivered a 40+ message backlog immediately after repair. See residualCaveats for the two things a disk write cannot undo.'
                : 'YOUR SESSION IS RUNNING DE-ENROLLED (WI-4562) and auto-repair did NOT fully succeed — see stillBroken. Claude Code rewrote this session config and dropped psu-owned keys, so some capabilities above remain OFF. Repair manually via session-config-integrity.repairSessionConfigOnDisk, or relaunch.',
          };
        }
      } catch {
        /* fail-soft — never break orientation over a config read/repair */
      }
    }
    // EI-11408 / P-004: Codex's lock policy is a RUNTIME verdict, not a
    // static client assumption. Hooks merely present on disk remain manual
    // until this exact owner produces a successful owner-scoped hook decision;
    // a newer owner-scoped error flips it back to manual. This fold is the
    // after-launch authority and carries one effective instruction only.
    let codexLocks: unknown;
    if (ownerId) {
      try {
        const session = await (await import('../../../adv-sessions')).latestAdvSessionByCoordOwner(ownerId);
        if (session?.agent === 'codex') {
          const [{ readCodexHomeDiagnostics }, { readCodexLockRuntimeVerdict }] = await Promise.all([
            import('../../../role-codex-home'),
            import('../../../codex-lock-runtime'),
          ]);
          const home = readCodexHomeDiagnostics(session.id);
          const hooksConfigured =
            home.hooksExists &&
            home.diagnostics?.lockEnforcement === 'hooks-configured' &&
            (!home.diagnostics.lockOwnerSid || home.diagnostics.lockOwnerSid === ownerId);
          codexLocks = readCodexLockRuntimeVerdict({ ownerId, hooksConfigured });
        }
      } catch {
        /* fail-soft: prompt snapshot remains conservative/manual */
      }
    }
    // P-006 / EI-11409: derive the small tool set this task actually needs
    // from the active modes + declared scope + surfaced recipe context, then
    // grow the EXISTING per-session MCP surface. list_changed-capable clients
    // (Codex/OMP) re-fetch the real full schemas; the compact schema pack in
    // the response makes the same task resumable after compaction with no
    // tools:find/tools:invoke rediscovery tax. Every orient recomputes it, so a
    // mode/scope transition yields a new watermark and a post-compaction orient
    // reconstructs the same pack. Fail-soft: orientation remains usable if the
    // registry or client activation seam is unavailable during a rolling deploy.
    let taskToolSchemaPack: OrientResult['taskToolSchemaPack'];
    try {
      const { buildTaskToolSchemaPack } = await import('./orient-task-schema-pack');
      const pack = buildTaskToolSchemaPack({
        intent: args.intent ?? args.memoryQuery,
        modes: runtimeModeIds ?? [],
        harness: args.harness ?? (ctx as { harnessSlug?: string | null }).harnessSlug ?? null,
        plan: args.planSlug ?? null,
        planItems: args.planItems ?? [],
        recipeTitles: Array.isArray(result.recipes)
          ? result.recipes.flatMap((recipe) => (typeof recipe.title === 'string' ? [recipe.title] : []))
          : args.intent
            ? []
            : undefined,
      });
      let surfaceChanged: boolean | null = null;
      try {
        surfaceChanged = ctx.activateTools?.(pack.toolNames) ?? null;
      } catch {
        surfaceChanged = null;
      }
      taskToolSchemaPack = {
        ...pack,
        activation: { requested: true, surfaceChanged },
      };
    } catch {
      /* fail-soft */
    }
    // EI-11484: OPEN OWNER DIRECTIVES fold — every orient (full AND monitor;
    // orient is the mandated bootstrap, so this is how a SUCCESSOR session in
    // the workspace inherits an order whose recording session died). Rendered
    // by the shared budgeted renderer; fail-soft, absent when none are open.
    let ownerDirectives: string | undefined;
    try {
      const { renderOpenOwnerDirectivesBlock } = await import('../../../owner-directives');
      const ws = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
      ownerDirectives = (await renderOpenOwnerDirectivesBlock(ws)) ?? undefined;
    } catch {
      /* fail-soft */
    }
    const out = assembleOrientOutput({
      self,
      recovery,
      presenceDrift: result.presenceDrift,
      ownerDirectives,
      modes,
      instructionPrecedence,
      ideate,
      captureMiss,
      configIntegrity,
      codexLocks,
      taskToolSchemaPack,
      result: result as object,
    });
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
