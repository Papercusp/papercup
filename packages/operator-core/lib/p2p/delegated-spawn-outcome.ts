/**
 * p2p/delegated-spawn-outcome.ts — REQUESTER-SIDE reconciliation of a delegated
 * spawn request (EI-19333624101736074).
 *
 * ## The gap this closes
 *
 * The delegated-spawn path is LOUD on refusal and SILENT on success:
 *   - refusal ⇒ `emitReceipt({ kind:'refusal' })`, a federated `p2p_receipts`
 *     fact the requester can read;
 *   - success ⇒ `setDisposition(..., 'honored')` + a `console.log` on the
 *     HONORING host, and `local_disposition` is explicitly host-local and never
 *     federated (see `sync/hyperbee/projections/work-offers.ts` :22 and :330).
 *
 * So exactly TWO states cross the wire (refused, nothing) where THREE are
 * needed. A member that spawns, joins the fleet, and dies at boot *arrives and
 * then vanishes* — from the requesting host that is indistinguishable from a
 * request nobody honored. Measured live 2026-08-02 (tower → Win rig): member
 * joined fleet `fed-drill` at 08:11:25Z, died on auth seconds later; afterwards
 * the tower held no receipt, no disposition, and an aged-out presence row. Two
 * full wakes were spent concluding the honor path had *fabricated* "honored"
 * when it had genuinely spawned a member that died. An observability gap does
 * not merely hide a bug — it manufactures confident wrong diagnoses.
 *
 * ## Why it is reconciled HERE and not fixed on the honoring side
 *
 * The honoring host could simply emit a success receipt (and should — see
 * EI-19331694139523035's follow-up). But that code runs on the REMOTE rig, and
 * rigs run installed sidecar bundles with no update path (EI-19330215508907244):
 * verified 2026-08-02, the Win rig's sidecar carries neither the boot-receipt
 * detector nor the honor-attribution fix, both landed the same day. A requester-
 * side reconciler needs no rig cooperation at all — it runs entirely on evidence
 * the requesting host already has (its own federated receipts + fleet presence).
 *
 * ## Honesty rules baked in
 *
 *  1. `honored-then-died` is only claimed for a member whose session ENDED with
 *     a lifetime under the boot threshold. A member that ran and finished is
 *     `honored-completed`, never a phantom.
 *  2. Attribution is REPORTED, not assumed. Presence rows carry no request id,
 *     so when other spawn requests targeted the same fleet in the same window
 *     the verdict is stamped `attribution:'ambiguous'` rather than silently
 *     crediting this request with a peer's member.
 *  3. Absence of evidence inside the honor window is `pending`, never
 *     `no-response` — the request may simply not have been picked up yet.
 *
 * PURE: no I/O, no clock. The caller supplies the evidence and `nowMs`.
 */

/** Default: a member dying within this long of first being seen is a BOOT death,
 *  not a completed run. The live rig failures died 2-4s in; the honor path's own
 *  boot-receipt window is 6s. 120s is deliberately generous — it is far cheaper
 *  to call a genuine short run "died at boot" (the detail carries the lifetime,
 *  so a reader can see it) than to miss a phantom. */
export const BOOT_DEATH_LIFETIME_MS = 120_000;

/** Default honor window for a spawn request — mirrors SPAWN_REQUEST_HONOR_WINDOW_MS. */
export const DEFAULT_HONOR_WINDOW_MS = 60 * 60_000;

export type DelegatedSpawnVerdict =
  /** A member attributable to this request is alive and taking turns. */
  | 'honored-live'
  /** THE PHANTOM: a member appeared and died within the boot threshold. This is
   *  the state that does not exist today — the whole reason this module exists. */
  | 'honored-then-died'
  /** A member appeared, ran past the boot threshold, and has since ended. */
  | 'honored-completed'
  /** The honoring host refused, and said why (a federated refusal receipt). */
  | 'refused'
  /** The honor window elapsed with no receipt and no member. Nobody picked it up. */
  | 'no-response'
  /**
   * MEASURED 2026-08-02, and the reason this verdict exists: for a REMOTE honor
   * the requesting host holds NO evidence a member ever existed. The Win rig's
   * member joined fleet `fed-drill` at 08:11:25Z and the tower has no row for it
   * in `coord_presence` (reaped) AND none in the append-only
   * `fleet_membership_events` (the fleet registry is machine-local) — the newest
   * fed-drill membership rows are from 03:41Z. Only `p2p_receipts` demonstrably
   * crosses (verified: 2 rows, both origin='remote', kind='refusal').
   *
   * So absent a refusal, a remote spawn's outcome is UNKNOWABLE from this side.
   * Reporting that honestly is the whole point — emitting `no-response` here
   * would dress the exact ambiguity this module exists to remove up as a verdict.
   */
  | 'indeterminate'
  /** Still inside the honor window with nothing observed yet. Not a failure. */
  | 'pending';

export interface DelegatedSpawnRequestFacts {
  offerId: string;
  fleetSlug: string;
  /** Seats asked for. A shortfall is reported, never silently rounded away. */
  count: number;
  requestedAtMs: number;
  /** Defaults to {@link DEFAULT_HONOR_WINDOW_MS}. */
  honorWindowMs?: number;
}

/** A federated receipt already filtered to this request's offerId. */
export interface DelegatedSpawnReceiptFacts {
  kind: string;
  code?: string | null;
  detail?: string | null;
  tsMs: number;
}

/**
 * A fleet presence row on the REQUESTING host. `firstSeenMs`/`lastActiveMs` are
 * the member's own lifetime bounds; `sessionState` is the shared liveness oracle
 * verdict (live | parked | draining | suspect | ended | recorded) — NOT a raw
 * heartbeat boolean, which reads `true` for a warm-dead session.
 */
export interface DelegatedSpawnMemberFacts {
  ownerId: string;
  fleetSlug: string;
  firstSeenMs: number;
  lastActiveMs: number;
  sessionState: string;
}

export interface DelegatedSpawnOutcome {
  verdict: DelegatedSpawnVerdict;
  /** Human detail — always states what evidence produced the verdict. */
  detail: string;
  /** Whether a member could be uniquely credited to THIS request. */
  attribution: 'unique' | 'ambiguous' | 'none';
  /** Members attributed to this request (may be empty). */
  members: Array<{ ownerId: string; sessionState: string; lifetimeMs: number }>;
  /** Seats asked for minus members observed — positive means a shortfall. */
  shortfall: number;
  /** The refusal code, when the verdict is `refused`. */
  refusalCode?: string;
  /** True when the verdict is one a requester should ACT on. */
  actionable: boolean;
}

const LIVE_STATES = new Set(['live', 'parked', 'draining']);

/**
 * Reconcile a delegated spawn request against requester-side evidence.
 *
 * `members` should already be scoped to the request's fleet; rows that first
 * appeared BEFORE the request are dropped here (they cannot have come from it).
 */
export function classifyDelegatedSpawnOutcome(args: {
  request: DelegatedSpawnRequestFacts;
  receipts: DelegatedSpawnReceiptFacts[];
  members: DelegatedSpawnMemberFacts[];
  nowMs: number;
  /** Other spawn requests targeting the SAME fleet whose windows overlap this
   *  one. >0 ⇒ a member cannot be uniquely credited to this request. */
  concurrentRequests?: number;
  bootDeathLifetimeMs?: number;
}): DelegatedSpawnOutcome {
  const { request, receipts, members, nowMs } = args;
  const bootMs = args.bootDeathLifetimeMs ?? BOOT_DEATH_LIFETIME_MS;
  const windowMs = request.honorWindowMs ?? DEFAULT_HONOR_WINDOW_MS;
  const windowEndsAtMs = request.requestedAtMs + windowMs;
  const withinWindow = nowMs < windowEndsAtMs;

  // A refusal is the one thing that DOES federate today — trust it first.
  const refusal = receipts
    .filter((r) => r.kind === 'refusal')
    .sort((a, b) => a.tsMs - b.tsMs)[0];
  if (refusal) {
    return {
      verdict: 'refused',
      detail:
        `the honoring host refused this request${refusal.code ? ` (${refusal.code})` : ''}` +
        `${refusal.detail ? `: ${refusal.detail}` : ''}`,
      attribution: 'none',
      members: [],
      shortfall: request.count,
      refusalCode: refusal.code ?? undefined,
      actionable: true,
    };
  }

  // Presence rows carry no request id, so candidacy is "same fleet, appeared
  // after the request was published". That is a heuristic, and it is REPORTED
  // as one whenever another request could also claim these members.
  const candidates = members
    .filter((m) => m.fleetSlug === request.fleetSlug && m.firstSeenMs >= request.requestedAtMs)
    .map((m) => ({
      ownerId: m.ownerId,
      sessionState: m.sessionState,
      lifetimeMs: Math.max(0, m.lastActiveMs - m.firstSeenMs),
    }));

  if (candidates.length === 0) {
    return withinWindow
      ? {
          verdict: 'pending',
          detail:
            `no receipt and no member yet, but the ${Math.round(windowMs / 60_000)}-min honor window is still open ` +
            `(${Math.round((windowEndsAtMs - nowMs) / 60_000)} min left) — not yet a failure`,
          attribution: 'none',
          members: [],
          shortfall: request.count,
          actionable: false,
        }
      : {
          verdict: 'no-response',
          detail:
            `the ${Math.round(windowMs / 60_000)}-min honor window elapsed with no refusal receipt and no member ` +
            `joining '${request.fleetSlug}' — nobody honored it. Check that the target host has accept-delegated-seats enabled.`,
          attribution: 'none',
          members: [],
          shortfall: request.count,
          actionable: true,
        };
  }

  const attribution: DelegatedSpawnOutcome['attribution'] =
    (args.concurrentRequests ?? 0) > 0 ? 'ambiguous' : 'unique';
  const caveat =
    attribution === 'ambiguous'
      ? ` ⚠ ${args.concurrentRequests} other spawn request(s) overlapped this one on the same fleet, and presence rows ` +
        'carry no request id — these members cannot be credited to this request with certainty.'
      : '';
  const shortfall = Math.max(0, request.count - candidates.length);
  const shortfallNote = shortfall > 0 ? ` Asked for ${request.count} seat(s), observed ${candidates.length}.` : '';

  const live = candidates.filter((m) => LIVE_STATES.has(m.sessionState));
  if (live.length > 0) {
    return {
      verdict: 'honored-live',
      detail:
        `${live.length} member(s) joined '${request.fleetSlug}' after the request and are ${live[0].sessionState}.` +
        shortfallNote +
        caveat,
      attribution,
      members: candidates,
      shortfall,
      actionable: shortfall > 0,
    };
  }

  // Every candidate has ended. Short-lived ⇒ the phantom this module exists for.
  const diedAtBoot = candidates.filter((m) => m.lifetimeMs < bootMs);
  if (diedAtBoot.length > 0) {
    return {
      verdict: 'honored-then-died',
      detail:
        `PHANTOM HONOR: ${diedAtBoot.length} member(s) joined '${request.fleetSlug}' and then died within ` +
        `${Math.round(bootMs / 1000)}s (shortest lifetime ${Math.min(...diedAtBoot.map((m) => m.lifetimeMs))}ms). ` +
        'The seat was consumed but no work can have been done. The honoring host emits no success receipt, so this ' +
        'is only visible by reconciliation — read the member log ON that host for the boot error (an auth failure is ' +
        'the common cause; see EI-19331694139523035).' +
        shortfallNote +
        caveat,
      attribution,
      members: candidates,
      shortfall,
      actionable: true,
    };
  }

  return {
    verdict: 'honored-completed',
    detail:
      `${candidates.length} member(s) joined '${request.fleetSlug}', ran past the ${Math.round(bootMs / 1000)}s boot ` +
      'threshold, and have since ended — a normal completed run, not a phantom.' +
      shortfallNote +
      caveat,
    attribution,
    members: candidates,
    shortfall,
    actionable: shortfall > 0,
  };
}
