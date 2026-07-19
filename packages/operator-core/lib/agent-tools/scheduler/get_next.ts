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
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  getNextForBee,
  resolveClaimSpecWorkspace,
  getClaimSpecRecord,
  getActiveClaimsForBee,
} from '../../scheduler/claim-spec-store';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';
import { loadHarnessRegistry } from '../../harness-registry';
import { cancelClaimableAwaits } from '../../events/await/store';
import { withBoundedTimeout } from '../../bounded-timeout';

/** The claimable-state subset diagnoseClaimNextMiss accepts (mirrors CLAIM_STATES_ALLOWLIST). */
type ClaimNextStates = ('todo' | 'open' | 'failing')[] | undefined;
import { matchRoutingGateHint } from '../../routing-gate-hints';
import {
  fleetScopedMiss,
  reconcileFleetScopeClaims,
  readFleetPauseState,
  diagnoseFleetScopeCooldownMiss,
} from '../../scheduler/fleet-scope-admission';

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
        error:
          `${STATIC}. Diagnosis: you are mid-fleet-transition — your latest membership fact names ` +
          `fleet '${rec.fleetSlug}' but no valid per-bee or inherited fleet claim spec exists, so ` +
          `self-select fails CLOSED (WI-4770) regardless of pool size. Escape: have the leader install ` +
          `the fleet sentinel (scheduler:set_claim_spec { fleet }), set your own per-bee spec, or ` +
          `fleet:leave to settle to solo default pulls.`,
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
    const activeClaims = await getActiveClaimsForBee({
      cupId: args.ownerId,
      workspaceId: resolvedWorkspace,
    }).catch(() => null);
    if (activeClaims) {
      const maxConcurrentClaims = rec?.spec.limits?.maxConcurrentClaims ?? 1;
      if (activeClaims.length >= maxConcurrentClaims) {
        const heldIds = activeClaims.map((c) => c.id);
        return {
          error:
            `${STATIC}. Diagnosis: you already hold ${activeClaims.length}/${maxConcurrentClaims} concurrent ` +
            `claim(s) — release or complete one before claiming another; held: ${heldIds.join(', ')}.`,
          diagnosis: {
            concurrencyBlocked: true,
            activeClaims: activeClaims.length,
            maxConcurrentClaims,
            heldIds,
          },
        };
      }
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
      floors = attributed;
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

    return {
      error: `${STATIC}. Diagnosis: ${aggregate}.${namedSummary}${breakdownSummary}${flagReadErrorNote}`,
      diagnosis: {
        drained: diag.drained,
        pendingUnclaimed: diag.pendingUnclaimed,
        readyUnclaimed: diag.readyUnclaimed,
        ...(diag.flagReadError ? { flagReadError: diag.flagReadError } : {}),
      },
      floors,
      ...(excludedBreakdown ? { excludedBreakdown } : {}),
    };
  } catch {
    return { error: STATIC };
  }
}

export default defineTool({
  name: 'scheduler:get_next',
  profile: 'engineer',
  description:
    'Self-select via your claim SPEC: atomically claim the next eligible work-item under global floors + spec.view.filter, ordered by spec.rank, SKIP LOCKED. Outside a fleet, no spec uses default ordering with a warning. A fleet MEMBER with no matching/inherited spec fails closed with windDown:true; it never falls through to generic backlog. Returns the claimed item + selecting spec revision, or a self-describing miss.',
  guidance: {
    when: 'You are a SELF-PULLING agent picking up your next item — a coding-pot cup (role="cup"), or an su fleet MEMBER pulling its lane (su-loop-capability-parity). Call this instead of scanning the raw frontier or self-prioritizing: scheduling is your Mug\'s / fleet leader\'s judgment expressed as your claim spec; the pickup is yours. A claim-spec self-puller is a cup or an su fleet member, NOT a coding-factory pipeline role (see notWhen).',
    notWhen:
      'You are a coding-FACTORY pipeline role (scoper/architect/worker/validator/…): you are PUSHED a FEATURE_ID by the orchestrator spine and do NOT self-pull. Claiming a SPECIFIC item by id → work_items:claim. Plain oldest-first self-select is only for non-fleet callers → work_items:claim_next.',
    chaining:
      'scheduler:get_next → work_items:set_state → work_items:release. Your leader re-steers via scheduler:set_claim_spec. A non-fleet MISS may park on one work-item:claimable event. A fleet scoped miss returns windDown:true: checkpoint/release, loop:end, and report to the leader; resume only after a spec revision or claimable event.',
    seeAlso: [
      'work_items:claim_next (plain oldest-first self-select, no spec)',
      'work_items:claim (claim a SPECIFIC item by id)',
      'scheduler:set_claim_spec (the spec your queen or fleet leader steers you with)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
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
        "claimable states — subset of ['todo','open','failing']. Omit to inherit your claim spec's own `states` (drain-claim-spec-hardening-2026-07-13 D-002/EI-11300 — a fleet leader sets it once via scheduler:set_claim_spec, every member inherits it), else ['todo']. Passing this EXPLICITLY always wins over the spec. 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
      ),
    rigAvailable: z
      .boolean()
      .optional()
      .describe(
        'WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded — a single-box caller cannot execute them anyway.',
      ),
  }),
  async handler(args, ctx) {
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
            text: JSON.stringify(fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds)),
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
    const res = await getNextForBee({
      cupId: ident.ownerId,
      // WI-1564: MUST match the partition scheduler:set_claim_spec writes
      // (same resolveClaimSpecWorkspace helper) — a reader left on 'default'
      // while the queen writes the workspace partition (or a federated spec
      // arrives under the booted workspace) silently falls back to
      // DEFAULT_CLAIM_SPEC and the steer never lands.
      workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      harness: args.harness,
      heldPaths: args.heldPaths,
      states: args.states,
      rigAvailable: args.rigAvailable,
      ignoreStoredSpec: !specOn && !reconciliation.scope,
      // P-006 (fleet-leader-frictions-six-improvements-2026-07-10, WI-3763): this is
      // THE live fleet-member self-pull surface — a miss here is the real "claim-spec
      // view is empty" signal a fleet leader wants pushed, so opt in.
      checkIdleDrainOnMiss: true,
    });
    // EI-8579: a self-puller with NEITHER a per-bee NOR an inherited fleet spec resolves to
    // DEFAULT_CLAIM_SPEC (plain oldest-first) — it can silently draw owner-deferred work
    // (a paused/de-scoped category) a curated spec would have excluded. Advisory only (the
    // claim already happened): nudge the caller to set its own spec, same non-blocking
    // posture as set_claim_spec's EI-6079 wakeability warning.
    const warning =
      res && res.specSource === 'default'
        ? 'You have no per-bee or fleet claim spec — this claim used plain oldest-first DEFAULT_CLAIM_SPEC, which can hand you owner-deferred work (e.g. a paused/de-scoped category). Consider scheduler:set_claim_spec {cupId: you} to scope your own pulls.'
        : undefined;
    // EI-8809 (routing-gate hint at dispatch): most items are already stamped
    // payload.routingHint at creation (work_items:create / plans:promote); this is
    // the render-time FALLBACK for an item created before that wiring landed.
    // Hint only — never blocks, never overrides a stamped value.
    let routingHint: unknown;
    if (res?.workItem) {
      const wi = res.workItem as { title?: string; summary?: string; payload?: unknown };
      const existing =
        wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
          ? (wi.payload as Record<string, unknown>).routingHint
          : undefined;
      routingHint = existing ?? matchRoutingGateHint(wi.title) ?? undefined;
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
    if (res?.workItem) {
      const wi = res.workItem as { id: string; harness?: string | null };
      checkpointHint = await import('../../work-item-checkpoint')
        .then((m) => m.getClaimTimeCheckpointHint({ harness: wi.harness ?? null, workItemId: wi.id, workspaceId: ident.workspaceId ?? undefined }))
        .catch(() => null);
    }
    // EI-10541: a successful self-pull means this agent is transitioning idle -> working, so
    // cancel its standing `work-item:claimable` idle-park await(s) — holding a claim and waiting
    // for claimable work are mutually exclusive, and a pre-claim await left armed (e.g. this claim
    // came from a leader-fed spec bump, not the await firing) otherwise keeps firing spurious ~30-min
    // timeout wakes while the agent is busy. Best-effort + subscriber-scoped: a cancel failure must
    // never break the claim path (fails soft, like the recall port above).
    if (res?.workItem) {
      await cancelClaimableAwaits(ident.ownerId).catch(() => 0);
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
      : await buildMissDiagnosis({
          ownerId: ident.ownerId,
          workspaceId: ident.workspaceId,
          harness: args.harness,
          states: args.states,
          rigAvailable: args.rigAvailable,
        });
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
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            res
              ? {
                  ok: true,
                  workItem: res.workItem,
                  claimedUnder: res.claimedUnder,
                  ...(warning ? { warning } : {}),
                  ...(routingHint ? { routingHint } : {}),
                  ...(memory ? { memory } : {}),
                  ...(checkpointHint
                    ? {
                        checkpoint: checkpointHint.checkpoint,
                        checkpointAgeMs: checkpointHint.checkpointAgeMs,
                        checkpointWarning:
                          'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).',
                      }
                    : {}),
                }
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
                  ? fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, { cooldownDiag })
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
