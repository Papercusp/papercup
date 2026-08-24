/**
 * reconcile-escalations — the attention-queue reconciliation sweep
 * (queue-pending-accuracy-and-drift P-003/P-005, D-002/D-003).
 *
 * The drift it kills: OPERATIONAL escalations (placement-watchdog cursed
 * placements, aging sweeps — `from: system[:…]`, no options) are emitted en
 * masse and almost never resolved (live: ~7000 opened, ~135 resolved), so they
 * accumulate forever. The reader already DEMOTES them out of "waiting on you"
 * (isOperationalEscalation → alert tier), but they still pile up in the alert
 * list. This sweep auto-resolves the stale ones so the queue stays a projection
 * of live reality WITHOUT relying on any agent remembering to resolve them.
 *
 * Why a TTL and not a per-unit liveness check: an operational escalation is a
 * redundant duplicate of a DERIVED health metric (`placements.cursed`) — that
 * metric, not the escalation, is the source of truth for current state (D-003).
 * So an operational escalation idle past the TTL is, by construction, stale: the
 * live state is still shown by the metric; the escalation is just un-GC'd noise.
 *
 * WI-36154 bounds that premise: it holds only where the row is a DUPLICATE of
 * the live signal. Where the open row is itself the SUPPRESSOR that stops an
 * alarm re-firing, resolving it re-arms the alarm instead of tidying a duplicate
 * — so a row whose EMITTER owns its lifecycle is exempt (see isEmitterOwnedRow).
 *
 * GENUINE human decisions (non-system sender, or carrying options) are NEVER
 * selected — a human must clear those (that is what `coord:resolve` is for).
 */

import { isOperationalEscalation } from './adapters';
import { listEscalations, resolveEscalationsBatch } from '../agent-tools/coordination/escalations';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { getPresence, listPresence } from '../agent-tools/coordination/presence';
import { fetchPresenceFleet } from '../agent-tools/coordination/presence-fleet';
import { sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { coordLog, coordSql, coordWorkspaceId } from '../agent-tools/coordination/log';
import { AGENT_SESSION_SENDER_PATTERN } from '../agent-tools/coordination/machine-authored';
import { getFleet } from '../agent-fleets-store';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

/** Resolver identity stamped on auto-reconciled escalations (audit trail). */
export const RECONCILE_OWNER = 'system:attention-reconcile';

/**
 * Default TTL for OPERATIONAL escalations: 48h. Override via env. Lowered from 3d
 * (infra-perf-robustness-audit-2026-06-18 D-005): operational escalations are
 * redundant duplicates of the derived `placements.cursed` health metric (D-003),
 * so a shorter idle window is safe — and a 3d window let a placement-watchdog burst
 * pile ~12k stale escalations into the alert tier (drowning ~89 real decisions in
 * the human attention feed) before they aged out. 48h still leaves ~2 days for any
 * genuinely-current operational state to surface.
 */
export const OPERATIONAL_ESCALATION_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_OPERATIONAL_ESCALATION_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 2 * 24 * 60 * 60 * 1000;
})();

/** Max escalations resolved per sweep tick. Raised 500→2500 (infra audit D-005):
 *  EI-1490 made a tick batch-resolve from a SINGLE coord-log load (no longer O(n²)),
 *  so a larger batch is cheap, and it lets the hourly sweep actually drain a large
 *  backlog (e.g. a watchdog burst) within a few ticks instead of accumulating. */
export const RECONCILE_BATCH_LIMIT = 2500;

export interface StaleEscalationInput {
  msg_id: string;
  from?: string | null;
  options?: readonly unknown[];
  /** ISO timestamp the escalation was opened. */
  ts: string;
  /**
   * WI-36154: the infra-liveness alarm's stable signal key, stamped into `meta`
   * by liveness-alarm.ts and FLATTENED onto the record (escalations.ts:190
   * `Object.assign(env, input.meta)`), so it arrives as a top-level field on
   * every read path — the projection returns the stored `body` whole, and the
   * event-fold spreads it (`{ ...open, resolved }`). Typed `unknown` because it
   * reaches us from jsonb: only a non-empty string counts (see isLivenessSuppressor).
   */
  livenessSignature?: unknown;
  /**
   * WI-36214: the emitter's explicit declaration that it OWNS this row's
   * lifecycle — it skips re-firing while the row is open, and resolves the row
   * itself when the condition clears. See SELF_RECONCILING_META_KEY.
   */
  selfReconciling?: unknown;
}

/**
 * WI-36214: the meta key an emitter stamps to opt a row OUT of the TTL sweep.
 *
 * Stamp it ONLY when BOTH legs hold, because each defeats a different half of
 * the sweep's premise:
 *   1. the emitter SKIPS firing while one of its rows is open (so GC'ing the
 *      row does not tidy a duplicate — it RE-ARMS the alarm), and
 *   2. the emitter RESOLVES the row itself once the condition clears (so the
 *      TTL is not needed as a backstop against an immortal row).
 *
 * Deliberately OPT-IN rather than inferred. The tempting inference — "this
 * emitter also calls resolveEscalation, so it reconciles its own rows" — is
 * WRONG and expensive: `pot/placement-watchdog.ts` both opens and resolves, but
 * opens one row PER CURSED PLACEMENT with no such gate. It is the mass-emitter
 * this whole sweep was built for (~7000 opened / ~135 resolved; a 3d window once
 * let ~12k pile into the alert tier), so inferring the exemption would resurrect
 * exactly the flood the sweep exists to kill.
 */
export const SELF_RECONCILING_META_KEY = 'selfReconciling';

/**
 * WI-36154/WI-36214: is this row its own emitter's SUPPRESSOR — i.e. would
 * resolving it re-arm an alarm whose condition is still true?
 *
 * Two legs, both anchored to an EXPLICIT stamp:
 *   - `selfReconciling === true` — the general marker (WI-36214);
 *   - a non-empty `livenessSignature` — the infra-liveness alarm's pre-existing
 *     stamp, retained so rows ALREADY OPEN (and any written by a not-yet-updated
 *     worker) stay protected without waiting to be re-emitted.
 *
 * Deliberately NOT `livenessSignatureOf()`, whose summary-derivation fallback
 * ends in a catch-all `"<panel label>: <...>"` match: that heuristic would
 * silently extend the exemption across unrelated operational rows. The exclusion
 * is anchored to the property that DEFINES membership (this row is an alarm's
 * own suppressor), never to how a summary happens to read.
 */
export function isEmitterOwnedRow(
  e: Pick<StaleEscalationInput, 'livenessSignature' | 'selfReconciling'>,
): boolean {
  if (e.selfReconciling === true) return true;
  return typeof e.livenessSignature === 'string' && e.livenessSignature.length > 0;
}

export interface StaleEscalation {
  msg_id: string;
  ageDays: number;
}

/**
 * PURE: which OPEN escalations are stale (auto-resolvable) — operational
 * (system sender, no options), NOT an emitter-owned suppressor row
 * (WI-36154/WI-36214), AND opened older than `ttlMs`. Sorted oldest first so a
 * batch-limited sweep
 * drains the longest-stale first.
 */
export function selectStaleEscalations(
  opens: readonly StaleEscalationInput[],
  ctx: { nowMs: number; ttlMs?: number },
): StaleEscalation[] {
  const ttl = ctx.ttlMs ?? OPERATIONAL_ESCALATION_TTL_MS;
  const out: StaleEscalation[] = [];
  for (const e of opens) {
    if (!isOperationalEscalation(e.from, (e.options?.length ?? 0) > 0)) continue;
    // WI-36154: the TTL premise (a row is a redundant duplicate of a derived
    // metric) is FALSE where the ROW IS THE SUPPRESSOR. liveness-alarm.ts:1552
    // buckets open escalations by signature and SKIPS firing a signal that
    // already has one open, so resolving that row does not clean up a duplicate
    // — it RE-ARMS the alarm while its condition is still true.
    //
    // MEASURED 14d: 5 of 5 idle-2d auto-resolves carrying a livenessSignature
    // re-fired within 120s (stale-paused-routines 3/3, rubric-emission-dark
    // 2/2) — the sweep was running the alarm as a ~2-day notification
    // scheduler. WI-36214: re-running that probe against the 366 rows the
    // exemption LEFT BEHIND found 6 more, all `system:escalation-aging-alarm`
    // (escalation-aging-alarm.ts:167 — same gate, no livenessSignature), so the
    // exclusion is now keyed on an explicit opt-in marker any such emitter can
    // stamp. Still narrow BY MEASUREMENT: 11 of 371 idle-2d resolves in 14d.
    if (isEmitterOwnedRow(e)) continue;
    const openedMs = Date.parse(e.ts);
    if (!Number.isFinite(openedMs)) continue;
    const ageMs = ctx.nowMs - openedMs;
    if (ageMs >= ttl) out.push({ msg_id: e.msg_id, ageDays: ageMs / 86_400_000 });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

export interface ReconcileResult {
  scanned: number;
  stale: number;
  resolved: number;
  /** True when the backlog exceeded the batch limit (more remain for next tick). */
  truncated: boolean;
  /**
   * WHICH BRANCH produced this result (WI-7397). Required, not optional, on
   * purpose: a caller must not be able to ignore the difference.
   *
   * The dead-author pass has a fail-safe that resolves NOTHING when a liveness
   * read throws. That is correct — a degraded read must never read as "everyone
   * is gone" — but before WI-7397 it returned a value IDENTICAL to the healthy
   * "nothing was eligible" case, so a permanently-degraded reaper was
   * indistinguishable from one with no work to do, forever and silently.
   *
   *  - 'swept'         — the pass ran to completion (`resolved` may still be 0)
   *  - 'no-candidates' — nothing was eligible this tick; healthy
   *  - 'aborted'       — a liveness/presence read THREW; nothing was resolved
   */
  outcome: 'swept' | 'no-candidates' | 'aborted';
}

/**
 * One reconciliation pass: load open escalations, resolve the stale operational
 * ones (up to the batch limit). Idempotent — an already-resolved escalation is a
 * no-op, so re-running is safe.
 */
export async function reconcileStaleEscalationsOnce(
  opts: { nowMs?: number; ttlMs?: number; limit?: number } = {},
): Promise<ReconcileResult> {
  const opens = (await listEscalations({ status: 'open' })) as unknown as StaleEscalationInput[];
  const nowMs = opts.nowMs ?? Date.now();
  const stale = selectStaleEscalations(opens, { nowMs, ttlMs: opts.ttlMs });
  const limit = opts.limit ?? RECONCILE_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  // EI-1490: resolve the whole batch from a SINGLE load of the escalation log.
  // The per-item `resolveEscalation` re-read the entire surface every call
  // (O(n²) over the ~13k operational backlog), so a tick drained only a fraction
  // of its batch before the step budget — the lane never actually emptied.
  const resolved =
    batch.length === 0
      ? 0
      : (
          await resolveEscalationsBatch(
            batch.map((s) => ({
              msg_id: s.msg_id,
              choice: 'auto-reconciled',
              resolver: RECONCILE_OWNER,
              note: `auto-resolved: operational escalation idle ${Math.round(s.ageDays)}d — live state is the derived health metric (queue-pending-accuracy P-003/P-005)`,
            })),
          )
        ).resolved;

  return {
    scanned: opens.length,
    stale: stale.length,
    resolved,
    truncated: stale.length > batch.length,
    outcome: 'swept',
  };
}

// ─── EI-19411323991062966: unanswerable escalations from DEAD authors ─────────
//
// The sweep above deliberately never touches NON-operational escalations — an
// agent- or session-authored escalation reads as a genuine human decision, and
// auto-closing a live agent's ask would be wrong. That default is right for a
// LIVE author and wrong for a DEAD one: an escalation whose author no longer
// exists can never be answered by that author, and no code path closes it. They
// are immortal by construction.
//
// MEASURED 2026-08-03: 365 of 550 open rows were non-operational, 304 of them
// past 48h, oldest 2026-06-15 — 66% of the open set and the OLDEST rows, so they
// sit at the FRONT of every oldest-first bounded page. That is the standing
// reason the 500-row read cap gets approached at all (the cap that silently
// starved condition-staleness's own auto-resolve leg in EI-19403159016550818).
//
// The discriminator is AUTHOR LIVENESS, not author identity. Deliberately NOT
// done by widening isOperationalEscalation: that set's comment rightly forbids
// adding an agent alias, because a live bee's escalation can be a genuine ask.

/**
 * TTL for NON-operational escalations before the dead-author reaper considers
 * them. Deliberately much longer than OPERATIONAL_ESCALATION_TTL_MS: these are
 * human-shaped asks, so age alone is never sufficient — it is only the window
 * after which a *provably absent* author makes the row unanswerable.
 */
export const UNANSWERABLE_ESCALATION_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_UNANSWERABLE_ESCALATION_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 7 * 24 * 60 * 60 * 1000;
})();

/**
 * Structural pre-filter: could this row EVER be reaped as unanswerable? Excludes
 * operational rows (the TTL sweep above owns those), anything carrying options
 * (a real choice — never auto-close), a blank sender, and anything inside the
 * TTL. Author liveness is NOT consulted here — this is the cheap filter that
 * decides whom we bother probing.
 */
function isUnanswerableCandidate(e: StaleEscalationInput, nowMs: number, ttlMs: number): boolean {
  const hasOptions = (e.options?.length ?? 0) > 0;
  if (hasOptions) return false;
  if (isOperationalEscalation(e.from, hasOptions)) return false;
  const from = typeof e.from === 'string' ? e.from.trim() : '';
  if (!from) return false;
  const openedMs = Date.parse(e.ts);
  if (!Number.isFinite(openedMs)) return false;
  return nowMs - openedMs >= ttlMs;
}

/** The distinct senders worth probing for liveness this tick. */
export function unanswerableCandidateAuthors(
  opens: readonly StaleEscalationInput[],
  ctx: { nowMs: number; ttlMs?: number },
): string[] {
  const ttl = ctx.ttlMs ?? UNANSWERABLE_ESCALATION_TTL_MS;
  const out = new Set<string>();
  for (const e of opens) {
    if (isUnanswerableCandidate(e, ctx.nowMs, ttl)) out.add((e.from as string).trim());
  }
  return [...out];
}

/**
 * PURE: which OPEN escalations are UNANSWERABLE — non-operational, option-less,
 * past `ttlMs`, AND authored by someone `isAuthorGone` reports as gone.
 *
 * `isAuthorGone` must return true ONLY for a PROVEN-absent author. Unknown must
 * map to false: this selector resolves rows that look like human decisions, so
 * every ambiguous signal has to fail closed.
 */
export function selectUnanswerableEscalations(
  opens: readonly StaleEscalationInput[],
  ctx: { nowMs: number; ttlMs?: number; isAuthorGone: (from: string) => boolean },
): StaleEscalation[] {
  const ttl = ctx.ttlMs ?? UNANSWERABLE_ESCALATION_TTL_MS;
  const out: StaleEscalation[] = [];
  for (const e of opens) {
    if (!isUnanswerableCandidate(e, ctx.nowMs, ttl)) continue;
    if (!ctx.isAuthorGone((e.from as string).trim())) continue;
    out.push({ msg_id: e.msg_id, ageDays: (ctx.nowMs - Date.parse(e.ts)) / 86_400_000 });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

export interface UnanswerableReconcileDeps {
  resolveSessionStatesFn?: typeof resolveSessionStates;
  getPresenceFn?: (ownerId: string) => Promise<unknown | null>;
}

/**
 * One dead-author reconciliation pass.
 *
 * Liveness is read in TWO legs because the oracle's "no entry" is ambiguous by
 * design — `resolveSessionStates` returns no entry BOTH for a degraded fetch and
 * for an owner it has never heard of, and its doc is explicit that the caller
 * keeps its own "state unknown" behavior. Treating no-entry as dead would
 * mass-resolve real asks on one transient fetch failure. So:
 *
 *   - an EXPLICIT verdict is authoritative in both directions — gone iff the
 *     session state is 'ended' or 'recorded' ('suspect'/'parked'/'draining' are
 *     ambiguous and deliberately count as NOT gone);
 *   - with NO verdict, presence-row absence disambiguates: we treat the author
 *     as gone only when the presence store ANSWERED and held no row for them.
 *
 * MEASURED: 226 of the 229 distinct authors behind the current backlog have no
 * presence row at all, so the presence leg — not the verdict leg — is what
 * actually drains this. Any throw from either leg aborts the whole pass and
 * resolves NOTHING; a degraded read must never read as "everyone is gone".
 */
export async function reconcileUnanswerableEscalationsOnce(
  opts: { nowMs?: number; ttlMs?: number; limit?: number } & UnanswerableReconcileDeps = {},
): Promise<ReconcileResult> {
  const opens = (await listEscalations({ status: 'open' })) as unknown as StaleEscalationInput[];
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? UNANSWERABLE_ESCALATION_TTL_MS;
  // WI-7397: the two zero-result branches below are semantically OPPOSITE (one
  // healthy, one a degraded-read abort) and must never again be the same value.
  const zero = (outcome: ReconcileResult['outcome']): ReconcileResult => ({
    scanned: opens.length,
    stale: 0,
    resolved: 0,
    truncated: false,
    outcome,
  });

  const candidates = unanswerableCandidateAuthors(opens, { nowMs, ttlMs: ttl });
  if (candidates.length === 0) return zero('no-candidates');

  const resolveFn = opts.resolveSessionStatesFn ?? resolveSessionStates;
  const getPresenceFn = opts.getPresenceFn ?? getPresence;

  let goneByVerdict: Map<string, boolean>;
  let presenceKnown: Set<string>;
  try {
    const [verdicts, presenceRows] = await Promise.all([
      resolveFn(candidates.map((ownerId) => ({ ownerId }))),
      Promise.all(candidates.map(async (id) => [id, await getPresenceFn(id)] as const)),
    ]);
    goneByVerdict = new Map(
      [...verdicts.entries()].map(([id, v]) => [
        id,
        v.sessionState === 'ended' || v.sessionState === 'recorded',
      ]),
    );
    presenceKnown = new Set(presenceRows.filter(([, row]) => row != null).map(([id]) => id));
  } catch {
    // FAIL-SAFE. A degraded liveness/presence read is indistinguishable from
    // "nobody exists" if you squint — so we refuse to squint.
    // The 'aborted' outcome is what makes this refusal VISIBLE: resolving
    // nothing is the right call, but doing so silently is not (WI-7397).
    return zero('aborted');
  }

  const isAuthorGone = (from: string): boolean =>
    goneByVerdict.has(from) ? goneByVerdict.get(from)! : !presenceKnown.has(from);

  const stale = selectUnanswerableEscalations(opens, { nowMs, ttlMs: ttl, isAuthorGone });
  const limit = opts.limit ?? RECONCILE_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  const resolved =
    batch.length === 0
      ? 0
      : (
          await resolveEscalationsBatch(
            batch.map((s) => ({
              msg_id: s.msg_id,
              choice: 'unanswerable',
              resolver: RECONCILE_OWNER,
              // Distinct from the operational note on purpose: an auto-closed row
              // must never read as an ask that was actually answered.
              note: `auto-resolved: author no longer exists — escalation open ${Math.round(s.ageDays)}d and unanswerable (EI-19411323991062966)`,
            })),
          )
        ).resolved;

  return {
    scanned: opens.length,
    stale: stale.length,
    resolved,
    truncated: stale.length > batch.length,
    outcome: 'swept',
  };
}

// ─── EI-7024: escalation SLA reroute to a live driver ────────────────────────

/** A genuine escalation may need a live operator even while the original row
 * remains a human decision. After this SLA, route a one-shot action message to
 * the closest live su. Environment override exists for operators/tests. */
export const ESCALATION_REROUTE_SLA_MS = (() => {
  const env = Number(process.env.PAPERCUSP_ESCALATION_REROUTE_SLA_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60 * 1000;
})();

/** Safety bound per five-minute tick. */
export const ESCALATION_REROUTE_BATCH_LIMIT = 200;

const AGENT_ESCALATION_AUTHOR_RE = new RegExp(AGENT_SESSION_SENDER_PATTERN, 'i');
export const ESCALATION_REROUTE_OWNER = 'system:escalation-sla-reroute';
const ESCALATION_REROUTE_MSG_PREFIX = 'escalation-sla-reroute:';
const ESCALATION_REROUTE_MARKER_FIELD = 'escalationRerouteOf';

const ESCALATION_REROUTE_IDENTITY: AgentIdentity = {
  ownerId: ESCALATION_REROUTE_OWNER,
  ownerLabel: 'system · escalation-sla-reroute',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface EscalationRerouteInput extends StaleEscalationInput {
  summary?: string;
  body?: string;
  plan_slug?: string;
  harness_slug?: string;
  /** Legacy/meta-flattened harness context. */
  harnessSlug?: string;
}

export interface EscalationRerouteDriver {
  ownerId: string;
  sessionState: string | null;
  agentRole: string | null;
  currentPlanSlug: string | null;
  potSlug: string | null;
  fleetSlug: string | null;
}

export type EscalationRerouteReason = 'author-fleet-leader' | 'author-fleet-member' | 'same-plan' | 'same-harness';

export interface EscalationRerouteSelection {
  escalation: EscalationRerouteInput;
  targetOwnerId: string;
  reason: EscalationRerouteReason;
  overdueMinutes: number;
}

function concrete(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRerouteEligible(
  e: EscalationRerouteInput,
  nowMs: number,
  slaMs: number,
  responseMarkers: ReadonlySet<string>,
): boolean {
  const from = concrete(e.from);
  if (!from || !AGENT_ESCALATION_AUTHOR_RE.test(from)) return false;
  if (isOperationalEscalation(from, (e.options?.length ?? 0) > 0)) return false;
  if (responseMarkers.has(e.msg_id)) return false;
  const openedMs = Date.parse(e.ts);
  return Number.isFinite(openedMs) && nowMs - openedMs >= slaMs;
}

/**
 * PURE: choose one DIFFERENT live su for each past-SLA, still-open escalation.
 * Contextless agents are never selected. Ties are owner-id sorted so retries and
 * tests make the same choice from the same snapshot.
 */
export function selectEscalationSlaReroutes(
  opens: readonly EscalationRerouteInput[],
  roster: readonly EscalationRerouteDriver[],
  ctx: {
    nowMs: number;
    slaMs?: number;
    responseMarkers?: ReadonlySet<string>;
    leaderByFleet?: ReadonlyMap<string, string | null>;
  },
): EscalationRerouteSelection[] {
  const slaMs = ctx.slaMs ?? ESCALATION_REROUTE_SLA_MS;
  const responseMarkers = ctx.responseMarkers ?? new Set<string>();
  const leaderByFleet = ctx.leaderByFleet ?? new Map<string, string | null>();
  const byOwner = new Map(roster.map((r) => [r.ownerId, r]));
  const out: EscalationRerouteSelection[] = [];

  for (const escalation of opens) {
    if (!isRerouteEligible(escalation, ctx.nowMs, slaMs, responseMarkers)) continue;
    const from = concrete(escalation.from)!;
    const author = byOwner.get(from);
    const authorFleet = author?.fleetSlug ?? null;
    const planSlug = concrete(escalation.plan_slug) ?? author?.currentPlanSlug ?? null;
    const harnessSlug =
      concrete(escalation.harness_slug) ?? concrete(escalation.harnessSlug) ?? author?.potSlug ?? null;

    const ranked = roster
      .filter(
        (candidate) => candidate.ownerId !== from && candidate.sessionState === 'live' && candidate.agentRole === 'su',
      )
      .map(
        (candidate): { candidate: EscalationRerouteDriver; rank: number; reason: EscalationRerouteReason } | null => {
          if (authorFleet && leaderByFleet.get(authorFleet) === candidate.ownerId) {
            return { candidate, rank: 0, reason: 'author-fleet-leader' };
          }
          if (authorFleet && candidate.fleetSlug === authorFleet) {
            return { candidate, rank: 1, reason: 'author-fleet-member' };
          }
          if (planSlug && candidate.currentPlanSlug === planSlug) {
            return { candidate, rank: 2, reason: 'same-plan' };
          }
          if (harnessSlug && candidate.potSlug === harnessSlug) {
            return { candidate, rank: 3, reason: 'same-harness' };
          }
          return null;
        },
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.rank - b.rank || a.candidate.ownerId.localeCompare(b.candidate.ownerId));

    const selected = ranked[0];
    if (!selected) continue;
    const openedMs = Date.parse(escalation.ts);
    out.push({
      escalation,
      targetOwnerId: selected.candidate.ownerId,
      reason: selected.reason,
      overdueMinutes: (ctx.nowMs - openedMs) / 60_000,
    });
  }

  return out.sort(
    (a, b) =>
      Date.parse(a.escalation.ts) - Date.parse(b.escalation.ts) ||
      a.escalation.msg_id.localeCompare(b.escalation.msg_id),
  );
}

/** Any messages-surface sibling carrying related_msg_id retires rerouting for
 * the escalation. A reroute notice cannot use related_msg_id when the original
 * escalation has been pruned, so its explicit lifecycle marker does the same
 * job. The explicit key-presence predicate is required by the live partial
 * index; keep it even though the equality looks sufficient. */
async function readEscalationResponseMarkers(msgIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(msgIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  try {
    const sql = coordSql();
    const rows = await sql<{
      related_msg_id: string | null;
      escalation_reroute_of: string | null;
    }[]>`
      SELECT DISTINCT
             body->>'related_msg_id' AS related_msg_id,
             body->>'${ESCALATION_REROUTE_MARKER_FIELD}' AS escalation_reroute_of
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND (
           (body ? 'related_msg_id' AND body->>'related_msg_id' = ANY(${ids}))
           OR
           (body ? '${ESCALATION_REROUTE_MARKER_FIELD}' AND body->>'${ESCALATION_REROUTE_MARKER_FIELD}' = ANY(${ids}))
         )
    `;
    return new Set(
      rows
        .flatMap((row) => [row.related_msg_id, row.escalation_reroute_of])
        .filter((id): id is string => typeof id === 'string'),
    );
  } catch {
    const idSet = new Set(ids);
    const lines = await coordLog.readLines('messages');
    return new Set(lines.flatMap((line) => {
      const marker = (line as unknown as Record<string, unknown>)[ESCALATION_REROUTE_MARKER_FIELD];
      return [
        line.related_msg_id,
        typeof marker === 'string' ? marker : null,
      ].filter((id): id is string => typeof id === 'string' && idSet.has(id));
    }));
  }
}

export interface EscalationRerouteResult {
  scanned: number;
  selected: number;
  rerouted: number;
  failed: number;
  truncated: boolean;
}

export interface EscalationRerouteDeps {
  listEscalationsFn?: typeof listEscalations;
  listPresenceFn?: typeof listPresence;
  resolveSessionStatesFn?: typeof resolveSessionStates;
  fetchPresenceFleetFn?: typeof fetchPresenceFleet;
  getFleetFn?: typeof getFleet;
  readResponseMarkersFn?: (msgIds: readonly string[]) => Promise<Set<string>>;
  sendMessageFn?: typeof sendMessage;
  wakeRecipientsFn?: typeof wakeRecipients;
}

/** One injectable, fail-closed pass. The original escalation is NEVER resolved:
 * this only appends one action message + attempts one targeted wake. */
export async function rerouteUnackedEscalationsOnce(
  opts: {
    nowMs?: number;
    slaMs?: number;
    limit?: number;
    workspaceId?: string;
  } & EscalationRerouteDeps = {},
): Promise<EscalationRerouteResult> {
  const listEscalationsFn = opts.listEscalationsFn ?? listEscalations;
  const listPresenceFn = opts.listPresenceFn ?? listPresence;
  const resolveFn = opts.resolveSessionStatesFn ?? resolveSessionStates;
  const fetchFleetFn = opts.fetchPresenceFleetFn ?? fetchPresenceFleet;
  const getFleetFn = opts.getFleetFn ?? getFleet;
  const readMarkersFn = opts.readResponseMarkersFn ?? readEscalationResponseMarkers;
  const sendFn = opts.sendMessageFn ?? sendMessage;
  const wakeFn = opts.wakeRecipientsFn ?? wakeRecipients;
  const nowMs = opts.nowMs ?? Date.now();
  const slaMs = opts.slaMs ?? ESCALATION_REROUTE_SLA_MS;
  const limit = opts.limit ?? ESCALATION_REROUTE_BATCH_LIMIT;
  const workspaceId = opts.workspaceId ?? coordWorkspaceId();

  const opens = (await listEscalationsFn({ status: 'open' })) as unknown as EscalationRerouteInput[];
  const pastSlaAgentRows = opens.filter((e) => isRerouteEligible(e, nowMs, slaMs, new Set()));
  const markers = await readMarkersFn(pastSlaAgentRows.map((e) => e.msg_id));
  const unmarked = pastSlaAgentRows.filter((e) => !markers.has(e.msg_id));
  if (unmarked.length === 0) {
    return { scanned: opens.length, selected: 0, rerouted: 0, failed: 0, truncated: false };
  }

  const presence = await listPresenceFn({ workspaceId });
  const ownerIds = presence.map((p) => p.ownerId);
  const [verdicts, membership] = await Promise.all([
    resolveFn(
      presence.map((p) => ({
        ownerId: p.ownerId,
        heartbeatAt: p.heartbeatAt,
        stale: p.stale,
        host: p.host,
        pid: p.pid,
        source: p.source,
      })),
    ),
    fetchFleetFn(ownerIds),
  ]);
  const roster: EscalationRerouteDriver[] = presence.map((p) => ({
    ownerId: p.ownerId,
    sessionState: verdicts.get(p.ownerId)?.sessionState ?? null,
    agentRole: p.agentRole,
    currentPlanSlug: p.currentPlanSlug,
    potSlug: p.potSlug,
    fleetSlug: membership.get(p.ownerId)?.fleetSlug ?? null,
  }));
  const authorIds = new Set(unmarked.map((e) => concrete(e.from)).filter((id): id is string => id !== null));
  const authorFleets = [
    ...new Set(
      roster
        .filter((r) => authorIds.has(r.ownerId))
        .map((r) => r.fleetSlug)
        .filter((slug): slug is string => slug !== null),
    ),
  ];
  const fleetRows = await Promise.all(
    authorFleets.map(async (slug) => [slug, await getFleetFn(workspaceId, slug).catch(() => null)] as const),
  );
  const leaderByFleet = new Map(fleetRows.map(([slug, fleet]) => [slug, fleet?.leaderOwnerId ?? null]));

  const selected = selectEscalationSlaReroutes(unmarked, roster, {
    nowMs,
    slaMs,
    responseMarkers: markers,
    leaderByFleet,
  });
  const batch = selected.slice(0, limit);
  let rerouted = 0;
  let failed = 0;
  for (const route of batch) {
    const { escalation } = route;
    const noticeMsgId = `${ESCALATION_REROUTE_MSG_PREFIX}${escalation.msg_id}`;
    try {
      const notice = await sendFn(ESCALATION_REROUTE_IDENTITY, {
        to: [route.targetOwnerId],
        msgId: noticeMsgId,
        summary:
          `⏰ escalation needs a live driver (${route.reason}, ~${Math.round(route.overdueMinutes)}m): ` +
          `${escalation.summary ?? escalation.msg_id}`,
        body:
          `Escalation ${escalation.msg_id} from ${escalation.from ?? 'an agent'} has remained open without ` +
          `any related coord acknowledgement for ~${Math.round(route.overdueMinutes)} minutes. You were selected ` +
          `as the closest live su (${route.reason}). Inspect it and drive the next action. Keep the original ` +
          'escalation open: only the human resolution path is authoritative. After taking ownership, acknowledge ' +
          `this reroute notice with coord:ack { msg_id: '${noticeMsgId}' }; that stable target remains valid even ` +
          'when the original escalation message has been pruned.',
        plan_slug: concrete(escalation.plan_slug) ?? undefined,
        harnessSlug: concrete(escalation.harness_slug) ?? concrete(escalation.harnessSlug) ?? undefined,
        extra: {
          auto: true,
          lifecycle: 'escalation-sla-reroute',
          expects: 'action',
          escalationRerouteReason: route.reason,
          [ESCALATION_REROUTE_MARKER_FIELD]: escalation.msg_id,
        },
      });
      rerouted += 1;
      try {
        await wakeFn([route.targetOwnerId], {
          summary: `take over unacknowledged escalation ${escalation.msg_id}`,
          payload: { escalationMsgId: escalation.msg_id, noticeMsgId: notice.msg_id },
          source: ESCALATION_REROUTE_OWNER,
          workspaceId,
        });
      } catch (error) {
        console.warn(
          `[escalation-sla-reroute] wake ${route.targetOwnerId} for ${escalation.msg_id} failed: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    } catch (error) {
      failed += 1;
      console.warn(
        `[escalation-sla-reroute] send for ${escalation.msg_id} failed: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return {
    scanned: opens.length,
    selected: selected.length,
    rerouted,
    failed,
    truncated: selected.length > batch.length,
  };
}
