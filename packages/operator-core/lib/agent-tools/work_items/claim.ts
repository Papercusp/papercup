/**
 * work_items:claim — Claimable (D-003). Assigns the work-item to an agent
 * (feature-family → taken_by; issue-family → assignee) and subscribes the claimer.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ id, assignee? }), MANY for the SAME assignee (ids:[…] + assignee?), or MANY
 * heterogeneous (items:[{ id, assignee?, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error… }], counts }. Each result self-describes its id; a
 * claim_conflict on one item never fails the rest (top-level ok = "the batch ran",
 * counts.failed is the truth — D-005). The claim lifecycle emit fires per claimed
 * item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  resolveAgentIdentity,
  SUPERUSER_FALLBACK_CLIENT_ID,
  isEphemeralMcpCallIdentity,
  type AgentIdentity,
} from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  claimWorkItem,
  classifyClaimFailure,
  getWorkItem,
  readUnresolvedDepBlockers,
  readWorkItemClaimHoldProvenance,
  type UnresolvedDepBlocker,
} from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';
import type { CellReader } from '../../cell-registry';
import { shapeWorkItemWriteEcho } from './write-echo-shape';
import {
  admitWorkItemForFleetTarget,
  notifyFleetScopeRefusal,
  fleetScopeLeaderRemedy,
  renderFleetDependencyEscape,
} from '../../scheduler/fleet-scope-admission';
import { getClaimTimeCheckpointHint } from '../../work-item-checkpoint';
import {
  authorshipRevalidationWarning,
  getClaimTimeAuthorshipRevalidationHint,
  getClaimTimePriorWorkHint,
  priorWorkWarning,
} from '../../work-item-prior-work';
import { planItemClaimCollision } from '../../scheduler/plan-item-claim-collision';
import {
  getClaimTimePlanItemContradiction,
  planItemContradictionWarning,
} from '../../work-item-plan-contradiction';
import { detectBgJobCheckpointClaim } from '../../checkpoint-bg-job-claim';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { getClaimTimeRetractionAdvisory } from './retraction-advisory';
// TYPE-only: erased at runtime, so it adds no import edge and cannot reintroduce an ESM
// cycle with the scheduler (the VALUE side is dynamically imported at its use site below,
// the same way fleet:leader-brief reaches this store).
import type { ClaimConcurrencyVerdict } from '../../scheduler/claim-spec-store';
import { assessClaimHoldGuard, recordClaimHoldBypassAudit, notifyClaimHoldBypass } from './claim-hold-guard';

interface ClaimItem {
  id: string;
  assignee?: string;
  harness?: string;
  force?: boolean;
  ownerOverride?: boolean;
}

/**
 * WI-5826: the warning a by-id claim MUST carry when the claimed row is already terminal.
 *
 * Claiming a finished item by id is deliberately ALLOWED (EI-8972 — "a completed row is STILL
 * directly claimable by id; the floor only gates self-select"): naming a finished item is how you
 * reopen it, inherit ownership, or attach follow-up work. What was missing is any SIGNAL — the
 * tool returned a bare ok:true on a state='done' row, so an agent could not distinguish fresh work
 * from finished work. Confirmed live 2026-07-26: work_items:claim{id:'EI-18645423267952485'} came
 * back ok:true on a row already done with terminalCompletionRef stamped, and was caught only
 * because that agent happened to read the returned workItem closely.
 *
 * EI-529 saw this class and mitigated it with a checkpointWarning, but that fires only when a
 * prior CHECKPOINT happens to exist; a completed item without one — the common case — still looked
 * like fresh work. This keys on the item's own terminal state instead, so it cannot be missed.
 *
 * Pure + exported so the guarantee is directly testable: the claim must keep SUCCEEDING (EI-8972's
 * decision) AND keep WARNING (this fix), and a future edit must not be able to silently drop one.
 */
export function terminalClaimWarning(
  workItem:
    | {
        state?: string | null;
        terminalOwner?: string | null;
        terminalCompletionRef?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!workItem) return null;
  const state = String(workItem.state ?? '').trim();
  const owner = String(workItem.terminalOwner ?? '').trim();
  const ref = String(workItem.terminalCompletionRef ?? '').trim();

  // "Finished" has TWO independent expressions here and the warning must catch both, because
  // the live miss and the pre-existing test each exhibit a DIFFERENT one:
  //   (a) a terminal `state` (done/resolved/closed/…) — the shape reported live 2026-07-26;
  //   (b) terminal_owner AND terminal_completion_ref both stamped — the shape EI-8972's
  //       self-select floor keys on, which can sit on a row whose state is still 'open'.
  // Keying on (a) alone silently missed (b) — caught by the guard test below, which seeds
  // exactly that row. EI-8972 is deliberate that BOTH columns are required for (b): a row with
  // only ONE set is NOT a genuine completion (it has its own two tests asserting it stays
  // claimable by self-select), so requiring both here keeps this warning consistent with the
  // floor instead of inventing a second, stricter notion of "done".
  const stateTerminal = state !== '' && ANY_FAMILY_TERMINAL_STATES.includes(state.toLowerCase());
  const genuinelyCompleted = owner !== '' && ref !== '';
  if (!stateTerminal && !genuinelyCompleted) return null;

  const label = stateTerminal ? state.toUpperCase() : 'COMPLETED';
  return (
    `⚠ THIS ITEM IS ALREADY ${label}` +
    (ref ? ` (completed: "${ref}"${owner ? ` by ${owner}` : ''})` : '') +
    '. The claim SUCCEEDED — claiming a finished item by id is allowed on purpose (reopen / inherit ' +
    'ownership / attach follow-up) — but this is NOT fresh work. Do NOT rebuild it: read the ' +
    'completion first and verify against the tree. If you wanted new work, release this and use ' +
    'scheduler:get_next instead.'
  );
}

/**
 * P-013 (work-item-dependency-edges-2026-08-02): the warning a by-id claim MUST carry when the
 * claimed row has UNRESOLVED BLOCKERS. The exact parallel of `terminalClaimWarning` above, for
 * the same reason and with the same contract.
 *
 * D-008 settled that dependency-blocking is a READINESS floor, so it gates SELF-SELECT only and
 * the by-id claim stays the deliberate operator override: naming a blocked item is how you take
 * ownership OF it in order to unblock it, and adding a floor here would break EI-8972's tested
 * escape hatch and make blocked work unreopenable by name. But the by-id claimer was then told
 * NOTHING — `scheduler:get_next` will not serve this item, and the claim returned a bare ok:true
 * that is indistinguishable from claiming ready work. That is the WI-5826 defect class exactly:
 * not a missing floor, a missing SIGNAL, fixed in the claim TOOL's response rather than in the
 * UPDATE.
 *
 * Pure + exported so both halves of the guarantee are directly testable — the claim must keep
 * SUCCEEDING (D-008) AND keep WARNING (this) — and so a future edit cannot silently drop one.
 * Takes the already-read blockers rather than reading them itself, which is what keeps it pure;
 * `readUnresolvedDepBlockers` is the read, shared with the floor's own predicate so this can
 * never name a blocker the queue does not gate on.
 */
export function blockedClaimWarning(blockers: readonly UnresolvedDepBlocker[] | null | undefined): string | null {
  if (!blockers || blockers.length === 0) return null;
  const named = blockers.map((b) => b.ref).filter((r) => r.trim() !== '');
  if (named.length === 0) return null;
  const shown = named.slice(0, 8);
  const more = named.length - shown.length;
  return (
    `⚠ THIS ITEM IS BLOCKED by ${named.length} unresolved ${named.length === 1 ? 'dependency' : 'dependencies'}: ` +
    `${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}. ` +
    'The claim SUCCEEDED — a by-id claim deliberately overrides readiness floors, which is how you ' +
    'take ownership of blocked work in order to unblock it (D-008) — but scheduler:get_next will ' +
    'NOT serve this item, so do not read the successful claim as "ready to build". Either work the ' +
    'blockers first, or — if the edge is stale — drop it with work_items:link { id:<blocker>, ' +
    'rel:"blocks", target_id:<this item>, remove:true } (the BLOCKER is the source of a blocks edge).'
  );
}

/**
 * EI-19313376980892266: the warning a by-id claim MUST carry when the claimer is ALREADY at
 * its `maxConcurrentClaims` cap. The THIRD member of the terminalClaimWarning /
 * blockedClaimWarning set, for the same reason and with the same contract.
 *
 * ⚠ THE FILING THAT PRODUCED THIS ITEM ASKED FOR A GATE HERE. That prescription was WRONG and
 * is retracted. It read `work_items:claim`'s non-enforcement of the concurrency cap as the
 * fourth divergent behaviour in a "one oracle" bug — but the governing ruling is
 * `work-item-dependency-edges-2026-08-02#D-008`: "EXEMPT the by-id claim from the blocking
 * floor and SIGNAL instead — READINESS floors gate self-select only; SECURITY floors gate
 * everywhere." A concurrency cap is squarely a readiness floor (it is about the claimer's
 * capacity, not its authorization), so it gates self-select and signals here.
 *
 * claim-door-census.test.ts encodes the same ruling as an executable classification
 * (`claimWorkItem` → `by-id-ungated`) and names the trap verbatim: "a census that demanded
 * every door gate would encode the wrong invariant and fail working code — which is worse than
 * no census, because someone would then 'fix' the code to satisfy it." Adding a refusal here
 * would have been exactly that fix, and would have broken the legitimate flows the by-id path
 * exists for: a leader dispatching a specific item to a specific member, and a drain leader
 * claiming a swath via { ids:[…] }.
 *
 * ⚠ CITATION NOTE, because this cost four lookups to resolve: D-008 lives on
 * `work-item-dependency-edges-2026-08-02`, NOT on the similarly-named
 * `dependency-subsystem-thorough-testing-2026-08-02` (whose decisions are D-001/D-002 and
 * D-018-D-021). Two dependency plans of the same date, each with a P-009 and a P-013. Always
 * cite this one as `<planSlug>#D-NNN`.
 *
 * What was genuinely missing is what was missing in the other two cases: not a floor, a
 * SIGNAL. `scheduler:get_next` refuses to serve an at-cap bee (get_next.ts, concurrencyBlocked)
 * and `fleet:leader-brief` now reports it, but a by-id claim returned a bare ok:true — so an
 * over-cap lane could be built up one named claim at a time with nothing ever saying so, and
 * the holder's own next `get_next` would then refuse them with a diagnosis that reads as a
 * surprise. THAT is the divergence worth closing, and a warning closes it without touching the
 * override.
 *
 * Takes the already-read verdict rather than reading it itself, which is what keeps it pure —
 * and the verdict comes from the shared `evaluateClaimConcurrency`, so this can never name a
 * cap the queue does not actually refuse on.
 */
export function concurrencyClaimWarning(
  verdict: ClaimConcurrencyVerdict | null | undefined,
  claimedId: string,
): string | null {
  if (!verdict?.blocked) return null;
  // The verdict is PRE-claim, so the item just claimed is not in `heldIds` — subtract it
  // anyway rather than trust that, so a retry/re-claim of an item the caller already holds
  // can never be reported as if it were an additional lane.
  const held = verdict.heldIds.filter((id) => id !== claimedId);
  const shown = held.slice(0, 8);
  const more = held.length - shown.length;
  return (
    `⚠ YOU WERE ALREADY AT YOUR CONCURRENCY CAP (${verdict.activeClaims}/${verdict.maxConcurrentClaims}) ` +
    `BEFORE THIS CLAIM` +
    (shown.length > 0 ? `, holding: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}` : '') +
    '. The claim SUCCEEDED — a by-id claim deliberately overrides self-select readiness floors, ' +
    'which is how a leader dispatches a specific item and how { ids:[…] } takes a swath — but ' +
    'scheduler:get_next WILL now refuse to serve you (concurrencyBlocked), so do not read this ' +
    'success as "the queue agrees I have capacity". Either release/complete a held item ' +
    '(work_items:release / work_items:complete), or — if this lane genuinely needs more than ' +
    'one item at a time — raise the cap deliberately with scheduler:set_claim_spec ' +
    '{ limits: { maxConcurrentClaims: N } } rather than accumulating past it one claim at a time. ' +
    'A PARKED item still counts: it retains taken_by.'
  );
}

/**
 * Claim ONE item, returning the self-describing result. On the compare-and-claim
 * loss, re-read + classify (EI-2197) so the agent gets an accurate, actionable
 * error (claim_conflict + holder, not_found, or not_claimable) rather than a
 * phantom "not found".
 */
async function claimOne(itRaw: ClaimItem, identity: AgentIdentity, reader: CellReader | null): Promise<BulkItemResult> {
  const claimerDefault = identity.ownerId;
  // EI-9274: a literal `'self'` assignee is treated identically to an OMITTED one
  // (resolved to the caller) — including for the implicit-identity guards below, so
  // `assignee: 'self'` under a loopback/ephemeral identity is refused the same way an
  // omitted assignee would be, instead of bypassing the guard and silently orphaning
  // the claim under an unmatchable literal "self" ownerId (previously stored verbatim —
  // WI-3881).
  const it: ClaimItem = { ...itRaw, assignee: itRaw.assignee === 'self' ? undefined : itRaw.assignee };
  if (!it.assignee && claimerDefault === SUPERUSER_FALLBACK_CLIENT_ID) {
    return {
      ok: false,
      id: it.id,
      error: 'missing_client_identity',
      hint: 'Implicit work-item claims require a real per-session or spawn owner. This request arrived as the shared su-loopback fallback, so it was refused before mutating the claim. Reconnect with a client identity or pass an explicit assignee.',
    };
  }
  // EI-8509: refuse an IMPLICIT claim under scripts/mcp-call.mjs's auto-generated
  // fallback identity (`mcp-call-<pid>`) — a one-shot stateless call with zero
  // liveness behind it, never a real spawned cup. Left unguarded, this is exactly
  // how "placed" work silently rots with nothing ever executing it (fleet_assignments
  // showed 4 such claims: assignee set, lastProgressAt/heartbeatAt null, sessionState
  // 'ended'). An explicit `assignee` (naming a real agent on purpose) still passes.
  if (!it.assignee && isEphemeralMcpCallIdentity(claimerDefault)) {
    return {
      ok: false,
      id: it.id,
      error: 'ephemeral_mcp_call_identity',
      hint: 'Refused: this call arrived under scripts/mcp-call.mjs\'s auto-generated fallback identity (mcp-call-<pid>), a one-shot process with no liveness/heartbeat and no fleet cup behind it — claiming here would silently "place" work that nothing executes (EI-8509). Spawn a real cup (fleet:spawn / bee:spawn) and let IT claim, or pass an explicit `assignee` naming the real agent that will do the work.',
    };
  }
  const claimer = it.assignee ?? claimerDefault;
  // EI-19313376980892266: start the concurrency read NOW, the moment the claimer is known, and
  // await it only in the success branch — it is independent of admission, the pre-claim lookup
  // and the claim itself, so overlapping them keeps this off the claim's critical path.
  //
  // PRE-claim on purpose. `evaluateClaimConcurrency` answers "would the scheduler refuse this
  // bee another item", i.e. `activeClaims >= max`. Read AFTER the claim landed, an ordinary
  // single claim under a cap of 1 satisfies that (1 >= 1) and would warn on every normal claim
  // — the warning has to key on the state the caller was in when they asked, which is exactly
  // the state get_next would have judged.
  //
  // Resolves the claimer's OWN effective limit (getClaimSpecRecord applies the bee → fleet →
  // DEFAULT inheritance). Defaulting to 1 here would be the easy wiring and would be WRONG in
  // the expensive direction: a member legitimately running under a leader-authored
  // concurrency > 1 would be warned it is over a cap that does not exist, which is the
  // false-positive mirror of the false-negative that produced this item.
  //
  // Fail-soft to null (never a fabricated verdict): this is a signal, not a floor, so a
  // degraded spec/claims read must cost the warning and never the claim.
  const concurrencyBefore = (async (): Promise<ClaimConcurrencyVerdict | null> => {
    try {
      const { readClaimConcurrency, getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
      const rec = await getClaimSpecRecord({
        cupId: claimer,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => null);
      return await readClaimConcurrency({
        cupId: claimer,
        workspaceId: identity.workspaceId ?? undefined,
        maxConcurrentClaims: rec?.spec.limits?.maxConcurrentClaims,
      });
    } catch {
      return null;
    }
  })();
  const admission = await admitWorkItemForFleetTarget({
    target: claimer,
    workItemId: it.id,
    harness: it.harness,
    workspaceId: identity.workspaceId,
  });
  if (!admission.allowed) {
    // WI-6326: reuse the SAME liveness read notifyFleetScopeRefusal just performed for
    // the leader notification — never a second lookup — so the caller-facing hint's
    // "route elsewhere" advice is code-conditional too, not just the leader's copy.
    // EI-19484346966003625 (R1): pass the item's harness so the notice can report whether
    // the spec is refusing a CLASS. This is the seam that produced the original evidence —
    // WI-7264 was refused here twice under one spec revision, and the advice both times was
    // to widen for that row.
    const { liveRouteTarget, classRefusal, dependencyEscape } =
      (await notifyFleetScopeRefusal(identity, admission, `work_items:claim ${it.id} → ${claimer}`, {
        harness: it.harness,
        // EI-18680302159738037: name the pair structurally so fleet:leader-brief can
        // list this block instead of leaving it to be buried as ordinary inbox mail.
        subject: { itemId: it.id, member: claimer },
      })) ?? {};
    return {
      ok: false,
      id: it.id,
      error: admission.code,
      ...(dependencyEscape ? { dependencyEscape } : {}),
      // EI-18673501896258575: surface the SAME concrete remedy the fleet leader was just
      // notified with, to the CALLER too — previously only fleetScopeLeaderRemedy's text
      // reached the leader (via notifyFleetScopeRefusal); the refused caller saw only the
      // bare reason and had no way to know "widen the spec" was even an option, let alone
      // the exact scheduler:set_claim_spec call shape, so a member acting on an explicit
      // leader directive had to file the work unclaimed and wait, blind, for their leader
      // to notice the notification.
      hint:
        `${admission.reason}. The claim was refused before mutation. ` +
        `${fleetScopeLeaderRemedy(admission, liveRouteTarget, classRefusal)}` +
        (dependencyEscape ? ` ${renderFleetDependencyEscape(dependencyEscape)}` : ''),
    };
  }
  // WI-5946: the by-id claim path never checked `payload._claimHold` — an owner-gated hold
  // (D-003; work_items:hold_open / release{claimHold:true}) was silently claimable by anyone
  // naming the id, even though the SAME flag already refuses self-select AND a non-holder's
  // terminal transition (setWorkItemState's held-open guard). Pre-read the item and mirror
  // hold_open's own clear-guard (force + a stricter ownerOverride for a policy-tier reason,
  // EI-18672701535825889) — one shared predicate (assessClaimHoldGuard), never a bypassable gap.
  // WI-6746: this pre-read IS the hold guard — claimWorkItem gates on taken_by + G2/P-010
  // admission and knows nothing about held_open/claim_hold. So swallowing the read to null
  // (the old `.catch(() => null)`) did not degrade the guard, it DELETED it: a PG fault
  // produced a null item, hence a null refusal, hence a completed claim past a hold someone
  // deliberately placed — un-audited and un-notified, because the provenance read below is
  // derived from the same null. Fail CLOSED instead: an unreadable item is not an unheld one.
  const preClaim = await lookupWorkItem(it.id, it.harness);
  if (preClaim.status === 'unreadable') {
    return {
      ok: false,
      id: it.id,
      error: 'work_item_unreadable',
      hint:
        `${it.id} could not be read, so its claim-hold state is UNKNOWN — the read failed (${preClaim.error}). ` +
        'Refusing the claim rather than risk bypassing a hold. This is a READ FAILURE, not a missing or unheld item: retry, ' +
        'and if it persists check database health (dev:pg_health) rather than the item.',
    };
  }
  const preClaimItem = preClaim.status === 'found' ? preClaim.item : null;
  const claimHoldRefusal = preClaimItem
    ? assessClaimHoldGuard(preClaimItem.payload, { force: it.force, ownerOverride: it.ownerOverride })
    : null;
  if (claimHoldRefusal) {
    return {
      ok: false,
      id: it.id,
      workItem: preClaimItem,
      error: claimHoldRefusal.error,
      heldBy: claimHoldRefusal.heldBy,
      heldReason: claimHoldRefusal.heldReason,
      convention: claimHoldRefusal.convention,
      hint: `${it.id} is ${claimHoldRefusal.hint}`,
    };
  }
  // `preClaimItem` reaching here with a hold means force (and, for a policy-tier reason,
  // ownerOverride) already cleared the guard above — re-derive the SAME provenance once more
  // (cheap, pure, no extra query) purely to know WHOM to audit/notify after the claim lands.
  const priorHoldForNotify = preClaimItem ? readWorkItemClaimHoldProvenance(preClaimItem.payload) : null;
  const bypassedHold = priorHoldForNotify?.heldOpen ?? priorHoldForNotify?.parked ?? null;
  const bypassedHoldConvention: 'held_open (lease)' | 'claim_hold (durable park)' | null = priorHoldForNotify?.heldOpen
    ? 'held_open (lease)'
    : priorHoldForNotify?.parked
      ? 'claim_hold (durable park)'
      : null;
  // EI-19313376980892266: RESOLVE the concurrency verdict BEFORE the claim mutates the rows it
  // counts. Starting the read early is not enough — it is `getActiveClaimsForBee` against the
  // same `taken_by` column the claim below writes, so awaiting it later (e.g. in the hint batch)
  // is a genuine race: if the claim's UPDATE commits first the read returns the just-claimed row
  // and an ORDINARY first claim reports itself as "1/1, already at cap". That is a false positive
  // on every claim, and it is what the batch test caught. Awaiting here costs nothing measurable
  // because the read has been in flight across admission + the pre-claim lookup already.
  const concurrency = await concurrencyBefore;
  const workItem = await claimWorkItem(it.id, claimer, { harness: it.harness });
  if (workItem && bypassedHold && bypassedHoldConvention) {
    // Forced past a claim-hold — leave the hold IN PLACE (this never clears it; a leader lifts
    // it explicitly via work_items:hold_open{clear:true}) but leave a forensic trail identical
    // in shape to work_items:release's own force-bypass audit + notify (release-force-guard.ts).
    void recordClaimHoldBypassAudit(claimer, it.id, {
      heldBy: bypassedHold.by,
      heldReason: bypassedHold.reason,
      convention: bypassedHoldConvention,
      harness: workItem.harness ?? it.harness ?? null,
      ownerOverride: Boolean(it.ownerOverride),
    });
    void notifyClaimHoldBypass(identity, {
      itemId: it.id,
      heldBy: bypassedHold.by,
      heldReason: bypassedHold.reason,
      convention: bypassedHoldConvention,
      harness: workItem.harness ?? it.harness ?? null,
    });
  }
  if (workItem) {
    // WI-5826: see terminalClaimWarning — a by-id claim of a finished row stays ALLOWED
    // (EI-8972) but can no longer be mistaken for fresh work.
    const terminalWarning = terminalClaimWarning(workItem);
    // EI-529: this is the NAMED-assignee dispatch path (a leader/dispatcher assigning a
    // SPECIFIC item to a SPECIFIC agent) — exactly the shape the report's "brief dispatch
    // re-assigns already-completed work" pattern hit. Surface a prior holder's checkpoint
    // (when one exists) so the new assignee starts in verify-mode instead of rebuilding.
    // P-001 (fleet-leadership-continuity-and-actuation-2026-08-01): the THIRD guard in this set.
    // EI-529 above fires only when a checkpoint exists; terminalClaimWarning only when the row is
    // finished. An item that is open, unassigned, checkpoint-less AND already worked slips both —
    // the WI-6096 shape, where a compaction released the claim and lost the checkpoint on a
    // fully-built, CI-wired feature. Fetched in PARALLEL with the checkpoint hint (independent
    // reads; no reason to pay two round-trips serially), then told whether a checkpoint exists so
    // it can escalate its wording when one does not.
    // P-007 (same plan): the FOURTH guard, and the one about a PEER rather than the past.
    // The three above all ask "has this item been worked before?"; this asks "is someone else
    // holding its plan lane RIGHT NOW?" — the work-item was unassigned and claimable, yet its
    // linked plan item can be held by a live peer, because the two are separate records with
    // separate ownership. `work_items:get` has surfaced this since agent-trap-guards-2026-07-26,
    // but CLAIM — the one call that actually starts the duplicated work — did not, so the drift
    // was only ever discoverable by an agent who thought to look first. Same detector, same
    // fail-open contract, wired at the moment the decision is made.
    //
    // Compares against the POST-claim row, whose assignee is now the claimer, so a lane held by
    // this same agent (the normal, non-diverged case) is correctly silent.
    // WI-6737: record that the checkpoint read FAILED, rather than letting its `null` be read as
    // "no checkpoint exists" a few lines below. The hint itself stays fail-soft (`null`) — only
    // the reason is now recoverable.
    // P-013: the FIFTH guard, and the only one about the item's FUTURE rather than its past.
    // The four above ask "has this been worked, or is a peer on it?"; this asks "can this item
    // even proceed?" — a by-id claim of a dependency-blocked row succeeds by design (D-008) but
    // the queue will never serve it, and nothing said so. Joins the same parallel batch (an
    // independent read; no reason to pay a serial round-trip) and is fail-soft for the reason
    // given on readUnresolvedDepBlockers: saying nothing here asserts nothing.
    let checkpointReadFailed = false;
    const [
      hint,
      priorRaw,
      authorshipRevalidation,
      laneCollision,
      unresolvedBlockers,
      premises,
      planDecisionsResult,
      retractionAdvisory,
      planContradiction,
    ] = await Promise.all([
      getClaimTimeCheckpointHint({
        harness: workItem.harness ?? it.harness ?? null,
        workItemId: it.id,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => {
        checkpointReadFailed = true;
        return null;
      }),
      getClaimTimePriorWorkHint({
        harness: workItem.harness ?? it.harness ?? null,
        workItemId: it.id,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => null),
      getClaimTimeAuthorshipRevalidationHint({
        harness: workItem.harness ?? it.harness ?? null,
        workItemId: it.id,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => null),
      planItemClaimCollision(workItem).catch(() => null),
      readUnresolvedDepBlockers(it.id, workItem.harness ?? it.harness ?? undefined).catch(() => null),
      // false-premise-in-prescriptive-artifacts-2026-08-02 P-001: the item's own
      // load-bearing premises, surfaced at the moment before the cost is paid.
      // Joins this same parallel batch (an independent read) and is fail-soft for
      // the reason every sibling hint here is: saying nothing asserts nothing.
      import('../../premises-claim-port')
        .then((m) =>
          m.getClaimTimePremises({
            workItem: {
              id: workItem.id ?? it.id,
              payload: workItem.payload,
              title: workItem.title,
              summary: workItem.summary,
            },
            harness: workItem.harness ?? it.harness ?? null,
            workspaceId: identity.workspaceId ?? undefined,
          }),
        )
        .catch(() => null),
      // EI-19387745408924340: agent-trap-guards-2026-07-26 P-003b's plan-Decisions
      // brief was wired at scheduler:get_next ONLY — a by-id claim (this surface)
      // of a plan-bound item saw no governing decisions at all. Same fail-soft
      // seam as every other hint above; rendered via the shared helper so the
      // note text cannot drift from scheduler:get_next's copy.
      import('../../plan-decisions-claim-port')
        .then(async (m) => {
          const brief = await m.getClaimTimePlanDecisions({
            workItem: { payload: workItem.payload },
            harness: workItem.harness ?? it.harness ?? null,
            workspaceId: identity.workspaceId ?? undefined,
          });
          return brief ? { decisions: brief.decisions, note: m.renderPlanDecisionsNote(brief) } : null;
        })
        .catch(() => null),
      getClaimTimeRetractionAdvisory(workItem, workItem.harness ?? it.harness ?? undefined),
      // WI-39498: the plan-says-done contradiction — the linked plan item is already
      // terminal (often annotated "← <this id> completed") while THIS row is still open,
      // so the work may already be finished. The one hint priorWorkWarning cannot carry
      // (it keys on prior-holder history, not on the plan/work-item contradiction). Same
      // fail-soft seam as every sibling hint above: saying nothing asserts nothing.
      getClaimTimePlanItemContradiction({
        workItemId: workItem.id ?? it.id,
        payload: workItem.payload,
      }).catch(() => null),
    ]);
    const blockedWarning = blockedClaimWarning(unresolvedBlockers);
    const concurrencyWarning = concurrencyClaimWarning(concurrency, it.id);
    // WI-6737: `hint` is null for BOTH "no checkpoint exists" and "the checkpoint read threw"
    // (the .catch above), so it cannot decide `hasCheckpoint` alone — collapsing the failure into
    // `false` makes priorWorkWarning assert "NO checkpoint was ever written" during an outage.
    // Re-derive the failure explicitly instead of inferring absence from a swallowed error.
    const priorWork = priorRaw
      ? { ...priorRaw, hasCheckpoint: checkpointReadFailed ? ('unknown' as const) : hint != null }
      : null;
    const priorWorkWarn = priorWorkWarning(priorWork);
    const authorshipRevalidationWarn = authorshipRevalidationWarning(authorshipRevalidation);
    // EI-18654296679612119: a SEPARATE, CONDITIONAL warning — only when the checkpoint text
    // itself cites a background job/task as evidence — rather than growing the EI-529 text
    // above unconditionally (which would fire on every checkpointed claim, background job or
    // not). See detectBgJobCheckpointClaim for why this can't be a live PID check here.
    const bgJobWarning = hint ? detectBgJobCheckpointClaim(hint.checkpoint) : { detected: false };
    const planContradictionWarn = planItemContradictionWarning(planContradiction, workItem.id ?? it.id);
    return hint
      ? {
          ok: true,
          id: it.id,
          workItem,
          checkpoint: hint.checkpoint,
          checkpointAgeMs: hint.checkpointAgeMs,
          checkpointWarning:
            'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).',
          ...(bgJobWarning.detected ? { checkpointBgJobWarning: bgJobWarning.reason } : {}),
          ...(terminalWarning ? { terminalWarning } : {}),
          ...(retractionAdvisory ? { retractionWarning: retractionAdvisory.retractionWarning } : {}),
          ...(blockedWarning ? { blockedWarning, blockedBy: unresolvedBlockers } : {}),
          ...(concurrencyWarning
            ? {
                concurrencyWarning,
                concurrency: {
                  activeClaims: concurrency!.activeClaims,
                  maxConcurrentClaims: concurrency!.maxConcurrentClaims,
                  heldIds: concurrency!.heldIds,
                },
              }
            : {}),
          ...(priorWorkWarn ? { priorWork, priorWorkWarning: priorWorkWarn } : {}),
          ...(planContradictionWarn
            ? { planItemContradiction: planContradiction, planItemContradictionWarning: planContradictionWarn }
            : {}),
          ...(authorshipRevalidationWarn
            ? { authorshipRevalidation, authorshipRevalidationWarning: authorshipRevalidationWarn }
            : {}),
          ...(laneCollision ? { planItemClaimCollision: laneCollision } : {}),
          ...(premises ? { premises: premises.rendered, premisesNote: premises.note } : {}),
          ...(planDecisionsResult
            ? { planDecisions: planDecisionsResult.decisions, planDecisionsNote: planDecisionsResult.note }
            : {}),
        }
      : {
          ok: true,
          id: it.id,
          workItem,
          ...(terminalWarning ? { terminalWarning } : {}),
          ...(retractionAdvisory ? { retractionWarning: retractionAdvisory.retractionWarning } : {}),
          ...(blockedWarning ? { blockedWarning, blockedBy: unresolvedBlockers } : {}),
          ...(concurrencyWarning
            ? {
                concurrencyWarning,
                concurrency: {
                  activeClaims: concurrency!.activeClaims,
                  maxConcurrentClaims: concurrency!.maxConcurrentClaims,
                  heldIds: concurrency!.heldIds,
                },
              }
            : {}),
          ...(priorWorkWarn ? { priorWork, priorWorkWarning: priorWorkWarn } : {}),
          ...(planContradictionWarn
            ? { planItemContradiction: planContradiction, planItemContradictionWarning: planContradictionWarn }
            : {}),
          ...(authorshipRevalidationWarn
            ? { authorshipRevalidation, authorshipRevalidationWarning: authorshipRevalidationWarn }
            : {}),
          ...(laneCollision ? { planItemClaimCollision: laneCollision } : {}),
          ...(premises ? { premises: premises.rendered, premisesNote: premises.note } : {}),
          ...(planDecisionsResult
            ? { planDecisions: planDecisionsResult.decisions, planDecisionsNote: planDecisionsResult.note }
            : {}),
        };
  }
  // claimWorkItem returns a bare null for THREE distinct outcomes — re-read + classify.
  const current = await getWorkItem(it.id, it.harness);
  const failure = classifyClaimFailure(current, claimer);
  if (failure.reason === 'not_found') {
    return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };
  }
  if (failure.reason === 'conflict') {
    // P-027 / D-055 A2 — THE contention point: the caller is blocked BY a named
    // holder and is deciding whether to wait, escalate, or go elsewhere. The
    // refusal already names WHO; this names what they are DOING, which is the
    // input that decision actually turns on.
    //
    // ⚠ ADVISORY ONLY, AND STRICTLY AFTER THE VERDICT. `failure.reason` is
    // already decided above; nothing here can promote a conflict to a grant. It
    // is also total (`resolveHolderAdvisory` never throws), so a dead facts store
    // costs the explanation and never the refusal — P-026 rule (f).
    //
    // D-094: the subject is subtracted, so the holder is never reported as
    // "also competing on" the very item being refused.
    const holderContext = await resolveHolderAdvisory({
      holder: failure.holder,
      reader,
      subjectRef: it.id,
    });
    return {
      ok: false,
      id: it.id,
      error: 'claim_conflict',
      holder: failure.holder,
      workItem: current,
      ...(holderContext ? { holderContext } : {}),
      hint: `Already claimed by ${failure.holder} — the item exists (get/observe/comment/complete resolve it). Coordinate with the holder via coord:send, or pick another item; if that agent is dead, the stale-claim reclaim lane frees it. Do not blind-retry with a different harness.`,
    };
  }
  return {
    ok: false,
    id: it.id,
    error: 'not_claimable',
    workItem: current,
    hint: 'Item exists but the claim was refused by a trust/admission gate, or it was released between the claim and this re-read — re-check with work_items:get / work_items:observe.',
  };
}

export default defineTool({
  name: 'work_items:claim',
  profile: 'engineer',
  // PROMPT-WEIGHT (EI-10966): this tool was 2054 chars — 454 over the 1600 HARD CAP — which
  // REDS the green gate and freezes deploys fleet-wide. Trimmed to the load-bearing contract;
  // the rationale that used to live in the prompt now lives here, where it costs no context:
  //   · claim_conflict → a LIVE peer holds it. Coordinate via coord:send; do NOT blind-retry.
  //     A DEAD holder is freed automatically by the stale-claim lane, so retrying only races.
  //   · claim_hold_blocked / policy_gate_requires_owner_override → deliberately parked
  //     (WI-2797 / D-003, enforced on the by-id path by WI-5946's claim-hold-guard). force /
  //     ownerOverride bypass it, leave the hold in place, and emit an audit row + notify.
  //   · There is no work_items:heartbeat — ANY papercusp-su call refreshes liveness, which is
  //     what the stale-claim reaper reads. The one gap is a long stretch of PURELY-LOCAL tool
  //     use (Bash/Read/vitest, zero platform calls) inside a >10–15min claim (EI-6772); call
  //     work_items:checkpoint partway, which is both a progress note and a liveness pulse.
  description:
    'Claim one OR many work-items (to yourself, or to `assignee`). Single: { id, assignee? }. Many: ids:[…] or items:[{ id, assignee?, harness? }]. Per-item outcomes — one refusal never fails the rest. A fleet MEMBER may only receive items matching its claim spec. A `_claimHold` item refuses with `claim_hold_blocked` (or `policy_gate_requires_owner_override`) unless `force`/`ownerOverride`; the hold stays either way.',
  guidance: {
    when: 'Starting work on work-item(s) — claim so peers do not duplicate. Claim a swath via { ids:[…] }. By-id claims may override self-select readiness floors, never fleet scope.',
    notWhen:
      '`claim_conflict` = a LIVE peer holds it: coordinate, do not blind-retry. `claim_hold_blocked`/`policy_gate_requires_owner_override` = deliberately parked: coordinate before `force`/`ownerOverride`.',
    chaining:
      'work_items:list → claim → set_state → release/close. No heartbeat verb exists — any platform call refreshes liveness; during a long LOCAL-ONLY stretch call work_items:checkpoint as a liveness pulse (EI-6772).',
    seeAlso: [
      'work_items:claim_next (self-select the next claimable item instead of naming an id)',
      'work_items:observe (check claimability before taking)',
      'work_items:release (drop the claim if you stop working it)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-claim shorthand: the work-item id'),
      assignee: z
        .string()
        .max(120)
        .optional()
        .describe(
          'default: you (also resolves the literal "self" to you). Applies to the inline id / every id in `ids`.',
        ),
      ids: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .optional()
        .describe('claim MANY items for the same `assignee` (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            assignee: z.string().max(120).optional(),
            harness: z.string().max(80).optional(),
            force: z.boolean().optional(),
            ownerOverride: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('claim many work-items at once — each { id, assignee?, harness?, force?, ownerOverride? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      force: z
        .boolean()
        .optional()
        .describe(
          'default for the inline id / every id in `ids`: claim past a `payload._claimHold` exclusion (WI-2797 durable park / hold_open lease) instead of refusing with `claim_hold_blocked`. The hold is left in place (never auto-cleared) and the bypass is audited + notifies the holder and the owner (WI-5946).',
        ),
      ownerOverride: z
        .boolean()
        .optional()
        .describe(
          'default for the inline id / every id in `ids`: REQUIRED in addition to `force` when the claim-hold reason names a policy-tier gate (a D-NNN decision id, `triageDecision:"gate"`, or "policy-tier") — `force` alone is refused for a policy gate (mirrors work_items:hold_open, EI-18672701535825889).',
        ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  // context-trimming-tiers P-025 (write-echo diet): trimmed/standard sessions
  // get a compact workItem ref per result instead of the full echoed row;
  // outcome fields (ok/error/holder/hint/reflect) pass through verbatim —
  // see write-echo-shape.ts.
  shape: {
    standard: (data) => shapeWorkItemWriteEcho(data, 'standard'),
    trimmed: (data) => shapeWorkItemWriteEcho(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // P-027: resolved ONCE for the whole batch — the advisory is reader-relative,
    // and every item in this call shares one reader. Guarded, so an
    // unattributable caller gets no advisory rather than a failed claim.
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
    const list: ClaimItem[] = args.items?.length
      ? args.items.map((it) => ({
          id: it.id,
          assignee: it.assignee ?? args.assignee,
          harness: it.harness ?? args.harness,
          force: it.force ?? args.force,
          ownerOverride: it.ownerOverride ?? args.ownerOverride,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({
            id,
            assignee: args.assignee,
            harness: args.harness,
            force: args.force,
            ownerOverride: args.ownerOverride,
          }))
        : [
            {
              id: args.id as string,
              assignee: args.assignee,
              harness: args.harness,
              force: args.force,
              ownerOverride: args.ownerOverride,
            },
          ];
    const env = await runBulk(list, (it) => claimOne(it, ident, reader), {
      keyOf: (it) => ({ id: it.id }),
    });
    // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
    // D-006): piggyback a targeted memory recall for the just-claimed item(s)
    // on the response — deadline-bounded, epoch-deduped (port 'claim'),
    // never-throws (dynamic import keeps the memory chain off this module's
    // static graph — see _bulk.ts's ESM-cycle note).
    const claimedItems = env.results
      .filter((r) => r.ok && r.workItem != null)
      .map((r) => r.workItem as { id?: string; title?: string; summary?: string; harness?: string | null });
    const memory = claimedItems.length
      ? await import('../../memory/claim-port')
          .then((m) =>
            m.buildClaimRecallBlock({
              sessionId: ident.ownerId,
              workspaceId: ident.workspaceId,
              items: claimedItems,
            }),
          )
          .catch(() => null)
      : null;
    return bulkContent(memory ? { ...env, memory } : env);
  },
});
