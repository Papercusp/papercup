/**
 * scheduler:get_next — the bee's spec-driven self-select (hybrid-bee-scheduler-work-stealing-2026-06-22).
 *
 * The bee calls get_next; the resolver loads the bee's Queen-issued claim spec (mig 372
 * bee_claim_specs; DEFAULT_CLAIM_SPEC when none) and atomically claims the single next eligible
 * work-item: the GLOBAL FLOORS (ready/blocking, lease, admission, swarm-affinity, dedup) AND the
 * spec's view.filter, ordered by the spec's rank, FOR UPDATE SKIP LOCKED. The spec can only
 * narrow + reorder within the floors (D-002); it can never claim a blocked/taken item.
 *
 * The richer sibling of work_items:claim_next (which is plain oldest-first, spec-blind): here the
 * Queen's scheduling judgment, expressed as the bee's spec, decides WHICH item; pickup stays the
 * bee's (self-selection, the blackboard result).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { getPresence, writePresence } from '../coordination/presence';
import { COORD_ROLES } from '../coordination/roles';
import {
  getNextForBee,
  resolveClaimSpecWorkspace,
  getClaimSpecRecord,
  readClaimConcurrency,
} from '../../scheduler/claim-spec-store';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';
import { getBuildInfo } from '../../build-info';
import { assessClaimFreshness, type ClaimFreshnessVerdict } from '../../work-item-claim-freshness';
import { holderContextReader, resolveHolderAdvisoryMap } from '../coordination/holder-advisory';
import type { CellReader } from '../../cell-registry';
import { loadHarnessRegistry } from '../../harness-registry';
import { cancelClaimableAwaits } from '../../events/await/store';
import { withBoundedTimeout } from '../../bounded-timeout';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { liveLockedPaths } from '../locks/live-lock-paths';

/** The claimable-state subset diagnoseClaimNextMiss accepts (mirrors CLAIM_STATES_ALLOWLIST). */
type ClaimNextStates = ('open' | 'failing')[] | undefined;
import { matchRoutingGateHint } from '../../routing-gate-hints';
import {
  fleetScopedMiss,
  reconcileFleetScopeClaims,
  readFleetPauseState,
  diagnoseFleetScopeCooldownMiss,
  diagnoseFleetScopeIssueFloorMiss,
  diagnoseFleetScopeFeatureFamilyMatch,
  diagnoseFleetScopeTerminalExhaustion,
} from '../../scheduler/fleet-scope-admission';

/**
 * EI-20099413453852234 — declare the caller's intent for the item it just claimed.
 *
 * This tool CLAIMS an item but used to leave the claimant's declared intent untouched,
 * so from the instant of the claim `coord_presence` held a live claim beside a stale
 * intent and presence computed `intentDivergent: true` for an agent that was actively
 * mid-implementation. Peers use exactly that signal to judge whether a claim is real:
 * one read it and offered to take an item out from under its holder, who was mid-fix on
 * that very item. An agent in a get_next loop re-claims every wake, so its intent was
 * stale BY CONSTRUCTION unless it remembered a second, entirely optional call each time.
 * The divergence is also invisible from INSIDE the agent that causes it and visible only
 * to peers — the worst shape for a self-correcting signal — so it is fixed HERE, at the
 * claim, rather than left to per-agent discipline.
 *
 * ⚠ READ-MODIFY-WRITE, DELIBERATELY — do not "simplify" this to a bare write.
 * `PgPresenceStore.write()`'s ON CONFLICT sets `current_plan_slug = EXCLUDED.current_plan_slug`,
 * a BARE assignment, so a write that OMITS it CLEARS it. A naive `writePresence(ident,
 * { intent })` would therefore wipe the declared plan slug of every self-pulling agent on
 * every claim — strictly worse than the stale intent it set out to fix. Every OTHER field
 * is safe to omit: `currentFiles` is COALESCEd against the existing row, `agentRole` /
 * `potSlug` / `capabilityTags` are populate-once-then-keep, and `host` / `pid` / `tty`
 * reset-then-repopulate from the psu supervisor beat by design.
 *
 * Fail-soft, like the `cancelClaimableAwaits` call it sits beside: the claim is already
 * COMMITTED by the time this runs, so dropping the caller's result over a presence hiccup
 * would be far worse than a stale intent.
 */
async function declareIntentForClaim(
  identity: AgentIdentity,
  workItem: unknown,
  harnessSlug?: string | null,
): Promise<void> {
  const wi = workItem as { id?: string | null; title?: string | null } | null;
  const id = typeof wi?.id === 'string' && wi.id.length > 0 ? wi.id : null;
  if (!id) return;
  const prev = await getPresence(identity.ownerId).catch(() => null);
  // Never clobber an intent the caller set DELIBERATELY for this same item: a re-pull of
  // an item you already declared should keep your richer wording, not flatten it to the
  // generated form. Also makes the write idempotent across repeated claims of one item.
  if (prev?.intent && prev.intent.includes(id)) return;
  const title = typeof wi?.title === 'string' ? wi.title.trim() : '';
  const clipped = title.length > 120 ? `${title.slice(0, 119)}…` : title;
  await writePresence(
    identity,
    {
      intent: clipped ? `${id}: ${clipped}` : id,
      // The one field that MUST be carried — see the ON CONFLICT note above.
      currentPlanSlug: prev?.currentPlanSlug ?? null,
    },
    harnessSlug ?? null,
  );
}

/**
 * P-006/P-007 (composable-event-awaits-2026-07-11): the idle-puller recipe, delivered at
 * the exact moment it applies — an EMPTY pull. Retires the ~60s idle re-poll cadence:
 * park on ONE await over the canonical `work-item:claimable` key (P-007 dual-emit — it
 * fires on every created-unclaimed / claim-released / last-blocker-cleared transition,
 * collapsing the 3-leaf composed any-spec this recipe originally taught; payload carries
 * {id,kind,severity,harness,title,state,reason} so `payload_filter` narrows it to your
 * claim spec's view), with the ~30-min on_timeout 'wake' as the missed-emit backstop.
 * The wake is a HINT, never a claim — get_next stays the single authoritative claim path,
 * so a spurious/racing wake costs one cheap re-miss, never a double-claim.
 * Exported for the recurrence-guard pin test (idle-loop-recipe-pin.test.ts).
 */
export const IDLE_PULL_MISS_ADVICE =
  'Idle recipe (composable-event-awaits P-006/P-007): do NOT re-poll on a timer — register ONE await and END YOUR TURN: ' +
  'events:await { event: "work-item:claimable", payload_filter: { harness: { eq: "<your-harness>" } } /* narrow to your claim spec\'s view */, timeout_sec: 1800 } ' +
  '— work-item:claimable fires on every created-unclaimed / claim-released / unblocked transition; the ~30-min on_timeout "wake" is the missed-emit backstop. ' +
  'The wake is a HINT that work may exist, never a claim: scheduler:get_next stays the AUTHORITATIVE claim on the wake turn; ' +
  'if it misses again, re-register the same await and end your turn again.';

/**
 * EI-18167154191955470: internal budget for the get_next DB path. During a fleet-drain cold
 * wake, a routine scheduler:get_next hung with ZERO response/progress for the full 300s MCP
 * idle timeout and was aborted by the client; an immediate retry of the identical call
 * succeeded (a floor-gated miss) in ~2s. The signature of PG pool contention: a query stuck
 * waiting on a pool connection blocks silently — no error, no progress — until a connection
 * frees. This budget bounds the heaviest DB legs (the atomic claim + the miss-diagnosis
 * fan-out) so such a stall returns a FAST, clean, retryable error WELL under the 300s idle
 * abort instead of the observed silent-hang failure mode. 30s is ~15x the normal ~2s latency
 * (so it never false-fires on a healthy-but-busy call) and 10x under the idle abort (so the
 * client NEVER hard-aborts first). The underlying pool-saturation root cause is tracked
 * separately (EI-18147753127456018); this closes the bad-failure-mode half.
 */
export const GET_NEXT_BUDGET_MS = 30_000;

/**
 * The fast, self-describing miss the tool returns when its DB path exceeds GET_NEXT_BUDGET_MS,
 * instead of hanging until the MCP client's 300s idle-timeout abort (EI-18167154191955470).
 * Distinct `error: 'timeout'` + `retryable: true` so a caller can distinguish it from a genuine
 * "no claimable work" miss and simply retry — a prior incident's immediate retry succeeded in ~2s.
 */
export function getNextTimeoutResult(budgetMs = GET_NEXT_BUDGET_MS): {
  ok: false;
  error: 'timeout';
  retryable: true;
  budgetMs: number;
  message: string;
} {
  return {
    ok: false,
    error: 'timeout',
    retryable: true,
    budgetMs,
    message:
      `scheduler:get_next exceeded its ${budgetMs}ms internal budget (likely transient PG pool ` +
      `contention) and returned a fast error instead of hanging until the MCP client's 300s ` +
      `idle-timeout abort (EI-18167154191955470). This is a RETRYABLE transient — the claim path ` +
      `is unchanged and a prior incident's immediate retry succeeded in ~2s. Retry now; if it ` +
      `persists, the account/PG pool may be saturated (see accounts:status / dev:rate_governor_status).`,
  };
}

/**
 * Return a structured retryable result for a bounded admin-pool transaction that hit a
 * PostgreSQL statement/lock timeout. This is distinct from the JS watchdog result above:
 * the database has already rejected the transaction, so preserving its typed message (and
 * blocker hint, when available) gives the caller the actual contention diagnosis instead of
 * converting it into a generic MCP `handler_error`.
 */
export function getNextContentionResult(error: OrgTxnTimeoutError): {
  ok: false;
  error: 'timeout';
  retryable: true;
  pgCode: string;
  message: string;
} {
  return {
    ok: false,
    error: 'timeout',
    retryable: true,
    pgCode: error.pgCode,
    message:
      `scheduler:get_next claim hit transient PostgreSQL contention (${error.pgCode}): ${error.message}. ` +
      'Retry now; the failed transaction was rolled back and no claim was returned.',
  };
}

/** WI-4413: pull the ids a claim spec NAMES (the leader-tranche shape) out of its view filter. */
export function specNamedIds(spec: unknown): string[] {
  const view = (spec as { view?: { filter?: { all?: unknown[] } } } | undefined)?.view;
  const clauses = Array.isArray(view?.filter?.all) ? view.filter.all : [];
  for (const c of clauses) {
    const cl = c as { field?: string; op?: string; value?: unknown };
    if (cl?.field === 'id' && cl?.op === 'in' && Array.isArray(cl.value)) {
      return cl.value.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}

/** The kinds whose claim path runs through the ISSUE-family diagnostic
 *  (diagnoseClaimNextMiss / explainIssueClaimFloors / aggregateIssueClaimExclusions,
 *  all imported below) — mirrors buildFleetKindClaimSpec's ISSUE_FAMILY_CLAIM_KINDS
 *  in fleet_registry/launch-on-plan.ts (not re-exported from there to avoid a
 *  fleet_registry → agent-tools/scheduler import edge for one literal set). */
const ISSUE_FAMILY_KINDS = new Set(['bug', 'change', 'task']);

/**
 * EI-18741395910746959: pull the `kind in [...]` leaf's value out of a claim spec's
 * view filter (top-level or nested one level inside an `all`) — the sibling of
 * specNamedIds, used to tell whether THIS diagnosis (which is issue-family-only,
 * see the doc comment below) is even on-topic for the caller's spec.
 */
export function specKindFilterValues(spec: unknown): string[] | undefined {
  const view = (spec as { view?: { filter?: unknown } } | undefined)?.view;
  const filter = view?.filter as { field?: string; op?: string; value?: unknown; all?: unknown[] } | undefined;
  if (!filter) return undefined;
  const candidates = Array.isArray(filter.all) ? filter.all : [filter];
  for (const c of candidates) {
    const cl = c as { field?: string; op?: string; value?: unknown };
    if (cl?.field === 'kind' && cl?.op === 'in' && Array.isArray(cl.value)) {
      return cl.value.filter((v): v is string => typeof v === 'string');
    }
  }
  return undefined;
}

/**
 * True when the spec's OWN kind filter (if any) restricts EXCLUSIVELY to issue-family
 * kinds (bug/change/task) — i.e. the issue-family-only diagnostic below is the WHOLE
 * story for this caller. False when the filter has no kind restriction at all (both
 * families are structurally reachable) or explicitly includes a non-issue kind
 * (feature/chunk/research-task/…) — in either case a "0 issue-family rows" diagnosis
 * is not the whole picture and the caller needs to be told so explicitly (the exact
 * confusion reported in EI-18741395910746959: a feature-only plan's claim spec has no
 * kind leaf at all, so its miss diagnosis silently talked ONLY about the issue-family
 * side, which the plan's items never touch, and never mentioned the feature-family
 * claim path at all).
 */
export function specIsIssueFamilyOnly(spec: unknown): boolean {
  const kinds = specKindFilterValues(spec);
  if (!kinds || kinds.length === 0) return false;
  return kinds.every((k) => ISSUE_FAMILY_KINDS.has(k));
}

/**
 * WI-6409: the ONE cap-led refusal EVERY miss branch returns when the caller is at its
 * concurrency cap — shared so the fleet-scoped and non-fleet branches cannot drift.
 *
 * Why it is shared rather than inlined at the (previously single) call site: EI-19931420102632438
 * fixed exactly this misattribution on the NON-fleet branch — "lead with the CAP, never with the
 * lane-empty phrase" — but a fleet member's miss routes to `fleetScopedMiss` instead, which never
 * consulted concurrency at all. So the identical defect survived on the branch every fleet member
 * actually takes, where it is strictly worse: `fleetScopedMiss` does not merely say "lane empty",
 * it pronounces CLAIM-PATH/READ-PATH DIVERGENCE, calls the breakdown "the reproduction", and
 * instructs the member to file a claim-path bug and NOT stand down.
 *
 * Measured live 2026-08-09 (this item's own reproduction, pool held constant): holding 1/1, two
 * consecutive `scheduler:get_next` calls returned `divergenceRecheck:"confirmed-twice"` with
 * "232 of 411 rows pass every floor"; releasing to 0 claims and re-calling seconds later SERVED an
 * item under the same spec (rev 7). The claim path was healthy the whole time.
 *
 * Note the divergence RE-CHECK cannot discriminate this case by construction: it re-runs the same
 * claim, which is still cap-blocked, so "confirmed-twice" is GUARANTEED rather than corroborating —
 * which is why the false verdict reads as rigorously confirmed. Hence the check below runs BEFORE
 * the re-check, not merely before the verdict.
 */
function concurrencyBlockedRefusal(concurrency: {
  activeClaims: number;
  maxConcurrentClaims: number;
  heldIds: string[];
}): { error: string; diagnosis: Record<string, unknown> } {
  return {
    // EI-19931420102632438: lead with the CAP, never with a lane-contents claim. A caller refused
    // on its own cap had the lane never consulted at all.
    error:
      `claim cap reached: you already hold ${concurrency.activeClaims}/${concurrency.maxConcurrentClaims} ` +
      `concurrent claim(s) — release or complete one before claiming another; ` +
      `held: ${concurrency.heldIds.join(', ')}. (The claim lane itself was NOT evaluated — this is ` +
      `not a statement about lane contents.)`,
    diagnosis: {
      concurrencyBlocked: true,
      activeClaims: concurrency.activeClaims,
      maxConcurrentClaims: concurrency.maxConcurrentClaims,
      heldIds: concurrency.heldIds,
    },
  };
}

/**
 * WI-4413: build the self-explaining miss. Two layers:
 *  1. AGGREGATE — the POOL/READY split from diagnoseClaimNextMiss (already the source of truth
 *     shared with the claim itself). Distinguishes "genuinely drained, idling is correct" from
 *     "the backlog is FULL but every row is gated" — a distinction the old static string erased.
 *  2. PER-ID — when the spec NAMES ids, which floor refuses each. This is the leader's case:
 *     they authored the tranche, so "WI-2749: claim-hold (held open by another agent)" is
 *     directly actionable, where an aggregate count is not.
 *
 * FAILS SOFT — a diagnosis is an annotation on a miss, never a new way for the claim path to
 * throw. Any error degrades to the original static message.
 */
async function buildMissDiagnosis(args: {
  ownerId: string;
  workspaceId: string | null;
  harness: string;
  states?: string[];
  rigAvailable?: boolean;
  /** P-027: the MISSING caller's reader, for the already-taken floor's holder
   *  advisory. Null (or an unattributable caller) simply omits the advisory. */
  reader?: CellReader | null;
}): Promise<{ error: string; diagnosis?: unknown; floors?: unknown }> {
  const STATIC = 'no claimable work-item matched your spec within the floors';
  try {
    const { diagnoseClaimNextMiss, explainIssueClaimFloors } = await import('../../work-items');
    let floors: unknown;
    let namedSummary = '';
    const resolvedWorkspace = resolveClaimSpecWorkspace(args.workspaceId);
    const rec = await getClaimSpecRecord({
      cupId: args.ownerId,
      workspaceId: resolvedWorkspace,
    }).catch(() => null);

    // WI-5276: getNextForBee fails CLOSED before any claim query when the caller is
    // mid-fleet-transition (source 'default' + a named fleetSlug marker: the latest
    // membership fact names a fleet whose sentinel spec is missing/invalid). The
    // member-role shape returns a fleetScopedMiss upstream, but a non-member role
    // (e.g. just promoted to leader of the new fleet — the original WI-4770 incident)
    // reaches THIS diagnosis, which would otherwise report pool counts as if the
    // items were reachable ("N pass the floors") while the true cause is the guard.
    // Mirror getNextForBee's own check order: this guard fires before concurrency.
    if (rec?.source === 'default' && rec.fleetSlug) {
      return {
        // EI-19931420102632438: this is a PRE-LANE refusal — the claim lane was never
        // evaluated — so the headline must not claim anything about lane contents (the
        // old `${STATIC}. Diagnosis: …` prefix read as "the lane is empty", which is a
        // statement about a different subsystem than the one that actually refused).
        error:
          `blocked: you are mid-fleet-transition — your latest membership fact names ` +
          `fleet '${rec.fleetSlug}' but no valid per-bee or inherited fleet claim spec exists, so ` +
          `self-select fails CLOSED (WI-4770) regardless of pool size. (The claim lane itself was ` +
          `NOT evaluated — this is not a statement about lane contents.) Escape: have the leader ` +
          `install the fleet sentinel (scheduler:set_claim_spec { fleet }), set your own per-bee ` +
          `spec, or fleet:leave to settle to solo default pulls.`,
        diagnosis: { fleetTransitionBlocked: true, fleetSlug: rec.fleetSlug },
      };
    }

    // EI-12095: getNextForBee short-circuits BEFORE the claim query whenever the caller
    // already holds >= its spec's maxConcurrentClaims (default 1) — a parked/held item
    // still counts (it retains `taken_by`). That miss has NOTHING to do with pool/floor
    // admissibility, so running diagnoseClaimNextMiss for it produces a real, expensive
    // false signal ("N admissible" while the true cause is "you're at your concurrency
    // limit") — a live incident burned a fleet leader hours bisecting the claim query for
    // exactly this. Check it FIRST and, when true, report it plainly (with the held ids,
    // so the caller can act immediately) instead of computing floors at all.
    // EI-19313376980892266: goes through the shared oracle (evaluateClaimConcurrency) so
    // this diagnosis, getNextWorkItem's refusal, fleet:leader-brief's idle accounting and
    // work_items:claim's WARNING cannot disagree about who is at capacity.
    //
    // "Warning", not "gate", and the distinction is load-bearing: work_items:claim is a
    // by-id door and stays ungated (claim-door-census.test.ts, `by-id-ungated`) — it reports
    // this same verdict on a successful claim (concurrencyClaimWarning) rather than refusing.
    // Sharing the ORACLE is what this item is about; sharing the BEHAVIOUR would break the
    // deliberate override.
    const concurrency = await readClaimConcurrency({
      cupId: args.ownerId,
      workspaceId: resolvedWorkspace,
      maxConcurrentClaims: rec?.spec.limits?.maxConcurrentClaims,
    }).catch(() => null);
    if (concurrency?.blocked) {
      // WI-6409: the message + diagnosis now live in `concurrencyBlockedRefusal` so the
      // fleet-scoped branch returns the IDENTICAL verdict instead of a false divergence.
      return concurrencyBlockedRefusal(concurrency);
    }

    // D-002 (drain-claim-spec-hardening-2026-07-13, fixes EI-11300): mirror getNextWorkItem's
    // own states resolution (per-call override wins; else the spec's `states`; else the
    // ['todo'] floor default) so the miss diagnosis reflects the SAME pool the real claim
    // attempt just ran under — a diagnosis computed under a different `states` than the
    // claim itself would mislead the caller about why it missed.
    const effectiveStates = args.states ?? (rec?.spec as { states?: string[] } | undefined)?.states;
    const diag = await diagnoseClaimNextMiss({
      harness: args.harness,
      assignee: args.ownerId,
      states: effectiveStates as ClaimNextStates,
      rigAvailable: args.rigAvailable,
    });
    const ids = specNamedIds(rec?.spec);
    if (ids.length > 0) {
      const attributed = await explainIssueClaimFloors(args.harness, ids, {
        assignee: args.ownerId,
        rigAvailable: args.rigAvailable,
      });
      const refused = attributed.filter((a) => !a.admissible);
      // P-027 / D-055 A2 — the `already-taken` floor is the one refusal in this
      // list caused by ANOTHER AGENT rather than by the row itself, so it is the
      // only one where "should I wait for them?" is a real question. Decorate
      // exactly those rows with the holder's goal; every other floor is untouched.
      //
      // ⚠ ADVISORY, AND AFTER THE FACT. `attributed`/`refused` are already decided
      // — nothing here can make a floored id admissible. Resolution is total and
      // one-per-DISTINCT-holder, so a leader's spec naming twenty ids held by one
      // peer costs one resolution, and a dead store costs only the advisory.
      const takenRows = attributed.filter((a) => a.refusedBy === 'already-taken' && a.heldBy);
      if (takenRows.length > 0 && args.reader) {
        const advisory = await resolveHolderAdvisoryMap(
          takenRows.map((a) => a.heldBy),
          args.reader,
        );
        floors = attributed.map((a) => {
          if (a.refusedBy !== 'already-taken' || !a.heldBy) return a;
          // D-094: subtract THIS id, so a holder is never reported as also
          // competing on the very row whose refusal is being explained.
          const holderContext = advisory.forRow(a.heldBy, a.id);
          return holderContext ? { ...a, holderContext } : a;
        });
      } else {
        floors = attributed;
      }
      if (refused.length === ids.length) {
        // The whole tranche is floored — the leader's spec is the thing that needs fixing, and
        // saying so plainly is the entire point of this diagnosis.
        namedSummary =
          ` Your spec NAMES ${ids.length} id(s) and NONE of them are claim-path admissible — ` +
          `this is a SPEC problem, not an empty queue: ` +
          refused.map((r) => `${r.id} (${r.refusedBy ?? 'unknown'})`).join(', ') +
          `. Tell your fleet leader; they must re-feed the spec.`;
      } else if (refused.length > 0) {
        namedSummary = ` ${refused.length}/${ids.length} named id(s) are floored: ${refused
          .map((r) => `${r.id} (${r.refusedBy ?? 'unknown'})`)
          .join(', ')}.`;
      }
    }

    const aggregate = diag.drained
      ? 'the backlog is genuinely DRAINED (0 unclaimed items in the pool) — idling is correct'
      : `the backlog is NOT drained: ${diag.pendingUnclaimed} unclaimed item(s) in the pool, but ${diag.readyUnclaimed} pass the floors` +
        (diag.readyUnclaimed === 0 ? ' — every one of them is GATED (blocked / held / needs-human / not-work), so idling is correct but the backlog is not empty' : '');
    // EI-14108: a flag-READ failure (fail-closed) reads identically to "the issue-claimable
    // flag is off" otherwise — say so explicitly so this never presents as a drained/out-of-
    // scope pool when it's actually an unreadable flag store.
    const flagReadErrorNote = diag.flagReadError
      ? ` NOTE: issue-claim flag UNREADABLE this call (SCHEDULER_ISSUES_CLAIMABLE: ${diag.flagReadError}) — fail-closed, so the counts above EXCLUDE the whole issue family (bug/change/task) rather than reflecting it being off/empty.`
      : '';

    // EI-13965: a BROAD spec (no named ids for explainIssueClaimFloors to attribute) that
    // is genuinely stranded (pool non-empty, nothing ready) gets the same self-explaining
    // treatment via an AGGREGATE per-floor breakdown instead of per-id — "pool empty" vs
    // "pool stranded, and by WHICH floor" for the common member-scoped-miss shape.
    let excludedBreakdown: unknown;
    let breakdownSummary = '';
    if (ids.length === 0 && !diag.drained && diag.readyUnclaimed === 0) {
      const { aggregateIssueClaimExclusions } = await import('../../scheduler/get-next');
      const agg = await withBoundedTimeout(
        aggregateIssueClaimExclusions((rec?.spec as { view?: { filter?: unknown } } | undefined)?.view?.filter as never, {
          harness: args.harness,
          states: effectiveStates,
          assignee: args.ownerId,
          rigAvailable: args.rigAvailable,
        }),
        { fallback: null, timeoutMs: 1_500, label: 'get_next:missBreakdown' },
      );
      if (agg.value) {
        excludedBreakdown = agg.value;
        const top = Object.entries(agg.value.excluded)
          .filter(([, n]) => (n as number) > 0)
          .sort((a, b) => (b[1] as number) - (a[1] as number));
        breakdownSummary =
          top.length > 0
            ? ` Your spec's filter matches ${agg.value.matchedByFilter} issue-family row(s); stranded by: ` +
              top.map(([k, n]) => `${k}=${n}`).join(', ') +
              ' (buckets are independent, a row can count under more than one). Not covered here: the ' +
              'plan-item-lane-guard\'s per-item blocked/cycle check (post-claim, JS-side) — zero above does ' +
              'not rule that out.'
            : agg.value.matchedByFilter === 0
              ? " Your spec's filter matches 0 issue-family rows at all — the SPEC itself is the problem, not a floor."
              : '';
      }
    }

    // EI-18741395910746959: everything above (diag.pendingUnclaimed/readyUnclaimed,
    // explainIssueClaimFloors, aggregateIssueClaimExclusions) is computed EXCLUSIVELY over
    // the issue-family (bug/change/task) claim path — it structurally cannot see a
    // feature-family miss. When the caller's OWN spec does not restrict to issue-family
    // kinds only (no kind filter at all, or one that includes feature/chunk/research-task/…),
    // this whole diagnosis may be silently irrelevant to why THEIR claim actually missed. Say
    // so plainly instead of letting "matches 0 issue-family row(s)" read as the whole picture.
    const issueFamilyOnly = specIsIssueFamilyOnly(rec?.spec);
    const familyScopeNote = issueFamilyOnly
      ? ''
      : ' NOTE: this diagnosis (pendingUnclaimed/readyUnclaimed/floors/excludedBreakdown above) covers ONLY the ' +
        "issue-family (bug/change/task) claim path — your spec's filter does not restrict to issue-family kinds " +
        'only, so if the item(s) you expected to claim are feature-family (kind:"feature"), this diagnosis says ' +
        'nothing about why THAT claim missed; check the plan/feature directly (plans:items / work_items:get) ' +
        'rather than trusting an issue-family-only 0 here.';

    return {
      error: `${STATIC}. Diagnosis: ${aggregate}.${namedSummary}${breakdownSummary}${flagReadErrorNote}${familyScopeNote}`,
      diagnosis: {
        drained: diag.drained,
        pendingUnclaimed: diag.pendingUnclaimed,
        readyUnclaimed: diag.readyUnclaimed,
        issueFamilyOnlyDiagnosis: issueFamilyOnly,
        ...(diag.flagReadError ? { flagReadError: diag.flagReadError } : {}),
      },
      floors,
      ...(excludedBreakdown ? { excludedBreakdown } : {}),
    };
  } catch {
    return { error: STATIC };
  }
}

/**
 * WI-20202324455243251: assemble a successful self-pull response in the order the
 * result-door should preserve. The door keeps the PREFIX of an oversized serialized
 * result, so the claim-time governing decisions must precede the bulky work-item
 * echo. They are the one advisory block that can change whether the claimed work is
 * valid; losing them to a tail cut makes a partial response look complete.
 *
 * Keep this pure and exported so the regression test exercises the production
 * assembly rather than a mirrored fixture. The remaining fields retain their former
 * order and conditional presence.
 */
export function assembleSchedulerClaimResult(legs: {
  workItem: unknown;
  claimedUnder: unknown;
  freshness?: unknown;
  warning?: unknown;
  routingHint?: unknown;
  memory?: unknown;
  checkpoint?: unknown;
  checkpointAgeMs?: unknown;
  checkpointWarning?: unknown;
  checkpointBgJobWarning?: unknown;
  priorWork?: unknown;
  priorWorkWarning?: unknown;
  planDecisions?: readonly unknown[] | null;
  planDecisionsNote?: string | null;
  premises?: unknown;
  premisesNote?: string | null;
}): Record<string, unknown> {
  return {
    ok: true,
    // Keep this before workItem: result-door truncation is prefix-preserving, and
    // governing decisions are safety-critical while the work-item echo is bulky.
    ...(legs.planDecisions
      ? { planDecisions: legs.planDecisions, planDecisionsNote: legs.planDecisionsNote as string }
      : {}),
    workItem: legs.workItem,
    claimedUnder: legs.claimedUnder,
    ...(legs.freshness ? { freshness: legs.freshness } : {}),
    ...(legs.warning ? { warning: legs.warning } : {}),
    ...(legs.routingHint ? { routingHint: legs.routingHint } : {}),
    ...(legs.memory ? { memory: legs.memory } : {}),
    ...(legs.checkpoint
      ? {
          checkpoint: legs.checkpoint,
          checkpointAgeMs: legs.checkpointAgeMs,
          checkpointWarning:
            legs.checkpointWarning ??
            'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).',
          ...(legs.checkpointBgJobWarning ? { checkpointBgJobWarning: legs.checkpointBgJobWarning } : {}),
        }
      : {}),
    ...(legs.priorWork
      ? {
          priorWork: legs.priorWork,
          priorWorkWarning: legs.priorWorkWarning,
        }
      : {}),
    ...(legs.premises ? { premises: legs.premises, premisesNote: legs.premisesNote } : {}),
  };
}

export default defineTool({
  name: 'scheduler:get_next',
  profile: 'engineer',
  description:
    'Self-select via your claim SPEC: atomically claims the next eligible item under global floors + spec filter/rank, SKIP LOCKED. Outside a fleet, no spec uses default ordering (warned). A fleet member without an inherited spec fails closed (windDown:true), never into generic backlog. Returns the item plus spec provenance, or a diagnosed miss.',
  guidance: {
    when: 'A self-pulling cup or su fleet member needs its next item. Use the Mug/leader claim spec instead of scanning the frontier. Pass only { harness, heldPaths?, states?, rigAvailable? }; never pass specId, revision, fleet, workspace, or claimSpec. claimedUnder reports the inherited spec.',
    notWhen:
      'Coding-factory roles are pushed a FEATURE_ID and do not self-pull. For a specific id use work_items:claim; for plain non-fleet oldest-first use work_items:claim_next.',
    chaining:
      'After a claim, set state and eventually release/complete it; leaders re-steer with scheduler:set_claim_spec. On a fleet miss with windDown:true, checkpoint/release and park until a spec revision or claimable event. windDown:false plus excludedBreakdown.claimable>0 is a claim-path bug.',
    seeAlso: [
      'work_items:claimable (how many / which items are claimable, WITHOUT claiming — same oracle, no side-effect)',
      'work_items:claim_next (plain oldest-first self-select, no spec)',
      'work_items:claim (claim a SPECIFIC item by id)',
      'scheduler:set_claim_spec (the spec your queen or fleet leader steers you with)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  // EI-20219220087119072: this self-pull handler never reads ctx.tx. Its claim,
  // scope-reconciliation, and miss-diagnosis legs use their own DB accessors and
  // can await several independent reads; retaining the dispatcher's ambient
  // workspace transaction pins an org-app pool slot for the whole call and lets
  // fleet contention starve subsequent scheduler pulls at the acquisition seam.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Harness to pull from. OPTIONAL — defaults to the session\'s own harness when it has exactly one. ' +
          'Pass it explicitly only to pull from a DIFFERENT harness than the session is scoped to.',
      ),
    heldPaths: z
      .array(z.string())
      .max(500)
      .optional()
      .describe('paths you already hold open — the affinity rank-term input (default: none)'),
    // WI-1912: clamped to the claimable allowlist — a free-string `states` let a caller
    // widen past the resolver-owned floors (a member passed ['todo','open','blocked'] and
    // pulled a leader-triage-only blocked item). The claim-spec validator rejects a
    // `blocked` filter TERM for exactly this reason (D-002); the arg gets the same wall.
    states: z
      .array(z.enum(CLAIM_STATES_ALLOWLIST as unknown as [string, ...string[]]))
      .max(20)
      .optional()
      .describe(
        "claimable states — subset of ['open','failing']. Omit to inherit your claim spec's own `states` (drain-claim-spec-hardening-2026-07-13 D-002/EI-11300 — a fleet leader sets it once via scheduler:set_claim_spec, every member inherits it), else ['open']. `open` is the unified claimable token for BOTH families now (feature `todo` retired). Passing this EXPLICITLY always wins over the spec. 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
      ),
    rigAvailable: z
      .boolean()
      .optional()
      .describe(
        'WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded — a single-box caller cannot execute them anyway.',
      ),
  }),
  async handler(rawArgs, ctx) {
    // WI-38059 — default `harness` from the session instead of requiring it.
    //
    // WHY: this was filed FIVE separate times by different agents before anyone
    // fixed it (EI-14940, EI-20184580886728084, EI-20186903579866871,
    // EI-20193064803605796, plus the Gemini grading pass S4). The shape of the
    // failure is always identical: an agent is told "pull work via
    // scheduler:get_next", calls it, and gets
    // `invalid_args: harness: expected string, received undefined` on its FIRST
    // action after a wake — the single worst moment to spend a round-trip, and
    // the reason it kept getting re-filed rather than learned.
    //
    // A session already knows its harness; making the caller restate it bought
    // nothing. Cross-harness pulls still work by passing it explicitly, so this
    // widens behaviour without removing any.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const resolvedHarness =
      rawArgs.harness ?? (typeof ctxHarness === 'string' && ctxHarness.trim() ? ctxHarness.trim() : undefined);
    if (!resolvedHarness) {
      // Only reachable from a session with no harness binding at all (unscoped
      // operator / cross-workspace). Say which of the two is missing rather than
      // re-emitting the bare zod complaint the five filings were about.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'harness_required',
              detail:
                'No `harness` argument and this session is not scoped to one, so there is no queue to pull from. ' +
                'Pass harness explicitly (a harness-scoped session supplies it automatically).',
            }),
          },
        ],
        isError: true,
      };
    }
    // Re-bind so every downstream `args.harness` stays a definite string — the
    // alternative (renaming ~15 call sites) would also have caught the unrelated
    // `args.harness` inside buildMissDiagnosis, which has its own `args` param.
    const args = { ...rawArgs, harness: resolvedHarness };
    const ident = resolveAgentIdentity(ctx);
    // P-016: reconcile ALL incompatible pre-existing claims before the next
    // pickup. The sweep is batch-shaped (one pass, one leader alert), so a dead
    // lane cannot drip one stale claim per wake. Only fleet MEMBERS are scoped;
    // leaders supervise rather than consume the member lane.
    const reconciliation = await reconcileFleetScopeClaims({
      ownerId: ident.ownerId,
      workspaceId: ident.workspaceId,
      identity: ident,
    });
    if (reconciliation.scope?.record.source === 'default') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, { harness: args.harness }),
            ),
          },
        ],
      };
    }
    // EI-12832: a paused fleet (control_state='winding-down') floors the SELECT side too —
    // a member woken during the pause must stand down, not pull the next item (even one
    // its spec matches). The by-id claim path is gated at admission; this closes the
    // self-select sibling seam with the same durable-control-state read.
    if (reconciliation.scope) {
      const pause = await readFleetPauseState(reconciliation.scope, ident.workspaceId);
      if (pause.windingDown) {
        // EI-15777: a member parked on `events:await('work-item:claimable')` from
        // BEFORE the pause is otherwise still woken by a peer's compliant
        // stand-down release (the admission gate only refuses the CLAIM, not the
        // wake itself) — a full session-resume cycle wasted every time, the
        // "post-mission wake churn" this closes. Retire the caller's own standing
        // claimable await(s) right here so no future release re-wakes them for a
        // pull they're forbidden to make anyway. Self/subscriber-scoped + best-effort,
        // same posture as the successful-claim cancel below.
        const claimableAwaitsCancelled = await cancelClaimableAwaits(ident.ownerId).catch(() => 0);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, {
                  pausedReason: pause.reason,
                  claimableAwaitsCancelled,
                  harness: args.harness,
                }),
              ),
            },
          ],
        };
      }
    }
    // SCHEDULER_SPEC_CLAIM kill-switch (default ON; fail-open): OFF ⇒ ignore the bee's stored
    // spec and claim by the DEFAULT ordering (a no-breakage degrade to claim_next behavior).
    // A fleet member is the exception: scope is a correctness boundary, not a feature
    // preference, so the kill-switch may disable scheduler steering but cannot widen a
    // member into the generic backlog.
    const specOn = await getFlag(FLAGS.SCHEDULER_SPEC_CLAIM, ident.ownerId).catch(() => true);
    // P-015: authoritative lock-plane snapshot, holders only and excluding this
    // caller. Fail-soft is implemented by liveLockedPaths; cap the SQL parameter so
    // a pathological lock storm cannot inflate a claim request without bound.
    const contendedPaths = (await liveLockedPaths({ excludeOwner: ident.ownerId })).slice(0, 500);
    // EI-18167154191955470: the atomic claim is the heaviest single DB op in this path — an
    // UPDATE ... FOR UPDATE SKIP LOCKED that must acquire both a pool connection and a row lock,
    // the most likely place to block under PG pool saturation. Bound it so a stall fails FAST
    // with a clean, retryable error instead of the observed failure mode: a silent 300s hang,
    // aborted by the MCP client idle-timeout, whose immediate retry then succeeded in ~2s.
    // NOTE (see withBoundedTimeout's own doc): this is a Promise.race and does NOT cancel the
    // query, so a claim UPDATE that commits in the background AFTER the deadline is a possible
    // orphan — but that orphan is self-healing (reconcileFleetScopeClaims + the lease reclaim
    // run at the TOP of the very next get_next sweep it) AND it already existed under today's
    // 300s hang; we only fail faster. A real throw is re-surfaced loudly, never a silent miss.
    const claim = await withBoundedTimeout(
      getNextForBee({
        cupId: ident.ownerId,
        // WI-1564: MUST match the partition scheduler:set_claim_spec writes
        // (same resolveClaimSpecWorkspace helper) — a reader left on 'default'
        // while the queen writes the workspace partition (or a federated spec
        // arrives under the booted workspace) silently falls back to
        // DEFAULT_CLAIM_SPEC and the steer never lands.
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
        harness: args.harness,
        heldPaths: args.heldPaths,
        contendedPaths,
        states: args.states,
        rigAvailable: args.rigAvailable,
        ignoreStoredSpec: !specOn && !reconciliation.scope,
        // P-006 (fleet-leader-frictions-six-improvements-2026-07-10, WI-3763): this is
        // THE live fleet-member self-pull surface — a miss here is the real "claim-spec
        // view is empty" signal a fleet leader wants pushed, so opt in.
        checkIdleDrainOnMiss: true,
      }),
      // fallback:null is a type-correct member of getNextForBee's return (`... | null`) and is
      // NEVER read — we branch on `claim.degraded` before ever touching `claim.value`.
      { fallback: null, timeoutMs: GET_NEXT_BUDGET_MS, label: 'scheduler:get_next:claim' },
    );
    // A genuine underlying error surfaces loudly (preserving today's behavior where a thrown
    // getNextForBee propagates), never degraded into a false "no claimable work" miss. Typed
    // PostgreSQL contention is the exception: it is a bounded, retryable condition and must
    // not become a generic `handler_error` that strands the fleet pull loop (EI-20224136729541724).
    if (claim.degraded && claim.reason === 'error') {
      if (claim.error instanceof OrgTxnTimeoutError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(getNextContentionResult(claim.error)) }],
        };
      }
      throw new Error(claim.errorMessage ?? 'scheduler:get_next claim failed');
    }
    // Budget exceeded: return the fast, retryable timeout miss instead of hanging to the abort.
    if (claim.degraded) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(getNextTimeoutResult()) }],
      };
    }
    let res = claim.value;
    // WI-6409: a caller at its CONCURRENCY CAP never had the lane evaluated — getNextForBee
    // short-circuits before the claim query (EI-12095) — so this miss says NOTHING about pool
    // admissibility. Answer it here, for EVERY caller, before the divergence machinery runs.
    //
    // This check used to exist only inside `buildMissDiagnosis`, which line ~839 skips entirely
    // when `reconciliation.scope` is set — i.e. it never ran for a FLEET MEMBER, whose miss is
    // routed to `fleetScopedMiss` instead. The result was a confident false verdict on the branch
    // every fleet member takes: "CLAIM-PATH/READ-PATH DIVERGENCE … 232 of 411 rows pass every
    // floor … this is an internal inconsistency in the claim path's own spec narrowing", with
    // advice to file a claim-path bug and "do not stand down". Reproduced live on this fleet
    // 2026-08-09 with the pool held constant (see concurrencyBlockedRefusal's doc comment).
    //
    // Placed BEFORE the WI-5947 re-check on purpose, for two reasons:
    //  1. CORRECTNESS — the re-check re-runs the same cap-blocked claim, so it can only ever
    //     return `divergenceRecheck:"confirmed-twice"`. The mechanism meant to distinguish a real
    //     defect from lane churn is, for this cause, guaranteed to affirm. Running it first would
    //     dress the false verdict in its strongest possible evidence.
    //  2. COST — it also avoids a second claim attempt plus two full oracle reads per capped pull,
    //     on the path a saturated fleet hits most often.
    // Fails SOFT (a read error leaves `res` null and the ordinary miss reporting stands): a
    // diagnosis must never become a new way for the claim path to fail.
    if (!res) {
      const capRec = await getClaimSpecRecord({
        cupId: ident.ownerId,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      }).catch(() => null);
      const capped = await readClaimConcurrency({
        cupId: ident.ownerId,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
        maxConcurrentClaims: capRec?.spec.limits?.maxConcurrentClaims,
      }).catch(() => null);
      if (capped?.blocked) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, ...concurrencyBlockedRefusal(capped) }),
            },
          ],
        };
      }
    }
    // WI-5947: RE-CONFIRM before letting a divergence verdict be pronounced.
    //
    // `fleetScopedMiss` reports CLAIM-PATH/READ-PATH DIVERGENCE when the claim above returned
    // nothing while the shared oracle reports claimable > 0. Those are two observations at two
    // DIFFERENT INSTANTS against a table the whole fleet is mutating: any row that becomes
    // claimable in the window between them (a peer releasing, a claim-hold lapsing, a detector
    // filing a new bug) makes a perfectly healthy miss look like a narrowing defect. The verdict
    // is not merely noisy — its advice INSTRUCTS the reader to file a claim-path bug in the
    // EI-10062 / WI-4309 / WI-5275 / WI-5822 class and calls the breakdown "the reproduction",
    // so a member following its tooling correctly files a fabricated bug against healthy code.
    // Observed live 2026-07-26 05:18Z on fleet nonp2p-bug-drain-0725 during a 0->2->4 claimable
    // burst; the claim path was correct throughout.
    //
    // The ground truth for "can the claim path actually select a row" is the CLAIM PATH, asked
    // again — not a second read. So on a would-be-divergent miss we retry the claim exactly once:
    //   - it succeeds  => the miss was a race, and the caller gets the work it came for (this is
    //                     the common case, and it is strictly better than any error message);
    //   - it misses    => re-read the breakdown; only if that STILL reports survivors do we let
    //                     the divergence stand, now attested across two claim attempts.
    // Placed HERE, before every `res?.workItem`-gated enrichment below, so a retry that lands
    // flows through the ordinary success path unchanged (recall port, checkpoint hint, await
    // cancellation) — there is no second, divergent success path to keep in sync.
    //
    // Cost is confined to the rare miss-with-survivors case: a normal drained miss (claimable
    // === 0, the overwhelmingly common shape) never enters this block and pays nothing.
    let issueBreakdown: import('../../scheduler/get-next').IssueClaimExclusionBreakdown | null = null;
    let divergenceRecheck: 'resolved-by-retry' | 'confirmed-twice' | undefined;
    // WI-7151 (EI-19318364531323846): the tier-1 (feature-family) match count, computed ONLY
    // when the issue-family breakdown would otherwise certify a false `spec_matches_nothing` —
    // see diagnoseFleetScopeFeatureFamilyMatch's doc comment. Left null for every other miss
    // shape (zero extra cost on the common paths).
    let featureFamilyMatched: number | null = null;
    let terminalExhaustion: import('../../scheduler/fleet-scope-admission').FleetScopeTerminalExhaustion | null = null;
    if (!res && reconciliation.scope) {
      issueBreakdown = await diagnoseFleetScopeIssueFloorMiss({
        scope: reconciliation.scope,
        harness: args.harness,
        workspaceId: ident.workspaceId,
        states: args.states,
        rigAvailable: args.rigAvailable,
      });
      if (issueBreakdown && issueBreakdown.claimable > 0) {
        const retry = await withBoundedTimeout(
          getNextForBee({
            cupId: ident.ownerId,
            workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
            harness: args.harness,
            heldPaths: args.heldPaths,
            contendedPaths,
            states: args.states,
            rigAvailable: args.rigAvailable,
            ignoreStoredSpec: !specOn && !reconciliation.scope,
            checkIdleDrainOnMiss: true,
          }),
          { fallback: null, timeoutMs: GET_NEXT_BUDGET_MS, label: 'scheduler:get_next:divergenceRecheck' },
        );
        // A degraded retry (timeout/error) proves nothing either way — leave the original
        // breakdown in place and let the miss report itself exactly as it would have.
        if (!retry.degraded && retry.value) {
          res = retry.value;
          divergenceRecheck = 'resolved-by-retry';
        } else if (!retry.degraded) {
          // Still nothing claimable to the claim path. Take a FRESH reading: if the pool moved
          // on (the racing row is now taken), this collapses to an ordinary floor-gated miss.
          const recheck = await diagnoseFleetScopeIssueFloorMiss({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
            states: args.states,
            rigAvailable: args.rigAvailable,
          });
          if (recheck) issueBreakdown = recheck;
          if (recheck && recheck.claimable > 0) divergenceRecheck = 'confirmed-twice';
        }
      } else if (issueBreakdown && issueBreakdown.matchedByFilter === 0) {
        // WI-7151: the issue-family breakdown reports a confident zero — but it is
        // STRUCTURALLY blind to the feature family (bug/change/task only). Check tier-1
        // before letting this certify a false `spec_matches_nothing` (e.g. a plan-scoped
        // spec whose promoted items are feature-family, per D-009).
        [featureFamilyMatched, terminalExhaustion] = await Promise.all([
          diagnoseFleetScopeFeatureFamilyMatch({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
            states: args.states,
            rigAvailable: args.rigAvailable,
          }),
          diagnoseFleetScopeTerminalExhaustion({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
          }),
        ]);
        if (featureFamilyMatched && featureFamilyMatched > 0) {
          // A genuine tier-1 candidate exists even though the claim (which just queried
          // this exact table) missed moments ago — retry once, same shape as the
          // claimable>0 divergence recheck above.
          const retry = await withBoundedTimeout(
            getNextForBee({
              cupId: ident.ownerId,
              workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
              harness: args.harness,
              heldPaths: args.heldPaths,
              contendedPaths,
              states: args.states,
              rigAvailable: args.rigAvailable,
              ignoreStoredSpec: !specOn && !reconciliation.scope,
              checkIdleDrainOnMiss: true,
            }),
            { fallback: null, timeoutMs: GET_NEXT_BUDGET_MS, label: 'scheduler:get_next:featureFamilyRecheck' },
          );
          if (!retry.degraded && retry.value) {
            res = retry.value;
            featureFamilyMatched = null; // claimed on retry — nothing left to explain
          }
        }
      }
    }
    // EI-8579: a self-puller with NEITHER a per-bee NOR an inherited fleet spec resolves to
    // DEFAULT_CLAIM_SPEC with its built-in p2p/federation safety fence. It can still draw
    // owner-deferred work (a paused/de-scoped category) that a curated spec would exclude.
    // Advisory only (the claim already happened): nudge the caller to set its own spec,
    // same non-blocking posture as set_claim_spec's EI-6079 wakeability warning.
    const warning =
      res && res.specSource === 'default'
        ? 'You have no per-bee or fleet claim spec — this claim used DEFAULT_CLAIM_SPEC with the built-in p2p/federation safety fence, but it can still hand you owner-deferred work (e.g. a paused/de-scoped category). Consider scheduler:set_claim_spec {cupId: you} to scope your own pulls.'
        : undefined;
    // EI-8809 (routing-gate hint at dispatch): most items are already stamped
    // payload.routingHint at creation (work_items:create / plans:promote); this is
    // the render-time FALLBACK for an item created before that wiring landed.
    // Hint only — never blocks, never overrides a stamped value.
    let routingHint: unknown;
    let freshness: ClaimFreshnessVerdict | null = null;
    if (res?.workItem) {
      const wi = res.workItem as { kind?: string; title?: string; summary?: string; payload?: unknown };
      const existing =
        wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
          ? (wi.payload as Record<string, unknown>).routingHint
          : undefined;
      routingHint = existing ?? matchRoutingGateHint(wi.title) ?? undefined;
      if (wi.kind === 'bug') {
        const build = getBuildInfo();
        freshness = assessClaimFreshness(wi.payload, {
          headSha: build.sha,
          runtimeSha: build.sha,
          runtimeVersion: build.version,
        });
      }
    }
    // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
    // D-006): on a hit, piggyback a targeted memory recall for the claimed
    // item — deadline-bounded, epoch-deduped (port 'claim'), never-throws.
    // This is THE live fleet-member self-pull surface, so it's the port that
    // matters most. Dynamic import keeps the memory chain off the static graph.
    let memory: string | null = null;
    if (res?.workItem) {
      const wi = res.workItem as { id?: string; title?: string; summary?: string; harness?: string | null };
      memory = await import('../../memory/claim-port')
        .then((m) => m.buildClaimRecallBlock({ sessionId: ident.ownerId, workspaceId: ident.workspaceId, items: [wi] }))
        .catch(() => null);
    }
    // EI-529: this is the primary self-pull surface (every fleet member / cup claims
    // through it) — surface a prior holder's checkpoint AT CLAIM TIME so a re-dispatch
    // after a dead/quiet session doesn't silently re-implement already-shipped work.
    // Omitted entirely when null (the common case: no prior holder ever checkpointed).
    let checkpointHint: import('../../work-item-checkpoint').ClaimTimeCheckpointHint | null = null;
    // WI-6737: a FAILED checkpoint read and a successful read that found nothing both leave
    // `checkpointHint` null. Only the former must stop a claimant from treating the item as
    // never-checkpointed, so keep the distinction instead of discarding it in the .catch.
    let checkpointReadFailed = false;
    if (res?.workItem) {
      const wi = res.workItem as { id: string; harness?: string | null };
      checkpointHint = await import('../../work-item-checkpoint')
        .then((m) => m.getClaimTimeCheckpointHint({ harness: wi.harness ?? null, workItemId: wi.id, workspaceId: ident.workspaceId ?? undefined }))
        .catch(() => {
          checkpointReadFailed = true;
          return null;
        });
    }
    // P-001/P-004 (fleet-leadership-continuity-and-actuation-2026-08-01): the prior-work banner,
    // wired here too. P-001 named THREE surfaces — work_items:claim, work_items:get and THIS one —
    // but only the first two got it, which left the biggest hole of the three: get_next is the
    // primary SELF-PULL surface every fleet member and cup claims through, so an
    // already-worked-but-checkpoint-less item was still indistinguishable from fresh work on the
    // path most agents actually take. (P-004's cross-surface test is what surfaced the omission —
    // it exists precisely because a guard wired into some-but-not-all read surfaces looks done.)
    // Escalates its wording when NO checkpoint exists, since that is the case no other guard here
    // can catch. Fail-soft + omitted entirely when null, exactly like the checkpoint hint above.
    let priorWorkHint: { priorWork: unknown; priorWorkWarning: string } | null = null;
    if (res?.workItem) {
      const wi = res.workItem as { id: string; harness?: string | null };
      priorWorkHint = await import('../../work-item-prior-work')
        .then(async (m) => {
          const raw = await m.getClaimTimePriorWorkHint({
            harness: wi.harness ?? null,
            workItemId: wi.id,
            workspaceId: ident.workspaceId ?? undefined,
          });
          if (!raw) return null;
          const priorWork = {
            ...raw,
            // WI-6737: never assert absence from a read that never ran.
            hasCheckpoint: checkpointReadFailed ? ('unknown' as const) : checkpointHint != null,
          };
          const warning = m.priorWorkWarning(priorWork);
          return warning ? { priorWork, priorWorkWarning: warning } : null;
        })
        .catch(() => null);
    }
    // EI-18654296679612119: a SEPARATE, CONDITIONAL warning — only when the checkpoint text
    // itself cites a background job/task as evidence — rather than growing the EI-529
    // checkpointWarning below unconditionally (which would fire on every checkpointed claim,
    // background job or not). See checkpoint-bg-job-claim.ts for why this can't be a live PID
    // check here (a claimant may be on a different host/process than the checkpoint's writer).
    const bgJobWarning = checkpointHint
      ? await import('../../checkpoint-bg-job-claim')
          .then((m) => m.detectBgJobCheckpointClaim(checkpointHint!.checkpoint))
          .catch(() => ({ detected: false as const }))
      : { detected: false as const };
    // agent-trap-guards-2026-07-26 P-003b: this is the primary self-pull surface, so
    // it's the port that matters most for surfacing a plan's governing Decisions at
    // CLAIM time — a cross-lane ruling recorded via plans:add-decision is auditable
    // and re-readable, but only for a claimant who thinks to go look. Fail-soft +
    // omitted entirely when null (no plan_item, unresolved slug, or zero decisions —
    // the common case for most plans).
    let planDecisions: import('../../plan-decisions-claim-port').ClaimTimePlanDecisionsBrief | null = null;
    // Rendered alongside planDecisions (same fetch, same dynamic import) via the
    // shared helper — EI-19387745408924340: extracted so this wording cannot
    // drift from work_items:claim / claim_next's copies of the same note.
    let planDecisionsNote: string | null = null;
    // false-premise-in-prescriptive-artifacts-2026-08-02 P-001: the SAME seam, for
    // the item's own load-bearing premises. planDecisions surfaces what OTHERS ruled;
    // this surfaces what THIS item's text assumes — and an unverified absence premise
    // is the measured way a claimant builds something that already exists.
    let premises: import('../../premises-claim-port').ClaimTimePremisesBrief | null = null;
    if (res?.workItem) {
      const wi = res.workItem as {
        payload?: unknown;
        harness?: string | null;
        title?: string | null;
        summary?: string | null;
      };
      [[planDecisions, planDecisionsNote], premises] = await Promise.all([
        import('../../plan-decisions-claim-port')
          .then(async (m) => {
            const brief = await m.getClaimTimePlanDecisions({
              workItem: { payload: wi.payload },
              harness: wi.harness ?? args.harness,
              workspaceId: ident.workspaceId,
            });
            return [brief, brief ? m.renderPlanDecisionsNote(brief) : null] as const;
          })
          .catch(() => [null, null] as const),
        import('../../premises-claim-port')
          .then((m) =>
            m.getClaimTimePremises({
              workItem: { payload: wi.payload, title: wi.title, summary: wi.summary },
              harness: wi.harness ?? args.harness,
              workspaceId: ident.workspaceId,
            }),
          )
          .catch(() => null),
      ]);
    }
    // EI-10541: a successful self-pull means this agent is transitioning idle -> working, so
    // cancel its standing `work-item:claimable` idle-park await(s) — holding a claim and waiting
    // for claimable work are mutually exclusive, and a pre-claim await left armed (e.g. this claim
    // came from a leader-fed spec bump, not the await firing) otherwise keeps firing spurious ~30-min
    // timeout wakes while the agent is busy. Best-effort + subscriber-scoped: a cancel failure must
    // never break the claim path (fails soft, like the recall port above).
    if (res?.workItem) {
      await cancelClaimableAwaits(ident.ownerId).catch(() => 0);
      // EI-20099413453852234: the same idle -> working transition also makes the caller's
      // DECLARED INTENT stale, which peers read as "this holder isn't really working it".
      // Declared here rather than left to the agent, for the reasons on the helper. Same
      // fail-soft posture as the cancel above — the claim is already committed.
      await declareIntentForClaim(ident, res.workItem, args.harness).catch(() => {});
    }
    // EI-16057: on a MISS ONLY, resolve `harness` against the registry before deciding
    // between "genuinely drained" (fleetScopedMiss / missDiagnosis below) and "the
    // `harness` arg itself never resolved" (a workspace id passed by mistake, a typo,
    // a slug from the wrong workspace) — the actual EI-16057 bug. An unresolvable
    // harness silently matches zero rows in the claim query, so left unchecked it
    // renders as `windDown:true`, the SAME authoritative "your lane is genuinely
    // drained" signal a real empty queue produces — a fleet member reading that stands
    // its loop down and reports a false all-clear to its leader. Checked HERE (only on
    // a miss, never on the hot successful-claim path) so a correct pull never pays the
    // extra read. Cached (loadHarnessRegistry); a read hiccup fails OPEN — "can't
    // verify" must never block/mis-report a claim path it's only annotating.
    const invalidHarnessKnownSlugs = !res
      ? await loadHarnessRegistry(
          ident.workspaceId && ident.workspaceId !== '*' ? ident.workspaceId : undefined,
        )
          .then((registry) =>
            registry.projects.some((p) => p.slug === args.harness)
              ? null
              : registry.projects.map((p) => p.slug).slice(0, 30),
          )
          .catch(() => null)
      : null;
    // WI-4413: a MISS must explain itself. `work_items:claim_next` has run diagnoseClaimNextMiss
    // on a miss since EI-5803 — but THIS path (the one every fleet member self-pulls through, and
    // the one a leader's claim spec drives) returned a static, floor-blind string. Live cost
    // (bug-drain-nonp2p 2026-07-12): three consecutive leader tranches were 100% floored, by three
    // DIFFERENT floors, and each took a manual payload dig to find while members idled.
    // FAILS SOFT: any error here degrades to exactly the old static message — a diagnosis must
    // never be able to break the claim path it is only annotating.
    const missDiagnosis = res || reconciliation.scope || invalidHarnessKnownSlugs
      ? { error: '' as string, diagnosis: undefined, floors: undefined }
      : (
          // EI-18167154191955470: the miss diagnosis fans out to several unbounded PG reads
          // (getClaimSpecRecord / readClaimConcurrency / diagnoseClaimNextMiss / …) — bound it
          // too so a pool stall HERE can't reproduce the 300s hang. buildMissDiagnosis already
          // fails soft to the STATIC message, so the timeout fallback is exactly that static miss.
          await withBoundedTimeout(
            buildMissDiagnosis({
              ownerId: ident.ownerId,
              workspaceId: ident.workspaceId,
              harness: args.harness,
              states: args.states,
              rigAvailable: args.rigAvailable,
              // P-027: guarded — an unattributable caller gets no advisory rather
              // than a failed miss-diagnosis.
              reader: holderContextReader(ctx as Parameters<typeof holderContextReader>[0]),
            }),
            {
              fallback: {
                error: 'no claimable work-item matched your spec within the floors',
                diagnosis: undefined,
                floors: undefined,
              },
              timeoutMs: 15_000,
              label: 'scheduler:get_next:missDiagnosis',
            },
          )
        ).value;
    // EI-13520: a genuine (non-paused) scoped miss may be a release-cooldown artifact,
    // not a real scope/spec problem — check before reporting a bare fleetScopedMiss so
    // the caller (and the leader they'd otherwise flag a false spec bug to) gets the
    // true cause. Only reached when reconciliation.scope is set AND res is null AND we
    // did not already return early on the paused/default-source branches above.
    const cooldownDiag =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs
        ? await diagnoseFleetScopeCooldownMiss({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
            states: args.states,
          })
        : null;
    // WI-5561: the issue-family floor-breakdown sibling of cooldownDiag above — surfaces WHY a
    // fleet-scoped miss happened (federation-detector / needs-human / claim-hold / … floors)
    // instead of the bare "no claimable work-item matched fleet scope" a member previously got
    // with zero explanation. Always attempted alongside cooldownDiag (independent signals, both
    // fail soft); fleetScopedMiss itself suppresses it while paused.
    // WI-5947: computed ABOVE (before the divergence re-check, which needs it to decide whether
    // to retry at all) and reused verbatim here — re-reading it would be a third unsynchronized
    // observation of the same churning pool, i.e. the very defect this fix removes.
    // `invalidHarnessKnownSlugs` still suppresses it: an unresolvable harness matches zero rows
    // for reasons that have nothing to do with the floors.
    const issueBreakdownForMiss =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs ? issueBreakdown : null;
    // WI-7151: same suppression as issueBreakdownForMiss — irrelevant once res is set (claimed
    // on a retry) or when the miss isn't fleet-scoped/is an invalid-harness miss.
    const featureFamilyMatchedForMiss =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs ? featureFamilyMatched : null;
    // EI-20186990913643457: same suppression as the other miss annotations — terminal
    // exhaustion only describes an actual fleet-scoped miss under a valid harness.
    const terminalExhaustionForMiss =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs ? terminalExhaustion : null;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            res
              ? assembleSchedulerClaimResult({
                  workItem: res.workItem,
                  claimedUnder: res.claimedUnder,
                  freshness,
                  warning,
                  routingHint,
                  memory,
                  checkpoint: checkpointHint?.checkpoint,
                  checkpointAgeMs: checkpointHint?.checkpointAgeMs,
                  checkpointWarning: checkpointHint
                    ? 'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).'
                    : undefined,
                  checkpointBgJobWarning: bgJobWarning.detected ? bgJobWarning.reason : undefined,
                  priorWork: priorWorkHint?.priorWork,
                  priorWorkWarning: priorWorkHint?.priorWorkWarning,
                  // EI-19396519606401168: this note used to be built from the
                  // POST-CAP length, so a capped brief announced itself as the
                  // complete set. The shared helper still renders the true total
                  // and says when older decisions are not shown.
                  planDecisions: planDecisions?.decisions,
                  planDecisionsNote,
                  premises: premises?.rendered,
                  premisesNote: premises?.note,
                })
              : invalidHarnessKnownSlugs
                ? {
                    ok: false,
                    error: 'invalid_input',
                    reason: 'harness_not_found',
                    message:
                      `harness '${args.harness}' does not resolve to a registered harness in this workspace — ` +
                      "pass the harness SLUG (e.g. 'papercusp'), not a workspace id or typo; see harness:list " +
                      'for valid slugs. This is a scope/argument problem, not a drained queue, so it is reported ' +
                      'as invalid_input and windDown is never set for it.',
                    passedHarness: args.harness,
                    knownHarnesses: invalidHarnessKnownSlugs,
                  }
                : reconciliation.scope
                  ? fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, {
                      cooldownDiag,
                      issueBreakdown: issueBreakdownForMiss,
                      featureFamilyMatched: featureFamilyMatchedForMiss,
                      terminalExhaustion: terminalExhaustionForMiss,
                      divergenceRecheck,
                      harness: args.harness,
                    })
                  : {
                    ok: false,
                    error: missDiagnosis.error,
                    // WI-4413: the miss now EXPLAINS itself — aggregate POOL/READY split, plus
                    // (when the spec names ids) the exact floor refusing each one.
                    ...(missDiagnosis.diagnosis ? { diagnosis: missDiagnosis.diagnosis } : {}),
                    ...(missDiagnosis.floors ? { floors: missDiagnosis.floors } : {}),
                    // P-006: teach the composed-await idle recipe exactly where the idle
                    // moment happens, instead of leaving the caller to a 60s re-poll.
                    advice: IDLE_PULL_MISS_ADVICE,
                  },
          ),
        },
      ],
    };
  },
});
