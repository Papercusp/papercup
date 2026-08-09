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

import type { PresenceRecord } from './../agent-tools/coordination/presence';
import { listPresence } from './../agent-tools/coordination/presence';
import { resolveSessionStates } from './../agent-tools/coordination/liveness-oracle';
import { MUG_COORD_SLOT, wakeMug } from '../pot/placement-watchdog';

/** Session states that can actually receive and act on a nudge. */
const DELIVERABLE_STATES = new Set(['live', 'parked']);

/** su session owner ids are minted with this prefix (e.g. `su-bdf16205-…`). */
const SU_OWNER_PREFIX = 'su-';

export type NudgeRecipient =
  | { kind: 'mug'; ownerId: string; why: string }
  | { kind: 'su'; ownerId: string; ownerLabel: string; why: string }
  | { kind: 'escalate'; why: string };

export interface ResolveNudgeRecipientOpts {
  workspaceId: string;
  /** The currently-resolved Mug coord owner, if the caller already looked it up. */
  mugOwner: string | null;
  /** DI seams for unit tests. */
  listPresenceFn?: typeof listPresence;
  resolveSessionStatesFn?: typeof resolveSessionStates;
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
  const listFn = opts.listPresenceFn ?? listPresence;
  const statesFn = opts.resolveSessionStatesFn ?? resolveSessionStates;

  let rows: PresenceRecord[] = [];
  try {
    rows = await listFn({ workspaceId: opts.workspaceId });
  } catch (e) {
    return {
      kind: 'escalate',
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
      kind: 'escalate',
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
  if (opts.mugOwner && deliverable(opts.mugOwner)) {
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

  if (recipient.kind === 'mug') {
    // Unchanged path: wakeMug's two halves (direct wake + durable @role:mug park).
    await wakeMug({
      workspaceId: opts.workspaceId,
      mugOwner: recipient.ownerId,
      summary: opts.summary,
      source: opts.source,
      payload: opts.payload,
      body: opts.body,
      harnessSlug: opts.harnessSlug,
    });
    return recipient;
  }

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

  const routingNote =
    `\n\n— Routed by the Scout nudge ladder because the Mug was not deliverable: ${recipient.why}. ` +
    `Before this ladder existed the nudge would have parked in ${MUG_COORD_SLOT}, which only a Mug drains.`;

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
  } catch (e) {
    console.warn(
      `[scout-nudge] ${recipient.kind} delivery failed (${opts.source}): ${e instanceof Error ? e.message : e}`,
    );
  }

  return recipient;
}
