/**
 * nudge-recipient — WHO receives a Scout-rail nudge once the Mug may not exist.
 *
 * Plan: retire-mug-kettle-su-only-2026-08-09 (P-034), closing LOSS GAP 1 + 2 from D-005.
 *
 * ## The gap this closes
 *
 * Three Scout watchdogs exist ONLY to wake the Mug, and the Mug is their designated
 * consumer — not an implementation detail:
 *   - `draft-review-watchdog`    — scout-routed drafts "sit unreviewed for days, neither
 *                                  ratified nor deprecated" unless the Queen reviews them.
 *   - `ungraded-filings-watchdog` — its own header: "nothing MAKES grading happen: the Mug
 *                                  only grades when triage happens to look".
 *   - `ready-plan-autostart`      — consumes plans the Queen ratified to 'ready'.
 *
 * `wakeMug` delivers through two halves: a best-effort direct wake of the resolved Mug
 * owner, plus a durable park to `MUG_COORD_SLOT` ('@role:mug') that the NEXT Mug wake
 * drains. Both halves terminate at the Mug. So with no live Mug — today when one simply
 * is not running, and permanently after the retirement — a nudge parks in a slot nobody
 * drains. Scout keeps producing into a queue with no consumer and NOTHING REPORTS IT.
 * That silent dead-end is the failure mode this module removes.
 *
 * ## Why this is not a change to `wakeMug`
 *
 * `wakeMug` has six call sites and they are two different populations:
 *   - THREE inside `pot/placement-watchdog` itself — genuine Mug placement nudges. They
 *     belong to the retiring tier and SHOULD die with it. Routing those to an su would
 *     hand the su the Mug's placement duties, which is exactly what the retirement is
 *     getting rid of.
 *   - THREE in the Scout watchdogs above — the output rail that must SURVIVE.
 * So the recipient strategy is applied at the Scout call sites, and `wakeMug` stays the
 * Mug-directed primitive (and is still used verbatim when the Mug IS the resolved
 * recipient). Retiring the tier then removes one branch of the ladder rather than
 * stranding a rail.
 *
 * ## The ladder
 *
 *   1. A live/parked **Mug** — unchanged behaviour while the tier is running.
 *   2. Else a live **su** session in the workspace — the replacement reviewer/grader.
 *   3. Else **escalate to the owner** — never a silent drop.
 *
 * Liveness comes from `resolveSessionStates`, THE shared oracle, never from a raw
 * heartbeat: `heartbeatFresh` means the keepalive is ticking, NOT that the session is
 * taking turns, and a warm-dead session reads fresh + `ended`. Picking a recipient off a
 * heartbeat would reintroduce the same silent dead-end one layer down.
 */

import type { PresenceRecord } from '../agent-tools/coordination/presence';
import type { listPresence } from '../agent-tools/coordination/presence';
import type { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';

/**
 * ⚠ EVERY runtime dependency here is imported LAZILY, inside the functions — the same
 * shape `wakeMug` uses one file over for `messages` / `workspace-als`, and for the same
 * reason. The Scout watchdog tests mock `@papercusp/db-org` with ONLY `getOrgPg`, and
 * vitest throws on access to ANY missing mock member. A STATIC import of the presence /
 * liveness modules pulls the real `su-lock-store` (which calls
 * `setAdminPoolStatementTimeoutProvider` at module scope) into their graph, and all three
 * suites then fail to COLLECT — a failure that looks nothing like the change that caused
 * it. Type-only imports above are erased at compile time and are safe.
 *
 * Keep new dependencies dynamic unless you have re-run those suites.
 */
const loadPresence = () => import('../agent-tools/coordination/presence');
const loadLiveness = () => import('../agent-tools/coordination/liveness-oracle');
const loadPlacementWatchdog = () => import('../pot/placement-watchdog');

/** Session states that can actually receive and act on a nudge. */
const DELIVERABLE_STATES = new Set(['live', 'parked']);

/** su session owner ids are minted with this prefix (e.g. `su-bdf16205-…`). */
const SU_OWNER_PREFIX = 'su-';

/**
 * `escalate` and `unresolved` are DELIBERATELY distinct, and collapsing them would
 * recreate the bug this module exists to fix, one level up:
 *   - `escalate`   — we KNOW nobody can act (presence read fine, nobody live). Tell the
 *                    owner; this is a real "your Scout rail has no consumer" signal.
 *   - `unresolved` — we could not TELL (presence/liveness unreadable). Absence of
 *                    evidence, not evidence of absence. Escalating on it would page the
 *                    owner every time a dependency hiccups and train them to ignore it.
 *                    The legacy durable park still ran, so degrade quietly to that.
 */
export type NudgeRecipient =
  | { kind: 'mug'; ownerId: string; why: string }
  | { kind: 'su'; ownerId: string; ownerLabel: string; why: string }
  | { kind: 'escalate'; why: string }
  | { kind: 'unresolved'; why: string };

export interface ResolveNudgeRecipientOpts {
  workspaceId: string;
  /** The currently-resolved Mug coord owner, if the caller already looked it up. */
  mugOwner: string | null;
  /** DI seams for unit tests. */
  listPresenceFn?: typeof listPresence;
  resolveSessionStatesFn?: typeof resolveSessionStates;
  /** P-037 seam: is the Mug/Kettle tier still runnable? Defaults to the shared
   *  predicate in pot/started.ts (loaded dynamically so a partially-mocked
   *  './started' in a Scout test cannot strand this module at import time). */
  mugKettleSystemEnabledFn?: () => Promise<boolean>;
}

/**
 * P-037: is the Mug tier still runnable? Fail-CLOSED to `false` — an unreadable
 * flag must not keep the Mug rung eligible, because a nudge routed to a Mug is
 * a nudge NOT routed to a live su, and `wakeMug` is itself gated on the same
 * predicate. Guessing `true` here would strand the nudge between two gates.
 */
async function tierRunnable(fn?: () => Promise<boolean>): Promise<boolean> {
  try {
    if (fn) return await fn();
    const { mugKettleSystemEnabled } = await import('../pot/started');
    return await mugKettleSystemEnabled();
  } catch {
    return false;
  }
}

/**
 * Resolve who should receive a Scout-rail nudge right now.
 *
 * Fail-soft by design: any error resolving liveness degrades to `escalate` rather than
 * throwing, because the caller is a watchdog whose whole purpose is to not go quiet.
 */
export async function resolveNudgeRecipient(
  opts: ResolveNudgeRecipientOpts,
): Promise<NudgeRecipient> {
  // The module LOADS are inside the guard too, not just the calls: a dynamic import can
  // itself throw (a partially-mocked dependency under test, a cycle at boot), and a
  // watchdog whose whole job is to not go quiet must never die resolving its own
  // recipient. Anything unresolvable degrades to `unresolved`, which the caller reports.
  let listFn: typeof listPresence;
  let statesFn: typeof resolveSessionStates;
  try {
    listFn = opts.listPresenceFn ?? (await loadPresence()).listPresence;
    statesFn = opts.resolveSessionStatesFn ?? (await loadLiveness()).resolveSessionStates;
  } catch (e) {
    return {
      kind: 'unresolved',
      why: `presence/liveness modules unavailable (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  let rows: PresenceRecord[] = [];
  try {
    rows = await listFn({ workspaceId: opts.workspaceId });
  } catch (e) {
    return {
      kind: 'unresolved',
      why: `presence unreadable (${e instanceof Error ? e.message : String(e)}) — cannot name a live recipient`,
    };
  }

  // Candidates: the Mug (if the caller resolved one) plus every su session in scope.
  // One oracle call covers both so the Mug and the su are judged by the same rule.
  const suRows = rows.filter((r) => r.ownerId.startsWith(SU_OWNER_PREFIX));
  const subjects = [
    ...(opts.mugOwner ? [{ ownerId: opts.mugOwner }] : []),
    ...suRows.map((r) => ({
      ownerId: r.ownerId,
      heartbeatAt: r.heartbeatAt,
      host: r.host,
      pid: r.pid,
      source: r.source,
    })),
  ];

  if (subjects.length === 0) {
    return { kind: 'escalate', why: 'no Mug and no su session present in this workspace' };
  }

  let verdicts: Map<string, { sessionState?: string | null }>;
  try {
    verdicts = (await statesFn(subjects, { hydratePerId: true })) as Map<
      string,
      { sessionState?: string | null }
    >;
  } catch (e) {
    return {
      kind: 'unresolved',
      why: `liveness oracle failed (${e instanceof Error ? e.message : String(e)}) — refusing to guess a recipient from a raw heartbeat`,
    };
  }

  const deliverable = (ownerId: string): boolean => {
    const v = verdicts.get(ownerId);
    // NO entry means the oracle could not judge this subject (a degraded fetch). Unknown
    // is not "alive" — treat it as undeliverable so we fall through to a real recipient
    // rather than parking a nudge on a session nobody has confirmed is taking turns.
    return v != null && v.sessionState != null && DELIVERABLE_STATES.has(v.sessionState);
  };

  // 1 — the Mug, while the tier is still running.
  //
  // P-037: "while the tier is still running" is now ENFORCED, not assumed. It
  // has to be, because `wakeMug` is gated on the same predicate: were this rung
  // to pick a Mug after the retirement, `deliverScoutNudge` would early-return
  // on it (a deliverable Mug needs no second recipient) while the delivery it
  // returned on had already no-opped — losing the nudge between two gates, the
  // one outcome worse than either the old behaviour or the new one.
  if (opts.mugOwner && deliverable(opts.mugOwner) && (await tierRunnable(opts.mugKettleSystemEnabledFn))) {
    return {
      kind: 'mug',
      ownerId: opts.mugOwner,
      why: `Mug ${opts.mugOwner} is ${verdicts.get(opts.mugOwner)?.sessionState}`,
    };
  }

  // 2 — a live su, preferring the most recently ACTIVE (not the most recent heartbeat:
  //     the keepalive bumps that on a session doing nothing).
  const liveSu = suRows
    .filter((r) => deliverable(r.ownerId))
    .sort((a, b) => (b.lastActiveAt ?? b.heartbeatAt ?? '').localeCompare(a.lastActiveAt ?? a.heartbeatAt ?? ''));

  if (liveSu.length > 0) {
    const chosen = liveSu[0];
    return {
      kind: 'su',
      ownerId: chosen.ownerId,
      ownerLabel: chosen.ownerLabel,
      why:
        `no deliverable Mug; routed to su ${chosen.ownerLabel} ` +
        `(${verdicts.get(chosen.ownerId)?.sessionState}, ${liveSu.length} su candidate(s))`,
    };
  }

  // 3 — nobody home. Say so loudly; never park into a slot with no drainer.
  return {
    kind: 'escalate',
    why:
      `no deliverable recipient: mug=${opts.mugOwner ?? 'none'} ` +
      `(${opts.mugOwner ? (verdicts.get(opts.mugOwner)?.sessionState ?? 'unknown') : 'n/a'}), ` +
      `${suRows.length} su session(s) present but none live/parked`,
  };
}

export interface DeliverScoutNudgeOpts {
  workspaceId: string;
  mugOwner: string | null;
  summary: string;
  source: string;
  payload?: unknown;
  body?: string;
  harnessSlug?: string | null;
  /** A true pager must re-invoke the selected su after the durable inbox write.
   *  Quiet review/grade nudges leave this false and remain inject-only. */
  wakeSu?: boolean;
}

/**
 * Deliver a Scout-rail nudge to whoever can actually act on it, and RETURN which route
 * was taken so the caller can log/record it. Replaces a bare `wakeMug` at the three
 * Scout watchdogs.
 */
export async function deliverScoutNudge(
  opts: DeliverScoutNudgeOpts,
): Promise<NudgeRecipient> {
  const recipient = await resolveNudgeRecipient({
    workspaceId: opts.workspaceId,
    mugOwner: opts.mugOwner,
  });

  // ALWAYS run the legacy Mug delivery first — this addition is PURELY ADDITIVE, the
  // same discipline severe-event-broadcast took with its own routing leg.
  //
  // Removing the durable `@role:mug` park when no Mug is live would be a REGRESSION while
  // the tier still runs: the park exists precisely so a FUTURE Mug relaunch drains it, and
  // "no Mug live right now" is the normal state between wakes, not evidence that none is
  // coming. So the park stays and the routed delivery is layered on top; when the tier is
  // finally gated OFF this call becomes a no-op and only the routed leg remains.
  const { wakeMug } = await loadPlacementWatchdog();
  await wakeMug({
    workspaceId: opts.workspaceId,
    mugOwner: recipient.kind === 'mug' ? recipient.ownerId : opts.mugOwner,
    summary: opts.summary,
    source: opts.source,
    payload: opts.payload,
    body: opts.body,
    harnessSlug: opts.harnessSlug,
  });

  // A deliverable Mug will act on it — no second recipient needed.
  if (recipient.kind === 'mug') return recipient;

  // Could not determine liveness — the durable park above is the honest best effort.
  // Do NOT page the owner on a dependency hiccup (see the NudgeRecipient doc).
  if (recipient.kind === 'unresolved') return recipient;

  const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
    import('../agent-tools/coordination/messages'),
    import('../workspace-als'),
  ]);

  // `human` surfaces to the owner; a concrete su ownerId is a direct address. Either way
  // the message is DIRECTED at someone who exists, never parked in `@role:mug`.
  //
  // ⚠ This is the INTERNAL `sendMessage`, whose `SendOptions.body` is a plain STRING and
  // which has `expectsReply?: boolean` — NOT the `coord:send` TOOL's wire shape (an array
  // of typed sections with `expects`). The two look interchangeable and are not; the
  // adjacent `wakeMug` uses this same string form.
  const to = recipient.kind === 'su' ? [recipient.ownerId] : ['human'];

  // The slot name is INLINED rather than imported from placement-watchdog's
  // MUG_COORD_SLOT: this is diagnostic prose, and the Scout tests mock that module with
  // only { resolveMugOwner, wakeMug }, so reading any other member throws.
  const routingNote =
    `\n\n— Routed by the Scout nudge ladder because the Mug was not deliverable: ${recipient.why}. ` +
    `Before this ladder existed the nudge would have parked in '@role:mug' (MUG_COORD_SLOT), which only a Mug drains.`;

  try {
    await runWithWorkspace(opts.workspaceId, () =>
      sendMessage(
        {
          ownerId: opts.source,
          ownerLabel: opts.source,
          source: 'static-client',
          workspaceId: opts.workspaceId,
          userId: null,
        },
        {
          to,
          summary: opts.summary,
          body: `${opts.body ?? opts.summary}${routingNote}`,
          expectsReply: recipient.kind === 'escalate',
          harnessSlug: opts.harnessSlug,
          extra: { scoutNudge: { route: recipient.kind, why: recipient.why, source: opts.source } },
        },
      ),
    );

    // `sendMessage` is deliberately inject-only. That is right for the ordinary
    // review/grade nudges, but not for the error-streak PAGER: without this explicit
    // opt-in the alarm can select a live su, persist a message, and still never start
    // a turn for that recipient. Wake only after the durable write succeeds so a
    // failed send cannot produce an empty wake.
    if (recipient.kind === 'su' && opts.wakeSu) {
      const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
      await wakeRecipients([recipient.ownerId], {
        summary: opts.summary,
        payload: opts.payload,
        source: opts.source,
        workspaceId: opts.workspaceId,
      });
    }
  } catch (e) {
    console.warn(
      `[scout-nudge] ${recipient.kind} delivery failed (${opts.source}): ${e instanceof Error ? e.message : e}`,
    );
  }

  return recipient;
}
